"""RBAC permission and CSV export tests."""

from datetime import timedelta
from uuid import uuid4

from app.core.time_utils import BUSINESS_TZ, utc_now


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ)


def _iso(dt):
    return dt.isoformat(timespec="seconds")


def _spec(client, capacity):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == capacity)


def _create_user(client, *, username, password="pw123", role="user", **perms):
    body = {
        "username": username,
        "display_name": username,
        "password": password,
        "role": role,
        "perm_create_order": perms.get("perm_create_order", False),
        "perm_edit_order": perms.get("perm_edit_order", False),
        "perm_export_report": perms.get("perm_export_report", False),
        "perm_manage_users": perms.get("perm_manage_users", False),
    }
    resp = client.post("/api/users", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _login(client, username, password="pw123"):
    resp = client.post("/api/auth/login", data={"username": username, "password": password})
    assert resp.status_code == 200, resp.text


def _order_payload(client, spec_id):
    suffix = uuid4().hex[:10]
    cust = client.post("/api/customers", json={"name": f"c-{suffix}", "phone": f"17{suffix}"})
    assert cust.status_code == 200, cust.text
    return {
        "customer_id": cust.json()["id"],
        "start_at": _iso(_now_local() - timedelta(minutes=5)),
        "adult_count": 1,
        "child_count": 0,
        "items": [{"equipment_spec_id": spec_id, "quantity": 1}],
    }


def test_me_returns_role_and_permissions(logged_in_client):
    me = logged_in_client.get("/api/auth/me").json()
    assert me["role"] == "superuser"
    assert me["permissions"] == {
        "create_order": True,
        "edit_order": True,
        "export_report": True,
        "manage_users": True,
        "view_revenue": True,
    }


def test_user_without_create_order_cannot_create_order(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    _create_user(client, username="staff1")  # no permissions
    _login(client, "staff1")
    resp = client.post("/api/orders", json=_order_payload(client, spec["id"]))
    assert resp.status_code == 403


def test_user_with_create_order_can_create_order(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    _create_user(client, username="staff2", perm_create_order=True)
    _login(client, "staff2")
    resp = client.post("/api/orders", json=_order_payload(client, spec["id"]))
    assert resp.status_code == 200, resp.text


def test_user_without_edit_order_cannot_edit_order(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 2)
    _create_user(client, username="staff3", perm_create_order=True)
    _login(client, "staff3")
    order_id = client.post("/api/orders", json=_order_payload(client, spec["id"])).json()["id"]
    resp = client.put(f"/api/orders/{order_id}", json=_order_payload(client, spec["id"]))
    assert resp.status_code == 403


def test_admin_cannot_modify_superuser(logged_in_client):
    client = logged_in_client
    _create_user(client, username="admin2", role="admin")
    me = client.get("/api/auth/me").json()
    _login(client, "admin2")
    resp = client.patch(f"/api/users/{me['id']}", json={"display_name": "hacked"})
    assert resp.status_code == 403


def test_cannot_edit_self(logged_in_client):
    client = logged_in_client
    me = client.get("/api/auth/me").json()
    resp = client.patch(f"/api/users/{me['id']}", json={"display_name": "self"})
    assert resp.status_code == 403


def test_disabled_user_cannot_login(logged_in_client):
    client = logged_in_client
    uid = _create_user(client, username="staff4", perm_create_order=True)
    resp = client.patch(f"/api/users/{uid}", json={"is_active": False})
    assert resp.status_code == 200
    client.post("/api/auth/logout")
    resp = client.post("/api/auth/login", data={"username": "staff4", "password": "pw123"})
    assert resp.status_code == 401


def test_export_requires_permission(logged_in_client):
    client = logged_in_client
    _create_user(client, username="staff5")  # no export permission
    _login(client, "staff5")
    today = _now_local().strftime("%Y-%m-%d")
    resp = client.get(f"/api/reports/orders/export?start={today}&end={today}")
    assert resp.status_code == 403


def test_superuser_can_export_csv(logged_in_client):
    client = logged_in_client
    today = _now_local().strftime("%Y-%m-%d")
    resp = client.get(f"/api/reports/orders/export?start={today}&end={today}")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    body = resp.text
    assert body.startswith("\ufeff")  # UTF-8 BOM
    assert "订单号" in body
    assert "使用时间" in body
    assert "消费总额(元)" in body


def test_admin_can_create_user(logged_in_client):
    client = logged_in_client
    _create_user(client, username="admin3", role="admin")
    _login(client, "admin3")
    resp = client.post(
        "/api/users",
        json={
            "username": "byadmin",
            "display_name": "byadmin",
            "password": "pw123",
            "role": "user",
        },
    )
    assert resp.status_code == 200, resp.text


def test_admin_cannot_create_admin(logged_in_client):
    client = logged_in_client
    _create_user(client, username="admin4", role="admin")
    _login(client, "admin4")
    resp = client.post(
        "/api/users",
        json={
            "username": "admin5",
            "display_name": "admin5",
            "password": "pw123",
            "role": "admin",
        },
    )
    assert resp.status_code == 403


def test_login_username_is_case_insensitive(logged_in_client):
    client = logged_in_client
    _create_user(client, username="CaseUser")
    # 全小写、全大写、带首尾空格均可登录
    _login(client, "caseuser")
    _login(client, "CASEUSER")
    resp = client.post(
        "/api/auth/login", data={"username": "  CaseUser  ", "password": "pw123"}
    )
    assert resp.status_code == 200, resp.text


def test_username_uniqueness_is_case_insensitive(logged_in_client):
    client = logged_in_client
    _create_user(client, username="DupName")
    resp = client.post(
        "/api/users",
        json={
            "username": "dupname",
            "display_name": "dup",
            "password": "pw123",
            "role": "user",
        },
    )
    assert resp.status_code == 409
