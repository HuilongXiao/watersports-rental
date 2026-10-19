import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.auth import router as auth_router
from app.api.auto_exports import router as auto_exports_router
from app.api.backups import router as backups_router
from app.api.catalog import router as catalog_router
from app.api.customers import router as customers_router
from app.api.dashboard import router as dashboard_router
from app.api.groups import router as groups_router
from app.api.inventory import router as inventory_router
from app.api.orders import router as orders_router
from app.api.payment_methods import router as payment_methods_router
from app.api.payments import router as payments_router
from app.api.settings import router as settings_router
from app.api.users import router as users_router
from app.api.reports import router as reports_router
from app.core.config import TRACE_REPORT_ENABLED
from app.db.init_db import check_database_connection, initialize_database
from app.db.seed import seed_system_data
from app.middleware.timing_middleware import (
    log_trace,
    setup_db_timing,
    timing_middleware,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    seed_system_data()
    from app.services.scheduler import start_scheduler, stop_scheduler

    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()


app = FastAPI(title="Rental App API", version="0.1.0", lifespan=lifespan)


class StaticCacheMiddleware:
    """静态资源缓存策略（纯 ASGI 中间件）。

    前端的 JS/CSS 单包较大，且每次访问都要重新下载；这里区分两类资源：

    - `/assets/**`：Vite 构建产物，文件名自带内容哈希，更新即换名，
      可以长期强缓存（一年），避免重复下载与重新解析。
    - 其余（index.html、manifest.json、图标等）一律 `no-cache`：
      每次带 ETag 校验，未变更返回 304（几十字节），发版后立刻生效。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        cache_control = (
            "public, max-age=31536000, immutable"
            if scope["path"].startswith("/assets/")
            else "no-cache"
        )

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["Cache-Control"] = cache_control
            await send(message)

        await self.app(scope, receive, send_wrapper)


# 请求耗时统计：X-Server-Timing 头 + JSON 轮转日志（REQUEST_TIMING 控制开关）
setup_db_timing()
app.middleware("http")(timing_middleware)

# 静态资源缓存头：给 JS/CSS 加长缓存、给 index.html 加 no-cache
app.add_middleware(StaticCacheMiddleware)
# gzip 压缩：JS/CSS 等文本资源压缩后传输量约降到 1/4；图片、字体等本身就是
# 压缩格式的响应会被内置的排除列表自动跳过。
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    # 允许前端 JS 读取 X-Server-Timing 响应头
    allow_headers=["*"],
    expose_headers=["X-Server-Timing"],
)

app.include_router(auth_router)
app.include_router(customers_router)
app.include_router(catalog_router)
app.include_router(inventory_router)
app.include_router(orders_router)
app.include_router(payments_router)
app.include_router(payment_methods_router)
app.include_router(settings_router)
app.include_router(dashboard_router)
app.include_router(groups_router)
app.include_router(users_router)
app.include_router(reports_router)
app.include_router(backups_router)
app.include_router(auto_exports_router)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "rental-app-api"}


@app.get("/api/health/database")
def database_health() -> dict[str, str]:
    connected = check_database_connection()
    return {
        "status": "ok" if connected else "error",
        "database": "connected" if connected else "unavailable",
    }


@app.post("/api/_trace")
async def client_trace(payload: dict):
    """接收前端上报的请求耗时 summary（集中汇总调试用）。

    由环境变量 TRACE_REPORT_ENABLED 控制，默认关闭；关闭时直接返回 disabled，
    不写日志，避免产生大量日志。
    """
    if not TRACE_REPORT_ENABLED:
        return {"status": "disabled"}
    log_trace({
        "path": payload.get("path"),
        "method": payload.get("method"),
        "client_timing_ms": payload.get("client_timing_ms"),
        "server_header": payload.get("server_header"),
        "extra": payload.get("extra"),
    })
    return {"status": "ok"}


# --- Single-container mode: serve the pre-built frontend from /app/static ---
# In local development the directory does not exist and Vite serves the UI.
STATIC_DIR = Path(os.getenv("STATIC_DIR", str(Path(__file__).resolve().parents[2] / "static")))

if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

    @app.exception_handler(StarletteHTTPException)
    async def spa_fallback(request: Request, exc: StarletteHTTPException):
        # Unknown non-API paths are client-side routes (e.g. /orders/<id>);
        # return index.html so the SPA router handles them on refresh.
        if exc.status_code == 404 and not request.url.path.startswith("/api/"):
            index_file = STATIC_DIR / "index.html"
            if index_file.is_file():
                return FileResponse(str(index_file))
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
