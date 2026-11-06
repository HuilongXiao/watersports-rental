"""Boat IDs & dispatch — the "船只编号 / 船只调配" feature.

Each equipment spec owns a set of individually numbered units (boats). A
dispatch record tracks which boat number is currently "出发" (checked out) on
a given order's equipment line, and when it is returned ("返还").

Enabling the "船只编号" setting is only allowed once every spec has a complete
set of boat numbers matching its configured total_quantity.
"""

from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class BoatNumber(Base):
    """A single numbered unit belonging to an equipment spec."""

    __tablename__ = "boat_numbers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    equipment_spec_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("equipment_specs.id"), nullable=False, index=True
    )
    # Operator-facing number text, e.g. "038", "A12".
    # 全局规则：同一 Group 内所有器材的编号都不能相同。
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("group_id", "number", name="uq_boat_numbers_group_number"),
    )


class BoatDispatch(Base):
    """One boat number currently on a dispatch (出发 / 返还 lifecycle)."""

    __tablename__ = "boat_dispatches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    order_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("orders.id"), nullable=False, index=True
    )
    order_item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("order_items.id"), nullable=False, index=True
    )
    equipment_spec_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("equipment_specs.id"), nullable=False, index=True
    )
    boat_number_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("boat_numbers.id"), nullable=False, index=True
    )
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    # 出发 (departed). A given boat number may be dispatched at most once at a time.
    departed: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    departed_at: Mapped[object | None] = mapped_column(UtcDateTime(), nullable=True)
    departed_by_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 返还
    returned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    returned_at: Mapped[object | None] = mapped_column(UtcDateTime(), nullable=True)
    returned_by_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)