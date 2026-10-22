"""Daily automated CSV exports for superuser.

Triggered by the scheduler at 00:00 Asia/Shanghai. Exports the previous
day's orders (00:00-24:00 Shanghai) and a full snapshot of customers as CSV
files, mirroring the format of the manual exports in ``app/api/reports.py``.

All groups' data is exported (superuser feature). Files are stored in
``AUTO_EXPORT_DIR`` and named ``auto_orders_YYYYMMDD.csv`` /
``auto_customers_YYYYMMDD.csv`` where the date is the exported (previous)
calendar day. ``run_daily_export`` is idempotent: if a file already exists it
is skipped, so scheduler retries never duplicate or overwrite work.
"""

import csv
import io
import re
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import AUTO_EXPORT_DIR
from app.core.time_utils import BUSINESS_TZ, to_shanghai, utc_now
from app.models.customer import Customer
from app.models.equipment import EquipmentSpec, SaleItem
from app.models.order import Order, OrderItem
from app.models.payment import Payment, PaymentItem
from app.models.payment_method import PaymentMethod

EXPORT_NAME_RE = re.compile(r"^auto_(orders|customers)_\d{8}\.csv$")

# 订单状态导出值（与前端列表标签一致）
_STATUS_LABEL = {
    "active": "预订",
    "in_progress": "进行中",
    "cancelled": "已取消",
    "no_show": "爽约",
    "completed": "已完成",
}


def _status_label(status: str | None) -> str:
    return _STATUS_LABEL.get(status or "", status or "")


def _time_str(value: datetime | None) -> str:
    """HH:MM:SS 24-hour format, or empty string when value is None."""
    if value is None:
        return ""
    return to_shanghai(value).strftime("%H:%M")


def _date_str(value: datetime | None) -> str:
    if value is None:
        return ""
    return to_shanghai(value).strftime("%Y-%m-%d")


def _duration_str(start: datetime | None, end: datetime | None) -> str:
    """HH:MM:SS duration between two datetimes, or empty string when either is None."""
    if start is None or end is None:
        return ""
    total_seconds = int((end - start).total_seconds())
    if total_seconds < 0:
        return ""
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    return f"{hours:02d}:{minutes:02d}"


def _orders_csv(db: Session, start_utc: datetime, end_utc: datetime) -> str:
    """Build the orders CSV for the [start_utc, end_utc) UTC window (all groups)."""
    stmt = (
        select(Order)
        .where(Order.start_at >= start_utc)
        .where(Order.start_at < end_utc)
        .order_by(Order.start_at.asc())
    )
    orders = list(db.scalars(stmt).all())

    buf = io.StringIO()
    buf.write("\ufeff")  # UTF-8 BOM so Excel decodes Chinese correctly.
    writer = csv.writer(buf)
    writer.writerow(
        [
            "订单号",
            "订单状态",
            "微信昵称",
            "订单日期",
            "订单时间",
            "创建日期",
            "创建时间",
            "散客",
            "签到时间",
            "归还时间",
            "使用时间",
            "成人",
            "儿童",
            "消费总额(元)",
            "类目排序",
            "类目名称",
            "备注",
            "数量",
            "单价(元)",
            "类目总额(元)",
            "付款方式",
        ]
    )

    # 付款方式 code→名称全局映射（code 全局唯一）；已删除的方式留空，不显示 code
    payment_names = dict(db.execute(select(PaymentMethod.code, PaymentMethod.name)).all())

    for order in orders:
        pay_name = payment_names.get(order.payment_method_code, "") if order.payment_method_code else ""
        items = list(
            db.scalars(
                select(OrderItem)
                .where(OrderItem.order_id == order.id)
                .order_by(OrderItem.created_at)
            ).all()
        )
        payment = db.scalar(select(Payment).where(Payment.order_id == order.id))
        adjustments = []
        if payment:
            adjustments = list(
                db.scalars(
                    select(PaymentItem)
                    .where(PaymentItem.payment_id == payment.id)
                    .order_by(PaymentItem.created_at)
                ).all()
            )

        items_total = sum(i.quantity * i.unit_price for i in items)
        adjustments_total = sum(a.amount for a in adjustments)
        grand_total = items_total + adjustments_total

        common = [
            order.order_number,
            _status_label(order.status),
            order.customer_wechat_nickname or "",
            _date_str(order.start_at),
            _time_str(order.start_at),
            _date_str(order.created_at),
            _time_str(order.created_at),
            "散客" if order.is_walk_in else "",
            _time_str(order.check_in_at),
            _time_str(order.return_at),
            _duration_str(order.check_in_at, order.return_at),
            str(order.adult_count),
            str(order.child_count),
            f"{grand_total / 100:.2f}",
        ]

        seq = 1
        for item in items:
            name = ""
            if item.equipment_spec_id:
                spec = db.get(EquipmentSpec, item.equipment_spec_id)
                name = spec.name if spec else ""
            elif item.sale_item_id:
                sale = db.get(SaleItem, item.sale_item_id)
                name = sale.name if sale else ""
            unit_price = item.unit_price
            qty = item.quantity
            writer.writerow(
                common
                + [
                    str(seq),
                    name,
                    "",
                    str(qty),
                    f"{unit_price / 100:.2f}",
                    f"{unit_price * qty / 100:.2f}",
                    pay_name,
                ]
            )
            seq += 1

        for adj in adjustments:
            writer.writerow(
                common
                + [
                    str(seq),
                    "其他",
                    adj.note,
                    str(adj.quantity),
                    f"{adj.unit_amount / 100:.2f}",
                    f"{adj.amount / 100:.2f}",
                    pay_name,
                ]
            )
            seq += 1

    return buf.getvalue()


