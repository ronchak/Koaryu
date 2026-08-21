import asyncio
from datetime import date

import pytest

from app.services.dashboard_summary_cache import (
    DashboardSummaryCacheKey,
    DashboardSummaryFactCache,
    DashboardSummaryFactInvalidated,
)


def make_key(**changes):
    values = {
        "studio_id": "studio-1",
        "visibility": "billing_visible",
        "timezone": "UTC",
        "local_date": date(2026, 5, 20),
        "formula_version": "dashboard-summary-v1",
    }
    values.update(changes)
    return DashboardSummaryCacheKey(**values)


def run(coroutine):
    return asyncio.run(coroutine)


def test_ttl_uses_injected_monotonic_clock_and_exact_boundary_is_expired():
    now = [100.0]
    calls = 0
    cache = DashboardSummaryFactCache(ttl_seconds=15, clock=lambda: now[0])

    async def load():
        nonlocal calls
        calls += 1
        return {"call": calls}

    assert run(cache.get_or_load(make_key(), load)) == {"call": 1}
    now[0] = 114.999
    assert run(cache.get_or_load(make_key(), load)) == {"call": 1}
    now[0] = 115.0
    assert run(cache.get_or_load(make_key(), load)) == {"call": 2}
    assert calls == 2


def test_max_entry_eviction_is_bounded_and_deterministic_lru():
    cache = DashboardSummaryFactCache(max_entries=2)
    calls = []

    async def load_for(label):
        calls.append(label)
        return {"label": label}

    async def exercise():
        await cache.get_or_load(make_key(local_date=date(2026, 5, 20)), lambda: load_for("a"))
        await cache.get_or_load(make_key(local_date=date(2026, 5, 21)), lambda: load_for("b"))
        await cache.get_or_load(make_key(local_date=date(2026, 5, 20)), lambda: load_for("a-hit"))
        await cache.get_or_load(make_key(local_date=date(2026, 5, 22)), lambda: load_for("c"))
        return await cache.get_or_load(make_key(local_date=date(2026, 5, 21)), lambda: load_for("b-reload"))

    assert run(exercise()) == {"label": "b-reload"}
    assert calls == ["a", "b", "c", "b-reload"]


def test_keys_never_share_across_studio_visibility_timezone_date_or_formula():
    cache = DashboardSummaryFactCache()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        return {"call": calls}

    variants = [
        make_key(),
        make_key(studio_id="studio-2"),
        make_key(visibility="billing_hidden"),
        make_key(timezone="America/Los_Angeles"),
        make_key(local_date=date(2026, 5, 21)),
        make_key(formula_version="dashboard-summary-v2"),
    ]

    async def exercise():
        return [await cache.get_or_load(item, load) for item in variants]

    values = run(exercise())
    assert [value["call"] for value in values] == [1, 2, 3, 4, 5, 6]


def test_errors_and_provider_timeout_are_not_cached_or_left_inflight():
    cache = DashboardSummaryFactCache()
    calls = 0

    async def fail_once():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("provider timeout")
        return {"ok": True}

    async def exercise():
        with pytest.raises(TimeoutError):
            await cache.get_or_load(make_key(), fail_once)
        assert cache._inflight == {}
        assert await cache.get_or_load(make_key(), fail_once) == {"ok": True}

    run(exercise())
    assert calls == 2


def test_follower_cancellation_does_not_cancel_shared_loader():
    cache = DashboardSummaryFactCache()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return {"ok": True}

    async def exercise():
        leader = asyncio.create_task(cache.get_or_load(make_key(), load))
        await started.wait()
        follower = asyncio.create_task(cache.get_or_load(make_key(), load))
        await asyncio.sleep(0)
        follower.cancel()
        with pytest.raises(asyncio.CancelledError):
            await follower
        release.set()
        assert await leader == {"ok": True}
        assert await cache.get_or_load(make_key(), load) == {"ok": True}

    run(exercise())
    assert calls == 1


def test_leader_cancellation_keeps_shared_flight_for_followers_and_cleans_up():
    cache = DashboardSummaryFactCache()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return {"value": calls}

    async def exercise():
        leader = asyncio.create_task(cache.get_or_load(make_key(), load))
        await started.wait()
        follower = asyncio.create_task(cache.get_or_load(make_key(), load))
        await asyncio.sleep(0)
        leader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await leader
        release.set()
        assert await follower == {"value": 1}
        assert cache._inflight == {}

    run(exercise())
    assert calls == 1


def test_invalidation_during_flight_rejects_old_value_and_reloads_once():
    cache = DashboardSummaryFactCache()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            await release.wait()
            return {"version": "stale"}
        return {"version": "fresh"}

    async def exercise():
        request = asyncio.create_task(cache.get_or_load(make_key(), load))
        await started.wait()
        cache.invalidate("studio-1", ladder_id="ladder-1", domain="dashboard")
        release.set()
        assert await request == {"version": "fresh"}
        assert cache.generation("studio-1") == 1
        assert cache._inflight == {}

    run(exercise())
    assert calls == 2


def test_typed_reserved_domains_do_not_mutate_dashboard_owner_yet():
    cache = DashboardSummaryFactCache()
    cache.invalidate("studio-1", ladder_id="ladder-1", domain="roster")
    cache.invalidate("studio-1", ladder_id="ladder-1", domain="eligibility")
    assert cache.generation("studio-1") == 0

    with pytest.raises(ValueError):
        cache.invalidate("studio-1", domain="unknown")
