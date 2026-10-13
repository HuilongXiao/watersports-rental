"""支付方式管理 API（feature flag: ENABLE_PAYMENT_METHOD）。

- 未开启：所有端点返回 404（功能不存在）
- GET：任何登录用户可读（前端展示 name 需要）
- POST/PUT/DELETE：需要 manage_payment_methods 权限或 superuser/admin
  （require_permission 已内置 superuser/admin 放行）

回滚方式：删除本文件与 main.py 中的 include_router 即可。
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import get_current_user, require_permission
from app.core.config import ENABLE_PAYMENT_METHOD
from app.db.session import get_db
from app.models.user import User
from app.services import payment_method_service

router = APIRouter(prefix="/api/payment-methods", tags=["payment-methods"])


def _require_enabled() -> None:
    if not ENABLE_PAYMENT_METHOD:
        raise HTTPException(status_code=404, detail="支付方式功能未启用")


class MethodCreateInput(BaseModel):
    name: str
    code: str | None = None


class MethodUpdateInput(BaseModel):
    name: str | None = None
    active: bool | None = None
    is_default: bool | None = None


@router.get("")
def list_payment_methods(
    active_only: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_enabled()
    methods = payment_method_service.list_methods(db, active_only=active_only)
    return [
        {"code": m.code, "name": m.name, "is_default": m.is_default, "active": m.active}
        for m in methods
    ]


@router.post("")
def create_payment_method(
    payload: MethodCreateInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("manage_payment_methods")),
):
    _require_enabled()
    return payment_method_service.create_method(db, user.id, payload.name, payload.code)


@router.put("/{code}")
def update_payment_method(
    code: str,
    payload: MethodUpdateInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("manage_payment_methods")),
):
    _require_enabled()
    if payload.name is None and payload.active is None and payload.is_default is None:
        raise HTTPException(status_code=422, detail="没有需要更新的字段")
    return payment_method_service.update_method(
        db,
        user.id,
        code,
        name=payload.name,
        active=payload.active,
        is_default=payload.is_default,
    )


@router.delete("/{code}")
def delete_payment_method(
    code: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("manage_payment_methods")),
):
    """软删除（active=false）。默认方式必须先切换默认，否则 422。"""
    _require_enabled()
    return payment_method_service.update_method(db, user.id, code, active=False)
