"""Mocked current trial reads, actual HTTP dependencies, and pinned SDK parsing.

These tests do not execute SQL. Core owns the SQL proof and later router mounting.
"""

import json
from copy import deepcopy
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import iter_route_contexts
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.api.v1.endpoints import trial_appointments as routes
from app.core.deps import get_current_user_id, get_supabase
from app.main import app as composed_app
from app.schemas.trial_appointment import MAX_REVISION, TrialAppointmentResponse
from app.services.platform_billing_service import PlatformBillingService
from app.services.studio_scope import (
    BILLING_STATUS_UNAVAILABLE_DETAIL,
    SUBSCRIPTION_REQUIRED_DETAIL,
)
from app.services.trial_appointment_service import (
    ADMIN_REQUIRED_DETAIL,
    UNAVAILABLE_DETAIL,
    TrialAppointmentService,
)
from app.services.workflow_management_service import WorkflowManagementService
from tests.test_trial_appointments import (
    ACTOR,
    APPOINTMENT,
    BASE,
    CREATE,
    LEAD,
    MALFORMED_ERROR_IDENTITIES,
    MUTATE,
    OPERATION,
    OTHER,
    PAGE,
    PATCH,
    PROGRAM,
    ROW,
    STUDIO,
    Database,
    SyntheticPostgrestClient,
    malformed_provider_error,
)

GET = "get_lead_trial_appointment_v1"
DETAIL = BASE + f"/{APPOINTMENT}"
PARAMS = {
    "p_studio_id": STUDIO,
    "p_actor_id": ACTOR,
    "p_lead_id": LEAD,
    "p_appointment_id": APPOINTMENT,
}
CURRENT = {
    **ROW,
    "revision": 3,
    "status": "completed",
    "location": "Current room",
    "updated_at": "2020-11-01T10:00:00Z",
}
NONNULL_FIELDS = set(ROW) - {"program_id", "created_by"}
ERRORS = [
    ("42501", "AUTOMATION_ADMIN_REQUIRED", 403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND", 404, "Trial appointment or lead not found."),
    ("22023", "AUTOMATION_INVALID_REQUEST", 422, "Invalid trial appointment request."),
    ("P0001", "AUTOMATION_STUDIO_BUSY", 409, "The studio is busy. Try again shortly."),
    ("42883", "private missing function", 503, UNAVAILABLE_DETAIL),
    ("PGRST202", "private missing function", 503, UNAVAILABLE_DETAIL),
    ("42501", "private permission error", 503, UNAVAILABLE_DETAIL),
    ("XX000", "AUTOMATION_NOT_FOUND", 503, UNAVAILABLE_DETAIL),
]


@pytest.fixture
def database():
    database = Database()
    database.handlers[GET] = {"payload": deepcopy(CURRENT)}
    return database


@pytest.fixture
def api(monkeypatch, database):
    # Keep the real membership and entitlement decisions. Replace only the billing
    # storage/provider boundary with a current synthetic subscription row.
    access_row = Mock(return_value={"status": "active", "comped": False})
    monkeypatch.setattr(PlatformBillingService, "get_access_status_row", access_row)
    lane_calls = []
    original_run = routes.run_supabase_operation

    async def tracked_run(provider, operation, *, lane):
        lane_calls.append(lane)
        return await original_run(provider, operation, lane=lane)

    monkeypatch.setattr(routes, "run_supabase_operation", tracked_run)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.include_router(routes.detail_router, prefix="/api/v1")
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            database=database,
            access_row=access_row,
            lane_calls=lane_calls,
            app=app,
        )


def assert_one_read(database):
    assert database.rpc_calls == [(GET, PARAMS)]
    assert database.execute_calls == [GET]


@pytest.mark.parametrize("ids", [str, UUID])
def test_service_reads_exact_current_record_once_without_tables(database, ids):
    result = TrialAppointmentService(database).get(
        *(ids(value) for value in [STUDIO, ACTOR, LEAD, APPOINTMENT])
    )
    assert isinstance(result, TrialAppointmentResponse)
    assert result.model_dump(mode="json") == CURRENT
    assert_one_read(database)
    assert database.query_log == []


