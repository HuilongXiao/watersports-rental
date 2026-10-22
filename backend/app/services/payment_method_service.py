"""支付方式管理业务逻辑（per-Group 隔离）。

每个 Group 独立维护自己的支付方式字典；code 在 Group 内唯一。
"""

import logging
import re

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.payment_method import PaymentMethod

logger = logging.getLogger(__name__)

_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,31}$")


def _group_scope(user_group_id: str | None) -> str | None:
    """返回有效的 group_id 过滤值。None = 不限制（superuser 看全局池）。"""
    return user_group_id


def list_methods(
    db: Session,
    active_only: bool = False,
    user_group_id: str | None = None,
) -> list[PaymentMethod]:
    """列出指定 Group 的支付方式；user_group_id=None 时返回全表（superuser 用途）。"""
    statement = select(PaymentMethod).order_by(PaymentMethod.id)
    if user_group_id is not None:
        statement = statement.where(PaymentMethod.group_id == user_group_id)
    if active_only:
        statement = statement.where(PaymentMethod.active.is_(True))
    return list(db.scalars(statement).all())


def _method_dict(m: PaymentMethod) -> dict:
    return {"id": m.id, "code": m.code, "name": m.name, "is_default": m.is_default, "active": m.active}


def _generate_code(db: Session, name: str, user_group_id: str | None = None) -> str:
    """未显式指定 code 时自动生成（Group 作用域内唯一）。"""
    ascii_part = re.sub(r"[^A-Z0-9]", "", name.upper())
    base = ascii_part if _CODE_RE.match(ascii_part or "") else "OTHER"
    candidate = base
    n = 1
    while True:
        stmt = select(PaymentMethod).where(PaymentMethod.code == candidate)
        if user_group_id is not None:
            stmt = stmt.where(PaymentMethod.group_id == user_group_id)
        else:
            stmt = stmt.where(PaymentMethod.group_id.is_(None))
        if db.scalar(stmt) is None:
            break
        n += 1
        candidate = f"OTHER_{n}"
    return candidate


def _check_group(user_group_id: str | None, row_group_id: str | None, row_label: str) -> None:
    """403 if non-superuser touches a row outside their Group."""
    if user_group_id is None:
        return
    if row_group_id != user_group_id:
        raise HTTPException(status_code=403, detail=f"无权操作其他 Group 的{row_label}")


def create_method(
    db: Session,
    operator_id: str,
    name: str,
    code: str | None = None,
    user_group_id: str | None = None,
) -> dict:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="支付方式名称不能为空")
    if code:
        code = code.strip().upper()
        if not _CODE_RE.match(code):
            raise HTTPException(
                status_code=422,
                detail="code 只能包含大写字母/数字/下划线，且以字母开头（最长 32 位）",
            )
        clash_stmt = select(PaymentMethod).where(PaymentMethod.code == code)
        if user_group_id is not None:
            clash_stmt = clash_stmt.where(PaymentMethod.group_id == user_group_id)
        else:
            clash_stmt = clash_stmt.where(PaymentMethod.group_id.is_(None))
        if db.scalar(clash_stmt) is not None:
            raise HTTPException(status_code=409, detail=f"code '{code}' 已存在于当前 Group")
    else:
        code = _generate_code(db, name, user_group_id)

    # 首个方式自动成为默认（Group 作用域内）
    is_first_stmt = select(PaymentMethod.id).where(PaymentMethod.active.is_(True))
    if user_group_id is not None:
        is_first_stmt = is_first_stmt.where(PaymentMethod.group_id == user_group_id)
    else:
        is_first_stmt = is_first_stmt.where(PaymentMethod.group_id.is_(None))
    is_first = db.scalar(is_first_stmt) is None

    method = PaymentMethod(group_id=user_group_id, code=code, name=name, is_default=is_first, active=True)
    db.add(method)
    db.commit()
    db.refresh(method)
    logger.info(
        "payment_method created operator=%s group=%s code=%s name=%s is_default=%s",
        operator_id, user_group_id, code, name, is_first,
    )
    return _method_dict(method)


def update_method(
    db: Session,
    operator_id: str,
    method_id: int,
    *,
    name: str | None = None,
    active: bool | None = None,
    is_default: bool | None = None,
    user_group_id: str | None = None,
) -> dict:
    """按 id 更新支付方式；code 路径已废弃（跨 Group 歧义）。"""
    method = db.get(PaymentMethod, method_id)
    if method is None:
        raise HTTPException(status_code=404, detail="支付方式不存在")
    _check_group(user_group_id, method.group_id, "支付方式")

    old = {"name": method.name, "active": method.active, "is_default": method.is_default}

    if name is not None:
        name = name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="支付方式名称不能为空")
        method.name = name

    if is_default is True:
        if not (active if active is not None else method.active):
            raise HTTPException(status_code=422, detail="停用中的支付方式不能设为默认")
        # 只清除同一 Group 内的其它默认
        clear_stmt = select(PaymentMethod).where(
            PaymentMethod.is_default.is_(True), PaymentMethod.id != method.id
        )
        if method.group_id is not None:
            clear_stmt = clear_stmt.where(PaymentMethod.group_id == method.group_id)
        else:
            clear_stmt = clear_stmt.where(PaymentMethod.group_id.is_(None))
        for other in db.scalars(clear_stmt).all():
            other.is_default = False
        method.is_default = True
    elif is_default is False:
        if method.is_default:
            raise HTTPException(status_code=422, detail="默认支付方式不能取消默认，请先将其它方式设为默认")

    if active is False:
        if method.is_default:
            raise HTTPException(status_code=422, detail="默认支付方式不可停用/删除，请先切换默认方式")
        method.active = False
    elif active is True:
        method.active = True

    db.commit()
    db.refresh(method)
    logger.info(
        "payment_method updated operator=%s id=%s old=%s new=%s",
        operator_id, method_id, old,
        {"name": method.name, "active": method.active, "is_default": method.is_default},
    )
    return _method_dict(method)


def delete_method(
    db: Session,
    operator_id: str,
    method_id: int,
    user_group_id: str | None = None,
) -> dict:
    """软删除（active=false）。默认方式必须先切换默认，否则 422。"""
    return update_method(
        db, operator_id, method_id, active=False, user_group_id=user_group_id,
    )


def validate_active_code(db: Session, code: str, user_group_id: str | None = None) -> bool:
    """订单写入校验：code 必须在当前 Group 存在且 active。"""
    stmt = select(PaymentMethod.id).where(
        PaymentMethod.code == code, PaymentMethod.active.is_(True)
    )
    if user_group_id is not None:
        stmt = stmt.where(PaymentMethod.group_id == user_group_id)
    else:
        stmt = stmt.where(PaymentMethod.group_id.is_(None))
    return db.scalar(stmt) is not None
