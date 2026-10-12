"""用户账号领域服务：用户名规范化与不区分大小写的查询/唯一性校验。

用户名在登录、创建用户、创建 Group manager 等所有入口均不区分大小写，
统一使用 LOWER(username) 比较；存储时保留用户输入的原始大小写用于展示。
注意：SQLite 的 LOWER 仅覆盖 ASCII，本系统用户名约定使用英文/数字。
"""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.user import User


def normalize_username(value: str) -> str:
    """去除首尾空白；比较时另做 lower()，展示保留原始大小写。"""
    return (value or "").strip()


def find_by_username(db: Session, username: str) -> User | None:
    """按用户名查找用户（不区分大小写、忽略首尾空格）。"""
    return db.scalar(
        select(User).where(func.lower(User.username) == normalize_username(username).lower())
    )


def username_exists(
    db: Session, username: str, exclude_id: str | None = None
) -> bool:
    """用户名是否已被占用（不区分大小写）。编辑用户排除自身时传 exclude_id。"""
    stmt = select(User.id).where(
        func.lower(User.username) == normalize_username(username).lower()
    )
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    return db.scalar(stmt) is not None
