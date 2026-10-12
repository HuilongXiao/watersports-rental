from sqlalchemy import CheckConstraint, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class InventoryConfiguration(Base):
    __tablename__ = "inventory_configurations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    equipment_spec_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("equipment_specs.id"), unique=True, nullable=False, index=True
    )
    total_quantity: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        CheckConstraint("total_quantity >= 0", name="ck_inventory_total_non_negative"),
    )
