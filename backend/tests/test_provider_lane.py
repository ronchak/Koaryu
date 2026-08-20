from __future__ import annotations

import asyncio
import threading

import pytest

from app.core.provider_executor import ThreadAffineProviderExecutor
from app.core.provider_lane import (
    ProviderLane,
    ProviderLaneOperationTimeoutError,
    ProviderLaneSaturatedError,
)


def make_executor(*, max_workers: int = 1) -> ThreadAffineProviderExecutor[object]:
    return ThreadAffineProviderExecutor(
        object,
        lambda _resource: None,
        max_workers=max_workers,
        thread_name_prefix="provider-lane-test",
    )


def test_capacity_is_bounded_and_saturation_does_not_submit() -> None:
    started = threading.Event()
    release = threading.Event()
    calls = 0

    def operation(_resource: object) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            assert release.wait(2)
        return calls

    async def scenario() -> None:
        executor = make_executor()
        lane = ProviderLane(
            executor,
            max_queue=1,
            queue_wait_timeout=0.05,
            operation_wait_timeout=2,
        )
        first = asyncio.create_task(lane.submit(operation))
        assert await asyncio.to_thread(started.wait, 2)
        second = asyncio.create_task(lane.submit(operation))
        await asyncio.sleep(0)

        with pytest.raises(ProviderLaneSaturatedError):
            await lane.submit(operation)

        assert calls == 1
        snapshot = lane.snapshot()
        assert snapshot.admitted == 2
        assert snapshot.waiting == 0
        assert snapshot.submitted == 2
        assert snapshot.saturated == 1

        release.set()
        assert await first == 1
        assert await second == 2
        await asyncio.sleep(0)
        assert lane.snapshot().admitted == 0
        await asyncio.to_thread(lane.shutdown)

    asyncio.run(scenario())


def test_queue_timeout_deadline_is_not_reset_by_repeated_wakeups() -> None:
    started = threading.Event()
    release = threading.Event()

    def operation(_resource: object) -> str:
        started.set()
        assert release.wait(2)
        return "done"

    async def scenario() -> None:
        executor = make_executor()
        lane = ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=0.08,
            operation_wait_timeout=1,
        )
        first = asyncio.create_task(lane.submit(operation))
        assert await asyncio.to_thread(started.wait, 2)
        waiter = asyncio.create_task(lane.submit(lambda _resource: "queued"))
        await asyncio.sleep(0)

        async def repeatedly_wake_waiter() -> None:
            for _ in range(40):
                if waiter.done():
                    return
                # Synthetic wakeups model completions that notify the lane but
                # do not make capacity available to this losing waiter.
                lane._wake_waiters()
                await asyncio.sleep(0.01)

        wake_task = asyncio.create_task(repeatedly_wake_waiter())
        started_waiting = asyncio.get_running_loop().time()
        try:
            with pytest.raises(ProviderLaneSaturatedError):
                await waiter
            elapsed = asyncio.get_running_loop().time() - started_waiting
            assert elapsed < 0.25
        finally:
            release.set()
            assert await first == "done"
            await wake_task
            await asyncio.to_thread(lane.shutdown)

    asyncio.run(scenario())


def test_operation_timeout_keeps_capacity_until_source_completion() -> None:
    started = threading.Event()
    release = threading.Event()

    def operation(_resource: object) -> str:
        started.set()
        assert release.wait(2)
        return "done"

    async def scenario() -> None:
        executor = make_executor()
        lane = ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=0.05,
        )
        with pytest.raises(ProviderLaneOperationTimeoutError):
            await lane.submit(operation)

        timed_out = lane.snapshot()
        assert timed_out.admitted == 1
        assert timed_out.completed == 0
        assert timed_out.timed_out == 1

        release.set()
        for _ in range(20):
            if lane.snapshot().completed == 1:
                break
            await asyncio.sleep(0.01)
        completed = lane.snapshot()
        assert completed.admitted == 0
        assert completed.completed == 1
        await asyncio.to_thread(lane.shutdown)

    asyncio.run(scenario())


def test_caller_cancellation_keeps_capacity_until_source_completion() -> None:
    started = threading.Event()
    release = threading.Event()

    def operation(_resource: object) -> str:
        started.set()
        assert release.wait(2)
        return "done"

    async def scenario() -> None:
        executor = make_executor()
        lane = ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=2,
        )
        task = asyncio.create_task(lane.submit(operation))
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        cancelled = lane.snapshot()
        assert cancelled.admitted == 1
        assert cancelled.completed == 0
        assert cancelled.cancelled == 1

        release.set()
        for _ in range(20):
            if lane.snapshot().completed == 1:
                break
            await asyncio.sleep(0.01)
        completed = lane.snapshot()
        assert completed.admitted == 0
        assert completed.completed == 1
        await asyncio.to_thread(lane.shutdown)

    asyncio.run(scenario())


