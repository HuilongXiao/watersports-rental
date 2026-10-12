"""散客标记：订单创建/编辑持久化 + 订单导出 G 列“散客”。"""

import csv
import io
from datetime import datetime

from app.core.time_utils import BUSINESS_TZ


def _now_local():
    return datetime.now(BUSINESS_TZ).replace(microsecond=0)


def _spec(client):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == 1)


def _customer(client):
    from uuid import uuid4

    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"散客测试-{suffix}", "phone": f"17{suffix}"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create(client, spec_id, customer_id, start_at, walk_in):
    response = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start_at.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "is_walk_in": walk_in,
            "items": [{"equipment_spec_id": spec_id, "quantity": 1}],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _rows(client, day):
    resp = client.get(f"/api/reports/orders/export?start={day}&end={day}")
    assert resp.status_code == 200, resp.text
    text = resp.text.lstrip("﻿")
    return list(csv.reader(io.StringIO(text)))


def test_walk_in_flag_persisted_and_defaults_false(logged_in_client):
    client = logged_in_client
    spec = _spec(client)
    customer_id = _customer(client)
    start = _now_local().replace(hour=11, minute=0)

    normal = _create(client, spec["id"], customer_id, start, False)
    assert normal["is_walk_in"] is False

    walk = _create(client, spec["id"], customer_id, start.replace(hour=12), True)
    assert walk["is_walk_in"] is True

    # 不传字段时默认 False
    resp = client.post(
        "/api/orders",
        json={
            "customer_id": customer_id,
            "start_at": start.replace(hour=13).isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_walk_in"] is False


def test_edit_order_cannot_change_walk_in_flag(logged_in_client):
    """订单创建后客户信息（含散客标记）不可修改：编辑时修改散客标记返回 409。"""
    client = logged_in_client
    spec = _spec(client)
    customer_id = _customer(client)
    start = _now_local().replace(hour=14, minute=0)
    order = _create(client, spec["id"], customer_id, start, False)

    resp = client.put(
        f"/api/orders/{order['id']}",
        json={
            "customer_id": customer_id,
            "start_at": start.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "is_walk_in": True,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    )
    assert resp.status_code == 409, resp.text

    # 保持原值（含散客标记与其他客户字段）的编辑仍可正常保存
    resp = client.put(
        f"/api/orders/{order['id']}",
        json={
            "customer_id": customer_id,
            "start_at": start.isoformat(),
            "adult_count": 1,
            "child_count": 0,
            "is_walk_in": False,
            "items": [{"equipment_spec_id": spec["id"], "quantity": 1}],
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_walk_in"] is False


def test_export_has_walk_in_column_g_with_value(logged_in_client):
    client = logged_in_client
    spec = _spec(client)
    customer_id = _customer(client)
    start = _now_local().replace(hour=15, minute=0)
    _create(client, spec["id"], customer_id, start, False)
    walk_order = _create(client, spec["id"], customer_id, start.replace(hour=16), True)

    rows = _rows(client, start.date().isoformat())
    header = rows[0]
    # B 列（索引 1）为“订单状态”，H 列（索引 7）为“散客”，原“签到时间”顺延到 I 列
    assert header[1] == "订单状态"
    assert header[7] == "散客"
    assert header[8] == "签到时间"

    by_number = {row[0]: row for row in rows[1:]}
    assert by_number[walk_order["order_number"]][7] == "散客"
    # 未勾选的订单该列为空
    normal_rows = [r for num, r in by_number.items() if num != walk_order["order_number"]]
    assert all(r[7] == "" for r in normal_rows)
