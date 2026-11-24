from sqlalchemy import CheckConstraint, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    order_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("orders.id"), unique=True, nullable=False, index=True
    )
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    updated_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)


class PaymentItem(Base):
    """Immutable "Other" adjustment. V1 has no adjustment subcategories."""

    __tablename__ = "payment_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    payment_id: Mapped[str] = mapped_column(String(36), ForeignKey("payments.id"), nullable=False, index=True)
    # 按订单项目退款时指向对应订单项目；其他调整项为空
    order_item_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("order_items.id"), nullable=True, index=True
    )
    # 按行调整的类型：refund（退款）/ price（调整价格）；历史调整项为空
    kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 针对拆分后的行做的调整时，指向拆分记录；其余为空
    order_item_split_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_amount: Mapped[int] = mapped_column(Integer, nullable=False)
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)

    __table_args__ = (
        CheckConstraint("quantity != 0", name="ck_payment_items_quantity_nonzero"),
        CheckConstraint("unit_amount >= 0", name="ck_payment_items_unit_amount_non_negative"),
        CheckConstraint("amount != 0", name="ck_payment_items_amount_nonzero"),
    )


class OrderItemSplit(Base):
    """订单项目的拆分展示记录：把一行金额拆成多行（均分或自定义）。

    amount 为拆分时的基准金额（分），后续针对拆分行的退款/调价记录在
    payment_items.order_item_split_id 上，不改变原有订单项目。
    """

    __tablename__ = "order_item_splits"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    order_item_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("order_items.id"), nullable=False, index=True
    )
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    # 展示顺序（0 开始）
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_by_user_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
