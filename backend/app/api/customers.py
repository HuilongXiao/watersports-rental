from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user, require_role
from app.db.session import get_db
from app.models.user import User
from app.serializers import customer_dict
from app.services import customer_service

router = APIRouter(prefix="/api/customers", tags=["customers"])


class CustomerInput(BaseModel):
    name: str | None = None
    gender: str | None = None
    wechat_nickname: str | None = None
    wechat_id: str | None = None
    phone: str | None = None
    note: str | None = None
    remind: bool = False


@router.get("")
def list_customers(
    q: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    customers = customer_service.search_customers(db, q, user, active_group_id)
    stats = customer_service.customer_order_stats(db, [c.id for c in customers])
    result = []
    for c in customers:
        item = customer_dict(c)
        total_orders, total_spending_fen = stats.get(c.id, (0, 0))
        item["total_orders"] = total_orders
        item["total_spending_fen"] = total_spending_fen
        result.append(item)
    return result


@router.get("/{customer_id}")
def get_customer(
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return customer_dict(customer_service.get_customer(db, customer_id, user, active_group_id))


@router.post("")
def create_customer(
    payload: CustomerInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    customer = customer_service.create_customer(db, user, payload.model_dump(), active_group_id)
    return customer_dict(customer)


@router.put("/{customer_id}")
def update_customer(
    customer_id: str,
    payload: CustomerInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    customer = customer_service.update_customer(
        db, user, customer_id, payload.model_dump(), active_group_id
    )
    return customer_dict(customer)


@router.delete("/{customer_id}")
def delete_customer(
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_role("superuser")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    # 永久删除客户 profile：仅 superuser；系统客户与仍有订单的客户由 service 拒绝
    customer_service.delete_customer(db, user, customer_id, active_group_id)
    return {"deleted": True}


@router.get("/{customer_id}/stats")
def customer_stats(
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    customer = customer_service.get_customer(db, customer_id, user, active_group_id)
    # Count orders by status and sum completed order amounts
    from sqlalchemy import func, select as sa_select
    from app.models.order import Order, OrderItem
    from app.models.payment import Payment, PaymentItem

    orders = list(db.scalars(
        sa_select(Order).where(Order.customer_id == customer_id).order_by(Order.start_at.asc())
    ).all())

    total_orders = len(orders)
    completed_orders = [o for o in orders if o.status == "completed"]
    no_show_orders = [o for o in orders if o.status == "no_show"]
    completed_count = len(completed_orders)
    no_show_count = len(no_show_orders)

    # Cumulative spending = sum of (items_total + adjustments_total) for completed orders
    total_spending_fen = 0
    for order in completed_orders:
        items_total = db.scalar(
            sa_select(func.coalesce(func.sum(OrderItem.quantity * OrderItem.unit_price), 0)).where(
                OrderItem.order_id == order.id
            )
        ) or 0
        adjustments_total = db.scalar(
            sa_select(func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.id == PaymentItem.payment_id)
            .where(Payment.order_id == order.id)
        ) or 0
        total_spending_fen += int(items_total) + int(adjustments_total)

    return {
        "total_spending_fen": total_spending_fen,
        "total_orders": total_orders,
        "completed_orders": completed_count,
        "no_show_orders": no_show_count,
        "no_show_order_ids": [o.id for o in no_show_orders],
    }


@router.get("/{customer_id}/orders")
def customer_orders(
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    customer = customer_service.get_customer(db, customer_id, user, active_group_id)
    from sqlalchemy import select as sa_select
    from app.models.order import Order
    from app.serializers import order_dict
    orders = list(db.scalars(
        sa_select(Order).where(Order.customer_id == customer_id).order_by(Order.start_at.asc())
    ).all())
    return [order_dict(db, o) for o in orders]
