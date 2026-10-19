"""请求耗时统计中间件。

记录每个 HTTP 请求的总耗时（total_ms）、DB 耗时（db_ms，通过 SQLAlchemy
event hooks 按请求累加）与 handler 耗时（handler_ms = total - db），
通过 X-Server-Timing 响应头返回给前端，并以 JSON 行写入轮转日志文件。

开关：环境变量 REQUEST_TIMING（默认开启；生产可设为 0/false 关闭）。
日志：按业务日期（Asia/Shanghai）每天一个文件，文件名带日期，便于按天取用：

  LOG_DIR/backend-requests-YYYY-MM-DD.log   后端每个请求的耗时（本中间件）
  LOG_DIR/frontend-trace-YYYY-MM-DD.log     前端上报的耗时（POST /api/_trace）

跨天时自动切换到当天文件（写入时判断日期，无需重启）。每份文件仍按大小轮转
（5MB x 2 份），并清理 30 天前的旧文件，避免磁盘占满。
容器内默认落在 /app/data/logs/（已挂载到 host ./data，NAS 上可直接查看）。
回滚：如 DB event hook 引发异常，注释掉 setup_db_timing() 调用即可。
"""

import json
import logging
import os
import time
from contextvars import ContextVar
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path

from sqlalchemy import event

from app.core.config import PROJECT_ROOT, REQUEST_TIMING
from app.core.time_utils import BUSINESS_TZ
from app.db.session import engine

# 日志保留天数：每次切换到新的一天时清理更早的文件。
LOG_RETENTION_DAYS = 30
_LOG_MAX_BYTES = 5 * 1024 * 1024
_LOG_BACKUP_COUNT = 2
# 日志类别 -> 文件名前缀
REQUEST_LOG_PREFIX = "backend-requests"
CLIENT_TRACE_LOG_PREFIX = "frontend-trace"

# 注意：BaseHTTPMiddleware 的 call_next 在独立 task 中运行，contextvars 的
# set() 不会回传到中间件上下文，因此这里用可变容器（list/dict）承载累加值，
# 子 task 继承同一对象引用，修改对中间件可见。
_db_seconds: ContextVar[list | None] = ContextVar("db_seconds", default=None)
_conn_t0: ContextVar[dict | None] = ContextVar("conn_t0", default=None)

trace_logger = logging.getLogger("app.request_timing")
client_trace_logger = logging.getLogger("app.client_trace")
_log_dir: Path | None = None
# 类别 -> (已绑定的日期, handler)；写入时发现日期变了就换文件
_handlers: dict[str, tuple[str, logging.Handler]] = {}


def _log_directory() -> Path:
    global _log_dir
    if _log_dir is None:
        _log_dir = Path(os.getenv("LOG_DIR", str(PROJECT_ROOT / "data" / "logs")))
        _log_dir.mkdir(parents=True, exist_ok=True)
    return _log_dir


def _today() -> str:
    """当前业务日期（Asia/Shanghai），形如 2026-10-15。"""
    return datetime.now(BUSINESS_TZ).strftime("%Y-%m-%d")


def _bind_log_file(logger: logging.Logger, key: str, prefix: str) -> None:
    """把 logger 绑定到「当天」的日志文件；跨天时自动切换到新文件。"""
    day = _today()
    bound = _handlers.get(key)
    if bound is not None and bound[0] == day:
        return
    if bound is not None:
        logger.removeHandler(bound[1])
        bound[1].close()
    handler = RotatingFileHandler(
        _log_directory() / f"{prefix}-{day}.log",
        maxBytes=_LOG_MAX_BYTES,
        backupCount=_LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    _handlers[key] = (day, handler)
    if bound is not None:  # 只有跨天时才需要清理旧文件
        _prune_old_files(prefix)


def _prune_old_files(prefix: str) -> None:
    """删除保留期之外的旧日志（含轮转产生的 .1/.2 后缀文件）。"""
    cutoff = (datetime.now(BUSINESS_TZ) - timedelta(days=LOG_RETENTION_DAYS)).date()
    for path in _log_directory().glob(f"{prefix}-*.log*"):
        stamp = path.name[len(prefix) + 1:][:10]
        try:
            day = datetime.strptime(stamp, "%Y-%m-%d").date()
        except ValueError:
            continue
        if day < cutoff:
            try:
                path.unlink()
            except OSError:
                pass


def _setup_logging() -> Path:
    _bind_log_file(trace_logger, REQUEST_LOG_PREFIX, REQUEST_LOG_PREFIX)
    return _log_directory()


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
    """前端上报的耗时单独写一份日志，不与后端请求日志混在一起。"""
    _bind_log_file(client_trace_logger, CLIENT_TRACE_LOG_PREFIX, CLIENT_TRACE_LOG_PREFIX)
    client_trace_logger.info(json.dumps({
        "timestamp": datetime.now(BUSINESS_TZ).isoformat(),
        "type": "client_trace",
        **record,
    }, ensure_ascii=False))


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
        "timestamp": datetime.now(BUSINESS_TZ).isoformat(),
        "path": request.url.path,
        "method": request.method,
        "status_code": status_code,
        "total_ms": total_ms,
        "db_ms": db_ms,
        "handler_ms": round(total_ms - db_ms, 1),
        "client_ip": request.client.host if request.client else None,
        "user_id": getattr(request.state, "user_id", None),
    }, ensure_ascii=False))
