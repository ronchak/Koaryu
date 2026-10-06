"""Simulation HTTP proofs using actual membership and read-only entitlement owners."""

import json
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.routing import iter_route_contexts
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.api.v1.endpoints import workflow_simulation as routes
from app.core.deps import get_current_user_id, get_supabase
from app.core.error_handlers import register_error_handlers
from app.core.request_body_limits import DEFAULT_API_REQUEST_MAX_BYTES, RequestBodyLimitMiddleware
from app.services import automation_email, platform_billing_service, studio_scope
from app.services.platform_billing_service import PlatformBillingService
from app.services.workflow_catalog import CATALOG, build_preset
from app.services.workflow_graph import validate_workflow_graph
from app.services.workflow_management_service import UNAVAILABLE_DETAIL
from tests.fakes.supabase import FakeRpcCall, TableBackedSupabase
from tests.test_platform_billing_readonly_access import subscription_row
from tests.test_workflow_management import SyntheticPostgrestClient, huge_safe_draft
from tests.test_workflow_simulation import (
    ACTOR,
    INSTANT,
    ISSUE,
    NUL_LOCATIONS,
    OTHER,
    SIMULATION_RPC,
    STUDIO,
    WORKFLOW,
    envelope,
    request_for,
    request_with_nul,
    wire_facts,
)

BASE = "/api/v1/automations/workflows/" + WORKFLOW + "/simulate"


class SimulationDatabase(TableBackedSupabase):
    def __init__(self):
        super().__init__(
            {
                "staff_roles": [
                    {"user_id": ACTOR, "studio_id": STUDIO, "role": "admin", "archived_at": None}
                ],
                "studio_subscriptions": [subscription_row(studio_id=STUDIO)],
            }
        )
        self.result = envelope()
        self.rpc_calls = []

    def rpc(self, name, params):
        assert name == SIMULATION_RPC
        self.rpc_calls.append((name, deepcopy(params)))

        def execute():
            if isinstance(self.result, Exception):
                raise self.result
            return deepcopy(self.result)

        return FakeRpcCall(execute)


@pytest.fixture
def api(monkeypatch):
    database = SimulationDatabase()
    settings = SimpleNamespace(ENVIRONMENT="production")
    monkeypatch.setattr(platform_billing_service, "get_settings", lambda: settings)
    monkeypatch.setattr(studio_scope, "get_settings", lambda: settings)
    forbidden = Mock(
        side_effect=AssertionError("Preview attempted provider preparation or a repair")
    )
    monkeypatch.setattr(platform_billing_service, "StripeService", forbidden)
    monkeypatch.setattr(automation_email, "build_email_transport", forbidden)
    monkeypatch.setattr(automation_email, "email_delivery_status", forbidden)
    for name in (
        "_ensure_subscription_row",
        "_get_access_status_row_uncoordinated",
        "get_status_sync",
    ):
        monkeypatch.setattr(PlatformBillingService, name, forbidden)
    real_access = PlatformBillingService.get_access_status_row
    access_calls = []

    def access(self, studio_id, **kwargs):
        access_calls.append((studio_id, kwargs))
        return real_access(self, studio_id, **kwargs)

    monkeypatch.setattr(PlatformBillingService, "get_access_status_row", access)
    real_run = routes.run_supabase_operation
    lanes = []

    async def run(provider, operation, *, lane):
        lanes.append(lane)
        return await real_run(provider, operation, lane=lane)

    monkeypatch.setattr(routes, "run_supabase_operation", run)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    register_error_handlers(app)
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client, database=database, app=app, lanes=lanes, access_calls=access_calls
        )
    forbidden.assert_not_called()
    for query in database.query_log:
        assert query["insert"] is None and query["update"] is None and query["upsert"] is None
        assert query["delete"] is False
        assert query["table"] in {"staff_roles", "studio_subscriptions"}
    assert platform_billing_service._access_repair_flights == {}
    assert platform_billing_service._access_repair_retry_after == {}


def post(api, request=None):
    return api.client.post(
        BASE, json=(request if request is not None else request_for()).model_dump(mode="json")
    )


def test_actual_authorization_uses_one_interactive_readonly_operation(api):
    before = deepcopy(api.database.tables)
    response = post(api)
    assert response.status_code == 200, response.text
    assert response.json()["valid"] is True
    assert api.lanes == ["interactive"]
    assert api.access_calls == [
        (STUDIO, {"strict_repairs": True, "allow_provider_repairs": True, "read_only": True})
    ]
    assert [q["table"] for q in api.database.query_log] == ["staff_roles", "studio_subscriptions"]
    assert len(api.database.rpc_calls) == 1
    assert api.database.tables == before


