"""API response serializers (dict shapes shared by routers)."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time_utils import to_iso_z
from app.models.customer import Customer
from app.models.equipment import EquipmentSpec, EquipmentType, SaleItem
from app.models.order import Order, OrderItem
from app.models.payment import Payment, PaymentItem
from app.models.user import User


def customer_dict(customer: Customer) -> dict:
    return {
        "id": customer.id,
        "group_id": customer.group_id,
        "name": customer.name,
        "gender": customer.gender,
        "wechat_nickname": customer.wechat_nickname,
        "wechat_id": customer.wechat_id,
        "phone": customer.phone,
        "is_system": customer.is_system,
        "note": customer.note,
        "remind": customer.remind,
        "created_at": to_iso_z(customer.created_at),
        "updated_at": to_iso_z(customer.updated_at),
    }


def user_dict(user: User) -> dict:
    return {
        "id": user.id,
        "group_id": user.group_id,
        "username": user.username,
        "display_name": user.display_name,
        "operator_code": user.operator_code,
        "role": user.role,
        "is_active": user.is_active,
        "is_system": user.is_system,
        "perm_create_order": user.perm_create_order,
        "perm_edit_order": user.perm_edit_order,
        "perm_export_report": user.perm_export_report,
        "perm_manage_users": user.perm_manage_users,
        "perm_view_revenue": user.perm_view_revenue,
        "perm_manage_payment_methods": user.perm_manage_payment_methods,
        "created_at": to_iso_z(user.created_at),
    }


def _user_name_map(
    db: Session, user_ids: set[str | None]
) -> tuple[dict[str, str], set[str], dict[str, str | None]]:
    """返回 (用户ID→显示名, 系统用户ID集合, 用户ID→操作员编号)。"""
    ids = {uid for uid in user_ids if uid}
    if not ids:
        return {}, set(), {}
    users = db.scalars(select(User).where(User.id.in_(ids))).all()
    return (
        {u.id: u.display_name for u in users},
        {u.id for u in users if u.is_system},
        {u.id: u.operator_code for u in users},
    )


def _catalog_names(db: Session, items: list[OrderItem]) -> tuple[dict, dict, dict]:
    spec_ids = {i.equipment_spec_id for i in items if i.equipment_spec_id}
    sale_ids = {i.sale_item_id for i in items if i.sale_item_id}
    spec_rows = (
        db.scalars(select(EquipmentSpec).where(EquipmentSpec.id.in_(spec_ids))).all()
        if spec_ids
        else []
    )
    spec_names = {s.id: s.name for s in spec_rows}
    type_ids = {s.equipment_type_id for s in spec_rows}
    type_colors = {
        t.id: t.color
        for t in db.scalars(
            select(EquipmentType).where(EquipmentType.id.in_(type_ids))
        ).all()
    } if type_ids else {}
    spec_colors = {s.id: type_colors.get(s.equipment_type_id) for s in spec_rows}
    sale_names = {
        s.id: s.name
        for s in db.scalars(select(SaleItem).where(SaleItem.id.in_(sale_ids))).all()
    } if sale_ids else {}
    return spec_names, sale_names, spec_colors


def order_item_dict(
    item: OrderItem, spec_names: dict, sale_names: dict, spec_colors: dict, locked: bool
) -> dict:
    return {
        "id": item.id,
        "equipment_spec_id": item.equipment_spec_id,
        "equipment_spec_name": spec_names.get(item.equipment_spec_id) if item.equipment_spec_id else None,
        "equipment_type_color": spec_colors.get(item.equipment_spec_id) if item.equipment_spec_id else None,
        "sale_item_id": item.sale_item_id,
        "sale_item_name": sale_names.get(item.sale_item_id) if item.sale_item_id else None,
        "quantity": item.quantity,
        "unit_price": item.unit_price,
        "line_amount": item.quantity * item.unit_price,
        "locked": locked,
    }


def _order_payload(
    order: Order,
    items: list[OrderItem],
    spec_names: dict,
    sale_names: dict,
    spec_colors: dict,
    names: dict,
    system_ids: set,
    codes: dict,
    adjustments_total: int,
    refund_total: int,
    check_in_warnings: list[dict] | None = None,
) -> dict:
    """由已预取的关联数据组装订单响应体（不做任何 DB 查询）。

    单条路径见 ``order_dict``，批量路径见 ``orders_dict``，两者共用本函数以保证
    输出结构完全一致。
    """
    locked = order.check_in_at is not None
    auto_return_due_at = None
    if order.check_in_at is not None and order.auto_return_after_minutes and order.return_at is None:
        from datetime import timedelta
        auto_return_due_at = to_iso_z(
            order.check_in_at + timedelta(minutes=order.auto_return_after_minutes)
        )
    items_total = sum(i.quantity * i.unit_price for i in items)
    return {
        "id": order.id,
        "order_number": order.order_number,
        "status": order.status,
        "customer_id": order.customer_id,
        "customer_name": order.customer_name,
        "customer_gender": order.customer_gender,
        "customer_wechat_nickname": order.customer_wechat_nickname,
        "customer_wechat_id": order.customer_wechat_id,
        "customer_phone": order.customer_phone,
        "start_at": to_iso_z(order.start_at),
        "end_at": to_iso_z(order.end_at),
        "adult_count": order.adult_count,
        "child_count": order.child_count,
        "note": order.note,
        "is_walk_in": order.is_walk_in,
        "note_popup": order.note_popup,
        "payment_method_code": order.payment_method_code,
        "items": [
            order_item_dict(i, spec_names, sale_names, spec_colors, locked) for i in items
        ],
        "items_total_fen": items_total,
        "refund_amount_fen": refund_total,
        "total_amount_fen": items_total + adjustments_total,
        "editable": order.status == "active" and order.check_in_at is None,
        "checked_in": order.check_in_at is not None,
        "returned": order.return_at is not None,
        "check_in_at": to_iso_z(order.check_in_at),
        "check_in_by_user_id": order.check_in_by_user_id,
        "check_in_by_user_name": names.get(order.check_in_by_user_id),
        "check_in_by_user_code": codes.get(order.check_in_by_user_id),
        "auto_return_after_minutes": order.auto_return_after_minutes,
        "auto_return_due_at": auto_return_due_at,
        "auto_return_at": to_iso_z(order.auto_return_at),
        "auto_return_occurred": order.auto_return_occurred,
        "return_at": to_iso_z(order.return_at),
        "return_by_user_id": order.return_by_user_id,
        "return_by_user_name": names.get(order.return_by_user_id),
        "return_by_user_code": codes.get(order.return_by_user_id),
        # 归还操作人是系统用户（2 小时自动归还 / 23:59 强制归还）时为 True
        "return_by_system": order.return_by_user_id in system_ids,
        "daily_forced_return_occurred": order.daily_forced_return_occurred,
        "created_by_user_id": order.created_by_user_id,
        "created_by_user_name": names.get(order.created_by_user_id),
        "created_by_user_code": codes.get(order.created_by_user_id),
        "created_at": to_iso_z(order.created_at),
        "updated_by_user_id": order.updated_by_user_id,
        "updated_by_user_name": names.get(order.updated_by_user_id),
        "updated_by_user_code": codes.get(order.updated_by_user_id),
        "updated_at": to_iso_z(order.updated_at),
        "inventory_warnings": check_in_warnings or [],
    }


def order_dict(db: Session, order: Order, items: list[OrderItem] | None = None,
               check_in_warnings: list[dict] | None = None) -> dict:
    """单条订单序列化（详情/创建/编辑等路径使用）。"""
    items = items if items is not None else list(
        db.scalars(
            select(OrderItem).where(OrderItem.order_id == order.id).order_by(OrderItem.created_at)
        ).all()
    )
    spec_names, sale_names, spec_colors = _catalog_names(db, items)
    names, system_ids, codes = _user_name_map(
        db,
        {
            order.created_by_user_id,
            order.updated_by_user_id,
            order.check_in_by_user_id,
            order.return_by_user_id,
        },
    )
    # 支付调整项总额（含正项“其他”和负项退款）
    adjustments_total = int(
        db.scalar(
            select(func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.id == PaymentItem.payment_id)
            .where(Payment.order_id == order.id)
        )
        or 0
    )
    # 退款金额：该订单所有负金额调整项之和（无支付记录或无退款时为 0）
    refund_total = int(
        db.scalar(
            select(func.coalesce(func.sum(PaymentItem.amount), 0))
            .join(Payment, Payment.id == PaymentItem.payment_id)
            .where(Payment.order_id == order.id, PaymentItem.amount < 0)
        )
        or 0
    )
    return _order_payload(
        order, items, spec_names, sale_names, spec_colors,
        names, system_ids, codes, adjustments_total, refund_total, check_in_warnings,
    )


def orders_dict(db: Session, orders: list[Order]) -> list[dict]:
    """批量序列化订单列表：以固定数量的查询替代逐单 N+1。

    原先每条订单要单独查询 订单项/船型/售卖项/用户/调整项合计/退款合计（约 6–7 次），
    订单量一大就会出现数秒级耗时。这里按订单 id 一次性预取并分组，输出与
    ``order_dict`` 完全一致。
    """
    if not orders:
        return []
    order_ids = [o.id for o in orders]
    # 1) 订单项一次性取回，按订单 id 分组
    items_by_order: dict[str, list[OrderItem]] = {}
    all_items = list(
        db.scalars(
            select(OrderItem)
            .where(OrderItem.order_id.in_(order_ids))
            .order_by(OrderItem.created_at)
        ).all()
    )
    for it in all_items:
        items_by_order.setdefault(it.order_id, []).append(it)
    # 2) 目录名称/颜色：全部订单项合并一次查询
    spec_names, sale_names, spec_colors = _catalog_names(db, all_items)
    # 3) 操作用户：全部订单涉及的用户合并一次查询
    user_ids: set[str | None] = set()
    for o in orders:
        user_ids.update(
            (
                o.created_by_user_id,
                o.updated_by_user_id,
                o.check_in_by_user_id,
                o.return_by_user_id,
            )
        )
    names, system_ids, codes = _user_name_map(db, user_ids)
    # 4) 调整项合计 / 退款合计：按订单分组聚合，各一次查询
    adjustments: dict[str, int] = {}
    refunds: dict[str, int] = {}
    for oid, total in db.execute(
        select(Payment.order_id, func.coalesce(func.sum(PaymentItem.amount), 0))
        .join(PaymentItem, PaymentItem.payment_id == Payment.id)
        .where(Payment.order_id.in_(order_ids))
        .group_by(Payment.order_id)
    ).all():
        adjustments[oid] = int(total)
    for oid, total in db.execute(
        select(Payment.order_id, func.coalesce(func.sum(PaymentItem.amount), 0))
        .join(PaymentItem, PaymentItem.payment_id == Payment.id)
        .where(Payment.order_id.in_(order_ids), PaymentItem.amount < 0)
        .group_by(Payment.order_id)
    ).all():
        refunds[oid] = int(total)
    return [
        _order_payload(
            o,
            items_by_order.get(o.id, []),
            spec_names, sale_names, spec_colors,
            names, system_ids, codes,
            adjustments.get(o.id, 0), refunds.get(o.id, 0),
        )
        for o in orders
    ]
