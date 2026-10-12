from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, get_current_user
from app.db.session import get_db
from app.models.user import User
from app.services import catalog_service
from app.services.catalog_service import _UNSET

router = APIRouter(prefix="/api/catalog", tags=["catalog"])

EquipmentColor = Literal["red", "blue", "green", "yellow", "purple", "orange", "cyan"]


class EquipmentTypeInput(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    color: EquipmentColor = "blue"


class EquipmentSpecInput(BaseModel):
    equipment_type_id: str
    name: str = Field(min_length=1, max_length=128)
    price: int = Field(ge=0)
    capacity: int | None = Field(default=None, ge=1)
    is_active: bool = True


class EquipmentSpecUpdate(BaseModel):
    equipment_type_id: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=128)
    price: int | None = Field(default=None, ge=0)
    # Use an explicit sentinel so that PATCH can set capacity to NULL (paddleboard).
    capacity: int | None = Field(default=None, ge=1)
    clear_capacity: bool = False
    is_active: bool | None = None


class SaleItemInput(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    price: int = Field(ge=0)
    is_active: bool = True


class SaleItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    price: int | None = Field(default=None, ge=0)
    is_active: bool | None = None


@router.get("")
def list_catalog(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    return catalog_service.list_catalog(db, user, active_group_id)


@router.post("/equipment-types")
def create_equipment_type(
    payload: EquipmentTypeInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    item = catalog_service.create_equipment_type(
        db, user, payload.name, payload.color, active_group_id
    )
    return {"id": item.id, "name": item.name, "color": item.color}


@router.put("/equipment-types/{type_id}")
def update_equipment_type(
    type_id: str,
    payload: EquipmentTypeInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    item = catalog_service.update_equipment_type(
        db, user, type_id, payload.name, payload.color
    )
    return {"id": item.id, "name": item.name, "color": item.color}


@router.post("/equipment-specs")
def create_equipment_spec(
    payload: EquipmentSpecInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    spec = catalog_service.create_equipment_spec(
        db, user, payload.equipment_type_id, payload.name, payload.price,
        payload.capacity, payload.is_active,
    )
    return catalog_service.list_catalog(db, user, active_group_id)


@router.put("/equipment-specs/{spec_id}")
def update_equipment_spec(
    spec_id: str,
    payload: EquipmentSpecUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    if payload.clear_capacity:
        capacity = None
    elif "capacity" in payload.model_fields_set:
        capacity = payload.capacity
    else:
        capacity = _UNSET
    catalog_service.update_equipment_spec(
        db, user, spec_id,
        name=payload.name,
        price=payload.price,
        capacity=capacity,
        is_active=payload.is_active,
        equipment_type_id=payload.equipment_type_id,
    )
    return catalog_service.list_catalog(db, user, active_group_id)


class EquipmentSpecReorder(BaseModel):
    # 按目标展示顺序排列的规格 ID 全量列表
    ids: list[str]


@router.post("/equipment-specs/reorder")
def reorder_equipment_specs(
    payload: EquipmentSpecReorder,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    catalog_service.reorder_equipment_specs(db, user, payload.ids, active_group_id)
    return catalog_service.list_catalog(db, user, active_group_id)


@router.post("/sale-items")
def create_sale_item(
    payload: SaleItemInput,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    catalog_service.create_sale_item(
        db, user, payload.name, payload.price, payload.is_active, active_group_id
    )
    return catalog_service.list_catalog(db, user, active_group_id)


@router.put("/sale-items/{item_id}")
def update_sale_item(
    item_id: str,
    payload: SaleItemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    active_group_id: str | None = Depends(get_active_group_id),
):
    catalog_service.update_sale_item(
        db, user, item_id, name=payload.name, price=payload.price, is_active=payload.is_active
    )
    return catalog_service.list_catalog(db, user, active_group_id)
