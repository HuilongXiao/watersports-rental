"""Inventory forecast blocking-window tests (active: buffer -90min + usage +2h; in_progress snap; completed actual usage)."""

from datetime import timedelta

from app.core.time_utils import BUSINESS_TZ, utc_now
from app.db.session import SessionLocal
from app.models.equipment import EquipmentSpec
from app.models.order import Order


def _now_local():
    return utc_now().astimezone(BUSINESS_TZ).replace(microsecond=0)


def _spec(client, capacity):
    equipment = client.get("/api/catalog").json()["equipment"]
    return next(item for item in equipment if item["capacity"] == capacity)


def _customer(client):
    from uuid import uuid4

    suffix = uuid4().hex[:10]
    response = client.post(
        "/api/customers",
        json={"name": f"预测客户-{suffix}", "phone": f"17{suffix}"},
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


def _forecast(client, day):
    resp = client.get(f"/api/dashboard/inventory-forecast?date={day}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _row(forecast, spec_id):
    return next(e for e in forecast["equipment"] if e["spec_id"] == spec_id)


def test_active_order_blocks_buffer_and_usage_window(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    customer_id = _customer(client)
    today = _now_local().replace(hour=10, minute=0, second=0)
    _create_order(client, spec["id"], customer_id, today)

    f = _forecast(client, today.date().isoformat())
    row = _row(f, spec["id"])
    # 当日仅此订单（10:00 开始、12:00 结束）→ 区间 10:00–12:00 共 5 格
    assert len(row["occupied"]) == 5
    # 10:00 开始的窗口 = 预留 [08:30,10:00) + 使用 [10:00,12:00)，
    # 显示区间首格即 10:00（预留在区间外）→ 前 4 格被使用占用
    assert row["occupied"][0:4] == [1] * 4
    assert row["available"][0:4] == [1] * 4
    assert row["occupied"][4] == 0
    assert row["available"][4] == 2


def test_overlapping_reservations_show_shortage(logged_in_client):
    # Scenario from the operator: stock 2; A reserves 1 at 10:00, B reserves 2
    # at 9:00 → at the 10:00 slot 3 boats are needed → available -1.
    # 用明天的日期：buffer（预留）只在槽结束时间 > 当前时间时才显示，
    # 今日/过去的槽会被 cutoff 隐藏，导致断言依赖运行时刻
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    a = _customer(client)
    b = _customer(client)
    base = (_now_local() + timedelta(days=1)).replace(hour=0, minute=0, second=0)
    _create_order(client, spec["id"], a, base.replace(hour=10), quantity=1)
    _create_order(client, spec["id"], b, base.replace(hour=9), quantity=2)

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 最早订单 09:00、最晚结束 12:00 → 区间 09:00–12:00 共 7 格
    # idx0=09:00 … idx6=12:00
    # A(10:00) 预留 [08:30,10:00) + 使用 [10:00,12:00)；
    # B(09:00) 预留 [07:30,09:00) + 使用 [09:00,11:00)
    # 09:00–10:30（idx 0–3）：A+B=3，库存 2 → available -1
    assert row["occupied"][0] == 3
    assert row["available"][0] == -1
    assert row["occupied"][2] == 3
    assert row["available"][2] == -1
    # 11:00（idx 4）：B 的使用已结束，仅 A → 1
    assert row["occupied"][4] == 1
    assert row["available"][4] == 1
    # 12:00（idx 6）：A 的使用也结束 → 0
    assert row["occupied"][6] == 0


def test_in_progress_checkin_snapping_first_half(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    # Start "now" so check-in is always inside the allowed window, then pin the
    # timestamps deterministically in the database.
    order_id = _create_order(client, spec["id"], customer_id, base)
    client.post(f"/api/orders/{order_id}/check-in")
    ci = base.replace(hour=14, minute=14)
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {
                "check_in_at": ci,
                "start_at": base.replace(hour=15, minute=0),
                "end_at": base.replace(hour=18, minute=0),
            }
        )
        db.commit()
    finally:
        db.close()

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 订单开始 15:00、结束 18:00 → 区间 15:00–18:00 共 7 格
    assert len(row["occupied"]) == 7
    # 14:14 签到（前半小时前半段）占 14:00 起 4 格，其中 14:00/14:30 在显示区间之前被裁剪
    assert row["occupied"][0:2] == [1, 1]
    assert row["occupied"][2] == 0


def test_in_progress_checkin_snapping_second_half(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    order_id = _create_order(client, spec["id"], customer_id, base)
    client.post(f"/api/orders/{order_id}/check-in")
    ci = base.replace(hour=14, minute=16)
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {
                "check_in_at": ci,
                "start_at": base.replace(hour=15, minute=0),
                "end_at": base.replace(hour=18, minute=0),
            }
        )
        db.commit()
    finally:
        db.close()

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    assert len(row["occupied"]) == 7
    # 14:16 签到（前半小时后半段）占 14:00 起 5 格，其中 14:00/14:30 在显示区间之前被裁剪
    assert row["occupied"][0:3] == [1, 1, 1]
    assert row["occupied"][3] == 0


def test_on_grid_start_with_seconds_blocks_exactly_eight_slots(logged_in_client):
    # 回归：14:00 开始的预订必须恰好占用 12:00–15:30 共 8 格，
    # 即使 start_at 带了秒数，16:00–16:30 那格也不能被占用。
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 3)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    start = base.replace(hour=14, minute=0, second=30)  # 故意带 30 秒
    _create_order(client, spec["id"], customer_id, start)

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 订单 14:00:30 开始、16:00:30 结束 → 区间 14:00–16:00 共 5 格
    assert len(row["occupied"]) == 5
    # 窗口 [12:00, 16:00)：14:00–15:30 共 4 格被占用，16:00 格不受影响
    assert row["occupied"][0:4] == [1] * 4
    assert row["occupied"][4] == 0
    assert row["available"][4] == 3


def test_off_grid_start_extends_to_overlapped_slots(logged_in_client):
    # 14:15 开始（非整格）：窗口 [12:15, 16:15) 按重叠向前/向后顺延，
    # 占用 12:00–16:00 共 9 格。
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 3)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    _create_order(client, spec["id"], customer_id, base.replace(hour=14, minute=15))

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 14:15 开始、16:15 结束 → 区间 14:00–16:00 共 5 格
    assert len(row["occupied"]) == 5
    assert row["occupied"][0:5] == [1] * 5


def test_completed_without_checkin_marks_order_start_to_end(logged_in_client):
    # 未签到直接归还的已完成订单：标注范围为订单开始→结束时间
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    order_id = _create_order(client, spec["id"], customer_id, base)
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {
                "status": "completed",
                "check_in_at": None,
                "return_at": base.replace(hour=13, minute=50),
                "start_at": base.replace(hour=12, minute=0),
                "end_at": base.replace(hour=14, minute=0),
            }
        )
        db.commit()
    finally:
        db.close()

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 订单 12:00–14:00 → 区间 12:00–14:00 共 5 格；占用 12:00–13:30 共 4 格
    assert len(row["occupied"]) == 5
    assert row["occupied"][0:4] == [1] * 4
    assert row["occupied"][4] == 0


