"""Boat numbering & dispatch service.

- 器材编号：each equipment spec owns N numbered boats (N = inventory total).
- 出发：assign a boat number to one line of an in-progress order.
- 返还：release that boat; when every boat of an order has been assigned and
  returned, the order is completed automatically.
"""

from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time_utils import to_iso_z, utc_now
from app.models.boat import BoatDispatch, BoatNumber
from app.models.equipment import EquipmentSpec, EquipmentType
from app.models.inventory import InventoryConfiguration
from app.models.order import Order, OrderItem
from app.models.user import User


def _group_scope(user: User, active_group_id: str | None = None) -> str | None:
    if user.role == "superuser":
        return active_group_id
    return user.group_id


def _assert_group(user: User, group_id: str | None, active_group_id: str | None) -> None:
    if user.role == "superuser":
        if active_group_id is not None and group_id != active_group_id:
            raise HTTPException(status_code=403, detail="无权操作其他 Group 的数据")
        return
    if group_id != user.group_id:
        raise HTTPException(status_code=403, detail="无权操作其他 Group 的数据")


def _target_quantity(db: Session, spec_id: str) -> int:
    config = db.scalar(
        select(InventoryConfiguration).where(
            InventoryConfiguration.equipment_spec_id == spec_id
        )
    )
    return int(config.total_quantity) if config else 0


def _natural_key(value: str):
    """Numbers sort numerically when possible, text falls back to lexicographic."""
    return (0, int(value), "") if value.isdigit() else (1, 0, value)


def _numbers_of(db: Session, spec_id: str) -> list[BoatNumber]:
    rows = list(
        db.scalars(
            select(BoatNumber).where(BoatNumber.equipment_spec_id == spec_id)
        ).all()
    )
    return sorted(rows, key=lambda r: _natural_key(r.number))


def _active_dispatches_of_spec(db: Session, spec_id: str) -> list[BoatDispatch]:
    return list(
        db.scalars(
            select(BoatDispatch).where(
                BoatDispatch.equipment_spec_id == spec_id,
                BoatDispatch.departed.is_(True),
                BoatDispatch.returned.is_(False),
            )
        ).all()
    )


def list_numbering(db: Session, user: User, active_group_id: str | None = None) -> dict:
    """Overview for the 「器材编号」tab: every spec + numbered/target counts."""
    scope = _group_scope(user, active_group_id)
    spec_stmt = select(EquipmentSpec).order_by(
        EquipmentSpec.sort_order, EquipmentSpec.created_at, EquipmentSpec.name
    )
    type_stmt = select(EquipmentType)
    if scope is not None:
        spec_stmt = spec_stmt.where(EquipmentSpec.group_id == scope)
        type_stmt = type_stmt.where(EquipmentType.group_id == scope)
    specs = list(db.scalars(spec_stmt).all())
    types = {t.id: t for t in db.scalars(type_stmt).all()}

    rows = []
    for spec in specs:
        numbered = len(_numbers_of(db, spec.id))
        target = _target_quantity(db, spec.id)
        in_use = len(_active_dispatches_of_spec(db, spec.id))
        type_row = types.get(spec.equipment_type_id)
        rows.append(
            {
                "spec_id": spec.id,
                "spec_name": spec.name,
                "type_id": spec.equipment_type_id,
                "type_name": type_row.name if type_row else "",
                "type_color": type_row.color if type_row else "blue",
                "is_active": spec.is_active,
                "boat_numbering_required": spec.boat_numbering_required,
                "target_quantity": target,
                "numbered_quantity": numbered,
                # 关闭编号的器材无需编号；停用规格也由前端弱化展示
                "complete": (not spec.boat_numbering_required) or numbered == target,
                "in_use": in_use,
            }
        )
    return {
        "rows": rows,
        "all_complete": all(r["complete"] for r in rows if r["is_active"]),
    }


def get_spec_numbers(
    db: Session, user: User, spec_id: str, active_group_id: str | None = None
) -> dict:
    spec = db.get(EquipmentSpec, spec_id)
    if not spec:
        raise HTTPException(status_code=404, detail="器材规格不存在")
    _assert_group(user, spec.group_id, active_group_id)
    type_row = db.get(EquipmentType, spec.equipment_type_id)
    active = {d.boat_number_id: d for d in _active_dispatches_of_spec(db, spec.id)}
    numbers = []
    for row in _numbers_of(db, spec.id):
        dispatch = active.get(row.id)
        numbers.append(
            {
                "id": row.id,
                "number": row.number,
                "in_use": dispatch is not None,
                "order_number": (
                    db.get(Order, dispatch.order_id).order_number if dispatch else None
                ),
            }
        )
    return {
        "spec_id": spec.id,
        "spec_name": spec.name,
        "type_name": type_row.name if type_row else "",
        "target_quantity": _target_quantity(db, spec.id),
        "boat_numbering_required": spec.boat_numbering_required,
        "numbers": numbers,
    }


