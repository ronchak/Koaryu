"""Billing timer ownership, flag gates and late cleanup without provider access."""

import asyncio
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from uuid import UUID

import pytest

from app.core.config import Settings
from app.services import billing_transition_scheduler as module
from app.services.billing_transition_scheduler import BillingTransitionScheduler


def summary():
    return {"claimed": 0, "completed": 0, "reconciliation_required": 0, "failed": 0}


class Controlled:
    def __init__(self, *, held=False, failure=None, result=None, results=None):
        self.settings = SimpleNamespace(BILLING_TRANSITION_SCHEDULER_ENABLED=True)
        self.now = 100.0
        self.sleeps = asyncio.Queue()
        self.waits = []
        self.expire = False
        self.entered = threading.Event()
        self.release = threading.Event()
        if not held:
            self.release.set()
        self.failure = failure
        self.result = summary() if result is None else result
        self.results = iter(results) if results is not None else None
        self.clients = []
        self.calls = []
        self.closed = []
        self.subject = BillingTransitionScheduler(
            self.settings,
            client_factory=self.create,
            client_closer=self.close,
            service_factory=lambda client: self,
            clock=lambda: self.now,
            sleep=self.sleep,
            wait_for_source=self.wait,
        )

    def create(self, **kwargs):
        if self.failure == "create":
            raise RuntimeError("private client diagnostic")
        client = object()
        self.clients.append((client, threading.get_ident(), kwargs))
        return client

    def close(self, client):
        self.closed.append((client, threading.get_ident()))
        if self.failure == "close":
            raise RuntimeError("private cleanup diagnostic")

    async def process_due_enrollment_transitions(self, **kwargs):
        self.calls.append((kwargs, threading.get_ident(), threading.current_thread().daemon))
        self.entered.set()
        assert self.release.wait(3), "controlled batch was not released"
        if self.failure == "process":
            raise RuntimeError("private provider diagnostic")
        return next(self.results) if self.results is not None else self.result

    async def sleep(self, seconds):
        wake = asyncio.get_running_loop().create_future()
        self.sleeps.put_nowait((seconds, wake))
        await wake

    async def wait(self, source, *, timeout):
        self.waits.append((source, timeout))
        return await module._wait_for_source(source, timeout=0 if self.expire else timeout)

    async def parked(self):
        return await asyncio.wait_for(self.sleeps.get(), 1)


@pytest.mark.parametrize("flag", [False, None, 1, "true"])
def test_disabled_and_stopped_start_create_no_work(monkeypatch, flag):
    assert Settings.model_fields["BILLING_TRANSITION_SCHEDULER_ENABLED"].default is False

    def forbidden(*args, **kwargs):
        pytest.fail("disabled scheduler created a thread")

    monkeypatch.setattr(module.threading, "Thread", forbidden)

    async def scenario():
        control = Controlled()
        control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = flag
        await control.subject.run_once()
        await control.subject.start()
        assert control.subject._timer is None
        await control.subject.stop()
        control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = True
        await control.subject.start()
        await control.subject.run_once()
        assert not control.clients and not control.calls

    asyncio.run(scenario())


