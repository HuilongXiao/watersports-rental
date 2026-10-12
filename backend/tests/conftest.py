"""Pytest configuration: isolated temp SQLite database for every test.

Environment is set before any app import so the engine binds to the temp DB.
Each test gets freshly created tables + seed data, so tests are independent
and can run repeatedly (the old skeleton wrote into the dev database).
"""

import os
import tempfile
from pathlib import Path

_tmp_dir = tempfile.mkdtemp(prefix="rental-test-")
# 强制指向临时数据库；绝不能用 setdefault，否则容器已注入的 DATABASE_URL
# 会让测试覆盖开发/生产库。
os.environ["DATABASE_URL"] = f"sqlite:///{(Path(_tmp_dir) / 'test.db').as_posix()}"
os.environ.setdefault("SESSION_SECRET", "test-secret")
os.environ.setdefault("INITIAL_ADMIN_USERNAME", "superuserx")
os.environ.setdefault("INITIAL_ADMIN_PASSWORD", "123456")
os.environ.setdefault("DISABLE_SCHEDULER", "true")

import pytest
from fastapi.testclient import TestClient

from app.db.base import Base
from app.db.seed import seed_system_data
from app.db.session import SessionLocal, engine
from app.main import app


def _seed_test_catalog() -> None:
    """Create the demo catalog tests rely on.

    The production seed intentionally ships without catalog entries (operators
    manage them in the UI), so tests provision their own fixture data. Catalog
    items are assigned to the default Group created by the system seed.
    """
    from uuid import uuid4

    from sqlalchemy import select

    from app.models.equipment import EquipmentSpec, EquipmentType, SaleItem
    from app.models.group import Group
    from app.models.inventory import InventoryConfiguration
    from app.models.user import User

    db = SessionLocal()
    try:
        system = db.scalar(select(User).where(User.is_system.is_(True)))
        actor = system.id
        group = db.scalar(select(Group))  # default group created by seed
        group_id = group.id if group else None

        kayak_type = EquipmentType(
            id=str(uuid4()), name="皮划艇", color="blue", group_id=group_id,
            created_by_user_id=actor, updated_by_user_id=actor,
        )
        board_type = EquipmentType(
            id=str(uuid4()), name="桨板", color="green", group_id=group_id,
            created_by_user_id=actor, updated_by_user_id=actor,
        )
        db.add_all([kayak_type, board_type])
        db.flush()

        spec_rows = [
            (kayak_type.id, "竞速皮划艇-3人座", 18000, 3),
            (kayak_type.id, "竞速皮划艇-2人座", 15000, 2),
            (kayak_type.id, "竞速皮划艇-1人座", 10000, 1),
            (kayak_type.id, "休闲皮划艇-3人座", 15000, 3),
            (kayak_type.id, "休闲皮划艇-2人座", 12000, 2),
            (board_type.id, "桨板", 10000, None),
        ]
        specs = [
            EquipmentSpec(
                id=str(uuid4()),
                group_id=group_id,
                equipment_type_id=type_id,
                name=name,
                price=price,
                capacity=capacity,
                is_active=True,
                created_by_user_id=actor,
                updated_by_user_id=actor,
            )
            for type_id, name, price, capacity in spec_rows
        ]
        db.add_all(specs)
        db.flush()

        db.add_all(
            InventoryConfiguration(
                id=str(uuid4()),
                group_id=group_id,
                equipment_spec_id=spec.id,
                total_quantity=5,
                updated_by_user_id=actor,
            )
            for spec in specs
        )
        db.add_all(
            [
                SaleItem(
                    id=str(uuid4()), name="防水袋", price=2000, is_active=True,
                    group_id=group_id,
                    created_by_user_id=actor, updated_by_user_id=actor,
                ),
                SaleItem(
                    id=str(uuid4()), name="手机防水套", price=1000, is_active=True,
                    group_id=group_id,
                    created_by_user_id=actor, updated_by_user_id=actor,
                ),
            ]
        )
        db.commit()
    finally:
        db.close()


@pytest.fixture()
def client():
    # Reset schema and seed deterministically before each test.
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    seed_system_data()
    _seed_test_catalog()
    # No lifespan context needed: init/seed are already done above.
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def logged_in_client(client):
    response = client.post(
        "/api/auth/login", data={"username": "superuserx", "password": "123456"}
    )
    assert response.status_code == 200, response.text
    return client
