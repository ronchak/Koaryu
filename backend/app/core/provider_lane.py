"""Bounded asynchronous admission for synchronous provider operations."""

from __future__ import annotations

import asyncio
import logging
import threading
import time

from concurrent.futures import Future
from dataclasses import asdict, dataclass
from typing import Callable, Generic, TypeVar

from httpx import TimeoutException

from app.core.provider_executor import ThreadAffineProviderExecutor


logger = logging.getLogger("uvicorn.error.provider_lane")

ResourceT = TypeVar("ResourceT")
ResultT = TypeVar("ResultT")


class ProviderLaneSaturatedError(TimeoutError):
    """Raised when no lane capacity is available before the queue timeout."""


class ProviderLaneOperationTimeoutError(TimeoutError):
    """Raised when a submitted operation outlives its caller wait timeout."""


@dataclass(frozen=True)
class ProviderLaneSnapshot:
    """Immutable, thread-safe lane admission and completion counters.

    ``submitted`` counts source futures accepted by the executor. ``completed``
    counts source futures that actually finished, including failures and work
    that outlived a caller timeout or cancellation. ``saturated`` counts queue
    waits that expired before submission. ``timed_out`` counts submitted calls
    whose operation wait expired, including the outer request deadline.
    ``cancelled`` counts submitted calls whose awaiting task was cancelled,
    including cancellation driven by that outer deadline. ``failed`` counts submitted source futures
    that finished with an exception; it does not count caller timeout or
    cancellation by itself. ``active`` counts operations executing on workers;
    ``admitted`` also includes executor-queued work. Queue durations run from
    submission request to worker invocation, including admission wait and client
    construction. Operation durations end only when provider work returns.
    Transport timeouts are distinct from the caller's wait deadline. An outer
    deadline may also expire before admission; it still increments timed_out.
    """

    max_workers: int
    max_queue: int
    capacity: int
    admitted: int
    waiting: int
    submitted: int
    completed: int
    saturated: int
    timed_out: int
    cancelled: int
    failed: int
    active: int
    peak_active: int
    transport_timed_out: int
    admission_wait_seconds: float
    queue_wait_seconds: float
    max_queue_wait_seconds: float
    operation_seconds: float
    max_operation_seconds: float


