from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user, require_permission
from app.core.time_utils import to_iso_z
from app.db.session import get_db
from app.models.user import User
from app.services import payment_service

router = APIRouter(prefix="/api/orders", tags=["payments"])


class AdjustmentInput(BaseModel):
    # quantity may be negative (refund/deduction); it must never be 0.
    quantity: int
    # unit_amount is always positive (min 1 fen); the sign of amount comes from quantity.
    unit_amount: int = Field(ge=1)
    note: str = Field(min_length=1)


class ItemRefundInput(BaseModel):
    """按订单项目退款：金额（分）为正数，备注必填。"""

    order_item_id: str
    order_item_split_id: str | None = None
    amount_fen: int = Field(ge=1)
    note: str = Field(min_length=1)


class ItemPriceAdjustInput(BaseModel):
    """按订单项目调整价格：new_amount_fen 为该行调整后的净额（分）。"""

    order_item_id: str
    order_item_split_id: str | None = None
    new_amount_fen: int = Field(ge=0)
    note: str = Field(min_length=1)


class ItemSplitInput(BaseModel):
    """把一行订单项目拆分为多行：各行的金额（分）之和须等于该行当前净额。"""

    order_item_id: str
    amounts_fen: list[int] = Field(min_length=2)


def _serialize(view: dict) -> dict:
    for item in view["adjustments"]:
        item["created_at"] = to_iso_z(item["created_at"])
    return view


@router.get("/{order_id}/payment")
def get_payment(
    order_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return _serialize(payment_service.payment_view(db, order_id, user, active_group_id))


@router.post("/{order_id}/payment/adjustments")
def add_adjustment(
    order_id: str,
    payload: AdjustmentInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("edit_order")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return _serialize(
        payment_service.add_adjustment(db, user, order_id, payload, active_group_id)
    )


@router.post("/{order_id}/payment/item-refunds")
def add_item_refund(
    order_id: str,
    payload: ItemRefundInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("edit_order")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return _serialize(
        payment_service.add_item_refund(db, user, order_id, payload, active_group_id)
    )


@router.post("/{order_id}/payment/item-price-adjustments")
def add_item_price_adjust(
    order_id: str,
    payload: ItemPriceAdjustInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("edit_order")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return _serialize(
        payment_service.add_item_price_adjust(db, user, order_id, payload, active_group_id)
    )


@router.post("/{order_id}/payment/item-splits")
def split_item(
    order_id: str,
    payload: ItemSplitInput,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("edit_order")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return _serialize(
        payment_service.split_order_item(db, user, order_id, payload, active_group_id)
    )
