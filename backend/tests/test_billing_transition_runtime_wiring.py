"""Both process schedulers drain before provider shutdown, including failures."""

import asyncio
import threading
from types import SimpleNamespace

import pytest

from app import main


@pytest.mark.parametrize(
    "automation,billing", [(False, False), (True, False), (False, True), (True, True)]
)
def test_lifespan_starts_only_enabled_schedulers(monkeypatch, automation, billing):
    calls = []
    wire(monkeypatch, calls, automation=automation, billing=billing)

    async def scenario():
        application = SimpleNamespace(state=SimpleNamespace())
        async with main._lifespan(application):
            assert (application.state.automation_scheduler is not None) is automation
            assert (application.state.billing_transition_scheduler is not None) is billing

    asyncio.run(scenario())
    expected = ["runtime_created"]
    if automation:
        expected += ["automation_construct", "automation_start"]
    if billing:
        expected += ["billing_construct", "billing_start"]
    if billing:
        expected += ["billing_stop"]
    if automation:
        expected += ["automation_stop"]
    assert [name for name, _ in calls] == expected + ["runtime_shutdown"]
    assert calls[-1][1] != threading.get_ident()


def wire(monkeypatch, calls, *, automation=True, billing=True, failure=None):
    monkeypatch.setattr(
        main,
        "settings",
        SimpleNamespace(
            AUTOMATION_WORKER_ENABLED=automation,
            BILLING_TRANSITION_SCHEDULER_ENABLED=billing,
        ),
    )

    def record(name):
        calls.append((name, threading.get_ident()))
        if name == failure:
            raise RuntimeError(failure)

    class Runtime:
        def __init__(self, *args):
            record("runtime_created")

        def shutdown(self):
            record("runtime_shutdown")

    def scheduler(name):
        class Scheduler:
            def __init__(self, settings):
                record(f"{name}_construct")

            async def start(self):
                record(f"{name}_start")

            async def stop(self):
                record(f"{name}_stop")

        return Scheduler

    monkeypatch.setattr(main, "SupabaseProviderRuntime", Runtime)
    monkeypatch.setattr(main, "AutomationScheduler", scheduler("automation"))
    monkeypatch.setattr(main, "BillingTransitionScheduler", scheduler("billing"))


@pytest.mark.parametrize(
    "failure,stops",
    [
        ("automation_construct", []),
        ("automation_start", ["automation_stop"]),
        ("billing_construct", ["automation_stop"]),
        ("billing_start", ["billing_stop", "automation_stop"]),
        ("body", ["billing_stop", "automation_stop"]),
        ("billing_stop", ["billing_stop", "automation_stop"]),
        ("automation_stop", ["billing_stop", "automation_stop"]),
    ],
)
def test_lifespan_cleans_all_constructed_owners_on_failure(monkeypatch, failure, stops):
    calls = []
    wire(monkeypatch, calls, failure=failure)

    async def scenario():
        application = SimpleNamespace(state=SimpleNamespace())
        async with main._lifespan(application):
            if failure == "body":
                raise RuntimeError("body")

    with pytest.raises(RuntimeError, match=failure):
        asyncio.run(scenario())
    assert [name for name, _ in calls if name.endswith("_stop")] == stops
    assert calls[-1][0] == "runtime_shutdown" and calls[-1][1] != threading.get_ident()