def set_spec_numbers(
    db: Session, user: User, spec_id: str, numbers: list[str],
    active_group_id: str | None = None,
) -> dict:
    """Replace all numbers of one spec (must match the configured quantity)."""
    spec = db.get(EquipmentSpec, spec_id)
    if not spec:
        raise HTTPException(status_code=404, detail="器材规格不存在")
    _assert_group(user, spec.group_id, active_group_id)

    if not spec.boat_numbering_required:
        raise HTTPException(status_code=422, detail="该器材已关闭编号，无需编号")

    target = _target_quantity(db, spec.id)
    cleaned = [str(n).strip() for n in numbers]
    if any(not n for n in cleaned):
        raise HTTPException(status_code=422, detail="所有器材都必须填写编号")
    if len(cleaned) != target:
        raise HTTPException(
            status_code=422,
            detail=f"编号数量必须与器材数量一致（需要 {target} 个，当前 {len(cleaned)} 个）",
        )
    if len(set(cleaned)) != len(cleaned):
        raise HTTPException(status_code=422, detail="编号不能重复")

    # 全局规则：同一 Group 内所有器材的编号都不可以相同
    scope_cond = (
        BoatNumber.group_id == spec.group_id
        if spec.group_id
        else BoatNumber.group_id.is_(None)
    )
    conflict = db.scalar(
        select(BoatNumber.number)
        .where(
            BoatNumber.equipment_spec_id != spec.id,
            scope_cond,
            BoatNumber.number.in_(cleaned),
        )
        .limit(1)
    )
    if conflict is not None:
        raise HTTPException(
            status_code=422,
            detail=f"编号 {conflict} 已被其他器材使用，所有器材的编号不能相同",
        )

    if _active_dispatches_of_spec(db, spec.id):
        raise HTTPException(
            status_code=409, detail="该器材有船只正在使用，请全部返还后再修改编号"
        )

    existing = list(
        db.scalars(
            select(BoatNumber)
            .where(BoatNumber.equipment_spec_id == spec.id)
            .order_by(BoatNumber.created_at, BoatNumber.id)
        ).all()
    )
    # 先把旧编号改成唯一占位，避免“交换编号”时撞上唯一约束
    for idx, row in enumerate(existing):
        row.number = f"__tmp_{row.id}_{idx}"
    db.flush()

    for idx, number in enumerate(cleaned):
        if idx < len(existing):
            row = existing[idx]
            row.number = number
            row.updated_by_user_id = user.id
        else:
            db.add(
                BoatNumber(
                    id=str(uuid4()),
                    group_id=spec.group_id,
                    equipment_spec_id=spec.id,
                    number=number,
                    created_by_user_id=user.id,
                    updated_by_user_id=user.id,
                )
            )
    for extra in existing[len(cleaned):]:
        db.delete(extra)

    db.commit()
    return get_spec_numbers(db, user, spec_id, active_group_id)


def all_specs_numbered(db: Session, group_id: str | None) -> bool:
    """True when every active spec has exactly as many numbers as its quantity."""
    stmt = select(EquipmentSpec).where(EquipmentSpec.is_active.is_(True))
    if group_id is not None:
        stmt = stmt.where(EquipmentSpec.group_id == group_id)
    for spec in db.scalars(stmt).all():
        if not spec.boat_numbering_required:
            continue
        if len(_numbers_of(db, spec.id)) != _target_quantity(db, spec.id):
            return False
    return True


def _order_item_or_404(db: Session, order_item_id: str) -> OrderItem:
    item = db.get(OrderItem, order_item_id)
    if not item or not item.equipment_spec_id:
        raise HTTPException(status_code=404, detail="订单器材项目不存在")
    return item


