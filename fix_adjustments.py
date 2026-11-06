"""
NAS 订单调整项清理脚本
订单号：O20261018010313E3A8
目标：保留最早的一条 -300 元退款调整项，删除其余 5 条（3 条重复 -300、1 条 +300、1 条 +600）

使用方法（在 NAS 宿主机执行）：
  docker cp fix_adjustments.py watersports-rental-backend-1:/tmp/fix_adjustments.py
  docker exec watersports-rental-backend-1 python /tmp/fix_adjustments.py
"""
import sqlite3

ORDER_NUMBER = "O20261018010313E3A8"
DB_PATH = "/app/data/rental_app.db"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# 1. 找订单
cur.execute("SELECT id, order_number FROM orders WHERE order_number=?", (ORDER_NUMBER,))
order = cur.fetchone()
if order is None:
    print(f"[ERROR] 未找到订单 {ORDER_NUMBER}")
    conn.close()
    exit(1)
order_id = order["id"]
print(f"[OK] 订单: {ORDER_NUMBER} (id={order_id})")

# 2. 找 payment
cur.execute("SELECT id FROM payments WHERE order_id=?", (order_id,))
payment = cur.fetchone()
if payment is None:
    print("[ERROR] 该订单没有支付记录")
    conn.close()
    exit(1)
payment_id = payment["id"]
print(f"[OK] payment_id={payment_id}")

# 3. 列出当前所有调整项
cur.execute(
    "SELECT id, quantity, unit_amount, amount, note, created_at, created_by_user_id "
    "FROM payment_items WHERE payment_id=? ORDER BY created_at",
    (payment_id,),
)
items = cur.fetchall()
print(f"\n=== 清理前：共 {len(items)} 条调整项 ===")
for it in items:
    sign = "+" if it["amount"] > 0 else ""
    print(
        f"  {it['id']}  qty={it['quantity']}  unit={it['unit_amount']}  "
        f"amt={sign}{it['amount']}  note={it['note']!r}  "
        f"created={it['created_at']}"
    )

# 4. 找出要保留的那条：最早的负金额（退款）调整项
keep = None
for it in items:
    if it["amount"] < 0:
        if keep is None or it["created_at"] < keep["created_at"]:
            keep = it
if keep is None:
    print("\n[ERROR] 没有找到负金额（退款）调整项，无法决定保留哪条，已中止")
    conn.close()
    exit(1)

print(f"\n[保留] {keep['id']}  amt={keep['amount']}  note={keep['note']!r}  created={keep['created_at']}")

# 5. 删除其余所有调整项
delete_ids = [it["id"] for it in items if it["id"] != keep["id"]]
print(f"\n[删除] 共 {len(delete_ids)} 条:")
for it in items:
    if it["id"] != keep["id"]:
        print(f"  - {it['id']}  amt={it['amount']}  note={it['note']!r}")

cur.execute(
    f"DELETE FROM payment_items WHERE payment_id=? AND id NOT IN ({','.join('?' * len(delete_ids))})",
    [payment_id, *delete_ids],
)
deleted = cur.rowcount
conn.commit()
print(f"\n[OK] 已删除 {deleted} 条调整项")

# 6. 列出清理后的结果
cur.execute(
    "SELECT id, quantity, unit_amount, amount, note, created_at "
    "FROM payment_items WHERE payment_id=? ORDER BY created_at",
    (payment_id,),
)
remaining = cur.fetchall()
print(f"\n=== 清理后：共 {len(remaining)} 条调整项 ===")
for it in remaining:
    sign = "+" if it["amount"] > 0 else ""
    print(f"  {it['id']}  amt={sign}{it['amount']}  note={it['note']!r}  created={it['created_at']}")

conn.close()
print("\n完成。")
