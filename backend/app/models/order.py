from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now

ORDER_STATUSES = ("active", "in_progress", "cancelled", "no_show", "completed")


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    order_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    customer_id: Mapped[str] = mapped_column(String(36), ForeignKey("customers.id"), nullable=False, index=True)

    # Customer snapshot (must not be rewritten when the customer is edited later).
    customer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    customer_gender: Mapped[str | None] = mapped_column(String(32), nullable=True)
    customer_wechat_nickname: Mapped[str | None] = mapped_column(String(128), nullable=True)
    customer_wechat_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    customer_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)

    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False, index=True)
    start_at: Mapped[object] = mapped_column(UtcDateTime(), nullable=False)
    end_at: Mapped[object] = mapped_column(UtcDateTime(), nullable=False)
    adult_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    child_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 散客标记：创建订单时由操作员手动勾选，用于订单导出识别散客单
    is_walk_in: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 备注弹窗标记：勾选后打开订单详情时弹窗展示备注内容，列表中客户名显示为红色
    note_popup: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 支付方式 code（对应 payment_methods.code，可为空=未选择）
    payment_method_code: Mapped[str | None] = mapped_column(String(32), nullable=True)

    check_in_at: Mapped[object | None] = mapped_column(UtcDateTime(), nullable=True)
    check_in_by_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    auto_return_after_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    auto_return_at: Mapped[object | None] = mapped_column(UtcDateTime(), nullable=True)
    auto_return_occurred: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    return_at: Mapped[object | None] = mapped_column(UtcDateTime(), nullable=True)
    return_by_user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    daily_forced_return_occurred: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        # Order status is validated in application code (ALLOWED_TRANSITIONS),
        # not by a DB CHECK constraint, so new statuses do not need a table rebuild.
        CheckConstraint("adult_count >= 0", name="ck_orders_adult_non_negative"),
        CheckConstraint("child_count >= 0", name="ck_orders_child_non_negative"),
        CheckConstraint("adult_count + child_count >= 1", name="ck_orders_people_at_least_one"),
        CheckConstraint("end_at > start_at", name="ck_orders_end_after_start"),
    )


class OrderItem(Base):
    __tablename__ = "order_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    order_id: Mapped[str] = mapped_column(String(36), ForeignKey("orders.id"), nullable=False, index=True)
    equipment_spec_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("equipment_specs.id"), nullable=True, index=True
    )
    sale_item_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("sale_items.id"), nullable=True, index=True
    )
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    unit_price: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)

    __table_args__ = (
        # Exactly one of equipment_spec_id / sale_item_id must be set.
        CheckConstraint(
            "(equipment_spec_id IS NOT NULL AND sale_item_id IS NULL) "
            "OR (equipment_spec_id IS NULL AND sale_item_id IS NOT NULL)",
            name="ck_order_items_exactly_one_reference",
        ),
        CheckConstraint("quantity >= 1", name="ck_order_items_quantity_positive"),
        CheckConstraint("unit_price >= 0", name="ck_order_items_price_non_negative"),
    )
