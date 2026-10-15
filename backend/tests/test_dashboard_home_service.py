"""Home endpoint, provider reads, cache reuse, materialization and failures."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import FastAPI, HTTPException, Response
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.api.v1.endpoints import dashboard
from app.schemas.auth import AuthResponse, UserProfile
from app.services import dashboard_home_service as home
from app.services.belt_eligibility import BeltEligibilityCalculator
from app.services.dashboard_home_sections import build_promotions, validate_dashboard_home_facts
from app.services.dashboard_summary_cache import (
    DashboardSummaryFactCache,
    invalidate_dashboard_fact_caches,
)
from tests.fakes.supabase import RpcBackedSupabase
from tests.test_belt_service import ProgramJoinTableQuery
from tests.test_dashboard_home_sections import STUDIO, TODAY, eligibility, home_key, rpc_facts


def tables():
    leads = [
        # overdue
        {
            "id": "l-3",
            "studio_id": STUDIO,
            "first_name": "C",
            "last_name": "Three",
            "stage": "inquiry",
            "follow_up_date": "2026-10-08",
        },
        {
            "id": "l-1",
            "studio_id": STUDIO,
            "first_name": "A",
            "last_name": "One",
            "stage": "offer_sent",
            "follow_up_date": "2026-10-08",
        },
        {
            "id": "l-2",
            "studio_id": STUDIO,
            "first_name": "B",
            "last_name": "Two",
            "stage": "trial_scheduled",
            "follow_up_date": "2026-10-09",
        },
        # due today
        *[
            {
                "id": f"l-t{i}",
                "studio_id": STUDIO,
                "first_name": "T",
                "last_name": str(i),
                "stage": "inquiry",
                "follow_up_date": "2026-10-10",
            }
            for i in range(5)
        ],
        # excluded
        {
            "id": "l-x1",
            "studio_id": STUDIO,
            "first_name": "X",
            "last_name": "Won",
            "stage": "enrolled",
            "follow_up_date": "2026-10-01",
        },
        {
            "id": "l-x2",
            "studio_id": STUDIO,
            "first_name": "X",
            "last_name": "Lost",
            "stage": "closed_lost",
            "follow_up_date": "2026-10-01",
        },
        {
            "id": "l-x3",
            "studio_id": STUDIO,
            "first_name": "X",
            "last_name": "Later",
            "stage": "inquiry",
            "follow_up_date": "2026-10-11",
        },
        {
            "id": "l-x4",
            "studio_id": "other",
            "first_name": "X",
            "last_name": "Other",
            "stage": "inquiry",
            "follow_up_date": "2026-10-01",
        },
    ]
    ranks = [
        {
            "id": "r-white",
            "ladder_id": "lad-1",
            "studio_id": STUDIO,
            "name": "White",
            "color_hex": "#FFFFFF",
            "display_order": 1,
            "min_classes": 0,
            "min_months": 0,
            "requires_approval": False,
            "is_tip": False,
            "created_at": "2026-01-01T00:00:00+00:00",
        },
        {
            "id": "r-yellow",
            "ladder_id": "lad-1",
            "studio_id": STUDIO,
            "name": "Yellow",
            "color_hex": "#FFFF00",
            "display_order": 2,
            "min_classes": 0,
            "min_months": 0,
            "requires_approval": True,
            "is_tip": False,
            "created_at": "2026-01-01T00:00:00+00:00",
        },
        {
            "id": "r-orange",
            "ladder_id": "lad-1",
            "studio_id": STUDIO,
            "name": "Orange",
            "color_hex": "#FFA500",
            "display_order": 3,
            "min_classes": 0,
            "min_months": 0,
            "requires_approval": False,
            "is_tip": False,
            "created_at": "2026-01-01T00:00:00+00:00",
        },
    ]
    students = [
        # missing contact (the one), active
        {
            "id": "st-1",
            "studio_id": STUDIO,
            "status": "active",
            "deleted_at": None,
            "legal_first_name": "Ana",
            "legal_last_name": "Unranked",
            "preferred_name": None,
            "membership_start_date": "2026-01-01",
            "program_id": "prog-1",
            "current_belt_rank_id": None,
            "emergency_contact_name": "",
        },
        {
            "id": "st-2",
            "studio_id": STUDIO,
            "status": "active",
            "deleted_at": None,
            "legal_first_name": "Ben",
            "legal_last_name": "White",
            "preferred_name": None,
            "membership_start_date": "2026-01-01",
            "program_id": "prog-1",
            "current_belt_rank_id": "r-white",
            "emergency_contact_name": "Mom",
        },
        {
            "id": "st-3",
            "studio_id": STUDIO,
            "status": "active",
            "deleted_at": None,
            "legal_first_name": "Cy",
            "legal_last_name": "Yellow",
            "preferred_name": None,
            "membership_start_date": "2026-01-01",
            "program_id": "prog-1",
            "current_belt_rank_id": "r-yellow",
            "emergency_contact_name": "Dad",
        },
        # not counted: deleted / inactive with empty contact
        {
            "id": "st-4",
            "studio_id": STUDIO,
            "status": "inactive",
            "deleted_at": None,
            "legal_first_name": "Di",
            "legal_last_name": "Gone",
            "preferred_name": None,
            "membership_start_date": None,
            "program_id": None,
            "current_belt_rank_id": None,
            "emergency_contact_name": None,
        },
    ]
    return {
        "studios": [{"id": STUDIO, "name": "River City", "timezone": "UTC"}],
        "leads": leads,
        "students": students,
        "programs": [
            {"id": "prog-1", "studio_id": STUDIO, "is_system": False, "archived_at": None}
        ],
        "belt_ladders": [
            {
                "id": "lad-1",
                "studio_id": STUDIO,
                "name": "Kids",
                "program_id": "prog-1",
                "sub_rank_term": "Stripe",
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
                "belt_ranks": ranks,
            }
        ],
        "belt_ranks": ranks,
        "student_program_memberships": [],
        "promotions": [],
        "attendance": [],
        "staff_roles": [
            {
                "id": f"sr-{role}",
                "user_id": f"user-{role}",
                "studio_id": STUDIO,
                "role": role,
                "archived_at": None,
                "created_at": "2026-01-01T00:00:00+00:00",
            }
            for role in ("admin", "front_desk", "instructor")
        ],
    }


def auth(user_id="user-admin", role="admin", studio_id=STUDIO):
    return AuthResponse(
        user=UserProfile(id=user_id, email=f"{user_id}@example.test"),
        staff_profiles_available=True,
        membership_status="active" if studio_id else "none",
        studio_id=studio_id,
        role=role if studio_id else None,
    )


class HomeSupabase(RpcBackedSupabase):
    def __init__(
        self,
        *,
        agenda_available=True,
        contact_missing=1,
        materialize_error=None,
        remains_unavailable=False,
    ):
        super().__init__(tables())
        self.agenda_available = agenda_available
        self.contact_missing = contact_missing
        self.materialize_error = materialize_error
        self.remains_unavailable = remains_unavailable
        self.facts_error = None
        self.facts_transform = lambda facts: facts
        self.required_eq_filters = {
            name: {"studio_id"} for name in ("leads", "students", "belt_ladders", "programs")
        }

    def table(self, name):
        # The Belt Tracker's ladder list filters programs through an inner join.
        return ProgramJoinTableQuery(self, name)

    def _rpc_dashboard_summary_facts(self, params):
        if self.facts_error:
            raise self.facts_error
        key = home_key(visibility=params["p_visibility"], studio_id=params["p_studio_id"])
        return self.facts_transform(
            rpc_facts(
                key, agenda_available=self.agenda_available, contact_missing=self.contact_missing
            )
        )

    def _rpc_materialize_recurring_class_sessions(self, params):
        if self.materialize_error:
            raise self.materialize_error
        if not self.remains_unavailable:
            self.agenda_available = True
        return 0 if self.remains_unavailable else 2


@pytest.fixture(autouse=True)
def isolated_home(monkeypatch):
    """Use fake I/O and public invalidation; do not replace cache default objects."""
    for cache in (home.dashboard_home_fact_cache, home.dashboard_home_promotion_cache):
        cache.invalidate(STUDIO, domain="dashboard")
    identity = Mock(
        side_effect=lambda user_id, requested: auth(user_id, user_id.removeprefix("user-"))
    )
    access, write_access = Mock(), Mock()
    monkeypatch.setattr(home.AuthService, "_get_user_profile_sync", identity)
    monkeypatch.setattr(home, "ensure_platform_subscription_access", access)
    monkeypatch.setattr(
        "app.services.studio_scope.ensure_platform_subscription_access", write_access
    )
    monkeypatch.setattr(
        home.DashboardHomeService, "_studio_today", staticmethod(lambda _tz: (TODAY, "UTC"))
    )
    yield SimpleNamespace(identity=identity, access=access, write_access=write_access)
    for cache in (home.dashboard_home_fact_cache, home.dashboard_home_promotion_cache):
        cache.invalidate(STUDIO, domain="dashboard")


def request(client, role="admin", *, fresh=False, requested_studio_id=STUDIO):
    response = Response()
    payload = asyncio.run(
        dashboard.get_dashboard_home(
            response, f"user-{role}", requested_studio_id, client, fresh=fresh
        )
    )
    return payload.model_dump(mode="json", by_alias=True), response


def wire_request(client, role="admin", *, fresh=False, raise_server_exceptions=True):
    """Mount the real route and response model without the application's lifespan."""
    app = FastAPI()
    app.include_router(dashboard.router, prefix="/api/v1")
    app.dependency_overrides[dashboard.get_current_user_id] = lambda: f"user-{role}"
    app.dependency_overrides[dashboard.get_requested_studio_id] = lambda: STUDIO
    app.dependency_overrides[dashboard.get_supabase] = lambda: client
    with TestClient(app, raise_server_exceptions=raise_server_exceptions) as http:
        return http.get("/api/v1/dashboard/home", params={"fresh": str(fresh).lower()})


