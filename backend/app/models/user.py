from sqlalchemy import Boolean, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    role: Mapped[str] = mapped_column(String(16), default="user", nullable=False)
    perm_create_order: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    perm_edit_order: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    perm_export_report: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    perm_manage_users: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    perm_view_revenue: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 添加支付方式（MANAGE_PAYMENT_METHODS）：控制谁可以管理支付方式
    perm_manage_payment_methods: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)