def _customers_csv(db: Session) -> str:
    """Build the customers CSV (full snapshot, all groups, cumulative stats)."""
    customers = list(
        db.scalars(
            select(Customer)
            .where(Customer.is_system.is_(False))
            .order_by(Customer.created_at)
        ).all()
    )

    buf = io.StringIO()
    buf.write("\ufeff")  # UTF-8 BOM so Excel decodes Chinese correctly.
    writer = csv.writer(buf)
    writer.writerow(
        [
            "客户ID",
            "姓名",
            "性别",
            "微信昵称",
            "微信ID",
            "手机号",
            "累计消费金额(元)",
            "总订单数",
            "完成订单数",
            "爽约订单数",
        ]
    )

    for c in customers:
        orders = list(db.scalars(select(Order).where(Order.customer_id == c.id)).all())
        completed = [o for o in orders if o.status == "completed"]
        no_show_count = sum(1 for o in orders if o.status == "no_show")
        total_spending_fen = 0
        for order in completed:
            items_total = db.scalar(
                select(func.coalesce(func.sum(OrderItem.quantity * OrderItem.unit_price), 0)).where(
                    OrderItem.order_id == order.id
                )
            ) or 0
            adj_total = db.scalar(
                select(func.coalesce(func.sum(PaymentItem.amount), 0))
                .join(Payment, Payment.id == PaymentItem.payment_id)
                .where(Payment.order_id == order.id)
            ) or 0
            total_spending_fen += int(items_total) + int(adj_total)

        writer.writerow(
            [
                c.id,
                c.name or "",
                c.gender or "",
                c.wechat_nickname or "",
                c.wechat_id or "",
                c.phone or "",
                f"{total_spending_fen / 100:.2f}",
                str(len(orders)),
                str(len(completed)),
                str(no_show_count),
            ]
        )

    return buf.getvalue()


def get_auto_export_setting(db: Session):
    """Return the global (singleton) Setting row that stores the auto-export
    flags, creating it on first use. Auto-export covers all groups, so the
    flags live on a group-less singleton row instead of any group's settings."""
    from app.models.settings import DEFAULT_AUTO_RETURN_MINUTES, SETTINGS_SINGLETON_ID, Setting

    setting = db.get(Setting, SETTINGS_SINGLETON_ID)
    if setting is None:
        from app.models.user import User

        system = db.scalar(select(User).where(User.is_system.is_(True)))
        setting = Setting(
            id=SETTINGS_SINGLETON_ID,
            group_id=None,
            auto_return_after_minutes=DEFAULT_AUTO_RETURN_MINUTES,
            updated_by_user_id=system.id if system else "",
        )
        db.add(setting)
        db.flush()
    return setting


def list_auto_exports() -> list[dict]:
    """List all auto-export files sorted newest-first."""
    files = sorted(AUTO_EXPORT_DIR.glob("auto_*.csv"), reverse=True)
    result = []
    for f in files:
        stat = f.stat()
        match = EXPORT_NAME_RE.match(f.name)
        export_type = match.group(1) if match else "unknown"
        result.append(
            {
                "filename": f.name,
                "type": export_type,
                "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                "size_bytes": stat.st_size,
            }
        )
    return result


def _resolve_export_path(filename: str) -> Path:
    if not EXPORT_NAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="无效的导出文件名")
    path = (AUTO_EXPORT_DIR / filename).resolve()
    # Prevent path traversal: resolved path must stay inside AUTO_EXPORT_DIR.
    if not str(path).startswith(str(AUTO_EXPORT_DIR.resolve())):
        raise HTTPException(status_code=400, detail="无效的导出文件名")
    if not path.exists():
        raise HTTPException(status_code=404, detail="导出文件不存在")
    return path


def get_export_path(filename: str) -> Path:
    """Return the resolved path for downloading a file."""
    return _resolve_export_path(filename)


def delete_export(filename: str) -> None:
    """Delete an auto-export file."""
    path = _resolve_export_path(filename)
    path.unlink()


def run_daily_export(
    db: Session, include_orders: bool = True, include_customers: bool = True
) -> dict:
    """Export the previous Shanghai calendar day's data as CSV files.

    The window is [yesterday 00:00, today 00:00) Asia/Shanghai. Files are named
    with the previous day's date. Only the requested types are produced
    (orders CSV and/or customers CSV). Skips files that already exist
    (idempotent). Returns a dict describing what was produced.
    """
    now_sh = to_shanghai(utc_now())
    today_midnight = datetime.combine(now_sh.date(), time(0, 0), tzinfo=BUSINESS_TZ)
    yesterday_midnight = today_midnight - timedelta(days=1)
    start_utc = yesterday_midnight.astimezone(timezone.utc)
    end_utc = today_midnight.astimezone(timezone.utc)

    date_tag = yesterday_midnight.strftime("%Y%m%d")
    orders_name = f"auto_orders_{date_tag}.csv"
    customers_name = f"auto_customers_{date_tag}.csv"

    produced = []
    if include_orders:
        orders_path = AUTO_EXPORT_DIR / orders_name
        if not orders_path.exists():
            orders_path.write_text(_orders_csv(db, start_utc, end_utc), encoding="utf-8")
            produced.append(orders_name)

    if include_customers:
        customers_path = AUTO_EXPORT_DIR / customers_name
        if not customers_path.exists():
            customers_path.write_text(_customers_csv(db), encoding="utf-8")
            produced.append(customers_name)

    return {
        "date": yesterday_midnight.strftime("%Y-%m-%d"),
        "orders_file": orders_name if include_orders else None,
        "customers_file": customers_name if include_customers else None,
        "produced": produced,
    }
