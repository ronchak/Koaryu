from datetime import datetime, timezone
from app.services.studio_business_date import studio_today


def test_studio_date_uses_configured_zone_and_handles_dst():
    instant = datetime(2026, 9, 6, 2, tzinfo=timezone.utc)
    day, name = studio_today("America/Los_Angeles", now=instant)
    assert day.isoformat() == "2026-09-05"
    assert name == "America/Los_Angeles"
    assert studio_today("Asia/Tokyo", now=instant)[0].isoformat() == "2026-09-06"
    for hour in (9, 10):
        assert (
            studio_today(
                "America/Los_Angeles", now=datetime(2026, 3, 8, hour, tzinfo=timezone.utc)
            )[0].isoformat()
            == "2026-03-08"
        )
    assert studio_today("invalid", now=instant)[1] == "UTC"
