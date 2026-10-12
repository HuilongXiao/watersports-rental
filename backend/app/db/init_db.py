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


def check_database_connection() -> bool:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception:
        return False
