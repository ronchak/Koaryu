from __future__ import annotations

import asyncio
import threading
from concurrent.futures import Future

import pytest

from app.core.provider_executor import (
    ProviderExecutorCleanupError,
    ThreadAffineProviderExecutor,
)


def test_slow_operation_does_not_block_event_loop_heartbeat():
    started = threading.Event()
    release = threading.Event()
    heartbeat_ticks: list[int] = []

    def provider(_resource: object) -> str:
        started.set()
        assert release.wait(2)
        return "done"

    async def heartbeat() -> None:
        while not release.is_set():
            heartbeat_ticks.append(1)
            await asyncio.sleep(0)

    async def scenario() -> None:
        executor = ThreadAffineProviderExecutor(
            lambda: object(),
            lambda _resource: None,
            max_workers=1,
            thread_name_prefix="provider-heartbeat",
        )
        try:
            operation = asyncio.create_task(executor.submit(provider))
            assert await asyncio.to_thread(started.wait, 2)
            heartbeat_task = asyncio.create_task(heartbeat())
            await asyncio.sleep(0.01)
            assert heartbeat_ticks
            release.set()
            assert await operation == "done"
            await heartbeat_task
        finally:
            release.set()
            executor.shutdown()

    asyncio.run(scenario())


def test_submit_source_returns_the_underlying_future():
    executor = ThreadAffineProviderExecutor(
        object,
        lambda _resource: None,
        max_workers=1,
        thread_name_prefix="provider-source-future",
    )
    try:
        source_future = executor.submit_source(lambda _resource: "done")
        assert isinstance(source_future, Future)
        assert source_future.result(timeout=2) == "done"
    finally:
        executor.shutdown()


def test_resources_are_created_reused_and_closed_on_their_own_threads():
    created: list[tuple[int, int]] = []
    used: list[tuple[int, int]] = []
    closed: list[tuple[int, int]] = []
    lock = threading.Lock()
    first_wave_started = threading.Event()
    first_wave_count = 0
    next_resource = 0

    def factory() -> dict[str, int]:
        nonlocal next_resource
        with lock:
            next_resource += 1
            resource = {"id": next_resource, "created_thread": threading.get_ident()}
            created.append((resource["id"], resource["created_thread"]))
            return resource

    def closer(resource: dict[str, int]) -> None:
        with lock:
            closed.append((resource["id"], threading.get_ident()))

    def operation(resource: dict[str, int]) -> tuple[int, int]:
        nonlocal first_wave_count
        observation = (resource["id"], threading.get_ident())
        with lock:
            used.append(observation)
            first_wave_count += 1
            wave_number = first_wave_count
        if wave_number <= 2:
            if wave_number == 2:
                first_wave_started.set()
            assert first_wave_started.wait(2)
        return observation

    async def scenario() -> None:
        executor = ThreadAffineProviderExecutor(
            factory,
            closer,
            max_workers=2,
            thread_name_prefix="provider-affinity",
        )
        try:
            results = await asyncio.gather(
                executor.submit(operation),
                executor.submit(operation),
            )
            await asyncio.gather(
                executor.submit(operation),
                executor.submit(operation),
            )
        finally:
            executor.shutdown()

        assert len(created) == 2
        assert len(closed) == 2
        assert {resource_id for resource_id, _ in created} == {
            resource_id for resource_id, _ in closed
        }
        assert {thread_id for _, thread_id in created} == {
            thread_id for _, thread_id in closed
        }
        assert all(
            created_thread == used_thread
            for resource_id, created_thread in created
            for used_resource_id, used_thread in used
            if resource_id == used_resource_id
        )
        assert all(
            created_thread == closed_thread
            for resource_id, created_thread in created
            for closed_resource_id, closed_thread in closed
            if resource_id == closed_resource_id
        )

    asyncio.run(scenario())


def test_operation_error_reaches_caller_and_worker_is_reused_before_cleanup():
    calls: list[tuple[str, int]] = []
    closed: list[int] = []

    def operation(resource: object) -> str:
        calls.append(("operation", threading.get_ident()))
        if len(calls) == 1:
            raise ValueError("provider failed")
        return "recovered"

    def closer(_resource: object) -> None:
        closed.append(threading.get_ident())

    async def scenario() -> None:
        executor = ThreadAffineProviderExecutor(
            object,
            closer,
            max_workers=1,
            thread_name_prefix="provider-reuse",
        )
        try:
            with pytest.raises(ValueError, match="provider failed"):
                await executor.submit(operation)
            assert await executor.submit(operation) == "recovered"
        finally:
            executor.shutdown()

    asyncio.run(scenario())
    assert len(calls) == 2
    assert len(closed) == 1
    assert calls[0][1] == calls[1][1] == closed[0]


def test_shutdown_rejects_work_and_is_idempotent():
    executor = ThreadAffineProviderExecutor(
        object,
        lambda _resource: None,
        max_workers=1,
        thread_name_prefix="provider-shutdown",
    )
    executor.shutdown()
    executor.shutdown()

    async def scenario() -> None:
        with pytest.raises(RuntimeError, match="shut down"):
            await executor.submit(lambda _resource: None)

    asyncio.run(scenario())


def test_closer_failure_is_reported_after_worker_threads_terminate():
    prefix = "provider-closer-failure"
    worker_threads: list[int] = []
    operation_barrier = threading.Barrier(2)

    def operation(_resource: object) -> int:
        worker_threads.append(threading.get_ident())
        operation_barrier.wait(2)
        return threading.get_ident()

    def closer(_resource: object) -> None:
        raise OSError("close failed")

    executor = ThreadAffineProviderExecutor(
        object,
        closer,
        max_workers=2,
        thread_name_prefix=prefix,
    )

    async def scenario() -> None:
        await asyncio.gather(
            executor.submit(operation),
            executor.submit(operation),
        )

    asyncio.run(scenario())
    with pytest.raises(ProviderExecutorCleanupError, match="cleanup failed") as raised:
        executor.shutdown()

    assert len(raised.value.failures) == 2
    assert all(
        thread.ident not in worker_threads
        for thread in threading.enumerate()
        if thread.name.startswith(prefix)
    )
    executor.shutdown()
