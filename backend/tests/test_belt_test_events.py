"""Mocked belt-test boundary and pinned SDK parsing; no SQL or provider integration."""

import base64
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest import SyncPostgrestClient
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from pydantic import ValidationError

from app.api.v1.endpoints import belt_tests as routes
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.belt_test import (
    BeltTestEventCreate,
    BeltTestEventResponse,
    BeltTestEventUpdate,
)
from app.schemas.trial_appointment import MAX_REVISION
from app.services.belt_test_service import (
    ADMIN_REQUIRED_DETAIL,
    INVALID_CURSOR_DETAIL,
    UNAVAILABLE_DETAIL,
    BeltTestEventMutationResult,
    BeltTestService,
)
from tests.fakes.supabase import TableBackedSupabase

STUDIO, ACTOR, LADDER, EVENT, OPERATION, PROGRAM, OTHER = (
    str(UUID(int=value)) for value in range(1, 8)
)
MUTATE = "mutate_belt_test_event_v1"
LIST = "list_belt_test_events_v1"
GET = "get_belt_test_event_v1"
BASE = "/api/v1/belt-tests"
# Deliberately old: receipt replay must remain possible after the event starts.
CREATE = {
    "operation_id": OPERATION,
    "name": "Autumn grading",
    "ladder_id": LADDER,
    "starts_at": "2020-11-01T01:30:00-07:00",
    "ends_at": "2020-11-01T01:30:00-08:00",
    "timezone": "America/Los_Angeles",
}
PATCH = {"operation_id": OPERATION, "expected_revision": 8, "name": "Renamed grading"}
ROW = {
    "id": EVENT,
    "studio_id": STUDIO,
    "name": "Autumn grading",
    "ladder_id": LADDER,
    "program_id": PROGRAM,
    "starts_at": "2020-11-01T08:30:00Z",
    "ends_at": "2020-11-01T09:30:00Z",
    "timezone": "America/Los_Angeles",
    "location": "Original room",
    "status": "scheduled",
    "revision": 8,
    "schedule_revision": 3,
    "created_by": ACTOR,
    "created_at": "2020-10-01T12:00:00Z",
    "updated_at": "2020-10-02T12:00:00Z",
}
RECEIPT = {"payload": ROW, "operation_id": OPERATION, "replayed": False}
CURSOR = {"created_at": ROW["created_at"], "id": EVENT}
PAGE = {"payload": {"items": [ROW], "next_cursor": None, "has_more": False}}
ROUTE_CASES = [
    ("GET", BASE, None, LIST),
    ("POST", BASE, CREATE, MUTATE),
    ("GET", BASE + f"/{EVENT}", None, GET),
    ("PATCH", BASE + f"/{EVENT}", PATCH, MUTATE),
]
MISSING_ERROR_IDENTITY = object()
MALFORMED_ERROR_IDENTITIES = [
    pytest.param(MISSING_ERROR_IDENTITY, id="missing"),
    pytest.param(None, id="null"),
    pytest.param([], id="array"),
    pytest.param({}, id="object"),
    pytest.param(503, id="integer"),
    pytest.param(1.5, id="float"),
    pytest.param(True, id="true"),
    pytest.param(False, id="false"),
]


def malformed_provider_error(field, identity):
    error = {
        "code": "P0001",
        "message": "AUTOMATION_STATE_CONFLICT",
        "details": "synthetic private provider detail",
        "hint": "synthetic private provider hint",
    }
    if identity is MISSING_ERROR_IDENTITY:
        error.pop(field)
    else:
        error[field] = identity
    return error


def encoded(value):
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


class Database(TableBackedSupabase):
    def __init__(self):
        super().__init__(
            {
                "staff_roles": [
                    {
                        "user_id": ACTOR,
                        "studio_id": STUDIO,
                        "role": "admin",
                        "archived_at": None,
                    }
                ]
            }
        )
        self.rpc_calls = []
        self.execute_calls = []
        self.handlers = {
            MUTATE: deepcopy(RECEIPT),
            LIST: deepcopy(PAGE),
            GET: {"payload": deepcopy(ROW)},
        }

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))

        def execute():
            self.execute_calls.append(name)
            handler = self.handlers[name]
            if isinstance(handler, Exception):
                raise handler
            return SimpleNamespace(data=deepcopy(handler))

        return SimpleNamespace(execute=execute)


