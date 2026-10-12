from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import inventory_service

router = APIRouter(prefix="/api/inventory", tags=["inventory"])


class InventoryInput(BaseModel):
    total_quantity: int = Field(ge=0)


@router.get("")
def list_inventory(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return inventory_service.list_inventory(db, user, active_group_id)


@router.put("/{equipment_spec_id}")
def set_inventory(
    equipment_spec_id: str,
    payload: InventoryInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return inventory_service.set_inventory(
        db, user, equipment_spec_id, payload.total_quantity, active_group_id
    )
