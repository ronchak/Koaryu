"""Unmounted real HTTP handlers backed only by synthetic SDK and mail transports."""

import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_workflow_test_email import (
    ACTOR,
    ATTEMPT,
    OTHER,
    PREPARED,
    SETTINGS,
    STUDIO,
    TEST,
    WORKFLOW,
    SyntheticScope,
    current,
    public,
    request_for,
)

from app.api.v1.endpoints import workflow_test_email as routes
from app.core.deps import get_current_user_id, get_supabase
from app.core.error_handlers import register_error_handlers
from app.core.request_body_limits import DEFAULT_API_REQUEST_MAX_BYTES, RequestBodyLimitMiddleware
from app.services import platform_billing_service, studio_scope
from app.services import workflow_test_email_service as service
from app.services.microsoft_graph_email import GRAPH_SEND_URL, MicrosoftGraphEmailTransport
from app.services.platform_billing_service import PlatformBillingService
from app.services.workflow_management_service import _ERRORS

POST = f"/api/v1/automations/workflows/{WORKFLOW}/test-email"
GET = f"/api/v1/automations/test-deliveries/{TEST}"


@pytest.fixture
def api(monkeypatch):
    scope = SyntheticScope()
    monkeypatch.setattr(platform_billing_service, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(studio_scope, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(routes, "get_settings", lambda: scope.settings)
    monkeypatch.setattr(routes, "time", SimpleNamespace(monotonic=scope.clock))
    forbidden = Mock(
        side_effect=AssertionError("Test command attempted a repair or interactive client")
    )
    monkeypatch.setattr(platform_billing_service, "StripeService", forbidden)
    for name in (
        "_ensure_subscription_row",
        "_get_access_status_row_uncoordinated",
        "get_status_sync",
    ):
        monkeypatch.setattr(PlatformBillingService, name, forbidden)
    access_calls = []
    actual_access = PlatformBillingService.get_access_status_row

    def access(self, studio, **kwargs):
        access_calls.append((studio, kwargs))
        return actual_access(self, studio, **kwargs)

    monkeypatch.setattr(PlatformBillingService, "get_access_status_row", access)

    def dependencies():
        return {
            "clock": scope.clock,
            "utc_clock": lambda: scope.now,
            "client_factory": scope.factory,
            "client_closer": scope.close,
            "transport_factory": scope.transport_factory,
        }

    def create(*args, **kwargs):
        return service.create_workflow_test_email(*args, **kwargs, **dependencies())

    def read(*args, **kwargs):
        return service.get_workflow_test_email(*args, **kwargs, **dependencies())

    monkeypatch.setattr(routes, "create_workflow_test_email", create)
    monkeypatch.setattr(routes, "get_workflow_test_email", read)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    register_error_handlers(app)
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = forbidden
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, app=app, scope=scope, access_calls=access_calls)
    forbidden.assert_not_called()
    assert len(scope.close_calls) == len(scope.clients)
    assert len({id(client) for client in scope.close_calls}) == len(scope.close_calls)
    assert platform_billing_service._access_repair_flights == {}
    assert platform_billing_service._access_repair_retry_after == {}


def post(api, data=None, **kwargs):
    return api.client.post(
        POST, json=data if data is not None else api.scope.data.model_dump(mode="json"), **kwargs
    )


def test_http_fresh_execution_uses_current_auth_readonly_entitlement_and_one_owned_client(api):
    response = post(api)
    assert response.status_code == 200, response.text
    assert response.json() == public("accepted")
    assert api.scope.factory_calls == [{"postgrest_client_timeout": 5.0}]
    assert api.access_calls == [
        (STUDIO, {"strict_repairs": True, "allow_provider_repairs": True, "read_only": True})
    ]
    assert len(api.scope.params(service.BEGIN)) == api.scope.transport.send_prepared.call_count == 1
    tables = [
        name
        for name, _ in api.scope.calls
        if not name.endswith("_v1") and not name.startswith("koaryu_")
    ]
    assert tables == ["staff_roles", "studio_subscriptions"]
    assert all(
        request.method == "GET"
        for request in api.scope.requests
        if request.url.path.endswith(("staff_roles", "studio_subscriptions"))
    )


@pytest.mark.parametrize("state", ["accepted", "failed", "unknown"])
def test_http_replay_reconciles_original_receipt_to_current_truth(api, state):
    api.scope.replay = True
    api.scope.state = state
    response = post(api)
    assert response.status_code == 200 and response.json() == public(state)
    api.scope.transport_factory.assert_not_called()
    assert len(api.scope.params(service.CREATE)) == len(api.scope.params(service.CURRENT)) == 1


def test_http_replay_unknown_current_truth_is_fixed_unavailable(api):
    api.scope.replay = True
    api.scope.handlers[service.CURRENT] = httpx.ReadTimeout("private delivery data")
    response = post(api)
    assert response.status_code == 503
    assert response.json()["detail"] == service.UNAVAILABLE_DETAIL
    assert "private" not in response.text and '"state":"queued"' not in response.text


@pytest.mark.parametrize("method", ["post", "get"])
@pytest.mark.parametrize("role", ["front_desk", "instructor", "student", None])
def test_http_current_admin_required_before_any_entitlement_or_scope_call(api, method, role):
    api.scope.tables["staff_roles"][0]["role"] = role
    response = post(api) if method == "post" else api.client.get(GET)
    assert response.status_code == 403
    assert api.access_calls == []
    assert api.scope.params(service.CREATE) == api.scope.params(service.CURRENT) == []
    api.scope.transport_factory.assert_not_called()


@pytest.mark.parametrize(
    "case,status", [("missing", 404), ("archived", 403), ("ambiguous", 409), ("foreign", 403)]
)
def test_http_current_membership_uses_established_studio_resolution(api, case, status):
    role = api.scope.tables["staff_roles"][0]
    headers = {}
    if case == "missing":
        api.scope.tables["staff_roles"].clear()
    elif case == "archived":
        role["archived_at"] = "2026-10-05T20:00:00Z"
    elif case == "ambiguous":
        api.scope.tables["staff_roles"].append({**role, "studio_id": OTHER})
    else:
        headers = {"X-Studio-Id": OTHER}
    response = post(api, headers=headers)
    assert response.status_code == status, response.text
    assert api.scope.params(service.CREATE) == []


def test_http_requested_studio_is_forwarded_to_scoped_sql_authority(api):
    response = post(api, headers={"X-Studio-Id": STUDIO})
    assert response.status_code == 200
    assert api.scope.params(service.CREATE)[0]["p_studio_id"] == STUDIO
    assert api.scope.params(service.CREATE)[0]["p_actor_id"] == ACTOR


@pytest.mark.parametrize("method", ["post", "get"])
@pytest.mark.parametrize(
    "kind,status", [("past_due", 402), ("missing", 503), ("repair", 503), ("malformed", 503)]
)
def test_http_readonly_entitlement_is_required_without_repairs(api, method, kind, status):
    row = api.scope.tables["studio_subscriptions"][0]
    if kind == "past_due":
        row["status"] = "past_due"
    elif kind == "missing":
        api.scope.tables["studio_subscriptions"].clear()
    elif kind == "repair":
        row["stripe_subscription_id"] = None
    else:
        row["comped"] = "false"
    response = post(api) if method == "post" else api.client.get(GET)
    assert response.status_code == status, response.text
    assert api.scope.params(service.CREATE) == api.scope.params(service.CURRENT) == []


@pytest.mark.parametrize("pair,expected", list(_ERRORS.items()))
def test_http_reserve_maps_only_declared_database_errors(api, pair, expected):
    code, message = pair
    api.scope.handlers[service.CREATE] = httpx.Response(
        400,
        json={
            "code": code,
            "message": message,
            "details": "PRIVATE_SQL",
            "hint": "PRIVATE_HINT",
        },
    )
    response = post(api)
    assert response.status_code == expected[0] and response.json()["detail"] == expected[1]
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize(
    "code,message",
    [
        ("XX001", "PRIVATE SQL"),
        (None, "PRIVATE SQL"),
        ([], "PRIVATE SQL"),
        ("P0001", []),
        ({}, {}),
        ("PGRST202", "missing RPC"),
    ],
)
def test_http_unrecognized_or_unhashable_sdk_error_is_fixed_unavailable(api, code, message):
    api.scope.handlers[service.CREATE] = httpx.Response(
        400, json={"code": code, "message": message}
    )
    response = post(api)
    assert response.status_code == 503 and response.json()["detail"] == service.UNAVAILABLE_DETAIL


@pytest.mark.parametrize(
    "payload", [None, {}, {"payload": None}, {"payload": current(studio_id=OTHER)}]
)
def test_http_current_read_rejects_malformed_or_foreign_response(api, payload):
    api.scope.handlers[service.CURRENT] = payload
    response = api.client.get(GET)
    assert response.status_code == 503 and response.json()["detail"] == service.UNAVAILABLE_DETAIL


def test_http_wrong_studio_or_missing_test_is_fixed_not_found(api):
    api.scope.handlers[service.CURRENT] = httpx.Response(
        400, json={"code": "P0002", "message": "AUTOMATION_NOT_FOUND", "details": "PRIVATE"}
    )
    response = api.client.get(GET)
    assert response.status_code == 404 and "PRIVATE" not in response.text


@pytest.mark.parametrize("field", ["operation_id", "graph", "email_node_id"])
def test_http_all_three_request_fields_are_required(api, field):
    data = request_for().model_dump(mode="json")
    data.pop(field)
    response = post(api, data)
    assert response.status_code == 422
    assert api.scope.factory_calls == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("recipient_email", "PRIVATE@example.com"),
        ("runtime", {}),
        ("execution_token", OTHER),
        ("context", {"kind": "entity", "entity_id": OTHER}),
        ("replay_only", True),
        ("test_delivery_id", TEST),
        ("reply_to", "PRIVATE@example.com"),
        ("profile", "synthetic"),
    ],
)
def test_http_caller_cannot_supply_private_authority_or_recipient(api, field, value):
    data = request_for().model_dump(mode="json")
    data[field] = value
    response = post(api, data)
    assert response.status_code == 422
    assert "PRIVATE@example.com" not in response.text
    assert api.scope.factory_calls == []


