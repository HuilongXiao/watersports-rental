"""Payment: dynamic final amount + immutable "Other" adjustments.

final_amount = SUM(OrderItem.quantity * unit_price)
             + SUM(PaymentItem.amount)

Adjustments are allowed in ANY order status (including terminal statuses).
"""

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.order import Order, OrderItem
from app.models.payment import Payment, PaymentItem
from app.models.user import User
from app.services.order_service import get_order, list_items


def order_items_total(db: Session, order_id: str) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(OrderItem.quantity * OrderItem.unit_price), 0)).where(
                OrderItem.order_id == order_id
            )
        )
        or 0
    )


def adjustments_total(db: Session, order_id: str) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.id == PaymentItem.payment_id)
            .where(Payment.order_id == order_id)
        )
        or 0
    )


def _get_payment(db: Session, order_id: str) -> Payment | None:
    return db.scalar(select(Payment).where(Payment.order_id == order_id))


def get_or_create_payment(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Payment:
    get_order(db, order_id, user, active_group_id)  # 404 if missing / 403 if cross-group
    payment = _get_payment(db, order_id)
    if payment is None:
        payment = Payment(
            id=str(uuid4()),
            order_id=order_id,
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
        )
        db.add(payment)
        db.flush()
    return payment


def add_adjustment(
    db: Session, user: User, order_id: str, payload, active_group_id: str | None = None
) -> dict:
    get_order(db, order_id, user, active_group_id)
    note = payload.note.strip() if payload.note else ""
    if not note:
        raise HTTPException(status_code=422, detail="每条其他调整必须填写说明")
    if payload.quantity == 0:
        raise HTTPException(status_code=422, detail="数量不能为 0")
    if payload.unit_amount < 1:
        # 调整项金额必须为正数（退款通过数量 -1 表达）
        raise HTTPException(status_code=422, detail="金额必须是大于 0 的正整数")

    payment = get_or_create_payment(db, user, order_id, active_group_id)
    item = PaymentItem(
        id=str(uuid4()),
        payment_id=payment.id,
        quantity=payload.quantity,
        unit_amount=payload.unit_amount,
        amount=payload.quantity * payload.unit_amount,
        note=note,
        created_by_user_id=user.id,
    )
    db.add(item)
    payment.updated_by_user_id = user.id
    db.commit()
    return payment_view(db, order_id, user, active_group_id)


def payment_view(
    db: Session, order_id: str, user: User | None = None, active_group_id: str | None = None
) -> dict:
    get_order(db, order_id, user, active_group_id)
    payment = _get_payment(db, order_id)
    adjustments = (
        list(
            db.scalars(
                select(PaymentItem)
                .where(PaymentItem.payment_id == payment.id)
                .order_by(PaymentItem.created_at)
            ).all()
        )
        if payment
        else []
    )
    items = list_items(db, order_id)
    normal_total = order_items_total(db, order_id)
    adjustment_total = adjustments_total(db, order_id)
    return {
        "order_id": order_id,
        "payment_id": payment.id if payment else None,
        "items_total_fen": normal_total,
        "adjustments_total_fen": adjustment_total,
        "amount_fen": normal_total + adjustment_total,
        "order_items": [
            {
                "id": item.id,
                "equipment_spec_id": item.equipment_spec_id,
                "sale_item_id": item.sale_item_id,
                "quantity": item.quantity,
                "unit_price": item.unit_price,
                "line_amount": item.quantity * item.unit_price,
            }
            for item in items
        ],
        "adjustments": [
            {
                "id": item.id,
                "quantity": item.quantity,
                "unit_amount": item.unit_amount,
                "amount": item.amount,
                "note": item.note,
                "created_at": item.created_at,
            }
            for item in adjustments
        ],
    }
