"""支付方式管理业务逻辑（受 ENABLE_PAYMENT_METHOD 开关控制，API 层负责开关检查）。

约束：
- code 唯一且创建后不可变
- 全表只允许一个 is_default=true（设置新默认时自动清除旧默认）
- 默认方式不允许停用/删除（需先切换默认）
- 删除 = 软删除（active=false），保留历史订单引用
"""

import logging
import re

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.payment_method import PaymentMethod

logger = logging.getLogger(__name__)

_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,31}$")


def list_methods(db: Session, active_only: bool = False) -> list[PaymentMethod]:
    statement = select(PaymentMethod).order_by(PaymentMethod.id)
    if active_only:
        statement = statement.where(PaymentMethod.active.is_(True))
    return list(db.scalars(statement).all())


def _method_dict(m: PaymentMethod) -> dict:
    return {"code": m.code, "name": m.name, "is_default": m.is_default, "active": m.active}


def _generate_code(db: Session, name: str) -> str:
    """未显式指定 code 时自动生成：优先取名称中的 ASCII 大写字母，否则 OTHER_<n>。"""
    ascii_part = re.sub(r"[^A-Z0-9]", "", name.upper())
    base = ascii_part if _CODE_RE.match(ascii_part or "") else "OTHER"
    candidate = base
    n = 1
    while db.scalar(select(PaymentMethod).where(PaymentMethod.code == candidate)) is not None:
        n += 1
        candidate = f"OTHER_{n}"
    return candidate


def create_method(db: Session, operator_id: str, name: str, code: str | None = None) -> dict:
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
        if db.scalar(select(PaymentMethod).where(PaymentMethod.code == code)) is not None:
            raise HTTPException(status_code=409, detail=f"code '{code}' 已存在")
    else:
        code = _generate_code(db, name)
    # 首个方式自动成为默认
    is_first = db.scalar(select(PaymentMethod.id).where(PaymentMethod.active.is_(True))) is None
    method = PaymentMethod(code=code, name=name, is_default=is_first, active=True)
    db.add(method)
    db.commit()
    db.refresh(method)
    logger.info(
        "payment_method created operator=%s code=%s name=%s is_default=%s",
        operator_id, code, name, is_first,
    )
    return _method_dict(method)


def update_method(
    db: Session,
    operator_id: str,
    code: str,
    *,
    name: str | None = None,
    active: bool | None = None,
    is_default: bool | None = None,
) -> dict:
    method = db.scalar(select(PaymentMethod).where(PaymentMethod.code == code))
    if method is None:
        raise HTTPException(status_code=404, detail="支付方式不存在")

    old = {"name": method.name, "active": method.active, "is_default": method.is_default}

    if name is not None:
        name = name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="支付方式名称不能为空")
        method.name = name

    if is_default is True:
        if not (active if active is not None else method.active):
            raise HTTPException(status_code=422, detail="停用中的支付方式不能设为默认")
        # 保证全表唯一默认：清除其它方式的默认标记
        for other in db.scalars(
            select(PaymentMethod).where(PaymentMethod.is_default.is_(True), PaymentMethod.id != method.id)
        ).all():
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
        "payment_method updated operator=%s code=%s old=%s new=%s",
        operator_id, code, old,
        {"name": method.name, "active": method.active, "is_default": method.is_default},
    )
    return _method_dict(method)


def validate_active_code(db: Session, code: str) -> bool:
    """订单写入校验：code 必须存在且 active。"""
    return (
        db.scalar(
            select(PaymentMethod.id).where(PaymentMethod.code == code, PaymentMethod.active.is_(True))
        )
        is not None
    )