def promotion_load_count(client):
    # Each load reads every studio ladder, with embedded ranks, exactly once.
    return sum(
        query["table"] == "belt_ladders" and query["columns"] == "*, belt_ranks(*)"
        for query in client.query_log
    )


@pytest.mark.parametrize(
    "role,kinds,stats_keys,panels",
    [
        (
            "admin",
            ["payments", "setup", "away", "contact"],
            {"active_students", "attendance", "follow_ups", "promotions"},
            {"follow_ups", "ready_to_promote"},
        ),
        (
            "front_desk",
            ["payments", "away", "contact"],
            {"active_students", "attendance", "follow_ups"},
            {"follow_ups"},
        ),
        (
            "instructor",
            ["away"],
            {"active_students", "attendance", "promotions"},
            {"ready_to_promote"},
        ),
    ],
)
def test_fastapi_wire_omits_role_hidden_keys_and_serializes_from_alias(
    role, kinds, stats_keys, panels
):
    client = HomeSupabase()
    response = wire_request(client, role)
    assert response.status_code == 200, response.text
    wire = response.json()
    assert (
        set(wire)
        == {
            "generated_at",
            "viewer",
            "studio",
            "needs_attention",
            "classes_today",
            "stats",
            "recent_students",
        }
        | panels
    )
    assert wire["viewer"] == {"role": role}
    assert set(wire["stats"]) == stats_keys
    assert [item["kind"] for item in wire["needs_attention"]["items"]] == kinds
    assert wire["classes_today"]["rows"][1]["capacity"] is None
    assert wire["recent_students"][0]["name"] == "Mia Chen"
    if "ready_to_promote" in panels:
        rows = wire["ready_to_promote"]["rows"]
        assert [row["student_id"] for row in rows] == ["st-1", "st-2", "st-3"]
        assert wire["stats"]["promotions"] == {"ready_count": 3, "needs_approval": 1}
        assert rows[0]["from"] is None and "from_" not in rows[0]
        assert rows[1]["from"] == {"name": "White", "color": "#FFFFFF"}
        assert rows[1]["needs_approval"] is True
    else:
        assert not any(
            query["table"] in {"belt_ladders", "belt_ranks"} for query in client.query_log
        )
    if role == "instructor":
        assert not any(query["table"] == "leads" for query in client.query_log)
    assert response.headers["cache-control"] == "no-store, private"
    assert response.headers["vary"] == "Authorization, X-Studio-Id, Cookie"
    timing_labels = {
        entry.strip().split(";")[0] for entry in response.headers["server-timing"].split(",")
    }
    assert {"koaryu_home_context", "koaryu_home_facts", "koaryu_home_total"} <= timing_labels
    assert all(label.startswith("koaryu_home_") for label in timing_labels)