def test_current_detail_does_not_replace_or_fall_back_to_original_operation_receipt(database):
    operation_rpc = "get_automation_operation_v1"
    original = {
        "operation_id": OPERATION,
        "state": "committed",
        "command": "trial.create",
        "entity_type": "trial_appointment",
        "entity_id": APPOINTMENT,
        "result": deepcopy(ROW),
        "committed_at": ROW["created_at"],
    }
    database.handlers[operation_rpc] = {"payload": deepcopy(original)}
    receipt = WorkflowManagementService(database).operation(STUDIO, ACTOR, UUID(OPERATION), "admin")
    current = TrialAppointmentService(database).get(STUDIO, ACTOR, LEAD, APPOINTMENT)
    assert receipt.model_dump(mode="json") == original
    assert current.model_dump(mode="json") == CURRENT
    assert current.revision > receipt.result.revision
    assert receipt.result.status == "scheduled"
    assert database.handlers[operation_rpc] == {"payload": original}
    assert database.rpc_calls[-1] == (GET, PARAMS)
    assert database.execute_calls == [operation_rpc, GET]
    assert database.query_log == []


@pytest.mark.parametrize("status", ["scheduled", "completed", "no_show", "canceled"])
@pytest.mark.parametrize("program", [None, PROGRAM])
def test_http_reads_past_and_terminal_history_with_retained_program_context(api, status, program):
    row = {**CURRENT, "status": status, "program_id": program, "created_by": None}
    api.database.handlers[GET] = {"payload": row}
    response = api.client.get(DETAIL, headers={"X-Studio-Id": f" {STUDIO} "})
    assert response.status_code == 200
    assert response.json() == row
    assert api.lane_calls == ["interactive"]
    api.access_row.assert_called_once_with(STUDIO, strict_repairs=True, allow_provider_repairs=True)
    assert_one_read(api.database)
    # No lead eligibility or active program lookup can hide retained history.
    assert {query["table"] for query in api.database.query_log} == {"staff_roles"}


@pytest.mark.parametrize("field", list(ROW))
def test_http_requires_every_complete_payload_field(api, field):
    api.database.handlers[GET]["payload"].pop(field)
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


@pytest.mark.parametrize("field", sorted(NONNULL_FIELDS))
def test_http_rejects_null_nonnullable_payload_fields(api, field):
    api.database.handlers[GET]["payload"][field] = None
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


@pytest.mark.parametrize(
    "envelope",
    [
        None,
        [],
        [{"payload": CURRENT}],
        CURRENT,
        {},
        {"result": CURRENT},
        {"payload": None},
        {"payload": []},
        {"payload": [CURRENT]},
        {"payload": CURRENT, "private_extra": "private"},
        {"payload": CURRENT, "operation_id": OPERATION, "replayed": True},
        {"payload": {**CURRENT, "private_extra": "private"}},
        PAGE,
    ],
)
def test_malformed_read_envelopes_fail_closed_without_receipt_or_list_fallback(database, envelope):
    database.handlers[GET] = envelope
    with pytest.raises(HTTPException) as error:
        TrialAppointmentService(database).get(STUDIO, ACTOR, LEAD, APPOINTMENT)
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert_one_read(database)
    assert database.query_log == []


@pytest.mark.parametrize("field", ["id", "studio_id", "lead_id"])
def test_http_rejects_foreign_identity_on_every_exact_record_key(api, field):
    api.database.handlers[GET]["payload"][field] = OTHER
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


@pytest.mark.parametrize(
    "field,value",
    [
        ("revision", True),
        ("revision", "3"),
        ("revision", 3.0),
        ("revision", 0),
        ("revision", MAX_REVISION + 1),
        ("status", "unknown"),
        ("starts_at", 1604219400),
        ("ends_at", CURRENT["starts_at"]),
        ("created_at", "2020-10-01T12:00:00"),
        ("updated_at", "2020-10-01"),
        ("timezone", "localtime"),
        ("location", 123),
        ("location", "x" * 241),
        ("program_id", "bad"),
        ("created_by", "bad"),
    ],
)
def test_http_rejects_invalid_current_payload_values(api, field, value):
    api.database.handlers[GET]["payload"][field] = value
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


