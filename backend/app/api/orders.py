from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.auth import (
    get_active_group_id,
    get_current_user,
    require_permission,
    require_role,
)
from app.core.time_utils import business_date
from app.db.session import get_db
from app.models.order import Order
from app.models.user import User
from app.serializers import order_dict
from app.services import inventory_service, order_service

router = APIRouter(prefix="/api/orders", tags=["orders"])

VALID_STATUS_FILTERS = {"active", "in_progress", "cancelled", "no_show", "completed"}


class OrderItemInput(BaseModel):
    equipment_spec_id: str | None = None
    sale_item_id: str | None = None
    quantity: int = Field(ge=1)


class OrderInput(BaseModel):
    customer_id: str | None = None
    # Fast customer mode fields. wechat_nickname is the current identifier;
    # customer_name is kept for backward compatibility with older clients.
    customer_name: str | None = None
    customer_wechat_nickname: str | None = None
    start_at: datetime
    adult_count: int = Field(ge=0)
    child_count: int = Field(ge=0)
    note: str | None = None
    is_walk_in: bool = False
    note_popup: bool = False
    items: list[OrderItemInput] = Field(min_length=1)


@router.get("")
def list_orders(
    status: str | None = None,
    business_day: str | None = None,
    business_day_from: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    statement = select(Order).order_by(Order.start_at.asc())
    if active_group_id is not None:
        statement = statement.where(Order.group_id == active_group_id)
    if status:
        if status not in VALID_STATUS_FILTERS:
            statement = statement.where(Order.id.is_(None))
        else:
            statement = statement.where(Order.status == status)
    orders = list(db.scalars(statement).all())

    def _parse_day(value: str):
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            return None

    if business_day:
        target = _parse_day(business_day)
        if target:
            orders = [o for o in orders if business_date(o.start_at) == target]
    if business_day_from:
        # 业务日期下限（含当日）：只保留开始时间业务日期 >= 该日期的订单
        lower = _parse_day(business_day_from)
        if lower:
            orders = [o for o in orders if business_date(o.start_at) >= lower]
    return [order_dict(db, o) for o in orders]


@router.get("/{order_id}")
def get_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.get_order(db, order_id, user, active_group_id)
    return order_dict(db, order)


@router.post("")
def create_order(
    payload: OrderInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("create_order")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.create_order(db, user, payload, active_group_id)
    return order_dict(db, order)


@router.post("/conflicts")
def check_conflicts(
    payload: OrderInput,
    exclude_order_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    """下单前库存冲突预检：返回该订单 4 小时 block 窗口内各船型的缺口明细。

    编辑订单时通过 query 参数 exclude_order_id 排除订单自身。预检不写库，
    冲突仅作预警，前端由用户二次确认后仍可正常保存。
    """
    resolved = order_service._resolve_items(db, payload.items)
    start_at = order_service._normalize_utc(payload.start_at)
    conflicts = inventory_service.check_order_conflicts(
        db, resolved, start_at, active_group_id, exclude_order_id
    )
    return {"conflicts": conflicts}


@router.put("/{order_id}")
def update_order(
    order_id: str,
    payload: OrderInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("edit_order")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.update_order(db, user, order_id, payload, active_group_id)
    return order_dict(db, order)


@router.delete("/{order_id}")
def delete_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("superuser")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    # 永久删除订单（含订单项目与支付记录）：仅 superuser
    order_service.delete_order(db, user, order_id, active_group_id)
    return {"deleted": True}


@router.post("/{order_id}/check-in")
def check_in(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order, warnings = order_service.check_in(db, user, order_id, active_group_id)
    return order_dict(db, order, check_in_warnings=warnings)


@router.post("/{order_id}/cancel-check-in")
def cancel_check_in(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.cancel_check_in(db, user, order_id, active_group_id)
    return order_dict(db, order)


@router.post("/{order_id}/return")
def return_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.return_order(db, user, order_id, active_group_id)
    return order_dict(db, order)


@router.post("/{order_id}/cancel-return")
def cancel_return(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.cancel_return(db, user, order_id, active_group_id)
    return order_dict(db, order)


@router.post("/{order_id}/cancel")
def cancel_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.cancel_order(db, user, order_id, active_group_id)
    return order_dict(db, order)


@router.post("/{order_id}/no-show")
def mark_no_show(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.mark_no_show(db, user, order_id, active_group_id)
    return order_dict(db, order)


@router.post("/{order_id}/complete")
def complete_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.complete_order(db, user, order_id, active_group_id)
    return order_dict(db, order)


@router.post("/{order_id}/restore")
def restore_order(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    order = order_service.restore_order(db, user, order_id, active_group_id)
    return order_dict(db, order)
