from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.settings import DEFAULT_AUTO_RETURN_MINUTES, Setting
from app.models.user import User


def get_settings(db: Session, group_id: str) -> Setting:
    setting = db.scalar(select(Setting).where(Setting.group_id == group_id))
    if setting is None:
        system = db.scalar(select(User).where(User.is_system.is_(True)))
        setting = Setting(
            id=str(uuid4()),
            group_id=group_id,
            auto_return_after_minutes=DEFAULT_AUTO_RETURN_MINUTES,
            updated_by_user_id=system.id if system else "",
        )
        db.add(setting)
        db.flush()
    return setting


def update_settings(
    db: Session, user: User, auto_return_after_minutes: int, group_id: str | None = None,
    *, fast_customer_mode: bool = False,
) -> Setting:
    if auto_return_after_minutes < 1:
        raise ValueError("auto_return_after_minutes must be >= 1")
    effective_group_id = group_id or user.group_id
    if not effective_group_id:
        raise ValueError("当前用户未归属任何 Group")
    setting = get_settings(db, effective_group_id)
    setting.auto_return_after_minutes = auto_return_after_minutes
    setting.fast_customer_mode = fast_customer_mode
    setting.updated_by_user_id = user.id
    db.commit()
    db.refresh(setting)
    return setting
