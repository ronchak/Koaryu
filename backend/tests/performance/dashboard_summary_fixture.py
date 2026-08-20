from __future__ import annotations

import argparse
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
FIXTURE_REVISION = "dashboard-summary-fixture-v1"
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
    return {
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

    supabase = CountingTableBackedSupabase(tables)
    service = DashboardSummaryService(supabase)
    auth = AuthResponse(
        user=UserProfile(id="fixture-user", email="fixture@example.invalid", full_name="Fixture User"),
        staff_profiles_available=True,
        studio_id=STUDIO_ID,
        role=manifest["fixed_request"]["role"],
    )
    studio_row = {"id": STUDIO_ID, "name": "Fixture Studio", "timezone": manifest["fixed_request"]["timezone"]}
    started = time.perf_counter()
    summary, timings = service._build_summary_sync(
        auth,
        studio_row,
        today_override=date.fromisoformat(manifest["fixed_request"]["date"]),
    )
    serialization_started = time.perf_counter()
    serialized_payload = summary.model_dump_json()
    serialization_duration_ms = (time.perf_counter() - serialization_started) * 1000
    total_duration_ms = (time.perf_counter() - started) * 1000
    stage_durations = [value for key, value in timings.items() if key != "total"]
    stage_durations.append(serialization_duration_ms)
    threshold_ms = manifest["long_task_threshold_ms"]

    return {
        "profile": profile,
        "route": manifest["fixed_request"]["route"],
        "cardinalities": cardinalities,
        "metrics": {
            "request_count": 1,
            "table_query_count": len(supabase.query_log),
            "rpc_count": len(supabase.rpc_calls),
            "total_provider_call_count": len(supabase.query_log) + len(supabase.rpc_calls),
            "returned_row_count": supabase.returned_row_count,
            "provider_response_bytes": supabase.provider_response_bytes,
            "serialized_response_payload_bytes": len(serialized_payload.encode("utf-8")),
            "total_duration_ms": round(total_duration_ms, 3),
            "max_stage_duration_ms": round(max(stage_durations, default=0), 3),
            "long_task_count": sum(value > threshold_ms for value in stage_durations),
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
