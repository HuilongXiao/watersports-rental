from sqlalchemy import text

# Importing the model package registers every mapped class on Base.metadata.
from app import models  # noqa: F401
from app.db.base import Base
from app.db.session import engine


# Lightweight additive migrations for the dev SQLite database. Each entry is
# (table, column_name, column_ddl_sql); the column is added only when missing,
# so existing databases upgrade in place without dropping data.
_ADDITIVE_COLUMNS = [
    ("users", "role", "VARCHAR(16) NOT NULL DEFAULT 'user'"),
    ("users", "perm_create_order", "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "perm_edit_order", "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "perm_export_report", "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "perm_manage_users", "BOOLEAN NOT NULL DEFAULT 0"),
    ("equipment_types", "color", "VARCHAR(16) NOT NULL DEFAULT 'blue'"),
    ("settings", "auto_export_orders_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
    ("settings", "auto_export_customers_enabled", "BOOLEAN NOT NULL DEFAULT 0"),
    ("customers", "note", "TEXT"),
    ("customers", "remind", "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "group_id", "VARCHAR(36)"),
    ("customers", "group_id", "VARCHAR(36)"),
    ("equipment_types", "group_id", "VARCHAR(36)"),
    ("equipment_specs", "group_id", "VARCHAR(36)"),
    ("sale_items", "group_id", "VARCHAR(36)"),
    ("inventory_configurations", "group_id", "VARCHAR(36)"),
    ("orders", "group_id", "VARCHAR(36)"),
    ("settings", "group_id", "VARCHAR(36)"),
    ("users", "perm_view_revenue", "BOOLEAN NOT NULL DEFAULT 0"),
    ("settings", "fast_customer_mode", "BOOLEAN NOT NULL DEFAULT 0"),
    ("equipment_specs", "sort_order", "INTEGER NOT NULL DEFAULT 0"),
    ("orders", "is_walk_in", "BOOLEAN NOT NULL DEFAULT 0"),
    ("orders", "note_popup", "BOOLEAN NOT NULL DEFAULT 0"),
    ("orders", "payment_method_code", "VARCHAR(32)"),
    ("users", "perm_manage_payment_methods", "BOOLEAN NOT NULL DEFAULT 0"),
    ("users", "operator_code", "VARCHAR(2)"),
]


def _existing_columns(bind, table: str) -> set[str]:
    rows = bind.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
    return {row[1] for row in rows} if rows else set()


def _ensure_additive_columns(bind) -> set[str]:
    added: set[str] = set()
    for table, column, ddl in _ADDITIVE_COLUMNS:
        if column in _existing_columns(bind, table):
            continue
        bind.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        added.add(f"{table}.{column}")
    return added


def _carry_over_auto_export_flags(bind, added: set[str]) -> None:
    """One-time migration: the old combined auto_export_enabled flag becomes
    the two per-type flags. Only runs when the new columns are first added and
    the old column still exists, so later explicit toggles are never overwritten."""
    if "settings.auto_export_orders_enabled" not in added:
        return
    if "auto_export_enabled" not in _existing_columns(bind, "settings"):
        return
    bind.exec_driver_sql(
        "UPDATE settings SET auto_export_orders_enabled = auto_export_enabled, "
        "auto_export_customers_enabled = auto_export_enabled"
    )


# Customer profiles only require a name OR wechat nickname; phone / wechat_id
# are optional independent fields. SQLite cannot ALTER a CHECK constraint, so
# the table is rebuilt in place (data preserved). Skipped when the table
# already carries the relaxed clause (fresh installs created by create_all
# carry it from the start).
_CUSTOMERS_REBUILD_DDL = """
CREATE TABLE customers_new (
    id VARCHAR(36) NOT NULL,
    group_id VARCHAR(36),
    name VARCHAR(128),
    gender VARCHAR(32),
    wechat_nickname VARCHAR(128),
    wechat_id VARCHAR(128),
    phone VARCHAR(32),
    is_system BOOLEAN NOT NULL,
    note TEXT,
    remind BOOLEAN NOT NULL,
    created_by_user_id VARCHAR(36) NOT NULL,
    updated_by_user_id VARCHAR(36) NOT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY(group_id) REFERENCES groups (id),
    CONSTRAINT ck_customers_identity CHECK (is_system = 1 OR name IS NOT NULL OR wechat_nickname IS NOT NULL)
)
"""

_CUSTOMERS_COPY_COLUMNS = (
    "id, group_id, name, gender, wechat_nickname, wechat_id, phone, "
    "is_system, note, remind, created_by_user_id, updated_by_user_id, "
    "created_at, updated_at"
)


def _needs_customers_rebuild(bind) -> bool:
    row = bind.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'"
    ).fetchone()
    if not row or not row[0]:
        return False
    # Rebuild if the table has the constraint but is missing the latest
    # relaxed clause (name OR wechat_nickname is sufficient).
    return (
        "ck_customers_identity" in row[0]
        and "is_system = 1 OR name IS NOT NULL OR wechat_nickname IS NOT NULL"
        not in row[0]
    )


def _rebuild_customers_table(bind) -> None:
    bind.exec_driver_sql(_CUSTOMERS_REBUILD_DDL)
    bind.exec_driver_sql(
        f"INSERT INTO customers_new ({_CUSTOMERS_COPY_COLUMNS}) "
        f"SELECT {_CUSTOMERS_COPY_COLUMNS} FROM customers"
    )
    bind.exec_driver_sql("DROP TABLE customers")
    bind.exec_driver_sql("ALTER TABLE customers_new RENAME TO customers")
    bind.exec_driver_sql("CREATE INDEX ix_customers_group_id ON customers (group_id)")
    bind.exec_driver_sql(
        "CREATE UNIQUE INDEX uq_customers_group_phone ON customers (group_id, phone)"
    )
    bind.exec_driver_sql(
        "CREATE UNIQUE INDEX uq_customers_group_wechat ON customers (group_id, wechat_id)"
    )


def _migrate_customers_unique_scope() -> None:
    """Scope customers' phone / wechat_id uniqueness to their Group.

    Different groups are different companies sharing the system, so two groups
    may each have a customer with the same phone or wechat ID. Legacy databases
    carry global unique indexes (ix_customers_phone / ix_customers_wechat_id);
    replace them with per-group unique indexes. Idempotent on every startup.
    """
    with engine.begin() as bind:
        indexes = {
            row[0]
            for row in bind.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'customers'"
            ).fetchall()
        }
        if "ix_customers_phone" in indexes:
            bind.exec_driver_sql("DROP INDEX ix_customers_phone")
        if "ix_customers_wechat_id" in indexes:
            bind.exec_driver_sql("DROP INDEX ix_customers_wechat_id")
        if "uq_customers_group_phone" not in indexes:
            bind.exec_driver_sql(
                "CREATE UNIQUE INDEX uq_customers_group_phone ON customers (group_id, phone)"
            )
        if "uq_customers_group_wechat" not in indexes:
            bind.exec_driver_sql(
                "CREATE UNIQUE INDEX uq_customers_group_wechat ON customers (group_id, wechat_id)"
            )
        # 微信昵称唯一性约束：同 group 内昵称（非空）必须唯一，防止手动
        # 创建客户时出现重复。SQLite 的 UNIQUE 对 NULL 值视为不冲突，
        # 所以 wechat_nickname 为 NULL 的客户不会互相冲突。
        #
        # 建索引前先检查是否有脏数据：如果同 group + 同昵称有多于一条，
        # 这里不会偷偷合并（避免破坏真实业务记录），而是把重复组打印出来
        # 让运维人员先处理。迁移是幂等的——索引已经存在时直接跳过。
        if "uq_customers_group_nickname" not in indexes:
            dup_rows = bind.exec_driver_sql(
                "SELECT group_id, wechat_nickname, COUNT(*) as n "
                "FROM customers WHERE wechat_nickname IS NOT NULL AND wechat_nickname != '' "
                "GROUP BY group_id, wechat_nickname HAVING n > 1"
            ).fetchall()
            if dup_rows:
                import logging
                log = logging.getLogger("app.db")
                log.warning(
                    "跳过 customers 的昵称唯一索引：检测到 %d 组同昵称客户。"
                    "请先手动合并重复数据后再部署。重复组（group_id / nickname / count）：%s",
                    len(dup_rows), [(r[0], r[1], r[2]) for r in dup_rows],
                )
            else:
                bind.exec_driver_sql(
                    "CREATE UNIQUE INDEX uq_customers_group_nickname "
                    "ON customers (group_id, wechat_nickname)"
                )


def _migrate_customers_identity_constraint() -> None:
    """Rebuild `customers` when it still carries the old CHECK constraint.

    Runs on an AUTOCOMMIT connection: PRAGMA foreign_keys is a no-op inside a
    transaction, so the rebuild uses an explicit BEGIN IMMEDIATE/COMMIT block
    on a connection where FK enforcement is off. The connection-scoped PRAGMA
    setting dies when the connection closes.
    """
    with engine.connect() as connection:
        if not _needs_customers_rebuild(connection):
            return
    with engine.connect() as connection:
        connection = connection.execution_options(isolation_level="AUTOCOMMIT")
        connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            _rebuild_customers_table(connection)
            connection.exec_driver_sql("COMMIT")
        except Exception:
            connection.exec_driver_sql("ROLLBACK")
            raise
        violations = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise RuntimeError(f"foreign key violations after customers rebuild: {violations}")


def initialize_database() -> None:
    """Create missing tables and add new columns during development startup.

    Alembic migrations should replace this for production schema upgrades.
    """
    Base.metadata.create_all(bind=engine)
    with engine.begin() as bind:
        added = _ensure_additive_columns(bind)
        _carry_over_auto_export_flags(bind, added)
    _migrate_customers_identity_constraint()
    _migrate_customers_unique_scope()
    _migrate_orders_status_constraint()
    _migrate_catalog_unique_group_scope()
    _migrate_settings_legacy_auto_export_column()
    _migrate_payment_methods_group_scope()


def _migrate_orders_status_constraint() -> None:
    """Rebuild `orders` to drop ck_orders_status ('进行中' became a status, and
    the status CHECK constraint was removed from the model), then convert
    legacy checked-in rows to the new in_progress status. Both steps are
    idempotent and safe to run on every startup."""
    from sqlalchemy.schema import CreateTable, CreateIndex

    from app.models.order import Order

    with engine.connect() as connection:
        row = connection.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orders'"
        ).fetchone()
        needs_rebuild = bool(row and row[0] and "ck_orders_status" in row[0])
    if needs_rebuild:
        with engine.connect() as connection:
            connection = connection.execution_options(isolation_level="AUTOCOMMIT")
            connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            try:
                create_ddl = str(CreateTable(Order.__table__).compile(connection))
                create_ddl = create_ddl.replace(
                    "CREATE TABLE orders", "CREATE TABLE orders_new", 1
                )
                connection.exec_driver_sql(create_ddl)
                collist = ", ".join(c.name for c in Order.__table__.columns)
                connection.exec_driver_sql(
                    f"INSERT INTO orders_new ({collist}) SELECT {collist} FROM orders"
                )
                connection.exec_driver_sql("DROP TABLE orders")
                connection.exec_driver_sql("ALTER TABLE orders_new RENAME TO orders")
                for index in Order.__table__.indexes:
                    connection.exec_driver_sql(str(CreateIndex(index).compile(connection)))
                connection.exec_driver_sql("COMMIT")
            except Exception:
                connection.exec_driver_sql("ROLLBACK")
                raise
            violations = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(f"foreign key violations after orders rebuild: {violations}")

    # Legacy rows: checked-in but not returned orders were stored as 'active'.
    with engine.begin() as bind:
        bind.exec_driver_sql(
            "UPDATE orders SET status = 'in_progress' "
            "WHERE status = 'active' AND check_in_at IS NOT NULL AND return_at IS NULL"
        )


