"""Thread-affine execution for synchronous provider resources."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Generic, TypeVar


ResourceT = TypeVar("ResourceT")
ResultT = TypeVar("ResultT")
_RESOURCE_UNSET = object()


class ProviderExecutorCleanupError(RuntimeError):
    """Raised after all worker threads have terminated but cleanup failed."""

    def __init__(self, failures: list[BaseException]) -> None:
        self.failures = tuple(failures)
        super().__init__(
            f"provider resource cleanup failed on {len(failures)} worker thread(s)"
        )


class ThreadAffineProviderExecutor(Generic[ResourceT]):
    """Own one lazily-created resource per executor worker thread."""

    def __init__(
        self,
        resource_factory: Callable[[], ResourceT],
        resource_closer: Callable[[ResourceT], None],
        *,
        max_workers: int,
        thread_name_prefix: str,
    ) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be positive")

        self._resource_factory = resource_factory
        self._resource_closer = resource_closer
        self._max_workers = max_workers
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix=thread_name_prefix,
        )
        self._thread_state = threading.local()
        self._state_lock = threading.Lock()
        self._closed = False
        self._shutdown_complete = threading.Event()

    async def submit(self, operation: Callable[[ResourceT], ResultT]) -> ResultT:
        """Run ``operation`` with the resource owned by its worker thread."""
        with self._state_lock:
            if self._closed:
                raise RuntimeError("provider executor is shut down")
            future = self._executor.submit(self._run_operation, operation)

        return await asyncio.wrap_future(future)

    def shutdown(self) -> None:
        """Reject new work, close resources on their owners, and stop workers."""
        with self._state_lock:
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

        cleanup_failures: list[BaseException] = []
        try:
            barrier = threading.Barrier(self._max_workers)
            cleanup_futures = [
                self._executor.submit(self._cleanup_on_worker, barrier)
                for _ in range(self._max_workers)
            ]
            for future in cleanup_futures:
                try:
                    future.result()
                except BaseException as exc:
                    cleanup_failures.append(exc)
        finally:
            # This must run even when a closer fails. It waits for every worker
            # to leave its cleanup task and terminates the executor threads.
            self._executor.shutdown(wait=True)
            self._shutdown_complete.set()

        if cleanup_failures:
            raise ProviderExecutorCleanupError(cleanup_failures) from cleanup_failures[0]

    def _run_operation(self, operation: Callable[[ResourceT], ResultT]) -> ResultT:
        resource = getattr(self._thread_state, "resource", _RESOURCE_UNSET)
        if resource is _RESOURCE_UNSET:
            resource = self._resource_factory()
            self._thread_state.resource = resource
        return operation(resource)

    def _cleanup_on_worker(self, barrier: threading.Barrier) -> None:
        # The barrier makes the one-task-per-worker assumption explicit: no
        # worker can finish cleanup and consume another cleanup task until all
        # configured workers have reached this point.
        barrier.wait()
        resource = getattr(self._thread_state, "resource", _RESOURCE_UNSET)
        if resource is not _RESOURCE_UNSET:
            del self._thread_state.resource
            self._resource_closer(resource)
