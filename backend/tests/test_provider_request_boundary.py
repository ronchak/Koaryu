import ast
import asyncio
from concurrent.futures import Future
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app import main
from app.api.v1.endpoints.billing import _audit_billing_action
from app.core.deps import run_supabase_operation
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.services.platform_billing_service import AccessRepairInFlight


ROOT = Path(__file__).parents[1]
ENDPOINTS = ROOT / "app" / "api" / "v1" / "endpoints"
EXPECTED_BULK_FUNCTIONS = {
    "reset_demo_studio",
    "clear_studio_data",
    "export_report_csv",
    "materialize_session_range",
    "materialize_schedule_window",
    "generate_week",
    "bulk_check_in",
    "bulk_update_tags",
    "bulk_update_status",
    "bulk_archive_students",
    "parse_csv_headers",
    "validate_csv_import",
    "execute_csv_import",
    "process_due_account_deletions",
}


def _config(*, workers: int = 1, queue: int = 2, operation_timeout: float = 1.0):
    return SupabaseLaneConfig(
        max_workers=workers,
        max_queue=queue,
        queue_wait_timeout=0.05,
        operation_wait_timeout=operation_timeout,
    )


def _runtime(**kwargs):
    config = _config(**kwargs)
    return SupabaseProviderRuntime(
        config,
        config,
        client_factory=lambda: SimpleNamespace(),
        client_closer=lambda _client: None,
        thread_name_prefix="boundary-test",
    )


def test_lifespan_owns_runtime_and_shuts_it_down_off_event_loop():
    calls = {}

    class FakeRuntime:
        def __init__(self, interactive, bulk):
            calls["configs"] = (interactive, bulk)
            calls["constructed_on"] = threading.get_ident()

        def shutdown(self):
            calls["shutdown_on"] = threading.get_ident()

    async def exercise():
        application = SimpleNamespace(state=SimpleNamespace())
        with patch.object(main, "SupabaseProviderRuntime", FakeRuntime):
            async with main._lifespan(application):
                assert isinstance(application.state.supabase_provider_runtime, FakeRuntime)
                calls["event_loop_thread"] = threading.get_ident()

    asyncio.run(exercise())

    assert calls["configs"] == (main.INTERACTIVE_PROVIDER_CONFIG, main.BULK_PROVIDER_CONFIG)
    assert calls["constructed_on"] == calls["event_loop_thread"]
    assert calls["shutdown_on"] != calls["event_loop_thread"]


def test_fake_client_operation_stays_inline_and_awaits_async_result():
    caller_thread = threading.get_ident()
    fake = object()

    async def operation(client):
        assert client is fake
        assert threading.get_ident() == caller_thread
        return "fake-result"

    assert asyncio.run(run_supabase_operation(fake, operation)) == "fake-result"


def test_runtime_operation_runs_on_owned_worker_and_selects_each_lane():
    runtime = _runtime()
    try:
        caller_thread = threading.get_ident()
        interactive_thread = asyncio.run(
            run_supabase_operation(
                runtime,
                lambda _client: (threading.get_ident(), threading.current_thread().name),
            )
        )
        bulk_thread = asyncio.run(
            run_supabase_operation(
                runtime,
                lambda _client: (threading.get_ident(), threading.current_thread().name),
                lane="bulk",
            )
        )
    finally:
        runtime.shutdown()

    assert interactive_thread[0] != caller_thread
    assert bulk_thread[0] != caller_thread
    assert "interactive" in interactive_thread[1]
    assert "bulk" in bulk_thread[1]


def test_runtime_saturation_and_operation_timeout_are_stable_http_errors():
    async def exercise():
        runtime = _runtime(workers=1, queue=0, operation_timeout=1.0)
        started = threading.Event()
        release = threading.Event()
        first = asyncio.create_task(
            run_supabase_operation(
                runtime,
                lambda _client: (started.set(), release.wait(1))[1],
            )
        )
        assert await asyncio.to_thread(started.wait, 1)
        try:
            with pytest.raises(HTTPException) as saturated:
                await run_supabase_operation(runtime, lambda _client: "queued")
            assert saturated.value.status_code == 503
            assert saturated.value.detail == "Provider capacity is temporarily unavailable."
            assert saturated.value.headers == {"Retry-After": "1"}
        finally:
            release.set()
            await first
            runtime.shutdown()

        timeout_runtime = _runtime(workers=1, queue=0, operation_timeout=0.01)
        try:
            with pytest.raises(HTTPException) as timed_out:
                await run_supabase_operation(timeout_runtime, lambda _client: time.sleep(0.05))
            assert timed_out.value.status_code == 504
            assert timed_out.value.detail == "Provider operation timed out."
            assert timed_out.value.headers == {"Retry-After": "1"}
        finally:
            timeout_runtime.shutdown()

    asyncio.run(exercise())


