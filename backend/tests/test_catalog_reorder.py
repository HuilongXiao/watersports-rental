"""器材规格自定义排序（sort_order）接口测试。"""

from uuid import uuid4


def test_reorder_changes_catalog_order(logged_in_client):
    client = logged_in_client
    catalog = client.get("/api/catalog").json()
    original_ids = [s["id"] for s in catalog["equipment"]]
    assert len(original_ids) >= 2

    reversed_ids = list(reversed(original_ids))
    resp = client.post(
        "/api/catalog/equipment-specs/reorder", json={"ids": reversed_ids}
    )
    assert resp.status_code == 200, resp.text
    # 接口直接返回更新后的完整 catalog
    assert [s["id"] for s in resp.json()["equipment"]] == reversed_ids

    # 再次查询，顺序已持久化
    reloaded = client.get("/api/catalog").json()
    assert [s["id"] for s in reloaded["equipment"]] == reversed_ids
    assert [s["sort_order"] for s in reloaded["equipment"]] == list(
        range(len(reversed_ids))
    )


def test_reorder_rejects_empty_list(logged_in_client):
    client = logged_in_client
    resp = client.post("/api/catalog/equipment-specs/reorder", json={"ids": []})
    assert resp.status_code == 422


def test_reorder_rejects_duplicate_ids(logged_in_client):
    client = logged_in_client
    ids = [s["id"] for s in client.get("/api/catalog").json()["equipment"]]
    duplicated = ids + [ids[0]]
    resp = client.post(
        "/api/catalog/equipment-specs/reorder", json={"ids": duplicated}
    )
    assert resp.status_code == 422


def test_reorder_rejects_unknown_id(logged_in_client):
    client = logged_in_client
    ids = [s["id"] for s in client.get("/api/catalog").json()["equipment"]]
    resp = client.post(
        "/api/catalog/equipment-specs/reorder", json={"ids": ids + [str(uuid4())]}
    )
    assert resp.status_code == 404


def test_new_spec_is_appended_to_sort_order(logged_in_client):
    client = logged_in_client
    catalog = client.get("/api/catalog").json()
    type_id = catalog["equipment_types"][0]["id"]

    # 先给存量规格确定一个明确顺序
    original_ids = [s["id"] for s in catalog["equipment"]]
    client.post(
        "/api/catalog/equipment-specs/reorder", json={"ids": original_ids}
    )

    create = client.post(
        "/api/catalog/equipment-specs",
        json={
            "equipment_type_id": type_id,
            "name": f"新规格{uuid4().hex[:8]}",
            "price": 9000,
            "capacity": 2,
        },
    )
    assert create.status_code == 200, create.text
    new_catalog = create.json()
    new_spec = new_catalog["equipment"][-1]
    assert new_spec["sort_order"] == len(original_ids)
