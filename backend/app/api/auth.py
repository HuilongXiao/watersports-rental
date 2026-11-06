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
from app.core.login_guard import BlockStatus, check_block, record_blocked_attempt, record_failure
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
    # 供请求耗时中间件记录 user_id
    request.state.user_id = user.id
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
            "manage_payment_methods": True,
            "boat_dispatch": True,
        }
    else:
        permissions = {
            "create_order": user.perm_create_order,
            "edit_order": user.perm_edit_order,
            "export_report": user.perm_export_report,
            "manage_users": user.perm_manage_users,
            "view_revenue": user.perm_view_revenue,
            "manage_payment_methods": user.perm_manage_payment_methods,
            "boat_dispatch": user.perm_boat_dispatch,
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
        "operator_code": user.operator_code,
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
            "manage_payment_methods": user.perm_manage_payment_methods,
            "boat_dispatch": user.perm_boat_dispatch,
        }
        if not mapping.get(perm):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无此操作权限")
        return user

    return dependency


def require_admin(user: User = Depends(get_current_user)) -> User:
    """仅管理员与超级管理员可操作（用于付款方式等系统级配置）。"""

    if user.is_system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="系统用户无操作权限")
    if user.role not in ("superuser", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可操作")
    return user


def can_view_revenue(user: User) -> bool:
    """是否允许读取营收/金额类统计（管理员与超级管理员始终允许）。"""
    return user.role in ("superuser", "admin") or bool(user.perm_view_revenue)


def require_any_permission(*perms: str):
    """Dependency factory: allow superuser/admin, or user holding any one of the perms."""

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
            "manage_payment_methods": user.perm_manage_payment_methods,
            "boat_dispatch": user.perm_boat_dispatch,
        }
        if not any(mapping.get(p) for p in perms):
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


def _client_ip(request: Request) -> str:
    """取真实来源 IP：优先反向代理写入的 X-Real-IP / X-Forwarded-For。"""
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _block_exception(block: BlockStatus) -> HTTPException:
    if block.permanent:
        return HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="登录失败次数过多，该 IP 已被永久锁定，请联系管理员解锁",
        )
    seconds = block.retry_after or 1
    hours = (seconds + 3599) // 3600
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"登录失败次数过多，该 IP 已被锁定 24 小时，请在约 {hours} 小时后重试",
        headers={"Retry-After": str(seconds)},
    )


@router.post("/login")
def login(
    request: Request,
    response: Response,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    username = form_data.username.strip()
    client_ip = _client_ip(request)
    block = check_block(client_ip)
    if block is not None:
        if not block.permanent:
            # 24 小时锁定期间继续尝试，达到 10 次/10 分钟即升级为永久锁定。
            escalated = record_blocked_attempt(client_ip)
            if escalated is not None:
                raise _block_exception(escalated)
        raise _block_exception(block)

    user = find_by_username(db, username)
    invalid = not user or not user.is_active or not verify_password(form_data.password, user.password_hash)
    # The System User must never log in through the normal flow.
    if not invalid and user.is_system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="系统用户不可登录")
    if invalid:
        new_block = record_failure(client_ip)
        if new_block is not None:
            raise _block_exception(new_block)
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
