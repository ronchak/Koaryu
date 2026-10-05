"""Synthetic candidate reads prove advisory filtering, not atomic SQL approval."""

import asyncio
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.api.v1.endpoints import belt_tests as routes
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.belt import EligibilityEntry
from app.schemas.belt_test import BeltTestEventResponse
from app.services import belt_eligibility
from app.services.belt_eligibility import (
    CANDIDATES_CONTEXT_DETAIL,
    CANDIDATES_STATE_DETAIL,
    CANDIDATES_UNAVAILABLE_DETAIL,
    BeltEligibilityCalculator,
)
from app.services.belt_test_service import ADMIN_REQUIRED_DETAIL, UNAVAILABLE_DETAIL
from tests.fakes.supabase import FakeResult, FakeTableQuery
from tests.test_belt_test_events import (
    ACTOR,
    BASE,
    EVENT,
    GET,
    LADDER,
    OTHER,
    PROGRAM,
    ROW,
    STUDIO,
    Database,
)

STUDENT, MEMBERSHIP, FIRST, SECOND, LAST, OTHER_LADDER, OTHER_PROGRAM = (
    str(UUID(int=value)) for value in range(100, 107)
)
NOW = datetime(2026, 10, 6, 0, 30, tzinfo=UTC)
PATH = BASE + f"/{EVENT}/candidates"


class CandidateQuery(FakeTableQuery):
    def _value_for_key(self, row, key):
        if "." in key:
            parent, child = key.split(".", 1)
            return (row.get(parent) or {}).get(child)
        return super()._value_for_key(row, key)

    def execute(self):
        result = super().execute()
        if self.name in self.supabase.read_overrides:
            return FakeResult(self.supabase.read_overrides[self.name])
        return result


class CandidateDatabase(Database):
    def __init__(self):
        super().__init__()
        self.read_overrides = {}
        self.tables.update(
            {
                "studios": [{"id": STUDIO, "timezone": "America/Los_Angeles"}],
                "programs": [{"id": PROGRAM, "studio_id": STUDIO, "archived_at": None}],
                "belt_ladders": [
                    {
                        "id": LADDER,
                        "name": "Belts",
                        "studio_id": STUDIO,
                        "program_id": PROGRAM,
                        "created_at": "2026-01-01T00:00:00Z",
                    }
                ],
                "belt_ranks": [
                    {
                        "id": rank_id,
                        "studio_id": STUDIO,
                        "ladder_id": LADDER,
                        "name": name,
                        "color_hex": "#FFFFFF",
                        "display_order": index,
                        "created_at": "2026-01-01T00:00:00Z",
                        "min_classes": 0,
                        "min_months": 0,
                        "requires_approval": False,
                    }
                    for index, (rank_id, name) in enumerate(
                        [(FIRST, "White"), (SECOND, "Yellow"), (LAST, "Green")], start=1
                    )
                ],
                "students": [
                    {
                        "id": STUDENT,
                        "studio_id": STUDIO,
                        "status": "active",
                        "deleted_at": None,
                        "legal_first_name": "Sam",
                        "legal_last_name": "Lee",
                        "preferred_name": None,
                        "hold_start_date": None,
                        "hold_end_date": None,
                        "membership_start_date": "2026-10-05",
                        "program_id": PROGRAM,
                        "current_belt_rank_id": FIRST,
                    }
                ],
                "student_program_memberships": [
                    {
                        "id": MEMBERSHIP,
                        "studio_id": STUDIO,
                        "student_id": STUDENT,
                        "program_id": PROGRAM,
                        "status": "active",
                        "ended_at": None,
                        "started_at": "2026-10-05T01:00:00Z",
                        "current_belt_rank_id": FIRST,
                    }
                ],
                "promotions": [],
                "attendance": [],
            }
        )
        self.handlers[GET] = {
            "payload": {
                **ROW,
                "starts_at": "2026-10-07T12:00:00Z",
                "ends_at": "2026-10-07T13:00:00Z",
                "timezone": "Pacific/Kiritimati",
            }
        }
        self.required_eq_filters = {
            table: {"studio_id"}
            for table in (
                "belt_ladders",
                "belt_ranks",
                "programs",
                "students",
                "student_program_memberships",
                "promotions",
                "attendance",
            )
        }
        self.required_eq_filters["studios"] = {"id"}

    def table(self, name):
        return CandidateQuery(self, name)


