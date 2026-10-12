"""Time helpers.

Hard business rules (see BUSINESS_RULES.md):

- Database stores UTC timestamps.
- Business decisions use the Asia/Shanghai calendar date.
- Check-in / Return always use the server's current time; operators cannot
  supply arbitrary timestamps.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BUSINESS_TZ = ZoneInfo("Asia/Shanghai")

ORDER_DURATION_HOURS = 2

# Daily Forced Return fixed window (second-of-day in Asia/Shanghai). Batch 2.
DAILY_FORCED_RETURN_START_SECOND = 23 * 3600 + 59 * 60 + 1  # 23:59:01
DAILY_FORCED_RETURN_END_SECOND = 23 * 3600 + 59 * 60 + 59   # 23:59:59

# Daily Auto-Export window (second-of-day in Asia/Shanghai). Runs just after
# midnight so the previous day's data is complete.
DAILY_AUTO_EXPORT_START_SECOND = 1   # 00:00:01
DAILY_AUTO_EXPORT_END_SECOND = 59    # 00:00:59


def utc_now() -> datetime:
    """Current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def to_shanghai(value: datetime) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(BUSINESS_TZ)


def business_date(value: datetime):
    """Calendar date of a datetime in the business timezone."""
    return to_shanghai(value).date()


def is_same_business_day(left: datetime, right: datetime | None = None) -> bool:
    right = right or utc_now()
    return business_date(left) == business_date(right)


def to_iso_z(value: datetime | None) -> str | None:
    """Serialize a datetime to ISO 8601 UTC with a trailing ``Z``."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