def test_immediate_periodic_batches_without_requests_skip_missed_ticks_and_fresh_worker_ids():
    async def scenario():
        control = Controlled()
        subject = control.subject
        await subject.start()
        await subject.start()
        delay, wake = await control.parked()
        assert delay == 300 and len(control.calls) == 1
        control.now += delay
        wake.set_result(None)
        delay, wake = await control.parked()
        assert delay == 300 and len(control.calls) == 2
        control.now = 1150
        wake.set_result(None)
        delay, _ = await control.parked()
        assert delay == 150 and len(control.calls) == 3
        assert {call[0]["limit"] for call in control.calls} == {1}
        workers = [UUID(call[0]["worker_id"]) for call in control.calls]
        assert len(set(workers)) == 3 and all(worker.version == 4 for worker in workers)
        assert all(not call[2] and call[1] != threading.get_ident() for call in control.calls)
        assert all(client[2] == {"postgrest_client_timeout": 30.0} for client in control.clients)
        assert control.closed == [(client, owner) for client, owner, _ in control.clients]
        await subject.stop()
        await subject.stop()
        await subject.start()
        assert subject._timer.done() and len(control.calls) == 3

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", [None, "process"])
def test_timeout_and_bounded_stop_retain_single_batch_client_and_cleanup_after_late_finish(
    monkeypatch, failure
):
    wrapped = []
    wrap = asyncio.wrap_future

    def counted(source):
        wrapped.append(source)
        return wrap(source)

    monkeypatch.setattr(asyncio, "wrap_future", counted)
    control = Controlled(held=True, failure=failure)
    control.expire = True

    async def scenario():
        subject = control.subject
        await subject.start()
        assert await asyncio.to_thread(control.entered.wait, 1)
        delay, wake = await control.parked()
        source = control.waits[0][0]
        await subject.run_once()
        control.now += delay
        wake.set_result(None)
        await control.parked()
        assert len(control.calls) == 1
        assert control.waits[0][1] == 120
        await asyncio.wait_for(asyncio.gather(subject.stop(), subject.stop()), 1)
        assert [timeout for _, timeout in control.waits[1:]] == [30, 30]
        assert wrapped.count(source) == 1
        assert subject._active is source and not source.done() and not source.cancelled()
        assert not control.closed
        await subject.run_once()
        control.release.set()
        assert await module._wait_for_source(source, timeout=1) == (
            "unavailable" if failure else "completed"
        )
        assert subject._active is None and len(control.calls) == 1
        assert control.closed == [(control.clients[0][0], control.calls[0][1])]

    try:
        asyncio.run(scenario())
    finally:
        control.release.set()


def test_flag_disable_blocks_future_ticks_and_pre_processing_recheck_closes_client():
    async def scenario():
        control = Controlled()
        await control.subject.start()
        _, wake = await control.parked()
        control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = False
        wake.set_result(None)
        _, wake = await control.parked()
        await control.subject.run_once()
        assert len(control.calls) == len(control.clients) == 1
        control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = True
        create = control.create

        def disable_during_creation(**kwargs):
            client = create(**kwargs)
            control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = False
            return client

        control.subject._client_factory = disable_during_creation
        wake.set_result(None)
        await control.parked()
        assert len(control.calls) == 1 and len(control.closed) == len(control.clients) == 2
        await control.subject.stop()

    asyncio.run(scenario())


def test_disabled_after_admission_before_owner_entry_creates_no_client(monkeypatch):
    original = module.threading.Thread
    control = Controlled()

    def disable_then_construct(**kwargs):
        control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = False
        return original(**kwargs)

    monkeypatch.setattr(module.threading, "Thread", disable_then_construct)

    async def scenario():
        await control.subject.start()
        await control.parked()
        assert not control.clients and not control.calls and control.subject._active is None
        await control.subject.stop()

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["create", "process", "close", "thread"])
def test_safe_failures_release_slot_and_timer_can_retry(monkeypatch, caplog, failure):
    control = Controlled(failure=failure)
    original = module.threading.Thread
    if failure == "thread":

        def fail_thread(**kwargs):
            raise RuntimeError("private thread diagnostic")

        monkeypatch.setattr(module.threading, "Thread", fail_thread)

    async def scenario():
        await control.subject.start()
        _, wake = await control.parked()
        assert control.subject._active is None
        assert len(control.closed) == len(control.clients)
        control.failure = None
        monkeypatch.setattr(module.threading, "Thread", original)
        wake.set_result(None)
        await control.parked()
        assert control.calls and control.subject._active is None
        await control.subject.stop()

    asyncio.run(scenario())
    assert "private" not in caplog.text and "diagnostic" not in caplog.text
    assert "billing_transition_batch_" in caplog.text