@pytest.mark.parametrize(
    "field,value", [("operation_id", True), ("email_node_id", 3), ("graph", []), ("graph", None)]
)
def test_http_public_shape_is_strict_before_owned_client_admission(api, field, value):
    data = request_for().model_dump(mode="json")
    data[field] = value
    assert post(api, data).status_code == 422
    assert api.scope.factory_calls == []


@pytest.mark.parametrize("field", ["subject_template", "body_template"])
@pytest.mark.parametrize("control", ["\x00", "\x01", "\x0b", "\r", "\x7f", "\x9f"])
def test_http_template_control_errors_precede_all_business_rpc_calls(api, field, control):
    data = request_for().model_dump(mode="json")
    data["graph"]["nodes"][1]["config"][field] = "PRIVATE" + control
    response = post(api, data)
    assert response.status_code == 422 and "PRIVATE" not in response.text
    assert api.scope.factory_calls == []


@pytest.mark.parametrize(
    "location", ["unknown_key", "unknown_value", "node_id", "edge_id", "subject", "reply_to"]
)
def test_http_nul_guard_covers_complete_original_body(api, location):
    data = request_for().model_dump(mode="json")
    if location == "unknown_key":
        data["bad\x00key"] = "value"
    elif location == "unknown_value":
        data["extra"] = "bad\x00value"
    elif location == "node_id":
        data["graph"]["nodes"][0]["id"] = "bad\x00node"
    elif location == "edge_id":
        data["graph"]["edges"][0]["id"] = "bad\x00edge"
    elif location == "subject":
        data["graph"]["nodes"][1]["config"]["subject_template"] = "bad\x00subject"
    else:
        data["graph"]["nodes"][1]["config"]["reply_to_email"] = "bad\x00@example.com"
    response = post(api, data)
    assert response.status_code == 422 and response.json()["detail"] == "Invalid workflow request."
    assert api.scope.factory_calls == []


