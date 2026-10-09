"""Pinned SDK parsing for retained v1 adapter and preparation-aware v2 dispatch."""

import json
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from postgrest import SyncPostgrestClient
from postgrest._sync.request_builder import SyncRPCFilterRequestBuilder
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from test_automation_email import email_settings
from test_automation_service import Clock, WorkerDatabase, assert_counts, prepared_sender, snapshot

from app.services import automation_service as service
from app.services.automation_email import DeliveryResult

BEGIN = "begin_missed_class_automation_v1"
V2_BEGIN = "begin_missed_class_automation_v2"
V2_SETTLE = "settle_missed_class_automation_v2"
DELIVERY_ID = str(UUID(int=1))
CLAIM_TOKEN = str(UUID(int=101))
IDENTITY = {"p_delivery_id": DELIVERY_ID, "p_claim_token": CLAIM_TOKEN}
BEGIN_PARAMS = {**IDENTITY, "p_allowed_recipients": ["koaryu@outlook.com"]}


def begin_envelope(**changes):
    return {
        "ready": True,
        "state": "sending",
        "reason": None,
        "message": snapshot(DELIVERY_ID),
        **changes,
    }


class MockPostgrestClient(SyncPostgrestClient):
    """Keep real RPC builders and SDK sessions, replacing only HTTP transport."""

    def __init__(self, handler, timeout, *, on_begin_builder=None):
        self.handler = handler
        self.on_begin_builder = on_begin_builder
        self.builders = []
        super().__init__(
            "https://synthetic.invalid/rest/v1",
            timeout=timeout,
            headers={"apikey": "synthetic-service-role", "X-Client-Info": "synthetic-client"},
        )
        self.auth("synthetic-service-role")

    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            follow_redirects=True,
            transport=httpx.MockTransport(self.handler),
            trust_env=False,
        )

    def rpc(self, func, params, **kwargs):
        builder = super().rpc(func, params, **kwargs)
        assert isinstance(builder, SyncRPCFilterRequestBuilder)
        builder.execute = Mock(wraps=builder.execute)
        self.builders.append((func, builder))
        if func == BEGIN:
            builder.headers["X-Synthetic-Builder"] = "retained"
            builder.params = builder.params.add("synthetic-query", "retained")
            if self.on_begin_builder:
                self.on_begin_builder()
        return builder


INVALID_BEGIN_DATA = [
    None,
    [],
    "not an envelope",
    12,
    {},
    {"message": {"detail": "synthetic SQL error"}, "code": "P0001"},
    {key: value for key, value in begin_envelope().items() if key != "reason"},
    begin_envelope(ready=1),
    begin_envelope(ready="true"),
    begin_envelope(state=None),
    begin_envelope(state="claimed"),
    begin_envelope(state={}),
    begin_envelope(reason=[]),
    begin_envelope(reason="unexpected"),
    begin_envelope(message=None),
    begin_envelope(message=[]),
    begin_envelope(message="not a message"),
    begin_envelope(ready=False),
    begin_envelope(message=snapshot("another-delivery")),
    begin_envelope(
        message={key: value for key, value in snapshot(DELIVERY_ID).items() if key != "attempt_id"}
    ),
    begin_envelope(message=snapshot(DELIVERY_ID, days_absent=True)),
    begin_envelope(message=snapshot(DELIVERY_ID, days_absent="20")),
    *[
        begin_envelope(message={**snapshot(DELIVERY_ID), field: None})
        for field in (
            "delivery_id",
            "attempt_id",
            "student_first_name",
            "studio_name",
            "recipient_email",
            "subject_template",
            "body_template",
            "reply_to_email",
            "unsubscribe_token",
        )
    ],
]


def execute_v1(response, *, on_builder=None, budget=None):
    requests = []

    def handle(request):
        requests.append(request)
        if isinstance(response, Exception):
            raise response
        return response

    client = MockPostgrestClient(handle, 5.0, on_begin_builder=on_builder)
    clock = Clock()
    guarded = service._WorkerClient(client, budget or service._WorkerBudget(clock() + 25, clock))
    try:
        return guarded.rpc(BEGIN, BEGIN_PARAMS).execute().data, requests, client
    finally:
        client.aclose()