@pytest.mark.parametrize(
    "result",
    [
        "private provider data",
        {"claimed": 0, "completed": 0, "failed": 0},
        {**summary(), "raw": "private provider data"},
        {**summary(), "claimed": True},
        {**summary(), "claimed": 2},
        {**summary(), "completed": 1},
        {**summary(), "failed": -1},
    ],
)
def test_malformed_results_are_not_retained_or_logged(caplog, result):
    caplog.set_level("INFO", logger=module.logger.name)

    async def scenario():
        control = Controlled(result=result)
        await control.subject.start()
        await control.parked()
        assert control.waits[0][0].result() == "unavailable"
        assert control.subject._active is None and len(control.closed) == 1
        await control.subject.stop()

    asyncio.run(scenario())
    assert "billing_transition_batch_unavailable" in caplog.text
    assert "billing_transition_batch_completed" not in caplog.text
    assert "private" not in caplog.text


def test_owner_can_finish_after_waiter_loop_closes_without_cancellation_or_raw_error(capsys):
    control = Controlled(held=True, failure="process")
    control.expire = True
    loop = asyncio.new_event_loop()
    errors = []
    loop.set_exception_handler(lambda _, context: errors.append(context))

    async def scenario():
        await control.subject.start()
        assert await asyncio.to_thread(control.entered.wait, 1)
        await control.parked()
        source = control.waits[0][0]
        await control.subject.stop()
        return source

    try:
        source = loop.run_until_complete(scenario())
        loop.close()
        assert not source.cancelled() and not control.closed
        control.release.set()
        assert source.result(timeout=1) == "unavailable"
        assert len(control.closed) == 1 and control.subject._active is None
        assert not hasattr(source, "_billing_waiter") and not errors
        assert "private" not in capsys.readouterr().err
    finally:
        control.release.set()
        if not loop.is_closed():
            loop.close()


@pytest.mark.parametrize("field", ["failed", "reconciliation_required"])
def test_attention_result_warns_without_immediate_retry_or_raw_result(caplog, field):
    async def scenario():
        control = Controlled(result={**summary(), "claimed": 1, field: 1})
        await control.subject.start()
        delay, _ = await control.parked()
        assert control.waits[0][0].result() == "attention_required"
        assert len(control.calls) == 1 and delay == 300
        await control.subject.stop()

    asyncio.run(scenario())
    assert [record.message for record in caplog.records] == [
        "billing_transition_batch_attention_required"
    ]


def test_start_stop_categories_and_timer_failure_are_sanitized(caplog):
    caplog.set_level("INFO", logger=module.logger.name)

    async def scenario():
        control = Controlled()

        async def broken_sleep(seconds):
            raise RuntimeError("private timer diagnostic")

        control.subject._sleep = broken_sleep
        await control.subject.start()
        await asyncio.wait({control.subject._timer}, timeout=1)
        assert control.subject._timer.done()
        await asyncio.sleep(0)
        await control.subject.stop()

    asyncio.run(scenario())
    assert [record.message for record in caplog.records] == [
        "billing_transition_scheduler_started",
        "billing_transition_batch_completed claimed=0 completed=0 reconciliation_required=0 failed=0",
        "billing_transition_timer_unavailable",
        "billing_transition_scheduler_admission_closed",
    ]
    assert all(record.exc_info is None for record in caplog.records)


def test_stop_cancels_only_timer_waiter_while_owner_is_processing():
    control = Controlled(held=True)

    async def scenario():
        await control.subject.start()
        assert await asyncio.to_thread(control.entered.wait, 1)
        source = control.waits[0][0]
        control.expire = True
        await asyncio.wait_for(control.subject.stop(), 1)
        assert control.subject._timer.cancelled()
        assert not source.done() and not source.cancelled() and not control.closed
        control.release.set()
        assert await module._wait_for_source(source, timeout=1) == "completed"
        assert len(control.closed) == 1

    try:
        asyncio.run(scenario())
    finally:
        control.release.set()


