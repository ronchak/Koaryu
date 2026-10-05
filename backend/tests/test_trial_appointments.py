"""Mocked trial boundary and pinned SDK parsing; no SQL or provider integration."""

import base64
import json
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
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

from app.api.v1.endpoints import trial_appointments as routes
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.trial_appointment import (
    MAX_REVISION,
    TrialAppointmentCreate,
    TrialAppointmentResponse,
    TrialAppointmentUpdate,
)
from app.schemas import trial_appointment as trial_schema
from app.services.trial_appointment_service import (
    ADMIN_REQUIRED_DETAIL,
    INVALID_CURSOR_DETAIL,
    UNAVAILABLE_DETAIL,
    TrialAppointmentService,
)
from tests.fakes.supabase import TableBackedSupabase

STUDIO, ACTOR, LEAD, APPOINTMENT, OPERATION, PROGRAM, OTHER = (
    str(UUID(int=value)) for value in range(1, 8)
)
MUTATE = "mutate_lead_trial_appointment_v1"
LIST = "list_lead_trial_appointments_v1"
BASE = f"/api/v1/leads/{LEAD}/trial-appointments"
# Deliberately old: committed operations must remain replayable after their start.
CREATE = {
    "operation_id": OPERATION,
    "starts_at": "2020-11-01T01:30:00-07:00",
    "ends_at": "2020-11-01T01:30:00-08:00",
    "timezone": "America/Los_Angeles",
}
PATCH = {"operation_id": OPERATION, "expected_revision": 1, "location": "Room 2"}
ROW = {
    "id": APPOINTMENT,
    "studio_id": STUDIO,
    "lead_id": LEAD,
    "program_id": PROGRAM,
    "starts_at": "2020-11-01T08:30:00Z",
    "ends_at": "2020-11-01T09:30:00Z",
    "timezone": "America/Los_Angeles",
    "location": "Original room",
    "status": "scheduled",
    "revision": 1,
    "created_by": ACTOR,
    "created_at": "2020-10-01T12:00:00Z",
    "updated_at": "2020-10-01T12:00:00Z",
}
RECEIPT = {"payload": ROW, "operation_id": OPERATION, "replayed": False}
CURSOR = {"created_at": ROW["created_at"], "id": APPOINTMENT}
PAGE = {"payload": {"items": [ROW], "next_cursor": None, "has_more": False}}
ROUTE_CASES = [
    ("GET", BASE, None),
    ("POST", BASE, CREATE),
    ("PATCH", BASE + f"/{APPOINTMENT}", PATCH),
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
        self.handlers = {MUTATE: deepcopy(RECEIPT), LIST: deepcopy(PAGE)}

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
    subscription = Mock()
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
    assert error.value.status_code == 503
    assert error.value.detail == UNAVAILABLE_DETAIL


def create(service, **changes):
    return service.create(STUDIO, ACTOR, LEAD, TrialAppointmentCreate(**{**CREATE, **changes}))


def test_resolved_dst_offsets_and_direct_aware_datetimes_normalize_to_utc():
    body = TrialAppointmentCreate(**CREATE)
    assert body.starts_at == datetime(2020, 11, 1, 8, 30, tzinfo=timezone.utc)
    assert body.ends_at - body.starts_at == timedelta(hours=1)
    assert body.timezone == "America/Los_Angeles"
    # A display zone need not agree with the supplied offset of a resolved instant.
    spring = TrialAppointmentCreate(
        **{**CREATE, "starts_at": "2020-03-08T02:30:00Z", "ends_at": "2020-03-08T03:30:00Z"}
    )
    assert spring.starts_at.hour == 2
    direct = TrialAppointmentCreate(
        **{**CREATE, "starts_at": body.starts_at, "ends_at": body.ends_at}
    )
    assert direct.model_dump(mode="json")["starts_at"] == "2020-11-01T08:30:00Z"


@pytest.mark.parametrize(
    "value",
    [
        "2020-11-01",
        "2020-11-01T01:30:00",
        "2020-11-01T01:30Z",
        "2020-11-01T01:30:00+01:99",
        "2020-11-01T01:30:00+24:00",
        "2020-11-01T01:30:00+0100",
        "2020-11-01T25:30:00Z",
        "2020-11-01T01:30:00Zgarbage",
        "Infinity",
        "1604219400",
        1604219400,
        1604219400.0,
        True,
        False,
        float("inf"),
        float("nan"),
        None,
        date(2020, 11, 1),
        datetime(2020, 11, 1, 1, 30),
        "0001-01-01T00:00:00+23:00",
    ],
)
@pytest.mark.parametrize("field", ["starts_at", "ends_at"])
def test_datetime_rejects_naive_date_numeric_or_malformed_values(field, value):
    with pytest.raises(ValidationError):
        TrialAppointmentCreate(**{**CREATE, field: value})


@pytest.mark.parametrize(
    "value",
    [
        "",
        "Mars/Olympus",
        "localtime",
        "posixrules",
        "/etc/localtime",
        "../UTC",
        "America/../UTC",
        "America//Los_Angeles",
        "America\\Los_Angeles",
        "posix/UTC",
        "right/UTC",
        " UTC",
        "A" * 129,
        None,
        True,
        123,
    ],
)
def test_timezone_rejects_unknown_or_host_dependent_names(value):
    with pytest.raises(ValidationError):
        TrialAppointmentCreate(**{**CREATE, "timezone": value})


@pytest.mark.parametrize("zone", ["UTC", "US/Pacific", "Etc/GMT+5", "America/Los_Angeles"])
def test_explicit_iana_zones_and_aliases_are_accepted(zone):
    assert TrialAppointmentCreate(**{**CREATE, "timezone": zone}).timezone == zone


def test_timezone_lookup_oserror_is_a_validation_error(monkeypatch):
    monkeypatch.setattr(trial_schema, "ZoneInfo", Mock(side_effect=OSError("synthetic lookup")))
    with pytest.raises(ValidationError):
        TrialAppointmentCreate(**CREATE)


def test_patch_openapi_distinguishes_omission_from_explicit_null():
    schema = TrialAppointmentUpdate.model_json_schema()
    assert set(schema["required"]) == {"operation_id", "expected_revision"}
    for field in ["starts_at", "ends_at", "timezone", "location", "status"]:
        assert schema["properties"][field]["type"] == "string"
        assert "anyOf" not in schema["properties"][field]
    assert {item["type"] for item in schema["properties"]["program_id"]["anyOf"]} == {
        "string",
        "null",
    }


@pytest.mark.parametrize("minutes", [0, -1, 1441])
def test_complete_windows_reject_nonpositive_or_over_day_duration(minutes):
    start = datetime(2020, 1, 1, tzinfo=timezone.utc)
    values = {"starts_at": start, "ends_at": start + timedelta(minutes=minutes)}
    with pytest.raises(ValidationError):
        TrialAppointmentCreate(**{**CREATE, **values})
    with pytest.raises(ValidationError):
        TrialAppointmentUpdate(**{**PATCH, **values})


def test_exactly_one_day_window_and_plain_bounded_location():
    body = TrialAppointmentCreate(
        **{**CREATE, "ends_at": "2020-11-02T08:30:00Z", "location": "<b>Room</b>"}
    )
    assert body.location == "<b>Room</b>"
    assert body.ends_at - body.starts_at == timedelta(days=1)
    assert TrialAppointmentCreate(**{**CREATE, "location": "x" * 240}).location == "x" * 240
    for value in [None, 123, True, "x" * 241]:
        with pytest.raises(ValidationError):
            TrialAppointmentCreate(**{**CREATE, "location": value})


@pytest.mark.parametrize("field", ["studio_id", "actor_id", "status", "schedule_revision", "extra"])
def test_create_rejects_noncontract_fields(field):
    with pytest.raises(ValidationError):
        TrialAppointmentCreate(**{**CREATE, field: OTHER})


@pytest.mark.parametrize("field", ["starts_at", "ends_at", "timezone", "location", "status"])
def test_patch_rejects_explicit_null_nonnullable_fields(field):
    with pytest.raises(ValidationError):
        TrialAppointmentUpdate(**{**PATCH, field: None})


@pytest.mark.parametrize("revision", [None, True, False, "1", 1.0, 0, -1, MAX_REVISION + 1])
def test_patch_revision_is_a_strict_bounded_integer(revision):
    with pytest.raises(ValidationError):
        TrialAppointmentUpdate(**{**PATCH, "expected_revision": revision})


def test_patch_requires_a_change_and_required_operation_revision():
    for value in [
        {"operation_id": OPERATION, "expected_revision": 1},
        {"location": "Room"},
        {"operation_id": OPERATION, "location": "Room"},
        {**PATCH, "studio_id": STUDIO},
        {**PATCH, "status": "unknown"},
    ]:
        with pytest.raises(ValidationError):
            TrialAppointmentUpdate(**value)
    assert (
        TrialAppointmentUpdate(**{**PATCH, "expected_revision": MAX_REVISION}).expected_revision
        == MAX_REVISION
    )


@pytest.mark.parametrize("status", ["completed", "no_show", "canceled"])
@pytest.mark.parametrize(
    "field,value",
    [
        ("starts_at", CREATE["starts_at"]),
        ("ends_at", CREATE["ends_at"]),
        ("timezone", "UTC"),
        ("location", "Room"),
        ("program_id", None),
    ],
)
def test_outcomes_cannot_mix_with_schedule_edits(status, field, value):
    with pytest.raises(ValidationError):
        TrialAppointmentUpdate(
            operation_id=OPERATION, expected_revision=1, status=status, **{field: value}
        )


def test_patch_allows_each_outcome_and_scheduled_with_schedule_edits():
    for status in ["completed", "no_show", "canceled"]:
        assert (
            TrialAppointmentUpdate(
                operation_id=OPERATION, expected_revision=1, status=status
            ).status
            == status
        )
    assert TrialAppointmentUpdate(**{**PATCH, "status": "scheduled"}).location == "Room 2"


@pytest.mark.parametrize("field", list(ROW))
def test_response_requires_every_canonical_field(field):
    incomplete = {key: value for key, value in ROW.items() if key != field}
    with pytest.raises(ValidationError):
        TrialAppointmentResponse(**incomplete)


def test_response_serializes_uuids_and_utc_and_rejects_extra_fields():
    row = TrialAppointmentResponse(
        **{**ROW, "id": UUID(APPOINTMENT), "created_at": "2020-10-01T05:00:00-07:00"}
    )
    assert row.model_dump(mode="json") == ROW
    assert (
        TrialAppointmentResponse(**{**ROW, "created_by": None, "program_id": None}).program_id
        is None
    )
    with pytest.raises(ValidationError):
        TrialAppointmentResponse(**{**ROW, "schedule_revision": 1})


@pytest.mark.parametrize("program", ["omitted", None, PROGRAM])
def test_create_calls_exact_atomic_signature_preserving_program_omission(database, program):
    changes = {} if program == "omitted" else {"program_id": program}
    result = create(TrialAppointmentService(database), **changes)
    request = {
        "starts_at": ROW["starts_at"],
        "ends_at": ROW["ends_at"],
        "timezone": ROW["timezone"],
        "location": "",
    }
    if program != "omitted":
        request["program_id"] = program
    assert database.rpc_calls == [
        (
            MUTATE,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_lead_id": LEAD,
                "p_appointment_id": None,
                "p_operation_id": OPERATION,
                "p_expected_revision": None,
                "p_request": request,
            },
        )
    ]
    assert result.model_dump(mode="json") == RECEIPT
    assert database.query_log == []


