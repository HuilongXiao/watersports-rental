from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
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
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return _serialize(
        payment_service.add_adjustment(db, user, order_id, payload, active_group_id)
    )