@pytest.mark.parametrize("role", ["front_desk", "instructor", "student", None])
def test_current_role_required_before_entitlement_or_facts(api, role):
    api.database.tables["staff_roles"][0]["role"] = role
    response = post(api)
    assert response.status_code == 403
    assert api.database.rpc_calls == [] and api.access_calls == []


@pytest.mark.parametrize(
    "case,status", [("missing", 404), ("archived", 403), ("ambiguous", 409), ("foreign", 403)]
)
def test_current_unambiguous_studio_scope_is_required(api, case, status):
    roles = api.database.tables["staff_roles"]
    if case == "missing":
        roles.clear()
    elif case == "archived":
        roles[0]["archived_at"] = INSTANT
    elif case == "ambiguous":
        roles.append({**roles[0], "studio_id": OTHER, "archived_at": INSTANT})
    else:
        api.client.cookies.set("koaryu-active-studio", OTHER)
    assert post(api).status_code == status
    assert not api.access_calls and not api.database.rpc_calls


@pytest.mark.parametrize(
    "overrides,status",
    [
        ({"status": "active"}, 200),
        ({"status": "trialing", "trial_end": "2999-01-01T00:00:00Z"}, 200),
        ({"status": "comped", "comped": True}, 200),
        ({"status": "canceled"}, 402),
        ({"status": "past_due"}, 402),
        ({"status": "trialing", "trial_end": "2000-01-01T00:00:00Z"}, 402),
        ({"status": "trialing", "trial_end": None}, 503),
        ({"current_period_end": None}, 503),
        ({"stripe_subscription_id": None}, 503),
        ({"comped": "true"}, 503),
    ],
)
def test_actual_readonly_entitlement_keeps_freshness_and_deny_semantics(api, overrides, status):
    row = api.database.tables["studio_subscriptions"][0]
    row.update(overrides)
    before = deepcopy(api.database.tables)
    response = post(api)
    assert response.status_code == status, response.text
    assert len(api.database.rpc_calls) == (1 if status == 200 else 0)
    assert api.database.tables == before
    assert api.access_calls[0][1]["read_only"] is True


def test_missing_subscription_never_initializes_a_row(api):
    api.database.tables["studio_subscriptions"] = []
    response = post(api)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "BILLING_STATUS_UNAVAILABLE"
    assert not api.database.rpc_calls
    assert api.database.tables["studio_subscriptions"] == []


def test_authentication_dependency_is_real_and_missing_token_is_401(api):
    del api.app.dependency_overrides[get_current_user_id]
    response = post(api)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert api.database.query_log == [] and api.lanes == []


def test_sql_rechecks_authority_after_http_guard(api):
    api.database.result = APIError(
        {"code": "42501", "message": "AUTOMATION_ADMIN_REQUIRED", "details": "private revocation"}
    )
    response = post(api)
    assert response.status_code == 403 and "private" not in response.text
    assert len(api.database.rpc_calls) == 1 and len(api.access_calls) == 1


@pytest.mark.parametrize("entity", [False, True])
def test_missing_or_foreign_workflow_or_entity_is_fixed_scoped_404(api, entity):
    api.database.result = APIError(
        {"code": "P0002", "message": "AUTOMATION_NOT_FOUND", "details": "private identity"}
    )
    response = post(api, request_for(entity=entity))
    assert response.status_code == 404
    assert response.json()["detail"] == "Workflow or simulation entity not found."
    assert len(api.database.rpc_calls) == 1


def test_dirty_graph_is_submitted_once_without_stored_workflow_read(api):
    request = request_for(build_preset("welcome"))
    request.graph.nodes[1].config.subject_template = "Unsaved subject"
    api.database.result = envelope(request)
    response = post(api, request)
    assert response.status_code == 200
    assert response.json()["trace"][1]["rendered_subject"] == "Unsaved subject"
    assert api.database.rpc_calls[0][1]["p_graph"] == request.graph.model_dump(mode="json")
    assert "p_status" not in api.database.rpc_calls[0][1]


