"""删除订单 / 删除客户 profile 的权限与级联测试（仅 superuser）。"""

from datetime import timedelta
from uuid import uuid4

from app.core.time_utils import BUSINESS_TZ, utc_now


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _spec_id(client):
    equipment = client.get("/api/catalog").json()["equipment"]
    return equipment[0]["id"]


def _create_customer(client):
    suffix = uuid4().hex[:10]
    resp = client.post(
        "/api/customers", json={"name": f"待删客户{suffix}", "phone": f"13{suffix}"}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _create_order(client):
    customer_id = _create_customer(client)
    resp = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": _iso(_now_local() + timedelta(hours=1)),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": _spec_id(client), "quantity": 1}],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"], customer_id


def _login(client, username, password="pw123"):
    resp = client.post(
        "/api/auth/login", data={"username": username, "password": password}
    )
    assert resp.status_code == 200, resp.text


def _switch_user(client, username, role="user"):
    body = {
        "username": username,
        "display_name": username,
        "password": "pw123",
        "role": role,
    }
    assert client.post("/api/users", json=body).status_code == 200
    _login(client, username)


def test_superuser_can_delete_order_and_customer(logged_in_client):
    client = logged_in_client
    order_id, customer_id = _create_order(client)

    # 有关联订单时客户不可删除
    resp = client.delete(f"/api/customers/{customer_id}")
    assert resp.status_code == 409

    # 删除订单后再 GET 为 404（订单项目/支付记录级联清除）
    resp = client.delete(f"/api/orders/{order_id}")
    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/orders/{order_id}").status_code == 404

    # 订单删除后客户可删除
    resp = client.delete(f"/api/customers/{customer_id}")
    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/customers/{customer_id}").status_code == 404


def test_customer_without_orders_can_be_deleted(logged_in_client):
    client = logged_in_client
    customer_id = _create_customer(client)
    resp = client.delete(f"/api/customers/{customer_id}")
    assert resp.status_code == 200, resp.text
    assert client.get(f"/api/customers/{customer_id}").status_code == 404


def test_system_customer_cannot_be_deleted(logged_in_client):
    client = logged_in_client
    customers = client.get("/api/customers").json()
    system_id = next(c["id"] for c in customers if c.get("is_system"))
    resp = client.delete(f"/api/customers/{system_id}")
    assert resp.status_code == 409


def test_admin_cannot_delete_order_or_customer(logged_in_client):
    client = logged_in_client
    order_id, customer_id = _create_order(client)
    _switch_user(client, "del-admin-x", role="admin")

    assert client.delete(f"/api/orders/{order_id}").status_code == 403
    assert client.delete(f"/api/customers/{customer_id}").status_code == 403
    # 数据仍然存在
    assert client.get(f"/api/orders/{order_id}").status_code == 200
    assert client.get(f"/api/customers/{customer_id}").status_code == 200


def test_plain_user_cannot_delete_order_or_customer(logged_in_client):
    client = logged_in_client
    order_id, customer_id = _create_order(client)
    _switch_user(client, "del-user-x", role="user")

    assert client.delete(f"/api/orders/{order_id}").status_code == 403
    assert client.delete(f"/api/customers/{customer_id}").status_code == 403


def test_delete_missing_order_returns_404(logged_in_client):
    client = logged_in_client
    assert client.delete(f"/api/orders/{uuid4()}").status_code == 404