def test_pinned_sdk_rejects_successful_v1_message_without_scoped_adapter():
    assert version("postgrest") == "0.17.2"
    client = MockPostgrestClient(lambda _: httpx.Response(200, json=begin_envelope()), 5.0)
    try:
        with pytest.raises(APIError):
            client.rpc(BEGIN, BEGIN_PARAMS).execute()
    finally:
        client.aclose()


def test_retained_v1_adapter_preserves_exact_http_request_and_never_executes_twice():
    data, requests, client = execute_v1(httpx.Response(200, json=begin_envelope()))
    assert data == begin_envelope() and client.session.is_closed
    (request,) = requests
    assert request.method == "POST" and request.url.path == "/rest/v1/rpc/" + BEGIN
    assert dict(request.url.params) == {"synthetic-query": "retained"}
    assert json.loads(request.content) == BEGIN_PARAMS
    assert request.headers["authorization"] == "Bearer synthetic-service-role"
    assert request.headers["apikey"] == "synthetic-service-role"
    assert request.headers["x-client-info"] == "synthetic-client"
    assert request.headers["x-synthetic-builder"] == "retained"
    assert request.headers["accept-profile"] == "public"
    assert request.headers["content-profile"] == "public"
    assert request.extensions["timeout"] == {"connect": 5.0, "read": 5.0, "write": 5.0, "pool": 5.0}
    client.builders[0][1].execute.assert_not_called()


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 401, 403, 404, 409, 429, 500, 503])
def test_v1_non_success_status_never_parses_or_follows_redirect(status):
    response = httpx.Response(
        status, json=begin_envelope(), headers={"Location": "https://synthetic.invalid/redirect"}
    )
    response.json = Mock(wraps=response.json)
    with pytest.raises(RuntimeError, match="invalid_automation_begin_response"):
        execute_v1(response)
    response.json.assert_not_called()


@pytest.mark.parametrize("data", INVALID_BEGIN_DATA)
def test_retained_v1_adapter_rejects_each_malformed_success(data):
    with pytest.raises(RuntimeError, match="invalid_automation_begin_response"):
        execute_v1(httpx.Response(200, json=data))


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"{invalid"),
        httpx.Response(204),
        httpx.ReadError("synthetic lost response"),
    ],
)
def test_retained_v1_lost_or_malformed_result_never_retries(response):
    with pytest.raises((RuntimeError, httpx.ReadError)):
        execute_v1(response)


@pytest.mark.parametrize(
    "state,reason", [(None, None), ("queued", "on_hold"), ("unknown", "lease_expired")]
)
def test_retained_v1_false_grant_remains_null(state, reason):
    result, requests, _ = execute_v1(
        httpx.Response(
            200, json=begin_envelope(ready=False, state=state, reason=reason, message=None)
        )
    )
    assert result == {"ready": False, "state": state, "reason": reason, "message": None}
    assert len(requests) == 1


def test_budget_is_checked_after_builder_creation_before_v1_http():
    clock = Clock()
    with pytest.raises(service._BudgetExhausted):
        execute_v1(
            httpx.Response(200, json=begin_envelope()),
            on_builder=lambda: setattr(clock, "now", 126),
            budget=service._WorkerBudget(125, clock),
        )


def test_other_rpc_keeps_real_sdk_error_validator():
    client = MockPostgrestClient(
        lambda _: httpx.Response(200, json={"message": {"private": "error"}}), 5.0
    )
    guarded = service._WorkerClient(client, service._WorkerBudget(125, Clock()))
    try:
        with pytest.raises(APIError):
            guarded.rpc("another_rpc", {}).execute()
    finally:
        client.aclose()
    client.builders[0][1].execute.assert_called_once()


