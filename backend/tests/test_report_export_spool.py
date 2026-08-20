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
from app.core.deps import run_supabase_operation
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.services.report_export_budget import ReportExportBudget
from app.services.report_export_catalog_types import CsvReport
from app.services.report_export_service import (
    EXPORT_SPOOL_MAX_MEMORY_BYTES,
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
    assert artifact.body.startswith(b"id,studio_id,note\r\n")
    assert b'"line1\nline2"' in artifact.body
    assert artifact.body.endswith(b"\r\n")
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
    assert artifact.spool_closed
    assert len(tracker.instances) == 1
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
    assert exact_byte_artifact.body == expected
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

    assert response.body.count(b"\n") > 2
    assert supabase.tables["audit_logs"][0]["metadata"]["row_count"] == 1

    failing_supabase = TableBackedSupabase({
        "students": [{"id": "student-1", "studio_id": "studio-1"}],
        "audit_logs": [],
    })
    failing_supabase.table_failures["audit_logs"] = RuntimeError("audit failed")
    with (
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

        async def operation(client):
            return await export_report_csv(
                "students",
                user_id="user-1",
                requested_studio_id="studio-1",
                supabase=client,
            )

        try:
            with patch(
                "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
                return_value={"studio_id": "studio-1", "role": "admin"},
            ):
                task = asyncio.create_task(
                    run_supabase_operation(runtime, operation, lane="bulk")
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
    assert artifact.output_bytes == len(artifact.body)
    assert artifact.output_bytes <= 20 * 1024 * 1024
    assert artifact.spool_rolled is (artifact.output_bytes > artifact.spool_threshold_bytes)
    assert artifact.spool_closed
    if scale == 50_000:
        assert wall_seconds < 15.0
        assert tracemalloc_peak < 512 * 1024 * 1024
        assert metrics["rss_delta"] < 512 * 1024 * 1024
