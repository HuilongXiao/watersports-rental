from datetime import datetime, time, timedelta, timezone

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
from app.core.time_utils import BUSINESS_TZ
from app.db.session import get_db
from app.models.order import Order
from app.models.user import User
from app.serializers import order_dict, orders_dict
from app.services import inventory_service, order_service

router = APIRouter(prefix="/api/orders", tags=["orders"])

VALID_STATUS_FILTERS = {"active", "in_progress", "cancelled", "no_show", "completed"}


def _day_start_utc(day) -> datetime:
    """业务日（Asia/Shanghai 日历日）00:00 对应的 UTC 时刻。"""
    return datetime.combine(day, time.min).replace(tzinfo=BUSINESS_TZ).astimezone(timezone.utc)


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
    # 支付方式 code（必须是启用中的方式，空值表示未选择）
    payment_method_code: str | None = None
    items: list[OrderItemInput] = Field(min_length=1)


@router.get("")
def list_orders(
    status: str | None = None,
    statuses: str | None = None,
    business_day: str | None = None,
    business_day_from: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    statement = select(Order).order_by(Order.start_at.asc())
    if active_group_id is not None:
        statement = statement.where(Order.group_id == active_group_id)

    # 状态过滤全部下推到 SQL：
    # - statuses：逗号分隔的状态集合，支持 "all"（不过滤状态）
    # - status：单个状态（兼容旧调用方）
    # - 两者都不传：返回全部状态（日结、订单分布等页面依赖此默认行为）
    if statuses:
        wanted = {s.strip() for s in statuses.split(",") if s.strip()}
        if "all" not in wanted:
            valid = wanted & VALID_STATUS_FILTERS
            if valid:
                statement = statement.where(Order.status.in_(valid))
            else:
                statement = statement.where(Order.id.is_(None))
    elif status:
        if status not in VALID_STATUS_FILTERS:
            statement = statement.where(Order.id.is_(None))
        elif status != "all":
            statement = statement.where(Order.status == status)

    def _parse_day(value: str):
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            return None

    # 业务日过滤下推到 SQL：避免把整个 group 的订单读进内存再逐条过滤
    if business_day:
        target = _parse_day(business_day)
        if target:
            start_utc = _day_start_utc(target)
            statement = statement.where(
                Order.start_at >= start_utc,
                Order.start_at < start_utc + timedelta(days=1),
            )
    if business_day_from:
        # 业务日期下限（含当日）
        lower = _parse_day(business_day_from)
        if lower:
            statement = statement.where(Order.start_at >= _day_start_utc(lower))

    orders = list(db.scalars(statement).all())
    return orders_dict(db, orders)


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


@router.post("/duplicate-check")
def check_duplicate(
    payload: OrderInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    """创建订单前重复检查：同一客户 + 同一业务日期 + 船型类型有交集。

    仅检查 active 和 in_progress 状态的订单。不写库，仅预警，
    前端由用户二次确认后仍可正常创建。
    """
    duplicates = order_service.check_duplicate_order(db, payload, active_group_id)
    return {"duplicates": duplicates}


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
