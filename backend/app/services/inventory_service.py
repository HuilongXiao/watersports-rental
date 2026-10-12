"""Operational inventory: configured total minus real-time occupied quantity.

Only OrderItems of orders with an effective check-in and no effective return
occupy inventory. Future orders do not reserve inventory. SaleItems never
occupy equipment inventory.
"""

import math
from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time_utils import to_shanghai, utc_now
from app.models.equipment import EquipmentSpec
from app.models.inventory import InventoryConfiguration
from app.models.order import Order, OrderItem
from app.models.user import User


def occupied_quantity(db: Session, equipment_spec_id: str) -> int:
    value = db.scalar(
        select(func.coalesce(func.sum(OrderItem.quantity), 0))
        .join(Order, Order.id == OrderItem.order_id)
        .where(
            OrderItem.equipment_spec_id == equipment_spec_id,
            Order.check_in_at.is_not(None),
            Order.return_at.is_(None),
        )
    )
    return int(value or 0)


def inventory_view(db: Session, config: InventoryConfiguration) -> dict:
    occupied = occupied_quantity(db, config.equipment_spec_id)
    total = config.total_quantity
    spec = db.get(EquipmentSpec, config.equipment_spec_id)
    return {
        "equipment_spec_id": config.equipment_spec_id,
        "equipment_spec_name": spec.name if spec else None,
        "total_quantity": total,
        "occupied_quantity": occupied,
        "available_quantity": total - occupied,
        "warning": total - occupied < 0,
    }


def list_inventory(
    db: Session, user: User, active_group_id: str | None = None
) -> list[dict]:
    stmt = (
        select(InventoryConfiguration)
        .join(EquipmentSpec, EquipmentSpec.id == InventoryConfiguration.equipment_spec_id)
        .order_by(EquipmentSpec.name)
    )
    if active_group_id is not None:
        stmt = stmt.where(InventoryConfiguration.group_id == active_group_id)
    configs = list(db.scalars(stmt).all())
    return [inventory_view(db, config) for config in configs]


def ensure_configuration(
    db: Session, equipment_spec_id: str, actor_id: str, group_id: str | None = None
) -> InventoryConfiguration:
    config = db.scalar(
        select(InventoryConfiguration).where(
            InventoryConfiguration.equipment_spec_id == equipment_spec_id
        )
    )
    if config is None:
        config = InventoryConfiguration(
            id=str(uuid4()),
            group_id=group_id,
            equipment_spec_id=equipment_spec_id,
            total_quantity=0,
            updated_by_user_id=actor_id,
        )
        db.add(config)
        db.flush()
    return config


def set_inventory(
    db: Session, user: User, equipment_spec_id: str, total_quantity: int,
    active_group_id: str | None = None,
) -> dict:
    if total_quantity < 0:
        raise HTTPException(status_code=422, detail="库存数量不能为负")
    spec = db.get(EquipmentSpec, equipment_spec_id)
    if not spec:
        raise HTTPException(status_code=404, detail="设备规格不存在")
    # Group ownership check: active group must own the spec.
    if active_group_id is not None and spec.group_id is not None and spec.group_id != active_group_id:
        raise HTTPException(status_code=403, detail="无权操作其他 Group 的库存")
    occupied = occupied_quantity(db, equipment_spec_id)
    if total_quantity < occupied:
        raise HTTPException(
            status_code=409,
            detail=f"运营库存不能低于当前占用数量（当前占用 {occupied}）",
        )
    config = ensure_configuration(db, equipment_spec_id, user.id, group_id=spec.group_id)
    config.total_quantity = total_quantity
    config.updated_by_user_id = user.id
    db.commit()
    db.refresh(config)
    return inventory_view(db, config)


# ---------------------------------------------------------------------------
# 半小时格占用计算（预测页与下单冲突预检共用同一口径）
# ---------------------------------------------------------------------------

SLOT_SECONDS = 1800
# 预订订单的预留时间（buffer）：订单开始前 1 小时 30 分需保证船已在岸边
BUFFER_MINUTES = 90
# 预订订单的预计使用时间（usage）：开始后 2 小时
USAGE_MINUTES = 120


