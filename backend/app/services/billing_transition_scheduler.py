"""Recurring billing work with one daemon-owned batch and no local queue."""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from concurrent.futures import Future
from uuid import uuid4

from app.db.supabase import close_supabase_client, create_supabase_client
from app.services.billing_service import BillingService

logger = logging.getLogger("uvicorn.error.billing_transition_scheduler")
INTERVAL_SECONDS = 300.0
BATCH_LIMIT = 25
WAIT_SECONDS = 120.0
STOP_SECONDS = 30.0
DATABASE_TIMEOUT_SECONDS = 30.0
_RESULT_FIELDS = {"claimed", "completed", "reconciliation_required", "failed"}


async def _wait_for_source(source, *, timeout):
    if source.done():
        return source.result()
    # Repeated timeouts/stops reuse one wrapper instead of accumulating callbacks.
    waiter = getattr(source, "_billing_waiter", None)
    if waiter is None:
        waiter = asyncio.wrap_future(source)
        source._billing_waiter = waiter
    elif waiter.get_loop() is not asyncio.get_running_loop():
        raise RuntimeError("Billing batch belongs to another event loop.")
    return await asyncio.wait_for(asyncio.shield(waiter), timeout=timeout)


def _consume_timer(task):
    if not task.cancelled() and task.exception() is not None:
        logger.warning("billing_transition_timer_unavailable")


class BillingTransitionScheduler:
    def __init__(
        self,
        settings,
        *,
        client_factory=None,
        client_closer=None,
        service_factory=None,
        clock=None,
        sleep=None,
        wait_for_source=None,
    ):
        self._settings = settings
        self._client_factory = client_factory or create_supabase_client
        self._client_closer = client_closer or close_supabase_client
        self._service_factory = service_factory or BillingService
        self._clock = clock or time.monotonic
        self._sleep = sleep or asyncio.sleep
        self._wait = wait_for_source or _wait_for_source
        self._lock = threading.RLock()
        self._started = False
        self._closed = False
        self._active = None
        self._timer = None

    def _enabled(self):
        return getattr(self._settings, "BILLING_TRANSITION_SCHEDULER_ENABLED", False) is True

    async def start(self) -> None:
        with self._lock:
            if self._started or self._closed or not self._enabled():
                return
            self._started = True
            self._timer = asyncio.create_task(self._ticks(), name="billing-transition-timer")
            self._timer.add_done_callback(_consume_timer)
            logger.info("billing_transition_scheduler_started")

    async def _ticks(self):
        target = self._clock()
        while True:
            with self._lock:
                if self._closed:
                    return
            await self.run_once()
            target += INTERVAL_SECONDS
            now = self._clock()
            if target < now:
                target += (math.floor((now - target) / INTERVAL_SECONDS) + 1) * INTERVAL_SECONDS
            await self._sleep(max(0.0, target - now))

    def _run_source(self, source):
        client = None
        outcome = "unavailable"
        try:
            with self._lock:
                if self._closed or not self._enabled():
                    outcome = "disabled"
                    return
            client = self._client_factory(postgrest_client_timeout=DATABASE_TIMEOUT_SECONDS)
            service = self._service_factory(client)
            with self._lock:
                if self._closed or not self._enabled():
                    outcome = "disabled"
                    return
            # This async public method wraps synchronous database/provider work.
            # Its loop belongs to the daemon, never to the ASGI waiter.
            result = asyncio.run(
                service.process_due_enrollment_transitions(
                    worker_id=str(uuid4()), limit=BATCH_LIMIT
                )
            )
            if (
                type(result) is not dict
                or set(result) != _RESULT_FIELDS
                or any(
                    type(value) is not int or not 0 <= value <= BATCH_LIMIT
                    for value in result.values()
                )
                or sum(result[key] for key in _RESULT_FIELDS - {"claimed"}) > result["claimed"]
            ):
                raise ValueError("Invalid billing batch result.")
            logger.info(
                "billing_transition_batch_completed claimed=%d completed=%d "
                "reconciliation_required=%d failed=%d",
                result["claimed"],
                result["completed"],
                result["reconciliation_required"],
                result["failed"],
            )
            outcome = "completed"
            if result["failed"] or result["reconciliation_required"]:
                outcome = "attention_required"
                logger.warning("billing_transition_batch_attention_required")
        except BaseException:  # noqa: BLE001 - Daemon failures must not expose provider diagnostics.
            logger.warning("billing_transition_batch_unavailable")
        finally:
            if client is not None:
                try:
                    self._client_closer(client)
                except BaseException:  # noqa: BLE001 - Preserve confirmed work; redact cleanup errors.
                    logger.warning("billing_transition_batch_cleanup_failed")
            with self._lock:
                source.set_result(outcome)
                source.__dict__.pop("_billing_waiter", None)
                self._active = None

    async def run_once(self) -> None:
        with self._lock:
            if not self._started or self._closed or not self._enabled() or self._active is not None:
                return
            source = Future()
            self._active = source
            try:
                threading.Thread(
                    target=self._run_source,
                    args=(source,),
                    name="billing-transition-batch",
                    daemon=True,
                ).start()
            except Exception:  # noqa: BLE001 - A failed admission leaves no occupied slot.
                self._active = None
                logger.warning("billing_transition_batch_admission_failed")
                return
        try:
            await self._wait(source, timeout=WAIT_SECONDS)
        except Exception:  # noqa: BLE001 - Waiting never cancels the source or releases its client.
            logger.warning("billing_transition_batch_wait_unavailable")

    async def stop(self) -> None:
        began = self._clock()
        with self._lock:
            self._closed = True
            timer, source = self._timer, self._active
        logger.info("billing_transition_scheduler_admission_closed")
        if timer is not None:
            timer.cancel()
            await asyncio.wait({timer}, timeout=max(0.0, STOP_SECONDS - (self._clock() - began)))
        if source is not None:
            try:
                await self._wait(source, timeout=max(0.0, STOP_SECONDS - (self._clock() - began)))
            except Exception:  # noqa: BLE001, S110 - The daemon still owns submitted work and cleanup.
                pass
        # Like automation shutdown, bound this waiter, not submitted mutations.
        await asyncio.sleep(0)