@pytest.mark.parametrize(
    "patch",
    [
        {"starts_at": "2020-11-01T10:30:00Z"},
        {"ends_at": "2020-11-01T07:30:00Z"},
        {"program_id": None},
        {"status": "canceled"},
    ],
)
def test_partial_update_passes_only_requested_fields_without_pre_read(database, patch):
    data = TrialAppointmentUpdate(operation_id=OPERATION, expected_revision=5, **patch)
    TrialAppointmentService(database).update(STUDIO, ACTOR, LEAD, APPOINTMENT, data)
    assert database.rpc_calls == [
        (
            MUTATE,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_lead_id": LEAD,
                "p_appointment_id": APPOINTMENT,
                "p_operation_id": OPERATION,
                "p_expected_revision": 5,
                "p_request": patch,
            },
        )
    ]
    assert database.query_log == []


def test_replay_returns_original_receipt_payload_without_reload(database):
    database.handlers[MUTATE]["replayed"] = True
    result = create(TrialAppointmentService(database))
    assert result.replayed is True
    assert str(result.operation_id) == OPERATION
    assert result.payload.model_dump(mode="json") == ROW
    assert len(database.rpc_calls) == 1
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
        {**RECEIPT, "replayed": 1},
        {**RECEIPT, "replayed": "true"},
        {**RECEIPT, "message": "private"},
        {**RECEIPT, "payload": {**ROW, "studio_id": OTHER}},
        {**RECEIPT, "payload": {**ROW, "lead_id": OTHER}},
        {**RECEIPT, "payload": {**ROW, "revision": "1"}},
        {**RECEIPT, "payload": {**ROW, "starts_at": 1604219400}},
    ],
)
def test_malformed_or_foreign_mutation_response_fails_closed(database, envelope):
    database.handlers[MUTATE] = envelope
    assert_unavailable(lambda: create(TrialAppointmentService(database)))
    assert len(database.rpc_calls) == 1
    assert database.query_log == []