def test_completed_with_checkin_marks_actual_usage_rounded_up(logged_in_client):
    # 有签到：签到 12:10、归还 13:11 → 实际使用 1 小时 1 分 → 向上取整
    # 为 1.5 小时，占 3 行（12:00 / 12:30 / 13:00）
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    order_id = _create_order(client, spec["id"], customer_id, base)
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {
                "status": "completed",
                "check_in_at": base.replace(hour=12, minute=10),
                "return_at": base.replace(hour=13, minute=11),
                "start_at": base.replace(hour=12, minute=0),
                "end_at": base.replace(hour=14, minute=0),
            }
        )
        db.commit()
    finally:
        db.close()

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    assert len(row["occupied"]) == 5
    assert row["occupied"][0:3] == [1] * 3
    assert row["occupied"][3] == 0


def test_completed_with_recheckin_uses_latest_checkin_time(logged_in_client):
    # 重新签到：以最新签到时间为准计算实际使用时长
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    customer_id = _customer(client)
    base = _now_local().replace(second=0)
    order_id = _create_order(client, spec["id"], customer_id, base)
    db = SessionLocal()
    try:
        db.query(Order).filter_by(id=order_id).update(
            {
                "status": "completed",
                # 最初签到 12:00，重新签到改为 13:00，归还 13:40 → 使用 40 分 → 占 2 行
                "check_in_at": base.replace(hour=13, minute=0),
                "return_at": base.replace(hour=13, minute=40),
                "start_at": base.replace(hour=12, minute=0),
                "end_at": base.replace(hour=14, minute=0),
            }
        )
        db.commit()
    finally:
        db.close()

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 13:00 签到、使用 40 分 → 占 13:00 / 13:30 两行
    assert row["occupied"][0:2] == [0, 0]
    assert row["occupied"][2:4] == [1, 1]
    assert row["occupied"][4] == 0


def test_inactive_spec_hidden_from_forecast(logged_in_client):
    client = logged_in_client
    spec = _spec(client, 1)
    today = _now_local().date().isoformat()
    assert any(e["spec_id"] == spec["id"] for e in _forecast(client, today)["equipment"])

    db = SessionLocal()
    try:
        db.query(EquipmentSpec).filter_by(id=spec["id"]).update({"is_active": False})
        db.commit()
    finally:
        db.close()

    assert all(e["spec_id"] != spec["id"] for e in _forecast(client, today)["equipment"])


