"""下单前库存冲突预检 POST /api/orders/conflicts 测试。"""

from datetime import timedelta

from app.core.time_utils import BUSINESS_TZ, utc_now
from app.db.session import SessionLocal
from app.models.order import Order


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ).replace(microsecond=0)


def _tomorrow_base():
    """明天 00:00 作为基准日期，确保 buffer 不被 buffer_cutoff 隐藏。"""
    return (_now_local() + timedelta(days=1)).replace(hour=0, minute=0, second=0)


def _spec(client, capacity):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == capacity)


def _customer(client):
    from uuid import uuid4

    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"冲突客户-{suffix}", "phone": f"17{suffix}"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _set_total(client, spec_id, total):
    assert client.put(f"/api/inventory/{spec_id}", json={"total_quantity": total}).status_code == 200


def _create_order(client, spec_id, customer_id, start_at, quantity=1):
    response = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start_at.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec_id, "quantity": quantity}],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _check_conflicts(client, spec_id, start_at, quantity=1, exclude_order_id=None):
    body = {
        "start_at": start_at.isoformat(),
        "adult_count": 1,
        "child_count": 0,
        "items": [{"equipment_spec_id": spec_id, "quantity": quantity}],
    }
    query = f"?exclude_order_id={exclude_order_id}" if exclude_order_id else ""
    resp = client.post(f"/api/orders/conflicts{query}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["conflicts"]


def test_no_conflict_when_stock_sufficient(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)  # 种子库存 5
    customer_id = _customer(client)
    base = _tomorrow_base()
    _create_order(client, spec["id"], customer_id, base.replace(hour=10))

    conflicts = _check_conflicts(client, spec["id"], base.replace(hour=10))
    assert conflicts == []


def test_overlapping_reservation_reports_conflict_range(logged_in_client):
    # 库存 2；已有 2 条 10:00 预订（窗口 08:30–12:00）；再订 1 条 10:00 → 缺 1 条
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    customer_id = _customer(client)
    base = _tomorrow_base()
    _create_order(client, spec["id"], customer_id, base.replace(hour=10), quantity=2)

    conflicts = _check_conflicts(client, spec["id"], base.replace(hour=10))
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c["equipment_spec_id"] == spec["id"]
    assert c["equipment_spec_name"] == "竞速皮划艇-1人座"
    assert c["total_quantity"] == 2
    assert c["requested_quantity"] == 1
    assert c["shortage"] == 1
    assert c["max_existing"] == 2
    assert c["max_occupied"] == 3
    assert c["ranges"] == [
        {"start": "08:30", "end": "12:00", "existing": 2, "occupied": 3, "shortage": 1}
    ]


def test_occupied_counts_existing_plus_requested(logged_in_client):
    # 库存 1、已有 2 条、本单 1 条：占用必须是 2+1=3（不是 existing+shortage=4）
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 1)
    customer_id = _customer(client)
    base = _tomorrow_base()
    _create_order(client, spec["id"], customer_id, base.replace(hour=10), quantity=2)

    conflicts = _check_conflicts(client, spec["id"], base.replace(hour=10))
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c["max_existing"] == 2
    assert c["max_occupied"] == 3
    assert c["shortage"] == 2
    assert c["ranges"][0]["existing"] == 2
    assert c["ranges"][0]["occupied"] == 3
    assert c["ranges"][0]["shortage"] == 2


def test_disjoint_windows_have_no_conflict(logged_in_client):
    # 已有 10:00 预订窗口到 12:00；新单 14:00（窗口从 12:30 开始），半开区间不重叠
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    customer_id = _customer(client)
    base = _tomorrow_base()
    _create_order(client, spec["id"], customer_id, base.replace(hour=10), quantity=2)

    assert _check_conflicts(client, spec["id"], base.replace(hour=14)) == []


def test_exclude_order_id_ignores_order_itself(logged_in_client):
    # 编辑订单预检：排除自身后不应报告冲突
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    customer_id = _customer(client)
    base = _tomorrow_base()
    order_id = _create_order(
        client, spec["id"], customer_id, base.replace(hour=10), quantity=2
    )

    assert (
        _check_conflicts(
            client, spec["id"], base.replace(hour=10), quantity=2, exclude_order_id=order_id
        )
        == []
    )
    # 不排除自身时则预警
    conflicts = _check_conflicts(client, spec["id"], base.replace(hour=10), quantity=2)
    assert len(conflicts) == 1
    assert conflicts[0]["shortage"] == 2


def test_in_progress_order_blocks_from_checkin(logged_in_client):
    # 进行中订单：签到 10:00 占用 10:00–12:00；新单 10:00 在该时段冲突
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    customer_id = _customer(client)
    base = _tomorrow_base()
    order_id = _create_order(client, spec["id"], customer_id, base.replace(hour=10), quantity=2)
    client.post(f"/api/orders/{order_id}/check-in")
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {"status": "in_progress", "check_in_at": base.replace(hour=10, minute=0)}
        )
        db.commit()
    finally:
        db.close()

    conflicts = _check_conflicts(client, spec["id"], base.replace(hour=10))
    assert len(conflicts) == 1
    # 新单窗口 08:30–12:00 与签到占用 10:00–12:00 相交
    assert conflicts[0]["ranges"] == [
        {"start": "10:00", "end": "12:00", "existing": 2, "occupied": 3, "shortage": 1}
    ]


def test_reservation_overlapped_by_usage_no_conflict(logged_in_client):
    # 配对去重：库存 2；已有 13:00 预订 2 条（使用至 15:00）。
    # 新单 15:00 订 1 条：预留 [13:30,15:00) 被已有订单的使用覆盖配对
    # → 13:30–15:00 占用 2（= 库存），无冲突
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    customer_id = _customer(client)
    base = _tomorrow_base()
    _create_order(client, spec["id"], customer_id, base.replace(hour=13), quantity=2)

    assert _check_conflicts(client, spec["id"], base.replace(hour=15)) == []


def test_reservation_overlapped_by_usage_conflict_partial(logged_in_client):
    # 配对去重：库存 1；已有 13:30 预订 1 条（使用 13:30–15:30）。
    # 新单 15:00 订 1 条：预留 [13:30,15:00)。已有使用结束 15:30 > 新单开始
    # 15:00 → 不满足「船能及时归还」条件，不可配对：
    # 13:30–15:00 已有使用 + 新单预留 = 2；15:00–15:30 新单使用与已有使用
    # 重叠 = 2。两段占用均 > 库存 1 → 冲突
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 1)
    customer_id = _customer(client)
    base = _tomorrow_base()
    _create_order(client, spec["id"], customer_id, base.replace(hour=13, minute=30), quantity=1)

    conflicts = _check_conflicts(client, spec["id"], base.replace(hour=15))
    assert len(conflicts) == 1
    c = conflicts[0]
    assert c["shortage"] == 1
    # 相邻槽数值相同（existing 1 / occupied 2 / shortage 1）合并为一个时段
    assert c["ranges"] == [
        {"start": "13:30", "end": "15:30", "existing": 1, "occupied": 2, "shortage": 1}
    ]


def test_sale_items_never_conflict(logged_in_client):
    client = logged_in_client
    sale = client.get("/api/catalog").json()["sale_items"][0]
    base = _tomorrow_base().replace(hour=10)
    resp = client.post(
        "/api/orders/conflicts",
        json={
            "start_at": base.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"sale_item_id": sale["id"], "quantity": 99}],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["conflicts"] == []