@pytest.mark.parametrize(
    "denial,status",
    [
        ("front_desk", 403),
        ("instructor", 403),
        ("archived", 403),
        ("multiple", 409),
        ("foreign", 403),
        ("none", 404),
    ],
)
def test_actual_membership_denial_precedes_entitlement_and_rpc(api, denial, status):
    membership = api.database.tables["staff_roles"][0]
    headers = {}
    if denial in {"front_desk", "instructor"}:
        membership["role"] = denial
    elif denial == "archived":
        membership["archived_at"] = "2026-10-01"
    elif denial == "multiple":
        api.database.tables["staff_roles"].append({**membership, "studio_id": OTHER})
        headers["X-Studio-Id"] = STUDIO
    elif denial == "foreign":
        headers["X-Studio-Id"] = OTHER
    else:
        api.database.tables["staff_roles"] = []
    response = api.client.get(DETAIL, headers=headers)
    assert response.status_code == status
    if denial in {"front_desk", "instructor"}:
        assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    api.access_row.assert_not_called()
    assert api.database.rpc_calls == []
    assert {query["table"] for query in api.database.query_log} == {"staff_roles"}


def test_actual_entitlement_is_rechecked_after_access_changes(api):
    assert api.client.get(DETAIL).status_code == 200
    api.access_row.return_value = {"status": "canceled", "comped": False}
    response = api.client.get(DETAIL)
    assert response.status_code == 402
    assert response.json() == {
        "detail": {
            **SUBSCRIPTION_REQUIRED_DETAIL,
            "status": "canceled",
            "comped": False,
            "subscription_required": True,
        }
    }
    assert api.access_row.call_count == 2
    assert_one_read(api.database)


def test_actual_entitlement_failure_blocks_read_without_provider_detail(api):
    api.access_row.side_effect = RuntimeError("private billing failure")
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {
        "detail": {**BILLING_STATUS_UNAVAILABLE_DETAIL, "subscription_required": True}
    }
    assert api.database.rpc_calls == []


def test_unauthenticated_request_has_no_membership_entitlement_or_rpc(api):
    api.app.dependency_overrides.pop(get_current_user_id)
    assert api.client.get(DETAIL).status_code == 401
    api.access_row.assert_not_called()
    assert api.lane_calls == []
    assert api.database.query_log == []
    assert api.database.rpc_calls == []


@pytest.mark.parametrize("path", [DETAIL.replace(LEAD, "bad"), BASE + "/bad"])
def test_uuid_path_validation_precedes_all_provider_operations(api, path):
    assert api.client.get(path).status_code == 422
    api.access_row.assert_not_called()
    assert api.lane_calls == []
    assert api.database.query_log == []
    assert api.database.rpc_calls == []


@pytest.mark.parametrize("code,message,status,detail", ERRORS)
def test_http_maps_only_owned_sql_error_pairs(api, code, message, status, detail):
    api.database.handlers[GET] = APIError(
        {"code": code, "message": message, "details": "private detail", "hint": "private hint"}
    )
    response = api.client.get(DETAIL)
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert "private" not in response.text
    assert_one_read(api.database)


@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_http_malformed_provider_error_identity_is_fixed_503(api, field, identity):
    api.database.handlers[GET] = APIError(malformed_provider_error(field, identity))
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ReadTimeout("private timeout"),
        RuntimeError("private failure"),
        HTTPException(400, "private response"),
    ],
)
def test_provider_fault_is_sanitized_without_retry(api, failure):
    api.database.handlers[GET] = failure
    response = api.client.get(DETAIL)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


def test_shared_lane_timeout_remains_504_without_resubmission(api, monkeypatch):
    async def completed_before_timeout(provider, operation, *, lane):
        assert lane == "interactive"
        operation(provider)
        raise HTTPException(504, "Shared provider operation timeout", headers={"Retry-After": "1"})

    monkeypatch.setattr(routes, "run_supabase_operation", completed_before_timeout)
    response = api.client.get(DETAIL)
    assert response.status_code == 504
    assert response.headers["Retry-After"] == "1"
    assert response.json() == {"detail": "Shared provider operation timeout"}
    assert_one_read(api.database)