def test_cleanup_keeps_slot_and_client_owned_after_processing_and_stop():
    control = Controlled()
    closing, release_close = threading.Event(), threading.Event()
    close = control.close

    def held_close(client):
        closing.set()
        assert release_close.wait(3)
        close(client)

    control.subject._client_closer = held_close
    control.expire = True

    async def scenario():
        await control.subject.start()
        assert await asyncio.to_thread(closing.wait, 1)
        await control.parked()
        source = control.waits[0][0]
        await control.subject.run_once()
        await control.subject.stop()
        assert len(control.calls) == 1 and not control.closed
        assert not source.done() and control.subject._active is source
        release_close.set()
        assert await module._wait_for_source(source, timeout=1) == "completed"
        assert control.subject._active is None and len(control.closed) == 1

    try:
        asyncio.run(scenario())
    finally:
        release_close.set()


@pytest.mark.parametrize(
    "result",
    [summary(), {"claimed": 1, "completed": 0, "reconciliation_required": 0, "failed": 1}],
)
def test_completed_batch_logs_only_exact_validated_counts(caplog, result):
    caplog.set_level("INFO", logger=module.logger.name)

    async def scenario():
        control = Controlled(result=result)
        await control.subject.start()
        await control.parked()
        assert len(control.calls) == 1
        await control.subject.stop()

    asyncio.run(scenario())
    records = [
        record
        for record in caplog.records
        if record.message.startswith("billing_transition_batch_completed")
    ]
    assert len(records) == 1
    record = records[0]
    counts = tuple(
        result[key] for key in ("claimed", "completed", "reconciliation_required", "failed")
    )
    assert record.args == counts and all(type(value) is int for value in record.args)
    assert (
        record.message
        == (
            "billing_transition_batch_completed claimed=%d completed=%d "
            "reconciliation_required=%d failed=%d"
        )
        % counts
    )
    assert record.levelname == "INFO" and record.exc_info is None
    warnings = [record.message for record in caplog.records if record.levelname == "WARNING"]
    assert warnings == (["billing_transition_batch_attention_required"] if result["failed"] else [])


@pytest.mark.parametrize("units", [0, 3, 25])
def test_tick_aggregates_units_with_one_client_and_stops_at_zero_or_limit(caplog, units):
    caplog.set_level("INFO", logger=module.logger.name)
    complete = {**summary(), "claimed": 1, "completed": 1}

    async def scenario():
        control = Controlled(results=[complete] * units + [summary(), complete])
        await control.subject.start()
        delay, _ = await control.parked()
        assert delay == 300
        assert len(control.calls) == min(units + 1, 25)
        assert {call[0]["limit"] for call in control.calls} == {1}
        assert len({call[0]["worker_id"] for call in control.calls}) == len(control.calls)
        assert len({call[1] for call in control.calls}) == 1
        assert len(control.clients) == len(control.closed) == 1
        assert control.waits[0][0].result() == "completed"
        await control.subject.stop()

    asyncio.run(scenario())
    completed = [
        record
        for record in caplog.records
        if record.message.startswith("billing_transition_batch_completed")
    ]
    assert len(completed) == 1 and completed[0].args == (units, units, 0, 0)


@pytest.mark.parametrize("pause", ["stop", "flag"])
def test_current_unit_finishes_after_pause_without_claiming_another(caplog, pause):
    caplog.set_level("INFO", logger=module.logger.name)
    control = Controlled(held=True, result={**summary(), "claimed": 1, "completed": 1})
    control.expire = True

    async def scenario():
        await control.subject.start()
        assert await asyncio.to_thread(control.entered.wait, 1)
        await control.parked()
        source = control.waits[0][0]
        if pause == "stop":
            await control.subject.stop()
        else:
            control.settings.BILLING_TRANSITION_SCHEDULER_ENABLED = False
        assert control.subject._active is source and not source.done()
        assert not control.closed and len(control.calls) == 1
        control.release.set()
        assert await module._wait_for_source(source, timeout=1) == "completed"
        assert len(control.calls) == len(control.closed) == 1
        assert not control.calls[0][2]
        await control.subject.stop()

    try:
        asyncio.run(scenario())
    finally:
        control.release.set()
    completed = [
        record
        for record in caplog.records
        if record.message.startswith("billing_transition_batch_completed")
    ]
    assert len(completed) == 1 and completed[0].args == (1, 1, 0, 0)