def test_no_studio_wire_is_exact_identity_only_with_no_provider_reads(isolated_home):
    isolated_home.identity.side_effect = None
    isolated_home.identity.return_value = auth(studio_id=None)
    client = HomeSupabase()
    response = wire_request(client)
    assert response.status_code == 200
    wire = response.json()
    assert set(wire) == {"generated_at", "viewer"}
    assert wire["generated_at"] and wire["viewer"] == {"role": None}
    assert client.rpc_calls == [] and client.query_log == []
    isolated_home.access.assert_not_called()


@pytest.mark.parametrize("visibility", ["billing_visible", "billing_hidden"])
def test_facts_rpc_uses_accepted_formula_and_exact_request_params_without_table_fanout(visibility):
    client = HomeSupabase()
    facts = home.DashboardHomeService(client).fetch_facts_sync(home_key(visibility=visibility))
    assert client.rpc_calls == [
        (
            "dashboard_summary_facts",
            {
                "p_studio_id": STUDIO,
                "p_visibility": visibility,
                "p_timezone_name": "UTC",
                "p_local_date": "2026-10-10",
                "p_formula_version": "dashboard-summary-v1",
            },
        )
    ]
    assert client.query_log == []
    assert facts.payment_attention_count == (2 if visibility == "billing_visible" else None)


def test_due_follow_ups_use_one_bounded_tenant_filtered_query_for_rows_and_count():
    client = HomeSupabase()
    rows, count = home.DashboardHomeService(client).fetch_due_follow_ups_sync(
        STUDIO, TODAY.isoformat()
    )
    assert count == 8 and len(rows) == 6
    assert [row.id for row in rows] == ["l-1", "l-3", "l-2", "l-t0", "l-t1", "l-t2"]
    assert [(row.follow_up_date, row.id) for row in rows] == sorted(
        (row.follow_up_date, row.id) for row in rows
    )
    assert len(client.query_log) == 1
    query = client.query_log[0]
    assert query["columns"] == "id, first_name, last_name, stage, follow_up_date"
    assert query["limit"] == 6
    assert query["orders"] == (("follow_up_date", False), ("id", False))
    assert set(query["filters"]) == {
        ("eq", "studio_id", STUDIO),
        ("neq", "stage", "enrolled"),
        ("neq", "stage", "closed_lost"),
        ("lte", "follow_up_date", TODAY.isoformat()),
    }
    client.query_log.clear()
    assert (
        home.DashboardHomeService(client).fetch_overdue_follow_up_count_sync(
            STUDIO, TODAY.isoformat()
        )
        == 3
    )
    assert client.query_log[0]["columns"] == "id" and client.query_log[0]["limit"] == 0
    assert ("lt", "follow_up_date", TODAY.isoformat()) in client.query_log[0]["filters"]


@pytest.mark.parametrize("empty", [False, True])
def test_follow_up_stats_use_due_minus_overdue_and_oldest_row_or_null(empty):
    client = HomeSupabase()
    if empty:
        client.tables["leads"] = []
    wire, _ = request(client, "front_desk")
    assert wire["stats"]["follow_ups"] == {
        "due_count": 0 if empty else 8,
        "overdue_count": 0 if empty else 3,
        "due_today_count": 0 if empty else 5,
        "oldest_due_date": None if empty else "2026-10-08",
    }
    assert len(wire["follow_ups"]["rows"]) == (0 if empty else 6)


def lead(lead_id, follow_up_date, stage="inquiry"):
    return {
        "id": lead_id,
        "studio_id": STUDIO,
        "first_name": "Lead",
        "last_name": lead_id,
        "stage": stage,
        "follow_up_date": follow_up_date,
    }


def follow_up_leads(*, overdue, due_today):
    return [lead(f"o-{i}", "2026-10-0" + str(1 + i % 9)) for i in range(overdue)] + [
        lead(f"t-{i}", TODAY.isoformat()) for i in range(due_today)
    ]


def churn_leads(monkeypatch, client, *, before=None, after=None):
    """Change leads around each due-rows read, as a concurrent writer would."""
    original = home.DashboardHomeService.fetch_due_follow_ups_sync
    reads = []

    def churned(self, studio_id, today):
        if before:
            before(client.tables["leads"], len(reads))
        result = original(self, studio_id, today)
        reads.append(result)
        if after:
            after(client.tables["leads"], len(reads))
        return result

    monkeypatch.setattr(home.DashboardHomeService, "fetch_due_follow_ups_sync", churned)
    return reads


def reschedule(leads, lead_ids, follow_up_date):
    for row in leads:
        if row["id"] in lead_ids:
            row["follow_up_date"] = follow_up_date


def overdue_count_queries(client):
    return [q for q in client.query_log if q["table"] == "leads" and q["limit"] == 0]


def follow_up_wire(client, role="front_desk"):
    wire, _ = request(client, role)
    return wire


def test_all_due_rows_settle_overdue_and_skip_the_count_despite_an_intervening_reschedule(
    monkeypatch,
):
    """(a) due_count fits the row limit: every due lead is a row; no second query."""
    client = HomeSupabase()
    client.tables["leads"] = follow_up_leads(overdue=3, due_today=2)
    overdue_ids = {"o-0", "o-1", "o-2"}
    churn_leads(
        monkeypatch, client, after=lambda leads, _: reschedule(leads, overdue_ids, "2026-10-10")
    )
    wire = follow_up_wire(client)
    assert wire["stats"]["follow_ups"] == {
        "due_count": 5,
        "overdue_count": 3,
        "due_today_count": 2,
        "oldest_due_date": "2026-10-01",
    }
    assert sum(row["follow_up_date"] < "2026-10-10" for row in wire["follow_ups"]["rows"]) == 3
    assert overdue_count_queries(client) == []


def test_rows_ending_today_settle_overdue_and_skip_the_count_despite_an_intervening_reschedule(
    monkeypatch,
):
    """(b) More are due, but the last row is due today, so every overdue lead is a row.

    This is the reviewed failure: a reschedule between two snapshots reported
    eight due, none overdue, beside three overdue rows.
    """
    client = HomeSupabase()
    overdue_ids = {"l-1", "l-2", "l-3"}
    churn_leads(
        monkeypatch, client, after=lambda leads, _: reschedule(leads, overdue_ids, "2026-10-10")
    )
    wire = follow_up_wire(client)
    assert wire["stats"]["follow_ups"] == {
        "due_count": 8,
        "overdue_count": 3,
        "due_today_count": 5,
        "oldest_due_date": "2026-10-08",
    }
    assert [row["id"] for row in wire["follow_ups"]["rows"]][:3] == ["l-1", "l-3", "l-2"]
    assert overdue_count_queries(client) == []


