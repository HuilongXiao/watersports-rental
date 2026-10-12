"""Daily auto-export endpoints for superuser.

Auto-exports contain all groups' data, so only superuser can access them.
The scheduler generates a orders CSV and/or a customers CSV per day depending
on the two per-type flags; the ``/enabled`` endpoints read and write them.
"""

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import require_role
from app.db.session import get_db
from app.models.user import User
from app.services import auto_export_service

router = APIRouter(prefix="/api/auto-exports", tags=["auto-exports"])


@router.get("")
def list_auto_exports(
    _: User = Depends(require_role("superuser")),
):
    return auto_export_service.list_auto_exports()


@router.get("/enabled")
def get_auto_export_enabled(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    setting = auto_export_service.get_auto_export_setting(db)
    return {
        "orders_enabled": bool(setting.auto_export_orders_enabled),
        "customers_enabled": bool(setting.auto_export_customers_enabled),
    }


class SetEnabledInput(BaseModel):
    orders_enabled: bool = False
    customers_enabled: bool = False


@router.post("/enabled")
def set_auto_export_enabled(
    payload: SetEnabledInput,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    setting = auto_export_service.get_auto_export_setting(db)
    setting.auto_export_orders_enabled = payload.orders_enabled
    setting.auto_export_customers_enabled = payload.customers_enabled
    db.commit()
    return {
        "orders_enabled": payload.orders_enabled,
        "customers_enabled": payload.customers_enabled,
    }


@router.get("/{filename}/download")
def download_auto_export(
    filename: str,
    _: User = Depends(require_role("superuser")),
):
    path = auto_export_service.get_export_path(filename)
    return FileResponse(path=str(path), filename=filename, media_type="text/csv")


@router.delete("/{filename}")
def delete_auto_export(
    filename: str,
    _: User = Depends(require_role("superuser")),
):
    auto_export_service.delete_export(filename)
    return {"status": "ok"}