@pytest.mark.parametrize(
    "last,outcome",
    [
        ({**summary(), "claimed": 1, "failed": 1}, "attention_required"),
        ({**summary(), "claimed": 1, "reconciliation_required": 1}, "attention_required"),
        ({**summary(), "claimed": 1}, "deferred"),
        ({"private": "provider data"}, "unavailable"),
    ],
)
def test_drain_stops_after_attention_deferred_or_malformed_unit(caplog, last, outcome):
    caplog.set_level("INFO", logger=module.logger.name)
    complete = {**summary(), "claimed": 1, "completed": 1}

    async def scenario():
        control = Controlled(results=[complete, last, complete])
        await control.subject.start()
        delay, _ = await control.parked()
        assert delay == 300 and len(control.calls) == 2
        assert control.waits[0][0].result() == outcome
        assert len(control.closed) == 1
        await control.subject.stop()

    asyncio.run(scenario())
    completed = [
        record
        for record in caplog.records
        if record.message.startswith("billing_transition_batch_completed")
    ]
    if outcome == "unavailable":
        assert not completed
    else:
        assert len(completed) == 1
        assert completed[0].args == (2, 1, last["reconciliation_required"], last["failed"])
    if outcome == "deferred":
        assert "billing_transition_batch_deferred" in caplog.text
        assert "attention_required" not in caplog.text
    assert "private" not in caplog.text and "provider data" not in caplog.text


def test_ordinary_interpreter_exit_retains_current_unit_and_cleanup_after_bounded_stop(tmp_path):
    script = r"""
import asyncio
from pathlib import Path
import sys
import time
from types import SimpleNamespace
from app.core.config import Settings
Settings.model_config["env_file"] = None
from app.services import billing_transition_scheduler as module

folder = Path(sys.argv[1])
module.STOP_SECONDS = 0.01
module.WAIT_SECONDS = 0.01
calls = []
class Service:
    async def process_due_enrollment_transitions(self, **kwargs):
        calls.append(kwargs)
        (folder / "entered").write_text("entered")
        while not (folder / "release").exists():
            time.sleep(0.01)
        (folder / "finished").write_text(str(len(calls)))
        return {"claimed": 1, "completed": 1, "reconciliation_required": 0, "failed": 0}

def close(client):
    (folder / "closed").write_text("closed")

async def scenario():
    subject = module.BillingTransitionScheduler(
        SimpleNamespace(BILLING_TRANSITION_SCHEDULER_ENABLED=True),
        client_factory=lambda **_: object(), client_closer=close,
        service_factory=lambda _: Service(),
    )
    await subject.start()
    while not (folder / "entered").exists():
        await asyncio.sleep(0.01)
    await subject.stop()
    assert subject._active is not None and not subject._active.cancelled()

asyncio.run(scenario())
(folder / "main-returned").write_text("returned")
"""
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "ENVIRONMENT": "test",
        "SUPABASE_URL": "https://placeholder.supabase.co",
    }
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(tmp_path)],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 5
        while not (tmp_path / "main-returned").exists() and time.monotonic() < deadline:
            assert process.poll() is None, "child exited before bounded stop returned"
            time.sleep(0.01)
        assert (tmp_path / "main-returned").exists()
        # The child has reached the end of its script. Only the active source
        # keeps it alive; its main event loop and bounded stop have both finished.
        time.sleep(0.1)
        assert process.poll() is None
        assert not (tmp_path / "finished").exists() and not (tmp_path / "closed").exists()
        (tmp_path / "release").write_text("release")
        stdout, stderr = process.communicate(timeout=5)
        assert process.returncode == 0, (stdout, stderr)
        assert (tmp_path / "finished").read_text() == "1"
        assert (tmp_path / "closed").read_text() == "closed"
    finally:
        (tmp_path / "release").write_text("release")
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
