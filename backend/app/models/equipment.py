from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now

# Seven palette choices offered to operators when creating an equipment type.
EQUIPMENT_TYPE_COLORS = ("red", "blue", "green", "yellow", "purple", "orange", "cyan")
DEFAULT_EQUIPMENT_TYPE_COLOR = "blue"


class EquipmentType(Base):
    __tablename__ = "equipment_types"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    color: Mapped[str] = mapped_column(
        String(16), default=DEFAULT_EQUIPMENT_TYPE_COLOR, nullable=False
    )
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    # V1 never deletes catalog rows (deactivate instead), so no delete cascade.
    equipment_specs: Mapped[list["EquipmentSpec"]] = relationship(back_populates="equipment_type")

    __table_args__ = (
        CheckConstraint(
            "color IN (" + ", ".join(f"'{c}'" for c in EQUIPMENT_TYPE_COLORS) + ")",
            name="ck_equipment_types_color",
        ),
    )


class EquipmentSpec(Base):
    __tablename__ = "equipment_specs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    equipment_type_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("equipment_types.id"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    price: Mapped[int] = mapped_column(Integer, nullable=False)
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 操作员自定义的展示顺序（创建订单下拉、预测页等均遵照此顺序）
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    equipment_type: Mapped[EquipmentType] = relationship(back_populates="equipment_specs")

    __table_args__ = (
        UniqueConstraint("equipment_type_id", "name", name="uq_equipment_specs_type_name"),
        CheckConstraint("price >= 0", name="ck_equipment_specs_price_non_negative"),
        CheckConstraint("capacity IS NULL OR capacity >= 1", name="ck_equipment_specs_capacity"),
    )


class SaleItem(Base):
    __tablename__ = "sale_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    price: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (CheckConstraint("price >= 0", name="ck_sale_items_price_non_negative"),)
