from __future__ import annotations

import asyncio
import resource
import threading
import time
import tracemalloc
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.reports import export_report_csv
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.services.report_export_budget import ReportExportBudget
from app.services.report_export_catalog_types import CsvReport
from app.services.report_export_service import (
    EXPORT_SPOOL_MAX_MEMORY_BYTES,
    EXPORT_STREAM_CHUNK_BYTES,
    ReportExportService,
)
from tests.fakes.supabase import TableBackedSupabase


def _report(*, builder=None, table=None, columns=("id", "note")) -> CsvReport:
    return CsvReport(
        id="test-report",
        title="Test report",
        filename="test-report.csv",
        columns=columns,
        source_keys=(),
        table=table,
        custom_builder=builder,
    )


class _SpoolTracker:
    def __init__(self, real_factory):
        self.real_factory = real_factory
        self.instances = []

    def __call__(self, *args, **kwargs):
        instance = self.real_factory(*args, **kwargs)
        self.instances.append(instance)
        return instance


def _build(service: ReportExportService, report: CsvReport):
    return asyncio.run(service.build_csv_artifact_for_report(report, "studio-1"))


async def _consume_artifact(artifact):
    chunks = []
    for chunk in artifact.stream():
        chunks.append(chunk)
    return b"".join(chunks)


async def _consume_response(response):
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


def test_exact_fetched_and_output_boundary_preserves_quoted_newline_bytes():
    rows = [
        {
            "id": f"row-{index:05d}",
            "studio_id": "studio-1",
            "note": "line1\nline2" if index == 0 else "ok",
        }
        for index in range(50_000)
    ]
    report = _report(table="export_rows", columns=("id", "studio_id", "note"))
    service = ReportExportService(TableBackedSupabase({"export_rows": rows}))

    artifact = _build(service, report)

    assert artifact.emitted_data_rows == 50_000
    assert artifact.budget.fetched_rows == 50_000
    assert not artifact.spool_closed
    body = asyncio.run(_consume_artifact(artifact))
    assert body.startswith(b"id,studio_id,note\r\n")
    assert b'"line1\nline2"' in body
    assert body.endswith(b"\r\n")
    assert artifact.spool_closed

    too_many = rows + [{"id": "row-over", "studio_id": "studio-1", "note": "over"}]
    failure_service = ReportExportService(
        TableBackedSupabase({"export_rows": too_many})
    )
    with pytest.raises(HTTPException) as raised:
        _build(failure_service, report)
    assert raised.value.status_code == 413
    assert raised.value.detail == (
        "Export is too large. Apply filters or request an async export."
    )
    assert failure_service.budget_snapshot.fetched_rows == 50_001

    endpoint_supabase = TableBackedSupabase({
        "students": [
            {"id": f"student-{index:05d}", "studio_id": "studio-1"}
            for index in range(50_001)
        ],
        "audit_logs": [],
    })
    with (
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
        pytest.raises(HTTPException) as endpoint_raised,
    ):
        asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=endpoint_supabase,
        ))
    assert endpoint_raised.value.status_code == 413
    assert endpoint_supabase.tables["audit_logs"] == []


def test_spool_rolls_over_and_closes_on_success_and_output_row_failure():
    rows = [
        {"id": str(index), "note": "x" * 64}
        for index in range(20_000)
    ]
    report = _report(builder=lambda _service, _studio_id: rows)
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    tracker = _SpoolTracker(real_factory)

    with patch(
        "app.services.report_export_service.tempfile.SpooledTemporaryFile",
        tracker,
    ):
        artifact = _build(ReportExportService(TableBackedSupabase({})), report)

    assert artifact.output_bytes > EXPORT_SPOOL_MAX_MEMORY_BYTES
    assert artifact.spool_threshold_bytes == EXPORT_SPOOL_MAX_MEMORY_BYTES
    assert artifact.spool_rolled
    assert not artifact.spool_closed
    assert len(tracker.instances) == 1
    assert not tracker.instances[0].closed
    chunks = list(artifact.stream())
    assert all(0 < len(chunk) <= EXPORT_STREAM_CHUNK_BYTES for chunk in chunks)
    assert b"".join(chunks).startswith(b"id,note\r\n")
    assert tracker.instances[0].closed

    failing_report = _report(
        builder=lambda _service, _studio_id: [{"id": "1", "note": "one"}, {"id": "2", "note": "two"}]
    )
    failure_tracker = _SpoolTracker(real_factory)
    budget = ReportExportBudget(max_output_rows=1)
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            failure_tracker,
        ),
        pytest.raises(HTTPException),
    ):
        _build(ReportExportService(TableBackedSupabase({}), budget=budget), failing_report)
    assert failure_tracker.instances[0].closed


