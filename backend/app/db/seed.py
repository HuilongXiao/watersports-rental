"""Idempotent system seed data.

- One protected System User (cannot log in; actor for automatic operations).
- One normal administrator (from INITIAL_ADMIN_* env vars) — superuser, no group.
- Optionally a default Group, system customer "游客", and per-group settings
  (controlled by SEED_DEFAULT_DATA env var; set to "false" for fresh installs).

The equipment / sale-item catalog is managed by the operator in the UI and is
intentionally NOT seeded.
"""

import os
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import (
    INITIAL_ADMIN_PASSWORD,
    INITIAL_ADMIN_USERNAME,
    SYSTEM_USER_USERNAME,
)
from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models.customer import Customer
from app.models.group import Group
from app.models.payment_method import PaymentMethod
from app.models.settings import DEFAULT_AUTO_RETURN_MINUTES, SETTINGS_SINGLETON_ID, Setting
from app.models.user import User
from app.services.user_service import find_by_username


def _get_or_create_system_user(db: Session) -> User:
    system = db.scalar(select(User).where(User.is_system.is_(True)))
    if system is None:
        system = User(
            id=str(uuid4()),
            username=SYSTEM_USER_USERNAME,
            display_name="系统",
            password_hash=hash_password(f"system-{uuid4()}"),
            is_active=True,
            is_system=True,
        )
        db.add(system)
        db.flush()
    return system


def seed_system_data() -> None:
    db: Session = SessionLocal()
    try:
        system = _get_or_create_system_user(db)

        # 初始支付方式：CASH/现金（全局唯一默认，幂等；与 ENABLE_PAYMENT_METHOD
        # 开关无关，保证开启功能时数据已就绪）
        if db.scalar(select(PaymentMethod).where(PaymentMethod.code == "CASH")) is None:
            db.add(PaymentMethod(code="CASH", name="现金", is_default=True, active=True))

        admin = find_by_username(db, INITIAL_ADMIN_USERNAME)
        if admin is None:
            db.add(
                User(
                    id=str(uuid4()),
                    username=INITIAL_ADMIN_USERNAME,
                    display_name="管理员",
                    password_hash=hash_password(INITIAL_ADMIN_PASSWORD),
                    is_active=True,
                    is_system=False,
                    role="superuser",
                    group_id=None,
                )
            )
        elif admin.role != "superuser":
            admin.role = "superuser"

        # Password recovery: if SUPERUSER_PASSWORD_RESET is set, reset the password.
        reset_password = os.getenv("SUPERUSER_PASSWORD_RESET", "").strip()
        if reset_password and admin is not None:
            admin.password_hash = hash_password(reset_password)

        # Default group / customer / settings — skip on fresh installs.
        seed_default = os.getenv("SEED_DEFAULT_DATA", "true").lower() == "true"
        if not seed_default:
            db.commit()
            return

        default_group = db.scalar(select(Group))
        if default_group is None:
            default_group = Group(
                id=str(uuid4()),
                name="默认Group",
                is_active=True,
            )
            db.add(default_group)
            db.flush()

        guest = db.scalar(
            select(Customer).where(Customer.is_system.is_(True), Customer.name == "游客")
        )
        if guest is None:
            db.add(
                Customer(
                    id=str(uuid4()),
                    name="游客",
                    gender=None,
                    wechat_nickname=None,
                    wechat_id=None,
                    phone=None,
                    is_system=True,
                    group_id=default_group.id,
                    created_by_user_id=system.id,
                    updated_by_user_id=system.id,
                )
            )
        elif guest.group_id is None:
            guest.group_id = default_group.id

        existing_setting = db.scalar(select(Setting).where(Setting.group_id == default_group.id))
        if existing_setting is None:
            old = db.get(Setting, SETTINGS_SINGLETON_ID)
            if old is not None:
                old.group_id = default_group.id
            else:
                db.add(
                    Setting(
                        id=str(uuid4()),
                        group_id=default_group.id,
                        auto_return_after_minutes=DEFAULT_AUTO_RETURN_MINUTES,
                        updated_by_user_id=system.id,
                    )
                )

        db.commit()
    finally:
        db.close()
