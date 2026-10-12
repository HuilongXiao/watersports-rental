import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
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
from app.api.payments import router as payments_router
from app.api.settings import router as settings_router
from app.api.users import router as users_router
from app.api.reports import router as reports_router
from app.db.init_db import check_database_connection, initialize_database
from app.db.seed import seed_system_data


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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(customers_router)
app.include_router(catalog_router)
app.include_router(inventory_router)
app.include_router(orders_router)
app.include_router(payments_router)
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