@pytest.fixture
def database(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            assert tz is UTC
            return NOW

    monkeypatch.setattr(belt_eligibility, "datetime", Clock)
    return CandidateDatabase()


@pytest.fixture
def api(monkeypatch, database):
    def entitled(client, studio_id):
        assert client is database and studio_id == STUDIO
        assert {query["table"] for query in database.query_log} == {"staff_roles"}
        assert database.rpc_calls == []

    subscription = Mock(side_effect=entitled)
    monkeypatch.setattr(routes, "ensure_platform_subscription_access", subscription)
    lane_calls = []
    original_run = routes.run_supabase_operation

    async def tracked_run(provider, operation, *, lane):
        lane_calls.append(lane)
        return await original_run(provider, operation, lane=lane)

    monkeypatch.setattr(routes, "run_supabase_operation", tracked_run)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield client, database, subscription, lane_calls, app


def candidates(database):
    event = BeltTestEventResponse.model_validate(database.handlers[GET]["payload"])
    return asyncio.run(BeltEligibilityCalculator(database).get_event_candidates(STUDIO, event))


def generic(database):
    return asyncio.run(BeltEligibilityCalculator(database).get_eligibility(STUDIO, LADDER))


def unscoped(database, *, legacy=True):
    database.tables["belt_ladders"][0]["program_id"] = None
    database.handlers[GET]["payload"]["program_id"] = None
    if legacy:
        database.tables["student_program_memberships"] = []


def assert_read_only(database):
    assert all(
        query["insert"] is None
        and query["upsert"] is None
        and query["update"] is None
        and not query["delete"]
        for query in database.query_log
    )
    assert all(name == GET for name, _ in database.rpc_calls)


@pytest.mark.parametrize("status", ["active", "paused"])
def test_current_exact_memberships_are_visible_with_advisory_approval_flags(database, status):
    database.tables["student_program_memberships"][0]["status"] = status
    database.tables["belt_ranks"][1]["requires_approval"] = True
    (entry,) = candidates(database)
    assert isinstance(entry, EligibilityEntry)
    assert entry.student_program_membership_id == MEMBERSHIP
    assert entry.program_id == PROGRAM
    assert entry.current_rank_id == FIRST and entry.next_rank_id == SECOND
    assert entry.classes_met and entry.time_met and entry.needs_approval
    assert not entry.is_eligible
    assert_read_only(database)


def test_unmet_classes_and_time_are_visible(database):
    database.tables["belt_ranks"][1].update(min_classes=10, min_months=1)
    (entry,) = candidates(database)
    assert not entry.classes_met and not entry.time_met and not entry.is_eligible
    assert entry.classes_required == 10 and entry.days_required == 30


def test_scoped_event_rejects_legacy_null_membership_before_generic_fallback(database):
    database.tables["student_program_memberships"] = []
    assert len(generic(database)) == 1
    assert candidates(database) == []


@pytest.mark.parametrize("rank", [None, FIRST])
@pytest.mark.parametrize("program", [None, PROGRAM])
def test_unscoped_event_supports_only_current_legacy_scalar_program(database, rank, program):
    unscoped(database)
    database.tables["students"][0].update(current_belt_rank_id=rank, program_id=program)
    (entry,) = candidates(database)
    assert entry.student_program_membership_id is None
    assert entry.program_id == program
    assert entry.next_rank_id == (SECOND if rank else FIRST)
    assert database.handlers[GET]["payload"]["program_id"] is None


def test_unscoped_event_legacy_program_does_not_depend_on_generic_ladder_selection(database):
    unscoped(database)
    database.tables["students"][0]["current_belt_rank_id"] = None
    database.tables["belt_ladders"].append(
        {"id": OTHER_LADDER, "studio_id": STUDIO, "name": "Other", "program_id": OTHER_PROGRAM}
    )
    assert generic(database) == []
    assert len(candidates(database)) == 1


@pytest.mark.parametrize("status", ["active", "paused"])
def test_unscoped_event_supports_explicit_current_membership_without_legacy_substitution(
    database, status
):
    unscoped(database, legacy=False)
    database.tables["student_program_memberships"][0]["status"] = status
    (entry,) = candidates(database)
    assert entry.student_program_membership_id == MEMBERSHIP
    assert entry.program_id == PROGRAM
    assert database.handlers[GET]["payload"]["program_id"] is None


def test_explicit_unscoped_event_supports_unranked_membership_with_multiple_ladders(database):
    unscoped(database, legacy=False)
    database.tables["student_program_memberships"][0]["current_belt_rank_id"] = None
    database.tables["belt_ladders"].append(
        {
            "id": OTHER_LADDER,
            "studio_id": STUDIO,
            "name": "Other",
            "program_id": OTHER_PROGRAM,
        }
    )
    assert generic(database) == []
    (entry,) = candidates(database)
    assert entry.student_program_membership_id == MEMBERSHIP
    assert entry.current_rank_id is None and entry.next_rank_id == FIRST


@pytest.mark.parametrize("defect", ["missing", "archived", "foreign"])
@pytest.mark.parametrize("legacy", [True, False])
def test_invalid_legacy_or_membership_program_is_excluded_without_fallback(
    database, defect, legacy
):
    unscoped(database, legacy=legacy)
    if defect == "missing":
        database.tables["programs"] = []
    elif defect == "archived":
        database.tables["programs"][0]["archived_at"] = "2026-10-01T00:00:00Z"
    else:
        database.tables["programs"][0]["studio_id"] = OTHER
    assert len(generic(database)) == 1
    assert candidates(database) == []


@pytest.mark.parametrize("defect", ["missing", "wrong_ladder", "foreign"])
@pytest.mark.parametrize("legacy", [True, False])
def test_nonnull_rank_must_resolve_exact_event_ladder_before_unranked_fallback(
    database, defect, legacy
):
    if legacy:
        unscoped(database)
    if defect == "missing":
        database.tables["belt_ranks"] = database.tables["belt_ranks"][1:]
    elif defect == "wrong_ladder":
        database.tables["belt_ranks"][0]["ladder_id"] = OTHER_LADDER
    else:
        database.tables["belt_ranks"][0]["studio_id"] = OTHER
    assert len(generic(database)) == 1  # Existing view's missing-rank fallback stays unchanged.
    assert candidates(database) == []


def test_rank_resolving_in_another_known_ladder_is_excluded(database):
    database.tables["belt_ladders"].append(
        {"id": OTHER_LADDER, "studio_id": STUDIO, "program_id": PROGRAM, "name": "Other"}
    )
    database.tables["belt_ranks"][0]["ladder_id"] = OTHER_LADDER
    assert candidates(database) == []


@pytest.mark.parametrize(
    "changes",
    [
        {"ended_at": "2026-10-01T00:00:00Z"},
        {"status": "ended"},
        {"studio_id": OTHER},
        {"student_id": OTHER},
    ],
)
def test_ineligible_membership_cannot_supply_scoped_event_context(database, changes):
    database.tables["student_program_memberships"][0].update(changes)
    assert candidates(database) == []


def test_scoped_event_rejects_different_current_membership_program_even_with_matching_rank(
    database,
):
    database.tables["programs"].append(
        {"id": OTHER_PROGRAM, "studio_id": STUDIO, "archived_at": None}
    )
    database.tables["student_program_memberships"][0]["program_id"] = OTHER_PROGRAM
    assert len(generic(database)) == 1
    assert candidates(database) == []


@pytest.mark.parametrize("status", ["active", "paused"])
def test_current_membership_blocks_legacy_fallback_when_its_rank_is_invalid(database, status):
    unscoped(database, legacy=False)
    database.tables["student_program_memberships"][0].update(
        status=status, current_belt_rank_id=OTHER
    )
    assert candidates(database) == []


def test_ended_membership_does_not_block_unscoped_legacy_context(database):
    unscoped(database, legacy=False)
    database.tables["student_program_memberships"][0]["ended_at"] = "2026-10-01T00:00:00Z"
    (entry,) = candidates(database)
    assert entry.student_program_membership_id is None


@pytest.mark.parametrize(
    "changes",
    [{"status": "inactive"}, {"deleted_at": "2026-10-01T00:00:00Z"}, {"studio_id": OTHER}],
)
def test_inactive_deleted_or_foreign_students_are_excluded(database, changes):
    database.tables["students"][0].update(changes)
    assert candidates(database) == []


@pytest.mark.parametrize(
    "studio_zone,event_zone,today",
    [
        ("America/Los_Angeles", "Pacific/Kiritimati", "2026-10-05"),
        ("Pacific/Kiritimati", "America/Los_Angeles", "2026-10-06"),
        (None, "America/Los_Angeles", "2026-10-06"),
        ("Unsupported/Zone", "America/Los_Angeles", "2026-10-06"),
    ],
)
@pytest.mark.parametrize(
    "boundary", ["start", "end", "open_end", "before_start", "after_end", "no_start"]
)
def test_holds_use_inclusive_studio_date_and_utc_fallback_not_event_timezone(
    database, studio_zone, event_zone, today, boundary
):
    database.tables["studios"][0]["timezone"] = studio_zone
    database.handlers[GET]["payload"]["timezone"] = event_zone
    previous = (datetime.fromisoformat(today) - timedelta(days=1)).date().isoformat()
    following = (datetime.fromisoformat(today) + timedelta(days=1)).date().isoformat()
    start, end, held = {
        "start": (today, following, True),
        "end": (previous, today, True),
        "open_end": (today, None, True),
        "before_start": (following, None, False),
        "after_end": (previous, previous, False),
        "no_start": (None, following, False),
    }[boundary]
    database.tables["students"][0].update(hold_start_date=start, hold_end_date=end)
    assert len(generic(database)) == 1
    assert bool(candidates(database)) is not held


@pytest.mark.parametrize(
    "table,changes",
    [
        ("belt_ladders", None),
        ("belt_ladders", {"studio_id": OTHER}),
        ("belt_ladders", {"program_id": None}),
        ("belt_ladders", {"program_id": OTHER_PROGRAM}),
        ("programs", None),
        ("programs", {"studio_id": OTHER}),
        ("programs", {"archived_at": "2026-10-01T00:00:00Z"}),
    ],
)
def test_changed_missing_archived_or_foreign_event_parent_is_fixed_conflict(api, table, changes):
    client, database, _, _, _ = api
    if changes is None:
        database.tables[table] = []
    else:
        database.tables[table][0].update(changes)
    response = client.get(PATH)
    assert response.status_code == 409
    assert response.json() == {"detail": CANDIDATES_CONTEXT_DETAIL}
    assert database.execute_calls == [GET]
    assert not any(query["table"] == "students" for query in database.query_log)
    assert_read_only(database)


def test_unscoped_event_cannot_silently_acquire_a_program(api):
    client, database, _, _, _ = api
    database.handlers[GET]["payload"]["program_id"] = None
    response = client.get(PATH)
    assert response.status_code == 409
    assert response.json() == {"detail": CANDIDATES_CONTEXT_DETAIL}


@pytest.mark.parametrize(
    "status,offset",
    [("draft", 1), ("canceled", 1), ("completed", 1), ("scheduled", -1), ("scheduled", 0)],
)
def test_only_future_scheduled_event_can_offer_candidates(api, status, offset):
    client, database, _, _, _ = api
    start = NOW + timedelta(seconds=offset)
    database.handlers[GET]["payload"].update(
        status=status, starts_at=start.isoformat(), ends_at=(start + timedelta(hours=1)).isoformat()
    )
    response = client.get(PATH)
    assert response.status_code == 409
    assert response.json() == {"detail": CANDIDATES_STATE_DETAIL}
    assert {query["table"] for query in database.query_log} == {"staff_roles"}
    assert database.execute_calls == [GET]


def test_highest_rank_has_no_next_candidate(database):
    database.tables["student_program_memberships"][0]["current_belt_rank_id"] = LAST
    assert candidates(database) == []


@pytest.mark.parametrize(
    "anchor,days", [("2026-10-05", 1), ("2026-10-05T01:00:00Z", 0), ("2026-10-04T01:00:00Z", 1)]
)
def test_rank_timing_remains_utc_elapsed_days_and_date_midnight(database, anchor, days):
    database.tables["student_program_memberships"][0]["started_at"] = anchor
    (entry,) = candidates(database)
    assert entry.days_at_rank == days


def test_promotion_stream_and_inclusive_credited_attendance_are_preserved(database):
    database.tables["promotions"] = [
        {
            "studio_id": STUDIO,
            "student_id": STUDENT,
            "student_program_membership_id": MEMBERSHIP,
            "program_id": PROGRAM,
            "promoted_at": "2026-10-01T00:00:00+00:00",
        },
        {
            "studio_id": STUDIO,
            "student_id": STUDENT,
            "student_program_membership_id": OTHER,
            "program_id": PROGRAM,
            "promoted_at": "2026-10-05T00:00:00+00:00",
        },
    ]

    def attendance(instant, **changes):
        return {
            "studio_id": STUDIO,
            "student_id": STUDENT,
            "status": "present",
            "checked_in_at": instant,
            "counts_toward_eligibility": True,
            "class_sessions": {"program_id": PROGRAM, "status": "scheduled", "deleted_at": None},
            **changes,
        }

    database.tables["attendance"] = [
        attendance("2026-10-04T23:59:59+00:00"),
        attendance("2026-10-05T00:00:00+00:00"),
        attendance("2026-10-05T00:01:00+00:00", counts_toward_eligibility=False),
        attendance("2026-10-05T00:02:00+00:00", status="absent"),
        attendance(
            "2026-10-05T00:03:00+00:00",
            class_sessions={"program_id": PROGRAM, "status": "canceled", "deleted_at": None},
        ),
        attendance(
            "2026-10-05T00:04:00+00:00",
            class_sessions={
                "program_id": PROGRAM,
                "status": "scheduled",
                "deleted_at": "2026-10-05",
            },
        ),
        attendance(
            "2026-10-05T00:05:00+00:00",
            class_sessions={"program_id": OTHER_PROGRAM, "status": "scheduled", "deleted_at": None},
        ),
    ]
    (entry,) = candidates(database)
    assert entry.days_at_rank == 1
    assert entry.classes_since_promo == 1
    query = next(query for query in database.query_log if query["table"] == "promotions")
    assert query["orders"] == (("promoted_at", True),)


def test_http_admin_checks_entitlement_then_exact_event_in_one_interactive_operation(api):
    client, database, subscription, lane_calls, _ = api
    before = deepcopy(database.tables)
    response = client.get(PATH, headers={"X-Studio-Id": f" {STUDIO} "})
    assert response.status_code == 200
    (entry,) = response.json()
    assert EligibilityEntry.model_validate(entry).student_id == STUDENT
    subscription.assert_called_once_with(database, STUDIO)
    assert lane_calls == ["interactive"]
    assert database.rpc_calls == [
        (GET, {"p_studio_id": STUDIO, "p_actor_id": ACTOR, "p_event_id": EVENT})
    ]
    assert database.tables == before
    assert_read_only(database)


@pytest.mark.parametrize(
    "denial,status",
    [
        ("front_desk", 403),
        ("instructor", 403),
        ("archived", 403),
        ("foreign", 403),
        ("none", 404),
        ("multiple", 409),
    ],
)
def test_http_current_admin_required_before_entitlement_event_or_candidate_reads(
    api, denial, status
):
    client, database, subscription, _, _ = api
    membership = database.tables["staff_roles"][0]
    headers = {}
    if denial in {"front_desk", "instructor"}:
        membership["role"] = denial
    elif denial == "archived":
        membership["archived_at"] = "2026-10-01"
    elif denial == "foreign":
        headers = {"X-Studio-Id": OTHER}
    elif denial == "multiple":
        database.tables["staff_roles"].append({**membership, "studio_id": OTHER})
    else:
        database.tables["staff_roles"] = []
    response = client.get(PATH, headers=headers)
    assert response.status_code == status
    if denial in {"front_desk", "instructor"}:
        assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    subscription.assert_not_called()
    assert database.rpc_calls == []
    assert {query["table"] for query in database.query_log} == {"staff_roles"}


@pytest.mark.parametrize("status", [402, 503])
def test_http_entitlement_denial_precedes_all_event_and_candidate_reads(api, status):
    client, database, subscription, _, _ = api
    subscription.side_effect = HTTPException(status, "Subscription unavailable")
    assert client.get(PATH).status_code == status
    assert database.rpc_calls == []
    assert {query["table"] for query in database.query_log} == {"staff_roles"}


def test_http_unauthenticated_has_no_provider_reads(api):
    client, database, subscription, _, app = api
    app.dependency_overrides.pop(get_current_user_id)
    assert client.get(PATH).status_code == 401
    subscription.assert_not_called()
    assert database.query_log == [] and database.rpc_calls == []


def test_http_invalid_event_id_has_no_event_or_candidate_reads(api):
    client, database, _, _, _ = api
    assert client.get(BASE + "/invalid/candidates").status_code == 422
    assert database.query_log == [] and database.rpc_calls == []


@pytest.mark.parametrize(
    "code,message,status,detail",
    [
        ("P0002", "AUTOMATION_NOT_FOUND", 404, "Belt-test event or ladder not found."),
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403, ADMIN_REQUIRED_DETAIL),
        ("XX000", "private provider error", 503, UNAVAILABLE_DETAIL),
    ],
)
def test_http_accepted_event_service_preserves_missing_forbidden_and_safe_errors(
    api, code, message, status, detail
):
    client, database, _, _, _ = api
    database.handlers[GET] = APIError(
        {"code": code, "message": message, "details": "private", "hint": "private"}
    )
    response = client.get(PATH)
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert database.execute_calls == [GET]
    assert {query["table"] for query in database.query_log} == {"staff_roles"}