def test_all_overdue_rows_use_the_separate_count_when_it_agrees():
    """(c) Every returned row is overdue and more are due: count the rest."""
    client = HomeSupabase()
    client.tables["leads"] = follow_up_leads(overdue=7, due_today=5)
    wire = follow_up_wire(client)
    assert wire["stats"]["follow_ups"] == {
        "due_count": 12,
        "overdue_count": 7,
        "due_today_count": 5,
        "oldest_due_date": "2026-10-01",
    }
    assert all(row["follow_up_date"] < "2026-10-10" for row in wire["follow_ups"]["rows"])
    assert len(overdue_count_queries(client)) == 1


@pytest.mark.parametrize(
    "change,expected",
    [
        # Three overdue leads move to today: the count (4) undercounts six overdue rows.
        (
            lambda leads: reschedule(leads, {"o-0", "o-1", "o-2"}, "2026-10-10"),
            {"due_count": 12, "overdue_count": 4, "due_today_count": 8},
        ),
        # Ten new overdue leads arrive: the count (17) exceeds the twelve due.
        (
            lambda leads: leads.extend(lead(f"n-{i}", "2026-10-02") for i in range(10)),
            {"due_count": 22, "overdue_count": 17, "due_today_count": 5},
        ),
    ],
)
def test_inconsistent_separate_count_retries_the_pair_once_and_reports_the_retry(
    monkeypatch, change, expected
):
    """(c) A count from another snapshot that contradicts the rows is not used."""
    client = HomeSupabase()
    client.tables["leads"] = follow_up_leads(overdue=7, due_today=5)
    reads = churn_leads(
        monkeypatch, client, after=lambda leads, count: change(leads) if count == 1 else None
    )
    wire = follow_up_wire(client)
    stats = wire["stats"]["follow_ups"]
    assert {name: stats[name] for name in expected} == expected
    rows = wire["follow_ups"]["rows"]
    assert sum(row["follow_up_date"] < "2026-10-10" for row in rows) <= stats["overdue_count"]
    assert stats["oldest_due_date"] == rows[0]["follow_up_date"]
    assert len(reads) == 2


def test_follow_ups_are_omitted_when_the_count_disagrees_with_the_rows_twice(monkeypatch):
    """(c) Still inconsistent after one retry: omit both follow-up sections."""
    client = HomeSupabase()
    client.tables["leads"] = follow_up_leads(overdue=7, due_today=5)
    churning = {"o-0", "o-1", "o-2", "o-3", "o-4"}
    # The same leads flip between overdue and today on either side of each read.
    reads = churn_leads(
        monkeypatch,
        client,
        before=lambda leads, _: reschedule(leads, churning, "2026-10-03"),
        after=lambda leads, _: reschedule(leads, churning, "2026-10-10"),
    )
    wire = follow_up_wire(client)
    assert "follow_ups" not in wire and "follow_ups" not in wire["stats"]
    assert {"studio", "needs_attention", "classes_today", "recent_students"} <= set(wire)
    assert len(reads) == 2 and len(overdue_count_queries(client)) == 2


@pytest.mark.parametrize(
    "contact_missing,rows,expected,lookup",
    [
        (1, [("st-1", "")], "st-1", True),
        (1, [("st-1", None)], "st-1", True),
        (1, [], None, True),
        (1, [("st-1", ""), ("st-2", None)], None, True),
        (2, [("st-1", ""), ("st-2", None)], None, False),
    ],
)
def test_contact_lookup_only_for_single_count_and_exactly_one_matching_student(
    contact_missing, rows, expected, lookup
):
    client = HomeSupabase(contact_missing=contact_missing)
    client.tables["students"] = [
        {
            "id": student_id,
            "studio_id": STUDIO,
            "status": "trialing",
            "deleted_at": None,
            "emergency_contact_name": name,
        }
        for student_id, name in rows
    ]
    client.tables["students"] += [
        {
            "id": "other",
            "studio_id": "other-studio",
            "status": "active",
            "deleted_at": None,
            "emergency_contact_name": "",
        },
        {
            "id": "deleted",
            "studio_id": STUDIO,
            "status": "active",
            "deleted_at": "2026-10-01",
            "emergency_contact_name": "",
        },
        {
            "id": "inactive",
            "studio_id": STUDIO,
            "status": "inactive",
            "deleted_at": None,
            "emergency_contact_name": "",
        },
        {
            "id": "whitespace",
            "studio_id": STUDIO,
            "status": "active",
            "deleted_at": None,
            "emergency_contact_name": " ",
        },
    ]
    wire, _ = request(client, "front_desk")
    contact = next(item for item in wire["needs_attention"]["items"] if item["kind"] == "contact")
    assert contact["count"] == contact_missing
    if expected:
        assert contact["student_id"] == expected
    else:
        assert "student_id" not in contact
    queries = [query for query in client.query_log if query["table"] == "students"]
    assert len(queries) == int(lookup)
    if lookup:
        assert queries[0]["limit"] == 2
        assert queries[0]["columns"] == "id"
        assert queries[0]["or_filters"] == (
            "emergency_contact_name.is.null,emergency_contact_name.eq.",
        )


def test_failed_contact_lookup_drops_only_student_id():
    client = HomeSupabase()
    client.table_failures["students"] = RuntimeError("lookup unavailable")
    wire, _ = request(client, "front_desk")
    assert wire["needs_attention"]["items"][-1] == {"kind": "contact", "count": 1}
    assert {"stats", "classes_today", "follow_ups", "recent_students", "studio"} <= set(wire)


def test_promotions_pick_first_ladder_from_service_order(monkeypatch):
    primary = SimpleNamespace(
        id="primary", ranks=[SimpleNamespace(id="yellow"), SimpleNamespace(id="white")]
    )
    entries = [
        eligibility("approval-only", needs_approval=True, is_eligible=False),
        eligibility("on-yellow", rank="yellow"),
    ]
    load = AsyncMock(return_value=(primary, entries))
    monkeypatch.setattr(home.BeltService, "get_primary_ladder_eligibility", load)
    wire, _ = request(HomeSupabase())
    load.assert_awaited_once_with(STUDIO)
    assert wire["stats"]["promotions"] == {"ready_count": 2, "needs_approval": 1}
    # Groups follow the primary ladder's rank order.
    assert [row["student_id"] for row in wire["ready_to_promote"]["rows"]] == [
        "on-yellow",
        "approval-only",
    ]


