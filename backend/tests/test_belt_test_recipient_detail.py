"""Exact recipient reads with real access checks; SQL and mounting remain Core-owned."""

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

from app.api.v1.endpoints import belt_test_recipients as routes
from app.core.deps import get_current_user_id, get_supabase
from app.main import app as composed_app
from app.schemas.belt_test_recipient import BeltTestRecipientResponse
from app.schemas.trial_appointment import MAX_REVISION
from app.services.belt_test_recipient_service import (
    ADMIN_REQUIRED_DETAIL,
    UNAVAILABLE_DETAIL,
    BeltTestRecipientService,
)
from app.services.studio_scope import BILLING_STATUS_UNAVAILABLE_DETAIL
from app.services.workflow_management_service import WorkflowManagementService
from tests import test_platform_billing_readonly_access as readonly_access
from tests.test_belt_test_recipients import (
    ACTOR,
    BASE,
    EVENT,
    MALFORMED_ERROR_IDENTITIES,
    OPERATION,
    OTHER,
    PAGE,
    RECIPIENT,
    RECIPIENTS_PATH,
    ROUTE_CASES,
    ROW,
    STUDIO,
    Database,
    SyntheticPostgrestClient,
    malformed_provider_error,
)
from tests.test_platform_billing_readonly_access import subscription_row

no_side_effects = readonly_access.no_side_effects

GET = "get_belt_test_recipient_v1"
DETAIL = RECIPIENTS_PATH + f"/{RECIPIENT}"
PARAMS = {
    "p_studio_id": STUDIO,
    "p_actor_id": ACTOR,
    "p_event_id": EVENT,
    "p_recipient_id": RECIPIENT,
}
CURRENT = {**ROW, "revision": 3, "updated_at": "2020-10-04T12:00:00Z"}
NULLABLE = {
    "student_program_membership_id",
    "approved_current_rank_id",
    "approved_by",
    "revoked_at",
}


@pytest.fixture
def database():
    database = Database()
    database.handlers[GET] = {"payload": deepcopy(CURRENT)}
    database.tables["studio_subscriptions"] = [subscription_row(studio_id=STUDIO)]
    return database


@pytest.fixture
def api(monkeypatch, database, no_side_effects):
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
        yield SimpleNamespace(client=client, database=database, lane_calls=lane_calls, app=app)
    for query in database.query_log:
        assert query["insert"] is query["update"] is query["upsert"] is None
        assert query["delete"] is False


def assert_one_read(database):
    assert database.rpc_calls == [(GET, PARAMS)]
    assert database.execute_calls == [GET]


@pytest.mark.parametrize("ids", [str, UUID])
def test_service_returns_exact_current_typed_record_once(database, ids):
    result = BeltTestRecipientService(database).get_recipient(
        *(ids(value) for value in [STUDIO, ACTOR, EVENT, RECIPIENT])
    )
    assert isinstance(result, BeltTestRecipientResponse)
    assert result.model_dump(mode="json") == CURRENT
    assert_one_read(database)
    assert database.query_log == []


def test_original_revoke_receipt_remains_history_after_current_reapproval(database):
    operation_rpc = "get_automation_operation_v1"
    revoked = {**ROW, "state": "revoked", "revoked_at": "2020-10-03T12:00:00Z"}
    original = {
        "operation_id": OPERATION,
        "state": "committed",
        "command": "belt_test.revoke",
        "entity_type": "belt_test_recipient",
        "entity_id": RECIPIENT,
        "result": revoked,
        "committed_at": revoked["revoked_at"],
    }
    database.handlers[operation_rpc] = {"payload": deepcopy(original)}
    receipt = WorkflowManagementService(database).operation(STUDIO, ACTOR, UUID(OPERATION), "admin")
    current = BeltTestRecipientService(database).get_recipient(STUDIO, ACTOR, EVENT, RECIPIENT)
    assert receipt.model_dump(mode="json") == original
    assert current.model_dump(mode="json") == CURRENT
    assert current.revision > receipt.result.revision
    assert database.handlers[operation_rpc] == {"payload": original}
    assert database.rpc_calls[-1] == (GET, PARAMS)
    assert database.execute_calls == [operation_rpc, GET]
    assert database.query_log == []


