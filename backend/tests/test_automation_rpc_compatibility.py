"""Exercise the pinned SDK's HTTP parsing with synthetic sessions and no network."""

import json
from importlib.metadata import version
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from postgrest import SyncPostgrestClient
from postgrest._sync.request_builder import SyncRPCFilterRequestBuilder
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from test_automation_email import email_settings
from test_automation_email_credentials import credential_state
from test_automation_service import Clock, assert_counts, snapshot

from app.services import automation_service as service
from app.services.automation_email import DeliveryResult
from app.services.automation_email_credentials import PROVIDER_KEY, CredentialCodec

BEGIN = "begin_missed_class_automation_v1"
DELIVERY_ID = str(UUID(int=1))
CLAIM_TOKEN = str(UUID(int=2))
STUDIO_ID = str(UUID(int=3))
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


class ProcessorHTTPFixture:
    def __init__(self, monkeypatch, begin_response=None, *, on_begin_builder=None):
        self.settings = email_settings(AUTOMATION_WORKER_ENABLED=True)
        codec = CredentialCodec(
            self.settings.EMAIL_TOKEN_ENCRYPTION_KEY,
            self.settings.EMAIL_GRAPH_CLIENT_ID,
            self.settings.EMAIL_FROM_ADDRESS,
        )
        self.ciphertext = codec.encrypt(credential_state())
        self.clock = Clock()
        self.requests = []
        self.claim_count = 0
        self.begin_response = begin_response
        self.clients = []
        self.on_begin_builder = on_begin_builder
        self.transport = Mock()
        self.transport.send.return_value = DeliveryResult("accepted")
        self.access = Mock(return_value={"subscription_required": False})
        monkeypatch.setattr(service, "get_platform_subscription_access", self.access)

    def handle(self, request):
        self.requests.append(request)
        name = request.url.path.rsplit("/", 1)[-1]
        if name == "get_automation_email_credential_v1":
            data = {
                "provider_key": PROVIDER_KEY,
                "revision": 1,
                "encrypted_credentials": self.ciphertext,
            }
        elif name == "enqueue_missed_class_automations_v1":
            data = {"enqueued": 0, "has_more": True}
        elif name == "claim_missed_class_automations_v1":
            self.claim_count += 1
            data = {
                "items": [{"id": DELIVERY_ID, "claim_token": CLAIM_TOKEN, "studio_id": STUDIO_ID}]
                if self.claim_count == 1
                else [],
                "has_more": False,
            }
        elif name == BEGIN:
            if isinstance(self.begin_response, Exception):
                raise self.begin_response
            return (
                self.begin_response
                if self.begin_response is not None
                else httpx.Response(200, json=begin_envelope())
            )
        elif name == "settle_missed_class_automation_v1":
            data = {"updated": True, "state": "accepted"}
        else:
            raise AssertionError("Unexpected synthetic HTTP request")
        return httpx.Response(200, json=data)

    def create_client(self, *, postgrest_client_timeout):
        assert postgrest_client_timeout == 5.0
        client = MockPostgrestClient(
            self.handle, postgrest_client_timeout, on_begin_builder=self.on_begin_builder
        )
        self.clients.append(client)
        return client

    def run(self):
        result = service.process_due_missed_class_automations(
            self.settings,
            limit=10,
            clock=self.clock,
            client_factory=self.create_client,
            client_closer=lambda client: client.aclose(),
            transport_factory=lambda _settings, _client: self.transport,
        ).model_dump()
        assert all(client.session.is_closed for client in self.clients)
        return result

    def requests_for(self, name):
        return [request for request in self.requests if request.url.path.endswith("/" + name)]


def test_pinned_sdk_rejects_successful_begin_message_without_scoped_adapter():
    assert version("postgrest") == "0.17.2"
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json=begin_envelope())

    client = MockPostgrestClient(handle, 5.0)
    try:
        with pytest.raises(APIError):
            client.rpc(BEGIN, BEGIN_PARAMS).execute()
    finally:
        client.aclose()
    assert len(requests) == 1