def test_no_ladder_returns_present_empty_promotions_without_eligibility_read(monkeypatch):
    client = HomeSupabase()
    client.tables["belt_ladders"] = []
    entries = AsyncMock(side_effect=AssertionError("No ladder must not trigger eligibility"))
    monkeypatch.setattr(BeltEligibilityCalculator, "get_eligibility", entries)
    wire, _ = request(client)
    assert wire["stats"]["promotions"] == {"ready_count": 0, "needs_approval": 0}
    assert wire["ready_to_promote"] == {"rows": []}
    entries.assert_not_awaited()
    assert not any(
        query["table"] in {"belt_ranks", "student_program_memberships", "promotions", "attendance"}
        for query in client.query_log
    )


def belt_rank(rank_id, ladder_id, name, display_order, *, studio_id=STUDIO):
    return {
        "id": rank_id,
        "ladder_id": ladder_id,
        "studio_id": studio_id,
        "name": name,
        "color_hex": "#000000",
        "display_order": display_order,
        "min_classes": 0,
        "min_months": 0,
        "requires_approval": False,
        "is_tip": False,
        "created_at": "2026-01-01T00:00:00+00:00",
    }


def add_ladder(data, ladder_id, program_id, created_at, ranks, *, studio_id=STUDIO):
    data["belt_ladders"].append(
        {
            "id": ladder_id,
            "studio_id": studio_id,
            "name": ladder_id,
            "program_id": program_id,
            "sub_rank_term": "Stripe",
            "created_at": created_at,
            "updated_at": created_at,
            "belt_ranks": ranks,
        }
    )
    data["belt_ranks"] = [*data["belt_ranks"], *ranks]


def add_program(data, program_id, *, studio_id=STUDIO, is_system=False, archived_at=None):
    data["programs"].append(
        {
            "id": program_id,
            "studio_id": studio_id,
            "is_system": is_system,
            "archived_at": archived_at,
        }
    )


def student(data, student_id):
    return next(row for row in data["students"] if row["id"] == student_id)


def hidden_rank_parent(program_id, **program):
    """An older hidden ladder owns st-1's current rank; st-1 stays in prog-1."""

    def mutate(data):
        if program_id:
            add_program(data, program_id, **program)
        add_ladder(
            data,
            "lad-hidden",
            program_id,
            "2025-12-01T00:00:00+00:00",
            [belt_rank("r-hidden", "lad-hidden", "Hidden", 1)],
        )
        student(data, "st-1")["current_belt_rank_id"] = "r-hidden"

    return mutate


def membership_rank_parents(data):
    hidden_rank_parent("prog-archived", archived_at="2026-02-01T00:00:00+00:00")(data)
    student(data, "st-1")["current_belt_rank_id"] = None
    data["student_program_memberships"] = [
        {
            "id": "m-hidden",
            "studio_id": STUDIO,
            "student_id": "st-1",
            "program_id": "prog-1",
            "status": "active",
            "ended_at": None,
            "started_at": "2026-01-01",
            "current_belt_rank_id": "r-hidden",
        },
        {
            "id": "m-paused",
            "studio_id": STUDIO,
            "student_id": "st-2",
            "program_id": "prog-1",
            "status": "paused",
            "ended_at": None,
            "started_at": "2026-01-01",
            "current_belt_rank_id": "r-white",
        },
    ]


def foreign_studio_ladder(data):
    add_program(data, "prog-foreign", studio_id="other")
    add_ladder(
        data,
        "lad-foreign",
        "prog-foreign",
        "2025-01-01T00:00:00+00:00",
        [belt_rank("r-foreign", "lad-foreign", "Foreign", 1, studio_id="other")],
        studio_id="other",
    )
    student(data, "st-1")["current_belt_rank_id"] = "r-foreign"


def older_visible_ladder(data):
    add_program(data, "prog-0")
    add_ladder(
        data,
        "lad-0",
        "prog-0",
        "2025-12-01T00:00:00+00:00",
        [belt_rank("r-zero", "lad-0", "Zero", 1)],
    )


def equal_rank_order(data):
    # Amber sorts before Yellow canonically (same order and time, smaller id),
    # but the embedded payload lists Yellow first.
    white, yellow, orange = data["belt_ranks"]
    amber = {**belt_rank("r-amber", "lad-1", "Amber", 2), "created_at": yellow["created_at"]}
    data["belt_ladders"][0]["belt_ranks"] = [white, yellow, amber, orange]
    data["belt_ranks"] = [white, yellow, amber, orange]
    data["students"].append(
        {
            **student(data, "st-3"),
            "id": "st-5",
            "legal_first_name": "Eve",
            "current_belt_rank_id": "r-amber",
        }
    )


def no_visible_program(data):
    data["programs"][0]["archived_at"] = "2026-02-01T00:00:00+00:00"


def only_hidden_ladders(data):
    add_program(data, "prog-archived", archived_at="2026-02-01T00:00:00+00:00")
    data["belt_ladders"][0]["program_id"] = "prog-archived"


def promotion_trace(client, start):
    return [(query["table"], query["columns"]) for query in client.query_log[start:]]


@pytest.mark.parametrize(
    "mutate,ready_ids",
    [
        (lambda data: None, ["st-1", "st-2", "st-3"]),
        (
            hidden_rank_parent("prog-archived", archived_at="2026-02-01T00:00:00+00:00"),
            ["st-2", "st-3"],
        ),
        (hidden_rank_parent("prog-system", is_system=True), ["st-2", "st-3"]),
        (hidden_rank_parent(None), ["st-2", "st-3"]),
        (membership_rank_parents, ["st-2", "st-3"]),
        (foreign_studio_ladder, ["st-1", "st-2", "st-3"]),
        (older_visible_ladder, []),
        (equal_rank_order, ["st-1", "st-2", "st-3", "st-5"]),
        (no_visible_program, []),
        (only_hidden_ladders, []),
    ],
    ids=[
        "single-visible",
        "archived-parent",
        "system-parent",
        "unscoped-parent",
        "membership-parents",
        "foreign-studio",
        "older-visible-primary",
        "equal-rank-order",
        "no-visible-program",
        "only-hidden-ladders",
    ],
)
def test_promotions_match_list_ladders_then_eligibility_with_one_fewer_ladder_read(
    mutate, ready_ids
):
    client = HomeSupabase()
    mutate(client.tables)

    async def previous_projection():
        belts = home.BeltService(client)
        ladders = await belts.list_ladders(STUDIO)
        if not ladders:
            return home.EMPTY_DASHBOARD_HOME_PROMOTIONS
        entries = await belts.get_eligibility(STUDIO, ladders[0].id)
        return build_promotions(entries, [rank.id for rank in ladders[0].ranks])

    previous = asyncio.run(previous_projection())
    previous_trace = promotion_trace(client, 0)
    start = len(client.query_log)
    current = asyncio.run(home.DashboardHomeService(client).fetch_promotions(STUDIO))
    trace = promotion_trace(client, start)

    assert current == previous
    assert [row.student_id for row in current.ready_to_promote.rows] == ready_ids
    # The Belt Tracker's list is one joined read. Home reads programs and, when
    # one is visible, one all-ladder snapshot, then the calculator's reads
    # without its own flat ladder metadata read.
    assert previous_trace[0] == ("belt_ladders", "*, belt_ranks(*), programs!inner()")
    snapshot = [("belt_ladders", "*, belt_ranks(*)")] if mutate is not no_visible_program else []
    assert trace == [
        ("programs", "id, is_system, archived_at"),
        *snapshot,
        *[read for read in previous_trace if read[0] != "belt_ladders"],
    ]
    ladder_reads = [query for query in client.query_log[start:] if query["table"] == "belt_ladders"]
    assert all(query["filters"] == (("eq", "studio_id", STUDIO),) for query in ladder_reads)


