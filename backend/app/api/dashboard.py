"""Basic dashboard figures for daily operations."""

import math
from datetime import date as date_type, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
from app.core.time_utils import BUSINESS_TZ, business_date, to_shanghai, utc_now
from app.db.session import get_db
from app.models.equipment import EquipmentSpec, EquipmentType
from app.models.inventory import InventoryConfiguration
from app.models.order import Order, OrderItem
from app.models.payment import Payment, PaymentItem
from app.models.user import User
from app.services import inventory_service
from app.services.inventory_service import occupied_quantity

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("")
def dashboard(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    today = business_date(utc_now())
    order_stmt = select(Order)
    config_stmt = select(InventoryConfiguration)
    if active_group_id is not None:
        order_stmt = order_stmt.where(Order.group_id == active_group_id)
        config_stmt = config_stmt.where(InventoryConfiguration.group_id == active_group_id)
    orders = list(db.scalars(order_stmt).all())
    today_orders = [o for o in orders if business_date(o.start_at) == today]

    counts = {"active": 0, "in_progress": 0, "cancelled": 0, "no_show": 0, "completed": 0}
    # 每种状态对应的订单金额（项目金额 + 支付调整，含退款负金额）
    status_amounts_fen: dict[str, int] = {k: 0 for k in counts}
    today_amount_fen = 0
    checked_in_now = 0
    for order in orders:
        if order.status == "in_progress":
            checked_in_now += 1
    # 今日已完成订单金额 = 已完成订单的项目金额 + 支付调整（含退款负金额）
    for order in today_orders:
        counts[order.status] = counts.get(order.status, 0) + 1
        items_total = db.scalar(
            select(func.coalesce(func.sum(OrderItem.quantity * OrderItem.unit_price), 0)).where(
                OrderItem.order_id == order.id
            )
        ) or 0
        adj_total = db.scalar(
            select(func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.id == PaymentItem.payment_id)
            .where(Payment.order_id == order.id)
        ) or 0
        order_total = int(items_total) + int(adj_total)
        status_amounts_fen[order.status] = status_amounts_fen.get(order.status, 0) + order_total
        if order.status == "completed":
            today_amount_fen += order_total

    configs = db.scalars(config_stmt).all()
    low_inventory = []
    for config in configs:
        occupied = occupied_quantity(db, config.equipment_spec_id)
        available = config.total_quantity - occupied
        if available <= 0:
            low_inventory.append(
                {
                    "equipment_spec_id": config.equipment_spec_id,
                    "available_quantity": available,
                    "total_quantity": config.total_quantity,
                    "occupied_quantity": occupied,
                }
            )

    return {
        "today": today.isoformat(),
        "today_orders": len(today_orders),
        "status_counts": counts,
        "status_amounts_fen": status_amounts_fen,
        "checked_in_now": checked_in_now,
        "today_completed_amount_fen": today_amount_fen,
        "low_inventory": low_inventory,
    }


@router.get("/order-distribution")
def order_distribution(
    date: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    """Half-hour slot order counts for a business day, broken down by equipment type.

    Returns 48 slots (00:00–23:30). Each slot has a total count and a segments
    list with per-equipment-type counts for non-cancelled orders overlapping the slot.
    Each segment carries a category:
      - "reserved": 预订 (active) — boat not yet in use, rendered in a lighter shade
      - "used": 进行中 (in_progress) / 已完成 (completed) — rendered in the full color
    """
    target = business_date(utc_now())
    if date:
        y, m, d = map(int, date.split("-"))
        target = date_type(y, m, d)

    # Build equipment_spec_id -> type_name lookup
    type_stmt = select(EquipmentType)
    spec_stmt = select(EquipmentSpec)
    order_stmt = select(Order).where(
        Order.status.in_(["active", "in_progress", "completed"])
    )
    if active_group_id is not None:
        type_stmt = type_stmt.where(EquipmentType.group_id == active_group_id)
        spec_stmt = spec_stmt.where(EquipmentSpec.group_id == active_group_id)
        order_stmt = order_stmt.where(Order.group_id == active_group_id)
    types = {t.id: t.name for t in db.scalars(type_stmt).all()}
    specs = list(db.scalars(spec_stmt).all())
    spec_type_name = {s.id: types.get(s.equipment_type_id, "其他") for s in specs}

    # Get non-cancelled orders for that business day
    orders = list(db.scalars(order_stmt).all())
    day_orders = [o for o in orders if business_date(o.start_at) == target]

    # Preload order items for these orders
    order_ids = [o.id for o in day_orders]
    all_items = (
        list(db.scalars(select(OrderItem).where(OrderItem.order_id.in_(order_ids))).all())
        if order_ids
        else []
    )
    items_by_order: dict[str, list] = {}
    for item in all_items:
        items_by_order.setdefault(item.order_id, []).append(item)

    slots = []
    for hour in range(24):
        for minute in (0, 30):
            slot_start = datetime(
                target.year, target.month, target.day, hour, minute, tzinfo=BUSINESS_TZ
            )
            slot_end = slot_start + timedelta(minutes=30)
            type_counts: dict[str, dict[str, int]] = {}
            for order in day_orders:
                o_start = to_shanghai(order.start_at)
                o_end = to_shanghai(order.end_at)
                if o_start < slot_end and o_end > slot_start:
                    # 预订 = 尚未投入使用（浅色）；进行中/已完成 = 已使用（原色）
                    category = "reserved" if order.status == "active" else "used"
                    for item in items_by_order.get(order.id, []):
                        if item.equipment_spec_id:
                            tname = spec_type_name.get(item.equipment_spec_id, "其他")
                            bucket = type_counts.setdefault(tname, {})
                            bucket[category] = bucket.get(category, 0) + item.quantity
            total = sum(sum(b.values()) for b in type_counts.values())
            segments = [
                {"type": t, "count": c, "category": category}
                for t, bucket in type_counts.items()
                for category, c in bucket.items()
            ]
            slots.append(
                {"slot": f"{hour:02d}:{minute:02d}", "total": total, "segments": segments}
            )

    return {"date": target.isoformat(), "slots": slots}


@router.get("/inventory-forecast")
def inventory_forecast(
    date: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    """半小时槽位（08:00 起，30 分钟一格）的占用/可用预测。

    显示区间的最晚边界按当日订单中最晚结束时间向后取整到 00/30 分计算
    （如最晚 20:03 结束 → 末格 20:00、结束边界 20:30）；当日无订单时
    保持默认 08:00–20:00 共 25 格。

    Blocking rules:
      - active (预订): 拆为预留时间 buffer [start-90min, start) 与使用时间
        usage [start, start+2h)；当某条船的使用时间与另一订单的预留时间
        重叠、且使用结束 ≤ 该订单开始（船能及时归还）时，重叠时段只计 1 条船。
        已过去的时间条（槽结束时间 ≤ 当前时间）不再统计 buffer，只显示 usage。
      - in_progress (进行中): blocked from the checked-in time forward for
        2 hours, snapped to the half-hour grid. When check-in falls in the
        first 15 minutes of a slot, 4 slots are blocked (floor); when it
        falls in the latter 15 minutes, 5 slots are blocked.
      - completed (已完成): 未签到按订单开始→结束；有签到按实际使用时长向上取整。
    """
    GRID_START_HOUR = 8

    target = business_date(utc_now())
    if date:
        y, m, d = map(int, date.split("-"))
        target = date_type(y, m, d)

    type_stmt = select(EquipmentType)
    # 预测页只展示启用中的器材规格（停用的船型不显示）
    spec_stmt = select(EquipmentSpec).where(EquipmentSpec.is_active.is_(True))
    config_stmt = select(InventoryConfiguration)
    # 已完成订单与进行中订单一样按签到时间计入“已使用”桶（原色展示）
    order_stmt = select(Order).where(Order.status.in_(["active", "in_progress", "completed"]))
    if active_group_id is not None:
        type_stmt = type_stmt.where(EquipmentType.group_id == active_group_id)
        spec_stmt = spec_stmt.where(EquipmentSpec.group_id == active_group_id)
        config_stmt = config_stmt.where(InventoryConfiguration.group_id == active_group_id)
        order_stmt = order_stmt.where(Order.group_id == active_group_id)

    types = {t.id: t for t in db.scalars(type_stmt).all()}
    specs = list(db.scalars(spec_stmt).all())
    totals = {c.equipment_spec_id: c.total_quantity for c in db.scalars(config_stmt).all()}

    orders = [o for o in db.scalars(order_stmt).all() if business_date(o.start_at) == target]
    order_ids = [o.id for o in orders]
    all_items = (
        list(db.scalars(select(OrderItem).where(OrderItem.order_id.in_(order_ids))).all())
        if order_ids
        else []
    )
    items_by_order: dict[str, list] = {}
    for item in all_items:
        items_by_order.setdefault(item.order_id, []).append(item)

    # 展示区间：
    #   最早槽位 = 当日订单（含已完成）最早开始时间向下取整到 00/30 分；
    #   最晚槽位 = 当日订单（含已完成）最晚结束时间向前取整到 00/30 分；
    # 无订单时默认 08:00–20:00 共 25 格。上限 48 格（到当日 24:00）。
    range_stmt = select(Order).where(
        Order.status.in_(["active", "in_progress", "completed"])
    )
    if active_group_id is not None:
        range_stmt = range_stmt.where(Order.group_id == active_group_id)
    range_orders = [
        o for o in db.scalars(range_stmt).all()
        if business_date(o.start_at) == target
    ]
    if not range_orders:
        grid_origin = datetime(
            target.year, target.month, target.day,
            GRID_START_HOUR, 0, tzinfo=BUSINESS_TZ,
        )
        slot_count = 25
    else:
        earliest_start = min(o.start_at for o in range_orders)
        latest_end = max(o.end_at for o in range_orders)
        start_sh = to_shanghai(earliest_start).replace(second=0, microsecond=0)
        end_sh = to_shanghai(latest_end).replace(second=0, microsecond=0)
        minute_floor = (start_sh.minute // 30) * 30
        grid_origin = start_sh.replace(minute=minute_floor)
        last_index = math.floor((end_sh - grid_origin).total_seconds() / 1800)
        slot_count = max(1, min(48, last_index + 1))

    # spec_id -> [slot_count occupied counts]，拆分为预订 / 已使用两桶。
    # 预留时间与使用时间重叠且船能及时归还的时段按配对规则去重（只计 1 条），
    # 口径与下单冲突预检 inventory_service.check_order_conflicts 完全一致。
    occupancy = inventory_service.compute_slot_occupancy(
        orders,
        items_by_order,
        grid_origin,
        slot_count,
        [s.id for s in specs],
        buffer_cutoff=to_shanghai(utc_now()),
    )
    occupied_active = {sid: v["booked"] for sid, v in occupancy.items()}
    occupied_used = {sid: v["used"] for sid, v in occupancy.items()}

    slots = [
        (grid_origin + timedelta(minutes=30 * i)).strftime("%H:%M")
        for i in range(slot_count)
    ]

    equipment = []
    # 展示顺序遵照“器材目录”里的自定义排序（sort_order），其次创建时间、名称
    for spec in sorted(
        specs,
        key=lambda s: (s.sort_order, s.created_at, s.name),
    ):
        t = types.get(spec.equipment_type_id)
        occupied_a = occupied_active[spec.id]
        occupied_u = occupied_used[spec.id]
        occupied = [a + b for a, b in zip(occupied_a, occupied_u)]
        total = totals.get(spec.id, 0)
        equipment.append(
            {
                "spec_id": spec.id,
                "name": spec.name,
                "type_name": t.name if t else "其他",
                "type_color": t.color if t else "blue",
                "total_quantity": total,
                "occupied": occupied,
                "occupied_active": occupied_a,
                "occupied_used": occupied_u,
                "available": [total - c for c in occupied],
            }
        )

    return {"date": target.isoformat(), "slots": slots, "equipment": equipment}


@router.get("/daily-summary")
def daily_summary(
    date: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    """Daily summary: order count, completed/estimated amount, item usage, others.

    已完成订单（过去/今日）统计：船型使用数量与金额、销售项目数量与金额、
    以及支付调整项（其他）的备注与金额。
    未来日期只统计预订（active）订单的项目数据（无调整项）。
    """
    from app.models.equipment import SaleItem

    target = business_date(utc_now())
    if date:
        y, m, d = map(int, date.split("-"))
        target = date_type(y, m, d)

    today = business_date(utc_now())
    is_future = target > today

    order_stmt = select(Order)
    if active_group_id is not None:
        order_stmt = order_stmt.where(Order.group_id == active_group_id)
    all_orders = list(db.scalars(order_stmt).all())
    day_orders = [o for o in all_orders if business_date(o.start_at) == target]
    order_count = len(day_orders)

    # 未来日期：统计预订（active）订单的项目数据；过去/今日：统计已完成订单
    summary_status = "active" if is_future else "completed"
    summary_orders = [o for o in day_orders if o.status == summary_status]

    order_ids = [o.id for o in summary_orders]
    items = (
        list(db.scalars(select(OrderItem).where(OrderItem.order_id.in_(order_ids))).all())
        if order_ids
        else []
    )

    spec_ids = {i.equipment_spec_id for i in items if i.equipment_spec_id}
    sale_ids = {i.sale_item_id for i in items if i.sale_item_id}
    specs = (
        {s.id: s.name for s in db.scalars(select(EquipmentSpec).where(EquipmentSpec.id.in_(spec_ids))).all()}
        if spec_ids
        else {}
    )
    sales = (
        {s.id: s.name for s in db.scalars(select(SaleItem).where(SaleItem.id.in_(sale_ids))).all()}
        if sale_ids
        else {}
    )

    item_map: dict[str, dict] = {}
    sale_map: dict[str, dict] = {}
    for item in items:
        if item.equipment_spec_id:
            name = specs.get(item.equipment_spec_id, "未知")
            bucket = item_map
        elif item.sale_item_id:
            name = sales.get(item.sale_item_id, "未知")
            bucket = sale_map
        else:
            continue
        if name not in bucket:
            bucket[name] = {"quantity": 0, "amount_fen": 0}
        bucket[name]["quantity"] += item.quantity
        bucket[name]["amount_fen"] += item.quantity * item.unit_price

    equipment_usage = [
        {"name": k, "quantity": v["quantity"], "amount_fen": v["amount_fen"]}
        for k, v in item_map.items()
    ]
    equipment_usage.sort(key=lambda x: x["quantity"], reverse=True)
    sale_item_usage = [
        {"name": k, "quantity": v["quantity"], "amount_fen": v["amount_fen"]}
        for k, v in sale_map.items()
    ]
    sale_item_usage.sort(key=lambda x: x["quantity"], reverse=True)

    # 金额合计 & 其他调整项（仅已完成订单有调整项）
    completed_amount_fen = 0
    others: list[dict] = []
    if not is_future:
        for order in summary_orders:
            items_total = db.scalar(
                select(func.coalesce(func.sum(OrderItem.quantity * OrderItem.unit_price), 0)).where(
                    OrderItem.order_id == order.id
                )
            ) or 0
            adj_items = list(
                db.scalars(
                    select(PaymentItem)
                    .join(Payment, Payment.id == PaymentItem.payment_id)
                    .where(Payment.order_id == order.id)
                ).all()
            )
            adj_total = sum(int(p.amount) for p in adj_items)
            completed_amount_fen += int(items_total) + adj_total
            for p in adj_items:
                others.append(
                    {
                        "note": p.note,
                        "quantity": p.quantity,
                        "amount_fen": int(p.amount),
                    }
                )

    return {
        "date": target.isoformat(),
        "is_future": is_future,
        "order_count": order_count,
        "summary_status": summary_status,
        "completed_amount_fen": completed_amount_fen if not is_future else 0,
        "estimated_amount_fen": (
            sum(e["amount_fen"] for e in equipment_usage)
            + sum(s["amount_fen"] for s in sale_item_usage)
        ) if is_future else 0,
        "equipment_usage": equipment_usage,
        "sale_item_usage": sale_item_usage,
        "others": others,
    }