def test_spool_closes_on_generation_byte_and_elapsed_failures():
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile

    generation_tracker = _SpoolTracker(real_factory)
    generation_report = _report(
        builder=lambda _service, _studio_id: (_ for _ in ()).throw(RuntimeError("failed"))
    )
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            generation_tracker,
        ),
        pytest.raises(RuntimeError),
    ):
        _build(ReportExportService(TableBackedSupabase({})), generation_report)
    assert generation_tracker.instances[0].closed

    expected = b"id\r\nx\r\n"
    byte_report = _report(
        builder=lambda _service, _studio_id: [{"id": "x", "note": None}],
        columns=("id",),
    )
    exact_byte_artifact = _build(
        ReportExportService(
            TableBackedSupabase({}),
            budget=ReportExportBudget(max_output_bytes=len(expected)),
        ),
        byte_report,
    )
    assert asyncio.run(_consume_artifact(exact_byte_artifact)) == expected
    assert exact_byte_artifact.output_bytes == len(expected)

    byte_tracker = _SpoolTracker(real_factory)
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            byte_tracker,
        ),
        pytest.raises(HTTPException),
    ):
        _build(
            ReportExportService(
                TableBackedSupabase({}),
                budget=ReportExportBudget(max_output_bytes=len(expected) - 1),
            ),
            byte_report,
        )
    assert byte_tracker.instances[0].closed

    clock = [0.0]
    elapsed_tracker = _SpoolTracker(real_factory)

    def elapsed_builder(_service, _studio_id):
        clock[0] = 16.0
        return []

    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            elapsed_tracker,
        ),
        pytest.raises(HTTPException),
    ):
        _build(
            ReportExportService(
                TableBackedSupabase({}),
                budget=ReportExportBudget(clock=lambda: clock[0]),
            ),
            _report(builder=elapsed_builder),
        )
    assert elapsed_tracker.instances[0].closed

    exact_clock = [0.0]
    def exact_elapsed_builder(_service, _studio_id):
        exact_clock[0] = 15.0
        return []

    exact_elapsed_report = _report(builder=exact_elapsed_builder)
    exact_elapsed_artifact = _build(
        ReportExportService(
            TableBackedSupabase({}),
            budget=ReportExportBudget(clock=lambda: exact_clock[0]),
        ),
        exact_elapsed_report,
    )
    assert exact_elapsed_artifact.budget.elapsed_seconds == 15.0
    exact_elapsed_artifact.close()


def test_stream_is_bounded_exact_and_explicit_close_does_not_materialize_body():
    expected = (
        b"id,note\r\n"
        + b"1,"
        + (b"x" * (EXPORT_STREAM_CHUNK_BYTES + 17))
        + b"\r\n"
    )
    artifact = _build(
        ReportExportService(TableBackedSupabase({})),
        _report(builder=lambda _service, _studio_id: [
            {"id": "1", "note": "x" * (EXPORT_STREAM_CHUNK_BYTES + 17)},
        ]),
    )
    assert not hasattr(artifact, "body")
    iterator = artifact.stream()
    first = next(iterator)
    assert 0 < len(first) <= EXPORT_STREAM_CHUNK_BYTES
    iterator.close()
    assert artifact.spool_closed

    artifact = _build(
        ReportExportService(TableBackedSupabase({})),
        _report(builder=lambda _service, _studio_id: [
            {"id": "1", "note": "x" * (EXPORT_STREAM_CHUNK_BYTES + 17)},
        ]),
    )
    chunks = list(artifact.stream())
    assert all(0 < len(chunk) <= EXPORT_STREAM_CHUNK_BYTES for chunk in chunks)
    assert b"".join(chunks) == expected
    assert artifact.spool_closed


def test_audit_row_count_uses_emitted_rows_and_audit_failure_returns_no_response():
    supabase = TableBackedSupabase({
        "students": [{
            "id": "student-1",
            "studio_id": "studio-1",
            "legal_first_name": "line1\nline2",
        }],
        "audit_logs": [],
    })
    with patch(
        "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
        return_value={"studio_id": "studio-1", "role": "admin"},
    ):
        response = asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))

    body = asyncio.run(_consume_response(response))
    assert body.count(b"\n") > 2
    assert supabase.tables["audit_logs"][0]["metadata"]["row_count"] == 1

    failing_supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    failing_supabase.table_failures["audit_logs"] = RuntimeError("audit failed")
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    failure_tracker = _SpoolTracker(real_factory)
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            failure_tracker,
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
        pytest.raises(RuntimeError, match="audit failed"),
    ):
        asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=failing_supabase,
        ))
    assert failing_supabase.tables["audit_logs"] == []
    assert failure_tracker.instances[0].closed