@pytest.fixture
def database():
    return Database()


@pytest.fixture
def api(monkeypatch, database):
    def entitled(client, studio_id):
        assert client is database
        assert studio_id == STUDIO
        assert database.query_log
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


def assert_unavailable(call):
    with pytest.raises(HTTPException) as error:
        call()
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)


def create(service, **changes):
    return service.create(STUDIO, ACTOR, BeltTestEventCreate(**{**CREATE, **changes}))


def call_service(database, rpc):
    service = BeltTestService(database)
    if rpc == MUTATE:
        return create(service)
    if rpc == LIST:
        return service.list(STUDIO, ACTOR)
    return service.get(STUDIO, ACTOR, EVENT)


def test_reused_time_types_resolve_dst_offsets_and_normalize_utc():
    body = BeltTestEventCreate(**CREATE)
    assert body.starts_at == datetime(2020, 11, 1, 8, 30, tzinfo=timezone.utc)
    assert body.ends_at - body.starts_at == timedelta(hours=1)
    assert body.model_dump(mode="json")["ends_at"] == "2020-11-01T09:30:00Z"
    assert body.timezone == "America/Los_Angeles"


@pytest.mark.parametrize("name", ["", " \t\n", "a" * 141, 17, True, b"grading", None])
def test_names_reject_blank_overlong_or_nonstring_input(name):
    for model, body in [(BeltTestEventCreate, CREATE), (BeltTestEventUpdate, PATCH)]:
        with pytest.raises(ValidationError):
            model(**{**body, "name": name})


def test_name_is_trimmed_without_changing_plain_text():
    name = '  <Autumn> & "grading"  '
    assert BeltTestEventCreate(**{**CREATE, "name": name}).name == '<Autumn> & "grading"'
    assert BeltTestEventUpdate(**{**PATCH, "name": name}).name == '<Autumn> & "grading"'
    assert len(BeltTestEventCreate(**{**CREATE, "name": "a" * 140}).name) == 140


@pytest.mark.parametrize(
    "changes",
    [
        {"program_id": PROGRAM},
        {"program_id": None},
        {"studio_id": STUDIO},
        {"actor_id": ACTOR},
        {"revision": 1},
        {"schedule_revision": 1},
        {"created_by": ACTOR},
        {"ladder_id": "invalid"},
        {"operation_id": "invalid"},
        {"location": "a" * 241},
        {"timezone": "Mars/Olympus"},
        {"starts_at": "2020-11-01T08:30:00"},
        {"ends_at": 1604219400},
    ],
)
def test_create_and_update_reject_spoofed_or_malformed_fields(changes):
    for model, body in [(BeltTestEventCreate, CREATE), (BeltTestEventUpdate, PATCH)]:
        with pytest.raises(ValidationError):
            model(**{**body, **changes})


@pytest.mark.parametrize("status", ["draft", "scheduled"])
def test_create_allows_only_initial_statuses(status):
    assert BeltTestEventCreate(**{**CREATE, "status": status}).status == status


@pytest.mark.parametrize("status", ["completed", "canceled", "no_show", "unknown", None])
def test_create_rejects_other_statuses(status):
    with pytest.raises(ValidationError):
        BeltTestEventCreate(**{**CREATE, "status": status})


def test_patch_requires_a_change():
    with pytest.raises(ValidationError):
        BeltTestEventUpdate(operation_id=OPERATION, expected_revision=1)


@pytest.mark.parametrize(
    "field", ["name", "ladder_id", "starts_at", "ends_at", "timezone", "location", "status"]
)
def test_patch_edits_are_nonnullable(field):
    with pytest.raises(ValidationError):
        BeltTestEventUpdate(**{**PATCH, field: None})


