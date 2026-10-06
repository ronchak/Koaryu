"""Controlled lifecycle events prove admission, cancellation and late owner cleanup."""

import asyncio
import threading
from concurrent.futures import Future
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from test_automation_batch import batch_summary
from test_automation_coordinator import BatchFixture

from app.schemas.automation_batch import AutomationBatchResponse
from app.services import automation_scheduler as scheduler
from app.services.automation_coordinator import AutomationBatchUnavailable
from app.services.automation_scheduler import AutomationBatchBusy, AutomationScheduler

UTC_NOW = datetime(2026, 10, 5, tzinfo=UTC)


class Controlled:
    def __init__(self):
        self.now = 100.0
        self.sleeps = asyncio.Queue()
        self.waits = []
        self.expire = False

    def clock(self):
        return self.now

    async def sleep(self, seconds):
        wake = asyncio.get_running_loop().create_future()
        self.sleeps.put_nowait((seconds, wake))
        await wake

    async def wait(self, source, *, timeout):
        self.waits.append((source, timeout))
        if self.expire:
            return await scheduler._wait_for_source(source, timeout=0)
        return await scheduler._wait_for_source(source, timeout=timeout)

    async def parked(self):
        return await asyncio.wait_for(self.sleeps.get(), 1)

    def make(self, processor, **kwargs):
        return AutomationScheduler(
            SimpleNamespace(AUTOMATION_WORKER_ENABLED=True),
            batch_processor=processor,
            clock=self.clock,
            utc_clock=lambda: UTC_NOW,
            sleep=self.sleep,
            wait_for_source=self.wait,
            **kwargs,
        )


class Owner:
    def __init__(self, *, held=False, fail=False):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = []
        self.closed = []
        self.fail = fail
        if not held:
            self.release.set()

    def __call__(self, settings, **kwargs):
        self.calls.append((kwargs, threading.get_ident(), threading.current_thread().daemon))
        self.entered.set()
        try:
            assert self.release.wait(2), "controlled owner was not released"
            if self.fail:
                raise RuntimeError("private source diagnostic")
            return AutomationBatchResponse.model_validate(batch_summary())
        finally:
            self.closed.append(threading.get_ident())


async def entered(owner):
    assert await asyncio.to_thread(owner.entered.wait, 1)


@pytest.mark.parametrize("flag", [False, None, 1, "true"])
def test_disabled_unstarted_and_closed_never_create_threads_or_clients(monkeypatch, flag):
    def forbidden(*a, **k):
        pytest.fail("disabled scheduler created a thread")

    monkeypatch.setattr(scheduler.threading, "Thread", forbidden)

    async def scenario():
        subject = AutomationScheduler(SimpleNamespace(AUTOMATION_WORKER_ENABLED=flag))
        with pytest.raises(AutomationBatchUnavailable):
            await subject.run_once()
        await subject.start()
        assert not subject.snapshot()["started"]
        await subject.stop()
        subject._settings.AUTOMATION_WORKER_ENABLED = True
        await subject.start()
        with pytest.raises(AutomationBatchUnavailable):
            await subject.run_once()
        assert subject.snapshot()["closed"] and not subject.snapshot()["in_flight"]

    asyncio.run(scenario())


def test_immediate_tick_idempotent_start_alternation_cadence_and_missed_skip():
    async def scenario():
        control, owner = Controlled(), Owner()
        subject = control.make(owner)
        await subject.start()
        await subject.start()
        delay, wake = await control.parked()
        assert delay == 60 and len(owner.calls) == 1
        assert owner.calls[0][0]["first_engine"] == "attendance"
        assert owner.calls[0][0]["deadline_monotonic"] == 125
        await subject.run_once(limit=1, deadline_monotonic=115)
        assert owner.calls[1][0]["first_engine"] == "workflows"
        assert owner.calls[1][0]["deadline_monotonic"] == 115
        control.now = 290
        wake.set_result(None)
        delay, _ = await control.parked()
        assert delay == 50 and len(owner.calls) == 3
        assert owner.calls[2][0]["first_engine"] == "attendance"
        assert all(daemon for _, _, daemon in owner.calls)
        snapshot = subject.snapshot()
        assert snapshot["last_started_at"] == snapshot["last_finished_at"] == UTC_NOW
        assert snapshot["last_outcome"] == "completed" and snapshot["last_has_more"] is False
        snapshot["closed"] = True
        assert not subject.snapshot()["closed"]
        await subject.stop()
        await subject.stop()
        await subject.start()
        assert len(owner.calls) == 3

    asyncio.run(scenario())


