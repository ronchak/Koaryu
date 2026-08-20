from __future__ import annotations

import asyncio
import threading
from dataclasses import FrozenInstanceError

import pytest

from app.core.provider_executor import ProviderExecutorCleanupError
from app.core.provider_lane import ProviderLaneSaturatedError
from app.core.provider_runtime import (
    SupabaseLaneConfig,
    SupabaseProviderRuntime,
    SupabaseProviderRuntimeCleanupError,
)
from app.db.supabase import close_supabase_client


def config(
    *,
    max_workers: int = 1,
    max_queue: int = 0,
    queue_wait_timeout: float = 1,
    operation_wait_timeout: float = 2,
) -> SupabaseLaneConfig:
    return SupabaseLaneConfig(
        max_workers=max_workers,
        max_queue=max_queue,
        queue_wait_timeout=queue_wait_timeout,
        operation_wait_timeout=operation_wait_timeout,
    )


def test_lane_config_is_immutable_and_runtime_validates_through_lane_constructors():
    lane_config = config()
    with pytest.raises(FrozenInstanceError):
        lane_config.max_queue = 1  # type: ignore[misc]

    with pytest.raises(ValueError, match="max_queue"):
        SupabaseProviderRuntime(config(max_queue=-1), config())


def test_sync_and_awaitable_operations_reuse_one_client_and_thread():
    created: list[tuple[int, int]] = []
    used: list[tuple[str, int, int]] = []
    closed: list[tuple[int, int]] = []
    next_client = 0
    lock = threading.Lock()

    def factory() -> dict[str, int]:
        nonlocal next_client
        with lock:
            next_client += 1
            client = {"id": next_client, "created_thread": threading.get_ident()}
            created.append((client["id"], client["created_thread"]))
            return client

    def closer(client: dict[str, int]) -> None:
        closed.append((client["id"], threading.get_ident()))

    def sync_operation(client: dict[str, int]) -> str:
        used.append(("sync", client["id"], threading.get_ident()))
        return "sync-result"

    async def awaitable_operation(client: dict[str, int]) -> str:
        used.append(("await-start", client["id"], threading.get_ident()))
        await asyncio.sleep(0)
        used.append(("await-end", client["id"], threading.get_ident()))
        return "await-result"

    async def scenario() -> None:
        runtime = SupabaseProviderRuntime(
            config(),
            config(),
            client_factory=factory,
            client_closer=closer,
            thread_name_prefix="runtime-affinity",
        )
        try:
            assert await runtime.run_interactive(sync_operation) == "sync-result"
            assert await runtime.run_interactive(awaitable_operation) == "await-result"
            assert runtime.interactive_snapshot().submitted == 2
            assert runtime.interactive_snapshot().completed == 2
        finally:
            runtime.shutdown()

    asyncio.run(scenario())

    assert len(created) == 1
    assert len(closed) == 1
    client_id, created_thread = created[0]
    assert closed == [(client_id, created_thread)]
    assert all(client == client_id and thread == created_thread for _, client, thread in used)


def test_supabase_transport_cleanup_stays_on_client_owner_thread():
    created: list[int] = []
    operations: list[int] = []
    closed: list[tuple[str, int]] = []

    class Transport:
        def __init__(self, name: str):
            self.name = name

        def close(self) -> None:
            closed.append((self.name, threading.get_ident()))

        def aclose(self) -> None:
            self.close()

    class FakeClient:
        def __init__(self) -> None:
            self.auth = Transport("auth")
            self._postgrest = Transport("postgrest")
            self._storage = Transport("storage")
            self._functions = type("Functions", (), {"_client": Transport("functions")})()

    def factory() -> FakeClient:
        created.append(threading.get_ident())
        return FakeClient()

    async def scenario() -> None:
        runtime = SupabaseProviderRuntime(
            config(),
            config(),
            client_factory=factory,
            client_closer=close_supabase_client,
            thread_name_prefix="runtime-transport-affinity",
        )
        try:
            assert await runtime.run_interactive(
                lambda _client: operations.append(threading.get_ident()) or "ok"
            ) == "ok"
        finally:
            runtime.shutdown()

    asyncio.run(scenario())

    assert len(created) == 1
    assert operations == created
    assert sorted(name for name, _thread in closed) == [
        "auth",
        "functions",
        "postgrest",
        "storage",
    ]
    assert all(thread == created[0] for _name, thread in closed)


def test_bulk_saturation_does_not_block_interactive_lane_or_event_loop():
    bulk_started = threading.Event()
    bulk_release = threading.Event()
    heartbeat_ticks = 0

    def bulk_operation(_client: object) -> str:
        bulk_started.set()
        assert bulk_release.wait(2)
        return "bulk"

    async def heartbeat() -> None:
        nonlocal heartbeat_ticks
        while not bulk_release.is_set():
            heartbeat_ticks += 1
            await asyncio.sleep(0)

    async def scenario() -> None:
        runtime = SupabaseProviderRuntime(
            config(queue_wait_timeout=0.05),
            config(queue_wait_timeout=0.05),
            client_factory=object,
            client_closer=lambda _client: None,
            thread_name_prefix="runtime-isolation",
        )
        try:
            bulk_task = asyncio.create_task(runtime.run_bulk(bulk_operation))
            assert await asyncio.to_thread(bulk_started.wait, 2)
            with pytest.raises(ProviderLaneSaturatedError):
                await runtime.run_bulk(lambda _client: "queued")

            heartbeat_task = asyncio.create_task(heartbeat())
            assert await runtime.run_interactive(lambda _client: "interactive") == "interactive"
            assert heartbeat_ticks

            bulk_release.set()
            assert await bulk_task == "bulk"
            await heartbeat_task
        finally:
            bulk_release.set()
            runtime.shutdown()

    asyncio.run(scenario())


def test_provider_errors_propagate_and_shutdown_rejects_and_is_idempotent():
    async def scenario() -> None:
        runtime = SupabaseProviderRuntime(
            config(),
            config(),
            client_factory=object,
            client_closer=lambda _client: None,
            thread_name_prefix="runtime-errors",
        )
        with pytest.raises(ValueError, match="provider failure"):
            await runtime.run_interactive(lambda _client: (_ for _ in ()).throw(ValueError("provider failure")))

        runtime.shutdown()
        runtime.shutdown()
        with pytest.raises(RuntimeError, match="shut down"):
            await runtime.run_bulk(lambda _client: None)

    asyncio.run(scenario())


def test_shutdown_attempts_both_lanes_and_reports_cleanup_failures():
    def failing_closer(_client: object) -> None:
        raise OSError("transport close failed")

    async def scenario() -> None:
        runtime = SupabaseProviderRuntime(
            config(),
            config(),
            client_factory=object,
            client_closer=failing_closer,
            thread_name_prefix="runtime-cleanup",
        )
        await runtime.run_interactive(lambda _client: "interactive")
        await runtime.run_bulk(lambda _client: "bulk")

        with pytest.raises(SupabaseProviderRuntimeCleanupError) as raised:
            runtime.shutdown()

        assert len(raised.value.failures) == 2
        assert all(
            isinstance(failure, ProviderExecutorCleanupError)
            for failure in raised.value.failures
        )
        runtime.shutdown()

    asyncio.run(scenario())