@pytest.mark.parametrize("status", ["draft", "scheduled", "completed", "canceled"])
def test_patch_can_combine_each_status_with_domain_edits_for_sql_to_resolve(status):
    body = BeltTestEventUpdate(**{**PATCH, **CREATE, "ladder_id": OTHER, "status": status})
    assert body.status == status
    assert str(body.ladder_id) == OTHER


@pytest.mark.parametrize("value", [0, -1, True, 1.0, "1", MAX_REVISION + 1, None])
def test_revision_fields_are_strict_positive_bigints(value):
    with pytest.raises(ValidationError):
        BeltTestEventUpdate(**{**PATCH, "expected_revision": value})
    for field in ["revision", "schedule_revision"]:
        with pytest.raises(ValidationError):
            BeltTestEventResponse(**{**ROW, field: value})


def test_bigint_max_is_accepted_without_coupling_revision_fields():
    assert (
        BeltTestEventUpdate(**{**PATCH, "expected_revision": MAX_REVISION}).expected_revision
        == MAX_REVISION
    )
    response = BeltTestEventResponse(**{**ROW, "revision": MAX_REVISION})
    assert response.revision == MAX_REVISION
    assert response.schedule_revision == 3


@pytest.mark.parametrize("duration", [0, -1, 86401])
def test_full_windows_reject_nonpositive_or_more_than_one_day(duration):
    start = datetime(2020, 11, 1, 8, 30, tzinfo=timezone.utc)
    times = {"starts_at": start, "ends_at": start + timedelta(seconds=duration)}
    for model, body in [
        (BeltTestEventCreate, CREATE),
        (BeltTestEventUpdate, PATCH),
        (BeltTestEventResponse, ROW),
    ]:
        with pytest.raises(ValidationError):
            model(**{**body, **times})


def test_maximum_window_and_partial_patch_leave_merged_window_to_sql():
    times = {"starts_at": "2020-11-01T08:30:00Z", "ends_at": "2020-11-02T08:30:00Z"}
    assert BeltTestEventCreate(**{**CREATE, **times}).ends_at.day == 2
    for field, value in [
        ("starts_at", "2030-01-01T00:00:00Z"),
        ("ends_at", "2000-01-01T00:00:00Z"),
    ]:
        update = BeltTestEventUpdate(**{**PATCH, field: value})
        assert update.model_dump(mode="json", exclude_unset=True)[field] == value


@pytest.mark.parametrize("field", list(ROW))
def test_response_requires_every_canonical_field_including_nullable_fields(field):
    with pytest.raises(ValidationError):
        BeltTestEventResponse(**{key: value for key, value in ROW.items() if key != field})


def test_response_normalizes_ids_times_and_preserves_distinct_revisions():
    response = BeltTestEventResponse(
        **{**ROW, "id": UUID(EVENT), "created_at": "2020-10-01T05:00:00-07:00"}
    )
    assert response.model_dump(mode="json") == ROW
    nullable = BeltTestEventResponse(**{**ROW, "program_id": None, "created_by": None})
    assert nullable.program_id is None and nullable.created_by is None
    with pytest.raises(ValidationError):
        BeltTestEventResponse(**{**ROW, "approved_schedule_revision": 3})


@pytest.mark.parametrize("changes", [{}, {"location": "Room 2", "status": "scheduled"}])
def test_create_uses_exact_rpc_with_null_identity_defaults_and_normalized_domain_fields(
    database, changes
):
    result = create(
        BeltTestService(database), name="  Autumn grading  ", ladder_id=UUID(LADDER), **changes
    )
    request = {
        "name": ROW["name"],
        "ladder_id": LADDER,
        "starts_at": ROW["starts_at"],
        "ends_at": ROW["ends_at"],
        "timezone": ROW["timezone"],
        "location": "",
        "status": "draft",
        **changes,
    }
    assert database.rpc_calls == [
        (
            MUTATE,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_event_id": None,
                "p_operation_id": OPERATION,
                "p_expected_revision": None,
                "p_request": request,
            },
        )
    ]
    assert result.model_dump(mode="json") == RECEIPT
    assert database.execute_calls == [MUTATE]
    assert database.query_log == []


