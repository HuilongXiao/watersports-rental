"""Group (multi-tenant) management — superuser only."""

from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import get_current_user, require_role
from app.core.security import hash_password
from app.db.session import get_db
from app.models.customer import Customer
from app.models.group import Group
from app.models.payment_method import PaymentMethod
from app.models.settings import DEFAULT_AUTO_RETURN_MINUTES, Setting
from app.models.user import User
from app.serializers import user_dict
from app.services.user_service import next_operator_code, normalize_username, username_exists

router = APIRouter(prefix="/api/groups", tags=["groups"])


class GroupCreateInput(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class GroupUpdateInput(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    is_active: bool | None = None


class ManagerCreateInput(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1)

    @field_validator("username")
    @classmethod
    def _strip_username(cls, value: str) -> str:
        value = normalize_username(value)
        if not value:
            raise ValueError("用户名不能为空")
        return value


def _group_dict(g: Group, member_count: int = 0) -> dict:
    return {
        "id": g.id,
        "name": g.name,
        "is_active": g.is_active,
        "member_count": member_count,
        "created_at": g.created_at.isoformat() + "Z" if g.created_at else None,
    }


def _count_members(db: Session, group_id: str) -> int:
    rows = list(
        db.scalars(
            select(User).where(User.group_id == group_id, User.is_system.is_(False))
        ).all()
    )
    return len(rows)


@router.get("")
def list_groups(
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    groups = list(db.scalars(select(Group).order_by(Group.created_at)).all())
    return [_group_dict(g, _count_members(db, g.id)) for g in groups]


@router.post("")
def create_group(
    payload: GroupCreateInput,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    name = payload.name.strip()
    if db.scalar(select(Group).where(Group.name == name)):
        raise HTTPException(status_code=409, detail="Group名称已存在")
    group = Group(id=str(uuid4()), name=name, is_active=True)
    db.add(group)
    db.flush()
    # Create system customer "游客" for this group.
    system = db.scalar(select(User).where(User.is_system.is_(True)))
    actor_id = system.id if system else ""
    db.add(
        Customer(
            id=str(uuid4()),
            name="游客",
            is_system=True,
            group_id=group.id,
            created_by_user_id=actor_id,
            updated_by_user_id=actor_id,
        )
    )
    # Create default settings for this group.
    db.add(
        Setting(
            id=str(uuid4()),
            group_id=group.id,
            auto_return_after_minutes=DEFAULT_AUTO_RETURN_MINUTES,
            updated_by_user_id=actor_id,
        )
    )
    # 为新 group seed 默认支付方式「现金」，保证该 group 下单时可立即选用。
    # 支付方式已按 group 隔离，必须随 group 创建一并初始化。
    db.add(
        PaymentMethod(
            group_id=group.id,
            code="CASH",
            name="现金",
            is_default=True,
            active=True,
        )
    )
    db.commit()
    db.refresh(group)
    return _group_dict(group, 0)


@router.patch("/{group_id}")
def update_group(
    group_id: str,
    payload: GroupUpdateInput,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    group = db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group不存在")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        name = data["name"].strip()
        clash = db.scalar(select(Group).where(Group.name == name, Group.id != group_id))
        if clash:
            raise HTTPException(status_code=409, detail="Group名称已存在")
        group.name = name
    if "is_active" in data:
        group.is_active = data["is_active"]
    db.commit()
    db.refresh(group)
    return _group_dict(group, _count_members(db, group.id))


@router.get("/{group_id}/members")
def list_members(
    group_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    group = db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group不存在")
    users = list(
        db.scalars(
            select(User)
            .where(User.group_id == group_id, User.is_system.is_(False))
            .order_by(User.created_at)
        ).all()
    )
    return [user_dict(u) for u in users]


@router.post("/{group_id}/managers")
def create_manager(
    group_id: str,
    payload: ManagerCreateInput,
    db: Session = Depends(get_db),
    _: User = Depends(require_role("superuser")),
):
    group = db.get(Group, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Group不存在")
    if not group.is_active:
        raise HTTPException(status_code=409, detail="Group已停用")
    if username_exists(db, payload.username):
        raise HTTPException(status_code=409, detail="用户名已存在")
    operator_code = next_operator_code(db, group_id)
    if operator_code is None:
        raise HTTPException(status_code=422, detail="该 Group 的操作员编号已达上限（Z9）")
    manager = User(
        id=str(uuid4()),
        username=payload.username,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
        is_active=True,
        is_system=False,
        role="admin",
        group_id=group_id,
        operator_code=operator_code,
    )
    db.add(manager)
    db.commit()
    db.refresh(manager)
    return user_dict(manager)