def test_update_rejects_another_appointment_id(database):
    database.handlers[MUTATE]["payload"]["id"] = OTHER
    assert_unavailable(
        lambda: TrialAppointmentService(database).update(
            STUDIO, ACTOR, LEAD, APPOINTMENT, TrialAppointmentUpdate(**PATCH)
        )
    )


@pytest.mark.parametrize(
    "code,message,status,detail",
    [
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403, ADMIN_REQUIRED_DETAIL),
        ("P0002", "AUTOMATION_NOT_FOUND", 404, "Trial appointment or lead not found."),
        ("22023", "AUTOMATION_INVALID_REQUEST", 422, "Invalid trial appointment request."),
        (
            "P0001",
            "AUTOMATION_REVISION_CONFLICT",
            409,
            "This trial appointment changed. Reload it before saving.",
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
            "This trial appointment cannot be changed in its current state.",
        ),
        ("P0001", "AUTOMATION_STUDIO_BUSY", 409, "The studio is busy. Try again shortly."),
        ("42883", "missing private RPC", 503, UNAVAILABLE_DETAIL),
        ("PGRST202", "missing private RPC", 503, UNAVAILABLE_DETAIL),
        ("42501", "private permission error", 503, UNAVAILABLE_DETAIL),
        ("22023", "private malformed error", 503, UNAVAILABLE_DETAIL),
        ("P0001", "unknown private error", 503, UNAVAILABLE_DETAIL),
        ("XX000", "AUTOMATION_NOT_FOUND", 503, UNAVAILABLE_DETAIL),
    ],
)
def test_only_owned_error_pairs_have_fixed_mapping(database, code, message, status, detail):
    database.handlers[MUTATE] = APIError(
        {"code": code, "message": message, "details": "private detail", "hint": "private hint"}
    )
    with pytest.raises(HTTPException) as error:
        create(TrialAppointmentService(database))
    assert (error.value.status_code, error.value.detail) == (status, detail)
    assert len(database.rpc_calls) == 1


