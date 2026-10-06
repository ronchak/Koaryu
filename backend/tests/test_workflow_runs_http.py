"""Run route wiring, actual scope guards, and mocked provider data."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.endpoints import workflow_management
from app.api.v1.endpoints import workflow_runs as routes
from app.core.deps import get_current_user_id, get_supabase
from app.core.error_handlers import register_error_handlers
from app.services import workflow_management_service
from app.services.platform_billing_service import PlatformBillingService
from tests.test_workflow_runs import (
    ACTOR,
    ATTEMPT_ROW,
    CANCEL_RPC,
    CANCELLED,
    DETAIL,
    GET_RPC,
    INSTANT,
    LIST_RPC,
    OPERATION,
    OPERATION_RPC,
    OTHER,
    PAGE,
    REQUEST,
    RUN,
    STEP_ROW,
    STUDIO,
    SUMMARY,
    WORKFLOW,
    SyntheticPostgrestClient,
    database,
)

BASE = "/api/v1/automations"
ROUTES = [
    ("GET", f"/workflows/{WORKFLOW}/runs", None, LIST_RPC),
    ("GET", f"/runs/{RUN}", None, GET_RPC),
    ("POST", f"/runs/{RUN}/cancel", REQUEST, CANCEL_RPC),
]


@pytest.fixture
def api(monkeypatch):
    db = database()
    # Leave ensure_platform_subscription_access and its entitlement decision real.
    # Only the billing provider read is synthetic, so no Stripe access occurs.
    subscription_row = Mock(return_value={"status": "active", "comped": False})
    monkeypatch.setattr(PlatformBillingService, "get_access_status_row", subscription_row)
    capabilities = Mock(
        side_effect=AssertionError("Run reads/cancel cannot query sender capability")
    )
    monkeypatch.setattr(workflow_management_service, "resolve_workflow_capabilities", capabilities)
    lanes = []
    original_run = routes.run_supabase_operation

    async def tracked_run(provider, operation, *, lane):
        lanes.append(lane)
        return await original_run(provider, operation, lane=lane)

    monkeypatch.setattr(routes, "run_supabase_operation", tracked_run)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.include_router(workflow_management.router, prefix="/api/v1")
    register_error_handlers(app)
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: db
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            app=app,
            db=db,
            subscription_row=subscription_row,
            capabilities=capabilities,
            lanes=lanes,
        )


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
def test_each_route_uses_actual_authority_and_one_interactive_rpc(api, method, path, body, rpc):
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {LIST_RPC: PAGE, GET_RPC: DETAIL, CANCEL_RPC: CANCELLED}[rpc]
    assert api.lanes == ["interactive"]
    assert api.db.execute_calls == [rpc]
    assert api.db.rpc_calls[0][1]["p_studio_id"] == STUDIO
    assert api.db.rpc_calls[0][1]["p_actor_id"] == ACTOR
    assert api.subscription_row.call_args.args == (STUDIO,)
    assert {entry["table"] for entry in api.db.query_log} == {"staff_roles"}
    api.capabilities.assert_not_called()


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
@pytest.mark.parametrize("role", ["front_desk", "instructor", "student", None])
def test_current_nonadmin_roles_fail_before_entitlement_or_rpc(api, method, path, body, rpc, role):
    api.db.tables["staff_roles"][0]["role"] = role
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 403
    assert not api.db.rpc_calls
    api.subscription_row.assert_not_called()


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
@pytest.mark.parametrize("case", ["archived", "missing", "foreign_studio", "other_actor"])
def test_current_membership_and_tenant_selection_fail_closed(api, method, path, body, rpc, case):
    headers = {}
    if case == "archived":
        api.db.tables["staff_roles"][0]["archived_at"] = INSTANT
    elif case == "missing":
        api.db.tables["staff_roles"] = []
    elif case == "foreign_studio":
        headers = {"X-Studio-Id": OTHER}
    else:
        api.db.tables["staff_roles"][0]["user_id"] = OTHER
    response = api.client.request(method, BASE + path, json=body, headers=headers)
    assert response.status_code == (404 if case in {"missing", "other_actor"} else 403)
    assert not api.db.rpc_calls
    api.subscription_row.assert_not_called()


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
@pytest.mark.parametrize(
    "row,allowed",
    [
        ({"status": "active", "comped": False}, True),
        ({"status": "canceled", "comped": True}, True),
        ({"status": "past_due", "comped": False}, False),
        ({"status": "trialing", "trial_end": INSTANT, "comped": False}, False),
    ],
)
def test_actual_entitlement_decision(api, method, path, body, rpc, row, allowed):
    api.subscription_row.return_value = row
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == (200 if allowed else 402), response.text
    assert api.db.execute_calls == ([rpc] if allowed else [])
    if not allowed:
        assert response.json()["detail"]["code"] == "SUBSCRIPTION_REQUIRED"


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
def test_unknown_entitlement_fails_before_run_rpc(api, method, path, body, rpc):
    api.subscription_row.side_effect = RuntimeError("private billing failure")
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 503
    assert "private" not in response.text
    assert not api.db.rpc_calls


@pytest.mark.parametrize(
    "method,path,body,rpc", ROUTES + [("GET", f"/operations/{OPERATION}", None, OPERATION_RPC)]
)
def test_disabled_sender_and_worker_do_not_block_history_cancel_or_receipt(
    api, monkeypatch, method, path, body, rpc
):
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "AUTOMATION_WORKER_ENABLED", False)
    monkeypatch.setattr(settings, "EMAIL_PROVIDER", "disabled")
    monkeypatch.setattr(settings, "EMAIL_SEND_ENABLED", False)
    response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 200, response.text
    assert api.db.execute_calls == [rpc]
    api.capabilities.assert_not_called()


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"operation_id": OPERATION},
        {"expected_revision": 8},
        {**REQUEST, "expected_revision": True},
        {**REQUEST, "expected_revision": "8"},
        {**REQUEST, "reason": "private"},
        {**REQUEST, "p_actor_id": OTHER},
    ],
)
def test_cancel_only_accepts_exact_operation_and_original_revision(api, body):
    response = api.client.post(BASE + f"/runs/{RUN}/cancel", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert all("input" not in item for item in response.json()["detail"])
    assert not api.db.rpc_calls


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("GET", "/runs/invalid", None),
        ("POST", "/runs/invalid/cancel", REQUEST),
        ("GET", "/workflows/invalid/runs", None),
        ("GET", f"/workflows/{WORKFLOW}/runs?limit=0", None),
        ("GET", f"/workflows/{WORKFLOW}/runs?limit=101", None),
        ("GET", f"/workflows/{WORKFLOW}/runs?cursor=invalid", None),
    ],
)
def test_route_ids_limits_and_cursors_rejected_before_rpc(api, method, path, body):
    assert api.client.request(method, BASE + path, json=body).status_code == 422
    assert not api.db.rpc_calls


@pytest.mark.parametrize("method,path,body,rpc", ROUTES)
def test_actual_http_and_pinned_sdk_reject_malformed_success_once(api, method, path, body, rpc):
    payload = deepcopy(api.db.handlers[rpc])
    if rpc == LIST_RPC:
        payload["payload"]["items"][0]["studio_id"] = OTHER
    else:
        payload["payload"]["run"]["id"] = OTHER
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=payload)

    with SyntheticPostgrestClient(handler) as provider:
        # Membership uses the table fake; the RPC uses the pinned SDK transport.
        provider.table = api.db.table
        api.app.dependency_overrides[get_supabase] = lambda: provider
        response = api.client.request(method, BASE + path, json=body)
    assert response.status_code == 503
    assert len(calls) == 1 and calls[0].url.path.endswith(rpc)
    assert "private" not in response.text


def test_front_desk_denied_cancel_receipt_even_with_faulty_sql_success(api):
    api.db.tables["staff_roles"][0]["role"] = "front_desk"
    response = api.client.get(BASE + f"/operations/{OPERATION}")
    assert response.status_code == 403
    assert api.db.execute_calls == [OPERATION_RPC]


def test_lost_cancel_response_then_receipt_and_current_get_are_distinct(api, monkeypatch):
    async def lose_response(provider, operation, *, lane):
        operation(provider)
        raise HTTPException(504, "Shared provider operation timeout")

    monkeypatch.setattr(routes, "run_supabase_operation", lose_response)
    response = api.client.post(BASE + f"/runs/{RUN}/cancel", json=REQUEST)
    assert response.status_code == 504
    assert api.db.execute_calls == [CANCEL_RPC]
    response = api.client.get(BASE + f"/operations/{OPERATION}")
    assert response.status_code == 200 and response.json()["result"] == CANCELLED
    assert api.db.execute_calls == [CANCEL_RPC, OPERATION_RPC]
    monkeypatch.setattr(
        routes, "run_supabase_operation", workflow_management.run_supabase_operation
    )
    current = deepcopy(CANCELLED)
    current["run"].update(state="unknown", revision=12)
    api.db.handlers[GET_RPC] = {"payload": current}
    response = api.client.get(BASE + f"/runs/{RUN}")
    assert response.status_code == 200 and response.json() == current


def test_missing_receipt_never_causes_a_cancel_retry(api):
    from postgrest.exceptions import APIError

    api.db.handlers[CANCEL_RPC] = RuntimeError("private lost response")
    api.db.handlers[OPERATION_RPC] = APIError(
        {
            "code": "P0002",
            "message": "AUTOMATION_NOT_FOUND",
            "details": "private",
            "hint": "private",
        }
    )
    assert api.client.post(BASE + f"/runs/{RUN}/cancel", json=REQUEST).status_code == 503
    assert api.client.get(BASE + f"/operations/{OPERATION}").status_code == 404
    assert api.db.execute_calls == [CANCEL_RPC, OPERATION_RPC]


def test_isolated_openapi_has_exact_routes_and_composed_receipt_union(api):
    document = api.app.openapi()
    for path, method, model in [
        ("/workflows/{workflow_id}/runs", "get", "WorkflowRunListResponse"),
        ("/runs/{run_id}", "get", "WorkflowRunDetail"),
        ("/runs/{run_id}/cancel", "post", "WorkflowRunDetail"),
    ]:
        operation = document["paths"][BASE + path][method]
        assert operation["responses"]["200"]["content"]["application/json"]["schema"][
            "$ref"
        ].endswith("/" + model)
    cancel = document["paths"][BASE + "/runs/{run_id}/cancel"]["post"]
    assert cancel["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "/WorkflowRunCancelRequest"
    )
    schemas = document["components"]["schemas"]
    for name, payload in [
        ("WorkflowRunSummary", SUMMARY),
        ("WorkflowRunStep", STEP_ROW),
        ("WorkflowEmailAttemptSummary", ATTEMPT_ROW),
        ("WorkflowRunDetail", DETAIL),
        ("WorkflowRunListResponse", PAGE),
        ("WorkflowRunCancelRequest", REQUEST),
    ]:
        assert schemas[name]["additionalProperties"] is False
        assert set(schemas[name]["required"]) == set(payload)
    operation = document["paths"][BASE + "/operations/{operation_id}"]["get"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]
    assert operation["discriminator"]["mapping"]["run.cancel"].endswith(
        "/RunCancelOperationResponse"
    )
    assert len(operation["oneOf"]) == 8


def test_history_routes_are_registered_once_on_actual_app():
    from fastapi.routing import iter_route_contexts

    from app.main import app

    paths = app.openapi()["paths"]
    for path, method, handler, model in [
        (
            "/workflows/{workflow_id}/runs",
            "get",
            routes.list_workflow_runs,
            "WorkflowRunListResponse",
        ),
        ("/runs/{run_id}", "get", routes.get_workflow_run, "WorkflowRunDetail"),
        ("/runs/{run_id}/cancel", "post", routes.cancel_workflow_run, "WorkflowRunDetail"),
    ]:
        path = BASE + path
        assert set(paths[path]) == {method}
        matches = [
            route
            for route in iter_route_contexts(app.routes)
            if route.path == path and method.upper() in route.methods
        ]
        assert len(matches) == 1
        assert matches[0].endpoint is handler
        assert paths[path][method]["responses"]["200"]["content"]["application/json"]["schema"] == {
            "$ref": f"#/components/schemas/{model}"
        }
    cancel = paths[BASE + "/runs/{run_id}/cancel"]["post"]
    assert cancel["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/WorkflowRunCancelRequest"
    }
    schemas = app.openapi()["components"]["schemas"]
    assert "RunCancelOperationResponse" in schemas
    assert "WorkflowRunCancelRequest" in schemas
    assert "WorkflowRunListResponse" in schemas
