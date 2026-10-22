"""Equipment type / spec / sale item catalog management.

Historical catalog rows are never deleted: deactivate (is_active=False) instead.
Catalog rows are isolated by Group; superuser queries see all groups.
"""

from datetime import timedelta
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.time_utils import utc_now
from app.models.boat import BoatDispatch, BoatNumber
from app.models.equipment import (
    DEFAULT_EQUIPMENT_TYPE_COLOR,
    EQUIPMENT_TYPE_COLORS,
    EquipmentSpec,
    EquipmentType,
    SaleItem,
)
from app.models.order import Order, OrderItem
from app.models.user import User
from app.services.inventory_service import ensure_configuration

# Sentinel distinguishing "field omitted in PATCH" from an explicit None (clear capacity).
_UNSET = object()


def _group_scope(user: User, active_group_id: str | None = None):
    """Return a predicate-ready value: None for superuser (no filter), else group_id.

    When ``active_group_id`` is provided (superuser switching group), it overrides
    the superuser's natural None scope.
    """
    if user.role == "superuser":
        return active_group_id
    return user.group_id


def list_catalog(db: Session, user: User, active_group_id: str | None = None) -> dict:
    group_id = _group_scope(user, active_group_id)
    type_stmt = select(EquipmentType).order_by(EquipmentType.name)
    spec_stmt = select(EquipmentSpec).order_by(
        EquipmentSpec.sort_order, EquipmentSpec.created_at, EquipmentSpec.name
    )
    sale_stmt = select(SaleItem).order_by(SaleItem.name)
    if group_id is not None:
        type_stmt = type_stmt.where(EquipmentType.group_id == group_id)
        spec_stmt = spec_stmt.where(EquipmentSpec.group_id == group_id)
        sale_stmt = sale_stmt.where(SaleItem.group_id == group_id)
    types = list(db.scalars(type_stmt).all())
    specs = list(db.scalars(spec_stmt).all())
    sale_items = list(db.scalars(sale_stmt).all())
    type_meta = {item.id: item for item in types}

    # 近 7 日（按订单开始时间）各项目的销售数量总和，用于下单页下拉排序。
    # 排除已取消订单；器材规格与销售项目分别统计。
    since = utc_now() - timedelta(days=7)
    eq_sales = dict(
        db.execute(
            select(OrderItem.equipment_spec_id, func.coalesce(func.sum(OrderItem.quantity), 0))
            .where(OrderItem.equipment_spec_id.is_not(None))
            .select_from(OrderItem)
            .join(Order, Order.id == OrderItem.order_id)
            .where(Order.start_at >= since, Order.status != "cancelled")
            .group_by(OrderItem.equipment_spec_id)
        ).all()
    )
    sale_sales = dict(
        db.execute(
            select(OrderItem.sale_item_id, func.coalesce(func.sum(OrderItem.quantity), 0))
            .where(OrderItem.sale_item_id.is_not(None))
            .select_from(OrderItem)
            .join(Order, Order.id == OrderItem.order_id)
            .where(Order.start_at >= since, Order.status != "cancelled")
            .group_by(OrderItem.sale_item_id)
        ).all()
    )

    return {
        "equipment_types": [
            {"id": t.id, "name": t.name, "color": t.color, "is_active": t.is_active}
            for t in types
        ],
        "equipment": [
            {
                "id": s.id,
                "equipment_type_id": s.equipment_type_id,
                "equipment_type_name": type_meta.get(s.equipment_type_id).name
                if s.equipment_type_id in type_meta
                else None,
                "equipment_type_color": type_meta.get(s.equipment_type_id).color
                if s.equipment_type_id in type_meta
                else DEFAULT_EQUIPMENT_TYPE_COLOR,
                # 类型停用后其下规格在新订单中不可选；规格自身 is_active 保持独立
                "equipment_type_active": type_meta.get(s.equipment_type_id).is_active
                if s.equipment_type_id in type_meta
                else True,
                "name": s.name,
                "price": s.price,
                "capacity": s.capacity,
                "sort_order": s.sort_order,
                "is_active": s.is_active,
                "boat_numbering_required": s.boat_numbering_required,
                "show_in_usage": s.show_in_usage,
                "sold_quantity_7d": int(eq_sales.get(s.id, 0)),
            }
            for s in specs
        ],
        "sale_items": [
            {
                "id": i.id,
                "name": i.name,
                "price": i.price,
                "is_active": i.is_active,
                "sold_quantity_7d": int(sale_sales.get(i.id, 0)),
            }
            for i in sale_items
        ],
    }