def test_semantic_failure_is_200_with_complete_issues_empty_trace_and_actions(api):
    request = request_for()
    request.graph.edges = []
    api.database.result = envelope(request, valid=False, issues=[ISSUE])
    response = post(api, request)
    assert response.status_code == 200
    result = response.json()
    assert result["valid"] is False and result["issues"]
    assert result["trace"] == [] and result["next_actions"] == []
    assert all(set(issue) == set(ISSUE) for issue in result["issues"])
    assert len(api.access_calls) == 1 and len(api.database.rpc_calls) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"graph": {}, "context": {"kind": "synthetic"}},
        {
            "graph": request_for().graph.model_dump(mode="json"),
            "context": {"kind": "synthetic", "reference_time": INSTANT},
        },
        {
            "graph": request_for().graph.model_dump(mode="json"),
            "context": {"kind": "entity", "entity_type": "lead", "entity_id": "private-invalid-id"},
        },
        {**request_for().model_dump(mode="json"), "send": True},
    ],
)
def test_structural_errors_use_safe_422_before_reads(api, body):
    response = api.client.post(BASE, json=body)
    assert response.status_code == 422
    assert api.database.query_log == [] and not api.database.rpc_calls
    for issue in response.json()["detail"]:
        assert set(issue) == {"loc", "msg", "type"}


@pytest.mark.parametrize("location", NUL_LOCATIONS)
def test_raw_escaped_nul_gets_fixed_422_before_any_read(api, location):
    raw = json.dumps(request_with_nul(location)).encode("utf-8")
    assert b"\\u0000" in raw and b"\x00" not in raw
    response = api.client.post(BASE, content=raw, headers={"content-type": "application/json"})
    assert response.status_code == 422
    assert response.json()["detail"] == "Invalid workflow request."
    assert api.database.query_log == [] and api.database.rpc_calls == []
    assert api.access_calls == [] and api.lanes == []


def test_oversized_nul_request_keeps_size_error_precedence(api):
    body = {"graph": huge_safe_draft(), "context": {"kind": "synthetic"}, "A\x00B": None}
    response = api.client.post(BASE, json=body)
    assert response.status_code == 422
    assert response.json()["detail"] == "Workflow request is too large."
    assert api.database.query_log == [] and api.database.rpc_calls == []
    assert api.access_calls == [] and api.lanes == []


@pytest.mark.parametrize("control", ["\x01", "\x0b", "\x1f", "\x7f", "\x85"])
def test_representable_controls_keep_semantic_200_and_unchanged_graph(api, control):
    request = request_for()
    request.graph.nodes[1].config.subject_template = "A" + control + "B"
    validation = validate_workflow_graph(request.graph, catalog=CATALOG)
    assert not validation.valid
    api.database.result = envelope(
        request, valid=False, issues=[issue.model_dump() for issue in validation.issues]
    )
    response = post(api, request)
    assert response.status_code == 200
    assert response.json()["valid"] is False
    assert response.json()["trace"] == [] and response.json()["next_actions"] == []
    assert api.database.rpc_calls[0][1]["p_graph"] == request.graph.model_dump(mode="json")
    assert len(api.access_calls) == 1 and api.lanes == ["interactive"]


def test_literal_backslash_u0000_reaches_simulation_and_rendering_unchanged(api):
    request = request_for()
    request.graph.nodes[1].config.body_template = r"A\u0000B"
    api.database.result = envelope(request)
    response = post(api, request)
    assert response.status_code == 200 and response.json()["valid"] is True
    assert response.json()["trace"][1]["rendered_body"] == r"A\u0000B"
    assert api.database.rpc_calls[0][1]["p_graph"] == request.graph.model_dump(mode="json")


def test_whole_request_canonical_guard_and_raw_middleware_limit(api):
    body = {"graph": huge_safe_draft(), "context": {"kind": "synthetic"}}
    response = api.client.post(BASE, json=body)
    assert (
        response.status_code == 422
        and response.json()["detail"] == "Workflow request is too large."
    )
    assert api.database.query_log == []
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.add_middleware(RequestBodyLimitMiddleware, api_v1_prefix="/api/v1")
    register_error_handlers(app)
    with TestClient(app) as client:
        response = client.post(
            BASE,
            content=b"x" * (DEFAULT_API_REQUEST_MAX_BYTES + 1),
            headers={"content-type": "application/json"},
        )
    assert response.status_code == 413


