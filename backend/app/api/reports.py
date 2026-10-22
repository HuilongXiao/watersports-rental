"""CSV order export report."""

import csv
import io
from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.auth import get_active_group_id, require_permission
from app.core.time_utils import BUSINESS_TZ, to_shanghai
from app.db.session import get_db
from app.models.customer import Customer
from app.models.equipment import EquipmentSpec, SaleItem
from app.models.order import Order, OrderItem
from app.models.payment import Payment, PaymentItem
from app.models.payment_method import PaymentMethod
from app.models.user import User

router = APIRouter(prefix="/api/reports", tags=["reports"])


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
    """HH:MM duration between two datetimes, or empty string when either is None."""
    if start is None or end is None:
        return ""
    total_seconds = int((end - start).total_seconds())
    if total_seconds < 0:
        return ""
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    return f"{hours:02d}:{minutes:02d}"


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


@router.get("/orders/export")
def export_orders(
    start: str,
    end: str,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("export_report")),
    active_group_id: str | None = Depends(get_active_group_id),
):
    try:
        start_date = datetime.strptime(start, "%Y-%m-%d").date()
        end_date = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "日期格式应为 YYYY-MM-DD",
        ) from exc
    if end_date < start_date:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "结束日期不能早于开始日期",
        )

    # Range covers [start_date 00:00, end_date+1 00:00) in Asia/Shanghai.
    start_local = datetime.combine(start_date, time(0, 0), tzinfo=BUSINESS_TZ)
    end_local = datetime.combine(end_date + timedelta(days=1), time(0, 0), tzinfo=BUSINESS_TZ)
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)

    stmt = (
        select(Order)
        .where(Order.start_at >= start_utc)
        .where(Order.start_at < end_utc)
        .order_by(Order.start_at.asc())
    )
    if active_group_id is not None:
        stmt = stmt.where(Order.group_id == active_group_id)
    orders = list(db.scalars(stmt).all())

    buf = io.StringIO()
    buf.write("﻿")  # UTF-8 BOM so Excel decodes Chinese correctly.
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
        # Order items (equipment / sale items) sorted by creation order.
        items = list(
            db.scalars(
                select(OrderItem)
                .where(OrderItem.order_id == order.id)
                .order_by(OrderItem.created_at)
            ).all()
        )

        # Payment adjustments ("其他" items) for this order.
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

        # Common order-level fields (A–N columns, repeated on every row).
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

    filename = f"orders_{start}_{end}.csv"
    return Response(
        content=buf.getvalue().encode("utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/customers/export")
def export_customers(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("export_report")),
):
    """Export all customers with cumulative stats as CSV."""
    customers = list(
        db.scalars(
            select(Customer)
            .where(Customer.is_system.is_(False))
            .order_by(Customer.created_at)
        ).all()
    )

    buf = io.StringIO()
    buf.write("﻿")  # UTF-8 BOM so Excel decodes Chinese correctly.
    writer = csv.writer(buf)
    writer.writerow([
        "客户ID", "姓名", "性别", "微信昵称", "微信ID", "手机号",
        "累计消费金额(元)", "总订单数", "完成订单数", "爽约订单数",
    ])

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

        writer.writerow([
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
        ])

    filename = "customers_all.csv"
    return Response(
        content=buf.getvalue().encode("utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/customers/{customer_id}/orders/export")
def export_customer_orders(
    customer_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("export_report")),
):
    """Export a single customer's orders as CSV (same format as order export)."""
    customer = db.get(Customer, customer_id)
    if not customer:
        raise HTTPException(status_code=404, detail="客户不存在")

    orders = list(db.scalars(
        select(Order).where(Order.customer_id == customer_id).order_by(Order.start_at.asc())
    ).all())

    # Reuse the same CSV format as export_orders
    buf = io.StringIO()
    buf.write("﻿")
    writer = csv.writer(buf)
    writer.writerow([
        "订单号", "订单状态", "微信昵称", "订单日期", "订单时间", "创建日期", "创建时间",
        "散客",
        "签到时间", "归还时间", "使用时间", "成人", "儿童", "消费总额(元)",
        "类目排序", "类目名称", "备注", "数量", "单价(元)", "类目总额(元)", "付款方式",
    ])

    # 付款方式 code→名称全局映射；已删除的方式留空，不显示 code
    payment_names = dict(db.execute(select(PaymentMethod.code, PaymentMethod.name)).all())

    for order in orders:
        pay_name = payment_names.get(order.payment_method_code, "") if order.payment_method_code else ""
        items = list(db.scalars(
            select(OrderItem).where(OrderItem.order_id == order.id).order_by(OrderItem.created_at)
        ).all())
        payment = db.scalar(select(Payment).where(Payment.order_id == order.id))
        adjustments = []
        if payment:
            adjustments = list(db.scalars(
                select(PaymentItem).where(PaymentItem.payment_id == payment.id).order_by(PaymentItem.created_at)
            ).all())

        items_total = sum(i.quantity * i.unit_price for i in items)
        adjustments_total = sum(a.amount for a in adjustments)
        grand_total = items_total + adjustments_total

        common = [
            order.order_number,
            _status_label(order.status),
            order.customer_wechat_nickname or "",
            _date_str(order.start_at), _time_str(order.start_at),
            _date_str(order.created_at), _time_str(order.created_at),
            "散客" if order.is_walk_in else "",
            _time_str(order.check_in_at), _time_str(order.return_at),
            _duration_str(order.check_in_at, order.return_at),
            str(order.adult_count), str(order.child_count),
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
            writer.writerow(common + [
                str(seq), name, "", str(item.quantity),
                f"{item.unit_price / 100:.2f}", f"{item.unit_price * item.quantity / 100:.2f}",
                pay_name,
            ])
            seq += 1
        for adj in adjustments:
            writer.writerow(common + [
                str(seq), "其他", adj.note, str(adj.quantity),
                f"{adj.unit_amount / 100:.2f}", f"{adj.amount / 100:.2f}",
                pay_name,
            ])
            seq += 1

    filename = f"customer_{customer_id}_orders.csv"
    return Response(
        content=buf.getvalue().encode("utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
