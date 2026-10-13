from sqlalchemy import Boolean, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class PaymentMethod(Base):
    """系统可用支付方式（全局字典表，不按 Group 隔离）。

    - code 唯一且不可变（如 CASH / POS / ONLINE / OTHER_x）
    - 全表只允许一个 is_default=true（业务层保证，见 payment_method_service）
    - active=false 表示软删除；默认方式必须先切换默认才能停用/删除
    - 功能整体受环境变量 ENABLE_PAYMENT_METHOD 控制（默认关闭）

    回滚方式：删除本文件与 models/__init__.py 的导入、payment_methods API、
    init_db 中 orders.payment_method_code 增量列登记即可（旧数据不受影响）。
    """

    __tablename__ = "payment_methods"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)