def test_result_exception_and_completion_counters_are_exact() -> None:
    calls = 0

    def operation(_resource: object) -> str:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ValueError("provider failed")
        return "ok"

    async def scenario() -> None:
        executor = make_executor()
        lane = ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=1,
        )
        assert await lane.submit(operation) == "ok"
        with pytest.raises(ValueError, match="provider failed"):
            await lane.submit(operation)
        await asyncio.sleep(0)

        snapshot = lane.snapshot()
        assert snapshot.submitted == 2
        assert snapshot.completed == 2
        assert snapshot.failed == 1
        assert snapshot.timed_out == 0
        assert snapshot.cancelled == 0
        await asyncio.to_thread(lane.shutdown)

    asyncio.run(scenario())


def test_provider_timeout_exception_is_not_reclassified_as_lane_timeout() -> None:
    def operation(_resource: object) -> None:
        raise TimeoutError("provider timeout")

    async def scenario() -> None:
        executor = make_executor()
        lane = ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=1,
        )
        with pytest.raises(TimeoutError, match="provider timeout") as raised:
            await lane.submit(operation)
        assert type(raised.value) is TimeoutError
        await asyncio.sleep(0)
        snapshot = lane.snapshot()
        assert snapshot.completed == 1
        assert snapshot.failed == 1
        assert snapshot.timed_out == 0
        await asyncio.to_thread(lane.shutdown)

    asyncio.run(scenario())


def test_separate_lanes_are_isolated() -> None:
    bulk_started = threading.Event()
    bulk_release = threading.Event()

    def bulk_operation(_resource: object) -> str:
        bulk_started.set()
        assert bulk_release.wait(2)
        return "bulk"

    async def scenario() -> None:
        bulk_executor = make_executor()
        interactive_executor = make_executor()
        bulk = ProviderLane(
            bulk_executor,
            max_queue=0,
            queue_wait_timeout=0.05,
            operation_wait_timeout=2,
        )
        interactive = ProviderLane(
            interactive_executor,
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=1,
        )
        bulk_task = asyncio.create_task(bulk.submit(bulk_operation))
        assert await asyncio.to_thread(bulk_started.wait, 2)

        with pytest.raises(ProviderLaneSaturatedError):
            await bulk.submit(lambda _resource: "queued")
        assert await interactive.submit(lambda _resource: "interactive") == "interactive"

        bulk_release.set()
        assert await bulk_task == "bulk"
        await asyncio.sleep(0)
        await asyncio.gather(
            asyncio.to_thread(bulk.shutdown),
            asyncio.to_thread(interactive.shutdown),
        )

    asyncio.run(scenario())


def test_shutdown_rejects_new_work_and_is_idempotent() -> None:
    async def scenario() -> None:
        lane = ProviderLane(
            make_executor(),
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=1,
        )
        await asyncio.to_thread(lane.shutdown)
        await asyncio.to_thread(lane.shutdown)
        with pytest.raises(RuntimeError, match="shut down"):
            await lane.submit(lambda _resource: None)

    asyncio.run(scenario())


def test_invalid_configuration_and_cross_loop_use_are_rejected() -> None:
    executor = make_executor()
    with pytest.raises(ValueError, match="max_queue"):
        ProviderLane(
            executor,
            max_queue=-1,
            queue_wait_timeout=1,
            operation_wait_timeout=1,
        )
    with pytest.raises(ValueError, match="queue_wait_timeout"):
        ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=0,
            operation_wait_timeout=1,
        )
    with pytest.raises(ValueError, match="operation_wait_timeout"):
        ProviderLane(
            executor,
            max_queue=0,
            queue_wait_timeout=1,
            operation_wait_timeout=0,
        )

    lane = ProviderLane(
        executor,
        max_queue=0,
        queue_wait_timeout=1,
        operation_wait_timeout=1,
    )

    async def bind() -> None:
        assert await lane.submit(lambda _resource: "bound") == "bound"

    asyncio.run(bind())

    async def use_other_loop() -> None:
        with pytest.raises(RuntimeError, match="different event loop"):
            await lane.submit(lambda _resource: "wrong loop")

    asyncio.run(use_other_loop())
    executor.shutdown()
