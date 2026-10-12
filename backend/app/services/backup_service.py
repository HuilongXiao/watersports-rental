"""SQLite database backup and restore.

Backups are stored as timestamped ``.db`` files inside ``BACKUP_DIR``. Both
backup and restore use the SQLite online backup API (``sqlite3.Connection.backup``)
which produces a consistent snapshot without taking the database offline.
"""

import re
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException

from app.core.config import BACKUP_DIR, DATABASE_URL, SQLITE_PATH
from app.db.session import engine

BACKUP_NAME_RE = re.compile(r"^backup_\d{8}_\d{6}\.db$")


def _assert_sqlite() -> None:
    if not DATABASE_URL.startswith("sqlite"):
        raise HTTPException(status_code=400, detail="仅支持 SQLite 数据库的备份与恢复")


def create_backup() -> Path:
    """Create a timestamped backup file and return its path."""
    _assert_sqlite()
    filename = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    dest = BACKUP_DIR / filename
    source_conn = sqlite3.connect(SQLITE_PATH)
    target_conn = sqlite3.connect(str(dest))
    try:
        source_conn.backup(target_conn)
    finally:
        target_conn.close()
        source_conn.close()
    return dest


def list_backups() -> list[dict]:
    """List all backup files sorted newest-first."""
    files = sorted(BACKUP_DIR.glob("backup_*.db"), reverse=True)
    result = []
    for f in files:
        stat = f.stat()
        result.append(
            {
                "filename": f.name,
                "size_bytes": stat.st_size,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
            }
        )
    return result


def _resolve_backup_path(filename: str) -> Path:
    if not BACKUP_NAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="无效的备份文件名")
    path = (BACKUP_DIR / filename).resolve()
    # Prevent path traversal: resolved path must stay inside BACKUP_DIR.
    if not str(path).startswith(str(BACKUP_DIR.resolve())):
        raise HTTPException(status_code=400, detail="无效的备份文件名")
    if not path.exists():
        raise HTTPException(status_code=404, detail="备份文件不存在")
    return path


def download_backup(filename: str) -> tuple[Path, str]:
    """Return (path, filename) for downloading a backup file."""
    _assert_sqlite()
    path = _resolve_backup_path(filename)
    return path, path.name


def restore_backup(filename: str) -> None:
    """Restore the database from a backup file.

    Closes all pooled connections, then uses the SQLite backup API to overwrite
    the main database file. New connections created afterwards will see the
    restored data.
    """
    _assert_sqlite()
    src_path = _resolve_backup_path(filename)

    # Release all pooled connections so the file is not locked.
    engine.dispose()

    source_conn = sqlite3.connect(str(src_path))
    target_conn = sqlite3.connect(SQLITE_PATH)
    try:
        source_conn.backup(target_conn)
    finally:
        target_conn.close()
        source_conn.close()

    # Remove stale WAL/SHM sidecar files left by the previous database.
    for suffix in ("-wal", "-shm"):
        sidecar = Path(SQLITE_PATH + suffix)
        if sidecar.exists():
            sidecar.unlink()


def delete_backup(filename: str) -> None:
    """Delete a backup file."""
    path = _resolve_backup_path(filename)
    path.unlink()