def compute_slot_occupancy(
    orders,
    items_by_order: dict,
    origin,
    slot_count: int,
    spec_ids,
    buffer_cutoff=None,
) -> dict[str, dict[str, list[int]]]:
    """按半小时格计算每种器材规格的占用，拆分为“已使用 / 预订”两桶。

    预订（active）订单拆为两段：
      - 预留时间 buffer [start-90min, start)：保证订单开始时船已在岸边；
      - 使用时间 usage [start, start+2h)：预计下水使用时段。
    进行中/已完成订单只产生“使用时间”（签到时间起 4/5 格，或已完成订单的
    实际使用时长）。

    配对去重规则：当某条船的“使用时间”与另一订单的“预留时间”重叠、且
    使用结束时间 ≤ 该订单开始时间（船能及时归还上岸）时，重叠时段只计
    1 条船——同一条物理船先被使用、归还后直接服务下一单。使用结束晚于
    对方开始时间的不参与配对（这正是预留时间存在的意义）。

    buffer_cutoff（可选，tz-aware）：结束时间 ≤ cutoff 的“过去时段”不再
    统计 buffer（预留）占用，只保留 usage 占用——过去时间已无需预留船只。
    配对去重也只在 buffer 可见的时段生效。
    """
    spec_set = set(spec_ids)
    used: dict[str, list[int]] = {sid: [0] * slot_count for sid in spec_set}
    booked: dict[str, list[int]] = {sid: [0] * slot_count for sid in spec_set}
    # usages: (start_idx, end_idx, end_time, qty, kind)；kind: used=进行中/已完成, book=预订使用段
    usages: dict[str, list[tuple]] = {sid: [] for sid in spec_set}
    # reserves: (start_idx, end_idx, book_start, qty)
    reserves: dict[str, list[tuple]] = {sid: [] for sid in spec_set}

    def _floor_idx(dt) -> int:
        return math.floor((dt - origin).total_seconds() / SLOT_SECONDS)

    def _ceil_idx(dt) -> int:
        return math.ceil((dt - origin).total_seconds() / SLOT_SECONDS)

    buffer_delta = timedelta(minutes=BUFFER_MINUTES)
    usage_delta = timedelta(minutes=USAGE_MINUTES)

    for order in orders:
        items = [
            i for i in items_by_order.get(order.id, [])
            if i.equipment_spec_id in spec_set
        ]
        if not items:
            continue
        if order.status == "active":
            o_start = to_shanghai(order.start_at).replace(second=0, microsecond=0)
            res_span = (
                _floor_idx(o_start - buffer_delta),
                _floor_idx(o_start),
            )
            use_span = (
                _floor_idx(o_start),
                _ceil_idx(o_start + usage_delta),
            )
            use_end = o_start + usage_delta
            for item in items:
                sid = item.equipment_spec_id
                reserves[sid].append((res_span[0], res_span[1], o_start, item.quantity))
                usages[sid].append((use_span[0], use_span[1], use_end, item.quantity, "book"))
        elif order.status == "in_progress":
            if not order.check_in_at:
                continue
            ci = to_shanghai(order.check_in_at).replace(second=0, microsecond=0)
            slot_start = _floor_idx(ci)
            count = 4 if ci.minute % 30 < 15 else 5
            for item in items:
                usages[item.equipment_spec_id].append(
                    (slot_start, slot_start + count, ci + timedelta(hours=2), item.quantity, "used")
                )
        elif order.status == "completed":
            if not order.check_in_at:
                # 未签到直接归还：标注订单开始→结束时间
                s = to_shanghai(order.start_at).replace(second=0, microsecond=0)
                e = to_shanghai(order.end_at).replace(second=0, microsecond=0)
                span = (_floor_idx(s), max(_floor_idx(s) + 1, _ceil_idx(e)))
                end_time = e
            else:
                # 有签到：按实际使用时长（归还-签到，向上取整到半小时）
                ci = to_shanghai(order.check_in_at).replace(second=0, microsecond=0)
                usage_end = to_shanghai(order.return_at or order.end_at)
                count = max(1, math.ceil((usage_end - ci).total_seconds() / SLOT_SECONDS))
                span = (_floor_idx(ci), _floor_idx(ci) + count)
                end_time = usage_end
            for item in items:
                usages[item.equipment_spec_id].append(
                    (span[0], span[1], end_time, item.quantity, "used")
                )

    for sid in spec_set:
        # 展开为单船单元做配对（单条船的使用只能覆盖一单预留）
        u_units = sorted(
            (end_time, s_i, e_i)
            for (s_i, e_i, end_time, qty, _kind) in usages[sid]
            for _ in range(qty)
        )
        r_units = sorted(
            (book_start, s_i, e_i)
            for (s_i, e_i, book_start, qty) in reserves[sid]
            for _ in range(qty)
        )
        # 贪心配对：按订单开始时间升序，每个预留单元配一个 end ≤ start 的使用单元。
        # 关键：仅当使用单元与该预留在槽位上实际重叠时才配对——无重叠的配对
        # 不产生任何去重效果，只会浪费配对名额（例如历史已完成订单的 usage
        # end_time 最早，会把当天所有预留的名额抢先耗尽）。
        pairs: list[tuple] = []
        eligible: list[tuple] = []
        u_ptr = 0
        for r in r_units:
            while u_ptr < len(u_units) and u_units[u_ptr][0] <= r[0]:
                eligible.append(u_units[u_ptr])
                u_ptr += 1
            for idx, u in enumerate(eligible):
                # u=(end_time, s_i, e_i)，r=(book_start, s_i, e_i)；槽位区间相交才算重叠
                if u[1] < r[2] and r[1] < u[2]:
                    pairs.append((eligible.pop(idx), r))
                    break

        for i in range(slot_count):
            # 过去时段（槽结束时间 ≤ cutoff）隐藏 buffer：预留与配对去重
            # 都不参与统计，只保留 usage
            buffer_visible = (
                buffer_cutoff is None
                or origin + timedelta(seconds=SLOT_SECONDS * (i + 1)) > buffer_cutoff
            )
            u_act = sum(qty for (s, e, _t, qty, kind) in usages[sid] if kind == "used" and s <= i < e)
            u_book = sum(qty for (s, e, _t, qty, kind) in usages[sid] if kind == "book" and s <= i < e)
            used[sid][i] = u_act
            if not buffer_visible:
                booked[sid][i] = u_book
                continue
            r_cnt = sum(qty for (s, e, _t, qty) in reserves[sid] if s <= i < e)
            matched = sum(1 for (u, r) in pairs if u[1] <= i < u[2] and r[1] <= i < r[2])
            # 被配对覆盖的预留不再额外计船（同一条船先被使用后服务下一单）
            booked[sid][i] = u_book + r_cnt - matched

    return {sid: {"used": used[sid], "booked": booked[sid]} for sid in spec_set}