def test_response_construction_failure_closes_claimed_spool():
    supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    tracker = _SpoolTracker(real_factory)
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            tracker,
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
        patch(
            "app.api.v1.endpoints.reports._ReportExportStreamingResponse",
            side_effect=RuntimeError("response construction failed"),
        ),
        pytest.raises(RuntimeError, match="response construction failed"),
    ):
        asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))
    assert tracker.instances[0].closed


def test_streaming_read_runs_off_event_loop_and_preserves_heartbeat():
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    read_started = threading.Event()
    release_read = threading.Event()

    class BlockingSpool(real_factory):
        def read(self, *args, **kwargs):
            read_started.set()
            release_read.wait(2)
            return super().read(*args, **kwargs)

    supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            BlockingSpool,
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
    ):
        response = asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))

        async def consume():
            return await _consume_response(response)

        async def scenario():
            task = asyncio.create_task(consume())
            for _ in range(100):
                if read_started.is_set():
                    break
                await asyncio.sleep(0)
            assert read_started.is_set()
            heartbeat_ticks = 0
            for _ in range(20):
                heartbeat_ticks += 1
                await asyncio.sleep(0)
            release_read.set()
            body = await task
            return heartbeat_ticks, body

        heartbeat_ticks, body = asyncio.run(scenario())

    assert heartbeat_ticks
    assert body.startswith(b"id,studio_id,legal_first_name")
    assert b"student-1,studio-1" in body


def test_audit_completes_before_first_spool_read():
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    read_started = threading.Event()

    class ReadTrackingSpool(real_factory):
        def read(self, *args, **kwargs):
            read_started.set()
            return super().read(*args, **kwargs)

    supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            ReadTrackingSpool,
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
    ):
        response = asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))
        assert supabase.tables["audit_logs"]
        assert not read_started.is_set()
        body = asyncio.run(_consume_response(response))

    assert read_started.is_set()
    assert b"student-1,studio-1" in body


def test_injected_spool_read_exception_closes_spool():
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    tracker = _SpoolTracker(real_factory)

    class FailingReadSpool(real_factory):
        def read(self, *args, **kwargs):
            raise OSError("injected spool read failure")

    supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            lambda *args, **kwargs: tracker.instances.append(
                FailingReadSpool(*args, **kwargs)
            ) or tracker.instances[-1],
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
    ):
        response = asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))
        with pytest.raises(OSError, match="injected spool read failure"):
            asyncio.run(_consume_response(response))

    assert tracker.instances[0].closed


def test_asgi_send_error_closes_spool_owner():
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    tracker = _SpoolTracker(real_factory)
    supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            tracker,
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
    ):
        response = asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))

        async def send(message):
            if message["type"] == "http.response.body":
                raise RuntimeError("injected ASGI send failure")

        async def invoke():
            await response(
                {"type": "http", "asgi": {"spec_version": "2.4"}},
                lambda: None,
                send,
            )

        with pytest.raises(RuntimeError, match="injected ASGI send failure"):
            asyncio.run(invoke())

    assert tracker.instances[0].closed


def test_asgi_cancellation_closes_spool_owner():
    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    tracker = _SpoolTracker(real_factory)
    send_started = threading.Event()
    supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    with (
        patch(
            "app.services.report_export_service.tempfile.SpooledTemporaryFile",
            tracker,
        ),
        patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ),
    ):
        response = asyncio.run(export_report_csv(
            "students",
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=supabase,
        ))

        async def send(message):
            send_started.set()
            await asyncio.Event().wait()

        async def invoke_and_cancel():
            task = asyncio.create_task(response(
                {"type": "http", "asgi": {"spec_version": "2.4"}},
                lambda: None,
                send,
            ))
            for _ in range(100):
                if send_started.is_set():
                    break
                await asyncio.sleep(0)
            assert send_started.is_set()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        asyncio.run(invoke_and_cancel())

    assert tracker.instances[0].closed