@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("private timeout"),
        RuntimeError("private provider"),
        HTTPException(400, "private response"),
    ],
)
def test_provider_fault_never_retries_or_reads_tables(database, failure):
    database.handlers[MUTATE] = failure
    assert_unavailable(lambda: create(TrialAppointmentService(database)))
    assert len(database.rpc_calls) == 1
    assert database.query_log == []


def test_list_uses_exact_rpc_even_for_empty_page(database):
    database.handlers[LIST] = {"payload": {"items": [], "next_cursor": None, "has_more": False}}
    result = TrialAppointmentService(database).list(STUDIO, ACTOR, LEAD)
    assert result.model_dump() == {"items": [], "next_cursor": None, "has_more": False}
    assert database.rpc_calls == [
        (
            LIST,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_lead_id": LEAD,
                "p_limit": 50,
                "p_cursor": None,
            },
        )
    ]
    assert database.query_log == []


def test_cursor_roundtrip_is_canonical_and_utc_normalized(database):
    database.handlers[LIST]["payload"].update(next_cursor=CURSOR, has_more=True)
    service = TrialAppointmentService(database)
    page = service.list(STUDIO, ACTOR, LEAD, limit=1)
    expected = encoded(json.dumps(CURSOR, sort_keys=True, separators=(",", ":")).encode())
    assert page.next_cursor == expected
    assert page.has_more is True
    service.list(STUDIO, ACTOR, LEAD, limit=1, cursor=page.next_cursor)
    assert database.rpc_calls[-1][1]["p_cursor"] == CURSOR
    service.list(
        STUDIO, ACTOR, LEAD, cursor=encoded({**CURSOR, "created_at": "2020-10-01T05:00:00-07:00"})
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
        encoded(b"not json"),
        encoded(b"\xff"),
        encoded([]),
        encoded(None),
        encoded({}),
        encoded({"id": APPOINTMENT}),
        encoded({"created_at": ROW["created_at"]}),
        encoded({**CURSOR, "extra": True}),
        encoded({**CURSOR, "created_at": "2020-10-01"}),
        encoded({**CURSOR, "created_at": "2020-10-01T12:00:00"}),
        encoded({**CURSOR, "created_at": 1601553600}),
        encoded({**CURSOR, "created_at": float("inf")}),
        encoded({**CURSOR, "id": "bad"}),
        encoded(
            f'{{"created_at":"{ROW["created_at"]}","id":"{APPOINTMENT}","id":"{OTHER}"}}'.encode()
        ),
    ],
)
def test_invalid_cursor_rejected_before_rpc(database, token):
    with pytest.raises(HTTPException) as error:
        TrialAppointmentService(database).list(STUDIO, ACTOR, LEAD, cursor=token)
    assert (error.value.status_code, error.value.detail) == (422, INVALID_CURSOR_DETAIL)
    assert database.rpc_calls == []


