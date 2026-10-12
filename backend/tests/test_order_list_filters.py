"""订单列表 business_day_from（业务日期下限）筛选测试。"""

from datetime import timedelta
from uuid import uuid4

from app.core.time_utils import BUSINESS_TZ, utc_now


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ).replace(microsecond=0)


def _spec(client, capacity):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == capacity)


def _customer(client):
    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"列表筛选客户-{suffix}", "phone": f"17{suffix}"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_order(client, spec_id, customer_id, start_at):
    response = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start_at.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec_id, "quantity": 1}],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_business_day_from_keeps_only_future_orders(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    customer_id = _customer(client)
    base = _now_local().replace(hour=10, minute=0, second=0)
    today_id = _create_order(client, spec["id"], customer_id, base)
    tomorrow_id = _create_order(client, spec["id"], customer_id, base + timedelta(days=1))
    tomorrow_str = (base.date() + timedelta(days=1)).strftime("%Y-%m-%d")

    resp = client.get(f"/api/orders?status=active&business_day_from={tomorrow_str}")
    assert resp.status_code == 200, resp.text
    ids = {o["id"] for o in resp.json()}
    assert tomorrow_id in ids
    assert today_id not in ids
