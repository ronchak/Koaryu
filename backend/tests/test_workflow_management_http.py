"""HTTP proofs with real role resolution and normal error handlers, synthetic providers only."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.endpoints import workflow_management as routes
from app.core.deps import get_current_user_id, get_supabase
from app.core.error_handlers import register_error_handlers
from app.core.request_body_limits import DEFAULT_API_REQUEST_MAX_BYTES, RequestBodyLimitMiddleware
from app.schemas.workflow_management import REQUEST_TOO_LARGE_DETAIL
from app.services import workflow_management_service as boundary
from tests.test_workflow_management import (
    ACTOR,
    COMMAND,
    COMMAND_RPC,
    CREATE,
    CREATE_RPC,
    GET_RPC,
    GRAPH,
    INSTANT,
    LIST_RPC,
    OPERATION,
    OPERATION_RPC,
    OTHER,
    PUBLISHED,
    READY,
    ROW,
    RPCS,
    SAVE,
    SAVE_RPC,
    STUDIO,
    VALIDATE_RPC,
    WORKFLOW,
    Database,
    SyntheticPostgrestClient,
    domain_receipts,
    huge_safe_draft,
    invoke,
    mutation,
    nul_workflow_body,
)

BASE = "/api/v1/automations"
ROUTES = [
    ("GET", "/catalog", None, None),
    ("GET", "/workflows", None, LIST_RPC),
    ("POST", "/workflows", CREATE, CREATE_RPC),
    ("POST", "/workflows/validate", {"graph": GRAPH}, VALIDATE_RPC),
    ("GET", f"/workflows/{WORKFLOW}", None, GET_RPC),
    ("PUT", f"/workflows/{WORKFLOW}", SAVE, SAVE_RPC),
    *[
        ("POST", f"/workflows/{WORKFLOW}/{action}", COMMAND, COMMAND_RPC)
        for action in ["publish", "start", "pause", "archive"]
    ],
    ("GET", f"/operations/{OPERATION}", None, OPERATION_RPC),
]


@pytest.fixture
def api(monkeypatch):
    database = Database()
    subscription = Mock()
    capability = Mock(return_value=deepcopy(READY))
    settings = Mock(return_value=SimpleNamespace(AUTOMATION_WORKER_ENABLED=True))
    monkeypatch.setattr(routes, "ensure_platform_subscription_access", subscription)
    monkeypatch.setattr(routes, "get_settings", settings)
    monkeypatch.setattr(boundary, "resolve_workflow_capabilities", capability)
    lane_calls = []
    original_run = routes.run_supabase_operation

    async def tracked_run(provider, operation, *, lane):
        lane_calls.append(lane)
        return await original_run(provider, operation, lane=lane)

    monkeypatch.setattr(routes, "run_supabase_operation", tracked_run)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    register_error_handlers(app)
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            database=database,
            subscription=subscription,
            capability=capability,
            settings=settings,
            lanes=lane_calls,
            app=app,
        )


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
def test_every_public_route_uses_one_authorized_interactive_operation(api, method, path, body, rpc):
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == (201 if rpc == CREATE_RPC else 200), response.text
    assert api.lanes == ["interactive"]
    api.subscription.assert_called_once_with(api.database, STUDIO)
    if rpc:
        assert api.database.execute_calls == [rpc]
        assert api.database.rpc_calls[0][1]["p_studio_id"] == STUDIO
        assert api.database.rpc_calls[0][1]["p_actor_id"] == ACTOR
    else:
        assert api.database.execute_calls == []
    if method in {"POST", "PUT"} and rpc != VALIDATE_RPC:
        assert set(response.json()) == set(ROW)
        assert "value" not in response.json()["draft_graph"]["nodes"][1]["config"]
    if rpc == VALIDATE_RPC:
        assert response.json()["valid"] is False
    assert all(entry["table"] == "staff_roles" for entry in api.database.query_log)


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
@pytest.mark.parametrize("role", ["front_desk", "instructor", "student", None])
def test_current_role_blocks_management_before_subscription_metadata_or_rpc(
    api, method, path, body, rpc, role
):
    if rpc == OPERATION_RPC and role == "front_desk":
        return  # Covered with the SQL-owned command-aware exception below.
    api.database.tables["staff_roles"][0]["role"] = role
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 403
    assert api.database.rpc_calls == []
    api.subscription.assert_not_called()
    api.capability.assert_not_called()
    api.settings.assert_not_called()


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
@pytest.mark.parametrize("membership", ["archived", "absent", "foreign_actor", "foreign_studio"])
def test_real_resolver_rejects_absent_archived_or_foreign_membership(
    api, method, path, body, rpc, membership
):
    headers = {}
    if membership == "absent":
        api.database.tables["staff_roles"].clear()
    elif membership == "archived":
        api.database.tables["staff_roles"][0]["archived_at"] = INSTANT
    elif membership == "foreign_actor":
        api.database.tables["staff_roles"][0]["user_id"] = OTHER
    else:
        headers["X-Studio-Id"] = OTHER
    response = api.client.request(method, BASE + path, json=body, headers=headers)
    assert response.status_code == (404 if membership in {"absent", "foreign_actor"} else 403)
    assert not api.database.rpc_calls
    api.capability.assert_not_called()
    api.subscription.assert_not_called()


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
def test_current_entitlement_is_required_before_capability_or_rpc(api, method, path, body, rpc):
    api.subscription.side_effect = HTTPException(403, "Studio access unavailable.")
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 403
    assert not api.database.rpc_calls
    api.capability.assert_not_called()
    api.settings.assert_not_called()


def test_front_desk_can_read_sql_authorized_own_lead_create_without_assignee_inference(api):
    api.database.tables["staff_roles"][0]["role"] = "front_desk"
    receipt = domain_receipts()["lead.create"]
    receipt["payload"]["result"]["assigned_staff_id"] = OTHER
    api.database.handlers[OPERATION_RPC] = receipt
    response = api.client.get(BASE + f"/operations/{OPERATION}")
    assert response.status_code == 200
    assert response.json()["command"] == "lead.create"
    assert response.json()["result"]["assigned_staff_id"] == OTHER
    assert api.database.execute_calls == [OPERATION_RPC]
    api.subscription.assert_called_once_with(api.database, STUDIO)


@pytest.mark.parametrize("command", [key for key in domain_receipts() if key != "lead.create"])
def test_front_desk_cannot_receive_other_command_even_if_sql_returns_it(api, command):
    api.database.tables["staff_roles"][0]["role"] = "front_desk"
    api.database.handlers[OPERATION_RPC] = domain_receipts()[command]
    response = api.client.get(BASE + f"/operations/{OPERATION}")
    assert response.status_code == 403
    assert response.json()["detail"] == boundary.RECEIPT_REQUIRED_DETAIL
    assert api.database.execute_calls == [OPERATION_RPC]


def test_sql_denial_for_another_actors_lead_receipt_is_retained(api):
    from postgrest.exceptions import APIError

    api.database.tables["staff_roles"][0]["role"] = "front_desk"
    api.database.handlers[OPERATION_RPC] = APIError(
        {
            "code": "42501",
            "message": "AUTOMATION_ADMIN_REQUIRED",
            "details": "private",
            "hint": "private",
        }
    )
    response = api.client.get(BASE + f"/operations/{OPERATION}")
    assert response.status_code == 403
    assert api.database.execute_calls == [OPERATION_RPC]


@pytest.mark.parametrize("method,path,body,rpc", [case for case in ROUTES if case[2] is not None])
def test_unknown_fields_produce_normalized_validation_errors_without_input(
    api, method, path, body, rpc
):
    response = api.client.request(method, BASE + path, json={**body, "p_start_replay_only": True})
    assert response.status_code == 422
    payload = response.json()
    assert payload["error"] == {"code": "validation_error", "status_code": 422}
    assert all("input" not in issue for issue in payload["detail"])
    assert not api.database.rpc_calls


@pytest.mark.parametrize(
    "path,body",
    [
        ("/workflows", CREATE),
        (f"/workflows/{WORKFLOW}/start", COMMAND),
        (f"/workflows/{WORKFLOW}/pause", COMMAND),
        (f"/workflows/{WORKFLOW}/archive", COMMAND),
    ],
)
def test_cancel_pending_is_rejected_outside_publish(api, path, body):
    response = api.client.post(BASE + path, json={**body, "cancel_pending": False})
    assert response.status_code == 422 and not api.database.rpc_calls


def test_publish_boolean_and_server_only_start_mode(api):
    response = api.client.post(
        BASE + f"/workflows/{WORKFLOW}/publish", json={**COMMAND, "cancel_pending": True}
    )
    assert response.status_code == 200
    assert api.database.rpc_calls[0][1]["p_cancel_pending"] is True
    api.capability.return_value["capabilities"].update(
        can_start=False, disabled_reason="Workflow scheduling is disabled."
    )
    api.database.handlers[COMMAND_RPC] = mutation({**PUBLISHED, "status": "active"}, True)
    response = api.client.post(BASE + f"/workflows/{WORKFLOW}/start", json=COMMAND)
    assert response.status_code == 200 and response.json()["revision"] == 9
    assert api.database.rpc_calls[-1][1]["p_start_replay_only"] is True
    assert "p_start_replay_only" not in response.json()


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/workflows", CREATE),
        ("PUT", f"/workflows/{WORKFLOW}", SAVE),
        ("POST", "/workflows/validate", {"graph": GRAPH}),
    ],
)
@pytest.mark.parametrize("contains_nul", [False, True])
def test_oversized_request_has_fixed_small_422_before_nested_validation_or_rpc(
    api, monkeypatch, method, path, body, contains_nul
):
    from app.schemas import workflow_management

    nested = Mock(side_effect=AssertionError("Must not validate nested draft"))
    monkeypatch.setattr(workflow_management, "validate_workflow_draft", nested)
    payload = {**body, "graph": huge_safe_draft()}
    if contains_nul:
        payload["A\x00B"] = None
    response = api.client.request(method, BASE + path, json=payload)
    assert response.status_code == 422
    assert response.json() == {
        "detail": REQUEST_TOO_LARGE_DETAIL,
        "error": {"code": "validation_error", "status_code": 422},
    }
    assert len(response.content) < 200
    assert not api.database.rpc_calls
    assert api.database.query_log == [] and api.lanes == []
    nested.assert_not_called()


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/workflows", CREATE),
        ("PUT", f"/workflows/{WORKFLOW}", SAVE),
        ("POST", "/workflows/validate", {"graph": GRAPH}),
    ],
)
@pytest.mark.parametrize("location", ["name", "description", "graph_value", "graph_key"])
def test_raw_escaped_nul_rejects_before_membership_entitlement_or_capacity(
    api, method, path, body, location
):
    raw = json.dumps(nul_workflow_body(body, location)).encode("utf-8")
    assert b"\\u0000" in raw and b"\x00" not in raw
    response = api.client.request(
        method, BASE + path, content=raw, headers={"content-type": "application/json"}
    )
    assert response.status_code == 422 and response.json()["detail"] == "Invalid workflow request."
    assert api.database.query_log == [] and api.database.rpc_calls == [] and api.lanes == []
    api.subscription.assert_not_called()
    api.capability.assert_not_called()


@pytest.mark.parametrize("text,valid", [(r"A\u0000B", True), ("A\x01B", False)])
def test_representable_validation_graphs_reach_semantics_unchanged(api, text, valid):
    from app.services.workflow_catalog import build_preset

    graph = build_preset("welcome")
    graph["nodes"][1]["config"]["body_template"] = text
    response = api.client.post(BASE + "/workflows/validate", json={"graph": graph})
    assert response.status_code == 200 and response.json()["valid"] is valid
    assert api.database.rpc_calls[0][1]["p_graph"] == graph
    assert api.lanes == ["interactive"]


def test_raw_body_413_middleware_is_unchanged_and_separate(api):
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    register_error_handlers(app)
    app.add_middleware(RequestBodyLimitMiddleware, api_v1_prefix="/api/v1")
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: api.database
    with TestClient(app) as client:
        response = client.post(
            BASE + "/workflows/validate",
            content=b" " * (DEFAULT_API_REQUEST_MAX_BYTES + 1),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 413
    assert response.json()["detail"] == "Request body is too large."
    assert not api.database.rpc_calls


def test_large_retained_draft_reads_over_http_without_request_ceiling(api):
    api.database.handlers[GET_RPC] = {"payload": {**ROW, "draft_graph": huge_safe_draft()}}
    response = api.client.get(BASE + f"/workflows/{WORKFLOW}")
    assert response.status_code == 200
    assert len(response.content) > 8_000_000
    assert len(response.json()["draft_graph"]["nodes"]) == 40


@pytest.mark.parametrize("body", [{}, [], {"graph": GRAPH, "actor_id": ACTOR}])
def test_invalid_validation_envelopes_are_422(api, body):
    response = api.client.post(BASE + "/workflows/validate", json=body)
    assert response.status_code == 422 and not api.database.rpc_calls


def test_invalid_graph_still_checks_current_sql_authority(api):
    response = api.client.post(BASE + "/workflows/validate", json={"graph": {"nodes": "bad"}})
    assert response.status_code == 200
    assert response.json()["valid"] is False
    assert api.database.execute_calls == [VALIDATE_RPC]
    api.subscription.assert_called_once_with(api.database, STUDIO)


@pytest.mark.parametrize("path", ["/workflows/not-a-uuid", "/operations/not-a-uuid"])
def test_path_uuid_validation_before_rpc(api, path):
    response = api.client.get(BASE + path)
    assert response.status_code == 422 and not api.database.rpc_calls


@pytest.mark.parametrize(
    "query", ["limit=0", "limit=101", "limit=true", "limit=1.5", "cursor=", "cursor=" + "x" * 513]
)
def test_list_query_bounds(api, query):
    response = api.client.get(BASE + "/workflows?" + query)
    assert response.status_code == 422 and not api.database.rpc_calls


def test_openapi_exposes_typed_receipt_variants_and_exact_requests(api):
    document = api.client.get("/openapi.json").json()
    operation = document["paths"][BASE + "/operations/{operation_id}"]["get"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]
    assert operation["discriminator"]["propertyName"] == "command"
    assert set(operation["discriminator"]["mapping"]) == set(domain_receipts()) | {
        "run.cancel",
        "test_email.create",
    }
    assert len(operation["oneOf"]) == 8
    schemas = document["components"]["schemas"]
    metadata = schemas["WorkflowFieldMetadata"]
    assert set(metadata["properties"]) == {
        "id",
        "label",
        "value_type",
        "operators",
        "nullable",
        "values",
    }
    assert metadata["properties"]["values"]["type"] == "array"
    assert metadata["properties"]["values"]["items"]["type"] == "string"
    assert "values" not in metadata["required"]
    assert metadata["properties"]["nullable"]["type"] == "boolean"
    assert metadata["properties"]["value_type"]["enum"] == ["boolean", "enum", "uuid"]
    assert metadata["additionalProperties"] is False
    for name in [
        "WorkflowCreate",
        "WorkflowSave",
        "WorkflowPublish",
        "WorkflowLifecycleRequest",
        "WorkflowValidate",
    ]:
        assert schemas[name]["additionalProperties"] is False
        assert "p_start_replay_only" not in schemas[name]["properties"]


@pytest.mark.parametrize("rpc", RPCS)
def test_pinned_sdk_malformed_success_facts_fail_closed_once(rpc):
    fake = Database()
    params = {"p_action": "pause"}
    body = fake.rpc(rpc, params).execute().data
    if rpc == LIST_RPC:
        body["payload"]["items"][0]["id"] = {"private": "invalid UUID"}
    elif rpc == OPERATION_RPC:
        body["payload"]["entity_id"] = None
    elif rpc == VALIDATE_RPC:
        body["payload"]["valid"] = "true"
    else:
        body["payload"]["id"] = OTHER if rpc != CREATE_RPC else "invalid UUID"
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=body)

    with SyntheticPostgrestClient(handler) as provider, pytest.raises(HTTPException) as error:
        invoke(boundary.WorkflowManagementService(provider), rpc)
    assert (error.value.status_code, error.value.detail) == (503, boundary.UNAVAILABLE_DETAIL)
    assert len(calls) == 1


def test_mutation_never_retries_when_interactive_response_is_lost(api, monkeypatch):
    async def lose_response(provider, operation, *, lane):
        operation(provider)
        raise HTTPException(504, "Shared provider operation timeout")

    monkeypatch.setattr(routes, "run_supabase_operation", lose_response)
    response = api.client.post(BASE + "/workflows", json=CREATE)
    assert response.status_code == 504
    assert api.database.execute_calls == [CREATE_RPC]