@pytest.mark.parametrize("limit", [0, 101, True, "1", 1.0])
def test_invalid_service_limits_rejected_before_rpc(database, limit):
    with pytest.raises(HTTPException) as error:
        TrialAppointmentService(database).list(STUDIO, ACTOR, LEAD, limit=limit)
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
        {"items": [], "next_cursor": CURSOR, "has_more": True},
        {"items": [{**ROW, "studio_id": OTHER}], "next_cursor": None, "has_more": False},
        {"items": [{**ROW, "lead_id": OTHER}], "next_cursor": None, "has_more": False},
        {"items": [ROW], "has_more": False},
        {"items": [ROW], "next_cursor": None},
        {"items": [ROW], "next_cursor": None, "has_more": False, "extra": "private"},
    ],
)
def test_malformed_or_foreign_list_payload_fails_closed(database, payload):
    database.handlers[LIST] = {"payload": payload}
    assert_unavailable(lambda: TrialAppointmentService(database).list(STUDIO, ACTOR, LEAD, limit=1))
    assert len(database.rpc_calls) == 1


@pytest.mark.parametrize(
    "envelope", [PAGE["payload"], {"message": PAGE["payload"]}, {**PAGE, "extra": True}, []]
)
def test_list_rejects_compatibility_envelopes(database, envelope):
    database.handlers[LIST] = envelope
    assert_unavailable(lambda: TrialAppointmentService(database).list(STUDIO, ACTOR, LEAD))


@pytest.mark.parametrize("method,path,body", ROUTE_CASES)
def test_http_admin_success_checks_membership_and_entitlement_in_interactive_lane(
    api, method, path, body
):
    client, database, subscription, lane_calls, _ = api
    database.handlers[MUTATE]["replayed"] = True
    response = client.request(method, path, json=body, headers={"X-Studio-Id": f" {STUDIO} "})
    assert response.status_code == (201 if method == "POST" else 200)
    assert response.json() == (PAGE["payload"] if method == "GET" else ROW)
    assert lane_calls == ["interactive"]
    subscription.assert_called_once_with(database, STUDIO)
    assert len(database.rpc_calls) == 1
    assert database.rpc_calls[0][1]["p_studio_id"] == STUDIO
    assert database.rpc_calls[0][1]["p_actor_id"] == ACTOR
    assert {query["table"] for query in database.query_log} == {"staff_roles"}


@pytest.mark.parametrize("method,path,body", ROUTE_CASES)
@pytest.mark.parametrize(
    "denial", ["front_desk", "instructor", "archived", "multiple", "foreign", "none"]
)
def test_http_membership_denials_precede_entitlement_and_rpc(api, method, path, body, denial):
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


@pytest.mark.parametrize("method,path,body", ROUTE_CASES)
@pytest.mark.parametrize("status", [402, 503])
def test_http_entitlement_failure_precedes_rpc(api, method, path, body, status):
    client, database, subscription, _, _ = api
    subscription.side_effect = HTTPException(status, "Subscription unavailable")
    assert client.request(method, path, json=body).status_code == status
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body", ROUTE_CASES)
def test_http_unauthenticated_request_has_no_membership_or_rpc_access(api, method, path, body):
    client, database, subscription, _, app = api
    app.dependency_overrides.pop(get_current_user_id)
    assert client.request(method, path, json=body).status_code == 401
    subscription.assert_not_called()
    assert database.query_log == []
    assert database.rpc_calls == []


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", BASE.replace(LEAD, "bad"), CREATE),
        ("GET", BASE.replace(LEAD, "bad"), None),
        ("PATCH", BASE + "/bad", PATCH),
        ("POST", BASE, {**CREATE, "starts_at": 1604219400}),
        ("POST", BASE, {**CREATE, "studio_id": OTHER}),
        ("PATCH", BASE + f"/{APPOINTMENT}", {**PATCH, "location": None}),
        ("GET", BASE + "?limit=0", None),
        ("GET", BASE + "?limit=101", None),
        ("GET", BASE + "?cursor=" + "a" * 513, None),
    ],
)
def test_http_invalid_contract_input_never_calls_rpc(api, method, path, body):
    client, database, _, _, _ = api
    assert client.request(method, path, json=body).status_code == 422
    assert database.rpc_calls == []