def test_timer_manual_contention_has_no_queue_and_only_admission_flips_priority():
    async def scenario():
        control, owner = Controlled(), Owner(held=True)
        control.expire = True
        subject = control.make(owner)
        await subject.start()
        await entered(owner)
        delay, wake = await control.parked()
        for _ in range(3):
            with pytest.raises(AutomationBatchBusy):
                await subject.run_once()
        control.now += delay
        wake.set_result(None)
        await control.parked()
        assert len(owner.calls) == 1 and subject.snapshot()["next_first_engine"] == "workflows"
        source = control.waits[0][0]
        assert not source.cancelled() and subject.snapshot()["in_flight"]
        owner.release.set()
        await scheduler._wait_for_source(source, timeout=1)
        control.expire = False
        await subject.run_once()
        assert [call[0]["first_engine"] for call in owner.calls] == ["attendance", "workflows"]
        await subject.stop()

    asyncio.run(scenario())


@pytest.mark.parametrize("cancel", [True, False])
def test_caller_cancel_or_timeout_retains_source_and_slot_until_actual_cleanup(cancel):
    async def scenario():
        control, owner = Controlled(), Owner(held=True)
        control.expire = not cancel
        subject = control.make(owner)
        caller = asyncio.create_task(subject.run_once())
        await subject.start()
        await entered(owner)
        if cancel:
            caller.cancel()
            with pytest.raises(asyncio.CancelledError):
                await caller
        else:
            with pytest.raises(AutomationBatchUnavailable):
                await caller
        source, timeout = control.waits[0]
        assert timeout == 30 and not source.cancelled() and not owner.closed
        with pytest.raises(AutomationBatchBusy):
            await subject.run_once()
        assert subject.snapshot()["in_flight"] and subject.snapshot()["last_outcome"] is None
        owner.release.set()
        result = await scheduler._wait_for_source(source, timeout=1)
        assert result.has_more is False and not subject.snapshot()["in_flight"]
        assert owner.closed == [owner.calls[0][1]]
        control.expire = False
        await subject.stop()

    asyncio.run(scenario())


@pytest.mark.parametrize("fail", [False, True])
def test_bounded_concurrent_stop_and_late_completion_never_cancel_source(fail, monkeypatch):
    wrapped = []
    wrap = asyncio.wrap_future

    def counted(source):
        wrapped.append(source)
        return wrap(source)

    monkeypatch.setattr(asyncio, "wrap_future", counted)

    async def scenario():
        control, owner = Controlled(), Owner(held=True, fail=fail)
        control.expire = True
        subject = control.make(owner)
        await subject.start()
        await entered(owner)
        await control.parked()
        source = control.waits[0][0]
        await asyncio.gather(subject.stop(), subject.stop())
        assert all(timeout == 30 for _, timeout in control.waits)
        assert subject.snapshot()["closed"] and subject.snapshot()["in_flight"]
        assert not source.done() and not owner.closed
        assert wrapped == [source]
        with pytest.raises(AutomationBatchUnavailable):
            await subject.run_once()
        owner.release.set()
        await scheduler._wait_for_source(source, timeout=1)
        snapshot = subject.snapshot()
        assert snapshot["last_outcome"] == ("unavailable" if fail else "completed")
        assert snapshot["last_has_more"] is (None if fail else False)
        assert not snapshot["in_flight"] and "private" not in repr(snapshot)
        assert len(owner.calls) == 1 and owner.closed == [owner.calls[0][1]]

    asyncio.run(scenario())


