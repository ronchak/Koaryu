"""Real loopback HTTP faults through the locked Supabase SDK and owned lane."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from statistics import median
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.core.deps import run_supabase_operation
from app.core.provider_lane import ProviderLaneOperationTimeoutError, ProviderLaneSaturatedError
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime


@pytest.fixture
def provider_server():
    release = threading.Event()
    arrived = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            arrived.set()
            if "/stall_headers" in self.path:
                release.wait(2)
                return
            if "/stall_body" in self.path:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.write(b"[")
                self.wfile.flush()
                release.wait(2)
                return
            time.sleep(0.01)
            payload = b'[{"ok":true}]'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    # This fixture exclusively points the production factory at an ephemeral
    # loopback server. Target/credential validation has its own dedicated suite.
    settings = SimpleNamespace(
        SUPABASE_URL=f"http://127.0.0.1:{server.server_port}",
        SUPABASE_SERVICE_ROLE_KEY="header.payload.signature",
        validate_supabase_service_role_configuration=lambda: None,
    )
    with patch("app.db.supabase.get_settings", return_value=settings):
        yield arrived
    release.set()
    server.shutdown()
    server.server_close()
    thread.join()


def config(*, workers=1, queue=0, caller=2, transport=0.12):
    return SupabaseLaneConfig(
        max_workers=workers, max_queue=queue, queue_wait_timeout=0.02,
        operation_wait_timeout=caller, postgrest_client_timeout=transport,
    )


@pytest.mark.parametrize("table", ["stall_headers", "stall_body"])
def test_postgrest_stalls_end_and_capacity_recovers_only_when_work_finishes(provider_server, table):
    async def scenario():
        runtime = SupabaseProviderRuntime(config(caller=0.035), config())
        try:
            # Warm client construction so the caller deadline isolates HTTP I/O.
            await runtime.run_interactive(lambda client: client.options.postgrest_client_timeout)
            started = time.monotonic()
            with pytest.raises(ProviderLaneOperationTimeoutError):
                await runtime.run_interactive(lambda client: client.table(table).select("*").execute())
            assert provider_server.is_set()
            pending = runtime.interactive_snapshot()
            assert pending.active == pending.admitted == 1
            assert pending.timed_out == 1
            assert pending.transport_timed_out == 0
            with pytest.raises(ProviderLaneSaturatedError):
                await runtime.run_interactive(lambda _client: None)
            while runtime.interactive_snapshot().admitted:
                assert time.monotonic() - started < 1.5
                await asyncio.sleep(0.005)
            ended = runtime.interactive_snapshot()
            assert ended.active == 0
            assert ended.transport_timed_out == ended.failed == 1
            assert ended.completed == 2
            assert ended.operation_seconds >= 0.1
            assert await runtime.run_interactive(lambda client: client.table("healthy").select("*").execute().data) == [{"ok": True}]
        finally:
            runtime.shutdown()
    asyncio.run(scenario())


def test_runtime_applies_independent_transport_budgets_and_normalizes_timeout(provider_server):
    async def scenario():
        runtime = SupabaseProviderRuntime(config(transport=0.08), config(transport=0.25))
        try:
            interactive = await runtime.run_interactive(lambda client: client.postgrest.session.timeout.read)
            bulk = await runtime.run_bulk(lambda client: client.postgrest.session.timeout.read)
            assert (interactive, bulk) == (0.08, 0.25)
            with pytest.raises(HTTPException) as error:
                await run_supabase_operation(runtime, lambda client: client.table("stall_body").select("*").execute())
            assert error.value.status_code == 504
            assert error.value.detail == "Provider operation timed out."
        finally:
            runtime.shutdown()
    asyncio.run(scenario())


@pytest.mark.parametrize("sessions", [1, 3, 10])
@pytest.mark.parametrize("scope", ["same_studio", "different_studios"])
def test_mixed_concurrency_records_bounded_metrics(provider_server, sessions, scope):
    async def scenario():
        runtime = SupabaseProviderRuntime(config(workers=4, queue=16, transport=1), config(transport=1))
        latencies = []
        try:
            async def session(index):
                started = time.monotonic()
                studio = "studio-0" if scope == "same_studio" else f"studio-{index}"
                # Vary work length, keeping tenant data inside the test request.
                def read(client):
                    for _ in range(1 + index % 3):
                        assert client.table("healthy").select("*").eq("studio_id", studio).execute().data == [{"ok": True}]
                await run_supabase_operation(runtime, read)
                latencies.append((time.monotonic() - started) * 1000)
            await asyncio.gather(*(session(index) for index in range(sessions)))
            snapshot = runtime.interactive_snapshot()
            assert snapshot.submitted == snapshot.completed == sessions
            assert snapshot.admitted == snapshot.active == snapshot.failed == snapshot.timed_out == snapshot.saturated == 0
            assert 1 <= snapshot.peak_active <= min(4, sessions)
            assert snapshot.operation_seconds > 0
            assert snapshot.queue_wait_seconds >= snapshot.admission_wait_seconds
            print(json.dumps({
                "scenario": "synthetic_loopback_provider", "scope": scope, "sessions": sessions,
                "median_ms": round(median(latencies), 2), "min_ms": round(min(latencies), 2),
                "max_ms": round(max(latencies), 2), "metrics": asdict(snapshot),
            }, sort_keys=True))
        finally:
            runtime.shutdown()
    asyncio.run(scenario())