class ProcessorHTTPFixture:
    def __init__(self, monkeypatch):
        self.settings = email_settings(AUTOMATION_WORKER_ENABLED=True)
        self.database = WorkerDatabase(self.settings)
        self.clock = Clock()
        self.requests = []
        self.clients = []
        self.responses = {}
        self.transport = SimpleNamespace(
            prepare=Mock(return_value=prepared_sender(self.settings)),
            send_prepared=Mock(return_value=DeliveryResult("accepted")),
        )
        self.access = Mock(return_value={"subscription_required": False})
        monkeypatch.setattr(service, "get_platform_subscription_access", self.access)

    def handle(self, request):
        self.requests.append(request)
        name = request.url.path.rsplit("/", 1)[-1]
        if name in self.responses:
            response = self.responses[name]
            if isinstance(response, Exception):
                raise response
            return response
        result = self.database.rpc(name, json.loads(request.content)).execute().data
        return httpx.Response(200, json=result)

    def create_client(self, *, postgrest_client_timeout):
        assert postgrest_client_timeout == 5.0
        client = MockPostgrestClient(self.handle, postgrest_client_timeout)
        self.clients.append(client)
        return client

    def run(self):
        result = service.process_due_missed_class_automations(
            self.settings,
            limit=1,
            clock=self.clock,
            client_factory=self.create_client,
            client_closer=lambda c: c.aclose(),
            transport_factory=lambda *_: self.transport,
        ).model_dump()
        assert all(client.session.is_closed for client in self.clients)
        return result

    def requests_for(self, name):
        return [request for request in self.requests if request.url.path.endswith("/" + name)]


def test_legacy_v2_uses_ordinary_installed_sdk_with_prepared_snapshot_and_exact_truth(monkeypatch):
    fixture = ProcessorHTTPFixture(monkeypatch)
    assert_counts(fixture.run(), processed=1, accepted=1)
    message, prepared = fixture.transport.send_prepared.call_args.args
    assert prepared is fixture.transport.prepare.return_value and message.subject == "Hi Sam"
    assert UUID(message.attempt_id).version == 5
    assert fixture.access.call_args.kwargs == {"allow_provider_repairs": False}
    assert not fixture.requests_for(BEGIN)
    for name, builder in fixture.clients[0].builders:
        builder.execute.assert_called_once()
    begin = json.loads(fixture.requests_for(V2_BEGIN)[0].content)
    assert begin["p_preparation_token"] is not None and begin["p_probe_token"] is None
    assert begin["p_allowed_recipients"] == ["koaryu@outlook.com"]
    settle = json.loads(fixture.requests_for(V2_SETTLE)[0].content)
    assert set(settle) == {"p_delivery_id", "p_claim_token", "p_attempt_id", "p_result"}
    assert settle["p_result"] == {
        "outcome": "accepted",
        "error_code": None,
        "provider_request_id": None,
        "retry_after_seconds": None,
        "submission_evidence": None,
        "failure_scope": None,
        "credential_revision": None,
    }


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json={"payload": {}}),
        httpx.Response(200, json=begin_envelope()),
        httpx.Response(200, json=[{"payload": {}}]),
        httpx.Response(200, content=b"{malformed"),
        httpx.Response(204),
        httpx.Response(500, json={"message": "private", "code": "P0001"}),
        httpx.ReadError("private lost begin"),
    ],
)
def test_legacy_v2_ambiguous_begin_never_falls_back_to_v1_or_sends(monkeypatch, response):
    fixture = ProcessorHTTPFixture(monkeypatch)
    fixture.responses[V2_BEGIN] = response
    assert_counts(fixture.run(), processed=1, unknown=1)
    fixture.transport.send_prepared.assert_not_called()
    assert len(fixture.requests_for(V2_BEGIN)) == 1
    assert not fixture.requests_for(BEGIN) and not fixture.requests_for(V2_SETTLE)


@pytest.mark.parametrize(
    "field",
    [
        "delivery_id",
        "claim_token",
        "attempt_id",
        "lease_expires_at",
        "credential_revision",
        "sender_binding",
        "message",
        "ready",
        "state",
        "reason",
    ],
)
def test_legacy_v2_requires_every_grant_field_through_actual_sdk(monkeypatch, field):
    fixture = ProcessorHTTPFixture(monkeypatch)
    original = fixture.database.rpc(V2_BEGIN, BEGIN_PARAMS).execute().data
    del original["payload"][field]
    fixture.responses[V2_BEGIN] = httpx.Response(200, json=original)
    assert_counts(fixture.run(), processed=1, unknown=1)
    fixture.transport.send_prepared.assert_not_called()