def test_fresh_promotion_load_reads_each_ladder_table_once():
    client = HomeSupabase()
    asyncio.run(home.DashboardHomeService(client).fetch_promotions(STUDIO))
    assert [query["table"] for query in client.query_log] == [
        "programs",
        "belt_ladders",
        "belt_ranks",
        "students",
        "student_program_memberships",
        "promotions",
        "attendance",
    ]
    ranks_read = client.query_log[2]
    assert ranks_read["orders"] == (
        ("ladder_id", False),
        ("display_order", False),
        ("created_at", False),
        ("id", False),
    )


def test_equal_rank_order_groups_by_embedded_order_and_steps_by_canonical_order():
    client = HomeSupabase()
    equal_rank_order(client.tables)
    promotions = asyncio.run(home.DashboardHomeService(client).fetch_promotions(STUDIO))
    rows = {row.student_id: row for row in promotions.ready_to_promote.rows}
    # Embedded order groups Yellow before Amber.
    assert list(rows) == ["st-1", "st-2", "st-3", "st-5"]
    # Canonical (display_order, created_at, id) order steps White to Amber to Yellow.
    assert [rows[student_id].to.name for student_id in rows] == [
        "White",
        "Amber",
        "Orange",
        "Yellow",
    ]


@pytest.mark.parametrize(
    "failure", [RuntimeError("provider unavailable"), ValueError("invalid eligibility")]
)
def test_promotion_failure_omits_both_sections_and_retains_every_other_section(
    monkeypatch, failure
):
    monkeypatch.setattr(
        home.DashboardHomeService, "fetch_promotions", AsyncMock(side_effect=failure)
    )
    wire = wire_request(HomeSupabase()).json()
    assert "promotions" not in wire["stats"] and "ready_to_promote" not in wire
    assert {"follow_ups", "classes_today", "needs_attention", "recent_students"} <= set(wire)


def test_concurrent_identical_misses_share_one_rpc_and_hits_load_neither_cache(monkeypatch):
    client = HomeSupabase()
    service = home.DashboardHomeService(client)
    context = service.resolve_context_sync("user-admin", STUDIO)
    fact_cache, promotion_cache = DashboardSummaryFactCache(), DashboardSummaryFactCache()
    original = home.DashboardHomeService.fetch_facts_sync

    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()

        async def slow_facts(self, key, **kwargs):
            started.set()
            await release.wait()
            return original(self, key, **kwargs)

        monkeypatch.setattr(home.DashboardHomeService, "fetch_facts_sync", slow_facts)
        tasks = [
            asyncio.create_task(
                home.DashboardHomeService.get_dashboard_home_from_context(
                    client, context, fact_cache=fact_cache, promotion_cache=promotion_cache
                )
            )
            for _ in range(5)
        ]
        await asyncio.wait_for(started.wait(), timeout=2)
        assert client.rpc_calls == []
        release.set()
        responses = await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)
        before = len(client.query_log)
        await home.DashboardHomeService.get_dashboard_home_from_context(
            client, context, fact_cache=fact_cache, promotion_cache=promotion_cache
        )
        assert not any(query["table"] == "belt_ladders" for query in client.query_log[before:])
        return responses

    responses = asyncio.run(exercise())
    assert len(client.rpc_calls) == 1
    assert promotion_load_count(client) == 1
    assert all(payload.stats.active_students.total == 9 for payload, _ in responses)


def test_cache_hit_resolves_identity_access_and_role_anew_every_request(isolated_home):
    client = HomeSupabase()
    isolated_home.identity.side_effect = [auth("first-owner"), auth("front-desk", "front_desk")]
    first, _ = request(client)
    second, _ = request(client, "front_desk")
    assert first["viewer"] == {"role": "admin"} and second["viewer"] == {"role": "front_desk"}
    assert "ready_to_promote" not in second and "promotions" not in second["stats"]
    assert "setup" not in [item["kind"] for item in second["needs_attention"]["items"]]
    assert len(client.rpc_calls) == 1
    assert [call.args for call in isolated_home.identity.call_args_list] == [
        ("user-admin", STUDIO),
        ("user-front_desk", STUDIO),
    ]
    assert isolated_home.access.call_count == 2
    assert [query["table"] for query in client.query_log].count("studios") == 2


def test_fresh_true_bypasses_both_warm_caches_and_returns_updated_facts():
    client = HomeSupabase()
    before, _ = request(client)
    client.facts_transform = lambda raw: {
        **raw,
        "students": {**raw["students"], "total_students": 99},
    }
    cached, _ = request(client)
    fresh, _ = request(client, fresh=True)
    assert (
        before["stats"]["active_students"]["total"]
        == cached["stats"]["active_students"]["total"]
        == 9
    )
    assert fresh["stats"]["active_students"]["total"] == 99
    assert len(client.rpc_calls) == 2
    assert promotion_load_count(client) == 2


def test_admin_and_instructor_share_promotions_but_not_billing_facts():
    client = HomeSupabase()
    admin, _ = request(client)
    instructor, _ = request(client, "instructor")
    assert admin["stats"]["promotions"] == instructor["stats"]["promotions"]
    assert promotion_load_count(client) == 1
    assert [params["p_visibility"] for _, params in client.rpc_calls] == [
        "billing_visible",
        "billing_hidden",
    ]
    assert [item["kind"] for item in instructor["needs_attention"]["items"]] == ["away"]


