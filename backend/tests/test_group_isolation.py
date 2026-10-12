"""Multi-tenant (Group) isolation tests.

Verifies that:
1. Superuser can create groups and managers.
2. A manager in group A cannot see group B's catalog/orders/customers.
3. Superuser can see both groups' data.
"""

from datetime import timedelta
from uuid import uuid4

from app.core.time_utils import BUSINESS_TZ, utc_now


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _login(client, username, password):
    resp = client.post("/api/auth/login", data={"username": username, "password": password})
    assert resp.status_code == 200, resp.text


def _create_group(client, name):
    resp = client.post("/api/groups", json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_manager(client, group_id, *, username, display_name, password):
    resp = client.post(
        f"/api/groups/{group_id}/managers",
        json={"username": username, "display_name": display_name, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_equipment_type(client, name):
    resp = client.post(
        "/api/catalog/equipment-types", json={"name": name, "color": "blue"}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_equipment_spec(client, type_id, name):
    resp = client.post(
        "/api/catalog/equipment-specs",
        json={
            "equipment_type_id": type_id,
            "name": name,
            "price": 10000,
            "capacity": 2,
            "is_active": True,
        },
    )
    assert resp.status_code == 200, resp.text
    # The endpoint returns the full catalog; pick the spec we just created.
    catalog = resp.json()
    spec = next(s for s in catalog["equipment"] if s["name"] == name)
    return spec


def _create_customer(client, *, name, phone):
    resp = client.post("/api/customers", json={"name": name, "phone": phone})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _create_order(client, customer_id, spec_id):
    start_at = _iso(_now_local() - timedelta(minutes=5))
    resp = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start_at,
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec_id, "quantity": 1}],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_superuser_can_create_groups_and_managers(logged_in_client):
    client = logged_in_client
    group = _create_group(client, f"test-group-{uuid4().hex[:6]}")
    assert group["id"]
    assert group["name"].startswith("test-group-")
    assert group["is_active"] is True

    manager = _create_manager(
        client, group["id"],
        username=f"mgr-{uuid4().hex[:6]}",
        display_name="Manager",
        password="pw123",
    )
    assert manager["role"] == "admin"
    assert manager["group_id"] == group["id"]


def test_manager_cannot_see_other_group_catalog(logged_in_client):
    client = logged_in_client
    # Two groups, each with one manager and one equipment type.
    group_a = _create_group(client, f"groupA-{uuid4().hex[:6]}")
    group_b = _create_group(client, f"groupB-{uuid4().hex[:6]}")

    type_a = _create_equipment_type(client, f"皮划艇-A-{uuid4().hex[:6]}")
    type_b = _create_equipment_type(client, f"皮划艇-B-{uuid4().hex[:6]}")

    # The superuser sees both equipment types.
    catalog = client.get("/api/catalog").json()
    type_names = {t["name"] for t in catalog["equipment_types"]}
    assert type_a["name"] in type_names
    assert type_b["name"] in type_names

    # Manager A logs in and should NOT see type B... but wait, superuser created
    # both types with group_id=None. This test verifies manager isolation only
    # when catalog is created by the manager themselves. Let's create as manager.
    manager_a = _create_manager(
        client, group_a["id"],
        username=f"mgrA-{uuid4().hex[:6]}",
        display_name="Manager A",
        password="pw123",
    )
    client.post("/api/auth/logout")
    _login(client, manager_a["username"], "pw123")

    # Manager A creates an equipment type — it should be assigned to group A.
    type_a_mgr = _create_equipment_type(client, f"桨板-A-{uuid4().hex[:6]}")
    catalog_a = client.get("/api/catalog").json()
    a_names = {t["name"] for t in catalog_a["equipment_types"]}
    assert type_a_mgr["name"] in a_names
    # Manager A does NOT see type_b (created by superuser with group_id=None...
    # actually superuser rows have group_id=None which is not group A's id, so
    # manager A should not see them).
    assert type_b["name"] not in a_names


def test_manager_cannot_see_other_group_orders(logged_in_client):
    client = logged_in_client
    group_a = _create_group(client, f"grpA-{uuid4().hex[:6]}")
    group_b = _create_group(client, f"grpB-{uuid4().hex[:6]}")

    # Create a manager in group A and a manager in group B.
    manager_a = _create_manager(
        client, group_a["id"],
        username=f"mgrA-{uuid4().hex[:6]}",
        display_name="Manager A",
        password="pw123",
    )
    manager_b = _create_manager(
        client, group_b["id"],
        username=f"mgrB-{uuid4().hex[:6]}",
        display_name="Manager B",
        password="pw123",
    )

    # Manager A creates a customer + equipment + order in group A.
    client.post("/api/auth/logout")
    _login(client, manager_a["username"], "pw123")
    cust_a = _create_customer(
        client, name=f"custA-{uuid4().hex[:6]}", phone=f"139{uuid4().hex[:8]}"
    )
    type_a = _create_equipment_type(client, f"船-A-{uuid4().hex[:6]}")
    spec_a = _create_equipment_spec(client, type_a["id"], f"规格-A-{uuid4().hex[:6]}")
    order_a = _create_order(client, cust_a["id"], spec_a["id"])
    assert order_a["id"]

    # Manager B logs in and should NOT see group A's customer or order.
    client.post("/api/auth/logout")
    _login(client, manager_b["username"], "pw123")
    customers_b = client.get("/api/customers").json()
    customer_ids_b = {c["id"] for c in customers_b}
    assert cust_a["id"] not in customer_ids_b

    orders_b = client.get("/api/orders").json()
    order_ids_b = {o["id"] for o in orders_b}
    assert order_a["id"] not in order_ids_b

    catalog_b = client.get("/api/catalog").json()
    spec_ids_b = {s["id"] for s in catalog_b["equipment"]}
    assert spec_a["id"] not in spec_ids_b


def test_superuser_sees_all_groups_data(logged_in_client):
    client = logged_in_client
    group_a = _create_group(client, f"sgA-{uuid4().hex[:6]}")
    group_b = _create_group(client, f"sgB-{uuid4().hex[:6]}")

    manager_a = _create_manager(
        client, group_a["id"],
        username=f"sgA-{uuid4().hex[:6]}",
        display_name="SG A",
        password="pw123",
    )
    manager_b = _create_manager(
        client, group_b["id"],
        username=f"sgB-{uuid4().hex[:6]}",
        display_name="SG B",
        password="pw123",
    )

    # Manager A creates an equipment type.
    client.post("/api/auth/logout")
    _login(client, manager_a["username"], "pw123")
    type_a = _create_equipment_type(client, f"船A-{uuid4().hex[:6]}")

    # Manager B creates an equipment type.
    client.post("/api/auth/logout")
    _login(client, manager_b["username"], "pw123")
    type_b = _create_equipment_type(client, f"船B-{uuid4().hex[:6]}")

    # Superuser logs back in and sees both.
    client.post("/api/auth/logout")
    _login(client, "superuserx", "123456")
    catalog = client.get("/api/catalog").json()
    type_names = {t["name"] for t in catalog["equipment_types"]}
    assert type_a["name"] in type_names
    assert type_b["name"] in type_names

    groups = client.get("/api/groups").json()
    group_names = {g["name"] for g in groups}
    assert group_a["name"] in group_names
    assert group_b["name"] in group_names


def test_manager_cannot_access_other_group_order_endpoint(logged_in_client):
    """A manager in group A cannot fetch an order that belongs to group B."""
    client = logged_in_client
    group_a = _create_group(client, f"qaA-{uuid4().hex[:6]}")
    group_b = _create_group(client, f"qaB-{uuid4().hex[:6]}")

    manager_a = _create_manager(
        client, group_a["id"],
        username=f"qaA-{uuid4().hex[:6]}",
        display_name="QA A",
        password="pw123",
    )
    manager_b = _create_manager(
        client, group_b["id"],
        username=f"qaB-{uuid4().hex[:6]}",
        display_name="QA B",
        password="pw123",
    )

    # Manager B creates a customer + equipment + order in group B.
    client.post("/api/auth/logout")
    _login(client, manager_b["username"], "pw123")
    cust_b = _create_customer(
        client, name=f"custB-{uuid4().hex[:6]}", phone=f"138{uuid4().hex[:8]}"
    )
    type_b = _create_equipment_type(client, f"船B-{uuid4().hex[:6]}")
    spec_b = _create_equipment_spec(client, type_b["id"], f"规格B-{uuid4().hex[:6]}")
    order_b = _create_order(client, cust_b["id"], spec_b["id"])

    # Manager A logs in and tries to fetch group B's order → 403.
    client.post("/api/auth/logout")
    _login(client, manager_a["username"], "pw123")
    resp = client.get(f"/api/orders/{order_b['id']}")
    assert resp.status_code == 403, resp.text

    # Manager A tries to fetch group B's customer → 403.
    resp = client.get(f"/api/customers/{cust_b['id']}")
    assert resp.status_code == 403, resp.text


def test_non_superuser_cannot_access_groups_api(logged_in_client):
    """Only superuser can manage groups."""
    client = logged_in_client
    group = _create_group(client, f"perm-{uuid4().hex[:6]}")
    manager = _create_manager(
        client, group["id"],
        username=f"perm-{uuid4().hex[:6]}",
        display_name="Perm",
        password="pw123",
    )
    client.post("/api/auth/logout")
    _login(client, manager["username"], "pw123")
    # Manager cannot list/create groups.
    assert client.get("/api/groups").status_code == 403
    assert client.post("/api/groups", json={"name": "x"}).status_code == 403