def _validate_color(color: str) -> str:
    if color not in EQUIPMENT_TYPE_COLORS:
        raise HTTPException(
            status_code=422,
            detail=f"颜色必须是以下之一：{'、'.join(EQUIPMENT_TYPE_COLORS)}",
        )
    return color


def _ensure_group(user: User, active_group_id: str | None = None) -> str | None:
    """Return the effective group_id for new catalog rows.

    Superuser without an active group creates global rows (None). When an
    ``active_group_id`` is provided, the new row is assigned to that group.
    Non-superuser always uses their own group_id.
    """
    if user.role == "superuser":
        return active_group_id
    return user.group_id


def _check_group_ownership(user: User, row_group_id: str | None, row_label: str) -> None:
    """403 if a non-superuser attempts to touch a row outside their Group.

    Superuser is always allowed (can switch via active_group_id elsewhere).
    None means the row belongs to the global pool — only superuser can edit
    those too (non-superuser never sees them in list_catalog anyway).
    """
    if user.role == "superuser":
        return
    if row_group_id is None or row_group_id != user.group_id:
        raise HTTPException(status_code=403, detail=f"无权修改其他 Group 的{row_label}")


def create_equipment_type(
    db: Session, user: User, name: str, color: str,
    is_active: bool = True, active_group_id: str | None = None,
) -> EquipmentType:
    name = name.strip()
    _validate_color(color)
    group_id = _ensure_group(user, active_group_id)
    clash_stmt = select(EquipmentType).where(EquipmentType.name == name)
    if group_id is not None:
        clash_stmt = clash_stmt.where(EquipmentType.group_id == group_id)
    if db.scalar(clash_stmt):
        raise HTTPException(status_code=409, detail="设备大类名称已存在")
    item = EquipmentType(
        id=str(uuid4()),
        group_id=group_id,
        name=name,
        color=color,
        is_active=is_active,
        created_by_user_id=user.id,
        updated_by_user_id=user.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_equipment_type(
    db: Session, user: User, type_id: str, name: str, color: str,
    is_active: bool = True,
) -> EquipmentType:
    item = db.get(EquipmentType, type_id)
    if not item:
        raise HTTPException(status_code=404, detail="设备大类不存在")
    _check_group_ownership(user, item.group_id, "设备大类")
    name = name.strip()
    _validate_color(color)
    clash_stmt = select(EquipmentType).where(
        EquipmentType.name == name, EquipmentType.id != type_id
    )
    if item.group_id is not None:
        clash_stmt = clash_stmt.where(EquipmentType.group_id == item.group_id)
    if db.scalar(clash_stmt):
        raise HTTPException(status_code=409, detail="设备大类名称已存在")
    item.name = name
    item.color = color
    item.is_active = is_active
    item.updated_by_user_id = user.id
    db.commit()
    db.refresh(item)
    return item


def _validate_price(price: int) -> None:
    if price < 0:
        raise HTTPException(status_code=422, detail="价格不能为负")


def create_equipment_spec(
    db: Session, user: User, equipment_type_id: str, name: str,
    price: int, capacity: int | None, is_active: bool, quantity: int = 0,
    boat_numbering_required: bool = True,
    show_in_usage: bool = True,
) -> EquipmentSpec:
    _validate_price(price)
    type_row = db.get(EquipmentType, equipment_type_id)
    if not type_row:
        raise HTTPException(status_code=404, detail="设备大类不存在")
    _check_group_ownership(user, type_row.group_id, "设备大类")
    name = name.strip()
    clash_stmt = select(EquipmentSpec).where(
        EquipmentSpec.equipment_type_id == equipment_type_id,
        EquipmentSpec.name == name,
    )
    if type_row.group_id is not None:
        clash_stmt = clash_stmt.where(EquipmentSpec.group_id == type_row.group_id)
    if db.scalar(clash_stmt):
        raise HTTPException(status_code=409, detail="该大类下规格名称已存在")
    # 新规格默认排在该 Group 所有规格的最后
    max_order_stmt = select(func.coalesce(func.max(EquipmentSpec.sort_order), 0))
    if type_row.group_id is not None:
        max_order_stmt = max_order_stmt.where(EquipmentSpec.group_id == type_row.group_id)
    next_order = int(db.scalar(max_order_stmt) or 0) + 1
    item = EquipmentSpec(
        id=str(uuid4()),
        group_id=type_row.group_id,
        equipment_type_id=equipment_type_id,
        name=name,
        price=price,
        capacity=capacity,
        sort_order=next_order,
        is_active=is_active,
        boat_numbering_required=boat_numbering_required,
        show_in_usage=show_in_usage,
        created_by_user_id=user.id,
        updated_by_user_id=user.id,
    )
    db.add(item)
    db.flush()
    config = ensure_configuration(db, item.id, user.id, group_id=item.group_id)
    # 新建规格时直接写入库存总量（新规格占用必然为 0，无需二次校验）
    config.total_quantity = quantity
    config.updated_by_user_id = user.id
    db.commit()
    db.refresh(item)
    return item


def update_equipment_spec(
    db: Session, user: User, spec_id: str,
    name: str | None = None, price: int | None = None,
    capacity=_UNSET, is_active: bool | None = None,
    equipment_type_id: str | None = None,
    boat_numbering_required: bool | None = None,
    show_in_usage: bool | None = None,
) -> EquipmentSpec:
    item = db.get(EquipmentSpec, spec_id)
    if not item:
        raise HTTPException(status_code=404, detail="设备规格不存在")
    _check_group_ownership(user, item.group_id, "设备规格")

    new_type_id = equipment_type_id or item.equipment_type_id
    if equipment_type_id:
        new_type_row = db.get(EquipmentType, new_type_id)
        if not new_type_row:
            raise HTTPException(status_code=404, detail="设备大类不存在")
        # 切换 equipment_type 时，新 type 必须属于同一 group（或都在全局池）
        # 否则就相当于越权引用别的 group 的分类
        if (
            new_type_row.group_id != item.group_id
        ):
            raise HTTPException(status_code=403, detail="新设备大类与当前规格不在同一 Group")
    new_type_row = None

    new_name = name.strip() if name is not None else item.name
    if new_name != item.name or new_type_id != item.equipment_type_id:
        clash_stmt = select(EquipmentSpec).where(
            EquipmentSpec.equipment_type_id == new_type_id,
            EquipmentSpec.name == new_name,
            EquipmentSpec.id != spec_id,
        )
        if item.group_id is not None:
            clash_stmt = clash_stmt.where(EquipmentSpec.group_id == item.group_id)
        if db.scalar(clash_stmt):
            raise HTTPException(status_code=409, detail="该大类下规格名称已存在")

    if price is not None:
        _validate_price(price)
        item.price = price
    if name is not None:
        item.name = new_name
    if equipment_type_id is not None:
        item.equipment_type_id = new_type_id
    # capacity is nullable (paddleboard); only touch it when explicitly provided.
    if capacity is not _UNSET:
        item.capacity = capacity
    if is_active is not None:
        item.is_active = is_active
    # 关闭编号前需确认该器材没有正在使用的船只，并清空已编好的编号（编号全局唯一，可被复用）
    if (
        boat_numbering_required is not None
        and boat_numbering_required != item.boat_numbering_required
    ):
        if not boat_numbering_required:
            in_use = db.scalar(
                select(BoatDispatch.id)
                .where(
                    BoatDispatch.equipment_spec_id == item.id,
                    BoatDispatch.departed.is_(True),
                    BoatDispatch.returned.is_(False),
                )
                .limit(1)
            )
            if in_use:
                raise HTTPException(
                    status_code=409, detail="该器材还有已出发的船只，请全部返还后再关闭编号"
                )
            db.execute(
                delete(BoatNumber).where(BoatNumber.equipment_spec_id == item.id)
            )
        item.boat_numbering_required = boat_numbering_required
    if show_in_usage is not None:
        item.show_in_usage = show_in_usage
    item.updated_by_user_id = user.id
    db.commit()
    db.refresh(item)
    return item


def reorder_equipment_specs(
    db: Session, user: User, ordered_ids: list[str],
    active_group_id: str | None = None,
) -> None:
    """Persist a new display order for equipment specs within the user's Group.

    IDs not visible in the current Group scope are rejected; specs omitted from
    the list keep their existing relative order (defensive: the UI always
    sends the full list).
    """
    if not ordered_ids:
        raise HTTPException(status_code=422, detail="排序列表不能为空")
    if len(ordered_ids) != len(set(ordered_ids)):
        raise HTTPException(status_code=422, detail="排序列表存在重复项目")

    group_id = _group_scope(user, active_group_id)
    stmt = select(EquipmentSpec)
    if group_id is not None:
        stmt = stmt.where(EquipmentSpec.group_id == group_id)
    specs = {s.id: s for s in db.scalars(stmt).all()}

    unknown = [sid for sid in ordered_ids if sid not in specs]
    if unknown:
        raise HTTPException(status_code=404, detail="包含不属于当前 Group 的器材规格")

    for index, spec_id in enumerate(ordered_ids):
        specs[spec_id].sort_order = index
    # 未包含在列表中的规格顺延到后面（理论上不会发生，保持防御）
    leftover = sorted(
        (s for sid, s in specs.items() if sid not in set(ordered_ids)),
        key=lambda s: (s.sort_order, s.name),
    )
    for offset, spec in enumerate(leftover, start=len(ordered_ids)):
        spec.sort_order = offset
    db.commit()


def create_sale_item(
    db: Session, user: User, name: str, price: int, is_active: bool,
    active_group_id: str | None = None,
) -> SaleItem:
    _validate_price(price)
    name = name.strip()
    group_id = _ensure_group(user, active_group_id)
    clash_stmt = select(SaleItem).where(SaleItem.name == name)
    if group_id is not None:
        clash_stmt = clash_stmt.where(SaleItem.group_id == group_id)
    if db.scalar(clash_stmt):
        raise HTTPException(status_code=409, detail="售卖项目名称已存在")
    item = SaleItem(
        id=str(uuid4()),
        group_id=group_id,
        name=name,
        price=price,
        is_active=is_active,
        created_by_user_id=user.id,
        updated_by_user_id=user.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def update_sale_item(
    db: Session, user: User, item_id: str,
    name: str | None = None, price: int | None = None, is_active: bool | None = None,
) -> SaleItem:
    item = db.get(SaleItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="售卖项目不存在")
    _check_group_ownership(user, item.group_id, "售卖项目")
    if name is not None:
        new_name = name.strip()
        clash_stmt = select(SaleItem).where(
            SaleItem.name == new_name, SaleItem.id != item_id
        )
        if item.group_id is not None:
            clash_stmt = clash_stmt.where(SaleItem.group_id == item.group_id)
        if db.scalar(clash_stmt):
            raise HTTPException(status_code=409, detail="售卖项目名称已存在")
        item.name = new_name
    if price is not None:
        _validate_price(price)
        item.price = price
    if is_active is not None:
        item.is_active = is_active
    item.updated_by_user_id = user.id
    db.commit()
    db.refresh(item)
    return item
