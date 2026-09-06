"""Date-only business context, independent of the server's system timezone."""
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def studio_today(timezone_name: Optional[str], *, now: Optional[datetime] = None):
    name = timezone_name or "UTC"
    try:
        zone = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        name, zone = "UTC", timezone.utc
    instant = now or datetime.now(timezone.utc)
    return instant.astimezone(zone).date(), name
