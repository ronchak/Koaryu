"""Application composition with controlled owners; no database or provider access."""

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from starlette.requests import Request
from test_automation_batch import batch_summary

from app import main
from app.api.v1.endpoints import automations
from app.core.config import Settings
from app.schemas.automation import MissedClassProcessRequest
from app.schemas.automation_batch import AutomationBatchResponse
from app.services.automation_scheduler import AutomationScheduler


def fake_provider(monkeypatch, calls):
    class Provider:
        def __init__(self, *args):
            calls.append(("provider_created", threading.get_ident()))

        def shutdown(self):
            calls.append(("provider_stopped", threading.get_ident()))

    monkeypatch.setattr(main, "SupabaseProviderRuntime", Provider)


def test_disabled_lifespan_creates_no_scheduler_client_timer_or_thread(monkeypatch):
    assert Settings.model_fields["AUTOMATION_WORKER_ENABLED"].default is False
    calls = []
    fake_provider(monkeypatch, calls)
    monkeypatch.setattr(main, "settings", SimpleNamespace(AUTOMATION_WORKER_ENABLED=False))
    constructor = Mock(side_effect=AssertionError("disabled scheduler construction"))
    monkeypatch.setattr(main, "AutomationScheduler", constructor)

    async def scenario():
        app = SimpleNamespace(state=SimpleNamespace())
        async with main._lifespan(app):
            assert app.state.automation_scheduler is None

    asyncio.run(scenario())
    constructor.assert_not_called()
    assert [name for name, _ in calls] == ["provider_created", "provider_stopped"]


@pytest.mark.parametrize("failure", [None, "construct", "start", "body", "stop"])
def test_lifespan_stops_admission_before_provider_cleanup_even_on_failure(monkeypatch, failure):
    calls = []
    fake_provider(monkeypatch, calls)
    monkeypatch.setattr(main, "settings", SimpleNamespace(AUTOMATION_WORKER_ENABLED=True))

    class Scheduler:
        def __init__(self, settings):
            calls.append(("constructed", threading.get_ident()))
            if failure == "construct":
                raise RuntimeError("construct")

        async def start(self):
            calls.append(("start", threading.get_ident()))
            if failure == "start":
                raise RuntimeError("start")

        async def stop(self):
            calls.append(("stop", threading.get_ident()))
            if failure == "stop":
                raise RuntimeError("stop")

    monkeypatch.setattr(main, "AutomationScheduler", Scheduler)
    loop_thread = threading.get_ident()

    async def scenario():
        app = SimpleNamespace(state=SimpleNamespace())
        async with main._lifespan(app):
            assert isinstance(app.state.automation_scheduler, Scheduler)
            if failure == "body":
                raise RuntimeError("body")

    if failure:
        with pytest.raises(RuntimeError, match=failure):
            asyncio.run(scenario())
    else:
        asyncio.run(scenario())
    expected = ["provider_created", "constructed"]
    if failure != "construct":
        expected += ["start", "stop"]
    assert [name for name, _ in calls] == expected + ["provider_stopped"]
    assert all(thread == loop_thread for _, thread in calls[:-1])
    assert calls[-1][1] != loop_thread


def test_lifespan_timer_and_route_share_real_admission_and_owner_cleanup(monkeypatch):
    calls = []
    fake_provider(monkeypatch, calls)
    settings = SimpleNamespace(AUTOMATION_WORKER_ENABLED=True, AUTOMATION_WORKER_SECRET="worker")
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(automations, "get_settings", lambda: settings)
    entered = threading.Event()
    release = threading.Event()
    owners = []
    closes = []
    sleeps = asyncio.Queue()

    def process(settings, **kwargs):
        owners.append((threading.get_ident(), kwargs))
        entered.set()
        try:
            assert release.wait(2), "owner was not released"
            return AutomationBatchResponse.model_validate(batch_summary())
        finally:
            closes.append(threading.get_ident())

    async def sleep(seconds):
        sleeps.put_nowait(seconds)
        await asyncio.Future()

    factory = Mock(
        side_effect=lambda settings: AutomationScheduler(
            settings, batch_processor=process, sleep=sleep
        )
    )
    monkeypatch.setattr(main, "AutomationScheduler", factory)
    monkeypatch.setattr(
        automations, "run_in_threadpool", Mock(side_effect=AssertionError("extra pool"))
    )
    monkeypatch.setattr(
        automations, "run_supabase_operation", Mock(side_effect=AssertionError("provider lane"))
    )

    async def scenario():
        app = SimpleNamespace(state=SimpleNamespace())
        request = Request({"type": "http", "app": app})
        try:
            async with main._lifespan(app):
                scheduler = app.state.automation_scheduler
                assert await asyncio.to_thread(entered.wait, 1)
                with pytest.raises(HTTPException) as busy:
                    await automations.process_due_automations(
                        request, MissedClassProcessRequest(), "worker"
                    )
                assert busy.value.status_code == 409
                assert busy.value.headers == {"Retry-After": "60"}
                assert len(owners) == 1
                release.set()
                assert 0 < await asyncio.wait_for(sleeps.get(), 1) <= 60
                response = await automations.process_due_automations(
                    request, MissedClassProcessRequest(limit=3), "worker"
                )
                assert response == AutomationBatchResponse.model_validate(batch_summary())
                assert app.state.automation_scheduler is scheduler
            assert scheduler.snapshot()["closed"]
            assert scheduler._timer.done()
            assert not scheduler.snapshot()["in_flight"]
        finally:
            release.set()

    asyncio.run(scenario())
    factory.assert_called_once_with(settings)
    assert len(owners) == len(closes) == 2
    assert [kwargs["first_engine"] for _, kwargs in owners] == ["attendance", "workflows"]
    assert owners[1][1]["limit"] == 3
    assert all(thread != threading.get_ident() for thread, _ in owners)
    assert closes == [thread for thread, _ in owners]
