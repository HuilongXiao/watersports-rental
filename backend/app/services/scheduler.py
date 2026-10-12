"""Background scheduler for automatic order returns and daily exports.

Started by the FastAPI lifespan as an asyncio task:

- Every 60 seconds: auto-return checked-in orders past their deadline.
- Every 60 seconds: if inside the 23:59 Asia/Shanghai window, run the daily
  forced return safety net.
- Every 60 seconds: if inside the 00:00 Asia/Shanghai window, run the daily
  superuser auto-export of orders/customers as CSV files.

DB work runs in a worker thread (``asyncio.to_thread``) so the event loop is
never blocked. SQLite with ``check_same_thread=False`` makes this safe.
"""

import asyncio
import logging
import os

from app.core.time_utils import (
    BUSINESS_TZ,
    DAILY_AUTO_EXPORT_END_SECOND,
    DAILY_AUTO_EXPORT_START_SECOND,
    DAILY_FORCED_RETURN_END_SECOND,
    DAILY_FORCED_RETURN_START_SECOND,
    to_shanghai,
    utc_now,
)
from app.db.session import SessionLocal
from app.services import auto_export_service, order_service

logger = logging.getLogger(__name__)

SCAN_INTERVAL_SECONDS = 60


def _is_scheduler_disabled() -> bool:
    return os.getenv("DISABLE_SCHEDULER", "").lower() == "true"


def _in_daily_forced_return_window() -> bool:
    """True when the current Asia/Shanghai time is inside the 23:59:01-23:59:59 window."""
    now_sh = to_shanghai(utc_now())
    second_of_day = now_sh.hour * 3600 + now_sh.minute * 60 + now_sh.second
    return DAILY_FORCED_RETURN_START_SECOND <= second_of_day <= DAILY_FORCED_RETURN_END_SECOND


def _in_daily_auto_export_window() -> bool:
    """True when the current Asia/Shanghai time is inside the 00:00:01-00:00:59 window."""
    now_sh = to_shanghai(utc_now())
    second_of_day = now_sh.hour * 3600 + now_sh.minute * 60 + now_sh.second
    return DAILY_AUTO_EXPORT_START_SECOND <= second_of_day <= DAILY_AUTO_EXPORT_END_SECOND


def _run_auto_return() -> None:
    db = SessionLocal()
    try:
        returned = order_service.auto_return_overdue_orders(db)
        if returned:
            logger.info("auto-return processed %d order(s)", len(returned))
    finally:
        db.close()


def _run_daily_forced_return() -> None:
    db = SessionLocal()
    try:
        returned = order_service.daily_forced_return(db)
        if returned:
            logger.info("daily forced return processed %d order(s)", len(returned))
    finally:
        db.close()


def _run_daily_auto_export() -> None:
    db = SessionLocal()
    try:
        setting = auto_export_service.get_auto_export_setting(db)
        include_orders = bool(setting.auto_export_orders_enabled)
        include_customers = bool(setting.auto_export_customers_enabled)
        if not include_orders and not include_customers:
            return
        result = auto_export_service.run_daily_export(db, include_orders, include_customers)
        if result.get("produced"):
            logger.info("daily auto export produced %s", result["produced"])
    except Exception:
        logger.exception("daily auto export failed")
    finally:
        db.close()


# Flag to avoid running the daily auto-export twice in the same 00:00 window.
_daily_auto_export_done = False


async def _scheduler_loop() -> None:
    global _daily_auto_export_done
    while True:
        try:
            await asyncio.to_thread(_run_auto_return)
            if _in_daily_forced_return_window():
                await asyncio.to_thread(_run_daily_forced_return)
            if _in_daily_auto_export_window():
                if not _daily_auto_export_done:
                    await asyncio.to_thread(_run_daily_auto_export)
                    _daily_auto_export_done = True
            else:
                # Reset once outside the window so it can run again the next day.
                _daily_auto_export_done = False
        except Exception:
            logger.exception("scheduler iteration failed")
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)


_scheduler_task: asyncio.Task | None = None


def start_scheduler() -> None:
    """Start the background scheduler task (no-op when DISABLE_SCHEDULER=true)."""
    global _scheduler_task
    if _is_scheduler_disabled():
        return
    if _scheduler_task is None or _scheduler_task.done():
        _scheduler_task = asyncio.create_task(_scheduler_loop())


def stop_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task is not None:
        _scheduler_task.cancel()
        _scheduler_task = None
