import os
from pathlib import Path

# config.py lives at backend/app/core/config.py: parents[2] is backend/.
BASE_DIR = Path(__file__).resolve().parents[2]
PROJECT_ROOT = BASE_DIR.parent

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/rental_app.db")

if DATABASE_URL.startswith("sqlite"):
    SQLITE_PATH = DATABASE_URL.replace("sqlite:///", "")
    if not SQLITE_PATH.startswith("/"):
        SQLITE_PATH = str((PROJECT_ROOT / SQLITE_PATH).resolve())
    Path(SQLITE_PATH).parent.mkdir(parents=True, exist_ok=True)

# 镜像内以空值预填这些变量名（部署时由用户填写）；空字符串按未设置处理，
# 回退到默认值，避免留空导致异常。
INITIAL_ADMIN_USERNAME = os.getenv("INITIAL_ADMIN_USERNAME") or "superuserx"
INITIAL_ADMIN_PASSWORD = os.getenv("INITIAL_ADMIN_PASSWORD") or "123456"
SESSION_SECRET = os.getenv("SESSION_SECRET") or "change-me-in-production"
SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true"
SESSION_MAX_AGE_SECONDS = 24 * 60 * 60

# Fixed business rules (not editable settings).
BUSINESS_TIMEZONE = "Asia/Shanghai"
ORDER_DURATION_HOURS = 2
SYSTEM_USER_USERNAME = os.getenv("SYSTEM_USER_USERNAME", "system")

# Database backup directory (mounted as ./backups:/app/backups in Docker).
BACKUP_DIR = Path(os.getenv("BACKUP_DIR", str(PROJECT_ROOT / "backups")))
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

# Auto-export directory for the daily superuser CSV exports
# (mounted as ./exports:/app/exports in Docker).
AUTO_EXPORT_DIR = Path(os.getenv("AUTO_EXPORT_DIR", str(PROJECT_ROOT / "exports")))
AUTO_EXPORT_DIR.mkdir(parents=True, exist_ok=True)

# Request timing middleware (X-Server-Timing header + JSON log).
# Default on for dev/debug; set REQUEST_TIMING=0 (or false) to disable in production.
REQUEST_TIMING = os.getenv("REQUEST_TIMING", "1").lower() not in ("0", "false", "off")

# POST /api/_trace client-side trace reporting endpoint. Default off to avoid
# generating large amounts of logs; enable with TRACE_REPORT_ENABLED=1.
TRACE_REPORT_ENABLED = os.getenv("TRACE_REPORT_ENABLED", "0").lower() in ("1", "true", "on")
