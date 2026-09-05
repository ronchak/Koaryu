from __future__ import annotations

import argparse
import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, Response
from app.api.v1.endpoints.dashboard import get_dashboard_summary
from app.services.dashboard_summary_service import dashboard_summary_fact_cache, DASHBOARD_SUMMARY_FORMULA_VERSION
from tests.fakes.supabase import FakeResult, FakeRpcCall
import json
import os
import re
import resource
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any

from app.schemas.auth import AuthResponse, UserProfile
from app.services.dashboard_summary_service import DashboardSummaryService
from tests.fakes.supabase import FakeTableQuery, TableBackedSupabase


ROOT_DIR = Path(__file__).resolve().parents[3]
MANIFEST_PATH = ROOT_DIR / "performance" / "dashboard-summary-budget.json"
FIXTURE_REVISION = "dashboard-summary-endpoint-fixture-v2"
STUDIO_ID = "fixture-studio"


class CountingFakeTableQuery(FakeTableQuery):
    def execute(self):
        result = super().execute()
        self.supabase.measurement.record_table_result(result)
        return result


class CountingTableBackedSupabase(TableBackedSupabase):
    def __init__(self, tables: dict[str, list[dict[str, Any]]]):
        super().__init__(tables)
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []
        self.returned_row_count = 0
        self.provider_response_bytes = 0
        self.measurement = self
        self.auth_call_count = 0
        self.auth = SimpleNamespace(admin=SimpleNamespace(get_user_by_id=self.get_user_by_id))
        self.facts = None

    def get_user_by_id(self, user_id):
        self.auth_call_count += 1
        return SimpleNamespace(user=SimpleNamespace(id=user_id, email="fixture@example.invalid", user_metadata={}))

    def rpc(self, name, params):
        assert name == "dashboard_summary_facts"
        self.rpc_calls.append((name, params))
        def execute():
            self.record_table_result(FakeResult(self.facts))
            return self.facts
        return FakeRpcCall(execute)

    def table(self, name: str):
        return CountingFakeTableQuery(self, name)

    def record_table_result(self, result: Any) -> None:
        data = result.data
        if isinstance(data, list):
            self.returned_row_count += len(data)
        elif data is not None:
            self.returned_row_count += 1
        envelope = {"data": data, "count": result.count}
        self.provider_response_bytes += len(
            json.dumps(envelope, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        )


def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text())


def _student_row(index: int) -> dict[str, Any]:
    return {
        "id": f"fixture-student-{index:04d}",
        "studio_id": STUDIO_ID,
        "legal_first_name": f"Fixture{index:04d}",
        "legal_last_name": "Student",
        "preferred_name": None,
        "status": "active",
        "hold_start_date": None,
        "hold_end_date": None,
        "membership_start_date": "2026-01-01",
        "created_at": "2026-01-01T00:00:00Z",
        "deleted_at": None,
        "emergency_contact_name": f"Fixture Contact {index:04d}" if index % 5 else None,
    }


