from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import UtcDateTime
from app.core.time_utils import utc_now


class PaymentMethod(Base):
    """每个 Group 独立维护的支付方式字典。

    约束：
    - (group_id, code) 联合唯一；code 本身不再全局唯一
    - 同一 Group 只允许一个 is_default=true（应用层保证，见 payment_method_service）
    - active=false 表示软删除；默认方式必须先切换默认才能停用/删除

    group_id 为 NULL 的行属于"全局池"，仅 superuser 可见和编辑，
    用于老订单的支付方式展示。正常 Group 用户永远只看到自己 group 的行。
    """

    __tablename__ = "payment_methods"
    __table_args__ = (
        UniqueConstraint("group_id", "code", name="uq_payment_methods_group_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("groups.id"), nullable=True, index=True
    )
    code: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, nullable=False)
    updated_at: Mapped[object] = mapped_column(UtcDateTime(), default=utc_now, onupdate=utc_now, nullable=False)
