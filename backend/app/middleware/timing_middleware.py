"""请求耗时统计中间件。

记录每个 HTTP 请求的总耗时（total_ms）、DB 耗时（db_ms，通过 SQLAlchemy
event hooks 按请求累加）与 handler 耗时（handler_ms = total - db），
通过 X-Server-Timing 响应头返回给前端，并以 JSON 行写入轮转日志文件。

开关：环境变量 REQUEST_TIMING（默认开启；生产可设为 0/false 关闭）。
日志：LOG_DIR/backend-requests.log（RotatingFileHandler，5MB x 5 份），
容器内默认落在 /app/data/logs/（已挂载到 host ./data，NAS 上可直接查看）。
回滚：如 DB event hook 引发异常，注释掉 setup_db_timing() 调用即可。
"""

import json
import logging
import os
import time
from contextvars import ContextVar
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path

from sqlalchemy import event

from app.core.config import PROJECT_ROOT, REQUEST_TIMING
from app.db.session import engine

# 注意：BaseHTTPMiddleware 的 call_next 在独立 task 中运行，contextvars 的
# set() 不会回传到中间件上下文，因此这里用可变容器（list/dict）承载累加值，
# 子 task 继承同一对象引用，修改对中间件可见。
_db_seconds: ContextVar[list | None] = ContextVar("db_seconds", default=None)
_conn_t0: ContextVar[dict | None] = ContextVar("conn_t0", default=None)

trace_logger = logging.getLogger("app.request_timing")
_log_dir: Path | None = None


def _setup_logging() -> Path:
    global _log_dir
    if _log_dir is not None:
        return _log_dir
    _log_dir = Path(os.getenv("LOG_DIR", str(PROJECT_ROOT / "data" / "logs")))
    _log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        _log_dir / "backend-requests.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    trace_logger.addHandler(handler)
    trace_logger.setLevel(logging.INFO)
    trace_logger.propagate = False
    return _log_dir


def setup_db_timing() -> None:
    """注册 SQLAlchemy event hooks，按请求累加 SQL 执行耗时。"""

    @event.listens_for(engine, "before_cursor_execute")
    def _before(conn, cursor, statement, parameters, context, executemany):
        acc = _db_seconds.get()
        if acc is None:
            return
        t0_map = _conn_t0.get()
        if t0_map is None:
            t0_map = {}
            _conn_t0.set(t0_map)
        t0_map[id(conn)] = time.monotonic()

    @event.listens_for(engine, "after_cursor_execute")
    def _after(conn, cursor, statement, parameters, context, executemany):
        acc = _db_seconds.get()
        t0_map = _conn_t0.get()
        if acc is None or not t0_map or id(conn) not in t0_map:
            return
        acc[0] += time.monotonic() - t0_map.pop(id(conn))


def log_trace(record: dict) -> None:
    _setup_logging()
    trace_logger.info(json.dumps({"type": "client_trace", **record}, ensure_ascii=False))


async def timing_middleware(request, call_next):
    """FastAPI http 中间件：计时、注入 X-Server-Timing 头、写 JSON 日志。"""
    if not REQUEST_TIMING:
        return await call_next(request)

    _setup_logging()
    db_acc = [0.0]
    _db_seconds.set(db_acc)
    _conn_t0.set({})
    start = time.monotonic()

    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception:
        total_ms = round((time.monotonic() - start) * 1000, 1)
        db_ms = round(db_acc[0] * 1000, 1)
        _write_log(request, None, status_code, total_ms, db_ms)
        raise

    total_ms = round((time.monotonic() - start) * 1000, 1)
    db_ms = round(db_acc[0] * 1000, 1)
    response.headers["X-Server-Timing"] = (
        f"total={total_ms}; db={db_ms}; handler={round(total_ms - db_ms, 1)}"
    )
    _write_log(request, response, status_code, total_ms, db_ms)
    return response


def _write_log(request, response, status_code: int, total_ms: float, db_ms: float) -> None:
    trace_logger.info(json.dumps({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "path": request.url.path,
        "method": request.method,
        "status_code": status_code,
        "total_ms": total_ms,
        "db_ms": db_ms,
        "handler_ms": round(total_ms - db_ms, 1),
        "client_ip": request.client.host if request.client else None,
        "user_id": getattr(request.state, "user_id", None),
    }, ensure_ascii=False))