def build_tables(cardinalities: dict[str, int]) -> dict[str, list[dict[str, Any]]]:
    student_count = cardinalities["students"]
    students = [_student_row(index) for index in range(student_count)]
    tables = {
        "students": students,
        "leads": [
            {"id": "fixture-lead-1", "studio_id": STUDIO_ID, "stage": "inquiry", "follow_up_date": "2026-05-20"},
            {"id": "fixture-lead-2", "studio_id": STUDIO_ID, "stage": "enrolled", "follow_up_date": "2026-05-20"},
            {"id": "fixture-lead-3", "studio_id": STUDIO_ID, "stage": "trial_scheduled", "follow_up_date": "2026-05-19"},
        ],
        "class_sessions": [
            {"id": "fixture-session-1", "studio_id": STUDIO_ID, "template_id": "fixture-template-1", "name": "Fixture Fundamentals", "date": "2026-05-20", "start_time": "09:00:00", "end_time": "10:00:00", "status": "scheduled", "deleted_at": None, "capacity": 20},
            {"id": "fixture-session-2", "studio_id": STUDIO_ID, "template_id": "fixture-template-2", "name": "Fixture Advanced", "date": "2026-05-20", "start_time": "18:00:00", "end_time": "19:00:00", "status": "scheduled", "deleted_at": None, "capacity": 20},
            {"id": "fixture-session-history", "studio_id": STUDIO_ID, "template_id": None, "name": "Fixture History", "date": "2026-05-01", "start_time": "18:00:00", "end_time": "19:00:00", "status": "scheduled", "deleted_at": None, "capacity": 20},
        ],
        "class_templates": [
            {"id": "fixture-template-1", "studio_id": STUDIO_ID, "day_of_week": 3, "start_date": "2026-01-01", "end_date": None, "is_active": True},
            {"id": "fixture-template-2", "studio_id": STUDIO_ID, "day_of_week": 3, "start_date": "2026-01-01", "end_date": None, "is_active": True},
        ],
        "attendance": [
            {"id": "fixture-attendance-1", "studio_id": STUDIO_ID, "student_id": students[0]["id"], "session_id": "fixture-session-1", "status": "present", "checked_in_at": "2026-05-20T16:00:00Z"},
            {"id": "fixture-attendance-2", "studio_id": STUDIO_ID, "student_id": students[1 % student_count]["id"], "session_id": "fixture-session-2", "status": "present", "checked_in_at": "2026-05-21T01:00:00Z"},
            {"id": "fixture-attendance-3", "studio_id": STUDIO_ID, "student_id": students[2 % student_count]["id"], "session_id": "fixture-session-history", "status": "present", "checked_in_at": "2026-05-01T01:00:00Z"},
        ],
        "programs": [
            {"id": "fixture-program", "studio_id": STUDIO_ID, "is_system": False, "archived_at": None},
            {"id": "fixture-system-program", "studio_id": STUDIO_ID, "is_system": True, "archived_at": None},
        ],
        "belt_ladders": [{"id": "fixture-ladder", "studio_id": STUDIO_ID, "program_id": "fixture-program"}],
        "belt_ranks": [
            {"id": "fixture-rank", "studio_id": STUDIO_ID, "ladder_id": "fixture-ladder", "is_tip": False},
            {"id": "fixture-tip", "studio_id": STUDIO_ID, "ladder_id": "fixture-ladder", "is_tip": True},
        ],
        "billing_payers": [{"id": "fixture-payer", "studio_id": STUDIO_ID, "billing_status": "past_due"}],
        "billing_invoices": [
            {"id": "fixture-invoice-open", "studio_id": STUDIO_ID, "status": "open", "due_date": "2026-05-20"},
            {"id": "fixture-invoice-uncollectible", "studio_id": STUDIO_ID, "status": "uncollectible", "due_date": None},
        ],
        "billing_plans": [{"id": "fixture-plan", "studio_id": STUDIO_ID, "archived_at": None}],
        "studio_payment_accounts": [{"studio_id": STUDIO_ID, "charges_enabled": True}],
    }

    # Dimensions are independently sized. Duplicate names deliberately exercise
    # deterministic ordering; endpoint timing never executes this semantic builder.
    for student in students:
        student["legal_first_name"] = "Duplicate"
    for name in ("leads", "class_sessions", "attendance", "billing_invoices"):
        seeds = tables[name]
        tables[name] = [
            {**seeds[index % len(seeds)], "id": f"{name}-{index}"}
            for index in range(cardinalities[name])
        ]
    for index, row in enumerate(tables["attendance"]):
        row["student_id"] = students[index % student_count]["id"]
        row["session_id"] = tables["class_sessions"][index % len(tables["class_sessions"])]["id"]
    tables["student_program_memberships"] = [{"id": f"membership-{index}", "student_id": students[index % student_count]["id"], "program_id": "fixture-program", "studio_id": STUDIO_ID, "status": "active" if index < student_count else "inactive"} for index in range(cardinalities["student_program_memberships"])]
    tables["billing_payments"] = [{"id": f"payment-{index}", "studio_id": STUDIO_ID, "status": "succeeded", "amount_cents": 100, "processed_at": "2026-05-20T00:00:00Z"} for index in range(cardinalities["billing_payments"])]
    tables["stripe_events"] = [{"id": f"event-{index}", "stripe_event_id": f"evt_fixture_{index}", "stripe_account_id": "acct_fixture", "type": "invoice.paid", "payload": {}, "processing_status": "processed", "livemode": False} for index in range(cardinalities["stripe_events"])]
    tables["staff_roles"] = [{"user_id": "fixture-user", "studio_id": STUDIO_ID, "role": "admin", "archived_at": None}]
    tables["staff_profiles"] = [{"user_id": "fixture-user", "legal_first_name": "Fixture", "legal_last_name": "User"}]
    tables["studio_subscriptions"] = [{"studio_id": STUDIO_ID, "status": "comped", "comped": True}]
    tables["studios"] = [{"id": STUDIO_ID, "name": "Fixture Studio", "timezone": "America/Los_Angeles"}]
    return tables