@pytest.mark.parametrize(
    "patch",
    [
        {"name": "Renamed grading"},
        {"ladder_id": OTHER},
        {"starts_at": "2020-11-01T10:30:00Z"},
        {"ends_at": "2020-11-01T07:30:00Z"},
        {"timezone": "UTC"},
        {"location": ""},
        {"status": "canceled"},
        {"status": "completed", "name": "Final grading", "ladder_id": OTHER},
    ],
)
def test_update_passes_only_explicit_fields_without_pre_read(database, patch):
    data = BeltTestEventUpdate(operation_id=OPERATION, expected_revision=8, **patch)
    result = BeltTestService(database).update(STUDIO, ACTOR, EVENT, data)
    assert database.rpc_calls == [
        (
            MUTATE,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_event_id": EVENT,
                "p_operation_id": OPERATION,
                "p_expected_revision": 8,
                "p_request": patch,
            },
        )
    ]
    assert result.payload.revision == 8
    assert result.payload.schedule_revision == 3
    assert database.execute_calls == [MUTATE]
    assert database.query_log == []


@pytest.mark.parametrize("updating", [False, True])
def test_old_dated_replay_returns_original_payload_without_current_event_read(database, updating):
    database.handlers[MUTATE]["replayed"] = True
    service = BeltTestService(database)
    if updating:
        result = service.update(STUDIO, ACTOR, EVENT, BeltTestEventUpdate(**PATCH))
    else:
        result = create(service)
    assert result.model_dump(mode="json") == {**RECEIPT, "replayed": True}
    assert database.execute_calls == [MUTATE]
    assert database.query_log == []


@pytest.mark.parametrize(
    "envelope",
    [
        None,
        [],
        [RECEIPT],
        ROW,
        {"message": ROW},
        {"payload": ROW},
        {**RECEIPT, "operation_id": OTHER},
        {**RECEIPT, "operation_id": "invalid"},
        {**RECEIPT, "replayed": 1},
        {**RECEIPT, "replayed": "true"},
        {**RECEIPT, "message": "private"},
        {**RECEIPT, "payload": {**ROW, "studio_id": OTHER}},
        {**RECEIPT, "payload": {**ROW, "revision": "8"}},
        {**RECEIPT, "payload": {**ROW, "schedule_revision": None}},
        {**RECEIPT, "payload": {**ROW, "program_id": "invalid"}},
        {**RECEIPT, "payload": {**ROW, "starts_at": 1604219400}},
    ],
)
def test_malformed_or_foreign_mutation_response_fails_closed(database, envelope):
    database.handlers[MUTATE] = envelope
    assert_unavailable(lambda: create(BeltTestService(database)))
    assert database.execute_calls == [MUTATE]
    assert database.query_log == []


def test_mutation_result_revalidates_model_instances():
    receipt = BeltTestEventMutationResult(**RECEIPT)
    receipt.replayed = 1
    with pytest.raises(ValidationError):
        BeltTestEventMutationResult.model_validate(receipt)


@pytest.mark.parametrize("field", ["id", "studio_id"])
def test_update_rejects_wrong_event_or_studio_id(database, field):
    database.handlers[MUTATE]["payload"][field] = OTHER
    assert_unavailable(
        lambda: BeltTestService(database).update(STUDIO, ACTOR, EVENT, BeltTestEventUpdate(**PATCH))
    )
    assert database.execute_calls == [MUTATE]


def test_get_uses_exact_rpc_and_preserves_canonical_response(database):
    result = BeltTestService(database).get(STUDIO, ACTOR, UUID(EVENT))
    assert result.model_dump(mode="json") == ROW
    assert database.rpc_calls == [
        (GET, {"p_studio_id": STUDIO, "p_actor_id": ACTOR, "p_event_id": EVENT})
    ]
    assert database.execute_calls == [GET]
    assert database.query_log == []