@pytest.mark.parametrize(
    "state,disposition",
    [("sending", "unknown"), ("unknown", "unknown"), ("queued", "skipped"), (None, "skipped")],
)
def test_legacy_v2_false_begin_is_never_permission_even_if_sending(monkeypatch, state, disposition):
    fixture = ProcessorHTTPFixture(monkeypatch)
    data = {
        "delivery_id": DELIVERY_ID,
        "claim_token": CLAIM_TOKEN,
        "ready": False,
        "state": state,
        "reason": None,
        "attempt_id": None,
        "lease_expires_at": None,
        "credential_revision": None,
        "sender_binding": None,
        "message": None,
    }
    fixture.responses[V2_BEGIN] = httpx.Response(200, json={"payload": data})
    assert_counts(fixture.run(), processed=1, **{disposition: 1})
    fixture.transport.send_prepared.assert_not_called()
    assert not fixture.requests_for(V2_SETTLE)


@pytest.mark.parametrize(
    "field,value",
    [
        ("delivery_id", str(UUID(int=777))),
        ("attempt_id", str(UUID(int=777))),
        ("updated", False),
        ("replayed", "true"),
    ],
)
def test_v2_settlement_mismatch_never_repeats_submission(monkeypatch, field, value):
    fixture = ProcessorHTTPFixture(monkeypatch)
    from test_automation_service import ATTEMPT_ID

    data = {
        "delivery_id": DELIVERY_ID,
        "attempt_id": ATTEMPT_ID,
        "updated": True,
        "replayed": False,
        "state": "accepted",
        "reason": None,
        field: value,
    }
    fixture.responses[V2_SETTLE] = httpx.Response(200, json={"payload": data})
    assert_counts(fixture.run(), processed=1, unknown=1, accepted=0)
    fixture.transport.send_prepared.assert_called_once()
    assert len(fixture.requests_for(V2_SETTLE)) == 1 and not fixture.requests_for(
        "settle_missed_class_automation_v1"
    )


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
@pytest.mark.parametrize(
    "origin", ["https://synthetic.invalid", "https://redirect.synthetic.invalid"]
)
@pytest.mark.parametrize("phase", ["readiness", "claim", "preparation", "begin"])
def test_legacy_worker_never_redirects_sdk_rpc_or_forwards_service_key(
    monkeypatch, status, origin, phase
):
    from fastapi import HTTPException

    from app.services.workflow_capabilities import RELEASE_PREFLIGHT_RPC

    names = {
        "readiness": RELEASE_PREFLIGHT_RPC,
        "claim": "claim_missed_class_automations_v1",
        "preparation": "claim_automation_sender_preparation_v1",
        "begin": V2_BEGIN,
    }
    fixture = ProcessorHTTPFixture(monkeypatch)
    fixture.responses[names[phase]] = httpx.Response(
        status, headers={"Location": origin + "/redirected-grant"}
    )
    if phase == "begin":
        assert_counts(fixture.run(), processed=1, unknown=1, accepted=0)
    else:
        with pytest.raises(HTTPException) as caught:
            fixture.run()
        assert caught.value.status_code == 503
    assert len(fixture.requests_for(names[phase])) == 1
    assert not any(request.url.path == "/redirected-grant" for request in fixture.requests)
    assert all(request.url.host == "synthetic.invalid" for request in fixture.requests)
    fixture.transport.send_prepared.assert_not_called()
    assert all(client.session.follow_redirects is False for client in fixture.clients)


@pytest.mark.parametrize(
    "origin", ["https://synthetic.invalid", "https://redirect.synthetic.invalid"]
)
def test_worker_table_queries_disable_redirects_without_mutating_unrelated_client(origin):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": origin + "/redirected-table"})

    client = MockPostgrestClient(handler, 5.0)
    unrelated = MockPostgrestClient(handler, 5.0)
    try:
        worker = service._WorkerClient(client, service._WorkerBudget(125, Clock()))
        with pytest.raises(APIError):
            worker.table("studio_subscriptions").select("*").eq("studio_id", DELIVERY_ID).execute()
        assert len(requests) == 1 and requests[0].url.path == "/rest/v1/studio_subscriptions"
        assert client.session.follow_redirects is False
        assert unrelated.session.follow_redirects is True
    finally:
        client.aclose()
        unrelated.aclose()