@pytest.mark.parametrize("state", ["approved", "revoked"])
@pytest.mark.parametrize("event_status", ["draft", "scheduled", "completed", "canceled"])
@pytest.mark.parametrize("null_context", [False, True])
def test_http_reads_history_without_querying_event_or_logical_context(
    api, state, event_status, null_context
):
    row = {**CURRENT, "state": state}
    if state == "revoked":
        row["revoked_at"] = "2020-10-03T12:00:00Z"
    if null_context:
        row.update(dict.fromkeys(NULLABLE - {"revoked_at"}))
    api.database.tables["belt_test_events"] = [{"id": EVENT, "status": event_status}]
    for table in ["student_program_memberships", "ranks", "programs"]:
        api.database.tables[table] = []
    api.database.handlers[GET] = {"payload": row}
    response = api.client.get(DETAIL, headers={"X-Studio-Id": f" {STUDIO} "})
    assert response.status_code == 200
    assert response.json() == row
    assert api.lane_calls == ["interactive"]
    assert_one_read(api.database)
    assert {query["table"] for query in api.database.query_log} == {
        "staff_roles",
        "studio_subscriptions",
    }


@pytest.mark.parametrize("field", list(ROW))
def test_http_requires_every_complete_payload_field(api, field):
    api.database.handlers[GET]["payload"].pop(field)
    response = api.client.get(DETAIL)
    assert (response.status_code, response.json()) == (503, {"detail": UNAVAILABLE_DETAIL})
    assert_one_read(api.database)


@pytest.mark.parametrize("field", sorted(set(ROW) - NULLABLE))
def test_http_rejects_null_nonnullable_fields(api, field):
    api.database.handlers[GET]["payload"][field] = None
    response = api.client.get(DETAIL)
    assert (response.status_code, response.json()) == (503, {"detail": UNAVAILABLE_DETAIL})
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
        PAGE,
        {"payload": {"items": [], "next_cursor": None, "has_more": False}},
        {"payload": CURRENT, "private_extra": "private"},
        {"payload": CURRENT, "operation_id": OPERATION, "replayed": True},
        *[
            {"payload": {**CURRENT, key: True}}
            for key in ["test_event_id", "eligible", "current_approval", "approval_generation"]
        ],
    ],
)
def test_malformed_envelopes_fail_closed_without_list_or_receipt_fallback(database, envelope):
    database.handlers[GET] = envelope
    with pytest.raises(HTTPException) as error:
        BeltTestRecipientService(database).get_recipient(STUDIO, ACTOR, EVENT, RECIPIENT)
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert_one_read(database)
    assert database.query_log == []


@pytest.mark.parametrize(
    "field,value",
    [
        *[(field, OTHER) for field in ["id", "studio_id", "event_id"]],
        *[
            (field, value)
            for field in ["revision", "approved_schedule_revision"]
            for value in [True, "3", 3.0, 0, MAX_REVISION + 1]
        ],
        ("state", "eligible"),
        ("approved_at", 1604219400),
        ("created_at", "2020-10-01T12:00:00"),
        ("updated_at", "2020-10-01"),
        *[(field, "bad") for field in NULLABLE],
    ],
)
def test_http_rejects_wrong_identity_and_invalid_values(api, field, value):
    api.database.handlers[GET]["payload"][field] = value
    response = api.client.get(DETAIL)
    assert (response.status_code, response.json()) == (503, {"detail": UNAVAILABLE_DETAIL})
    assert_one_read(api.database)


@pytest.mark.parametrize(
    "denial,status",
    [
        ("front_desk", 403),
        ("instructor", 403),
        ("student", 403),
        ("archived", 403),
        ("multiple", 409),
        ("foreign", 403),
        ("none", 404),
    ],
)
def test_current_membership_denial_precedes_entitlement_and_rpc(api, denial, status):
    membership = api.database.tables["staff_roles"][0]
    headers = {}
    if denial in {"front_desk", "instructor", "student"}:
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
    if denial in {"front_desk", "instructor", "student"}:
        assert response.json() == {"detail": ADMIN_REQUIRED_DETAIL}
    assert api.database.rpc_calls == []
    assert {query["table"] for query in api.database.query_log} == {"staff_roles"}


