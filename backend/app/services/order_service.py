"""Order application service: the authoritative business workflow layer.

Covers order creation/editing, the 4-state lifecycle, check-in, direct return,
return cancellation and customer/price snapshots. All business validation
lives here, never in the API/frontend.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.time_utils import (
    ORDER_DURATION_HOURS,
    business_date,
    is_same_business_day,
    utc_now,
)
from app.models.customer import Customer
from app.models.equipment import EquipmentSpec, SaleItem
from app.models.inventory import InventoryConfiguration
from app.models.order import Order, OrderItem
from app.models.settings import DEFAULT_AUTO_RETURN_MINUTES, Setting
from app.models.user import User
from app.services.inventory_service import occupied_quantity
from app.services.settings_service import get_settings

ALLOWED_TRANSITIONS = {
    ("active", "in_progress"),
    ("active", "cancelled"),
    ("active", "no_show"),
    ("active", "completed"),
    ("in_progress", "completed"),
    ("cancelled", "active"),
    ("no_show", "active"),
    ("completed", "active"),
}


def _normalize_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _generate_order_number(db: Session) -> str:
    for _ in range(5):
        number = f"O{utc_now().strftime('%Y%m%d%H%M%S')}{uuid4().hex[:4].upper()}"
        if not db.scalar(select(Order.id).where(Order.order_number == number)):
            return number
    raise HTTPException(status_code=500, detail="订单号生成失败，请重试")


def _snapshot(customer: Customer) -> dict:
    return {
        "customer_name": customer.name,
        "customer_gender": customer.gender,
        "customer_wechat_nickname": customer.wechat_nickname,
        "customer_wechat_id": customer.wechat_id,
        "customer_phone": customer.phone,
    }


def validate_people_capacity(
    spec_quantities: list[tuple[EquipmentSpec, int]], adult_count: int, child_count: int
) -> None:
    """Business-rule section 6 capacity/composition checks.

    Paddleboard-style specs have capacity=NULL and impose no extra rule.
    When multiple specs are present, total capacity is the sum of all seat
    counts weighted by each spec's quantity. Each spec allows at most 2 adults
    per unit (so a 1-seat boat allows 1 adult, a 2-seat boat allows 2 adults).
    """
    total = adult_count + child_count
    if total < 1:
        raise HTTPException(status_code=422, detail="至少需要 1 人")
    seated = [(s, q) for s, q in spec_quantities if s.capacity is not None]
    if not seated:
        return
    total_seats = sum(s.capacity * q for s, q in seated)
    max_adults = sum(min(2, s.capacity) * q for s, q in seated)
    if total > total_seats:
        raise HTTPException(status_code=422, detail=f"总人数不能超过设备承载人数 {total_seats} 人")
    if adult_count < 1:
        raise HTTPException(status_code=422, detail="至少需要 1 名成人")
    if adult_count > max_adults:
        raise HTTPException(status_code=422, detail=f"当前器材组合最多 {max_adults} 名成人")


def _resolve_items(db: Session, payload_items: list) -> list[tuple[str | None, str | None, int, object]]:
    if not payload_items:
        raise HTTPException(status_code=422, detail="订单至少包含一个项目")
    resolved = []
    for item in payload_items:
        has_spec = bool(item.equipment_spec_id)
        has_sale = bool(item.sale_item_id)
        if has_spec == has_sale:
            raise HTTPException(status_code=422, detail="每个订单项目必须且只能引用一个目录项目")
        if has_spec:
            spec = db.get(EquipmentSpec, item.equipment_spec_id)
            if not spec or not spec.is_active:
                raise HTTPException(status_code=422, detail="设备规格不可用或已停用")
            resolved.append((spec.id, None, item.quantity, spec))
        else:
            sale = db.get(SaleItem, item.sale_item_id)
            if not sale or not sale.is_active:
                raise HTTPException(status_code=422, detail="售卖项目不可用或已停用")
            resolved.append((None, sale.id, item.quantity, sale))
    return resolved


def _resolve_fast_customer(
    db: Session, user: User, payload, active_group_id: str | None
) -> Customer:
    """Resolve the customer for an order created/edited in fast customer mode.

    The current fast-mode identifier is the customer's WeChat nickname. If an
    existing customer in the same Group already carries that nickname, the
    order is attached to that customer's profile (no duplicate is created).
    Otherwise a new name-only / nickname-only customer is created.

    ``customer_name`` is kept as a fallback for older clients that still send
    the legacy name-based fast-mode payload.
    """
    group_id = active_group_id or user.group_id
    nickname = (payload.customer_wechat_nickname or "").strip() or None
    name = (payload.customer_name or "").strip() or None

    if nickname:
        existing = db.scalar(
            select(Customer)
            .where(Customer.group_id == group_id, Customer.wechat_nickname == nickname)
            .order_by(Customer.updated_at.desc())
        )
        if existing:
            return existing
        system = db.scalar(select(User).where(User.is_system.is_(True)))
        customer = Customer(
            id=str(uuid4()),
            name=None,
            gender=None,
            wechat_nickname=nickname,
            wechat_id=None,
            phone=None,
            is_system=False,
            group_id=group_id,
            created_by_user_id=system.id if system else user.id,
            updated_by_user_id=system.id if system else user.id,
        )
        db.add(customer)
        db.flush()
        return customer

    if name:
        existing = db.scalar(
            select(Customer)
            .where(Customer.group_id == group_id, Customer.name == name)
            .order_by(Customer.updated_at.desc())
        )
        if existing:
            return existing
        system = db.scalar(select(User).where(User.is_system.is_(True)))
        customer = Customer(
            id=str(uuid4()),
            name=name,
            gender=None,
            wechat_nickname=None,
            wechat_id=None,
            phone=None,
            is_system=False,
            group_id=group_id,
            created_by_user_id=system.id if system else user.id,
            updated_by_user_id=system.id if system else user.id,
        )
        db.add(customer)
        db.flush()
        return customer

    raise HTTPException(status_code=422, detail="请提供客户微信昵称")


def create_order(db: Session, user: User, payload, active_group_id: str | None = None) -> Order:
    if not payload.customer_id:
        customer = _resolve_fast_customer(db, user, payload, active_group_id)
    else:
        customer = db.get(Customer, payload.customer_id)
        if not customer:
            raise HTTPException(status_code=404, detail="客户不存在")

    # Group ownership: non-superuser must own the customer.
    if (
        active_group_id is not None
        and customer.group_id is not None
        and customer.group_id != active_group_id
    ):
        raise HTTPException(status_code=403, detail="无权使用其他 Group 的客户")

    start_at = _normalize_utc(payload.start_at)
    end_at = start_at + timedelta(hours=ORDER_DURATION_HOURS)

    if payload.adult_count < 0 or payload.child_count < 0:
        raise HTTPException(status_code=422, detail="人数不能为负")

    resolved = _resolve_items(db, payload.items)
    spec_quantities = [(ref, qty) for _, _, qty, ref in resolved if isinstance(ref, EquipmentSpec)]
    validate_people_capacity(spec_quantities, payload.adult_count, payload.child_count)

    order = Order(
        id=str(uuid4()),
        group_id=active_group_id if active_group_id else customer.group_id,
        order_number=_generate_order_number(db),
        customer_id=customer.id,
        **_snapshot(customer),
        status="active",
        start_at=start_at,
        end_at=end_at,
        adult_count=payload.adult_count,
        child_count=payload.child_count,
        note=(payload.note.strip() if payload.note and payload.note.strip() else None),
        is_walk_in=bool(getattr(payload, "is_walk_in", False)),
        note_popup=bool(getattr(payload, "note_popup", False)),
        created_by_user_id=user.id,
        updated_by_user_id=user.id,
    )
    db.add(order)
    db.flush()
    for spec_id, sale_id, quantity, catalog in resolved:
        db.add(
            OrderItem(
                id=str(uuid4()),
                order_id=order.id,
                equipment_spec_id=spec_id,
                sale_item_id=sale_id,
                quantity=quantity,
                unit_price=catalog.price,
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
            )
        )
    db.commit()
    db.refresh(order)
    return order


def get_order(
    db: Session, order_id: str, user: User | None = None, active_group_id: str | None = None
) -> Order:
    order = db.get(Order, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    if (
        active_group_id is not None
        and order.group_id is not None
        and order.group_id != active_group_id
    ):
        raise HTTPException(status_code=403, detail="无权访问其他 Group 的订单")
    return order


def list_items(db: Session, order_id: str) -> list[OrderItem]:
    return list(
        db.scalars(
            select(OrderItem).where(OrderItem.order_id == order_id).order_by(OrderItem.created_at)
        ).all()
    )


def delete_order(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> None:
    """永久删除订单及其关联数据（仅 superuser 可调用，鉴权在 API 层）。

    级联删除：支付调整项 → 支付记录 → 订单项目 → 订单本身。
    """
    from app.models.payment import Payment, PaymentItem

    order = get_order(db, order_id, user, active_group_id)
    order_id_pk = order.id

    # 模型间只声明了外键列、未声明 relationship，工作单元无法自动排序删除，
    # 因此显式按依赖顺序执行 DELETE：支付调整项 → 支付记录 → 订单项目 → 订单。
    payment_ids = select(Payment.id).where(Payment.order_id == order_id_pk)
    db.execute(delete(PaymentItem).where(PaymentItem.payment_id.in_(payment_ids)))
    db.execute(delete(Payment).where(Payment.order_id == order_id_pk))
    db.execute(delete(OrderItem).where(OrderItem.order_id == order_id_pk))
    db.execute(delete(Order).where(Order.id == order_id_pk))
    db.commit()


def _editable(order: Order) -> None:
    """终态订单不可修改；active 与 in_progress 均可修改（进行中仅允许调整销售项目）。"""
    if order.status in ("completed", "cancelled", "no_show"):
        raise HTTPException(status_code=409, detail="终态订单需先恢复为 active 才能修改")


def update_order(
    db: Session, user: User, order_id: str, payload, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    _editable(order)

    # 订单创建后客户信息不可修改：客户字段仅允许与原值完全一致时通过
    if payload.customer_id and payload.customer_id != order.customer_id:
        raise HTTPException(status_code=409, detail="订单创建后客户信息不可修改")
    if not payload.customer_id:
        nickname = (payload.customer_wechat_nickname or "").strip()
        if nickname != (order.customer_wechat_nickname or ""):
            raise HTTPException(status_code=409, detail="订单创建后客户信息不可修改")
        # 旧客户端仅传姓名的回退路径：双方均无昵称时按姓名比对
        if not nickname and (payload.customer_name or "").strip() != (order.customer_name or ""):
            raise HTTPException(status_code=409, detail="订单创建后客户信息不可修改")
    if bool(getattr(payload, "is_walk_in", False)) != bool(order.is_walk_in):
        raise HTTPException(status_code=409, detail="订单创建后客户信息不可修改")

    # Fast customer mode: re-link or create customer from wechat nickname.
    if not payload.customer_id:
        customer = _resolve_fast_customer(db, user, payload, active_group_id)
        order.customer_id = customer.id
        order.customer_name = customer.name
        order.customer_gender = customer.gender
        order.customer_wechat_nickname = customer.wechat_nickname
        order.customer_wechat_id = customer.wechat_id
        order.customer_phone = customer.phone

    start_at = _normalize_utc(payload.start_at)
    resolved = _resolve_items(db, payload.items)
    spec_quantities = [(ref, qty) for _, _, qty, ref in resolved if isinstance(ref, EquipmentSpec)]
    validate_people_capacity(spec_quantities, payload.adult_count, payload.child_count)

    # 进行中订单：器材项目必须与原订单完全一致（不可增删改），仅可调整销售项目
    if order.check_in_at is not None:
        existing_eq = {
            (i.equipment_spec_id, i.quantity)
            for i in list_items(db, order.id)
            if i.equipment_spec_id
        }
        new_eq = {
            (spec_id, qty)
            for spec_id, _sale_id, qty, ref in resolved
            if isinstance(ref, EquipmentSpec)
        }
        if existing_eq != new_eq:
            raise HTTPException(status_code=409, detail="签到后不能修改器材项目，仅可添加或调整销售项目")

    order.start_at = start_at
    order.end_at = start_at + timedelta(hours=ORDER_DURATION_HOURS)
    order.adult_count = payload.adult_count
    order.child_count = payload.child_count
    order.note = payload.note.strip() if payload.note and payload.note.strip() else None
    order.is_walk_in = bool(getattr(payload, "is_walk_in", False))
    order.note_popup = bool(getattr(payload, "note_popup", False))
    order.updated_by_user_id = user.id

    for old in list_items(db, order.id):
        db.delete(old)
    db.flush()
    for spec_id, sale_id, quantity, catalog in resolved:
        db.add(
            OrderItem(
                id=str(uuid4()),
                order_id=order.id,
                equipment_spec_id=spec_id,
                sale_item_id=sale_id,
                quantity=quantity,
                unit_price=catalog.price,
                created_by_user_id=user.id,
                updated_by_user_id=user.id,
            )
        )
    db.commit()
    db.refresh(order)
    return order


def _transition(order: Order, target: str) -> None:
    if (order.status, target) not in ALLOWED_TRANSITIONS:
        raise HTTPException(
            status_code=409,
            detail=f"不允许的订单状态转换：{order.status} → {target}",
        )
    order.status = target


def cancel_order(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    if order.check_in_at is not None:
        raise HTTPException(status_code=409, detail="已签到订单请先取消签到再取消订单")
    _transition(order, "cancelled")
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def mark_no_show(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    if order.check_in_at is not None:
        raise HTTPException(status_code=409, detail="已签到订单不能标记为爽约")
    _transition(order, "no_show")
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def complete_order(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    """Active → completed without check-in/return (e.g. forgotten records)."""
    order = get_order(db, order_id, user, active_group_id)
    if order.check_in_at is not None:
        raise HTTPException(status_code=409, detail="已签到订单请使用归还操作完成")
    _transition(order, "completed")
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def restore_order(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    _transition(order, "active")
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def _assert_order_business_day(order: Order) -> None:
    if not is_same_business_day(order.start_at):
        today = business_date(utc_now()).isoformat()
        order_day = business_date(order.start_at).isoformat()
        raise HTTPException(
            status_code=409,
            detail=f"只能操作当天订单（订单日期 {order_day}，今天 {today}）",
        )


def check_in(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> tuple[Order, list[dict]]:
    order = get_order(db, order_id, user, active_group_id)
    if order.status != "active":
        raise HTTPException(status_code=409, detail="只有 active 订单可以签到")
    if order.return_at is not None:
        raise HTTPException(status_code=409, detail="订单已存在有效归还，请先取消归还")
    _assert_order_business_day(order)

    now = utc_now()
    if now < order.start_at - timedelta(hours=1):
        raise HTTPException(status_code=409, detail="签到时间不能早于订单开始时间超过1小时")

    # Re-check-in overwrites the current check-in (rule 10.2) and resets markers.
    effective_group_id = order.group_id
    if effective_group_id is None:
        # Legacy/superuser-created order: fall back to the default group's settings.
        from app.models.group import Group
        first_group = db.scalar(select(Group))
        effective_group_id = first_group.id if first_group else None
    if effective_group_id is not None:
        settings: Setting = get_settings(db, effective_group_id)
        auto_return_minutes = settings.auto_return_after_minutes
    else:
        auto_return_minutes = DEFAULT_AUTO_RETURN_MINUTES
    order.check_in_at = now
    order.check_in_by_user_id = user.id
    order.auto_return_after_minutes = auto_return_minutes
    order.auto_return_occurred = False
    order.auto_return_at = None
    order.daily_forced_return_occurred = False
    # 预订 → 进行中（正式状态：已签到未归还）
    order.status = "in_progress"
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)

    # Warnings only: shortage never hard-blocks check-in.
    warnings = []
    for item in list_items(db, order.id):
        if not item.equipment_spec_id:
            continue
        config = db.scalar(
            select(InventoryConfiguration).where(
                InventoryConfiguration.equipment_spec_id == item.equipment_spec_id
            )
        )
        total_config = config.total_quantity if config else 0
        occupied = occupied_quantity(db, item.equipment_spec_id)
        available_after = total_config - occupied
        if available_after < 0:
            warnings.append(
                {
                    "equipment_spec_id": item.equipment_spec_id,
                    "message": f"库存不足：签到后可用 {available_after}（总量 {total_config}，已占用 {occupied}）",
                }
            )
    return order, warnings


def cancel_check_in(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    if order.check_in_at is None:
        raise HTTPException(status_code=409, detail="订单未签到")
    if order.return_at is not None:
        raise HTTPException(status_code=409, detail="存在有效归还，请先取消归还")
    order.check_in_at = None
    order.check_in_by_user_id = None
    order.auto_return_after_minutes = None
    order.auto_return_at = None
    order.auto_return_occurred = False
    # 进行中 → 预订（取消签到回到未签到状态）
    if order.status == "in_progress":
        order.status = "active"
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def return_order(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    if order.status not in ("active", "in_progress"):
        raise HTTPException(status_code=409, detail="只有进行中或预订的订单可以归还")
    _assert_order_business_day(order)

    now = utc_now()
    system_user = None
    if order.return_at is not None:
        # Allowed only as a human correction after an automatic (System User) return.
        system_user = db.scalar(select(User).where(User.is_system.is_(True)))
        if order.return_by_user_id != (system_user.id if system_user else None):
            raise HTTPException(status_code=409, detail="订单已归还")
        if order.auto_return_at is not None and now <= order.auto_return_at:
            raise HTTPException(status_code=409, detail="人工归还修正时间必须晚于自动归还时间")
    else:
        if order.check_in_at is not None:
            if now <= order.check_in_at:
                raise HTTPException(status_code=409, detail="归还时间必须晚于签到时间")
        else:
            # Direct return without check-in.
            if now < order.start_at + timedelta(minutes=1):
                raise HTTPException(status_code=409, detail="直接归还时间至少为开始时间后 1 分钟")

    order.return_at = now
    order.return_by_user_id = user.id
    order.status = "completed"
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def cancel_return(
    db: Session, user: User, order_id: str, active_group_id: str | None = None
) -> Order:
    order = get_order(db, order_id, user, active_group_id)
    if order.return_at is None:
        raise HTTPException(status_code=409, detail="订单没有可取消的归还")
    order.return_at = None
    order.return_by_user_id = None
    order.daily_forced_return_occurred = False
    # Historical auto return snapshot fields are intentionally preserved.
    if order.status == "completed":
        # Cancelled return: back to 进行中 if checked in, otherwise back to 预订.
        order.status = "in_progress" if order.check_in_at is not None else "active"
    order.updated_by_user_id = user.id
    db.commit()
    db.refresh(order)
    return order


def _get_system_user(db: Session) -> User | None:
    return db.scalar(select(User).where(User.is_system.is_(True)))


def auto_return_overdue_orders(db: Session) -> list[Order]:
    """Scan for checked-in in_progress orders past their auto-return deadline.

    Always evaluates against the *current* (last-effective) check_in_at,
    regardless of whether a previous auto-return was later cancelled.
    Performed by the System User as a background safety mechanism. Returns the
    list of orders that were auto-returned in this scan.
    """
    system_user = _get_system_user(db)
    if system_user is None:
        return []
    now = utc_now()
    stmt = (
        select(Order)
        .where(Order.status == "in_progress")
        .where(Order.check_in_at.is_not(None))
        .where(Order.return_at.is_(None))
        .where(Order.auto_return_after_minutes.is_not(None))
    )
    returned: list[Order] = []
    for order in db.scalars(stmt).all():
        deadline = order.check_in_at + timedelta(minutes=order.auto_return_after_minutes)
        if now < deadline:
            continue
        order.return_at = now
        order.return_by_user_id = system_user.id
        order.auto_return_at = now
        order.auto_return_occurred = True
        order.status = "completed"
        order.updated_by_user_id = system_user.id
        returned.append(order)
    if returned:
        db.commit()
        for order in returned:
            db.refresh(order)
    return returned


def daily_forced_return(db: Session) -> list[Order]:
    """End-of-day safety net: force-return every active checked-in order.

    Performed by the System User at 23:59 Asia/Shanghai. Returns the list of
    orders that were force-returned in this run.
    """
    system_user = _get_system_user(db)
    if system_user is None:
        return []
    now = utc_now()
    stmt = (
        select(Order)
        .where(Order.status == "in_progress")
        .where(Order.check_in_at.is_not(None))
        .where(Order.return_at.is_(None))
    )
    returned: list[Order] = []
    for order in db.scalars(stmt).all():
        order.return_at = now
        order.return_by_user_id = system_user.id
        order.daily_forced_return_occurred = True
        order.status = "completed"
        order.updated_by_user_id = system_user.id
        returned.append(order)
    if returned:
        db.commit()
        for order in returned:
            db.refresh(order)
    return returned