def test_openapi_contains_only_exact_public_dtos_and_required_fields(api):
    document = api.client.get("/openapi.json").json()
    schemas = document["components"]["schemas"]
    expected = {
        "WorkflowSimulationRequest": {"graph", "context"},
        "WorkflowSimulationSyntheticContext": {"kind"},
        "WorkflowSimulationEntityContext": {"kind", "entity_type", "entity_id"},
        "WorkflowSimulationResponse": {
            "valid",
            "issues",
            "trace",
            "next_actions",
            "reference_time",
            "future_conditions_rechecked",
        },
        "WorkflowSimulationTrace": {
            "node_id",
            "outcome",
            "edge_id",
            "reason",
            "scheduled_at",
            "action_kind",
            "rendered_subject",
            "rendered_body",
        },
        "WorkflowSimulationAction": {"node_id", "scheduled_at", "action_kind", "reason"},
    }
    for name, fields in expected.items():
        model = schemas[name]
        assert model["additionalProperties"] is False
        assert set(model["properties"]) == fields == set(model["required"])
    assert (
        schemas["WorkflowSimulationResponse"]["properties"]["future_conditions_rechecked"]["const"]
        is True
    )
    assert schemas["WorkflowSimulationResponse"]["properties"]["trace"]["maxItems"] == 40
    assert schemas["WorkflowSimulationResponse"]["properties"]["next_actions"]["maxItems"] == 40
    assert not any(name.startswith(("_Facts", "_Payload")) for name in schemas)


def test_composed_app_mounts_simulation_once_and_keeps_existing_routes():
    from app.main import app

    paths = app.openapi()["paths"]
    path = "/api/v1/automations/workflows/{workflow_id}/simulate"
    matches = [route for route in iter_route_contexts(app.routes) if route.path == path]
    assert len(matches) == 1 and matches[0].endpoint is routes.simulate_workflow
    assert matches[0].methods == {"POST"} and set(paths[path]) == {"post"}
    operation = paths[path]["post"]
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/WorkflowSimulationRequest"
    }
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/WorkflowSimulationResponse"
    }
    assert {
        (parameter["name"], parameter["in"])
        for parameter in operation["parameters"]
        if parameter["in"] != "header"
    } == {("workflow_id", "path")}
    assert set(paths["/api/v1/automations/workflows/{workflow_id}"]) == {"get", "put"}
    assert set(paths["/api/v1/automations/missed-class"]) == {"get", "put"}
    assert "/api/v1/automations/workflows/{workflow_id}/test-email" not in paths
    assert "/api/v1/automations/test-deliveries/{test_delivery_id}" not in paths
    assert not any(
        name.startswith(("_Facts", "_Payload")) for name in app.openapi()["components"]["schemas"]
    )


@pytest.mark.parametrize("entity", [False, True])
def test_installed_sdk_http_route_uses_only_authorization_selects_and_one_fact_rpc(api, entity):
    request = request_for(entity=entity)
    payload = envelope(request, facts=wire_facts() if entity else None)
    calls = []

    def handler(http_request):
        calls.append(http_request)
        path = http_request.url.path
        if path == "/rest/v1/staff_roles":
            assert http_request.method == "GET"
            return httpx.Response(200, json=api.database.tables["staff_roles"])
        if path == "/rest/v1/studio_subscriptions":
            assert http_request.method == "GET"
            return httpx.Response(200, json=api.database.tables["studio_subscriptions"][0])
        assert http_request.method == "POST" and path == "/rest/v1/rpc/" + SIMULATION_RPC
        assert json.loads(http_request.content)["p_context"] == request.context.model_dump(
            mode="json"
        )
        return httpx.Response(200, json=payload)

    with SyntheticPostgrestClient(handler) as provider:
        api.app.dependency_overrides[get_supabase] = lambda: provider
        response = post(api, request)
    assert response.status_code == 200, response.text
    assert [call.method for call in calls] == ["GET", "GET", "POST"]
    assert api.lanes == ["interactive"] and api.access_calls[0][1]["read_only"] is True


def test_entity_null_is_safe_503_without_synthetic_fallback(api):
    request = request_for(entity=True)
    api.database.result = envelope(request)
    response = post(api, request)
    assert response.status_code == 503 and response.json()["detail"] == UNAVAILABLE_DETAIL
    assert "Sample" not in response.text and len(api.database.rpc_calls) == 1


def test_installed_sdk_studio_nowait_conflict_keeps_the_existing_409(api):
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/staff_roles"):
            return httpx.Response(200, json=api.database.tables["staff_roles"])
        if request.url.path.endswith("/studio_subscriptions"):
            return httpx.Response(200, json=api.database.tables["studio_subscriptions"][0])
        return httpx.Response(
            400,
            json={
                "code": "P0001",
                "message": "AUTOMATION_STUDIO_BUSY",
                "details": "private studio lock",
            },
        )

    with SyntheticPostgrestClient(handler) as provider:
        api.app.dependency_overrides[get_supabase] = lambda: provider
        response = post(api)
    assert response.status_code == 409
    assert response.json()["detail"] == "The studio is busy. Try again shortly."
    assert len(calls) == 3 and api.access_calls[0][1]["read_only"] is True