class ProviderLane(Generic[ResourceT]):
    """Bound one provider executor by worker capacity plus a finite queue."""

    def __init__(
        self,
        executor: ThreadAffineProviderExecutor[ResourceT],
        *,
        max_queue: int,
        queue_wait_timeout: float,
        operation_wait_timeout: float,
        name: str = "provider",
    ) -> None:
        if max_queue < 0:
            raise ValueError("max_queue must be non-negative")
        if queue_wait_timeout <= 0:
            raise ValueError("queue_wait_timeout must be positive")
        if operation_wait_timeout <= 0:
            raise ValueError("operation_wait_timeout must be positive")

        self._name = name
        self._last_metrics_at = 0.0
        self._executor = executor
        self._max_workers = executor.max_workers
        self._max_queue = max_queue
        self._capacity = self._max_workers + max_queue
        self._queue_wait_timeout = queue_wait_timeout
        self._operation_wait_timeout = operation_wait_timeout

        self._lifecycle_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._closed = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake_event: asyncio.Event | None = None

        self._admitted = 0
        self._waiting = 0
        self._available = self._capacity
        self._submitted = 0
        self._completed = 0
        self._saturated = 0
        self._timed_out = 0
        self._cancelled = 0
        self._failed = 0
        self._active = 0
        self._peak_active = 0
        self._transport_timed_out = 0
        self._admission_wait_seconds = 0.0
        self._queue_wait_seconds = 0.0
        self._max_queue_wait_seconds = 0.0
        self._operation_seconds = 0.0
        self._max_operation_seconds = 0.0

    @property
    def operation_wait_timeout(self) -> float:
        return self._operation_wait_timeout

    def snapshot(self) -> ProviderLaneSnapshot:
        """Return a consistent immutable snapshot for later metrics wiring."""
        with self._state_lock:
            return ProviderLaneSnapshot(
                max_workers=self._max_workers,
                max_queue=self._max_queue,
                capacity=self._capacity,
                admitted=self._admitted,
                waiting=self._waiting,
                submitted=self._submitted,
                completed=self._completed,
                saturated=self._saturated,
                timed_out=self._timed_out,
                cancelled=self._cancelled,
                failed=self._failed,
                active=self._active,
                peak_active=self._peak_active,
                transport_timed_out=self._transport_timed_out,
                admission_wait_seconds=self._admission_wait_seconds,
                queue_wait_seconds=self._queue_wait_seconds,
                max_queue_wait_seconds=self._max_queue_wait_seconds,
                operation_seconds=self._operation_seconds,
                max_operation_seconds=self._max_operation_seconds,
            )

    async def submit(self, operation: Callable[[ResourceT], ResultT]) -> ResultT:
        """Admit and await one operation without cancelling its source future."""
        loop = self._bind_loop()
        requested_at = time.monotonic()
        try:
            await self._acquire()
        finally:
            with self._state_lock:
                self._admission_wait_seconds += time.monotonic() - requested_at

        source_future: Future[ResultT] | None = None
        try:
            with self._lifecycle_lock:
                if self._closed:
                    raise RuntimeError("provider lane is shut down")
                source_future = self._executor.submit_source(self._measure_operation(operation, requested_at))
                with self._state_lock:
                    self._submitted += 1
                source_future.add_done_callback(self._source_future_done)
        except BaseException:
            if source_future is None:
                self._release_unsubmitted()
            raise

        assert source_future is not None
        wrapped_future = asyncio.wrap_future(source_future, loop=loop)
        # Late provider failures still belong to the source future. Retrieve the
        # asyncio wrapper exception as well when the caller has already left.
        wrapped_future.add_done_callback(
            lambda future: None if future.cancelled() else future.exception()
        )
        try:
            done, _pending = await asyncio.wait(
                (wrapped_future,), timeout=self._operation_wait_timeout
            )
        except asyncio.CancelledError:
            # asyncio.wait does not cancel the futures it is watching, so the
            # source future remains responsible for its own capacity slot.
            with self._state_lock:
                self._cancelled += 1
            raise

        if not done:
            with self._state_lock:
                self._timed_out += 1
            self._log_metrics()
            raise ProviderLaneOperationTimeoutError(
                "provider operation exceeded its wait timeout"
            )

        # Keep this outside the caller-cancellation handler so an exception
        # raised by provider code, including TimeoutError or CancelledError,
        # propagates unchanged and is not misclassified as caller behavior.
        return wrapped_future.result()

    def record_request_timeout(self) -> None:
        """Count the owning request deadline, which may cancel a lane waiter."""
        with self._state_lock:
            self._timed_out += 1
        self._log_metrics()

    def _measure_operation(
        self, operation: Callable[[ResourceT], ResultT], requested_at: float
    ) -> Callable[[ResourceT], ResultT]:
        def run(resource: ResourceT) -> ResultT:
            started_at = time.monotonic()
            queue_wait = started_at - requested_at
            with self._state_lock:
                self._active += 1
                self._peak_active = max(self._peak_active, self._active)
                self._queue_wait_seconds += queue_wait
                self._max_queue_wait_seconds = max(self._max_queue_wait_seconds, queue_wait)
            try:
                return operation(resource)
            except TimeoutException:
                with self._state_lock:
                    self._transport_timed_out += 1
                raise
            finally:
                duration = time.monotonic() - started_at
                with self._state_lock:
                    self._active -= 1
                    self._operation_seconds += duration
                    self._max_operation_seconds = max(self._max_operation_seconds, duration)

        return run

    def _log_metrics(self) -> None:
        # One aggregate record per lane per minute, only when work changes.
        # No operation labels, studio/user identifiers, or provider payloads.
        now = time.monotonic()
        with self._state_lock:
            if now - self._last_metrics_at < 60.0:
                return
            self._last_metrics_at = now
        logger.info("provider_lane_metrics lane=%s counters=%s", self._name, asdict(self.snapshot()))

    def shutdown(self) -> None:
        """Reject new admission, then drain accepted work through the executor."""
        with self._lifecycle_lock:
            self._closed = True
            loop = self._loop

        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._wake_waiters)
        self._executor.shutdown()

    def _bind_loop(self) -> asyncio.AbstractEventLoop:
        loop = asyncio.get_running_loop()
        with self._lifecycle_lock:
            if self._loop is None:
                self._loop = loop
                self._wake_event = asyncio.Event()
            elif self._loop is not loop:
                raise RuntimeError("provider lane is bound to a different event loop")
        return loop

    async def _acquire(self) -> None:
        wake_event = self._wake_event
        assert wake_event is not None
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._queue_wait_timeout

        with self._state_lock:
            if self._closed:
                raise RuntimeError("provider lane is shut down")

        while True:
            with self._state_lock:
                if self._closed:
                    raise RuntimeError("provider lane is shut down")
                if self._available:
                    self._available -= 1
                    self._admitted += 1
                    return
                self._waiting += 1

            remaining = deadline - loop.time()
            if remaining <= 0:
                with self._state_lock:
                    self._waiting -= 1
                    self._saturated += 1
                self._log_metrics()
                raise ProviderLaneSaturatedError(
                    "provider lane queue capacity is saturated"
                )

            try:
                await asyncio.wait_for(wake_event.wait(), timeout=remaining)
            except asyncio.TimeoutError as exc:
                with self._state_lock:
                    self._waiting -= 1
                    self._saturated += 1
                self._log_metrics()
                raise ProviderLaneSaturatedError(
                    "provider lane queue capacity is saturated"
                ) from exc
            except asyncio.CancelledError:
                with self._state_lock:
                    self._waiting -= 1
                raise
            else:
                with self._state_lock:
                    self._waiting -= 1
                # A source completion or shutdown sets this event. Clearing it
                # after a successful wake lets later completions wake waiters.
                wake_event.clear()

    def _release_unsubmitted(self) -> None:
        with self._state_lock:
            self._available += 1
            self._admitted -= 1
        if self._wake_event is not None:
            self._wake_event.set()

    def _source_future_done(self, source_future: Future[ResultT]) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            self._complete_without_loop(source_future)
            return
        try:
            loop.call_soon_threadsafe(self._complete_on_loop, source_future)
        except RuntimeError:
            # The owning loop can close while timed-out work is still draining.
            # There is no asyncio waiter left to wake in that state, but the
            # plain accounting still must reflect actual source completion.
            self._complete_without_loop(source_future)

    def _complete_on_loop(self, source_future: Future[ResultT]) -> None:
        failed = False
        if not source_future.cancelled():
            failed = source_future.exception() is not None

        with self._state_lock:
            self._admitted -= 1
            self._available += 1
            self._completed += 1
            if failed:
                self._failed += 1

        self._log_metrics()
        wake_event = self._wake_event
        if wake_event is not None:
            wake_event.set()

    def _complete_without_loop(self, source_future: Future[ResultT]) -> None:
        failed = not source_future.cancelled() and source_future.exception() is not None
        with self._state_lock:
            self._admitted -= 1
            self._available += 1
            self._completed += 1
            if failed:
                self._failed += 1
        self._log_metrics()

    def _wake_waiters(self) -> None:
        wake_event = self._wake_event
        if wake_event is not None:
            wake_event.set()