def test_fresh_bypasses_older_inflight_facts_and_promotions():
    client = HomeSupabase()
    context = home.DashboardHomeService(client).resolve_context_sync("user-admin", STUDIO)
    fact_cache, promotion_cache = DashboardSummaryFactCache(), DashboardSummaryFactCache()
    old_facts = validate_dashboard_home_facts(rpc_facts(), context.facts_key)
    old_promotions = build_promotions([], [])
    client.facts_transform = lambda raw: {
        **raw,
        "students": {**raw["students"], "total_students": 99},
    }

    async def exercise():
        facts_started, promotions_started, release = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )

        async def old_facts_loader():
            facts_started.set()
            await release.wait()
            return old_facts

        async def old_promotions_loader():
            promotions_started.set()
            await release.wait()
            return old_promotions

        pending = [
            asyncio.create_task(fact_cache.get_or_load(context.facts_key, old_facts_loader)),
            asyncio.create_task(
                promotion_cache.get_or_load(context.promotions_key, old_promotions_loader)
            ),
        ]
        try:
            await asyncio.wait_for(
                asyncio.gather(facts_started.wait(), promotions_started.wait()), timeout=2
            )
            payload, _ = await asyncio.wait_for(
                home.DashboardHomeService.get_dashboard_home_from_context(
                    client,
                    context,
                    fact_cache=fact_cache,
                    promotion_cache=promotion_cache,
                    fresh=True,
                ),
                timeout=2,
            )
            assert payload.stats.active_students.total == 99
            assert payload.stats.promotions.ready_count == 3
            assert all(not task.done() for task in pending)
        finally:
            release.set()
            await asyncio.gather(*pending)

    asyncio.run(exercise())
    assert len(client.rpc_calls) == 1 and promotion_load_count(client) == 1


def test_still_unavailable_agenda_can_materialize_again_after_fifteen_second_ttl():
    client = HomeSupabase(agenda_available=False, remains_unavailable=True)
    context = home.DashboardHomeService(client).resolve_context_sync("user-admin", STUDIO)
    now = [0.0]
    fact_cache = DashboardSummaryFactCache(clock=lambda: now[0])
    promotion_cache = DashboardSummaryFactCache(clock=lambda: now[0])

    async def load():
        payload, _ = await home.DashboardHomeService.get_dashboard_home_from_context(
            client, context, fact_cache=fact_cache, promotion_cache=promotion_cache
        )
        assert payload.classes_today is None

    async def exercise():
        await load()
        now[0] = 14.99
        await load()
        assert [name for name, _ in client.rpc_calls].count(
            "materialize_recurring_class_sessions"
        ) == 1
        now[0] = 15.0
        await load()
        assert [name for name, _ in client.rpc_calls].count(
            "materialize_recurring_class_sessions"
        ) == 2

    asyncio.run(exercise())
    assert [name for name, _ in client.rpc_calls].count("dashboard_summary_facts") == 4
    assert promotion_load_count(client) == 2


def test_shared_invalidation_evicts_both_home_caches():
    client = HomeSupabase()

    async def exercise():
        await dashboard.get_dashboard_home(Response(), "user-admin", STUDIO, client)
        caches = (home.dashboard_home_fact_cache, home.dashboard_home_promotion_cache)
        generations = [cache.generation(STUDIO) for cache in caches]
        invalidate_dashboard_fact_caches(STUDIO, domain="dashboard")
        assert [cache.generation(STUDIO) for cache in caches] == [
            generation + 1 for generation in generations
        ]
        await dashboard.get_dashboard_home(Response(), "user-admin", STUDIO, client)

    asyncio.run(exercise())
    assert len(client.rpc_calls) == 2
    assert promotion_load_count(client) == 2


@pytest.mark.parametrize("remains_unavailable", [False, True])
def test_unavailable_agenda_materializes_today_checks_permission_rereads_once_and_reuses_result(
    isolated_home, remains_unavailable
):
    client = HomeSupabase(agenda_available=False, remains_unavailable=remains_unavailable)
    caches = (home.dashboard_home_fact_cache, home.dashboard_home_promotion_cache)
    before = [cache.generation(STUDIO) for cache in caches]
    with patch.object(
        home, "resolve_write_staff_role_for_user", wraps=home.resolve_write_staff_role_for_user
    ) as permission:
        wire, response = request(client)
        permission.assert_called_once_with(
            client, "user-admin", STUDIO, require_platform_subscription=True
        )
        isolated_home.write_access.assert_called_once_with(client, STUDIO)
        assert any(query["table"] == "staff_roles" for query in client.query_log)
        assert [name for name, _ in client.rpc_calls] == [
            "dashboard_summary_facts",
            "materialize_recurring_class_sessions",
            "dashboard_summary_facts",
        ]
        assert client.rpc_calls[1][1] == {
            "p_studio_id": STUDIO,
            "p_start_date": TODAY.isoformat(),
            "p_end_date": TODAY.isoformat(),
        }
        assert ("classes_today" in wire) is not remains_unavailable
        assert {"stats", "needs_attention", "follow_ups", "ready_to_promote"} <= set(wire)
        assert "koaryu_home_materialize" in response.headers["server-timing"]
        assert "koaryu_home_facts_after_materialize" in response.headers["server-timing"]
        client.rpc_calls.clear()
        second, _ = request(client)
        assert client.rpc_calls == []
        assert ("classes_today" in second) is not remains_unavailable
        assert permission.call_count == 1
        assert [cache.generation(STUDIO) for cache in caches] == [before[0] + 1, before[1]]
        assert promotion_load_count(client) == 1


def test_available_agenda_never_materializes_or_checks_write_permission():
    client = HomeSupabase()
    with patch.object(home, "resolve_write_staff_role_for_user") as permission:
        request(client)
    permission.assert_not_called()
    assert [name for name, _ in client.rpc_calls] == ["dashboard_summary_facts"]


def test_failed_materialization_hides_only_classes_today():
    wire = wire_request(
        HomeSupabase(agenda_available=False, materialize_error=RuntimeError("write failed"))
    ).json()
    assert "classes_today" not in wire
    assert {
        "studio",
        "stats",
        "needs_attention",
        "follow_ups",
        "ready_to_promote",
        "recent_students",
    } <= set(wire)