def _rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def measure_profile(profile: str, git_sha: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{40}", git_sha):
        raise ValueError("git SHA must be a full lowercase hexadecimal commit SHA")
    manifest = load_manifest()
    profile_manifest = manifest["profiles"][profile]
    cardinalities = profile_manifest["cardinalities"]
    tables = build_tables(cardinalities)
    if {name: len(rows) for name, rows in tables.items()} != cardinalities:
        raise AssertionError(f"fixture cardinalities do not match manifest for {profile}")

    # This old builder is a semantic reference only. Its execution and fake
    # provider rows are explicitly excluded from endpoint performance evidence.
    reference_client = CountingTableBackedSupabase(tables)
    reference_auth = AuthResponse(user=UserProfile(id="fixture-user", email="fixture@example.invalid"), staff_profiles_available=True, studio_id=STUDIO_ID, role="admin")
    reference, _ = DashboardSummaryService(reference_client)._build_summary_sync(
        reference_auth, tables["studios"][0], today_override=date(2026, 5, 20),
    )
    supabase = CountingTableBackedSupabase(tables)
    supabase.facts = reference.model_dump(mode="json", exclude={"auth", "generated_at"})
    supabase.facts["formula_version"] = DASHBOARD_SUMMARY_FORMULA_VERSION
    stage_durations = []
    serialized_bytes = 0

    async def request():
        nonlocal serialized_bytes
        response = Response()
        started = time.perf_counter()
        payload = await get_dashboard_summary(response, "fixture-user", STUDIO_ID, supabase)
        encoded = payload.model_dump_json().encode()
        stage_durations.append((time.perf_counter() - started) * 1000)
        serialized_bytes += len(encoded)
        assert response.headers["cache-control"] == "no-store, private"
        assert "koaryu_summary_context" in response.headers["server-timing"]
        assert "koaryu_summary_facts" in response.headers["server-timing"]
        assert payload.auth.user.id == "fixture-user"
        assert payload.students == reference.students
        return payload

    async def exercise():
        dashboard_summary_fact_cache.invalidate(STUDIO_ID, domain="dashboard")
        await request()  # miss
        assert len(supabase.rpc_calls) == 1
        before = len(supabase.rpc_calls)
        await request()  # hit, with fresh Auth and table context
        hit_rpc_count = len(supabase.rpc_calls) - before
        dashboard_summary_fact_cache.invalidate(STUDIO_ID, domain="dashboard")
        before = len(supabase.rpc_calls)
        await asyncio.gather(request(), request(), request())
        concurrent_rpc_count = len(supabase.rpc_calls) - before
        dashboard_summary_fact_cache.invalidate(STUDIO_ID, domain="dashboard")
        before = len(supabase.rpc_calls)
        await request()
        invalidation_rpc_count = len(supabase.rpc_calls) - before
        # Revoking subscription must deny even while entitled facts are cached.
        tables["studio_subscriptions"][0].update(status="canceled", comped=False)
        before = len(supabase.rpc_calls)
        try:
            await request()
        except HTTPException as exc:
            assert exc.status_code == 402
        else:
            raise AssertionError("cached facts bypassed fresh subscription authorization")
        denied_rpc_count = len(supabase.rpc_calls) - before
        return hit_rpc_count, concurrent_rpc_count, invalidation_rpc_count, denied_rpc_count

    started = time.perf_counter()
    with patch.object(DashboardSummaryService, "_studio_today", return_value=(date(2026, 5, 20), "America/Los_Angeles")):
        hit, concurrent, invalidated, denied = asyncio.run(exercise())
    total_duration_ms = (time.perf_counter() - started) * 1000
    dashboard_summary_fact_cache.invalidate(STUDIO_ID, domain="dashboard")
    assert (hit, concurrent, invalidated, denied) == (0, 1, 1, 0)
    return {
        "profile": profile,
        "route": manifest["fixed_request"]["route"],
        "cardinalities": cardinalities,
        "metrics": {
            "request_count": 7,
            "auth_call_count": supabase.auth_call_count,
            "table_query_count": len(supabase.query_log),
            "rpc_count": len(supabase.rpc_calls),
            "cache_hit_rpc_count": hit,
            "concurrent_miss_rpc_count": concurrent,
            "invalidation_rpc_count": invalidated,
            "denied_rpc_count": denied,
            "total_provider_call_count": supabase.auth_call_count + len(supabase.query_log) + len(supabase.rpc_calls),
            "returned_row_count": supabase.returned_row_count,
            "provider_response_bytes": supabase.provider_response_bytes,
            "serialized_response_payload_bytes": serialized_bytes,
            "total_duration_ms": round(total_duration_ms, 3),
            "max_stage_duration_ms": round(max(stage_durations, default=0), 3),
            "slow_backend_stage_count": sum(value > manifest["backend_stage_threshold_ms"] for value in stage_durations),
            "peak_rss_bytes": _rss_bytes(),
            "data_ready": True,
        },
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=("small", "medium", "large"), required=True)
    parser.add_argument("--git-sha", required=True)
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args(sys.argv[1:])
    evidence = measure_profile(args.profile, args.git_sha)
    os.write(sys.stdout.fileno(), (json.dumps(evidence, separators=(",", ":")) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
