"""Process-local single admission lane with bounded waiting and daemon ownership."""

from __future__ import annotations

import asyncio
import math
import threading
import time
from concurrent.futures import Future
from datetime import UTC, datetime

from app.schemas.automation_batch import AutomationBatchResponse
from app.services.automation_coordinator import (
    AutomationBatchUnavailable,
    _batch_deadline,
    process_automation_batch,
)

INTERVAL_SECONDS = 60.0
WAIT_SECONDS = 30.0


class AutomationBatchBusy(RuntimeError):
    def __init__(self):
        super().__init__("Automation batch is already running.")


async def _wait_for_source(source, *, timeout):
    if source.done():
        return source.result()
    # Repeated stop/wait calls must not accumulate callbacks on a stalled source.
    waiter = getattr(source, "_automation_waiter", None)
    if waiter is None:
        waiter = asyncio.wrap_future(source)
        source._automation_waiter = waiter
    elif waiter.get_loop() is not asyncio.get_running_loop():
        raise AutomationBatchUnavailable()
    if source.done():
        source.__dict__.pop("_automation_waiter", None)
    return await asyncio.wait_for(asyncio.shield(waiter), timeout=timeout)


def _consume_timer(task):
    if not task.cancelled():
        task.exception()


class AutomationScheduler:
    def __init__(
        self,
        settings,
        *,
        batch_processor=None,
        clock=None,
        utc_clock=None,
        sleep=None,
        wait_for_source=None,
    ):
        self._settings = settings
        self._processor = batch_processor or process_automation_batch
        self._clock = clock or time.monotonic
        self._utc_clock = utc_clock or (lambda: datetime.now(UTC))
        self._sleep = sleep or asyncio.sleep
        self._wait = wait_for_source or _wait_for_source
        self._lock = threading.RLock()
        self._started = False
        self._closed = False
        self._active = None
        self._timer = None
        self._next_first_engine = "attendance"
        self._last_started_at = None
        self._last_finished_at = None
        self._last_outcome = None
        self._last_has_more = None

    def _enabled(self):
        return getattr(self._settings, "AUTOMATION_WORKER_ENABLED", False) is True

    def _now(self):
        now = self._clock()
        if type(now) not in {int, float} or not math.isfinite(now):
            raise AutomationBatchUnavailable()
        return now

    def _utc_now(self):
        now = self._utc_clock()
        if not isinstance(now, datetime) or now.utcoffset() is None:
            raise AutomationBatchUnavailable()
        return now.astimezone(UTC)

    async def start(self) -> None:
        with self._lock:
            if self._closed or self._started or not self._enabled():
                return
            self._started = True
            self._timer = asyncio.create_task(self._ticks(), name="automation-timer")
            self._timer.add_done_callback(_consume_timer)

    async def _ticks(self):
        target = self._now()
        while True:
            with self._lock:
                if self._closed:
                    return
            try:
                await self.run_once()
            except (AutomationBatchBusy, AutomationBatchUnavailable):
                pass
            target += INTERVAL_SECONDS
            now = self._now()
            if target < now:
                target += (math.floor((now - target) / INTERVAL_SECONDS) + 1) * INTERVAL_SECONDS
            await self._sleep(max(0.0, target - now))

    def _run_source(self, source, first_engine, deadline, limit):
        result = None
        try:
            observed = self._processor(
                self._settings,
                first_engine=first_engine,
                deadline_monotonic=deadline,
                limit=limit,
                clock=self._clock,
            )
            if type(observed) is AutomationBatchResponse:
                if observed.model_fields_set != set(AutomationBatchResponse.model_fields):
                    raise AutomationBatchUnavailable()
                # Pass actual nested objects so incomplete default models remain detectable.
                observed = {
                    key: getattr(observed, key) for key in AutomationBatchResponse.model_fields
                }
            result = AutomationBatchResponse.model_validate(observed, context={"limit": limit})
        except BaseException:  # noqa: BLE001 - A daemon failure must not emit raw diagnostics.
            # Even a late thread failure is represented without secret-bearing exceptions.
            result = None
        finally:
            try:
                finished = self._utc_now()
            except Exception:  # noqa: BLE001 - Unavailable observation has no invented timestamp.
                finished = None
            with self._lock:
                if self._active is source:
                    self._last_finished_at = finished
                    self._last_outcome = "completed" if result is not None else "unavailable"
                    self._last_has_more = result.has_more if result is not None else None
                    source.set_result(result)
                    source.__dict__.pop("_automation_waiter", None)
                    self._active = None

    async def run_once(
        self,
        *,
        limit: int = 10,
        deadline_monotonic: float | None = None,
    ) -> AutomationBatchResponse:
        with self._lock:
            if not self._started or self._closed or not self._enabled():
                raise AutomationBatchUnavailable()
        try:
            if deadline_monotonic is None:
                deadline_monotonic = self._now() + 25.0
            admitted_at, deadline = _batch_deadline(self._clock, deadline_monotonic, limit)
            started_at = self._utc_now()
        except Exception:  # noqa: BLE001 - Sanitize invalid clock and admission callbacks.
            raise AutomationBatchUnavailable() from None
        with self._lock:
            if not self._started or self._closed or not self._enabled():
                raise AutomationBatchUnavailable()
            if self._active is not None:
                raise AutomationBatchBusy()
            source = Future()
            first = self._next_first_engine
            self._active = source
            self._last_started_at = started_at
            self._next_first_engine = "workflows" if first == "attendance" else "attendance"
            try:
                thread = threading.Thread(
                    target=self._run_source,
                    args=(source, first, deadline, limit),
                    name="automation-batch",
                    daemon=True,
                )
                thread.start()
            except Exception:  # noqa: BLE001 - Failed local admission leaves no occupied slot.
                self._active = None
                self._next_first_engine = first
                self._last_outcome = "unavailable"
                self._last_has_more = None
                raise AutomationBatchUnavailable() from None
        try:
            result = await self._wait(
                source, timeout=max(0.0, WAIT_SECONDS - (self._now() - admitted_at))
            )
            if result is None:
                raise AutomationBatchUnavailable()
            return result
        except Exception:  # noqa: BLE001 - A waiter cannot expose the source's diagnostics.
            raise AutomationBatchUnavailable() from None

    async def stop(self) -> None:
        began = self._now()
        with self._lock:
            self._closed = True
            timer, source = self._timer, self._active
        if timer is not None:
            timer.cancel()
            await asyncio.wait({timer}, timeout=max(0.0, WAIT_SECONDS - (self._now() - began)))
        if source is not None:
            try:
                await self._wait(source, timeout=max(0.0, WAIT_SECONDS - (self._now() - began)))
            except Exception:  # noqa: BLE001, S110 - The owner retains cleanup after bounded waiting.
                pass
        # Allow timer cancellation to run without joining the owner thread.
        await asyncio.sleep(0)

    def snapshot(self):
        with self._lock:
            return {
                "started": self._started,
                "closed": self._closed,
                "in_flight": self._active is not None,
                "next_first_engine": self._next_first_engine,
                "last_started_at": self._last_started_at,
                "last_finished_at": self._last_finished_at,
                "last_outcome": self._last_outcome,
                "last_has_more": self._last_has_more,
            }
