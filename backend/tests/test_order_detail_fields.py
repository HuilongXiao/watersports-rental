"""订单详情字段测试：散客标记、使用时长数据、系统自动归还标注。"""

from datetime import timedelta
from uuid import uuid4

from app.core.time_utils import BUSINESS_TZ, utc_now
from app.db.session import SessionLocal
from app.models.order import Order
from app.services import order_service


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ).replace(microsecond=0)


def _spec(client, capacity):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == capacity)


def _customer(client):
    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"详情字段客户-{suffix}", "phone": f"17{suffix}"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_order(client, spec_id, customer_id, start_at, *, is_walk_in=False):
    response = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start_at.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "is_walk_in": is_walk_in,
            "items": [{"equipment_spec_id": spec_id, "quantity": 1}],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_walk_in_flag_returned_in_order_detail(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    customer_id = _customer(client)
    order = _create_order(
        client, spec["id"], customer_id, _now_local(), is_walk_in=True
    )
    assert order["is_walk_in"] is True
    fetched = client.get(f"/api/orders/{order['id']}").json()
    assert fetched["is_walk_in"] is True


def test_system_auto_return_marked_as_system(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    customer_id = _customer(client)
    # 开始时间取“现在”，保证签到在允许窗口内
    order = _create_order(client, spec["id"], customer_id, _now_local())
    order_id = order["id"]
    check_in = client.post(f"/api/orders/{order_id}/check-in")
    assert check_in.status_code == 200, check_in.text

    # 将签到时间回拨到 3 小时前，使 2 小时自动归还时限已过
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {"check_in_at": utc_now() - timedelta(hours=3)}
        )
        db.commit()
    finally:
        db.close()

    db = SessionLocal()
    try:
        returned = order_service.auto_return_overdue_orders(db)
    finally:
        db.close()
    assert any(o.id == order_id for o in returned)

    detail = client.get(f"/api/orders/{order_id}").json()
    assert detail["status"] == "completed"
    assert detail["return_at"] is not None
    assert detail["auto_return_occurred"] is True
    # 自动归还由系统用户执行 → 前端据此显示“系统”
    assert detail["return_by_system"] is True