def assign_number(
    db: Session, user: User, order_item_id: str, number: str,
    active_group_id: str | None = None,
) -> dict:
    item = _order_item_or_404(db, order_item_id)
    order = db.get(Order, item.order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    _assert_group(user, order.group_id, active_group_id)
    if order.status != "in_progress":
        raise HTTPException(status_code=409, detail="只有进行中的订单可以调配船只")

    number = str(number).strip()
    boat = db.scalar(
        select(BoatNumber).where(
            BoatNumber.equipment_spec_id == item.equipment_spec_id,
            BoatNumber.number == number,
        )
    )
    if not boat:
        raise HTTPException(status_code=422, detail="输入错误，请重新输入")

    active_stmt = select(BoatDispatch).where(
        BoatDispatch.order_item_id == item.id,
        BoatDispatch.departed.is_(True),
        BoatDispatch.returned.is_(False),
    )
    assigned = list(db.scalars(active_stmt).all())
    if any(d.number == number for d in assigned):
        # 该编号在本订单项目中已出发且未返还：提示占用（含重复提交场景）
        raise HTTPException(status_code=409, detail=f"{number}号船正在使用当中")

    occupied = db.scalar(
        select(BoatDispatch).where(
            BoatDispatch.boat_number_id == boat.id,
            BoatDispatch.departed.is_(True),
            BoatDispatch.returned.is_(False),
        )
    )
    if occupied:
        raise HTTPException(status_code=409, detail=f"{number}号船正在使用当中")

    # 调配总量按已调配过的船数（含已返还）计算，避免返还后重复要求补填
    total_assigned = len(
        db.scalars(
            select(BoatDispatch).where(
                BoatDispatch.order_item_id == item.id,
                BoatDispatch.departed.is_(True),
            )
        ).all()
    )
    if total_assigned >= item.quantity:
        raise HTTPException(status_code=422, detail="该订单项目已分配完船只")

    dispatch = BoatDispatch(
        id=str(uuid4()),
        group_id=order.group_id,
        order_id=order.id,
        order_item_id=item.id,
        equipment_spec_id=item.equipment_spec_id,
        boat_number_id=boat.id,
        number=number,
        departed=True,
        departed_at=utc_now(),
        departed_by_user_id=user.id,
        returned=False,
    )
    db.add(dispatch)
    db.commit()
    db.refresh(dispatch)
    return _dispatch_dict(db, dispatch)


def _dispatch_dict(db: Session, dispatch: BoatDispatch) -> dict:
    item = db.get(OrderItem, dispatch.order_item_id)
    spec = db.get(EquipmentSpec, dispatch.equipment_spec_id)
    type_row = db.get(EquipmentType, spec.equipment_type_id) if spec else None
    return {
        "dispatch_id": dispatch.id,
        "order_id": dispatch.order_id,
        "order_item_id": dispatch.order_item_id,
        "spec_id": dispatch.equipment_spec_id,
        "spec_name": spec.name if spec else "",
        "type_id": type_row.id if type_row else None,
        "type_name": type_row.name if type_row else "",
        "type_color": type_row.color if type_row else "blue",
        "number": dispatch.number,
        "quantity": item.quantity if item else 1,
        "departed_at": to_iso_z(dispatch.departed_at),
        "returned": dispatch.returned,
    }


def list_board(
    db: Session, user: User, active_group_id: str | None = None
) -> dict:
    """出发 / 返还 页面数据：进行中订单 + 已出发船只。"""
    scope = _group_scope(user, active_group_id)
    stmt = select(Order).where(Order.status == "in_progress")
    if scope is not None:
        stmt = stmt.where(Order.group_id == scope)
    orders = list(db.scalars(stmt).all())
    orders.sort(key=lambda o: (o.check_in_at is None, o.check_in_at or o.start_at))

    order_ids = [o.id for o in orders]
    items_by_order: dict[str, list[OrderItem]] = {oid: [] for oid in order_ids}
    if order_ids:
        for item in db.scalars(
            select(OrderItem).where(OrderItem.order_id.in_(order_ids))
        ).all():
            items_by_order[item.order_id].append(item)

    dispatch_stmt = select(BoatDispatch).where(BoatDispatch.departed.is_(True))
    if scope is not None:
        dispatch_stmt = dispatch_stmt.where(BoatDispatch.group_id == scope)
    all_dispatches = list(db.scalars(dispatch_stmt).all())
    by_item: dict[str, list[BoatDispatch]] = {}
    total_by_item: dict[str, int] = {}
    for d in all_dispatches:
        total_by_item[d.order_item_id] = total_by_item.get(d.order_item_id, 0) + 1
        if not d.returned:
            by_item.setdefault(d.order_item_id, []).append(d)
    dispatches = [d for d in all_dispatches if not d.returned]

    specs = {s.id: s for s in db.scalars(select(EquipmentSpec)).all()}
    types = {t.id: t for t in db.scalars(select(EquipmentType)).all()}

    cards = []
    for order in orders:
        lines = []
        for item in items_by_order.get(order.id, []):
            if not item.equipment_spec_id:
                continue
            spec = specs.get(item.equipment_spec_id)
            if not spec or not spec.boat_numbering_required:
                continue
            type_row = types.get(spec.equipment_type_id)
            assigned = sorted(
                by_item.get(item.id, []), key=lambda d: _natural_key(d.number)
            )
            lines.append(
                {
                    "order_item_id": item.id,
                    "spec_id": spec.id,
                    "spec_name": spec.name,
                    "type_id": type_row.id if type_row else None,
                    "type_name": type_row.name if type_row else "",
                    "type_color": type_row.color if type_row else "blue",
                    "quantity": item.quantity,
                    # 已调配过的船数（含已返还）：用于判断还需调配几行
                    "dispatched_total": total_by_item.get(item.id, 0),
                    "assigned": [
                        {
                            "dispatch_id": d.id,
                            "number": d.number,
                            "departed_at": to_iso_z(d.departed_at),
                        }
                        for d in assigned
                    ],
                }
            )
        cards.append(
            {
                "order_id": order.id,
                "order_number": order.order_number,
                "customer_name": order.customer_name,
                "customer_gender": order.customer_gender,
                "customer_wechat_nickname": order.customer_wechat_nickname,
                "check_in_at": to_iso_z(order.check_in_at),
                "lines": lines,
            }
        )

    departed = []
    for d in dispatches:
        order = db.get(Order, d.order_id)
        spec = specs.get(d.equipment_spec_id)
        type_row = types.get(spec.equipment_type_id) if spec else None
        departed.append(
            {
                "dispatch_id": d.id,
                "order_id": d.order_id,
                "order_number": order.order_number if order else "",
                "customer_name": order.customer_name if order else None,
                "customer_gender": order.customer_gender if order else None,
                "customer_wechat_nickname": order.customer_wechat_nickname if order else None,
                "spec_name": spec.name if spec else "",
                "type_id": type_row.id if type_row else None,
                "type_name": type_row.name if type_row else "",
                "type_color": type_row.color if type_row else "blue",
                "number": d.number,
                "departed_at": to_iso_z(d.departed_at),
            }
        )
    departed.sort(key=lambda x: _natural_key(x["number"]))

    return {"orders": cards, "departed": departed}


def return_dispatch(
    db: Session, user: User, dispatch_id: str, active_group_id: str | None = None
) -> dict:
    dispatch = db.get(BoatDispatch, dispatch_id)
    if not dispatch:
        raise HTTPException(status_code=404, detail="船只出发记录不存在")
    order = db.get(Order, dispatch.order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    _assert_group(user, order.group_id, active_group_id)

    if not dispatch.returned:
        dispatch.returned = True
        dispatch.returned_at = utc_now()
        dispatch.returned_by_user_id = user.id

    completed = _maybe_complete_order(db, order, user)
    db.commit()
    return {
        "dispatch_id": dispatch.id,
        "order_id": order.id,
        "order_number": order.order_number,
        "order_completed": completed,
    }


def reset_dispatch(
    db: Session, user: User, dispatch_id: str, active_group_id: str | None = None
) -> dict:
    """撤销一次出发（仅限出发 30 分钟内），船只回到待调配状态。

    只删除这一条出发记录，不影响同订单其他船只的出发状态。
    """
    dispatch = db.get(BoatDispatch, dispatch_id)
    if not dispatch:
        raise HTTPException(status_code=404, detail="船只出发记录不存在")
    order = db.get(Order, dispatch.order_id)
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    _assert_group(user, order.group_id, active_group_id)

    if dispatch.returned:
        raise HTTPException(status_code=422, detail="该船只已返还，无法重新出发")
    if dispatch.departed_at and utc_now() - dispatch.departed_at > timedelta(minutes=30):
        raise HTTPException(status_code=422, detail="出发已超过 30 分钟，无法重新出发")

    number = dispatch.number
    db.delete(dispatch)
    db.commit()
    return {
        "dispatch_id": dispatch_id,
        "order_id": order.id,
        "order_number": order.order_number,
        "number": number,
    }


def _maybe_complete_order(db: Session, order: Order, user: User) -> bool:
    """Complete the order once every required boat is assigned and returned."""
    if order.status != "in_progress":
        return False
    items = list(
        db.scalars(
            select(OrderItem).where(
                OrderItem.order_id == order.id,
                OrderItem.equipment_spec_id.is_not(None),
            )
        ).all()
    )
    if not items:
        return False
    # 只校验需要编号的器材：关闭「器材编号」的规格不参与船只调配
    spec_ids = {item.equipment_spec_id for item in items}
    required_ids = {
        s.id
        for s in db.scalars(
            select(EquipmentSpec).where(EquipmentSpec.id.in_(spec_ids))
        ).all()
        if s.boat_numbering_required
    }
    items = [item for item in items if item.equipment_spec_id in required_ids]
    if not items:
        return False
    dispatches = list(
        db.scalars(
            select(BoatDispatch).where(BoatDispatch.order_id == order.id)
        ).all()
    )
    for item in items:
        own = [d for d in dispatches if d.order_item_id == item.id]
        if len(own) < item.quantity:
            return False
        if any(not d.returned for d in own):
            return False
    if any(not d.returned for d in dispatches):
        return False

    now = utc_now()
    order.return_at = now
    order.return_by_user_id = user.id
    order.status = "completed"
    order.updated_by_user_id = user.id
    return True
