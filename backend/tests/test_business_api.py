from uuid import uuid4


def test_order_requires_at_least_one_item(logged_in_client):
    client = logged_in_client
    suffix = uuid4().hex[:10]
    customer = client.post(
        "/api/customers", json={"name": "链路测试客户", "phone": f"13{suffix}"}
    )
    assert customer.status_code == 200, customer.text
    customer_id = customer.json()["id"]

    order = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": "2026-09-27T10:00:00+08:00",
            "adult_count": 2,
            "child_count": 0,
            "items": [],
        },
    )
    # An order must contain at least one catalog item.
    assert order.status_code == 422


def test_payment_of_missing_order_is_404(logged_in_client):
    client = logged_in_client
    assert client.get("/api/orders/not-found/payment").status_code == 404


def test_protected_business_routes_require_login(client):
    assert client.get("/api/customers").status_code == 401
    assert client.get("/api/catalog").status_code == 401
    assert client.get("/api/inventory").status_code == 401
    assert client.get("/api/orders").status_code == 401
    assert client.get("/api/settings").status_code == 401
    assert client.get("/api/dashboard").status_code == 401


def test_customer_requires_name_or_wechat_nickname(logged_in_client):
    client = logged_in_client
    suffix = uuid4().hex[:10]
    # Name alone is sufficient.
    ok_name = client.post("/api/customers", json={"name": f"仅姓名{suffix}"})
    assert ok_name.status_code == 200, ok_name.text
    # Wechat nickname alone is sufficient.
    ok_nick = client.post("/api/customers", json={"wechat_nickname": f"仅昵称{suffix}"})
    assert ok_nick.status_code == 200, ok_nick.text
    # Phone / wechat_id alone are not enough.
    rejected = client.post("/api/customers", json={"phone": f"13{suffix}"})
    assert rejected.status_code == 422
    # Nothing at all is rejected.
    assert client.post("/api/customers", json={}).status_code == 422
