"""V1 acceptance rule tests (scenarios A, B, D, G + key invariants).

Business timezone is Asia/Shanghai; all orders below are created on the
*current* business day except where past/future dates are explicitly tested.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app.core.time_utils import BUSINESS_TZ, utc_now


# ---------- helpers ----------

def _now_local():
    return utc_now().astimezone(BUSINESS_TZ)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _spec(client, capacity):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == capacity)


def _spec_null_capacity(client):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] is None)


def _customer(client):
    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"规则客户-{suffix}", "phone": f"17{suffix}"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_order(client, spec_id, *, adults=1, children=0, start_at=None,
                  quantity=1, customer_id=None, sale_item_id=None):
    payload = {
        "customer_id": customer_id or _customer(client),
        "start_at": _iso(start_at or (_now_local() - timedelta(minutes=5))),
        "adult_count": adults,
        "child_count": children,
        "items": [
            {"equipment_spec_id": spec_id, "quantity": quantity}
            if spec_id
            else {"sale_item_id": sale_item_id, "quantity": quantity}
        ],
    }
    response = client.post("/api/orders", json=payload)
    return response


def _inventory_row(client, spec_id):
    return next(
        row for row in client.get("/api/inventory").json()
        if row["equipment_spec_id"] == spec_id
    )


# ---------- scenario A: future order does not reserve inventory ----------

def test_future_order_does_not_occupy_inventory(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 3)
    before = _inventory_row(client, spec["id"])["occupied_quantity"]

    future = _now_local().replace(microsecond=0) + timedelta(days=1, hours=2)
    response = _create_order(client, spec["id"], adults=2, start_at=future)
    assert response.status_code == 200, response.text
    after = _inventory_row(client, spec["id"])["occupied_quantity"]
    assert after == before


def test_future_order_check_in_and_return_rejected(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 3)
    future = _now_local().replace(microsecond=0) + timedelta(days=1)
    order_id = _create_order(client, spec["id"], adults=2, start_at=future).json()["id"]

    assert client.post(f"/api/orders/{order_id}/check-in").status_code == 409
    assert client.post(f"/api/orders/{order_id}/return").status_code == 409


def test_past_order_check_in_and_return_rejected(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 3)
    yesterday = _now_local().replace(microsecond=0) - timedelta(days=1)
    order_id = _create_order(client, spec["id"], adults=2, start_at=yesterday).json()["id"]

    assert client.post(f"/api/orders/{order_id}/check-in").status_code == 409
    assert client.post(f"/api/orders/{order_id}/return").status_code == 409


def test_check_in_before_start_time_rejected(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 3)
    later_today = _now_local().replace(microsecond=0) + timedelta(hours=2)
    order_id = _create_order(client, spec["id"], adults=2, start_at=later_today).json()["id"]
    # Same business day, but server time is still before start_at.
    assert client.post(f"/api/orders/{order_id}/check-in").status_code == 409


# ---------- scenario B: immediate order is just an order ----------

def test_immediate_order_is_plain_active_order(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    response = _create_order(client, spec["id"], adults=2)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "active"
    assert body["order_number"].startswith("O")


# ---------- scenario D: direct return without check-in ----------

def test_direct_return_without_checkin_completes_order(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    before = _inventory_row(client, spec["id"])["occupied_quantity"]
    order_id = _create_order(client, spec["id"], adults=2).json()["id"]

    response = client.post(f"/api/orders/{order_id}/return")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["check_in_at"] is None
    assert body["return_at"] is not None
    # Direct return must not change inventory.
    after = _inventory_row(client, spec["id"])["occupied_quantity"]
    assert after == before


def test_direct_return_requires_one_minute_after_start(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    soon = _now_local().replace(microsecond=0) + timedelta(minutes=10)
    order_id = _create_order(client, spec["id"], adults=2, start_at=soon).json()["id"]
    assert client.post(f"/api/orders/{order_id}/return").status_code == 409


def test_return_after_checkin_must_be_later_than_checkin(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    order_id = _create_order(client, spec["id"], adults=2).json()["id"]
    assert client.post(f"/api/orders/{order_id}/check-in").status_code == 200
    # Server stamps check-in/return itself; the second call is strictly later.
    assert client.post(f"/api/orders/{order_id}/return").status_code == 200


# ---------- scenario E: in_progress is a formal order status ----------

def test_checkin_moves_order_to_in_progress(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    order_id = _create_order(client, spec["id"], adults=2).json()["id"]

    checked_in = client.post(f"/api/orders/{order_id}/check-in").json()
    assert checked_in["status"] == "in_progress"

    returned = client.post(f"/api/orders/{order_id}/return").json()
    assert returned["status"] == "completed"

    # Cancel return: checked-in order goes back to in_progress, not active.
    cancelled = client.post(f"/api/orders/{order_id}/cancel-return").json()
    assert cancelled["status"] == "in_progress"

    # Cancel check-in: back to 预订 (active).
    reset = client.post(f"/api/orders/{order_id}/cancel-check-in").json()
    assert reset["status"] == "active"


def test_status_filter_supports_in_progress(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    order_id = _create_order(client, spec["id"], adults=2).json()["id"]
    client.post(f"/api/orders/{order_id}/check-in")

    response = client.get("/api/orders?status=in_progress")
    assert response.status_code == 200, response.text
    assert any(o["id"] == order_id for o in response.json())


# ---------- group isolation: same-named content allowed across groups ----------

def test_same_phone_allowed_across_groups(logged_in_client):
    """Different groups are different companies: the same phone may exist in
    each group, but stays unique within one group."""
    client = logged_in_client
    g1 = client.post("/api/groups", json={"name": "甲公司"}).json()["id"]
    g2 = client.post("/api/groups", json={"name": "乙公司"}).json()["id"]

    first = client.post(
        "/api/customers",
        json={"name": "甲客户", "phone": "13900000001"},
        headers={"X-Active-Group": g1},
    )
    assert first.status_code == 200, first.text
    second = client.post(
        "/api/customers",
        json={"name": "乙客户", "phone": "13900000001"},
        headers={"X-Active-Group": g2},
    )
    assert second.status_code == 200, second.text

    duplicate = client.post(
        "/api/customers",
        json={"name": "甲客户2", "phone": "13900000001"},
        headers={"X-Active-Group": g1},
    )
    assert duplicate.status_code == 409


# ---------- fast customer mode: wechat nickname dedup ----------

def test_fast_mode_reuses_customer_by_wechat_nickname(logged_in_client):
    """In fast customer mode, orders with the same wechat nickname attach to
    the same customer profile instead of creating duplicates."""
    client = logged_in_client
    spec = _spec(client, 2)
    start = _now_local().replace(microsecond=0) + timedelta(minutes=10)

    o1 = client.post(
        "/api/orders",
        json={
            "customer_wechat_nickname": "水上漂",
            "start_at": _iso(start),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    ).json()
    o2 = client.post(
        "/api/orders",
        json={
            "customer_wechat_nickname": "水上漂",
            "start_at": _iso(start + timedelta(hours=2)),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    ).json()
    assert o1["customer_id"] == o2["customer_id"]

    customers = client.get("/api/customers").json()
    nickname_matches = [c for c in customers if c["wechat_nickname"] == "水上漂"]
    assert len(nickname_matches) == 1


def test_fast_mode_different_nickname_creates_new_customer(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    start = _now_local().replace(microsecond=0) + timedelta(minutes=10)

    o1 = client.post(
        "/api/orders",
        json={
            "customer_wechat_nickname": "张三",
            "start_at": _iso(start),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    ).json()
    o2 = client.post(
        "/api/orders",
        json={
            "customer_wechat_nickname": "李四",
            "start_at": _iso(start + timedelta(hours=2)),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    ).json()
    assert o1["customer_id"] != o2["customer_id"]


# ---------- inventory shortage warns but does not block ----------

def test_zero_inventory_warns_but_allows_checkin(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 3)
    client.put(f"/api/inventory/{spec['id']}", json={"total_quantity": 0})

    order_id = _create_order(client, spec["id"], adults=2).json()["id"]
    response = client.post(f"/api/orders/{order_id}/check-in")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["inventory_warnings"], "库存不足时应返回警告"
    assert _inventory_row(client, spec["id"])["available_quantity"] == -1


def test_inventory_cannot_be_set_below_occupied(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 3)
    order_id = _create_order(client, spec["id"], adults=2, quantity=2).json()["id"]
    client.post(f"/api/orders/{order_id}/check-in")
    assert client.put(f"/api/inventory/{spec['id']}", json={"total_quantity": 1}).status_code == 409


# ---------- capacity rules ----------

def test_capacity_rules_enforced(logged_in_client):
    client = logged_in_client

    # 3 adults on a 3-seat boat is invalid (max 2 adults).
    assert _create_order(client, _spec(client, 3)["id"], adults=3).status_code == 422
    # 0 adults invalid.
    assert _create_order(client, _spec(client, 3)["id"], adults=0, children=2).status_code == 422
    # 1 adult + 2 children on a 3-seat boat is valid.
    assert _create_order(client, _spec(client, 3)["id"], adults=1, children=2).status_code == 200
    # 2 children on a 2-seat boat is invalid (need an adult).
    assert _create_order(client, _spec(client, 2)["id"], adults=0, children=2).status_code == 422
    # Anything but exactly 1 adult on a 1-seat boat is invalid.
    assert _create_order(client, _spec(client, 1)["id"], adults=1, children=1).status_code == 422
    assert _create_order(client, _spec(client, 1)["id"], adults=1).status_code == 200


def test_multi_spec_capacity_sums_by_quantity(logged_in_client):
    """Total seats and max adults must account for each spec's quantity.

    2x 1-seat boats + 1x 2-seat boat = 4 seats, max 4 adults. 4 people total
    must be accepted (previously the quantity was dropped, giving 3 seats).
    """
    client = logged_in_client
    s1 = _spec(client, 1)["id"]
    s2 = _spec(client, 2)["id"]
    start = _now_local().replace(microsecond=0) - timedelta(minutes=5)

    payload = {
        "customer_id": _customer(client),
        "start_at": _iso(start),
        "adult_count": 4,
        "child_count": 0,
        "items": [
            {"equipment_spec_id": s1, "quantity": 2},
            {"equipment_spec_id": s2, "quantity": 1},
        ],
    }
    assert client.post("/api/orders", json=payload).status_code == 200

    # 5 people exceeds 4 seats.
    payload["adult_count"] = 5
    assert client.post("/api/orders", json=payload).status_code == 422


def test_paddleboard_has_no_extra_capacity_restriction(logged_in_client):
    client = logged_in_client
    board = _spec_null_capacity(client)
    assert _create_order(client, board["id"], adults=1, children=1).status_code == 200


# ---------- order lifecycle / locking ----------

def test_status_transitions_and_item_locking(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    order_id = _create_order(client, spec["id"], adults=2).json()["id"]

    # Items editable before check-in.
    editable = client.put(
        f"/api/orders/{order_id}",
        json={
            "customer_id": client.get(f"/api/orders/{order_id}").json()["customer_id"],
            "start_at": _iso(_now_local() - timedelta(minutes=5)),
            "adult_count": 2,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 3}],
        },
    )
    assert editable.status_code == 200, editable.text
    assert editable.json()["items"][0]["quantity"] == 3

    client.post(f"/api/orders/{order_id}/check-in")
    locked = client.put(
        f"/api/orders/{order_id}",
        json={
            "customer_id": client.get(f"/api/orders/{order_id}").json()["customer_id"],
            "start_at": _iso(_now_local() - timedelta(minutes=5)),
            "adult_count": 2,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    )
    assert locked.status_code == 409

    # Cancel check-in unlocks items.
    client.post(f"/api/orders/{order_id}/cancel-check-in")
    another_order = _create_order(client, spec["id"], adults=2).json()["id"]
    assert client.post(f"/api/orders/{another_order}/cancel").status_code == 200
    assert client.post(f"/api/orders/{another_order}/restore").status_code == 200
    assert client.post(f"/api/orders/{another_order}/no-show").status_code == 200
    assert client.post(f"/api/orders/{another_order}/restore").status_code == 200


def test_illegal_transitions_rejected(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    first = _create_order(client, spec["id"], adults=2).json()["id"]
    second = _create_order(client, spec["id"], adults=2).json()["id"]
    client.post(f"/api/orders/{first}/cancel")
    client.post(f"/api/orders/{second}/no-show")
    # cancelled/no_show cannot reach completed directly.
    assert client.post(f"/api/orders/{first}/return").status_code == 409


# ---------- payment "Other" adjustments (scenario G) ----------

def test_payment_adjustments_signs_notes_and_terminal_allowed(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    order_id = _create_order(client, spec["id"], adults=2).json()["id"]
    price = spec["price"]

    payment = client.get(f"/api/orders/{order_id}/payment").json()
    assert payment["amount_fen"] == price

    add = client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": 1, "unit_amount": 5000, "note": "附加费"},
    )
    assert add.status_code == 200
    assert add.json()["amount_fen"] == price + 5000

    # Negative quantity reduces the final amount (refund/discount).
    refund = client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": -1, "unit_amount": 3000, "note": "折扣退款"},
    )
    assert refund.status_code == 200
    assert refund.json()["amount_fen"] == price + 5000 - 3000

    # quantity 0 is invalid; note is mandatory; negative unit amount invalid.
    assert client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": 0, "unit_amount": 100, "note": "x"},
    ).status_code == 422
    assert client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": 1, "unit_amount": 100, "note": ""},
    ).status_code == 422
    assert client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": 1, "unit_amount": -1, "note": "x"},
    ).status_code == 422

    # Multiple adjustments remain immutable: list has two entries.
    assert len(refund.json()["adjustments"]) == 2

    # Adjustments are still allowed after the order is completed/cancelled.
    client.post(f"/api/orders/{order_id}/return")
    late = client.post(
        f"/api/orders/{order_id}/payment/adjustments",
        json={"quantity": 1, "unit_amount": 100, "note": "结班更正"},
    )
    assert late.status_code == 200


# ---------- customer snapshot & protections ----------

def test_order_keeps_customer_snapshot_after_profile_edit(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    customer_id = _customer(client)
    original = client.get(f"/api/customers/{customer_id}").json()
    order_id = _create_order(client, spec["id"], adults=2, customer_id=customer_id).json()["id"]

    suffix = uuid4().hex[:10]
    updated = client.put(
        f"/api/customers/{customer_id}",
        json={"name": original["name"] + "-改名", "phone": f"18{suffix}"},
    )
    assert updated.status_code == 200

    order = client.get(f"/api/orders/{order_id}").json()
    assert order["customer_name"] == original["name"]
    assert order["customer_phone"] == original["phone"]


def test_system_guest_customer_is_protected(logged_in_client):
    client = logged_in_client
    guests = [c for c in client.get("/api/customers").json() if c.get("is_system")]
    assert guests, "系统客户 游客 必须存在"
    guest = guests[0]
    response = client.put(
        f"/api/customers/{guest['id']}",
        json={"name": "游客改名", "phone": "13900000000"},
    )
    assert response.status_code == 409


# ---------- catalog deactivation ----------

def test_inactive_spec_cannot_be_added_to_new_order(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    deactivated = client.put(
        f"/api/catalog/equipment-specs/{spec['id']}", json={"is_active": False}
    )
    assert deactivated.status_code == 200
    response = _create_order(client, spec["id"], adults=1)
    assert response.status_code == 422


def test_settings_auto_return_minutes_validation(logged_in_client):
    client = logged_in_client
    assert client.put("/api/settings", json={"auto_return_after_minutes": 0}).status_code == 422
    ok = client.put("/api/settings", json={"auto_return_after_minutes": 90})
    assert ok.status_code == 200
    assert ok.json()["auto_return_after_minutes"] == 90