@pytest.mark.parametrize(
    "envelope",
    [
        None,
        [],
        ROW,
        RECEIPT,
        {"message": ROW},
        {"payload": {**ROW, "studio_id": OTHER}},
        {"payload": {**ROW, "id": OTHER}},
        {"payload": {**ROW, "name": " "}},
        {"payload": {**ROW, "ends_at": ROW["starts_at"]}},
        {"payload": {**ROW, "status": "no_show"}},
    ],
)
def test_get_rejects_malformed_envelope_or_foreign_identity(database, envelope):
    database.handlers[GET] = envelope
    assert_unavailable(lambda: BeltTestService(database).get(STUDIO, ACTOR, EVENT))
    assert database.execute_calls == [GET]
    assert database.query_log == []


def test_list_uses_exact_rpc_even_for_empty_page(database):
    database.handlers[LIST] = {"payload": {"items": [], "next_cursor": None, "has_more": False}}
    result = BeltTestService(database).list(STUDIO, ACTOR)
    assert result.model_dump() == {"items": [], "next_cursor": None, "has_more": False}
    assert database.rpc_calls == [
        (LIST, {"p_studio_id": STUDIO, "p_actor_id": ACTOR, "p_limit": 50, "p_cursor": None})
    ]
    assert database.execute_calls == [LIST]
    assert database.query_log == []


def test_cursor_roundtrip_is_canonical_and_normalizes_utc(database):
    database.handlers[LIST]["payload"].update(next_cursor=CURSOR, has_more=True)
    service = BeltTestService(database)
    page = service.list(STUDIO, ACTOR, limit=1)
    assert page.next_cursor == encoded(
        json.dumps(CURSOR, sort_keys=True, separators=(",", ":")).encode()
    )
    assert page.has_more is True
    service.list(STUDIO, ACTOR, limit=1, cursor=page.next_cursor)
    assert database.rpc_calls[-1][1]["p_cursor"] == CURSOR
    service.list(
        STUDIO, ACTOR, cursor=encoded({**CURSOR, "created_at": "2020-10-01T05:00:00-07:00"})
    )
    assert database.rpc_calls[-1][1]["p_cursor"] == CURSOR


@pytest.mark.parametrize(
    "token",
    [
        "",
        "a",
        "!@#",
        "Zm9=",
        "x" * 513,
        "Zh",
        1,
        encoded(b"not json"),
        encoded(b"\xff"),
        encoded([]),
        encoded(None),
        encoded({}),
        encoded({"id": EVENT}),
        encoded({"created_at": ROW["created_at"]}),
        encoded({**CURSOR, "extra": True}),
        encoded({**CURSOR, "created_at": "2020-10-01T12:00:00"}),
        encoded({**CURSOR, "created_at": 1601553600}),
        encoded({**CURSOR, "created_at": float("inf")}),
        encoded({**CURSOR, "id": "invalid"}),
        encoded(f'{{"created_at":"{ROW["created_at"]}","id":"{EVENT}","id":"{OTHER}"}}'.encode()),
    ],
)
def test_invalid_cursor_rejected_before_rpc(database, token):
    with pytest.raises(HTTPException) as error:
        BeltTestService(database).list(STUDIO, ACTOR, cursor=token)
    assert (error.value.status_code, error.value.detail) == (422, INVALID_CURSOR_DETAIL)
    assert database.rpc_calls == []


@pytest.mark.parametrize("limit", [0, 101, True, "1", 1.0])
def test_invalid_service_limit_rejected_before_rpc(database, limit):
    with pytest.raises(HTTPException) as error:
        BeltTestService(database).list(STUDIO, ACTOR, limit=limit)
    assert error.value.status_code == 422
    assert database.rpc_calls == []


