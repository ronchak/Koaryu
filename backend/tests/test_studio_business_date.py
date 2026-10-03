from datetime import datetime, timezone
import pytest

from app.services.studio_business_date import studio_today, studio_today_for_studio
from tests.fakes.supabase import TableBackedSupabase


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


def test_scoped_studio_date_uses_one_tenant_filtered_lookup_and_local_day():
    supabase = TableBackedSupabase(
        {
            "studios": [
                {"id": "studio-1", "timezone": "America/Los_Angeles"},
                {"id": "studio-2", "timezone": "Asia/Tokyo"},
            ]
        }
    )

    day = studio_today_for_studio(
        supabase,
        "studio-1",
        now=datetime(2026, 9, 20, 2, tzinfo=timezone.utc),
    )

    assert day.isoformat() == "2026-09-19"
    assert len(supabase.log) == 1
    assert supabase.log[0]["filters"] == (("eq", "id", "studio-1"),)


def test_scoped_studio_date_fails_when_studio_context_is_missing():
    with pytest.raises(RuntimeError, match="timezone could not be loaded"):
        studio_today_for_studio(TableBackedSupabase({"studios": []}), "missing")