# ---------------------------------------------------------------------------
# 下单前库存冲突预检
# ---------------------------------------------------------------------------

def check_order_conflicts(
    db: Session,
    resolved: list[tuple[str | None, str | None, int, object]],
    start_at_utc,
    active_group_id: str | None,
    exclude_order_id: str | None = None,
) -> list[dict]:
    """预检一张待创建/编辑订单在 buffer（开始前 90 分）+ 使用（开始后 2 小时）
    窗口内的库存冲突。

    resolved 为 order_service._resolve_items 的输出。只检查器材规格项目，
    售卖项目不占用船只库存。返回冲突明细（无冲突时为空列表），缺口数量
    = 已有占用 + 本单数量 - 库存总量。
    """
    # 同一规格在一张订单内可能出现多行，合并数量
    requested: dict[str, int] = {}
    for spec_id, _sale_id, quantity, _ref in resolved:
        if spec_id:
            requested[spec_id] = requested.get(spec_id, 0) + quantity
    if not requested:
        return []

    local_start = to_shanghai(start_at_utc).replace(second=0, microsecond=0)
    win_start = local_start - timedelta(minutes=BUFFER_MINUTES)
    win_end = local_start + timedelta(minutes=USAGE_MINUTES)
    # 候选槽起点：win_start 向下取整到半小时
    origin = win_start.replace(minute=(win_start.minute // 30) * 30, second=0, microsecond=0)
    slot_count = math.ceil((win_end - origin).total_seconds() / 1800)
    candidate_slots = [origin + timedelta(minutes=30 * i) for i in range(slot_count)]

    # 查询窗口可能重叠的预订/进行中/已完成订单（±26 小时足够覆盖跨日边界）
    stmt = select(Order).where(Order.status.in_(["active", "in_progress", "completed"]))
    if active_group_id is not None:
        stmt = stmt.where(Order.group_id == active_group_id)
    if exclude_order_id:
        stmt = stmt.where(Order.id != exclude_order_id)
    stmt = stmt.where(Order.start_at >= start_at_utc - timedelta(hours=26))
    stmt = stmt.where(Order.start_at <= start_at_utc + timedelta(hours=26))
    orders = list(db.scalars(stmt).all())

    # 只加载相关规格的订单项目
    spec_ids = set(requested)
    items: list[OrderItem] = []
    if orders:
        items = list(
            db.scalars(
                select(OrderItem)
                .where(OrderItem.order_id.in_([o.id for o in orders]))
                .where(OrderItem.equipment_spec_id.in_(spec_ids))
            ).all()
        )
    items_by_order: dict[str, list[OrderItem]] = {}
    for item in items:
        items_by_order.setdefault(item.order_id, []).append(item)

    # 已有占用（不含本单）：与船只用量预测同口径（过去时段不统计 buffer）
    cutoff = to_shanghai(utc_now())
    existing_occ = compute_slot_occupancy(
        orders, items_by_order, origin, slot_count, spec_ids, buffer_cutoff=cutoff,
    )
    occupied = {
        sid: [u + b for u, b in zip(v["used"], v["booked"])]
        for sid, v in existing_occ.items()
    }

    # 含本单的预计占用：把本单当作一张 active 虚拟订单加入同一口径计算
    from types import SimpleNamespace

    pseudo_order = SimpleNamespace(
        id="__new__", status="active", start_at=start_at_utc,
        end_at=None, check_in_at=None, return_at=None,
    )
    pseudo_items = [
        SimpleNamespace(equipment_spec_id=sid, quantity=qty)
        for sid, qty in requested.items()
    ]
    with_new_items = dict(items_by_order)
    with_new_items["__new__"] = pseudo_items
    with_new_occ = compute_slot_occupancy(
        [*orders, pseudo_order], with_new_items, origin, slot_count, spec_ids,
        buffer_cutoff=cutoff,
    )
    occupied_with_new = {
        sid: [u + b for u, b in zip(v["used"], v["booked"])]
        for sid, v in with_new_occ.items()
    }

    # 库存总量（未配置视为 0）
    config_stmt = select(InventoryConfiguration).where(
        InventoryConfiguration.equipment_spec_id.in_(spec_ids)
    )
    if active_group_id is not None:
        config_stmt = config_stmt.where(InventoryConfiguration.group_id == active_group_id)
    totals = {
        c.equipment_spec_id: c.total_quantity for c in db.scalars(config_stmt).all()
    }
    spec_names = {
        s.id: s.name
        for s in db.scalars(select(EquipmentSpec).where(EquipmentSpec.id.in_(spec_ids))).all()
    }

    conflicts: list[dict] = []
    for spec_id, requested_qty in requested.items():
        total = totals.get(spec_id, 0)
        shortage_slots = []
        for i, existing in enumerate(occupied[spec_id]):
            # 预计占用 = 含本单后的占用（预留/使用重叠已按配对规则去重）
            projected = occupied_with_new[spec_id][i]
            overflow = projected - total
            if overflow > 0:
                shortage_slots.append((i, existing, projected, overflow))
        if not shortage_slots:
            continue

        # 将连续的冲突槽合并为时段，便于前端展示
        ranges = []
        run_start = shortage_slots[0][0]
        run_prev = run_start
        run_existing = shortage_slots[0][1]
        run_projected = shortage_slots[0][2]
        run_overflow = shortage_slots[0][3]
        for i, existing, projected, overflow in shortage_slots[1:]:
            if (
                i == run_prev + 1
                and existing == run_existing
                and projected == run_projected
                and overflow == run_overflow
            ):
                run_prev = i
                continue
            ranges.append(
                _conflict_range(
                    candidate_slots, run_start, run_prev,
                    run_existing, run_projected, run_overflow,
                )
            )
            run_start = run_prev = i
            run_existing, run_projected, run_overflow = existing, projected, overflow
        ranges.append(
            _conflict_range(
                candidate_slots, run_start, run_prev,
                run_existing, run_projected, run_overflow,
            )
        )

        max_existing = max(existing for _i, existing, _p, _o in shortage_slots)
        max_projected = max(projected for _i, _e, projected, _o in shortage_slots)
        conflicts.append(
            {
                "equipment_spec_id": spec_id,
                "equipment_spec_name": spec_names.get(spec_id, "未知船型"),
                "total_quantity": total,
                "requested_quantity": requested_qty,
                "max_existing": max_existing,
                "max_occupied": max_projected,
                "shortage": max(overflow for _i, _e, _p, overflow in shortage_slots),
                "ranges": ranges,
            }
        )

    conflicts.sort(key=lambda c: (-c["shortage"], c["equipment_spec_name"]))
    return conflicts


def _conflict_range(
    slots, first_idx: int, last_idx: int, existing: int, projected: int, overflow: int
) -> dict:
    return {
        "start": slots[first_idx].strftime("%H:%M"),
        "end": (slots[last_idx] + timedelta(minutes=30)).strftime("%H:%M"),
        "existing": existing,
        "occupied": projected,
        "shortage": overflow,
    }
