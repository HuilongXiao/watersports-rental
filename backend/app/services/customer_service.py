"""Customer management with simple candidate search (operator confirms)."""

from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.user import User


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def search_customers(
    db: Session, q: str | None, user: User, active_group_id: str | None = None
) -> list[Customer]:
    statement = select(Customer).order_by(Customer.updated_at.desc())
    if active_group_id is not None:
        statement = statement.where(Customer.group_id == active_group_id)
    term = _clean(q)
    if term:
        like = f"%{term}%"
        statement = statement.where(
            or_(
                Customer.name.ilike(like),
                Customer.wechat_nickname.ilike(like),
                Customer.wechat_id.ilike(like),
                Customer.phone.ilike(like),
            )
        )
    return list(db.scalars(statement).all())


def customer_order_stats(db: Session, customer_ids: list[str]) -> dict[str, tuple[int, int]]:
    """批量返回每个客户的 (订单总数, 已完成订单消费额-分)。

    消费额口径与客户详情 stats 接口一致：已完成订单的订单项目金额合计 +
    支付调整项金额合计。订单总数统计所有状态的订单。
    """
    if not customer_ids:
        return {}

    from app.models.order import Order, OrderItem
    from app.models.payment import Payment, PaymentItem

    counts = dict(
        db.execute(
            select(Order.customer_id, func.count())
            .where(Order.customer_id.in_(customer_ids))
            .group_by(Order.customer_id)
        ).all()
    )
    item_totals = dict(
        db.execute(
            select(
                Order.customer_id,
                func.coalesce(func.sum(OrderItem.quantity * OrderItem.unit_price), 0),
            )
            .join(OrderItem, OrderItem.order_id == Order.id)
            .where(Order.status == "completed", Order.customer_id.in_(customer_ids))
            .group_by(Order.customer_id)
        ).all()
    )
    adjustment_totals = dict(
        db.execute(
            select(Order.customer_id, func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.order_id == Order.id)
            .join(PaymentItem, PaymentItem.payment_id == Payment.id)
            .where(Order.status == "completed", Order.customer_id.in_(customer_ids))
            .group_by(Order.customer_id)
        ).all()
    )
    return {
        cid: (
            int(counts.get(cid, 0)),
            int(item_totals.get(cid, 0)) + int(adjustment_totals.get(cid, 0)),
        )
        for cid in customer_ids
    }


def get_customer(
    db: Session, customer_id: str, user: User | None = None, active_group_id: str | None = None
) -> Customer:
    customer = db.get(Customer, customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="客户不存在")
    if (
        active_group_id is not None
        and customer.group_id is not None
        and customer.group_id != active_group_id
    ):
        raise HTTPException(status_code=403, detail="无权访问其他 Group 的客户")
    return customer


def _ensure_unique(
    db: Session,
    phone: str | None,
    wechat_id: str | None,
    wechat_nickname: str | None = None,
    exclude_id: str | None = None,
    group_id: str | None = None,
) -> None:
    """业务组内唯一性检查：手机号、微信ID、微信昵称三者都必须唯一。

    wechat_nickname 也纳入检查是因为客户管理页面没有走订单创建时的
    _resolve_or_create_customer 查重路径，此前这里只检查 phone/wechat_id
    会导致同昵称客户被重复创建。
    """
    predicates = []
    if phone:
        predicates.append(Customer.phone == phone)
    if wechat_id:
        predicates.append(Customer.wechat_id == wechat_id)
    if wechat_nickname:
        predicates.append(Customer.wechat_nickname == wechat_nickname)
    if not predicates:
        return
    statement = select(Customer).where(or_(*predicates))
    if group_id is not None:
        statement = statement.where(Customer.group_id == group_id)
    if exclude_id:
        statement = statement.where(Customer.id != exclude_id)
    if db.scalar(statement):
        raise HTTPException(status_code=409, detail="手机号、微信ID或微信昵称已存在")


def create_customer(
    db: Session, user: User, payload: dict, active_group_id: str | None = None
) -> Customer:
    name = _clean(payload.get("name"))
    phone = _clean(payload.get("phone"))
    wechat_nickname = _clean(payload.get("wechat_nickname"))
    wechat_id = _clean(payload.get("wechat_id"))
    gender = _clean(payload.get("gender"))
    note = _clean(payload.get("note"))
    remind = bool(payload.get("remind", False))
    if not note:
        remind = False

    if not (name or wechat_nickname):
        raise HTTPException(
            status_code=422,
            detail="至少提供姓名或微信昵称",
        )
    group_id = active_group_id if active_group_id is not None else user.group_id
    _ensure_unique(db, phone, wechat_id, wechat_nickname, group_id=group_id)

    customer = Customer(
        id=str(uuid4()),
        group_id=group_id,
        name=name,
        gender=gender,
        wechat_nickname=wechat_nickname,
        wechat_id=wechat_id,
        phone=phone,
        is_system=False,
        note=note,
        remind=remind,
        created_by_user_id=user.id,
        updated_by_user_id=user.id,
    )
    db.add(customer)
    db.commit()
    db.refresh(customer)
    return customer


def delete_customer(
    db: Session, user: User, customer_id: str, active_group_id: str | None = None
) -> None:
    """永久删除客户 profile（仅 superuser 可调用，鉴权在 API 层）。

    系统客户（游客）不可删除；仍有关联订单的客户需先删除订单，
    避免破坏订单历史的外键完整性。
    """
    from app.models.order import Order

    customer = get_customer(db, customer_id, user, active_group_id)
    if customer.is_system:
        raise HTTPException(status_code=409, detail="系统客户（游客）不可删除")

    order_count = db.scalar(
        select(func.count()).select_from(Order).where(Order.customer_id == customer.id)
    )
    if order_count:
        raise HTTPException(
            status_code=409,
            detail=f"该客户存在 {order_count} 笔订单，请先删除相关订单后再删除客户",
        )

    db.delete(customer)
    db.commit()


def update_customer(
    db: Session, user: User, customer_id: str, payload: dict, active_group_id: str | None = None
) -> Customer:
    customer = get_customer(db, customer_id, user, active_group_id)
    if customer.is_system:
        raise HTTPException(status_code=409, detail="系统客户（游客）不可修改")

    name = _clean(payload.get("name"))
    phone = _clean(payload.get("phone"))
    wechat_nickname = _clean(payload.get("wechat_nickname"))
    wechat_id = _clean(payload.get("wechat_id"))
    gender = _clean(payload.get("gender"))
    note = _clean(payload.get("note"))
    remind = bool(payload.get("remind", False))
    if not note:
        remind = False

    if not (name or wechat_nickname):
        raise HTTPException(
            status_code=422,
            detail="至少保留姓名或微信昵称",
        )
    _ensure_unique(db, phone, wechat_id, wechat_nickname,
                   exclude_id=customer_id, group_id=customer.group_id)

    customer.name = name
    customer.phone = phone
    customer.wechat_nickname = wechat_nickname
    customer.wechat_id = wechat_id
    customer.gender = gender
    customer.note = note
    customer.remind = remind
    customer.updated_by_user_id = user.id
    db.commit()
    db.refresh(customer)
    return customer