@pytest.mark.parametrize(
    "payload",
    [
        {"items": [ROW, ROW], "next_cursor": None, "has_more": False},
        {"items": [ROW], "next_cursor": CURSOR, "has_more": False},
        {"items": [ROW], "next_cursor": None, "has_more": True},
        {"items": [ROW], "next_cursor": None, "has_more": 0},
        {"items": [ROW], "next_cursor": {**CURSOR, "extra": True}, "has_more": True},
        {"items": [ROW], "next_cursor": {**CURSOR, "id": OTHER}, "has_more": True},
        {
            "items": [ROW],
            "next_cursor": {**CURSOR, "created_at": ROW["updated_at"]},
            "has_more": True,
        },
        {"items": [ROW], "next_cursor": {"id": EVENT}, "has_more": True},
        {"items": [ROW], "next_cursor": encoded(CURSOR), "has_more": True},
        {"items": [], "next_cursor": CURSOR, "has_more": True},
        {"items": [{**ROW, "studio_id": OTHER}], "next_cursor": None, "has_more": False},
        {"items": [{**ROW, "schedule_revision": "3"}], "next_cursor": None, "has_more": False},
        {"items": [ROW], "has_more": False},
        {"items": [ROW], "next_cursor": None},
        {"items": [ROW], "next_cursor": None, "has_more": False, "extra": "private"},
    ],
)
def test_list_rejects_malformed_cursor_rows_or_page_bounds(database, payload):
    database.handlers[LIST] = {"payload": payload}
    assert_unavailable(lambda: BeltTestService(database).list(STUDIO, ACTOR, limit=1))
    assert database.execute_calls == [LIST]


@pytest.mark.parametrize(
    "envelope", [PAGE["payload"], {"message": PAGE["payload"]}, {**PAGE, "extra": True}, []]
)
def test_list_rejects_compatibility_envelopes(database, envelope):
    database.handlers[LIST] = envelope
    assert_unavailable(lambda: BeltTestService(database).list(STUDIO, ACTOR))


@pytest.mark.parametrize("rpc", [MUTATE, LIST, GET])
@pytest.mark.parametrize(
    "code,message,status,detail",
    [
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403, ADMIN_REQUIRED_DETAIL),
        ("P0002", "AUTOMATION_NOT_FOUND", 404, "Belt-test event or ladder not found."),
        ("22023", "AUTOMATION_INVALID_REQUEST", 422, "Invalid belt-test event request."),
        (
            "P0001",
            "AUTOMATION_REVISION_CONFLICT",
            409,
            "This belt-test event changed. Reload it before saving.",
        ),
        (
            "P0001",
            "AUTOMATION_OPERATION_CONFLICT",
            409,
            "This operation was already used for a different request.",
        ),
        (
            "P0001",
            "AUTOMATION_STATE_CONFLICT",
            409,
            "This belt-test event cannot be changed in its current state.",
        ),
        ("P0001", "AUTOMATION_STUDIO_BUSY", 409, "The studio is busy. Try again shortly."),
        ("42883", "missing private RPC", 503, UNAVAILABLE_DETAIL),
        ("PGRST202", "missing private RPC", 503, UNAVAILABLE_DETAIL),
        ("42501", "private permission error", 503, UNAVAILABLE_DETAIL),
        ("P0001", "unknown private error", 503, UNAVAILABLE_DETAIL),
        ("XX000", "AUTOMATION_NOT_FOUND", 503, UNAVAILABLE_DETAIL),
    ],
)
def test_only_exact_owned_error_pairs_have_safe_mapping(
    database, rpc, code, message, status, detail
):
    database.handlers[rpc] = APIError(
        {"code": code, "message": message, "details": "private detail", "hint": "private hint"}
    )
    with pytest.raises(HTTPException) as error:
        call_service(database, rpc)
    assert (error.value.status_code, error.value.detail) == (status, detail)
    assert database.execute_calls == [rpc]
    assert database.query_log == []


