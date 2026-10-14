"""Deterministic, aggregate-only performance fixture for ``GET /dashboard/home``.

The real endpoint runs with real Auth, membership and subscription checks
against in-memory provider tables. The facts RPC is faked with an accepted
V53-shaped payload that already lists today's classes, so Home never
materializes sessions. The studio business date, the belt eligibility clock
and the response timestamp are frozen, so serialized bytes are deterministic.
Evidence holds counts, bytes and timings only: never rows, names or payloads.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import resource
import sys
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from fastapi import HTTPException, Response

from app.api.v1.endpoints.dashboard import get_dashboard_home
from app.services import belt_eligibility, dashboard_home_service
from app.services.dashboard_home_sections import (
    DASHBOARD_FACTS_RPC_FORMULA_VERSION,
    DASHBOARD_FACTS_RPC_NAME,
)
from app.services.dashboard_home_service import DashboardHomeService
from app.services.dashboard_summary_cache import invalidate_dashboard_fact_caches
from tests.fakes.supabase import FakeResult, FakeRpcCall, FakeTableQuery, TableBackedSupabase

ROOT_DIR = Path(__file__).resolve().parents[3]
MANIFEST_PATH = ROOT_DIR / "performance" / "dashboard-home-budget.json"
FIXTURE_REVISION = "dashboard-home-endpoint-fixture-v1"
STUDIO_ID = "fixture-studio"
USER_ID = "fixture-user"
TODAY = date(2026, 5, 20)
TIMEZONE = "America/Los_Angeles"
# Noon on TODAY in the studio's timezone: the eligibility calculator's "now".
FROZEN_NOW = datetime(2026, 5, 20, 19, 0, tzinfo=UTC)
PROGRAM_ID = "fixture-program"
LADDER_ID = "fixture-ladder"
MATERIALIZE_RPC_NAME = "materialize_recurring_class_sessions"
# BeltService.list_ladders' embedded read runs exactly once per promotions load.
PROMOTION_LOAD_COLUMNS = "*, belt_ranks(*)"
# Every studio-owned table Home reads must be filtered by studio.
TENANT_TABLES = (
    "students",
    "student_program_memberships",
    "attendance",
    "promotions",
    "programs",
    "belt_ladders",
    "belt_ranks",
    "leads",
    "studio_subscriptions",
)
# Eligibility reads these in 100-student chunks; an index on student_id keeps
# the fake's scan cost from dominating the endpoint timing. All filters still apply.
STUDENT_INDEXED_TABLES = ("attendance", "student_program_memberships", "promotions")
# The only table the run changes (subscription revocation). Matches on every
# other table are computed once per distinct query; each execute is still counted.
MUTATED_TABLES = frozenset({"studio_subscriptions"})
ADMIN_SECTIONS = frozenset(
    {
        "studio",
        "needs_attention",
        "classes_today",
        "stats",
        "follow_ups",
        "ready_to_promote",
        "recent_students",
    }
)
EXPECTED_TIMINGS = frozenset(
    {
        "koaryu_home_context",
        "koaryu_home_facts",
        "koaryu_home_contact",
        "koaryu_home_follow_ups",
        "koaryu_home_promotions",
        "koaryu_home_total",
    }
)
# (id suffix, name, color, min classes, min months, requires approval)
RANKS = (
    ("white", "White", "#FFFFFF", 0, 0, False),
    ("yellow", "Yellow", "#FFD700", 8, 1, False),
    ("orange", "Orange", "#FF8C00", 12, 2, False),
    ("green", "Green", "#228B22", 16, 3, True),
    ("blue", "Blue", "#1E3A8A", 24, 4, True),
    ("brown", "Brown", "#6B4423", 32, 6, True),
)
OPEN_LEAD_STAGES = ("inquiry", "trial_scheduled", "trial_completed", "offer_sent")
LEAD_STAGES = (*OPEN_LEAD_STAGES, "enrolled", "closed_lost")
# Six of today's classes: five rows and one overflow, as the RPC bounds them.
TODAY_CLASSES = (
    ("16:00:00", "16:45:00", 12, 9),
    ("17:00:00", "17:45:00", 16, 14),
    ("18:00:00", "19:00:00", 24, 20),
    ("19:00:00", "20:00:00", None, 7),
    ("20:00:00", "21:00:00", 20, 0),
    ("21:00:00", "21:45:00", 12, 0),
)


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FROZEN_NOW if tz is None else FROZEN_NOW.astimezone(tz)


class CountingFakeTableQuery(FakeTableQuery):
    def execute(self):
        result = super().execute()
        self.supabase.record_result(result)
        return result

    def _matched_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.name in MUTATED_TABLES or rows is not self.supabase.tables.get(self.name):
            return super()._matched_rows(rows)
        key = (
            self.name,
            len(rows),
            tuple(
                (op, column, frozenset(value) if isinstance(value, set) else value)
                for op, column, value in self.filters
            ),
            tuple(self.or_filters),
            tuple(self.orders),
        )
        matched = self.supabase.matches.get(key)
        if matched is None:
            candidates = self.supabase.indexed_candidates(self.name, rows, self.filters)
            matched = self.supabase.matches[key] = super()._matched_rows(candidates)
        return matched


class CountingTableBackedSupabase(TableBackedSupabase):
    def __init__(self, tables: dict[str, list[dict[str, Any]]], facts: dict[str, Any]):
        super().__init__(tables)
        self.required_eq_filters = {name: {"studio_id"} for name in TENANT_TABLES}
        self.rpc_calls: list[str] = []
        self.returned_row_count = 0
        self.provider_response_bytes = 0
        self.auth_call_count = 0
        self.auth = SimpleNamespace(admin=SimpleNamespace(get_user_by_id=self.get_user_by_id))
        self._facts_json = json.dumps(facts)
        self.matches: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
        self._student_indexes = {
            name: (len(tables[name]), _positions_by_student(tables[name]))
            for name in STUDENT_INDEXED_TABLES
        }

    def get_user_by_id(self, user_id):
        self.auth_call_count += 1
        return SimpleNamespace(
            user=SimpleNamespace(id=user_id, email="fixture@example.invalid", user_metadata={})
        )

    def rpc(self, name, params):
        self.rpc_calls.append(name)
        if name == MATERIALIZE_RPC_NAME:
            # Recorded so the gate fails on any write; the design never reaches it.
            return FakeRpcCall(lambda: 0)
        if name != DASHBOARD_FACTS_RPC_NAME:
            raise AssertionError("Home called an unexpected RPC")
        if params != {
            "p_studio_id": STUDIO_ID,
            "p_visibility": "billing_visible",
            "p_timezone_name": TIMEZONE,
            "p_local_date": TODAY.isoformat(),
            "p_formula_version": DASHBOARD_FACTS_RPC_FORMULA_VERSION,
        }:
            raise AssertionError("Home sent unexpected facts RPC parameters")

        def execute():
            facts = json.loads(self._facts_json)
            self.record_result(FakeResult(facts))
            return facts

        return FakeRpcCall(execute)

    def table(self, name: str):
        return CountingFakeTableQuery(self, name)

    def indexed_candidates(
        self, name: str, rows: list[dict[str, Any]], filters: list[tuple[str, str, Any]]
    ) -> list[dict[str, Any]]:
        indexed = self._student_indexes.get(name)
        if indexed is None or rows is not self.tables.get(name) or len(rows) != indexed[0]:
            return rows
        for op, key, value in filters:
            if op == "in" and key == "student_id":
                positions = sorted(
                    position for student_id in value for position in indexed[1].get(student_id, ())
                )
                return [rows[position] for position in positions]
        return rows

    def record_result(self, result: Any) -> None:
        data = result.data
        if isinstance(data, list):
            self.returned_row_count += len(data)
        elif data is not None:
            self.returned_row_count += 1
        envelope = {"data": data, "count": result.count}
        self.provider_response_bytes += len(
            json.dumps(envelope, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        )

    def counters(self) -> tuple[int, int, int]:
        """(facts RPCs, promotion loads, follow-up queries) so far."""

        return (
            self.rpc_calls.count(DASHBOARD_FACTS_RPC_NAME),
            sum(
                query["table"] == "belt_ladders" and query["columns"] == PROMOTION_LOAD_COLUMNS
                for query in self.query_log
            ),
            sum(query["table"] == "leads" for query in self.query_log),
        )


def _positions_by_student(rows: list[dict[str, Any]]) -> dict[str, list[int]]:
    index: dict[str, list[int]] = {}
    for position, row in enumerate(rows):
        index.setdefault(row["student_id"], []).append(position)
    return index


def load_manifest() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text())
    if manifest["fixture_revision"] != FIXTURE_REVISION:
        raise AssertionError("performance manifest is bound to a different fixture revision")
    return manifest


def _student_status(index: int) -> str:
    if index % 10 == 5:
        return "trialing"
    if index % 10 == 9:
        return "inactive"
    return "active"


def _rank_rows() -> list[dict[str, Any]]:
    return [
        {
            "id": f"fixture-rank-{suffix}",
            "studio_id": STUDIO_ID,
            "ladder_id": LADDER_ID,
            "name": name,
            "color_hex": color,
            "display_order": order,
            "min_classes": min_classes,
            "min_months": min_months,
            "requires_approval": requires_approval,
            "is_tip": False,
            "tip_color_hex": None,
            "created_at": "2025-06-01T00:00:00+00:00",
        }
        for order, (suffix, name, color, min_classes, min_months, requires_approval) in enumerate(
            RANKS, start=1
        )
    ]


def build_tables(cardinalities: dict[str, int]) -> dict[str, list[dict[str, Any]]]:
    student_count = cardinalities["students"]
    students = [
        {
            "id": f"fixture-student-{index:04d}",
            "studio_id": STUDIO_ID,
            "legal_first_name": "Fixture",
            "legal_last_name": f"Student {index:04d}",
            "preferred_name": None,
            "status": _student_status(index),
            "deleted_at": None,
            "hold_start_date": None,
            "hold_end_date": None,
            "membership_start_date": "2025-09-01",
            "program_id": PROGRAM_ID,
            "current_belt_rank_id": None,
            "created_at": (datetime(2025, 9, 1, tzinfo=UTC) + timedelta(hours=index)).isoformat(),
            # Exactly one active student lacks a contact, so Home runs its contact lookup.
            "emergency_contact_name": None if index == 0 else "Fixture Contact",
        }
        for index in range(student_count)
    ]
    ranks = _rank_rows()
    rank_ids = [rank["id"] for rank in ranks]
    memberships = []
    for index in range(cardinalities["student_program_memberships"]):
        current = index < student_count
        rank_slot = index % (len(rank_ids) + 1)
        memberships.append(
            {
                "id": f"fixture-membership-{index}",
                "studio_id": STUDIO_ID,
                "student_id": students[index % student_count]["id"],
                "program_id": PROGRAM_ID,
                "status": "active" if current else "inactive",
                "ended_at": None if current else "2025-12-31T00:00:00+00:00",
                "started_at": (
                    datetime(2025, 9, 1, tzinfo=UTC) + timedelta(days=index % 120)
                ).isoformat(),
                # Unranked, every rank, and the top rank (no next rank) all occur.
                "current_belt_rank_id": rank_ids[rank_slot - 1] if rank_slot else None,
            }
        )
    # Half the students were promoted (bounded attendance reads); half never were.
    promoted_pool = max(1, student_count // 2)
    promotions = [
        {
            "id": f"fixture-promotion-{index}",
            "studio_id": STUDIO_ID,
            "student_id": students[index % promoted_pool]["id"],
            "student_program_membership_id": f"fixture-membership-{index % promoted_pool}",
            "program_id": PROGRAM_ID,
            "promoted_at": (
                datetime(2026, 1, 5, tzinfo=UTC) + timedelta(days=index % 100)
            ).isoformat(),
        }
        for index in range(cardinalities["promotions"])
    ]
    attendance = [
        {
            "id": f"fixture-attendance-{index}",
            "studio_id": STUDIO_ID,
            "student_id": students[index % student_count]["id"],
            "status": "absent" if index % 10 == 7 else "present",
            "counts_toward_eligibility": index % 25 != 3,
            "checked_in_at": (
                FROZEN_NOW - timedelta(days=1 + 2 * (index // student_count), hours=index % 5)
            ).isoformat(),
            # The embedded session the real query joins; never deleted or canceled.
            "class_sessions": {
                "program_id": PROGRAM_ID if index % 9 else None,
                "status": "completed",
                "deleted_at": None,
            },
        }
        for index in range(cardinalities["attendance"])
    ]
    leads = [
        {
            "id": f"fixture-lead-{index:05d}",
            "studio_id": STUDIO_ID,
            "first_name": "Fixture",
            "last_name": f"Lead {index:05d}",
            "stage": LEAD_STAGES[index % len(LEAD_STAGES)],
            # Fifteen overdue days, today and five future days; some leads have no date.
            "follow_up_date": None
            if index % 7 == 6
            else (TODAY + timedelta(days=index % 21 - 15)).isoformat(),
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        for index in range(cardinalities["leads"])
    ]
    return {
        "students": students,
        "student_program_memberships": memberships,
        "attendance": attendance,
        "promotions": promotions,
        "programs": [
            {"id": PROGRAM_ID, "studio_id": STUDIO_ID, "is_system": False, "archived_at": None},
            {
                "id": "fixture-system-program",
                "studio_id": STUDIO_ID,
                "is_system": True,
                "archived_at": None,
            },
        ],
        "belt_ladders": [
            {
                "id": LADDER_ID,
                "studio_id": STUDIO_ID,
                "name": "Fixture Ladder",
                "program_id": PROGRAM_ID,
                "sub_rank_term": "Stripe",
                "created_at": "2025-06-01T00:00:00+00:00",
                "updated_at": "2025-06-01T00:00:00+00:00",
                "belt_ranks": ranks,
            }
        ],
        "belt_ranks": ranks,
        "leads": leads,
        "staff_roles": [
            {
                "user_id": USER_ID,
                "studio_id": STUDIO_ID,
                "role": "admin",
                "created_at": "2025-06-01T00:00:00+00:00",
                "archived_at": None,
            }
        ],
        "staff_profiles": [
            {"user_id": USER_ID, "legal_first_name": "Fixture", "legal_last_name": "User"}
        ],
        "studio_subscriptions": [
            {"studio_id": STUDIO_ID, "status": "comped", "comped": True, "trial_end": None}
        ],
        "studios": [{"id": STUDIO_ID, "name": "Fixture Studio", "timezone": TIMEZONE}],
    }


def build_facts(tables: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """The accepted billing-visible facts RPC payload, consistent with the tables."""

    students = [row for row in tables["students"] if row["deleted_at"] is None]
    trialing = sum(row["status"] == "trialing" for row in students)
    current = sum(row["status"] in {"active", "trialing"} for row in students)
    recent = sorted(students, key=lambda row: row["created_at"], reverse=True)[:5]
    return {
        "formula_version": DASHBOARD_FACTS_RPC_FORMULA_VERSION,
        "studio": {"id": STUDIO_ID, "name": "Fixture Studio", "timezone": TIMEZONE},
        "timezone": TIMEZONE,
        "today": TODAY.isoformat(),
        "students": {
            "total_students": len(students),
            "active_students": current,
            "trialing_students": trialing,
            "on_hold_students": 0,
        },
        "operational": {
            "attendance_with_capacity": min(600, len(tables["attendance"]) // 4),
            "total_capacity": 600,
            "sessions_tracked": 30,
        },
        "schedule": {"today_sessions": len(TODAY_CLASSES)},
        "today_schedule": {
            "available": True,
            "overflow_count": len(TODAY_CLASSES) - 5,
            "rows": [
                {
                    "id": f"fixture-session-{index}",
                    "name": f"Fixture Class {index}",
                    "start_time": start,
                    "end_time": end,
                    "capacity": capacity,
                    "attendance_count": checked_in,
                }
                for index, (start, end, capacity, checked_in) in enumerate(TODAY_CLASSES[:5])
            ],
        },
        "inactivity": {"watch_14": current // 12},
        "emergency_contacts": {
            "available": True,
            "students_missing_contact_name": sum(
                row["status"] in {"active", "trialing"} and not row["emergency_contact_name"]
                for row in students
            ),
        },
        "billing": {
            "can_view_billing": True,
            "payment_attention_count": 3,
            "has_plans": False,
            "payments_ready": True,
            "amounts": {"available": False},
        },
        "setup": {
            "has_programs": True,
            "has_students": True,
            "has_belt_system": True,
            "has_weekly_classes": True,
            "has_tuition_plans": False,
        },
        "recent_students": [
            {
                "id": row["id"],
                "display_name": f"{row['legal_first_name']} {row['legal_last_name']}",
                "status": row["status"],
                "started_on": row["membership_start_date"],
            }
            for row in recent
        ],
    }


def _rss_bytes() -> int:
    # ru_maxrss is the whole fixture process high-water mark, including table
    # construction; it is not endpoint-only allocation.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def _invalidate() -> None:
    invalidate_dashboard_fact_caches(STUDIO_ID, domain="dashboard")


def measure_profile(profile: str, git_sha: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{40}", git_sha):
        raise ValueError("git SHA must be a full lowercase hexadecimal commit SHA")
    manifest = load_manifest()
    cardinalities = manifest["profiles"][profile]["cardinalities"]
    tables = build_tables(cardinalities)
    if {name: len(rows) for name, rows in tables.items()} != cardinalities:
        raise AssertionError(f"fixture cardinalities do not match manifest for {profile}")
    supabase = CountingTableBackedSupabase(tables, build_facts(tables))
    stage_durations: list[float] = []
    payloads: list[bytes] = []

    async def request() -> None:
        response = Response()
        started = time.perf_counter()
        payload = await get_dashboard_home(response, USER_ID, STUDIO_ID, supabase)
        encoded = payload.model_dump_json(by_alias=True).encode()
        stage_durations.append((time.perf_counter() - started) * 1000)
        payloads.append(encoded)
        assert response.headers["cache-control"] == "no-store, private"
        timings = {
            entry.strip().split(";")[0] for entry in response.headers["server-timing"].split(",")
        }
        assert timings == EXPECTED_TIMINGS, "Home Server-Timing labels changed"
        assert payload.viewer.role == "admin"

    async def phase(*requests) -> tuple[int, ...]:
        before = supabase.counters()
        await asyncio.gather(*requests)
        return tuple(after - prior for after, prior in zip(supabase.counters(), before))

    async def exercise() -> list[tuple[int, ...]]:
        _invalidate()
        phases = [await phase(request())]  # miss
        phases.append(await phase(request()))  # hit, with fresh Auth and table context
        _invalidate()
        phases.append(await phase(request(), request(), request()))  # concurrent misses
        _invalidate()
        phases.append(await phase(request()))  # invalidation
        # Revoking the subscription must deny even while entitled facts are cached.
        tables["studio_subscriptions"][0].update(status="canceled", comped=False)
        before = supabase.counters()
        try:
            await request()
        except HTTPException as exc:
            if exc.status_code != 402:
                raise
        else:
            raise AssertionError("cached facts bypassed fresh subscription authorization")
        phases.append(tuple(after - prior for after, prior in zip(supabase.counters(), before)))
        return phases

    started = time.perf_counter()
    with (
        patch.object(DashboardHomeService, "_studio_today", return_value=(TODAY, TIMEZONE)),
        patch.object(belt_eligibility, "datetime", _FrozenDatetime),
        patch.object(dashboard_home_service, "_utc_now", return_value=FROZEN_NOW),
    ):
        phases = asyncio.run(exercise())
    total_duration_ms = (time.perf_counter() - started) * 1000
    _invalidate()

    facts_rpcs, promotion_loads, follow_up_queries = (list(column) for column in zip(*phases))
    if facts_rpcs != [1, 0, 1, 1, 0]:
        raise AssertionError(f"Home facts cache reuse changed: {facts_rpcs}")
    if promotion_loads != [1, 0, 1, 1, 0]:
        raise AssertionError(f"Home promotions cache reuse changed: {promotion_loads}")
    if len(payloads) != 6 or len(set(payloads)) != 1:
        raise AssertionError("cached and uncached Home payloads differ")
    wire = json.loads(payloads[0])
    data_ready = (
        ADMIN_SECTIONS <= wire.keys() and {"follow_ups", "promotions"} <= wire["stats"].keys()
    )
    if {query["table"] for query in supabase.query_log} - cardinalities.keys():
        raise AssertionError("Home read a table the manifest does not size")
    if any(
        query["insert"] is not None
        or query["upsert"] is not None
        or query["update"] is not None
        or query["delete"]
        for query in supabase.query_log
    ):
        raise AssertionError("Home wrote through a table query")
    rpc_count = len(supabase.rpc_calls)
    return {
        "profile": profile,
        "route": manifest["fixed_request"]["route"],
        "cardinalities": cardinalities,
        "metrics": {
            "request_count": 7,
            "auth_call_count": supabase.auth_call_count,
            "table_query_count": len(supabase.query_log),
            "rpc_count": rpc_count,
            "cache_hit_rpc_count": facts_rpcs[1],
            "concurrent_miss_rpc_count": facts_rpcs[2],
            "invalidation_rpc_count": facts_rpcs[3],
            "denied_rpc_count": facts_rpcs[4],
            "materialize_rpc_count": supabase.rpc_calls.count(MATERIALIZE_RPC_NAME),
            "promotion_load_count": sum(promotion_loads),
            "follow_up_query_count": sum(follow_up_queries),
            "total_provider_call_count": supabase.auth_call_count
            + len(supabase.query_log)
            + rpc_count,
            "returned_row_count": supabase.returned_row_count,
            "provider_response_bytes": supabase.provider_response_bytes,
            "serialized_response_payload_bytes": sum(len(payload) for payload in payloads),
            "total_duration_ms": round(total_duration_ms, 3),
            "max_stage_duration_ms": round(max(stage_durations, default=0), 3),
            "slow_backend_stage_count": sum(
                value > manifest["backend_stage_threshold_ms"] for value in stage_durations
            ),
            "peak_rss_bytes": _rss_bytes(),
            "data_ready": data_ready,
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
    os.write(
        sys.stdout.fileno(), (json.dumps(evidence, separators=(",", ":")) + "\n").encode("utf-8")
    )


if __name__ == "__main__":
    main()