def test_real_sdk_successful_begin_sends_and_settles_once_preserving_request(monkeypatch):
    fixture = ProcessorHTTPFixture(monkeypatch)
    assert_counts(fixture.run(), processed=1, accepted=1, unknown=0)
    fixture.transport.send.assert_called_once()
    (begin_request,) = fixture.requests_for(BEGIN)
    assert begin_request.method == "POST"
    assert begin_request.url.path == "/rest/v1/rpc/" + BEGIN
    assert dict(begin_request.url.params) == {"synthetic-query": "retained"}
    assert json.loads(begin_request.content) == BEGIN_PARAMS
    assert begin_request.headers["authorization"] == "Bearer synthetic-service-role"
    assert begin_request.headers["apikey"] == "synthetic-service-role"
    assert begin_request.headers["x-client-info"] == "synthetic-client"
    assert begin_request.headers["x-synthetic-builder"] == "retained"
    assert begin_request.headers["accept-profile"] == "public"
    assert begin_request.headers["content-profile"] == "public"
    assert begin_request.extensions["timeout"] == {
        "connect": 5.0,
        "read": 5.0,
        "write": 5.0,
        "pool": 5.0,
    }
    (settle_request,) = fixture.requests_for("settle_missed_class_automation_v1")
    settled = json.loads(settle_request.content)
    assert settled["p_delivery_id"] == DELIVERY_ID
    assert settled["p_claim_token"] == CLAIM_TOKEN and settled["p_outcome"] == "accepted"
    assert fixture.access.call_args.kwargs == {"allow_provider_repairs": False}
    for name, builder in fixture.clients[0].builders:
        assert builder.execute.call_count == (0 if name == BEGIN else 1)


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 401, 403, 404, 409, 429, 500, 503])
def test_non_success_status_is_not_parsed_dispatched_settled_or_redirected(monkeypatch, status):
    response = httpx.Response(
        status,
        json=begin_envelope(),
        headers={"Location": "https://synthetic.invalid/redirect-target"},
    )
    response.json = Mock(wraps=response.json)
    fixture = ProcessorHTTPFixture(monkeypatch, response)
    assert_counts(fixture.run(), processed=1, unknown=1, accepted=0, failed=0)
    fixture.transport.send.assert_not_called()
    response.json.assert_not_called()
    assert len(fixture.requests_for(BEGIN)) == 1
    assert not fixture.requests_for("settle_missed_class_automation_v1")
    assert not fixture.requests_for("redirect-target")
    assert fixture.claim_count == 1
    assert fixture.clients[0].session.follow_redirects is True
    next(
        builder for name, builder in fixture.clients[0].builders if name == BEGIN
    ).execute.assert_not_called()


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


@pytest.mark.parametrize("data", INVALID_BEGIN_DATA)
def test_malformed_success_data_stops_as_unknown_before_dispatch_or_settlement(monkeypatch, data):
    fixture = ProcessorHTTPFixture(monkeypatch, httpx.Response(200, content=json.dumps(data)))
    assert_counts(fixture.run(), processed=1, unknown=1, accepted=0, failed=0, skipped=0)
    fixture.transport.send.assert_not_called()
    assert len(fixture.requests_for(BEGIN)) == 1
    assert not fixture.requests_for("settle_missed_class_automation_v1")
    assert fixture.claim_count == 1


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"{malformed synthetic JSON"),
        httpx.Response(204),
        httpx.ReadError("synthetic lost response"),
    ],
)
def test_malformed_json_or_lost_begin_response_never_retries(monkeypatch, response):
    fixture = ProcessorHTTPFixture(monkeypatch, response)
    assert_counts(fixture.run(), processed=1, unknown=1, accepted=0)
    fixture.transport.send.assert_not_called()
    assert len(fixture.requests_for(BEGIN)) == 1
    assert not fixture.requests_for("settle_missed_class_automation_v1")
    next(
        builder for name, builder in fixture.clients[0].builders if name == BEGIN
    ).execute.assert_not_called()


@pytest.mark.parametrize(
    "state,reason,disposition",
    [
        (None, None, "skipped"),
        ("queued", "on_hold", "skipped"),
        ("unknown", "lease_expired", "unknown"),
    ],
)
def test_ready_false_null_message_preserves_skip_or_unknown(
    monkeypatch, state, reason, disposition
):
    fixture = ProcessorHTTPFixture(
        monkeypatch,
        httpx.Response(
            200,
            json={
                "ready": False,
                "state": state,
                "reason": reason,
                "message": None,
            },
        ),
    )
    assert_counts(fixture.run(), processed=1, **{disposition: 1})
    fixture.transport.send.assert_not_called()
    assert len(fixture.requests_for(BEGIN)) == 1
    assert not fixture.requests_for("settle_missed_class_automation_v1")


def test_other_rpc_keeps_real_sdk_error_validator():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"message": {"synthetic": "error"}})

    client = MockPostgrestClient(handler, 5.0)
    clock = Clock()
    budgeted = service._WorkerClient(client, service._WorkerBudget(clock() + 25, clock))
    try:
        with pytest.raises(APIError):
            budgeted.rpc("another_rpc", {}).execute()
    finally:
        client.aclose()
    assert len(requests) == 1
    client.builders[0][1].execute.assert_called_once()


def test_budget_is_checked_after_builder_creation_before_actual_begin_request(monkeypatch):
    fixture = ProcessorHTTPFixture(monkeypatch)
    fixture.on_begin_builder = lambda: setattr(fixture.clock, "now", fixture.clock() + 26)
    assert_counts(fixture.run(), processed=0, unknown=0)
    assert not fixture.requests_for(BEGIN)
    assert not fixture.requests_for("settle_missed_class_automation_v1")
    fixture.transport.send.assert_not_called()
    next(
        builder for name, builder in fixture.clients[0].builders if name == BEGIN
    ).execute.assert_not_called()