@pytest.mark.parametrize("rpc", [MUTATE, LIST, GET])
@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("private timeout"),
        RuntimeError("private provider"),
        HTTPException(400, "private response"),
    ],
)
def test_client_failure_never_retries_or_reads_tables(database, rpc, failure):
    database.handlers[rpc] = failure
    assert_unavailable(lambda: call_service(database, rpc))
    assert database.execute_calls == [rpc]
    assert database.query_log == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_admin_success_checks_membership_then_entitlement_in_interactive_lane(
    api, method, path, body, rpc
):
    client, database, subscription, lane_calls, _ = api
    database.handlers[MUTATE]["replayed"] = True
    response = client.request(method, path, json=body, headers={"X-Studio-Id": f" {STUDIO} "})
    assert response.status_code == (201 if method == "POST" else 200)
    assert response.json() == (PAGE["payload"] if rpc == LIST else ROW)
    assert lane_calls == ["interactive"]
    subscription.assert_called_once_with(database, STUDIO)
    assert database.execute_calls == [rpc]
    assert database.rpc_calls[0][1]["p_studio_id"] == STUDIO
    assert database.rpc_calls[0][1]["p_actor_id"] == ACTOR
    assert {query["table"] for query in database.query_log} == {"staff_roles"}


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
@pytest.mark.parametrize(
    "denial", ["front_desk", "instructor", "archived", "multiple", "foreign", "none"]
)
def test_http_membership_denial_precedes_entitlement_and_rpc(api, method, path, body, rpc, denial):
    client, database, subscription, _, _ = api
    membership = database.tables["staff_roles"][0]
    headers = {}
    expected = 403
    if denial in {"front_desk", "instructor"}:
        membership["role"] = denial
    elif denial == "archived":
        membership["archived_at"] = "2026-10-01"
    elif denial == "multiple":
        database.tables["staff_roles"].append({**membership, "studio_id": OTHER})
        expected = 409
    elif denial == "foreign":
        headers["X-Studio-Id"] = OTHER
    else:
        database.tables["staff_roles"] = []
        expected = 404
    response = client.request(method, path, json=body, headers=headers)
    assert response.status_code == expected
    if denial in {"front_desk", "instructor"}:
        assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    subscription.assert_not_called()
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
@pytest.mark.parametrize("status", [402, 503])
def test_http_entitlement_failure_precedes_rpc(api, method, path, body, rpc, status):
    client, database, subscription, _, _ = api
    subscription.side_effect = HTTPException(status, "Subscription unavailable")
    assert client.request(method, path, json=body).status_code == status
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_unauthenticated_request_has_no_membership_or_rpc_access(api, method, path, body, rpc):
    client, database, subscription, _, app = api
    app.dependency_overrides.pop(get_current_user_id)
    assert client.request(method, path, json=body).status_code == 401
    subscription.assert_not_called()
    assert database.query_log == []
    assert database.rpc_calls == []


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", BASE + "/bad", None),
        ("PATCH", BASE + "/bad", PATCH),
        ("POST", BASE, {**CREATE, "program_id": PROGRAM}),
        ("POST", BASE, {**CREATE, "status": "completed"}),
        ("PATCH", BASE + f"/{EVENT}", {**PATCH, "location": None}),
        ("PATCH", BASE + f"/{EVENT}", {"operation_id": OPERATION, "expected_revision": 1}),
        ("GET", BASE + "?limit=0", None),
        ("GET", BASE + "?limit=101", None),
        ("GET", BASE + "?cursor=" + "a" * 513, None),
        ("GET", BASE + "?cursor=malformed", None),
    ],
)
def test_http_invalid_input_never_calls_rpc(api, method, path, body):
    client, database, _, _, _ = api
    assert client.request(method, path, json=body).status_code == 422
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_http_mocked_sql_authority_rejection_is_sanitized(api, method, path, body, rpc):
    client, database, _, _, _ = api
    database.handlers[rpc] = APIError(
        {
            "code": "42501",
            "message": "AUTOMATION_ADMIN_REQUIRED",
            "details": "private event",
            "hint": "private SQL",
        }
    )
    response = client.request(method, path, json=body)
    assert response.status_code == 403
    assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    assert database.execute_calls == [rpc]


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", [[], {}], ids=["array", "object"])
def test_http_malformed_error_identity_returns_fixed_503_without_retry(
    api, method, path, body, rpc, field, identity
):
    client, database, _, _, _ = api
    database.handlers[rpc] = APIError(malformed_provider_error(field, identity))
    response = client.request(method, path, json=body)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert "private" not in response.text
    assert database.execute_calls == [rpc]
    assert len(database.rpc_calls) == 1