def _migrate_catalog_unique_group_scope() -> None:
    """Add group-scoped unique indexes for catalog tables.

    Motivation: prior to this fix the uniqueness scope spanned all groups
    globally — so group A's "皮划艇" type could block group B from creating
    a type with the same name. Each group owns its own catalog; duplicates
    across groups are perfectly legitimate.

    Three indexes are added:
      - uq_equipment_types_group_name  on (group_id, name)
      - uq_sale_items_group_name        on (group_id, name)
      - uq_equipment_specs_group_type_name on (group_id, equipment_type_id, name)

    The old uq_equipment_specs_type_name (scope: equipment_type_id, name only)
    is dropped because it's now subsumed by the new, wider index.

    SQLite treats NULL as "not equal to anything" in UNIQUE, so group_id=NULL
    global rows never collide with one another — a fresh install that seeds
    both NULL-group rows will still be fine.

    Safety: if any duplicate is found within a group, the index creation is
    skipped and a WARNING is logged. The container still boots; ops get a
    concrete list of which rows to merge first.
    """
    import logging

    log = logging.getLogger("app.db")

    checks = [
        (
            "equipment_types",
            "uq_equipment_types_group_name",
            "SELECT group_id, name, COUNT(*) FROM equipment_types "
            "WHERE name IS NOT NULL AND name != '' "
            "GROUP BY group_id, name HAVING COUNT(*) > 1",
            None,  # no pre-existing index to drop
        ),
        (
            "sale_items",
            "uq_sale_items_group_name",
            "SELECT group_id, name, COUNT(*) FROM sale_items "
            "WHERE name IS NOT NULL AND name != '' "
            "GROUP BY group_id, name HAVING COUNT(*) > 1",
            None,
        ),
        (
            "equipment_specs",
            "uq_equipment_specs_group_type_name",
            "SELECT group_id, equipment_type_id, name, COUNT(*) FROM equipment_specs "
            "WHERE name IS NOT NULL AND name != '' "
            "GROUP BY group_id, equipment_type_id, name HAVING COUNT(*) > 1",
            "uq_equipment_specs_type_name",  # old constraint to drop
        ),
    ]

    with engine.begin() as bind:
        indexes = {
            row[0]
            for row in bind.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }

        for table, idx_name, dup_sql, old_idx_name in checks:
            if idx_name in indexes:
                continue

            if old_idx_name and old_idx_name in indexes:
                bind.exec_driver_sql(f"DROP INDEX {old_idx_name}")

            dup_rows = bind.exec_driver_sql(dup_sql).fetchall()
            if dup_rows:
                log.warning(
                    "跳过 %s 的唯一索引 %s：检测到 %d 组重复数据。"
                    "请先手动合并后再部署。重复组：%s",
                    table, idx_name, len(dup_rows),
                    [tuple(r) for r in dup_rows],
                )
                continue

            if table == "equipment_types":
                bind.exec_driver_sql(
                    "CREATE UNIQUE INDEX uq_equipment_types_group_name "
                    "ON equipment_types (group_id, name)"
                )
            elif table == "sale_items":
                bind.exec_driver_sql(
                    "CREATE UNIQUE INDEX uq_sale_items_group_name "
                    "ON sale_items (group_id, name)"
                )
            elif table == "equipment_specs":
                bind.exec_driver_sql(
                    "CREATE UNIQUE INDEX uq_equipment_specs_group_type_name "
                    "ON equipment_specs (group_id, equipment_type_id, name)"
                )


