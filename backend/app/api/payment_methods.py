"""支付方式管理 API（per-Group 隔离）。

- GET：任何登录用户可读（前端展示 name 需要），但只看到自己 Group 的方式
- POST/PUT/DELETE：需要 manage_payment_methods 权限或 superuser/admin
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user, require_permission
from app.db.session import get_db
from app.models.user import User
from app.services import payment_method_service

router = APIRouter(prefix="/api/payment-methods", tags=["payment-methods"])


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
    active_group_id: str | None = Depends(get_active_group_id),
):
    methods = payment_method_service.list_methods(
        db, active_only=active_only, user_group_id=active_group_id
    )
    return [
        payment_method_service._method_dict(m)
        for m in methods
    ]


@router.post("")
def create_payment_method(
    payload: MethodCreateInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("manage_payment_methods")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return payment_method_service.create_method(
        db, user.id, payload.name, payload.code, user_group_id=active_group_id
    )


@router.put("/{method_id}")
def update_payment_method(
    method_id: int,
    payload: MethodUpdateInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("manage_payment_methods")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    if payload.name is None and payload.active is None and payload.is_default is None:
        raise HTTPException(status_code=422, detail="没有需要更新的字段")
    return payment_method_service.update_method(
        db, user.id, method_id,
        name=payload.name,
        active=payload.active,
        is_default=payload.is_default,
        user_group_id=active_group_id,
    )


@router.delete("/{method_id}")
def delete_payment_method(
    method_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("manage_payment_methods")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    """软删除（active=false）。默认方式必须先切换默认，否则 422。"""
    return payment_method_service.delete_method(
        db, user.id, method_id, user_group_id=active_group_id
    )