@pytest.mark.parametrize(
    "overrides,status",
    [
        (None, 503),
        ({"current_period_end": None}, 503),
        ({"stripe_subscription_id": None}, 503),
        ({"current_period_end": "2000-01-01T00:00:00+00:00"}, 503),
        ({"status": "canceled"}, 402),
        ({"comped": True, "status": "canceled"}, 200),
        ({"status": "trialing", "trial_end": "2999-01-01T00:00:00+00:00"}, 200),
        ({"status": "trialing", "trial_end": None}, 503),
        ({"status": "trialing", "trial_end": "2000-01-01T00:00:00+00:00"}, 402),
        ({"status": "trialing", "comped": True, "trial_end": "invalid"}, 402),
        ({"comped": "true"}, 503),
    ],
)
def test_actual_read_only_entitlement_blocks_repairs_and_missing_rows(api, overrides, status):
    rows = [subscription_row(studio_id=STUDIO, **overrides)] if overrides is not None else []
    api.database.tables["studio_subscriptions"] = deepcopy(rows)
    response = api.client.get(DETAIL)
    assert response.status_code == status
    assert api.database.tables["studio_subscriptions"] == rows
    if status == 200:
        assert_one_read(api.database)
    else:
        assert api.database.rpc_calls == []
        assert response.json()["detail"]["subscription_required"] is True
        if status == 503:
            assert response.json()["detail"] == {
                **BILLING_STATUS_UNAVAILABLE_DETAIL,
                "subscription_required": True,
            }


def test_entitlement_is_rechecked_after_current_access_changes(api):
    assert api.client.get(DETAIL).status_code == 200
    api.database.tables["studio_subscriptions"][0]["status"] = "canceled"
    assert api.client.get(DETAIL).status_code == 402
    assert_one_read(api.database)


@pytest.mark.parametrize("path", [DETAIL.replace(EVENT, "bad"), RECIPIENTS_PATH + "/bad", None])
def test_invalid_uuid_and_unauthenticated_requests_precede_reads(api, path):
    if path is None:
        api.app.dependency_overrides.pop(get_current_user_id)
    assert api.client.get(path or DETAIL).status_code == (401 if path is None else 422)
    assert api.lane_calls == api.database.query_log == api.database.rpc_calls == []


@pytest.mark.parametrize(
    "code,message,status",
    [
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403),
        ("P0002", "AUTOMATION_NOT_FOUND", 404),
        ("22023", "AUTOMATION_INVALID_REQUEST", 422),
        ("P0001", "AUTOMATION_STUDIO_BUSY", 409),
        ("PGRST202", "private missing function", 503),
        ("42883", "private missing function", 503),
        ("42501", "private permission", 503),
        ("XX000", "AUTOMATION_NOT_FOUND", 503),
    ],
)
def test_http_maps_owned_sql_errors_without_fallback(api, code, message, status):
    api.database.handlers[GET] = APIError({"code": code, "message": message, "details": "private"})
    response = api.client.get(DETAIL)
    assert response.status_code == status
    assert "private" not in response.text
    if status == 503:
        assert response.json() == {"detail": UNAVAILABLE_DETAIL}
    assert_one_read(api.database)


@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_ERROR_IDENTITIES)
def test_pinned_sdk_malformed_errors_are_sanitized_without_retry(field, identity):
    requests = []

    def transport(request):
        requests.append(request)
        return httpx.Response(503, json=malformed_provider_error(field, identity))

    with SyntheticPostgrestClient(transport) as database, pytest.raises(HTTPException) as error:
        BeltTestRecipientService(database).get_recipient(STUDIO, ACTOR, EVENT, RECIPIENT)
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None and error.value.__suppress_context__ is True
    assert isinstance(error.value.__context__, APIError)
    assert len(requests) == 1
    assert json.loads(requests[0].content) == PARAMS


@pytest.mark.parametrize(
    "failure",
    [httpx.ReadTimeout("private"), RuntimeError("private"), HTTPException(400, "private")],
)
def test_http_provider_failure_is_fixed_503_without_retry(api, failure):
    api.database.handlers[GET] = failure
    response = api.client.get(DETAIL)
    assert (response.status_code, response.json()) == (503, {"detail": UNAVAILABLE_DETAIL})
    assert_one_read(api.database)


