"""End-to-end smoke flow matching V1 acceptance scenarios C and G."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4


def _first_equipment(client):
    catalog = client.get("/api/catalog")
    assert catalog.status_code == 200
    equipment = catalog.json()["equipment"][0]
    return equipment


def _make_customer(client):
    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"真实链路客户-{suffix}", "phone": f"19{suffix}"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_catalog_customer_order_inventory_checkin_payment_return(logged_in_client):
    client = logged_in_client
    equipment = _first_equipment(client)
    customer_id = _make_customer(client)

    start_at = (datetime.now(timezone.utc) - timedelta(minutes=5)).replace(microsecond=0)
    order_response = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start_at.isoformat(),
            "adult_count": 2,
            "child_count": 0,
            "items": [{"equipment_spec_id": equipment["id"], "quantity": 1}],
        },
    )
    assert order_response.status_code == 200, order_response.text
    order = order_response.json()
    order_id = order["id"]
    assert order["items"][0]["unit_price"] == equipment["price"]
    # end_at is fixed at start_at + 2 hours regardless of client input.
    assert order["end_at"] is not None

    inventory_before = client.get("/api/inventory").json()
    item_before = next(
        item for item in inventory_before if item["equipment_spec_id"] == equipment["id"]
    )

    check_in = client.post(f"/api/orders/{order_id}/check-in")
    assert check_in.status_code == 200, check_in.text
    checked_in = check_in.json()
    assert checked_in["check_in_at"] is not None
    assert checked_in["items"][0]["locked"] is True
    # Auto-return duration is snapshotted from settings at check-in time.
    assert checked_in["auto_return_after_minutes"] == 120

    inventory_after = client.get("/api/inventory").json()
    item_after = next(
        item for item in inventory_after if item["equipment_spec_id"] == equipment["id"]
    )
    assert item_after["occupied_quantity"] == item_before["occupied_quantity"] + 1

    payment_before = client.get(f"/api/orders/{order_id}/payment")
    assert payment_before.status_code == 200
    assert payment_before.json()["amount_fen"] == equipment["price"]

    adjustment = client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": 1, "unit_amount": 50, "note": "smoke test adjustment"},
    )
    assert adjustment.status_code == 200, adjustment.text
    assert adjustment.json()["amount_fen"] == equipment["price"] + 50

    returned = client.post(f"/api/orders/{order_id}/return")
    assert returned.status_code == 200, returned.text
    # V1 has exactly four statuses; a return completes the order (not "returned").
    body = returned.json()
    assert body["status"] == "completed"
    # 人工归还：归还操作人不是系统；创建/最后改动带操作人姓名
    assert body["return_by_system"] is False
    assert body["return_by_user_name"]
    assert body["created_by_user_name"]
    assert body["updated_by_user_name"]

    inventory_final = client.get("/api/inventory").json()
    item_final = next(
        item for item in inventory_final if item["equipment_spec_id"] == equipment["id"]
    )
    assert item_final["occupied_quantity"] == item_before["occupied_quantity"]
