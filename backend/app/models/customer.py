from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    gender: Mapped[str | None] = mapped_column(String(32), nullable=True)
    wechat_nickname: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # phone / wechat_id are unique *per Group* (different companies may share a
    # customer's phone); global uniqueness is deliberately NOT enforced.
    wechat_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    remind: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        # A standalone customer must carry at least a name or a wechat nickname;
        # any combination of the other fields (phone / wechat_id) is allowed.
        # The protected system customer ("游客" walk-in placeholder) is exempt.
        CheckConstraint(
            "is_system = 1 OR name IS NOT NULL OR wechat_nickname IS NOT NULL",
            name="ck_customers_identity",
        ),
        UniqueConstraint("group_id", "phone", name="uq_customers_group_phone"),
        UniqueConstraint("group_id", "wechat_id", name="uq_customers_group_wechat"),
    )