def test_actual_http_handler_uses_pinned_sdk_for_membership_and_exact_rpc(api):
    assert version("postgrest") == "0.17.2"
    requests = []

    def transport(request):
        requests.append(request)
        if request.url.path == "/rest/v1/staff_roles":
            assert request.method == "GET"
            assert request.url.params["user_id"] == f"eq.{ACTOR}"
            return httpx.Response(200, json=api.database.tables["staff_roles"])
        assert request.method == "POST"
        assert request.url.path == f"/rest/v1/rpc/{GET}"
        assert json.loads(request.content) == PARAMS
        return httpx.Response(200, json={"payload": CURRENT})

    with SyntheticPostgrestClient(transport) as database:
        api.app.dependency_overrides[get_supabase] = lambda: database
        response = api.client.get(DETAIL, headers={"X-Studio-Id": STUDIO})
    assert response.status_code == 200
    assert response.json() == CURRENT
    assert len(requests) == 2
    assert api.lane_calls == ["interactive"]
    api.access_row.assert_called_once()


@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_pinned_sdk_malformed_errors_are_sanitized_from_none(field, identity):
    requests = []

    def transport(request):
        requests.append(request)
        return httpx.Response(503, json=malformed_provider_error(field, identity))

    with SyntheticPostgrestClient(transport) as database, pytest.raises(HTTPException) as error:
        TrialAppointmentService(database).get(STUDIO, ACTOR, LEAD, APPOINTMENT)
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert isinstance(error.value.__context__, APIError)
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{GET}"
    assert json.loads(requests[0].content) == PARAMS


@pytest.mark.parametrize(
    "method,path,body,expected",
    [
        ("GET", BASE, None, PAGE["payload"]),
        ("POST", BASE, CREATE, ROW),
        ("PATCH", DETAIL, PATCH, ROW),
    ],
)
def test_combined_routers_preserve_existing_list_create_and_patch(
    api, method, path, body, expected
):
    response = api.client.request(method, path, json=body)
    assert response.status_code == (201 if method == "POST" else 200)
    assert response.json() == expected
    assert api.database.execute_calls == [
        "list_lead_trial_appointments_v1" if method == "GET" else MUTATE
    ]


def test_detail_openapi_reuses_complete_response_and_accepts_only_identity_parameters(api):
    path = "/api/v1/leads/{lead_id}/trial-appointments/{appointment_id}"
    contract = api.app.openapi()["paths"][path]
    assert set(contract) == {"get", "patch"}
    detail = contract["get"]
    assert "requestBody" not in detail
    assert not [param for param in detail["parameters"] if param["in"] == "query"]
    for name in ["lead_id", "appointment_id"]:
        parameter = next(param for param in detail["parameters"] if param["name"] == name)
        assert parameter["in"] == "path"
        assert parameter["required"] is True
        assert parameter["schema"]["format"] == "uuid"
    assert detail["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/TrialAppointmentResponse"
    }
    assert len(routes.detail_router.routes) == 1


def test_composed_app_keeps_trial_detail_unmounted_until_core_sql_proof():
    base = "/api/v1/leads/{lead_id}/trial-appointments"
    expected = {
        (base, "GET"): routes.list_trial_appointments,
        (base, "POST"): routes.create_trial_appointment,
        (base + "/{appointment_id}", "PATCH"): routes.update_trial_appointment,
    }
    actual = [
        (route.path, method, route.endpoint)
        for route in iter_route_contexts(composed_app.routes)
        if route.path.startswith(base)
        for method in route.methods or set()
    ]
    assert len(actual) == len(expected)
    assert {(path, method): handler for path, method, handler in actual} == expected
    openapi = composed_app.openapi()
    assert set(openapi["paths"][base]) == {"get", "post"}
    assert set(openapi["paths"][base + "/{appointment_id}"]) == {"patch"}
