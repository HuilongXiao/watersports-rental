"""User management API (RBAC: superuser > admin > user)."""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
from app.core.security import hash_password
from app.db.session import get_db
from app.models.group import Group
from app.models.user import User
from app.serializers import user_dict
from app.services.user_service import normalize_username, username_exists

router = APIRouter(prefix="/api/users", tags=["users"])

VALID_ROLES = {"superuser", "admin", "user"}


class UserCreateInput(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1)
    role: str = Field(default="user")
    group_id: str | None = None
    perm_create_order: bool = False
    perm_edit_order: bool = False
    perm_export_report: bool = False
    perm_manage_users: bool = False
    perm_view_revenue: bool = False
    perm_manage_payment_methods: bool = False

    @field_validator("username")
    @classmethod
    def _strip_username(cls, value: str) -> str:
        value = normalize_username(value)
        if not value:
            raise ValueError("用户名不能为空")
        return value


class UserUpdateInput(BaseModel):
    display_name: str | None = None
    password: str | None = None
    role: str | None = None
    perm_create_order: bool | None = None
    perm_edit_order: bool | None = None
    perm_export_report: bool | None = None
    perm_manage_users: bool | None = None
    perm_view_revenue: bool | None = None
    perm_manage_payment_methods: bool | None = None
    is_active: bool | None = None


def _can_list_users(user: User) -> bool:
    if user.is_system:
        return False
    if user.role in ("superuser", "admin"):
        return True
    return bool(user.perm_manage_users)


@router.get("")
def list_users(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    if not _can_list_users(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "无此操作权限")
    stmt = select(User).where(User.is_system.is_(False))
    if user.role == "superuser":
        if active_group_id is not None:
            stmt = stmt.where(User.group_id == active_group_id, User.role != "superuser")
        else:
            pass  # superuser sees all non-system users
    else:
        # admin and user-managers see only their group, and cannot see superusers.
        stmt = stmt.where(User.group_id == user.group_id, User.role != "superuser")
        if user.role == "admin":
            pass  # admin sees all non-superuser users in their group
        else:  # user with manage_users permission
            stmt = stmt.where(User.role == "user")
    users = list(db.scalars(stmt.order_by(User.created_at)))
    return [user_dict(u) for u in users]


@router.post("")
def create_user(
    payload: UserCreateInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    if user.is_system or user.role not in ("superuser", "admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "无此操作权限")
    if payload.role not in VALID_ROLES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "角色无效")
    if user.role == "admin" and payload.role != "user":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "管理员只能创建普通用户")

    # Resolve the new user's group_id.
    if user.role == "superuser":
        # Superuser may optionally specify a group_id; when an active group is
        # selected, default to it. Otherwise leave None.
        target_group_id = payload.group_id if payload.group_id is not None else active_group_id
        if target_group_id is not None and not db.get(Group, target_group_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Group不存在")
    else:  # admin
        # Admin creates users in their own group; ignore payload.group_id.
        target_group_id = user.group_id

    if username_exists(db, payload.username):
        raise HTTPException(status.HTTP_409_CONFLICT, "用户名已存在")

    new_user = User(
        id=str(uuid4()),
        group_id=target_group_id,
        username=payload.username,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
        is_active=True,
        is_system=False,
        role=payload.role,
        perm_create_order=payload.perm_create_order,
        perm_edit_order=payload.perm_edit_order,
        perm_export_report=payload.perm_export_report,
        perm_manage_users=payload.perm_manage_users,
        perm_view_revenue=payload.perm_view_revenue,
        perm_manage_payment_methods=payload.perm_manage_payment_methods,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return user_dict(new_user)


@router.patch("/{user_id}")
def update_user(
    user_id: str,
    payload: UserUpdateInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "用户不存在")
    if target.is_system:
        raise HTTPException(status.HTTP_409_CONFLICT, "系统用户不可修改")
    if user.is_system:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "系统用户无操作权限")
    if user.id == target.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "不能编辑自己")

    data = payload.model_dump(exclude_unset=True)

    if user.role == "superuser":
        pass  # full control over any non-system user
    elif user.role == "admin":
        # Admin can only manage users in their own group.
        if target.group_id != user.group_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "无权管理其他 Group 的用户")
        if target.role != "user":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "管理员只能管理普通用户")
        if data.get("role") not in (None, "user"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "管理员不能提升用户角色")
    else:  # role == "user"
        if not user.perm_manage_users:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "无此操作权限")
        if target.group_id != user.group_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "无权管理其他 Group 的用户")
        if target.role != "user":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "只能管理普通用户")
        if any(k != "is_active" for k in data):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "仅可启停账户状态")

    if "role" in data and data["role"] not in VALID_ROLES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "角色无效")

    if "password" in data:
        pwd = data.pop("password")
        if pwd:
            target.password_hash = hash_password(pwd)
    if "role" in data:
        target.role = data.pop("role")
    for field in (
        "display_name",
        "perm_create_order",
        "perm_edit_order",
        "perm_export_report",
        "perm_manage_users",
        "perm_view_revenue",
        "perm_manage_payment_methods",
        "is_active",
    ):
        if field in data:
            setattr(target, field, data[field])

    db.commit()
    db.refresh(target)
    return user_dict(target)