def test_real_coordinator_close_remains_on_owner_after_bounded_stop(monkeypatch):
    batch = BatchFixture(monkeypatch)
    closing, release = threading.Event(), threading.Event()
    control = Controlled()
    control.expire = True

    def close(client):
        closing.set()
        assert release.wait(2)
        batch.close_client(client)

    subject = control.make(lambda _, **k: batch.stubbed(**k, client_closer=close))

    async def scenario():
        await subject.start()
        assert await asyncio.to_thread(closing.wait, 1)
        await control.parked()
        source = control.waits[0][0]
        await subject.stop()
        assert subject.snapshot()["in_flight"] and not batch.closes
        assert not batch.clients[0][0].session.is_closed
        release.set()
        assert await scheduler._wait_for_source(source, timeout=1)
        assert batch.closes == batch.clients and batch.clients[0][0].session.is_closed
        assert batch.closes[0][1] != threading.get_ident()

    try:
        asyncio.run(scenario())
    finally:
        release.set()


def test_parent_loop_can_close_before_daemon_owner_finishes_without_raw_diagnostics(capsys):
    control, owner = Controlled(), Owner(held=True, fail=True)
    subject = control.make(owner)
    loop = asyncio.new_event_loop()
    errors = []
    loop.set_exception_handler(lambda _, context: errors.append(context))

    async def begin_and_stop():
        await subject.start()
        await entered(owner)
        source = control.waits[0][0]
        control.expire = True
        await subject.stop()
        assert not source.done()
        return source

    try:
        source = loop.run_until_complete(begin_and_stop())
        loop.close()

        async def foreign_wait():
            with pytest.raises(AutomationBatchUnavailable):
                await scheduler._wait_for_source(source, timeout=0)

        asyncio.run(foreign_wait())
        assert not source.cancelled()
        owner.release.set()
        assert source.result(timeout=1) is None
        assert owner.closed == [owner.calls[0][1]]
        assert subject.snapshot()["last_outcome"] == "unavailable"
        assert not hasattr(source, "_automation_waiter")
        assert not errors and "private" not in capsys.readouterr().err
    finally:
        owner.release.set()
        if not loop.is_closed():
            loop.close()


@pytest.mark.parametrize(
    "kwargs",
    [{"limit": True}, {"limit": 0}, {"deadline_monotonic": float("nan")}, {"create_fails": True}],
)
def test_invalid_admission_and_disabled_runtime_do_not_advance_priority(kwargs, monkeypatch):
    async def scenario():
        control, owner = Controlled(), Owner()
        subject = control.make(owner)
        await subject.start()
        await control.parked()
        before = subject.snapshot()["next_first_engine"]
        if "create_fails" in kwargs:

            def failed_thread(**_):
                raise RuntimeError("private thread diagnostic")

            monkeypatch.setattr(scheduler.threading, "Thread", failed_thread)
        with pytest.raises(AutomationBatchUnavailable):
            await subject.run_once(**({} if "create_fails" in kwargs else kwargs))
        subject._settings.AUTOMATION_WORKER_ENABLED = False
        with pytest.raises(AutomationBatchUnavailable):
            await subject.run_once()
        assert len(owner.calls) == 1 and subject.snapshot()["next_first_engine"] == before
        await subject.stop()

    asyncio.run(scenario())


def test_result_publication_and_slot_release_are_one_observable_transition(monkeypatch):
    publishing, release, observing = threading.Event(), threading.Event(), threading.Event()
    sources = []

    class PausedPublication(Future):
        def __init__(self):
            super().__init__()
            sources.append(self)

        def set_result(self, result):
            publishing.set()
            assert release.wait(2)
            super().set_result(result)

    monkeypatch.setattr(scheduler, "Future", PausedPublication)

    async def scenario():
        control, owner = Controlled(), Owner()
        subject = control.make(owner)
        await subject.start()
        assert await asyncio.to_thread(publishing.wait, 1)

        def observe():
            observing.set()
            return subject.snapshot(), sources[0].done()

        observer = asyncio.create_task(asyncio.to_thread(observe))
        assert await asyncio.to_thread(observing.wait, 1)
        assert not sources[0].done() and not observer.done()
        release.set()
        snapshot, done = await observer
        assert done and not snapshot["in_flight"] and snapshot["last_outcome"] == "completed"
        await subject.stop()

    try:
        asyncio.run(scenario())
    finally:
        release.set()
