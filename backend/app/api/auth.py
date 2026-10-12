from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import (
    SESSION_COOKIE_SECURE,
    SESSION_MAX_AGE_SECONDS,
    SESSION_SECRET,
)
from app.core.security import hash_password, verify_password
from app.db.session import get_db
from app.models.group import Group
from app.models.user import User
from app.services.user_service import find_by_username

router = APIRouter(prefix="/api/auth", tags=["auth"])
serializer = URLSafeTimedSerializer(SESSION_SECRET)
COOKIE_NAME = "rental_session"


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    try:
        user_id = serializer.loads(token, max_age=SESSION_MAX_AGE_SECONDS)
    except BadSignature as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="会话无效") from exc

    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="会话无效")
    return user


def get_active_group_id(request: Request, user: User = Depends(get_current_user)) -> str | None:
    """Return the group_id to filter by. Superuser can override via X-Active-Group header."""
    if user.role == "superuser":
        return request.headers.get("X-Active-Group")
    return user.group_id


def _user_payload(user: User, db: Session | None = None) -> dict:
    if user.role in ("superuser", "admin"):
        permissions = {
            "create_order": True,
            "edit_order": True,
            "export_report": True,
            "manage_users": True,
            "view_revenue": True,
        }
    else:
        permissions = {
            "create_order": user.perm_create_order,
            "edit_order": user.perm_edit_order,
            "export_report": user.perm_export_report,
            "manage_users": user.perm_manage_users,
            "view_revenue": user.perm_view_revenue,
        }
    group_name = None
    if user.group_id and db is not None:
        group = db.get(Group, user.group_id)
        if group:
            group_name = group.name
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "is_system": user.is_system,
        "role": user.role,
        "group_id": user.group_id,
        "group_name": group_name,
        "permissions": permissions,
    }


def require_permission(perm: str):
    """Dependency factory: allow superuser/admin, or user with the permission bit."""

    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.is_system:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="系统用户无操作权限")
        if user.role in ("superuser", "admin"):
            return user
        mapping = {
            "create_order": user.perm_create_order,
            "edit_order": user.perm_edit_order,
            "export_report": user.perm_export_report,
            "manage_users": user.perm_manage_users,
            "view_revenue": user.perm_view_revenue,
        }
        if not mapping.get(perm):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无此操作权限")
        return user

    return dependency


def require_role(*roles: str):
    """Dependency factory: allow only the listed roles."""

    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无此操作权限")
        return user

    return dependency


def get_current_group_id(user: User = Depends(get_current_user)) -> str | None:
    """Return the current user's group_id. None for superuser (sees all groups)."""
    if user.is_system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="系统用户无操作权限")
    return user.group_id


def require_group_member(user: User = Depends(get_current_user)) -> User:
    """Ensure user belongs to a group (blocks superuser from operational data creation)."""
    if user.is_system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="系统用户无操作权限")
    if user.group_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="超级管理员请使用管理员账号操作")
    return user


@router.post("/login")
def login(
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    user = find_by_username(db, form_data.username)
    invalid = not user or not user.is_active or not verify_password(form_data.password, user.password_hash)
    # The System User must never log in through the normal flow.
    if not invalid and user.is_system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="系统用户不可登录")
    if invalid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误")

    response.set_cookie(
        COOKIE_NAME,
        serializer.dumps(user.id),
        httponly=True,
        samesite="lax",
        secure=SESSION_COOKIE_SECURE,
        max_age=SESSION_MAX_AGE_SECONDS,
    )
    return {"status": "ok", "user": _user_payload(user, db)}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"status": "ok"}


@router.get("/me")
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _user_payload(user, db)


class ChangePasswordInput(BaseModel):
    old_password: str = Field(min_length=1)
    new_password: str = Field(min_length=1)


@router.post("/change-password")
def change_password(
    payload: ChangePasswordInput,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.old_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="原密码错误")
    user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"status": "ok"}
