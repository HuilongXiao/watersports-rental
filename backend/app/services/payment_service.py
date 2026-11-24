"""Payment: dynamic final amount + immutable "Other" adjustments.

final_amount = SUM(OrderItem.quantity * unit_price)
             + SUM(PaymentItem.amount)

Adjustments are allowed in ANY order status (including terminal statuses).
"""

from datetime import datetime, timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.order import Order, OrderItem
from app.models.payment import OrderItemSplit, Payment, PaymentItem
from app.models.user import User
from app.services.order_service import get_order, list_items

# 幂等窗口：同一用户对同一订单提交完全相同的调整项（数量、单价、说明），
# 若在此时间内已有一条，则视为重复提交，不再新建。用于防御前端「成功后 load 失败
# 误导用户重试」或多标签页连点导致的重复调整项。
ADJUSTMENT_IDEMPOTENCY_WINDOW = timedelta(seconds=5)


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

    # 幂等性检查：5 秒内同一用户对同一订单提交完全相同的调整项，视为重复提交，
    # 直接返回当前支付视图（不新建），防御前端连点或 load 失败后的误重试。
    cutoff = datetime.utcnow() - ADJUSTMENT_IDEMPOTENCY_WINDOW
    duplicate = db.scalar(
        select(PaymentItem).where(
            PaymentItem.payment_id == payment.id,
            PaymentItem.quantity == payload.quantity,
            PaymentItem.unit_amount == payload.unit_amount,
            PaymentItem.note == note,
            PaymentItem.created_by_user_id == user.id,
            PaymentItem.created_at >= cutoff,
        )
    )
    if duplicate is not None:
        return payment_view(db, order_id, user, active_group_id)

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


def add_item_refund(
    db: Session, user: User, order_id: str, payload, active_group_id: str | None = None
) -> dict:
    """按订单项目退款：记录为负金额调整项并关联该行，退款金额不得超过该行剩余可退金额。"""
    get_order(db, order_id, user, active_group_id)
    note = payload.note.strip() if payload.note else ""
    if not note:
        raise HTTPException(status_code=422, detail="退款必须填写备注")
    if payload.amount_fen < 1:
        raise HTTPException(status_code=422, detail="退款金额必须大于 0")

    item = db.scalar(
        select(OrderItem).where(OrderItem.id == payload.order_item_id, OrderItem.order_id == order_id)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="订单项目不存在")

    split = _get_split(db, payload.order_item_id, getattr(payload, "order_item_split_id", None))
    if split is not None:
        remaining = split.amount + split_adjusted_total(db, split.id)
    else:
        remaining = item.quantity * item.unit_price + item_adjusted_total(db, order_id, item.id)
    if payload.amount_fen > remaining:
        raise HTTPException(status_code=422, detail="退款金额不能超过该行剩余可退金额")

    payment = get_or_create_payment(db, user, order_id, active_group_id)
    db.add(
        PaymentItem(
            id=str(uuid4()),
            payment_id=payment.id,
            order_item_id=item.id,
            order_item_split_id=split.id if split else None,
            kind="refund",
            quantity=-1,
            unit_amount=payload.amount_fen,
            amount=-payload.amount_fen,
            note=note,
            created_by_user_id=user.id,
        )
    )
    payment.updated_by_user_id = user.id
    db.commit()
    return payment_view(db, order_id, user, active_group_id)


def add_item_price_adjust(
    db: Session, user: User, order_id: str, payload, active_group_id: str | None = None
) -> dict:
    """按订单项目调整价格：把该行当前净额改为新金额，差额记录为调整项。"""
    get_order(db, order_id, user, active_group_id)
    note = payload.note.strip() if payload.note else ""
    if not note:
        raise HTTPException(status_code=422, detail="调整价格必须填写备注")
    if payload.new_amount_fen < 0:
        raise HTTPException(status_code=422, detail="调整后金额不能为负数")

    item = db.scalar(
        select(OrderItem).where(OrderItem.id == payload.order_item_id, OrderItem.order_id == order_id)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="订单项目不存在")

    split = _get_split(db, payload.order_item_id, getattr(payload, "order_item_split_id", None))
    if split is not None:
        current = split.amount + split_adjusted_total(db, split.id)
    else:
        current = item.quantity * item.unit_price + item_adjusted_total(db, order_id, item.id)
    diff = payload.new_amount_fen - current
    if diff == 0:
        raise HTTPException(status_code=422, detail="调整后金额与当前金额相同")

    payment = get_or_create_payment(db, user, order_id, active_group_id)
    db.add(
        PaymentItem(
            id=str(uuid4()),
            payment_id=payment.id,
            order_item_id=item.id,
            order_item_split_id=split.id if split else None,
            kind="price",
            quantity=1 if diff > 0 else -1,
            unit_amount=abs(diff),
            amount=diff,
            note=note,
            created_by_user_id=user.id,
        )
    )
    payment.updated_by_user_id = user.id
    db.commit()
    return payment_view(db, order_id, user, active_group_id)