def test_access_repair_follower_wait_uses_total_deadline_without_cancelling_leader_signal():
    async def exercise():
        runtime = _runtime(workers=1, queue=0, operation_timeout=0.01)
        completion: Future[None] = Future()
        try:
            with pytest.raises(HTTPException) as timed_out:
                await run_supabase_operation(
                    runtime,
                    lambda _client: (_ for _ in ()).throw(
                        AccessRepairInFlight(completion)
                    ),
                )
            assert timed_out.value.status_code == 504
            assert timed_out.value.detail == "Provider operation timed out."
            assert not completion.cancelled()
        finally:
            completion.set_result(None)
            runtime.shutdown()

    asyncio.run(exercise())


def test_background_billing_audit_reacquires_runtime_and_constructs_fresh_service():
    runtime = _runtime()
    constructed = []
    audited = []

    class FakeBillingService:
        def __init__(self, client):
            constructed.append((client, threading.get_ident()))

        def audit_connect_dashboard_opened(self, studio_id, actor_id):
            audited.append((studio_id, actor_id, threading.get_ident()))

    try:
        with patch("app.api.v1.endpoints.billing.BillingService", FakeBillingService):
            asyncio.run(
                _audit_billing_action(
                    runtime,
                    "audit_connect_dashboard_opened",
                    "studio-1",
                    "user-1",
                )
            )
    finally:
        runtime.shutdown()

    assert len(constructed) == 1
    assert audited == [("studio-1", "user-1", constructed[0][1])]


def test_all_request_provider_dependencies_are_wrapped_and_lane_mapping_is_explicit():
    dependency_count = 0
    wrapped_count = 0
    lane_by_function = {}

    for path in sorted(ENDPOINTS.glob("*.py")):
        tree = ast.parse(path.read_text())
        for node in tree.body:
            if not isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
                continue
            has_provider_dependency = any(
                isinstance(default, ast.Call)
                and isinstance(default.func, ast.Name)
                and default.func.id == "Depends"
                and default.args
                and isinstance(default.args[0], ast.Name)
                and default.args[0].id == "get_supabase"
                for default in node.args.defaults + node.args.kw_defaults
                if default is not None
            )
            if not has_provider_dependency:
                continue
            dependency_count += 1
            calls = [
                call
                for call in ast.walk(node)
                if isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name)
                and call.func.id == "run_supabase_operation"
            ]
            assert len(calls) == 1, f"{path.name}:{node.name} has no single provider boundary"
            wrapped_count += 1
            lane = next(
                keyword.value.value
                for keyword in calls[0].keywords
                if keyword.arg == "lane"
            ) if calls[0].keywords else "interactive"
            lane_by_function[node.name] = lane
            for call in ast.walk(node):
                if not isinstance(call, ast.Call) or not call.args:
                    continue
                if isinstance(call.func, ast.Name) and call.func.id.endswith("Service"):
                    assert not (
                        isinstance(call.args[0], ast.Name)
                        and call.args[0].id == "supabase"
                    ), f"{path.name}:{node.name} constructs a service from the dependency"

    assert dependency_count == 132
    assert wrapped_count == dependency_count
    assert {name for name, lane in lane_by_function.items() if lane == "bulk"} == EXPECTED_BULK_FUNCTIONS


def test_student_photo_body_is_read_before_interactive_provider_admission():
    path = ENDPOINTS / "students.py"
    tree = ast.parse(path.read_text())
    upload = next(
        node
        for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "upload_student_photo"
    )
    provider_operation = next(
        node
        for node in upload.body
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
        and node.name == "_provider_operation"
    )

    assert any(
        isinstance(node, ast.Await)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and node.value.func.attr == "read_validated_file"
        for statement in upload.body[: upload.body.index(provider_operation)]
        for node in ast.walk(statement)
    )
    assert not any(
        isinstance(node, ast.Name) and node.id == "file"
        for node in ast.walk(provider_operation)
    )


def test_remaining_application_client_factories_are_isolated_special_cases():
    # The runtime owns ordinary request clients. These are the direct factory
    # callers left: runtime worker setup, off-loop JWKS fallback, off-loop
    # readiness, dashboard child reads, rare live Stripe authorization, and
    # owner-run CLI scripts. The CLI singleton is retained because that caller
    # remains outside FastAPI and no request worker imports this accessor.
    source = "\n".join(path.read_text() for path in (ROOT / "app").rglob("*.py"))
    assert "_client: Optional" in source
    assert "close_supabase_client" in source