def test_materialization_permission_denial_skips_the_write_and_hides_only_classes(monkeypatch):
    client = HomeSupabase(agenda_available=False)
    permission = Mock(side_effect=HTTPException(status_code=403, detail="write denied"))
    monkeypatch.setattr(home, "resolve_write_staff_role_for_user", permission)
    response = wire_request(client)
    assert response.status_code == 200
    wire = response.json()
    assert "classes_today" not in wire
    assert {"studio", "stats", "needs_attention", "recent_students"} <= set(wire)
    permission.assert_called_once_with(
        client, "user-admin", STUDIO, require_platform_subscription=True
    )
    assert not any(name == "materialize_recurring_class_sessions" for name, _ in client.rpc_calls)


def test_leads_failure_hides_only_follow_ups_sections_through_fastapi():
    client = HomeSupabase()
    client.table_failures["leads"] = RuntimeError("leads unavailable")
    response = wire_request(client)
    assert response.status_code == 200
    wire = response.json()
    assert "follow_ups" not in wire and "follow_ups" not in wire["stats"]
    assert {"classes_today", "ready_to_promote", "needs_attention", "recent_students"} <= set(wire)
    assert "promotions" in wire["stats"]


@pytest.mark.parametrize("needed", [True, False])
def test_overdue_count_access_denial_is_fatal_whenever_the_count_is_read(monkeypatch, needed):
    client = HomeSupabase()
    if needed:
        client.tables["leads"] = follow_up_leads(overdue=7, due_today=5)
    count = Mock(side_effect=HTTPException(status_code=403, detail="count access denied"))
    monkeypatch.setattr(home.DashboardHomeService, "fetch_overdue_follow_up_count_sync", count)
    response = wire_request(client, "front_desk")
    # When the rows settle the overdue count, the count query (and its denial) never runs.
    assert response.status_code == (403 if needed else 200)
    assert count.call_count == (1 if needed else 0)


@pytest.mark.parametrize("status", [401, 402, 403, 409])
@pytest.mark.parametrize("section", ["leads", "belt_ladders", "students"])
def test_optional_section_access_denials_remain_fatal(section, status):
    client = HomeSupabase()
    client.table_failures[section] = HTTPException(status_code=status, detail="access denied")
    response = wire_request(client)
    assert response.status_code == status and response.json() == {"detail": "access denied"}


@pytest.mark.parametrize("code", ["42501", "28000", "28P01", "PGRST301", "PGRST302", "PGRST303"])
def test_provider_access_errors_are_not_hidden_as_missing_sections(code):
    client = HomeSupabase()
    error = APIError({"code": code, "message": "access denied"})
    client.table_failures["leads"] = error
    with pytest.raises(APIError) as result:
        request(client)
    assert result.value is error


def test_subscription_denial_precedes_even_warm_cache_and_every_provider_read(isolated_home):
    client = HomeSupabase()
    request(client)
    client.rpc_calls.clear()
    client.query_log.clear()
    isolated_home.access.side_effect = HTTPException(
        status_code=402, detail="subscription required"
    )
    response = wire_request(client)
    assert response.status_code == 402
    assert client.rpc_calls == [] and client.query_log == []


@pytest.mark.parametrize("failure", ["provider", "shape", "mismatch"])
def test_facts_failures_fail_whole_request_instead_of_returning_partial_home(failure):
    client = HomeSupabase()
    if failure == "provider":
        client.facts_error = RuntimeError("facts unavailable")
    elif failure == "shape":
        client.facts_transform = lambda _: []
    else:
        client.facts_transform = lambda raw: {
            **raw,
            "studio": {**raw["studio"], "id": "wrong-studio"},
        }
    response = wire_request(client, raise_server_exceptions=False)
    assert response.status_code == 500, (
        "Production bug: failed or mismatched facts must fail the entire Home request"
    )


def test_concurrent_unavailable_agenda_writes_and_invalidates_once_and_every_request_succeeds(
    monkeypatch,
):
    client = HomeSupabase(agenda_available=False)
    service = home.DashboardHomeService(client)
    contexts = [
        service.resolve_context_sync(f"user-{role}", STUDIO)
        for role in ("admin", "front_desk", "instructor", "admin")
    ]
    fact_cache, promotion_cache = DashboardSummaryFactCache(), DashboardSummaryFactCache()
    original_facts = home.DashboardHomeService.fetch_facts_sync
    original_materialize = home.DashboardHomeService.materialize_today
    writers = []

    async def exercise():
        release = asyncio.Event()
        waiting = []

        async def gated_facts(self, key, **kwargs):
            if not release.is_set():
                # Hold every first read until all requests share an unavailable agenda.
                waiting.append(key.visibility)
                await release.wait()
            else:
                # Keep re-reads in flight while any later write could land.
                await asyncio.sleep(0.015)
            return original_facts(self, key, **kwargs)

        async def staggered_materialize(self, user_id, key):
            writers.append(user_id)
            await asyncio.sleep(0.01 * len(writers))
            await original_materialize(self, user_id, key)

        monkeypatch.setattr(home.DashboardHomeService, "fetch_facts_sync", gated_facts)
        monkeypatch.setattr(home.DashboardHomeService, "materialize_today", staggered_materialize)
        tasks = [
            asyncio.create_task(
                home.DashboardHomeService.get_dashboard_home_from_context(
                    client, context, fact_cache=fact_cache, promotion_cache=promotion_cache
                )
            )
            for context in contexts
        ]
        while sorted(waiting) != ["billing_hidden", "billing_visible"]:
            await asyncio.sleep(0)
        release.set()
        return await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)

    responses = asyncio.run(exercise())
    assert [payload.classes_today is not None for payload, _ in responses] == [True] * 4
    assert len(writers) == 1
    assert [name for name, _ in client.rpc_calls].count("materialize_recurring_class_sessions") == 1
    assert fact_cache.generation(STUDIO) == 1
    assert [payload.viewer.role for payload, _ in responses] == [
        "admin",
        "front_desk",
        "instructor",
        "admin",
    ]
    instructor = responses[2][0]
    assert all(item.kind != "payments" for item in instructor.needs_attention.items)
    assert home._agenda_recoveries == {}


@pytest.mark.parametrize(
    "role,denied_table",
    [("admin", "leads"), ("front_desk", "leads"), ("instructor", "belt_ladders")],
)
def test_access_denial_in_any_section_wins_over_a_simultaneous_facts_failure(role, denied_table):
    client = HomeSupabase()
    client.facts_error = RuntimeError("facts temporarily unavailable")
    client.table_failures[denied_table] = HTTPException(status_code=403, detail="access denied")
    response = wire_request(client, role, raise_server_exceptions=False)
    assert response.status_code == 403
    assert response.json() == {"detail": "access denied"}
