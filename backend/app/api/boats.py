from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import boat_service

router = APIRouter(prefix="/api/boats", tags=["boats"])


class NumbersInput(BaseModel):
    numbers: list[str]


class AssignInput(BaseModel):
    order_item_id: str
    number: str = Field(min_length=1, max_length=32)


@router.get("/numbering")
def numbering_overview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.list_numbering(db, user, active_group_id)


@router.get("/numbering/{spec_id}")
def spec_numbers(
    spec_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.get_spec_numbers(db, user, spec_id, active_group_id)


@router.put("/numbering/{spec_id}")
def save_spec_numbers(
    spec_id: str,
    payload: NumbersInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.set_spec_numbers(db, user, spec_id, payload.numbers, active_group_id)


@router.get("/board")
def dispatch_board(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.list_board(db, user, active_group_id)


@router.post("/assign")
def assign_number(
    payload: AssignInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.assign_number(
        db, user, payload.order_item_id, payload.number, active_group_id
    )


@router.post("/return/{dispatch_id}")
def return_number(
    dispatch_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.return_dispatch(db, user, dispatch_id, active_group_id)


@router.post("/reset/{dispatch_id}")
def reset_departure(
    dispatch_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return boat_service.reset_dispatch(db, user, dispatch_id, active_group_id)
