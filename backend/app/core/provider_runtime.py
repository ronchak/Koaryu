"""Thread-affine Supabase provider lanes."""

from __future__ import annotations

import asyncio
import inspect
import math
import threading
from dataclasses import dataclass
from functools import partial
from typing import Awaitable, Callable, Generic, TypeVar, cast

from supabase import Client

from app.core.provider_executor import ThreadAffineProviderExecutor
from app.core.provider_lane import ProviderLane, ProviderLaneSnapshot
from app.db.supabase import close_supabase_client, create_supabase_client


ResultT = TypeVar("ResultT")


@dataclass(frozen=True, slots=True)
class SupabaseLaneConfig:
    """Explicit immutable admission settings for one provider lane."""

    max_workers: int
    max_queue: int
    queue_wait_timeout: float
    operation_wait_timeout: float
    postgrest_client_timeout: float = 10.0

    def __post_init__(self) -> None:
        if not math.isfinite(self.postgrest_client_timeout) or self.postgrest_client_timeout <= 0:
            raise ValueError("postgrest_client_timeout must be finite and positive")


class SupabaseProviderRuntimeCleanupError(RuntimeError):
    """Raised after both provider lanes have attempted shutdown."""

    def __init__(self, failures: list[BaseException]) -> None:
        self.failures = tuple(failures)
        self.causes = self.failures
        super().__init__(
            f"supabase provider runtime cleanup failed for {len(failures)} lane(s)"
        )


Operation = Callable[[Client], ResultT | Awaitable[ResultT]]


class SupabaseProviderRuntime(Generic[ResultT]):
    """Own independent interactive and bulk Supabase execution lanes."""

    def __init__(
        self,
        interactive: SupabaseLaneConfig,
        bulk: SupabaseLaneConfig,
        *,
        client_factory: Callable[[], Client] | None = None,
        client_closer: Callable[[Client], None] = close_supabase_client,
        thread_name_prefix: str = "supabase-provider",
    ) -> None:
        self._lifecycle_lock = threading.Lock()
        self._shutdown_complete = threading.Event()
        self._closed = False

        interactive_executor: ThreadAffineProviderExecutor[Client] | None = None
        bulk_executor: ThreadAffineProviderExecutor[Client] | None = None
        try:
            interactive_executor = self._build_executor(
                interactive,
                client_factory or partial(
                    create_supabase_client,
                    postgrest_client_timeout=interactive.postgrest_client_timeout,
                ),
                client_closer,
                f"{thread_name_prefix}-interactive",
            )
            bulk_executor = self._build_executor(
                bulk,
                client_factory or partial(
                    create_supabase_client,
                    postgrest_client_timeout=bulk.postgrest_client_timeout,
                ),
                client_closer,
                f"{thread_name_prefix}-bulk",
            )
            self._interactive_lane = ProviderLane(
                interactive_executor,
                max_queue=interactive.max_queue,
                queue_wait_timeout=interactive.queue_wait_timeout,
                operation_wait_timeout=interactive.operation_wait_timeout,
                name="interactive",
            )
            self._bulk_lane = ProviderLane(
                bulk_executor,
                max_queue=bulk.max_queue,
                queue_wait_timeout=bulk.queue_wait_timeout,
                operation_wait_timeout=bulk.operation_wait_timeout,
                name="bulk",
            )
        except BaseException:
            if bulk_executor is not None:
                bulk_executor.shutdown()
            if interactive_executor is not None:
                interactive_executor.shutdown()
            raise

    @staticmethod
    def _build_executor(
        config: SupabaseLaneConfig,
        client_factory: Callable[[], Client],
        client_closer: Callable[[Client], None],
        thread_name_prefix: str,
    ) -> ThreadAffineProviderExecutor[Client]:
        return ThreadAffineProviderExecutor(
            client_factory,
            client_closer,
            max_workers=config.max_workers,
            thread_name_prefix=thread_name_prefix,
        )

    async def run_interactive(self, operation: Operation[ResultT]) -> ResultT:
        self._ensure_open()
        return await self._interactive_lane.submit(self._on_worker(operation))

    async def run_bulk(self, operation: Operation[ResultT]) -> ResultT:
        self._ensure_open()
        return await self._bulk_lane.submit(self._on_worker(operation))

    def interactive_snapshot(self) -> ProviderLaneSnapshot:
        return self._interactive_lane.snapshot()

    def bulk_snapshot(self) -> ProviderLaneSnapshot:
        return self._bulk_lane.snapshot()

    def record_request_timeout(self, lane: str) -> None:
        if lane == "interactive":
            self._interactive_lane.record_request_timeout()
        elif lane == "bulk":
            self._bulk_lane.record_request_timeout()
        else:
            raise ValueError(f"unknown provider lane: {lane}")

    def operation_wait_timeout(self, lane: str) -> float:
        """Return the full caller deadline for one request-boundary operation."""
        if lane == "interactive":
            return self._interactive_lane.operation_wait_timeout
        if lane == "bulk":
            return self._bulk_lane.operation_wait_timeout
        raise ValueError(f"unknown provider lane: {lane}")

    def shutdown(self) -> None:
        """Reject work, drain both lanes, and report every shutdown failure."""
        with self._lifecycle_lock:
            if self._closed:
                wait_for_shutdown = not self._shutdown_complete.is_set()
                owns_shutdown = False
            else:
                self._closed = True
                wait_for_shutdown = False
                owns_shutdown = True

        if wait_for_shutdown:
            self._shutdown_complete.wait()
            return
        if not owns_shutdown:
            return

        failures: list[BaseException] = []
        try:
            for lane in (self._interactive_lane, self._bulk_lane):
                try:
                    lane.shutdown()
                except BaseException as exc:
                    failures.append(exc)
        finally:
            self._shutdown_complete.set()

        if failures:
            raise SupabaseProviderRuntimeCleanupError(failures) from failures[0]

    def _ensure_open(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                raise RuntimeError("supabase provider runtime is shut down")

    @staticmethod
    def _on_worker(operation: Operation[ResultT]) -> Callable[[Client], ResultT]:
        def invoke(client: Client) -> ResultT:
            result = operation(client)
            if not inspect.isawaitable(result):
                return result
            return asyncio.run(_await_result(cast(Awaitable[ResultT], result)))

        return invoke


async def _await_result(result: Awaitable[ResultT]) -> ResultT:
    return await result