def test_exact_child_absence_is_distinct_from_missing_receipt_and_empty_page(database):
    database.handlers["get_automation_operation_v1"] = APIError(
        {"code": "P0002", "message": "AUTOMATION_NOT_FOUND"}
    )
    with pytest.raises(HTTPException) as missing_receipt:
        WorkflowManagementService(database).operation(STUDIO, ACTOR, UUID(OPERATION), "admin")
    assert missing_receipt.value.status_code == 404
    database.handlers["list_belt_test_recipients_v1"] = {
        "payload": {"items": [], "next_cursor": None, "has_more": False}
    }
    service = BeltTestRecipientService(database)
    assert service.list_recipients(STUDIO, ACTOR, EVENT).items == []
    assert service.get_recipient(STUDIO, ACTOR, EVENT, RECIPIENT).revision == 3
    database.handlers[GET] = APIError({"code": "P0002", "message": "AUTOMATION_NOT_FOUND"})
    with pytest.raises(HTTPException) as error:
        service.get_recipient(STUDIO, ACTOR, EVENT, RECIPIENT)
    assert error.value.status_code == 404
    assert database.execute_calls == [
        "get_automation_operation_v1",
        "list_belt_test_recipients_v1",
        GET,
        GET,
    ]


def test_actual_http_handler_uses_pinned_sdk_for_membership_entitlement_and_exact_rpc(api):
    assert version("postgrest") == "0.17.2"
    requests = []

    def transport(request):
        requests.append(request)
        if request.url.path == "/rest/v1/staff_roles":
            assert request.method == "GET" and request.url.params["user_id"] == f"eq.{ACTOR}"
            return httpx.Response(200, json=api.database.tables["staff_roles"])
        if request.url.path == "/rest/v1/studio_subscriptions":
            assert request.method == "GET" and request.url.params["studio_id"] == f"eq.{STUDIO}"
            return httpx.Response(200, json=api.database.tables["studio_subscriptions"][0])
        assert request.method == "POST" and request.url.path == f"/rest/v1/rpc/{GET}"
        assert json.loads(request.content) == PARAMS
        return httpx.Response(200, json={"payload": CURRENT})

    with SyntheticPostgrestClient(transport) as database:
        api.app.dependency_overrides[get_supabase] = lambda: database
        response = api.client.get(DETAIL, headers={"X-Studio-Id": STUDIO})
    assert (response.status_code, response.json()) == (200, CURRENT)
    assert len(requests) == 3
    assert api.lane_calls == ["interactive"]


@pytest.mark.parametrize("method,path,body,rpc", ROUTE_CASES)
def test_existing_routes_keep_exact_default_entitlement_call(
    api, monkeypatch, method, path, body, rpc
):
    ensure = Mock()
    monkeypatch.setattr(routes, "ensure_platform_subscription_access", ensure)
    response = api.client.request(method, path, json=body)
    assert response.status_code == 200
    ensure.assert_called_once_with(api.database, STUDIO)
    assert api.database.execute_calls == [rpc]


def test_detail_openapi_reuses_complete_dto_with_identity_only(api):
    path = BASE + "/{event_id}/recipients/{recipient_id}"
    contract = api.app.openapi()["paths"][path]
    assert set(contract) == {"get"}
    detail = contract["get"]
    assert "requestBody" not in detail
    assert not [param for param in detail["parameters"] if param["in"] == "query"]
    assert {param["name"] for param in detail["parameters"] if param["in"] == "path"} == {
        "event_id",
        "recipient_id",
    }
    assert detail["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/BeltTestRecipientResponse"
    }
    assert len(routes.detail_router.routes) == 1


def test_composed_app_retains_existing_recipient_routes_without_detail_mount():
    base = BASE + "/{event_id}/recipients"
    expected = {
        (base, "GET"): routes.list_belt_test_recipients,
        (base + "/approve", "POST"): routes.approve_belt_test_recipients,
        (base + "/{recipient_id}/revoke", "POST"): routes.revoke_belt_test_recipient,
    }
    actual = [
        (route.path, method, route.endpoint)
        for route in iter_route_contexts(composed_app.routes)
        if route.path.startswith(base)
        for method in route.methods or set()
    ]
    assert len(actual) == len(expected)
    assert {(path, method): handler for path, method, handler in actual} == expected
    assert base + "/{recipient_id}" not in composed_app.openapi()["paths"]
