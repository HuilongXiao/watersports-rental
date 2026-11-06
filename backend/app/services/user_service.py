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


# ---- 操作员编号（operator code） -------------------------------------------------
# 编号规则：2 位，首位大写字母 A 起，第二位数字 0 起；按 group 内用户创建顺序分配
# （A0-A9 后进位到 B0…），每个 group 最多 260 个。group_id=NULL 视为独立桶。
# 超级管理员固定使用特殊编号 SU，不参与 A0-Z9 序列。
# 编号持久化在 users.operator_code，删除用户不影响其他人编号。

_OPERATOR_CODE_MAX_RANK = 259  # Z9
SUPERUSER_OPERATOR_CODE = "SU"


def format_operator_code(rank: int) -> str:
    """序号 → 编号：0→A0 … 9→A9，10→B0 … 259 Z9。"""
    return f"{chr(ord('A') + rank // 10)}{rank % 10}"


def _group_members(db: Session, group_id: str | None) -> list[User]:
    """同一编号桶（group；NULL 独立桶）内的非系统用户，按创建顺序。"""
    group_cond = User.group_id.is_(None) if group_id is None else User.group_id == group_id
    return list(
        db.scalars(
            select(User)
            .where(User.is_system.is_(False), group_cond)
            .order_by(User.created_at, User.id)
        ).all()
    )


def _code_rank(code: str | None) -> int | None:
    """A0→0 … Z9→259；非标准编号（如 SU）返回 None，不参与序号计算。"""
    if not code or len(code) != 2 or not ("A" <= code[0] <= "Z") or not code[1].isdigit():
        return None
    return (ord(code[0]) - ord("A")) * 10 + int(code[1])


def next_operator_code(db: Session, group_id: str | None) -> str | None:
    """为新建用户分配该 group 内的新编号：当前最大序号 +1（不复用已删除用户的编号）。

    特殊编号（如超级管理员的 SU）不参与序号计算。超过容量（Z9）返回 None。
    """
    ranks: list[int] = []
    for u in _group_members(db, group_id):
        rank = _code_rank(u.operator_code)
        if rank is not None:
            ranks.append(rank)
    rank = (max(ranks) + 1) if ranks else 0
    return format_operator_code(rank) if rank <= _OPERATOR_CODE_MAX_RANK else None


def allocate_operator_code(
    db: Session, group_id: str | None, role: str
) -> str | None:
    """新建用户分配编号：超级管理员在桶内优先使用固定编号 SU（未被占用时），
    其余情况（或 SU 已占用）走 A0-Z9 顺序分配。容量满返回 None。
    """
    if role == "superuser":
        su_taken = any(
            u.operator_code == SUPERUSER_OPERATOR_CODE
            for u in _group_members(db, group_id)
        )
        if not su_taken:
            return SUPERUSER_OPERATOR_CODE
    return next_operator_code(db, group_id)


def backfill_operator_codes(db: Session) -> int:
    """启动回填：给缺编号的存量非系统用户按 group+创建顺序补编号。

    超级管理员固定为 SU（含 SU 规则上线前 A0→SU 的一次性迁移）；其余已持有
    编号的用户不动（编号一经分配不可变）；桶内编号从当前最大值之后继续，避免
    与已有编号冲突。返回新分配/迁移数量。调用方负责 commit。
    """
    users = list(
        db.scalars(
            select(User)
            .where(User.is_system.is_(False))
            .order_by(User.created_at, User.id)
        ).all()
    )
    buckets: dict[str | None, list[User]] = {}
    for u in users:
        buckets.setdefault(u.group_id, []).append(u)

    assigned = 0
    for members in buckets.values():
        # 超级管理员固定编号 SU：桶内第一个 superuser 占用 SU；若其此前已被回填为
        # A0（SU 规则上线前的版本），此处做一次性迁移 A0→SU。
        su_taken = any(
            u.operator_code == SUPERUSER_OPERATOR_CODE for u in members
        )
        if not su_taken:
            for u in members:
                if u.role == "superuser":
                    if u.operator_code != SUPERUSER_OPERATOR_CODE:
                        u.operator_code = SUPERUSER_OPERATOR_CODE
                        assigned += 1
                    break

        existing = [
            rank
            for u in members
            if (rank := _code_rank(u.operator_code)) is not None
        ]
        rank = (max(existing) + 1) if existing else 0
        for u in members:
            if u.operator_code:
                continue
            if rank > _OPERATOR_CODE_MAX_RANK:
                break
            u.operator_code = format_operator_code(rank)
            assigned += 1
            rank += 1
    return assigned