def test_real_bulk_runtime_keeps_report_client_thread_affine_after_cancellation():
    class ThreadTrackingClient(TableBackedSupabase):
        def __init__(self):
            super().__init__({
                "students": [{"id": "student-1", "studio_id": "studio-1"}],
                "audit_logs": [],
            })
            self.started = threading.Event()
            self.release = threading.Event()
            self.operation_threads = []

        def table(self, name):
            query = super().table(name)
            execute = query.execute

            def tracked_execute():
                self.operation_threads.append((name, threading.get_ident()))
                if name == "students":
                    self.started.set()
                    self.release.wait(2)
                return execute()

            query.execute = tracked_execute
            return query

    created_threads = []
    closed_threads = []
    client_holder = []
    factory_ready = threading.Event()

    def factory():
        client = ThreadTrackingClient()
        client_holder.append(client)
        created_threads.append(threading.get_ident())
        factory_ready.set()
        return client

    def closer(_client):
        closed_threads.append(threading.get_ident())

    config = SupabaseLaneConfig(
        max_workers=1,
        max_queue=0,
        queue_wait_timeout=1.0,
        operation_wait_timeout=2.0,
    )

    async def scenario():
        runtime = SupabaseProviderRuntime(
            config,
            config,
            client_factory=factory,
            client_closer=closer,
            thread_name_prefix="report-affinity",
        )
        heartbeat_ticks = 0

        try:
            with patch(
                "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
                return_value={"studio_id": "studio-1", "role": "admin"},
            ):
                task = asyncio.create_task(
                    export_report_csv(
                        "students",
                        user_id="user-1",
                        requested_studio_id="studio-1",
                        supabase=runtime,
                    )
                )
                client = await asyncio.to_thread(
                    lambda: (
                        factory_ready.wait(1)
                        and client_holder[0].started.wait(1)
                        and client_holder[0]
                    )
                )
                for _ in range(20):
                    heartbeat_ticks += 1
                    await asyncio.sleep(0)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                assert not runtime.bulk_snapshot().completed
                client.release.set()
                for _ in range(100):
                    if runtime.bulk_snapshot().completed == 1:
                        break
                    await asyncio.sleep(0.01)
                assert runtime.bulk_snapshot().completed == 1
                assert runtime.bulk_snapshot().admitted == 0
                assert client.operation_threads
                assert {thread for _name, thread in client.operation_threads} == {
                    created_threads[0]
                }
                assert heartbeat_ticks
                assert client_holder[0] is client
        finally:
            runtime.shutdown()

    real_factory = __import__(
        "app.services.report_export_service", fromlist=["tempfile"]
    ).tempfile.SpooledTemporaryFile
    tracker = _SpoolTracker(real_factory)
    with patch(
        "app.services.report_export_service.tempfile.SpooledTemporaryFile",
        tracker,
    ):
        asyncio.run(scenario())
    assert tracker.instances
    assert all(instance.closed for instance in tracker.instances)
    assert closed_threads == created_threads


@pytest.mark.parametrize("scale", (1_000, 10_000, 50_000))
def test_deterministic_performance_fixture_records_source_output_and_spool_metrics(scale):
    rows = [
        {
            "id": str(index),
            "studio_id": "studio-1",
            "note": "payload" * 8,
        }
        for index in range(scale)
    ]
    report = _report(
        table="export_rows",
        columns=("id", "studio_id", "note"),
    )
    supabase = TableBackedSupabase({"export_rows": rows})
    service = ReportExportService(supabase)

    rss_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    tracemalloc.start()
    started = time.perf_counter()
    artifact = _build(service, report)
    wall_seconds = time.perf_counter() - started
    _current, tracemalloc_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    rss_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    metrics = {
        "scale": scale,
        "wall_seconds": wall_seconds,
        "source_rows": artifact.budget.fetched_rows,
        "provider_calls": artifact.budget.provider_calls,
        "output_rows": artifact.emitted_data_rows,
        "output_bytes": artifact.output_bytes,
        "spool_threshold": artifact.spool_threshold_bytes,
        "spool_rolled": artifact.spool_rolled,
        "spool_closed": artifact.spool_closed,
        "tracemalloc_peak": tracemalloc_peak,
        "rss_delta": max(0, rss_after - rss_before),
    }
    print(f"report_export_performance={metrics}")

    assert artifact.budget.fetched_rows == scale
    assert artifact.budget.provider_calls == (scale // 1_000) + 1
    assert artifact.budget.emitted_rows == scale
    body = asyncio.run(_consume_artifact(artifact))
    assert artifact.output_bytes == len(body)
    assert artifact.output_bytes <= 20 * 1024 * 1024
    assert artifact.spool_rolled is (artifact.output_bytes > artifact.spool_threshold_bytes)
    assert artifact.spool_closed
    if scale == 50_000:
        assert wall_seconds < 15.0
        assert tracemalloc_peak < 512 * 1024 * 1024
        assert metrics["rss_delta"] < 512 * 1024 * 1024
