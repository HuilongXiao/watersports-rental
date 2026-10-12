"""Database backup / restore endpoints.

Backups contain all groups' data, so only superuser can access them.
"""

from fastapi import APIRouter, Depends, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.auth import require_role
from app.db.session import get_db
from app.models.user import User
from app.services import backup_service

router = APIRouter(prefix="/api/backups", tags=["backups"])


@router.get("")
def list_backups(
    _: User = Depends(require_role("superuser")),
):
    return backup_service.list_backups()


@router.post("")
def create_backup(
    _: User = Depends(require_role("superuser")),
):
    path = backup_service.create_backup()
    return {"filename": path.name, "status": "ok"}


@router.get("/{filename}/download")
def download_backup(
    filename: str,
    _: User = Depends(require_role("superuser")),
):
    path, name = backup_service.download_backup(filename)
    return FileResponse(path=str(path), filename=name, media_type="application/octet-stream")


@router.post("/{filename}/restore")
def restore_backup(
    filename: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    backup_service.restore_backup(filename)
    return {"status": "ok", "restored_from": filename}


@router.delete("/{filename}")
def delete_backup(
    filename: str,
    _: User = Depends(require_role("superuser")),
):
    backup_service.delete_backup(filename)
    return {"status": "ok"}
