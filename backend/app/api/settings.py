from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
from app.core.config import ENABLE_PAYMENT_METHOD
from app.core.time_utils import to_iso_z
from app.db.session import get_db
from app.models.group import Group
from app.models.user import User
from app.services import payment_method_service, settings_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsInput(BaseModel):
    auto_return_after_minutes: int = Field(ge=1)
    fast_customer_mode: bool = False


def _resolve_group_id(db: Session, user: User, active_group_id: str | None) -> str:
    """Return the effective group id for fetching settings.

    Superuser (no group) manages the default group's settings. Other roles use
    their own group. When ``active_group_id`` is provided (superuser switching
    group), it takes precedence over the fallback first-group behaviour.
    """
    if active_group_id:
        return active_group_id
    if user.group_id:
        return user.group_id
    group = db.scalar(select(Group))
    if group is None:
        raise HTTPException(status_code=409, detail="尚无 Group，无法读取设置")
    return group.id


@router.get("")
def get_settings(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    group_id = _resolve_group_id(db, user, active_group_id)
    setting = settings_service.get_settings(db, group_id)
    result = {
        "auto_return_after_minutes": setting.auto_return_after_minutes,
        "fast_customer_mode": setting.fast_customer_mode,
        "updated_at": to_iso_z(setting.updated_at),
    }
    # 支付方式功能开启时随设置一起返回（active 列表 + 默认 code），
    # 前端 SettingsContext 一次请求取齐，避免额外往返
    if ENABLE_PAYMENT_METHOD:
        methods = payment_method_service.list_methods(db, active_only=True)
        result["payment_methods"] = [
            {"code": m.code, "name": m.name, "is_default": m.is_default} for m in methods
        ]
        default_method = next((m for m in methods if m.is_default), None)
        result["default_payment_method"] = default_method.code if default_method else None
    else:
        result["payment_methods"] = []
        result["default_payment_method"] = None
    return result


@router.put("")
def update_settings(
    payload: SettingsInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    group_id = _resolve_group_id(db, user, active_group_id)
    try:
        setting = settings_service.update_settings(
            db, user, payload.auto_return_after_minutes, group_id,
            fast_customer_mode=payload.fast_customer_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "auto_return_after_minutes": setting.auto_return_after_minutes,
        "fast_customer_mode": setting.fast_customer_mode,
        "updated_at": to_iso_z(setting.updated_at),
    }
