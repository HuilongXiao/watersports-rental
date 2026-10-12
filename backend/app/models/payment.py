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