def split_order_item(
    db: Session, user: User, order_id: str, payload, active_group_id: str | None = None
) -> dict:
    """把一行订单项目拆分为多行展示：金额合计必须等于该行当前净额。"""
    get_order(db, order_id, user, active_group_id)
    item = db.scalar(
        select(OrderItem).where(OrderItem.id == payload.order_item_id, OrderItem.order_id == order_id)
    )
    if item is None:
        raise HTTPException(status_code=404, detail="订单项目不存在")

    existing = db.scalar(
        select(OrderItemSplit.id).where(OrderItemSplit.order_item_id == item.id)
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="该行已拆分，请先编辑订单恢复")

    amounts = [int(a) for a in payload.amounts_fen]
    if len(amounts) < 2:
        raise HTTPException(status_code=422, detail="拆分至少需要 2 行")
    if any(a <= 0 for a in amounts):
        raise HTTPException(status_code=422, detail="每行拆分金额必须大于 0")

    current = item.quantity * item.unit_price + item_adjusted_total(db, order_id, item.id)
    if sum(amounts) != current:
        raise HTTPException(status_code=422, detail="拆分金额合计必须等于该行当前金额")

    for index, amount in enumerate(amounts):
        db.add(
            OrderItemSplit(
                id=str(uuid4()),
                order_item_id=item.id,
                amount=amount,
                position=index,
                created_by_user_id=user.id,
            )
        )
    db.commit()
    return payment_view(db, order_id, user, active_group_id)


def _get_split(db: Session, order_item_id: str, split_id: str | None) -> OrderItemSplit | None:
    if not split_id:
        return None
    split = db.scalar(
        select(OrderItemSplit).where(
            OrderItemSplit.id == split_id,
            OrderItemSplit.order_item_id == order_item_id,
        )
    )
    if split is None:
        raise HTTPException(status_code=404, detail="拆分记录不存在")
    return split


def split_adjusted_total(db: Session, split_id: str) -> int:
    """某拆分行的调整合计（退款/调价，负数为减少）。"""
    return int(
        db.scalar(
            select(func.coalesce(func.sum(PaymentItem.amount), 0)).where(
                PaymentItem.order_item_split_id == split_id
            )
        )
        or 0
    )


def item_adjusted_total(db: Session, order_id: str, order_item_id: str) -> int:
    """某订单项目的调整合计（退款/调价，负数为减少，未调整为 0）。"""
    return int(
        db.scalar(
            select(func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.id == PaymentItem.payment_id)
            .where(Payment.order_id == order_id, PaymentItem.order_item_id == order_item_id)
        )
        or 0
    )


def payment_view(
    db: Session, order_id: str, user: User | None = None, active_group_id: str | None = None
) -> dict:
    get_order(db, order_id, user, active_group_id)
    payment = _get_payment(db, order_id)
    adjustments = (
        list(
            db.execute(
                select(PaymentItem, User.display_name, User.operator_code)
                .join(User, User.id == PaymentItem.created_by_user_id, isouter=True)
                .where(PaymentItem.payment_id == payment.id)
                .order_by(PaymentItem.created_at)
            ).all()
        )
        if payment
        else []
    )
    items = list_items(db, order_id)
    # 拆分记录：按订单项目分组（列表为空表示未拆分）
    splits_by_item: dict[str, list[OrderItemSplit]] = {}
    if items:
        for split in db.scalars(
            select(OrderItemSplit)
            .where(OrderItemSplit.order_item_id.in_([i.id for i in items]))
            .order_by(OrderItemSplit.position)
        ).all():
            splits_by_item.setdefault(split.order_item_id, []).append(split)
    normal_total = order_items_total(db, order_id)
    adjustment_total = adjustments_total(db, order_id)
    # 每个订单项目的调整合计（负数表示减少），用于前端按行展示调整后小计
    adjusted_by_item: dict[str, int] = {}
    if payment:
        for item_id, total in db.execute(
            select(PaymentItem.order_item_id, func.coalesce(func.sum(PaymentItem.amount), 0))
            .where(
                PaymentItem.payment_id == payment.id,
                PaymentItem.order_item_id.is_not(None),
            )
            .group_by(PaymentItem.order_item_id)
        ).all():
            adjusted_by_item[item_id] = int(total)
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
                "adjusted_fen": adjusted_by_item.get(item.id, 0),
                "splits": [
                    {"id": s.id, "amount_fen": s.amount}
                    for s in splits_by_item.get(item.id, [])
                ],
            }
            for item in items
        ],
        "adjustments": [
            {
                "id": item.id,
                "order_item_id": item.order_item_id,
                "order_item_split_id": item.order_item_split_id,
                "kind": item.kind,
                "quantity": item.quantity,
                "unit_amount": item.unit_amount,
                "amount": item.amount,
                "note": item.note,
                "created_at": item.created_at,
                "created_by_user_name": operator_name,
                "created_by_user_code": operator_code,
            }
            for item, operator_name, operator_code in adjustments
        ],
    }