def test_http_surrogate_utf8_validation_precedes_business_calls(api):
    data = request_for().model_dump(mode="json")
    data["graph"]["nodes"][1]["config"]["body_template"] = "PRIVATE\ud800"
    response = api.client.post(
        POST, content=json.dumps(data), headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 422 and "PRIVATE" not in response.text
    assert api.scope.factory_calls == []


def test_http_full_body_size_error_precedes_nested_nul_and_shape_validation(api):
    data = request_for().model_dump(mode="json")
    data["unexpected"] = "\U0001f642" * (DEFAULT_API_REQUEST_MAX_BYTES // 4)
    data["graph"]["nodes"][0]["id"] = "bad\x00node"
    response = api.client.post(
        POST,
        content=json.dumps(data, ensure_ascii=False).encode("utf8"),
        headers={"Content-Type": "application/json"},
    )
    assert (
        response.status_code == 422
        and response.json()["detail"] == "Workflow request is too large."
    )
    assert api.scope.factory_calls == []


def test_actual_body_limit_middleware_rejects_oversized_body_before_auth_or_scope(api):
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    register_error_handlers(app)
    app.add_middleware(RequestBodyLimitMiddleware, api_v1_prefix="/api/v1")
    with TestClient(app) as client:
        response = client.post(
            POST,
            content=b"x" * (DEFAULT_API_REQUEST_MAX_BYTES + 1),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 413
    assert api.scope.factory_calls == []


@pytest.mark.parametrize(
    "method,path",
    [("post", POST.replace(WORKFLOW, "invalid")), ("get", GET.replace(TEST, "invalid"))],
)
def test_http_path_identity_errors_precede_business_client(api, method, path):
    response = api.client.request(
        method, path, json=request_for().model_dump(mode="json") if method == "post" else None
    )
    assert response.status_code == 422 and api.scope.factory_calls == []


@pytest.mark.parametrize("method", ["post", "get"])
def test_deadline_is_created_before_threadpool_queue_and_not_restarted(api, monkeypatch, method):
    admitted = []

    async def delayed(function):
        admitted.append(function.keywords["deadline_monotonic"])
        api.scope.clock.now = 126.0
        return function()

    monkeypatch.setattr(routes, "run_in_threadpool", delayed)
    response = post(api) if method == "post" else api.client.get(GET)
    assert response.status_code == 503
    assert admitted == [125.0]
    assert api.scope.factory_calls == api.scope.close_calls == []


@pytest.mark.parametrize(
    "phase",
    [
        "staff_roles",
        "studio_subscriptions",
        service.CREATE,
        service.PREPARE,
        PREPARED,
        service.BEGIN,
        service.SETTLE,
        service.CURRENT,
    ],
)
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
@pytest.mark.parametrize("host", ["https://synthetic.invalid", "https://other.invalid"])
def test_owned_client_never_follows_redirect_or_forwards_credentials(api, phase, status, host):
    if phase == service.CURRENT:
        api.scope.replay = True
    destination = host + "/PRIVATE-redirect-target"
    api.scope.handlers[phase] = httpx.Response(status, headers={"Location": destination})
    response = post(api)
    assert response.status_code in {200, 503}
    assert all(str(request.url) != destination for request in api.scope.requests)
    assert all(request.url.host == "synthetic.invalid" for request in api.scope.requests)
    assert len(api.scope.params(phase)) == 1
    assert all(client.session.follow_redirects is False for client in api.scope.clients)
    if phase not in {service.SETTLE}:
        api.scope.transport.send_prepared.assert_not_called()


@pytest.mark.parametrize(
    "provider_status,state", [(202, "accepted"), (400, "failed"), (503, "unknown")]
)
def test_http_actual_prepared_transport_sends_synthetic_message_once(
    api, monkeypatch, provider_status, state
):
    from app.services import microsoft_graph_email

    monkeypatch.setattr(
        microsoft_graph_email,
        "time",
        SimpleNamespace(monotonic=api.scope.clock, time=lambda: 1791240000.0),
    )
    provider_requests = []
    provider_clients = []

    def handler(request):
        provider_requests.append(request)
        return httpx.Response(provider_status, headers={"request-id": "synthetic-request"})

    def factory(**kwargs):
        client = httpx.Client(transport=httpx.MockTransport(handler), **kwargs)
        provider_clients.append(client)
        return client

    api.scope.transport_factory = lambda settings, client: MicrosoftGraphEmailTransport(
        settings, client, client_factory=factory
    )
    response = post(api)
    assert response.status_code == 200, response.text
    assert response.json() == public(state)
    assert len(provider_requests) == 1
    sent = provider_requests[0]
    assert str(sent.url) == GRAPH_SEND_URL
    assert sent.headers["client-request-id"] == ATTEMPT
    payload = json.loads(sent.content)
    assert payload["message"]["subject"] == "[Test] Hello Sample lead"
    assert payload["message"]["toRecipients"] == [
        {"emailAddress": {"address": "koaryu@outlook.com"}}
    ]
    assert "Sample data only" in payload["message"]["body"]["content"]
    assert "Unsubscribe" not in payload["message"]["body"]["content"]
    assert all(client.is_closed for client in provider_clients)
    assert len(api.scope.params(service.BEGIN)) == len(api.scope.params(service.SETTLE)) == 1
    assert api.scope.params(service.SETTLE)[0]["p_result"]["credential_revision"] == 7


def test_http_private_success_fields_never_appear_in_response(api):
    response = post(api)
    assert set(response.json()) == {"operation_id", "test_delivery_id", "state"}
    for secret in (
        "koaryu@outlook.com",
        "Sample lead",
        "provider_request_id",
        "sender_binding",
        "preparation_token",
    ):
        assert secret not in response.text


def test_unmounted_router_has_exact_public_openapi_contract(api):
    document = api.client.get("/openapi.json").json()
    schemas = document["components"]["schemas"]
    expected = {
        "WorkflowTestEmailRequest": {"operation_id", "graph", "email_node_id"},
        "WorkflowTestEmailResponse": {"operation_id", "test_delivery_id", "state"},
    }
    for name, fields in expected.items():
        assert set(schemas[name]["properties"]) == set(schemas[name]["required"]) == fields
        assert schemas[name]["additionalProperties"] is False
    assert set(schemas["WorkflowTestEmailResponse"]["properties"]["state"]["enum"]) == {
        "queued",
        "sending",
        "accepted",
        "failed",
        "unknown",
    }
    assert set(document["paths"]) == {
        "/api/v1/automations/workflows/{workflow_id}/test-email",
        "/api/v1/automations/test-deliveries/{test_delivery_id}",
    }
    assert all("Execution" not in name and "Preparation" not in name for name in schemas)