def _migrate_settings_legacy_auto_export_column() -> None:
    """Drop settings.auto_export_enabled 遗留列。

    v1.1.9 把 `auto_export_enabled` 拆成了 `auto_export_orders_enabled`
    + `auto_export_customers_enabled`，模型里已经删掉旧列，但数据库里
    列还在且是 NOT NULL 没有默认值。新 group 创建时 insert Setting
    会因为这个"幽灵列"而 NOT NULL constraint failed。

    直接 DROP COLUMN 一劳永逸。SQLite 3.35+ 支持。
    """
    with engine.begin() as bind:
        cols = {row[1] for row in bind.exec_driver_sql("PRAGMA table_info(settings)").fetchall()}
        if "auto_export_enabled" not in cols:
            return
        # 先把历史行补齐（防御）
        bind.exec_driver_sql(
            "UPDATE settings SET auto_export_enabled = 0"
        )
        # 彻底删除这个旧列
        bind.exec_driver_sql(
            "ALTER TABLE settings DROP COLUMN auto_export_enabled"
        )


def _migrate_payment_methods_group_scope() -> None:
    """给 payment_methods 加 group_id + 唯一索引 + 为空 Group seed 默认项。

    背景：v1.2.0 前 payment_methods 是全局字典表，所有 Group 共享 CASH/SQB。
    改为 Group 隔离后，需要：
      1. ALTER 加 group_id 列
      2. 现有全局行分配给"第一个 Group"（历史唯一活跃 Group）
      3. 删除旧的 code 全局唯一索引（uq_payment_methods_code）
      4. 建立 (group_id, code) 联合唯一索引
      5. 为没有任何支付方式的 Group 自动 seed 一条 CASH 默认项

    全幂等，safe to run on every startup。
    """
    import logging

    log = logging.getLogger("app.db")

    with engine.begin() as bind:
        cols = {
            row[1]
            for row in bind.exec_driver_sql(
                "PRAGMA table_info(payment_methods)"
            ).fetchall()
        }
        indexes = {
            row[0]
            for row in bind.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }

        # ---- 1. 加 group_id 列 ----
        if "group_id" not in cols:
            bind.exec_driver_sql(
                "ALTER TABLE payment_methods ADD COLUMN group_id VARCHAR(36) REFERENCES groups(id)"
            )

        # ---- 2. 给现有行分配 group_id ----
        # 所有 group_id IS NULL 的行 → 第一个存在的 Group
        null_groups = bind.exec_driver_sql(
            "SELECT COUNT(*) FROM payment_methods WHERE group_id IS NULL"
        ).scalar()
        if null_groups > 0:
            first_group = bind.exec_driver_sql(
                "SELECT id FROM groups ORDER BY created_at LIMIT 1"
            ).scalar()
            if first_group:
                bind.exec_driver_sql(
                    "UPDATE payment_methods SET group_id = ? WHERE group_id IS NULL",
                    (first_group,),
                )
                log.info(
                    "payment_methods: %d 条全局行已分配给 Group %s",
                    null_groups, first_group[:8],
                )

        # ---- 3. 删旧的全局唯一索引 ----
        # SQLite 自动命名约束索引为 tablename_columnname_uindex 或类似；
        # 也可能是 migration 建的自定义名。
        old_idx_candidates = [
            "uq_payment_methods_code",  # 可能的自定义名
            "ix_payment_methods_code",   # SQLAlchemy 默认建的 index（不是 unique）
        ]
        for idx in old_idx_candidates:
            if idx in indexes:
                bind.exec_driver_sql(f"DROP INDEX {idx}")
                log.info("payment_methods: 已删除旧索引 %s", idx)

        # ---- 4. 建新的 group 作用域唯一索引 ----
        new_idx = "uq_payment_methods_group_code"
        if new_idx not in indexes:
            bind.exec_driver_sql(
                "CREATE UNIQUE INDEX uq_payment_methods_group_code "
                "ON payment_methods (group_id, code)"
            )
            log.info("payment_methods: 已创建 group 作用域唯一索引")

        # ---- 5. 为没有支付方式的 Group seed CASH ----
        from app.core.time_utils import utc_now

        now = utc_now().strftime("%Y-%m-%d %H:%M:%S.%f")
        all_groups = bind.exec_driver_sql("SELECT id FROM groups").fetchall()
        for (gid,) in all_groups:
            existing = bind.exec_driver_sql(
                "SELECT COUNT(*) FROM payment_methods WHERE group_id = ?",
                (gid,),
            ).scalar()
            if existing == 0:
                bind.exec_driver_sql(
                    "INSERT INTO payment_methods "
                    "(group_id, code, name, is_default, active, created_at, updated_at) "
                    "VALUES (?, 'CASH', '现金', 1, 1, ?, ?)",
                    (gid, now, now),
                )
                log.info(
                    "payment_methods: 为 Group %s 自动 seed CASH 默认项", gid[:8]
                )


def check_database_connection() -> bool:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