@pytest.mark.parametrize(
    "method,path,body", [("POST", BASE, CREATE), ("PATCH", BASE + f"/{EVENT}", PATCH)]
)
def test_http_timeout_after_mutation_never_resubmits(api, monkeypatch, method, path, body):
    client, database, _, _, _ = api

    async def committed_before_lane_timeout(provider, operation, *, lane):
        assert lane == "interactive"
        operation(provider)
        raise HTTPException(504, "Shared provider operation timeout", headers={"Retry-After": "1"})

    monkeypatch.setattr(routes, "run_supabase_operation", committed_before_lane_timeout)
    response = client.request(method, path, json=body)
    assert response.status_code == 504
    assert response.headers["Retry-After"] == "1"
    assert response.json() == {"detail": "Shared provider operation timeout"}
    assert database.execute_calls == [MUTATE]


def test_http_provider_timeout_is_sanitized(api):
    client, database, _, _, _ = api
    database.handlers[MUTATE] = httpx.ReadTimeout("private provider timeout")
    response = client.post(BASE, json=CREATE)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert database.execute_calls == [MUTATE]


def test_openapi_exports_typed_event_routes_and_existing_eligibility_candidates(api):
    _, _, _, _, app = api
    schema = app.openapi()
    assert set(schema["paths"]) == {BASE, BASE + "/{event_id}", BASE + "/{event_id}/candidates"}
    assert set(schema["paths"][BASE]) == {"get", "post"}
    assert set(schema["paths"][BASE + "/{event_id}"]) == {"get", "patch"}
    assert set(schema["paths"][BASE + "/{event_id}/candidates"]) == {"get"}
    assert schema["paths"][BASE + "/{event_id}/candidates"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["items"] == {"$ref": "#/components/schemas/EligibilityEntry"}
    assert set(schema["components"]["schemas"]["BeltTestEventResponse"]["required"]) == set(ROW)
    create_schema = schema["components"]["schemas"]["BeltTestEventCreate"]
    assert "program_id" not in create_schema["properties"]
    assert create_schema["additionalProperties"] is False


class SyntheticPostgrestClient(SyncPostgrestClient):
    def __init__(self, handler):
        self.handler = handler
        super().__init__("https://synthetic.invalid/rest/v1")

    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            transport=httpx.MockTransport(self.handler),
            trust_env=False,
        )


@pytest.mark.parametrize("rpc,envelope", [(MUTATE, RECEIPT), (GET, {"payload": ROW}), (LIST, PAGE)])
def test_pinned_postgrest_parses_all_exact_rpc_envelopes_without_network(rpc, envelope):
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=envelope)

    with SyntheticPostgrestClient(handler) as database:
        result = call_service(database, rpc)
    assert result.model_dump(mode="json") == (envelope if rpc == MUTATE else envelope["payload"])
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{rpc}"
    request = json.loads(requests[0].content)
    assert request["p_studio_id"] == STUDIO
    assert request["p_actor_id"] == ACTOR
    if rpc == MUTATE:
        assert request["p_event_id"] is None
        assert request["p_expected_revision"] is None
        assert "program_id" not in request["p_request"]
        assert request["p_request"]["status"] == "draft"


def test_pinned_postgrest_error_details_are_not_exposed():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            409,
            json={
                "code": "P0001",
                "message": "AUTOMATION_STATE_CONFLICT",
                "details": "private event",
                "hint": "private SQL",
            },
        )

    with SyntheticPostgrestClient(handler) as database:
        with pytest.raises(HTTPException) as error:
            create(BeltTestService(database))
    assert (error.value.status_code, error.value.detail) == (
        409,
        "This belt-test event cannot be changed in its current state.",
    )
    assert len(requests) == 1


@pytest.mark.parametrize("rpc", [MUTATE, GET, LIST])
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_pinned_postgrest_malformed_error_identity_is_unavailable(rpc, field, identity):
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(503, json=malformed_provider_error(field, identity))

    with SyntheticPostgrestClient(handler) as database:
        with pytest.raises(HTTPException) as error:
            call_service(database, rpc)
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert isinstance(error.value.__context__, APIError)
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{rpc}"