@pytest.mark.parametrize(
    "table",
    [
        "belt_ladders",
        "programs",
        "studios",
        "belt_ranks",
        "students",
        "student_program_memberships",
        "promotions",
        "attendance",
    ],
)
@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError("private provider detail"),
        TimeoutError("private timeout"),
        HTTPException(409, "private conflict"),
        APIError(
            {"code": "P0002", "message": "private missing", "details": "private", "hint": "private"}
        ),
    ],
)
def test_new_candidate_provider_errors_are_fixed_unavailable_without_retry(api, table, failure):
    client, database, _, _, _ = api
    database.table_failures[table] = failure
    response = client.get(PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": CANDIDATES_UNAVAILABLE_DETAIL}
    assert "private" not in response.text
    assert sum(query["table"] == table for query in database.query_log) == 1
    assert database.execute_calls == [GET]
    assert_read_only(database)


@pytest.mark.parametrize(
    "table",
    [
        "belt_ladders",
        "programs",
        "studios",
        "belt_ranks",
        "students",
        "student_program_memberships",
        "promotions",
        "attendance",
    ],
)
@pytest.mark.parametrize("malformed", [None, {}, "private malformed response", [None], [{}]])
def test_malformed_candidate_provider_results_are_fixed_unavailable(api, table, malformed):
    client, database, _, _, _ = api
    database.read_overrides[table] = malformed
    response = client.get(PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": CANDIDATES_UNAVAILABLE_DETAIL}
    assert sum(query["table"] == table for query in database.query_log) == 1


@pytest.mark.parametrize("rows", [[], [{"id": STUDIO}], [{"id": STUDIO, "timezone": 17}]])
def test_missing_or_malformed_studio_facts_do_not_default_to_utc(api, rows):
    client, database, _, _, _ = api
    database.read_overrides["studios"] = rows
    response = client.get(PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": CANDIDATES_UNAVAILABLE_DETAIL}


@pytest.mark.parametrize(
    "table,field",
    [
        ("belt_ladders", "program_id"),
        ("programs", "archived_at"),
        ("students", "current_belt_rank_id"),
        ("students", "hold_start_date"),
        ("student_program_memberships", "current_belt_rank_id"),
    ],
)
def test_omitted_nullable_parent_facts_are_unavailable_not_known_null(api, table, field):
    client, database, _, _, _ = api
    database.tables[table][0].pop(field)
    response = client.get(PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": CANDIDATES_UNAVAILABLE_DETAIL}


@pytest.mark.parametrize(
    "session",
    [
        None,
        {},
        [],
        [None],
        [{}, {}],
        "private malformed join",
        {"program_id": None, "status": "scheduled"},
        {"program_id": [], "status": "scheduled", "deleted_at": None},
        {"program_id": None, "status": None, "deleted_at": None},
        {"program_id": None, "status": "invalid", "deleted_at": None},
        {"program_id": None, "status": "scheduled", "deleted_at": False},
    ],
)
def test_unscoped_attendance_cannot_invent_credit_from_missing_or_malformed_join(api, session):
    client, database, _, _, _ = api
    unscoped(database)
    database.read_overrides["attendance"] = [
        {
            "student_id": STUDENT,
            "checked_in_at": "2026-10-05T00:00:00Z",
            "counts_toward_eligibility": True,
            "class_sessions": session,
        }
    ]
    response = client.get(PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": CANDIDATES_UNAVAILABLE_DETAIL}


@pytest.mark.parametrize("credit", [0, 1, "false", [], {}])
def test_unscoped_attendance_requires_boolean_or_explicit_nullable_credit(api, credit):
    client, database, _, _, _ = api
    unscoped(database)
    database.read_overrides["attendance"] = [
        {
            "student_id": STUDENT,
            "checked_in_at": "2026-10-05T00:00:00Z",
            "counts_toward_eligibility": credit,
            "class_sessions": {"program_id": None, "status": "completed", "deleted_at": None},
        }
    ]
    response = client.get(PATH)
    assert response.status_code == 503
    assert response.json() == {"detail": CANDIDATES_UNAVAILABLE_DETAIL}


@pytest.mark.parametrize("credit,expected", [(True, 1), (None, 1), (False, 0)])
@pytest.mark.parametrize("list_join", [False, True])
def test_complete_unscoped_join_preserves_nullable_credit_and_supported_sdk_shapes(
    database, credit, expected, list_join
):
    unscoped(database)
    session = {"program_id": None, "status": "completed", "deleted_at": None}
    database.read_overrides["attendance"] = [
        {
            "student_id": STUDENT,
            "checked_in_at": "2026-10-05T00:00:00Z",
            "counts_toward_eligibility": credit,
            "class_sessions": [session] if list_join else session,
        }
    ]
    (entry,) = candidates(database)
    assert entry.classes_since_promo == expected


@pytest.mark.parametrize("current_rank", [None, FIRST])
@pytest.mark.parametrize("parent,foreign_id", [("studio_id", OTHER), ("ladder_id", OTHER_LADDER)])
def test_candidate_first_and_next_ranks_always_use_selected_same_studio_ladder(
    database, current_rank, parent, foreign_id
):
    unscoped(database)
    database.tables["students"][0]["current_belt_rank_id"] = current_rank
    rows = deepcopy(database.tables["belt_ranks"])
    foreign_index = 0 if current_rank is None else 1
    rows[foreign_index][parent] = foreign_id
    database.read_overrides["belt_ranks"] = rows
    (entry,) = candidates(database)
    assert entry.next_rank_id == (SECOND if current_rank is None else LAST)


def test_one_reference_instant_drives_event_expiry_holds_and_elapsed_rank_days(
    database, monkeypatch
):
    calls = []

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            calls.append(tz)
            return NOW if len(calls) == 1 else NOW + timedelta(days=10)

    monkeypatch.setattr(belt_eligibility, "datetime", Clock)
    (entry,) = candidates(database)
    assert entry.days_at_rank == 0
    assert calls == [UTC]