@pytest.mark.parametrize("method,path,body", ROUTE_CASES)
@pytest.mark.parametrize(
    "code,message,status",
    [
        ("P0002", "AUTOMATION_NOT_FOUND", 404),
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403),
        ("P0001", "AUTOMATION_STATE_CONFLICT", 409),
    ],
)
def test_http_mocked_sql_parent_authority_and_terminal_rejections_are_fixed(
    api, method, path, body, code, message, status
):
    client, database, _, _, _ = api
    database.handlers[LIST if method == "GET" else MUTATE] = APIError(
        {"code": code, "message": message, "details": "private lead", "hint": "private SQL"}
    )
    response = client.request(method, path, json=body)
    assert response.status_code == status
    assert "private" not in response.text
    assert message not in response.text
    assert len(database.rpc_calls) == 1


@pytest.mark.parametrize("method,path,body", ROUTE_CASES)
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", [[], {}], ids=["array", "object"])
def test_http_malformed_error_identity_returns_fixed_503_without_retry(
    api, method, path, body, field, identity
):
    client, database, _, _, _ = api
    rpc = LIST if method == "GET" else MUTATE
    database.handlers[rpc] = APIError(malformed_provider_error(field, identity))
    response = client.request(method, path, json=body)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert "private" not in response.text
    assert database.execute_calls == [rpc]
    assert len(database.rpc_calls) == 1


def test_http_provider_timeout_is_sanitized_without_retry(api):
    client, database, _, _, _ = api
    database.handlers[MUTATE] = httpx.ReadTimeout("private provider timeout")
    response = client.post(BASE, json=CREATE)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert len(database.rpc_calls) == 1


def test_shared_lane_timeout_remains_504_without_resubmitting_mutation(api, monkeypatch):
    client, database, _, _, _ = api

    async def committed_before_lane_timeout(provider, operation, *, lane):
        assert lane == "interactive"
        operation(provider)
        raise HTTPException(504, "Shared provider operation timeout", headers={"Retry-After": "1"})

    monkeypatch.setattr(routes, "run_supabase_operation", committed_before_lane_timeout)
    response = client.post(BASE, json=CREATE)
    assert response.status_code == 504
    assert response.headers["Retry-After"] == "1"
    assert response.json() == {"detail": "Shared provider operation timeout"}
    assert len(database.rpc_calls) == 1


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


def test_pinned_postgrest_parses_payload_receipt_without_network():
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={**RECEIPT, "replayed": True})

    with SyntheticPostgrestClient(handler) as database:
        result = create(TrialAppointmentService(database))
    assert result.model_dump(mode="json") == {**RECEIPT, "replayed": True}
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{MUTATE}"
    request_body = json.loads(requests[0].content)
    assert request_body["p_appointment_id"] is None
    assert request_body["p_expected_revision"] is None
    assert "program_id" not in request_body["p_request"]


def test_pinned_postgrest_error_details_are_not_exposed():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            409,
            json={
                "code": "P0001",
                "message": "AUTOMATION_STATE_CONFLICT",
                "details": "private appointment",
                "hint": "private SQL",
            },
        )

    with SyntheticPostgrestClient(handler) as database:
        with pytest.raises(HTTPException) as error:
            create(TrialAppointmentService(database))
    assert (error.value.status_code, error.value.detail) == (
        409,
        "This trial appointment cannot be changed in its current state.",
    )
    assert len(requests) == 1


@pytest.mark.parametrize("rpc", [MUTATE, LIST])
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
            service = TrialAppointmentService(database)
            if rpc == LIST:
                service.list(STUDIO, ACTOR, LEAD)
            else:
                create(service)
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert isinstance(error.value.__context__, APIError)
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{rpc}"
