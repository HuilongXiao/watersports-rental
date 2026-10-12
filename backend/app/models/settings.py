from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now

# Kept for backward compatibility with existing rows; new rows use UUID ids.
SETTINGS_SINGLETON_ID = "singleton"
DEFAULT_AUTO_RETURN_MINUTES = 120


class Setting(Base):
    """Per-group system settings table.

    Only genuine settings live here. Order duration, business timezone and the
    daily forced return window are fixed business rules, not settings.
    """

    __tablename__ = "settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    auto_return_after_minutes: Mapped[int] = mapped_column(
        Integer, default=DEFAULT_AUTO_RETURN_MINUTES, nullable=False
    )
    auto_export_orders_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    auto_export_customers_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    fast_customer_mode: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "auto_return_after_minutes >= 1", name="ck_settings_auto_return_minutes_positive"
        ),
    )