def test_usage_overlapping_reservation_counts_one_boat(logged_in_client):
    # 库存 2；乙 13:00 预订 2 条（使用 13:00–15:00），甲 15:00 预订 1 条。
    # 乙的使用结束 15:00 ≤ 甲的开始 15:00，其中 1 条船先被乙使用、归还后服务甲。
    # → 13:00–15:00 时段占用 2 而非 3；甲的预留 [13:30,15:00) 被乙的使用覆盖配对。
    # 用明天的日期保证 buffer 可见（今日过去的槽会隐藏预留，配对逻辑无法验证）
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    a = _customer(client)
    b = _customer(client)
    base = (_now_local() + timedelta(days=1)).replace(hour=0, minute=0, second=0)
    _create_order(client, spec["id"], b, base.replace(hour=13), quantity=2)
    _create_order(client, spec["id"], a, base.replace(hour=15), quantity=1)

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 最早订单 13:00 → idx0=13:00；最晚结束 17:00（甲 start 15:00 + 2h）→ 共 9 格
    # 13:00–15:00（idx 0–3）：乙使用 2 + 甲预留 1 - 配对 1 = 2
    assert row["occupied"][0:4] == [2, 2, 2, 2]
    assert row["available"][0:4] == [0, 0, 0, 0]
    # 15:00–17:00（idx 4–7）：甲使用 1
    assert row["occupied"][4:8] == [1, 1, 1, 1]
    assert row["occupied"][8] == 0


def test_usage_fully_inside_reservation_counts_one_boat(logged_in_client):
    # 使用时间 13:30–15:30（active 订单 13:30 开始，使用至 15:30），
    # 另一订单 16:00 开始 → 预留时间 [14:30,16:00)。
    # 使用结束 15:30 ≤ 16:00，可配对 → 重叠的 14:30–15:30 只计 1 条；
    # 15:30–16:00 仅剩预留 1 条；13:30–14:00 仅使用 1 条。全程占用不超过 1。
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 2)
    a = _customer(client)
    b = _customer(client)
    base = (_now_local() + timedelta(days=1)).replace(hour=0, minute=0, second=0)
    _create_order(client, spec["id"], a, base.replace(hour=13, minute=30), quantity=1)
    _create_order(client, spec["id"], b, base.replace(hour=16), quantity=1)

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 最早订单 13:30 → idx0=13:30；最晚结束 18:00 → 共 10 格（13:30…17:30）
    # idx0=13:30 ~ idx1=14:00 仅使用 1；idx2=14:30 ~ idx3=15:00 重叠 → 1；
    # idx4=15:30 仅预留 1；idx5=16:00 ~ idx8=17:30 乙使用 1；idx9=18:00 → 0
    assert row["occupied"][0] == 1
    assert row["occupied"][1:4] == [1, 1, 1]
    assert row["occupied"][4] == 1
    assert row["occupied"][5:9] == [1, 1, 1, 1]
    assert row["occupied"][9] == 0


def test_past_slots_hide_buffer_occupancy(logged_in_client):
    # 用户规则：当前时间 10:15 时，09:30–10:00、09:00–09:30 及更早的时间条
    # 不再显示 buffer（预订预留）占用，只显示 usage（使用）占用。
    # 用「昨天」的订单保证全部槽位都在过去，结果与运行时刻无关。
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    a = _customer(client)
    b = _customer(client)
    base = (_now_local() - timedelta(days=1)).replace(hour=0, minute=0, second=0)
    # A 10:00 订 1 条（预留 08:30–10:00），B 09:00 订 2 条（使用 09:00–11:00）
    _create_order(client, spec["id"], a, base.replace(hour=10), quantity=1)
    _create_order(client, spec["id"], b, base.replace(hour=9), quantity=2)

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # 区间 09:00–12:00 共 7 格（idx0=09:00）
    # 昨天所有槽均已过去 → buffer 全隐藏：
    # idx0=09:00 仅 B 使用 2（若 buffer 可见应为 B 使用 2 + A 预留 1 = 3）
    assert row["occupied"][0] == 2
    # idx2=10:00 ~ idx3=10:30：A 使用 1 + B 使用 2 = 3（usage 始终显示）
    assert row["occupied"][2] == 3
    assert row["occupied"][3] == 3
    # idx4=11:00：仅 A 使用 1
    assert row["occupied"][4] == 1


def test_future_slots_keep_buffer_occupancy(logged_in_client):
    # 对照组：同样的订单放在「明天」，全部槽位都在未来，
    # buffer 正常显示（与 test_past_slots_hide_buffer_occupancy 互为镜像）。
    client = logged_in_client
    spec = _spec(client, 1)
    _set_total(client, spec["id"], 5)
    a = _customer(client)
    b = _customer(client)
    base = (_now_local() + timedelta(days=1)).replace(hour=0, minute=0, second=0)
    _create_order(client, spec["id"], a, base.replace(hour=10), quantity=1)
    _create_order(client, spec["id"], b, base.replace(hour=9), quantity=2)

    f = _forecast(client, base.date().isoformat())
    row = _row(f, spec["id"])
    # idx0=09:00：B 使用 2 + A 预留 1 = 3（buffer 可见）
    assert row["occupied"][0] == 3
    # idx2=10:00 ~ idx3=10:30：A 使用 1 + B 使用 2 = 3
    assert row["occupied"][2] == 3
    assert row["occupied"][4] == 1
