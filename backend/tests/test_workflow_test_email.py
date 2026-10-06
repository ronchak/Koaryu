"""Synthetic installed-SDK protocol proofs; no SQL execution or external mail."""

import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from test_automation_email import email_settings
from test_automation_email_credentials import credential_state
from test_automation_rpc_compatibility import MockPostgrestClient
from test_automation_service import Clock, preparation_claim, preparation_settled
from test_platform_billing_readonly_access import subscription_row
from test_workflow_capabilities import V38, exact_preflight_row, guarded_preflight

from app.schemas.workflow_test_email import (
    WorkflowTestEmailRequest,
)
from app.services import platform_billing_service, studio_scope
from app.services import workflow_test_email_service as service
from app.services.automation_email import (
    DeliveryResult,
    SyntheticTestEmailMessage,
    assemble_synthetic_test_email,
    delivery_configuration,
    sender_identity_binding,
)
from app.services.automation_email_credentials import (
    PROVIDER_KEY,
    CredentialCodec,
    CredentialEnvelope,
)
from app.services.automation_service import _WorkerBudget, _WorkerClient
from app.services.microsoft_graph_email import PreparedEmailSender
from app.services.workflow_capabilities import RELEASE_PREFLIGHT_RPC
from app.services.workflow_catalog import CATALOG
from app.services.workflow_email import WorkflowEmailRenderError, render_workflow_email
from app.services.workflow_simulation_service import build_synthetic_workflow_facts

STUDIO, ACTOR, WORKFLOW, OPERATION, TEST, EXECUTION, PREPARATION, TOKEN, PROBE, ATTEMPT, OTHER = (
    str(UUID(int=n)) for n in range(1001, 1012)
)
NOW = datetime(2026, 10, 5, 21, 0, tzinfo=UTC)
LEASE = (NOW + timedelta(seconds=60)).isoformat()
PREPARED = "settle_automation_sender_preparation_v1"
CREDENTIAL = "get_automation_email_credential_v1"
FINGERPRINT = "f" * 64
SETTINGS = email_settings(AUTOMATION_WORKER_ENABLED=False, ENVIRONMENT="production")
CONFIG = delivery_configuration(SETTINGS)
BINDING = sender_identity_binding(CONFIG)


def request_for(event="lead.created", *, reply_to=""):
    recipient = CATALOG["triggers"][event]["recipient_ids"][0]
    config = {"event_type": event}
    if CATALOG["triggers"][event]["supports_offset"]:
        config["offset_minutes"] = -15
    return WorkflowTestEmailRequest.model_validate(
        {
            "operation_id": OPERATION,
            "email_node_id": "email",
            "graph": {
                "schema_version": 1,
                "nodes": [
                    {"id": "trigger", "type": "trigger", "config": config},
                    {
                        "id": "email",
                        "type": "email",
                        "config": {
                            "recipient": recipient,
                            "subject_template": "Hello {{recipient_name}}",
                            "body_template": "A message from {{studio_name}}.",
                            "reply_to_email": reply_to,
                        },
                    },
                    {"id": "end", "type": "end", "config": {}},
                ],
                "edges": [
                    {"id": "a", "source": "trigger", "target": "email", "port": "next"},
                    {"id": "b", "source": "email", "target": "end", "port": "next"},
                ],
            },
        }
    )


def public(state="queued", **changes):
    return {"operation_id": OPERATION, "test_delivery_id": TEST, "state": state, **changes}


def execution(data=None, **changes):
    data = data or request_for()
    trigger = next(node for node in data.graph.nodes if node.type == "trigger").config
    email = next(node for node in data.graph.nodes if node.id == data.email_node_id).config
    return {
        "execution_token": EXECUTION,
        "lease_expires_at": LEASE,
        "scope_fingerprint": FINGERPRINT,
        "reference_time": NOW.isoformat(),
        "event_type": trigger.event_type,
        "trigger_context": {
            "program_id": trigger.program_id,
            "offset_minutes": trigger.offset_minutes
            if "offset_minutes" in trigger.model_fields_set
            else None,
        },
        "email_node_id": data.email_node_id,
        "recipient_policy": email.recipient,
        "subject_template": email.subject_template,
        "body_template": email.body_template,
        "recipient_email": "koaryu@outlook.com",
        "reply_to": email.reply_to_email or CONFIG.reply_to,
        **changes,
    }


def reserved(data=None, *, replayed=False, **changes):
    return {
        "studio_id": STUDIO,
        "actor_id": ACTOR,
        "workflow_id": WORKFLOW,
        "result": public(),
        "replayed": replayed,
        "execution": None if replayed else execution(data),
        **changes,
    }


def rendered(data=None):
    selected = service.Execution.model_validate(execution(data))
    facts = build_synthetic_workflow_facts(
        selected.event_type,
        selected.reference_time,
        program_id=selected.trigger_context.program_id,
        offset_minutes=selected.trigger_context.offset_minutes,
        recipient_ids=frozenset({selected.recipient_policy}),
    )
    content = render_workflow_email(
        selected.event_type,
        selected.subject_template,
        selected.body_template,
        {**facts.template_facts, **facts.recipients[selected.recipient_policy].template_facts},
        unsubscribe_url=None,
    )
    labeled = assemble_synthetic_test_email(content.subject, content.text_body)
    return {key: getattr(labeled, key) for key in service.Rendered.model_fields}


def attempt(data=None, **changes):
    return {
        "id": ATTEMPT,
        "lease_expires_at": LEASE,
        "credential_revision": 7,
        "sender_binding": BINDING,
        "message": {
            "attempt_id": ATTEMPT,
            "to_address": "koaryu@outlook.com",
            "reply_to": execution(data)["reply_to"],
            **rendered(data),
        },
        **changes,
    }


def begun(data=None, **changes):
    return {
        "studio_id": STUDIO,
        "test_delivery_id": TEST,
        "outcome": "begun",
        "result": public("sending"),
        "attempt": attempt(data),
        **changes,
    }


def claimed(params=None, **changes):
    params = params or {"p_preparation_id": PREPARATION}
    return {
        **preparation_claim(params),
        "studio_id": STUDIO,
        "test_delivery_id": TEST,
        "preparation_token": TOKEN,
        "lease_expires_at": LEASE,
        **changes,
    }


def finished(**changes):
    return {
        "studio_id": STUDIO,
        "test_delivery_id": TEST,
        "updated": True,
        "replayed": False,
        "result": public("failed"),
        **changes,
    }


def settled(state="accepted", **changes):
    return {
        "studio_id": STUDIO,
        "test_delivery_id": TEST,
        "attempt_id": ATTEMPT,
        "updated": True,
        "replayed": False,
        "state": state,
        "result": public(state),
        **changes,
    }


def current(state="queued", **changes):
    return {"studio_id": STUDIO, "workflow_id": WORKFLOW, "result": public(state), **changes}


class SyntheticScope:
    """Scriptable SQL responses, with the real pinned PostgREST request/parser."""

    def __init__(self, settings=SETTINGS, data=None):
        self.settings = settings
        self.data = data or request_for()
        self.clock = Clock()
        self.now = NOW
        self.requests = []
        self.calls = []
        self.handlers = {}
        self.close_calls = []
        self.factory_calls = []
        self.clients = []
        self.before_request = None
        self.after_request = None
        self.state = "queued"
        self.replay = False
        self.preparation_mode = "ready"
        self.generation = 3
        self.preparation_id = None
        self.tables = {
            "staff_roles": [
                {"user_id": ACTOR, "studio_id": STUDIO, "role": "admin", "archived_at": None}
            ],
            "studio_subscriptions": [subscription_row(studio_id=STUDIO)],
        }
        self.config = delivery_configuration(settings)
        self.envelope = CredentialEnvelope(7, credential_state(expires_at=4102444800.0))
        self.ciphertext = CredentialCodec(
            settings.EMAIL_TOKEN_ENCRYPTION_KEY,
            settings.EMAIL_GRAPH_CLIENT_ID,
            settings.EMAIL_FROM_ADDRESS,
        ).encrypt(self.envelope.state)
        self.prepared = PreparedEmailSender(
            self.envelope, sender_identity_binding(self.config), self.config, 100.0
        )
        self.transport = SimpleNamespace(
            prepare=Mock(side_effect=lambda **kwargs: self.prepared),
            send_prepared=Mock(
                return_value=DeliveryResult(
                    "accepted", submission_evidence="accepted", credential_revision=7
                )
            ),
        )
        self.transport_factory = Mock(return_value=self.transport)

    def factory(self, **kwargs):
        self.factory_calls.append(kwargs)
        client = MockPostgrestClient(self.handle, kwargs["postgrest_client_timeout"])
        self.clients.append(client)
        return client

    def close(self, client):
        self.close_calls.append(client)
        client.aclose()

    def handle(self, request):
        self.requests.append(request)
        name = request.url.path.rsplit("/", 1)[-1]
        params = (
            json.loads(request.content) if request.method == "POST" else dict(request.url.params)
        )
        self.calls.append((name, deepcopy(params)))
        if self.before_request:
            self.before_request(name, params)
        if name in self.handlers:
            handler = self.handlers[name]
            response = handler(params) if callable(handler) else handler
        else:
            response = self.default(name, params)
        if self.after_request:
            self.after_request(name, params)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, httpx.Response):
            return response
        return httpx.Response(200, json=response)

    def default(self, name, params):
        if name in self.tables:
            rows = self.tables[name]
            for field, expression in params.items():
                if expression.startswith("eq."):
                    rows = [row for row in rows if row.get(field) == expression[3:]]
            if name == "studio_subscriptions":
                return deepcopy(rows[0] if rows else None)
            return deepcopy(rows)
        if name == RELEASE_PREFLIGHT_RPC:
            return exact_preflight_row()
        if name == V38:
            return guarded_preflight()
        if name == CREDENTIAL:
            return {
                "provider_key": PROVIDER_KEY,
                "revision": 7,
                "encrypted_credentials": self.ciphertext,
            }
        if name == service.CREATE:
            return {"payload": reserved(self.data, replayed=self.replay)}
        if name == service.PREPARE:
            self.preparation_id = params["p_preparation_id"]
            return {
                "payload": claimed(
                    params,
                    mode=self.preparation_mode,
                    probe_token=PROBE if self.preparation_mode != "ready" else None,
                    generation=self.generation,
                )
            }
        if name == PREPARED:
            succeeded = params["p_result"]["outcome"] == "prepared"
            return {
                "payload": {
                    **preparation_settled(params),
                    "generation": self.generation,
                    "preparation_token": TOKEN if succeeded else None,
                    "probe_token": PROBE
                    if succeeded and self.preparation_mode != "ready"
                    else None,
                    "lease_expires_at": LEASE if succeeded else None,
                }
            }
        if name == service.BEGIN:
            self.state = "sending"
            return {"payload": begun(self.data)}
        if name == service.FINISH:
            self.state = "failed"
            return {"payload": finished()}
        if name == service.SETTLE:
            self.state = {
                "accepted": "accepted",
                "unknown": "unknown",
                "retryable_failure": "failed",
                "permanent_failure": "failed",
            }[params["p_result"]["outcome"]]
            return {"payload": settled(self.state)}
        if name == service.CURRENT:
            return {"payload": current(self.state)}
        raise AssertionError(f"Unexpected synthetic request: {name}")

    def run(self, *, deadline=125.0, **changes):
        values = {
            "settings": self.settings,
            "actor_id": ACTOR,
            "requested_studio_id": None,
            "workflow_id": UUID(WORKFLOW),
            "data": self.data,
            "deadline_monotonic": deadline,
            "clock": self.clock,
            "utc_clock": lambda: self.now,
            "client_factory": self.factory,
            "client_closer": self.close,
            "transport_factory": self.transport_factory,
            **changes,
        }
        return service.create_workflow_test_email(**values)

    def read(self, *, deadline=125.0, **changes):
        return service.get_workflow_test_email(
            self.settings,
            ACTOR,
            None,
            UUID(TEST),
            deadline_monotonic=deadline,
            clock=self.clock,
            utc_clock=lambda: self.now,
            client_factory=self.factory,
            client_closer=self.close,
            transport_factory=self.transport_factory,
            **changes,
        )

    def params(self, name):
        return [params for rpc, params in self.calls if rpc == name]


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(platform_billing_service, "get_settings", lambda: SETTINGS)
    monkeypatch.setattr(studio_scope, "get_settings", lambda: SETTINGS)
    return SyntheticScope()


def assert_unavailable(call):
    with pytest.raises(HTTPException) as caught:
        call()
    assert caught.value.status_code == 503
    assert caught.value.detail == service.UNAVAILABLE_DETAIL
    return caught.value


def test_fresh_test_uses_one_scoped_grant_prepared_revision_and_exact_message(scope):
    result = scope.run()
    assert result.model_dump(mode="json") == public("accepted")
    assert scope.factory_calls == [{"postgrest_client_timeout": 5.0}]
    assert scope.close_calls == scope.clients and len(scope.clients) == 1
    assert scope.clients[0].session.follow_redirects is False
    assert scope.params(service.CURRENT) == []
    assert scope.params(service.FINISH) == []
    assert scope.params("claim_automation_sender_preparation_v1") == []
    assert len(scope.params(service.BEGIN)) == len(scope.params(service.SETTLE)) == 1
    assert scope.params(service.PREPARE)[0] == {
        "p_studio_id": STUDIO,
        "p_actor_id": ACTOR,
        "p_test_delivery_id": TEST,
        "p_execution_token": EXECUTION,
        "p_preparation_id": scope.preparation_id,
        "p_sender_binding": BINDING,
        "p_allowed_recipients": ["koaryu@outlook.com"],
    }
    assert scope.params(PREPARED)[0]["p_result"] == {
        "outcome": "prepared",
        "credential_revision": 7,
        "sender_binding": BINDING,
        "safe_reason": None,
        "retry_after_seconds": None,
    }
    message, handle = scope.transport.send_prepared.call_args.args
    assert type(message) is SyntheticTestEmailMessage
    assert message.attempt_id == ATTEMPT and handle is scope.prepared
    assert message.to_address == "koaryu@outlook.com"
    assert message.subject == "[Test] Hello Sample lead"
    assert message.text_body.startswith("Synthetic automation test. Sample data only.\n\n")
    assert "Sample studio" in message.text_body
    assert "Unsubscribe" not in message.text_body + message.html_body
    assert scope.transport.prepare.call_args.kwargs == {"deadline": 120.0}
    assert scope.transport.send_prepared.call_args.kwargs == {"deadline": 120.0}
    assert scope.params(service.BEGIN)[0]["p_rendered"] == rendered()
    assert all(request.extensions["timeout"]["read"] == 5.0 for request in scope.requests)


@pytest.mark.parametrize("state", ["queued", "sending", "accepted", "failed", "unknown"])
def test_replay_returns_verified_current_not_historical_queued_state(scope, state):
    scope.replay = True
    scope.state = state
    result = scope.run()
    assert result.model_dump(mode="json") == public(state)
    assert len(scope.params(service.CREATE)) == len(scope.params(service.CURRENT)) == 1
    scope.transport_factory.assert_not_called()
    assert scope.params(service.PREPARE) == scope.params(service.BEGIN) == []


@pytest.mark.parametrize("state", ["queued", "sending", "accepted", "failed", "unknown"])
def test_current_read_has_no_sender_or_recipient_eligibility_precondition(scope, state):
    scope.settings = SimpleNamespace(EMAIL_SEND_ENABLED=False)
    scope.state = state
    assert scope.read().state == state
    assert scope.params(CREDENTIAL) == scope.params(service.CREATE) == []
    scope.transport_factory.assert_not_called()
    assert scope.close_calls == scope.clients


@pytest.mark.parametrize("state", ["accepted", "failed", "unknown"])
@pytest.mark.parametrize("disabled", ["flag", "provider", "configuration", "credential"])
def test_unavailable_runtime_allows_only_sql_receipt_replay(scope, state, disabled):
    scope.replay = True
    scope.state = state
    scope.settings = deepcopy(scope.settings)
    if disabled == "flag":
        scope.settings.EMAIL_SEND_ENABLED = False
    elif disabled == "provider":
        scope.settings.EMAIL_PROVIDER = "disabled"
    elif disabled == "configuration":
        scope.settings.EMAIL_FROM_ADDRESS = "invalid"
    else:
        scope.handlers[CREDENTIAL] = {
            "provider_key": PROVIDER_KEY,
            "revision": 7,
            "encrypted_credentials": None,
        }
    assert scope.run().state == state
    sent = scope.params(service.CREATE)[0]
    assert sent["p_replay_only"] is True and sent["p_runtime"] is None
    scope.transport_factory.assert_not_called()


def test_replay_only_cannot_accept_unexpected_fresh_grant(scope):
    scope.settings = SimpleNamespace(EMAIL_SEND_ENABLED=False)
    assert_unavailable(scope.run)
    scope.transport_factory.assert_not_called()
    assert not scope.params(service.CURRENT)


@pytest.mark.parametrize(
    "response", [None, [], {}, {"payload": None}, {"payload": {}}, {"message": "private"}]
)
def test_malformed_create_never_retries_or_uses_untrusted_scope(scope, response):
    scope.handlers[service.CREATE] = response
    assert_unavailable(scope.run)
    assert len(scope.params(service.CREATE)) == 1
    assert scope.params(service.CURRENT) == scope.params(service.FINISH) == []
    scope.transport_factory.assert_not_called()
    assert len(scope.close_calls) == 1


@pytest.mark.parametrize(
    "response", [None, {}, {"payload": None}, {"payload": current("accepted", studio_id=OTHER)}]
)
def test_replay_current_read_failure_is_unavailable(scope, response):
    scope.replay = True
    scope.handlers[service.CURRENT] = response
    assert_unavailable(scope.run)
    assert len(scope.params(service.CREATE)) == len(scope.params(service.CURRENT)) == 1
    scope.transport_factory.assert_not_called()


@pytest.mark.parametrize("field", ["studio_id", "actor_id", "workflow_id"])
def test_reserve_cross_scope_echo_is_rejected_before_execution(scope, field):
    scope.handlers[service.CREATE] = {"payload": reserved(**{field: OTHER})}
    assert_unavailable(scope.run)
    scope.transport_factory.assert_not_called()
    assert scope.params(service.CURRENT) == []


@pytest.mark.parametrize("field", ["operation_id", "test_delivery_id"])
def test_reserve_result_identity_and_canonical_uuid_are_required(scope, field):
    value = OTHER if field == "operation_id" else "{00000000-0000-0000-0000-000000001234}"
    scope.handlers[service.CREATE] = {"payload": reserved(result=public(**{field: value}))}
    assert_unavailable(scope.run)
    scope.transport_factory.assert_not_called()


@pytest.mark.parametrize(
    "field,value",
    [
        ("email_node_id", "different"),
        ("subject_template", "Different valid subject"),
        ("body_template", "Different valid body"),
        ("recipient_policy", "assigned_staff"),
        ("recipient_email", "another@example.com"),
        ("reply_to", "another@example.com"),
    ],
)
def test_contradictory_selection_never_grants_execution(scope, field, value):
    scope.handlers[service.CREATE] = {"payload": reserved(execution=execution(**{field: value}))}
    result = scope.run()
    assert result.state == "queued"
    scope.transport_factory.assert_not_called()
    assert not scope.params(service.FINISH)
    assert len(scope.params(service.CURRENT)) == 1


@pytest.mark.parametrize("reply", ["", "OVERRIDE@Example.com"])
def test_selected_reply_to_is_pinned_without_overwriting_nonempty_node(scope, reply):
    scope.data = request_for(reply_to=reply)
    assert scope.run().state == "accepted"
    message = scope.transport.send_prepared.call_args.args[0]
    assert message.reply_to == (reply.lower() if reply else "reply@example.com")
    assert scope.params(service.CREATE)[0]["p_runtime"]["default_reply_to"] == "reply@example.com"


@pytest.mark.parametrize("event", list(CATALOG["triggers"]))
def test_every_trigger_uses_only_fictional_factory_and_reserved_reference_time(scope, event):
    scope.data = request_for(event)
    assert scope.run().state == "accepted"
    assert scope.params(service.BEGIN)[0]["p_rendered"] == rendered(scope.data)
    assert all(name not in {"students", "leads", "invoices", "programs"} for name, _ in scope.calls)


@pytest.mark.parametrize("mode", ["ready", "cooldown", "auth_blocked"])
def test_test_specific_live_scope_can_prepare_each_known_gate_mode(scope, mode):
    scope.preparation_mode = mode
    assert scope.run().state == "accepted"
    begin = scope.params(service.BEGIN)[0]
    assert begin["p_probe_token"] == (PROBE if mode != "ready" else None)
    assert scope.params("claim_automation_sender_preparation_v1") == []


@pytest.mark.parametrize("phase", ["execution", "preparation", "after_preparation"])
def test_expired_scope_or_preparation_never_begins_or_sends(scope, phase):
    if phase == "execution":
        scope.now = NOW + timedelta(seconds=60)
    elif phase == "preparation":
        scope.after_request = lambda name, params: (
            setattr(scope, "now", NOW + timedelta(seconds=60)) if name == service.PREPARE else None
        )
    else:
        scope.after_request = lambda name, params: (
            setattr(scope, "now", NOW + timedelta(seconds=60)) if name == PREPARED else None
        )
    assert scope.run().state == "failed"
    assert scope.params(service.FINISH)[0]["p_reason"] == "lease_expired"
    assert scope.params(service.BEGIN) == []
    scope.transport.send_prepared.assert_not_called()
    if phase != "after_preparation":
        scope.transport.prepare.assert_not_called()


@pytest.mark.parametrize("mode", ["ready", "cooldown", "auth_blocked"])
def test_denied_preparation_cannot_reach_provider(scope, mode):
    scope.handlers[service.PREPARE] = lambda params: {
        "payload": claimed(
            params,
            mode=mode,
            allowed=False,
            preparation_token=None,
            probe_token=None,
            lease_expires_at=None,
            retry_at=LEASE if mode == "cooldown" else None,
            reason="sender_unavailable",
        )
    }
    assert scope.run().state == "failed"
    scope.transport_factory.assert_not_called()
    assert not scope.params(service.BEGIN)


@pytest.mark.parametrize(
    "field,value",
    [
        ("preparation_token", None),
        ("lease_expires_at", None),
        ("generation", 0),
        ("generation", True),
        ("studio_id", OTHER),
        ("test_delivery_id", OTHER),
        ("preparation_id", OTHER),
        ("allowed", 1),
        ("mode", "unknown"),
        ("probe_token", PROBE),
        ("reason", "sender_unavailable"),
        ("retry_at", LEASE),
    ],
)
def test_malformed_test_preparation_grants_no_provider_authority(scope, field, value):
    scope.handlers[service.PREPARE] = lambda params: {"payload": claimed(params, **{field: value})}
    assert_unavailable(scope.run)
    scope.transport_factory.assert_not_called()
    assert not scope.params(service.BEGIN)
    assert not scope.params(service.FINISH) and not scope.params(service.CURRENT)


@pytest.mark.parametrize(
    "field,value",
    [
        ("generation", 4),
        ("preparation_token", OTHER),
        ("probe_token", PROBE),
        ("lease_expires_at", (NOW + timedelta(seconds=61)).isoformat()),
        ("preparation_id", OTHER),
    ],
)
def test_shared_preparation_completion_requires_original_identity_and_lease(scope, field, value):
    scope.handlers[PREPARED] = lambda params: {
        "payload": {
            **preparation_settled(params),
            "generation": 3,
            "preparation_token": TOKEN,
            "lease_expires_at": LEASE,
            field: value,
        }
    }
    assert_unavailable(scope.run)
    scope.transport.send_prepared.assert_not_called()
    assert not scope.params(service.BEGIN)
    assert not scope.params(service.FINISH) and not scope.params(service.CURRENT)


@pytest.mark.parametrize(
    "outcome,state",
    [
        ("already_begun", "sending"),
        ("already_begun", "accepted"),
        ("already_begun", "failed"),
        ("already_begun", "unknown"),
        ("stopped", "failed"),
    ],
)
def test_confirmed_begin_refusal_returns_current_without_resend_or_extra_read(
    scope, outcome, state
):
    scope.handlers[service.BEGIN] = {
        "payload": begun(outcome=outcome, result=public(state), attempt=None)
    }
    assert scope.run().state == state
    scope.transport.send_prepared.assert_not_called()
    assert not scope.params(service.CURRENT) and not scope.params(service.FINISH)
    assert len(scope.params(service.BEGIN)) == 1


@pytest.mark.parametrize(
    "response",
    [
        None,
        {},
        {"payload": None},
        {"payload": begun(outcome="lease_lost", result=None, attempt=None)},
        {"payload": begun(studio_id=OTHER)},
        {"payload": begun(test_delivery_id=OTHER)},
        {"payload": begun(result=public("sending", operation_id=OTHER))},
    ],
)
def test_uncertain_begin_uses_current_only_and_never_preflight_finish(scope, response):
    scope.handlers[service.BEGIN] = response
    scope.state = "unknown"
    assert scope.run().state == "unknown"
    scope.transport.send_prepared.assert_not_called()
    assert not scope.params(service.FINISH) and not scope.params(service.SETTLE)
    assert len(scope.params(service.BEGIN)) == len(scope.params(service.CURRENT)) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("credential_revision", 8),
        ("sender_binding", "a" * 64),
        ("lease_expires_at", NOW.isoformat()),
    ],
)
def test_returned_attempt_mismatch_never_sends_or_rebegins(scope, field, value):
    scope.handlers[service.BEGIN] = {"payload": begun(attempt=attempt(**{field: value}))}
    scope.state = "sending"
    assert scope.run().state == "sending"
    scope.transport.send_prepared.assert_not_called()
    assert len(scope.params(service.BEGIN)) == 1
    assert not scope.params(service.FINISH)


@pytest.mark.parametrize(
    "field,value",
    [
        ("attempt_id", OTHER),
        ("to_address", "another@example.com"),
        ("reply_to", "another@example.com"),
        ("subject", "[Test] Different"),
        ("text_body", "Synthetic automation test. Sample data only.\n\nDifferent"),
        ("html_body", "<div>Different</div>"),
    ],
)
def test_returned_message_must_match_exact_prepared_values(scope, field, value):
    returned = attempt()
    returned["message"][field] = value
    scope.handlers[service.BEGIN] = {"payload": begun(attempt=returned)}
    scope.state = "sending"
    assert scope.run().state == "sending"
    scope.transport.send_prepared.assert_not_called()
    assert not scope.params(service.FINISH)


@pytest.mark.parametrize(
    "observation,expected,evidence",
    [
        (DeliveryResult("accepted"), "accepted", None),
        (
            DeliveryResult("accepted", submission_evidence="accepted", credential_revision=7),
            "accepted",
            "accepted",
        ),
        (
            DeliveryResult("unknown", "provider_submission_unknown", submission_evidence="unknown"),
            "unknown",
            "unknown",
        ),
        (DeliveryResult("retryable_failure", "provider_unavailable"), "unknown", "unknown"),
        (DeliveryResult("permanent_failure", "provider_rejected"), "unknown", "unknown"),
        (
            DeliveryResult(
                "retryable_failure",
                "provider_unavailable",
                submission_evidence="not_submitted",
                failure_scope="sender_transient",
            ),
            "failed",
            "not_submitted",
        ),
        (
            DeliveryResult(
                "permanent_failure",
                "provider_rejected",
                submission_evidence="rejected",
                failure_scope="message",
                credential_revision=7,
            ),
            "failed",
            "rejected",
        ),
        (
            DeliveryResult("accepted", submission_evidence="accepted", credential_revision=8),
            "unknown",
            "unknown",
        ),
        (None, "unknown", "unknown"),
    ],
)
def test_submission_truth_and_evidence_are_never_upgraded(scope, observation, expected, evidence):
    scope.transport.send_prepared.return_value = observation
    assert scope.run().state == expected
    result = scope.params(service.SETTLE)[0]["p_result"]
    assert result["submission_evidence"] == evidence
    assert len(result) == 7
    assert len(scope.params(service.BEGIN)) == scope.transport.send_prepared.call_count == 1
    assert not scope.params(service.CURRENT)


def test_provider_exception_is_unknown_and_no_retry(scope):
    scope.transport.send_prepared.side_effect = RuntimeError("PRIVATE PROVIDER MESSAGE")
    assert scope.run().state == "unknown"
    assert scope.params(service.SETTLE)[0]["p_result"]["outcome"] == "unknown"
    assert scope.transport.send_prepared.call_count == 1


@pytest.mark.parametrize(
    "observation,reported",
    [
        (DeliveryResult("unknown"), "accepted"),
        (DeliveryResult("retryable_failure", submission_evidence="not_submitted"), "accepted"),
        (DeliveryResult("accepted"), "failed"),
    ],
)
def test_settlement_cannot_upgrade_or_contradict_observed_truth(scope, observation, reported):
    scope.transport.send_prepared.return_value = observation
    scope.handlers[service.SETTLE] = {"payload": settled(reported)}
    scope.state = "unknown"
    scope.handlers[service.CURRENT] = {"payload": current("unknown")}
    assert scope.run().state == "unknown"
    assert len(scope.params(service.CURRENT)) == 1
    assert not scope.params(service.FINISH)


def test_role_change_after_submission_does_not_erase_settlement(scope):
    def submit(*args, **kwargs):
        scope.tables["staff_roles"].clear()
        return DeliveryResult("accepted", submission_evidence="accepted", credential_revision=7)

    scope.transport.send_prepared.side_effect = submit
    assert scope.run().state == "accepted"
    assert len(scope.params("staff_roles")) == 1
    assert "p_actor_id" not in scope.params(service.SETTLE)[0]


@pytest.mark.parametrize("phase", [service.FINISH, service.SETTLE])
@pytest.mark.parametrize("response", [None, {}, {"payload": None}])
def test_unconfirmed_terminal_result_requires_current_truth(scope, phase, response):
    scope.handlers[phase] = response
    if phase == service.FINISH:
        scope.transport.prepare.return_value = None
        scope.transport.prepare.side_effect = None
        scope.handlers[service.CURRENT] = {"payload": current("failed")}
    else:
        scope.handlers[service.CURRENT] = {"payload": current("unknown")}
    assert scope.run().state == ("failed" if phase == service.FINISH else "unknown")
    assert len(scope.params(service.CURRENT)) == 1


@pytest.mark.parametrize("phase", [service.FINISH, service.SETTLE])
def test_confirmed_terminal_replay_is_current_without_redundant_get(scope, phase):
    if phase == service.FINISH:
        scope.transport.prepare.side_effect = None
        scope.transport.prepare.return_value = None
        scope.handlers[phase] = {"payload": finished(replayed=True)}
    else:
        scope.handlers[phase] = {"payload": settled(replayed=True)}
    assert scope.run().state == ("failed" if phase == service.FINISH else "accepted")
    assert not scope.params(service.CURRENT)


@pytest.mark.parametrize(
    "phase",
    [service.CREATE, service.PREPARE, PREPARED, service.BEGIN, service.SETTLE, service.CURRENT],
)
def test_private_rpc_network_failures_close_owned_client_and_never_retry_submission(scope, phase):
    scope.handlers[phase] = httpx.ReadTimeout("PRIVATE transport detail")
    if phase == service.CURRENT:
        scope.replay = True
    if phase in {service.CREATE, service.CURRENT, service.PREPARE, PREPARED}:
        assert_unavailable(scope.run)
    else:
        response = scope.run()
        assert response.state in {"failed", "sending", "queued"}
    assert len(scope.close_calls) == 1
    assert len(scope.params(phase)) == 1
    assert scope.transport.send_prepared.call_count <= 1


@pytest.mark.parametrize("deadline", [float("nan"), float("inf"), -1.0, 100.0, 110.0])
def test_exhausted_thread_admission_creates_no_client(scope, deadline):
    assert_unavailable(lambda: scope.run(deadline=deadline))
    assert scope.factory_calls == scope.close_calls == []


@pytest.mark.parametrize(
    "phase", ["staff_roles", "studio_subscriptions", RELEASE_PREFLIGHT_RPC, V38, CREDENTIAL]
)
def test_pre_reserve_budget_exhaustion_never_creates_test_scope(scope, phase):
    scope.after_request = lambda name, params: (
        setattr(scope.clock, "now", 115.0) if name == phase else None
    )
    assert_unavailable(scope.run)
    assert not scope.params(service.CREATE)
    scope.transport_factory.assert_not_called()
    assert len(scope.close_calls) == 1


@pytest.mark.parametrize("phase", [service.CREATE, service.PREPARE, PREPARED])
def test_pre_begin_budget_exhaustion_uses_remaining_terminal_reserve(scope, phase):
    scope.after_request = lambda name, params: (
        setattr(scope.clock, "now", 115.0) if name == phase else None
    )
    assert scope.run().state == "failed"
    assert not scope.params(service.BEGIN)
    assert scope.params(service.FINISH)[0]["p_reason"] == "budget_exhausted"
    scope.transport.send_prepared.assert_not_called()


def test_budget_after_possible_begin_never_uses_preflight_finish(scope):
    scope.after_request = lambda name, params: (
        setattr(scope.clock, "now", 120.0) if name == service.BEGIN else None
    )
    assert_unavailable(scope.run)
    assert not scope.params(service.FINISH)
    scope.transport.send_prepared.assert_not_called()
    assert len(scope.params(service.BEGIN)) == 1


def test_provider_deadline_preserves_five_second_settlement_reserve(scope):
    def submit(*args, **kwargs):
        assert kwargs["deadline"] == 120.0
        scope.clock.now = 119.99
        return DeliveryResult("accepted", submission_evidence="accepted", credential_revision=7)

    scope.transport.send_prepared.side_effect = submit
    assert scope.run().state == "accepted"
    assert len(scope.params(service.SETTLE)) == 1


def test_replay_releases_unused_settlement_reserve_for_current_read(scope):
    scope.replay = True
    scope.state = "accepted"
    scope.after_request = lambda name, params: (
        setattr(scope.clock, "now", 118.0) if name == service.CREATE else None
    )
    assert scope.run().state == "accepted"
    assert len(scope.params(service.CURRENT)) == 1


def test_cleanup_error_does_not_change_confirmed_truth_or_close_twice(scope):
    def closer(client):
        scope.close(client)
        raise RuntimeError("PRIVATE close failure")

    assert scope.run(client_closer=closer).state == "accepted"
    assert len(scope.close_calls) == 1


SCOPE = {"p_studio_id": STUDIO, "p_test_delivery_id": TEST, "p_execution_token": EXECUTION}
ACTOR_SCOPE = {"p_studio_id": STUDIO, "p_actor_id": ACTOR}
RUNTIME = {
    "sender_binding": BINDING,
    "default_reply_to": "reply@example.com",
    "allowed_recipients": ["koaryu@outlook.com"],
}
ACCEPTED = {
    "outcome": "accepted",
    "error_code": None,
    "provider_request_id": None,
    "retry_after_seconds": None,
    "submission_evidence": "accepted",
    "failure_scope": None,
    "credential_revision": 7,
}
RPC_CASES = [
    (
        service.CREATE,
        service.ReserveRequest,
        {
            **ACTOR_SCOPE,
            "p_workflow_id": WORKFLOW,
            "p_operation_id": OPERATION,
            "p_graph": request_for().graph.model_dump(mode="json"),
            "p_email_node_id": "email",
            "p_runtime": RUNTIME,
            "p_replay_only": False,
        },
        service.Reserved,
        reserved(),
    ),
    (
        service.PREPARE,
        service.PreparationRequest,
        {
            **SCOPE,
            "p_actor_id": ACTOR,
            "p_preparation_id": PREPARATION,
            "p_sender_binding": BINDING,
            "p_allowed_recipients": ["koaryu@outlook.com"],
        },
        service.PreparationClaim,
        claimed(),
    ),
    (
        service.FINISH,
        service.FinishRequest,
        {**SCOPE, "p_reason": "recipient_suppressed"},
        service.Finished,
        finished(),
    ),
    (
        service.BEGIN,
        service.BeginRequest,
        {
            **SCOPE,
            "p_actor_id": ACTOR,
            "p_preparation_id": PREPARATION,
            "p_preparation_token": TOKEN,
            "p_probe_token": None,
            "p_allowed_recipients": ["koaryu@outlook.com"],
            "p_scope_fingerprint": FINGERPRINT,
            "p_rendered": rendered(),
        },
        service.Begun,
        begun(),
    ),
    (
        service.SETTLE,
        service.SettleRequest,
        {
            **SCOPE,
            "p_attempt_id": ATTEMPT,
            "p_result": ACCEPTED,
        },
        service.Settled,
        settled(),
    ),
    (
        service.CURRENT,
        service.CurrentRequest,
        {
            **ACTOR_SCOPE,
            "p_test_delivery_id": TEST,
        },
        service.Current,
        current(),
    ),
]
PRIVATE_CASES = [
    *[(request_type, params) for _, request_type, params, _, _ in RPC_CASES],
    *[(result_type, payload) for _, _, _, result_type, payload in RPC_CASES],
    (service.Runtime, RUNTIME),
    (service.TriggerContext, {"program_id": None, "offset_minutes": None}),
    (service.Execution, execution()),
    (service.Rendered, rendered()),
    (service.Message, attempt()["message"]),
    (service.Attempt, attempt()),
    (service._Result, public()),
    (service._Acknowledgment, public()),
]


def sdk_result(case, response):
    name, request_type, params, result_type, _ = case
    requests = []

    def handler(request):
        requests.append(request)
        return (
            response if isinstance(response, httpx.Response) else httpx.Response(200, json=response)
        )

    client = MockPostgrestClient(handler, 5.0)
    clock = Clock()
    try:
        result = service._test_rpc(
            _WorkerClient(client, _WorkerBudget(125.0, clock)),
            name,
            request_type.model_validate(params),
            result_type,
        )
        assert len(requests) == 1
        assert json.loads(requests[0].content) == params
        return result
    finally:
        client.aclose()


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
def test_every_rpc_uses_exact_closed_envelope_with_real_sdk(case):
    result = sdk_result(case, {"payload": case[-1]})
    assert isinstance(result, case[-2])


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
@pytest.mark.parametrize(
    "response", [None, [], "private", 12, {}, {"payload": None}, {"payload": {}, "extra": True}]
)
def test_every_rpc_rejects_malformed_sdk_success(case, response):
    assert_unavailable(lambda: sdk_result(case, response))


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"not-json"),
        httpx.Response(200, json={"message": "PRIVATE SQL message", "code": "P0001"}),
        httpx.Response(500, json={"message": "PRIVATE SQL message", "code": "XX001"}),
    ],
)
def test_every_rpc_hides_installed_sdk_parser_and_error_diagnostics(case, response):
    assert_unavailable(lambda: sdk_result(case, response))


@pytest.mark.parametrize(
    "model,value", PRIVATE_CASES, ids=lambda arg: getattr(arg, "__name__", "payload")
)
def test_every_private_object_is_closed_and_every_field_is_required(model, value):
    parsed = model.model_validate(value)
    assert parsed is not None
    for key in model.model_fields:
        if key not in value:
            continue
        without = deepcopy(value)
        without.pop(key)
        with pytest.raises(ValidationError):
            model.model_validate(without)
    with pytest.raises(ValidationError):
        model.model_validate({**value, "recipient_override": "private@example.com"})


@pytest.mark.parametrize(
    "model,value", PRIVATE_CASES, ids=lambda arg: getattr(arg, "__name__", "payload")
)
def test_private_objects_and_validation_strings_hide_tokens_and_message_data(model, value):
    parsed = model.model_validate(value)
    assert repr(parsed) == model.__name__ + "()"
    assert str(parsed) == ""
    with pytest.raises(ValidationError) as caught:
        model.model_validate({**value, "PRIVATE_FIELD": "PRIVATE_SECRET"})
    assert "PRIVATE_SECRET" not in str(caught.value)
    assert "koaryu@outlook.com" not in str(caught.value)
    assert EXECUTION not in str(caught.value)


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
def test_every_request_corresponding_identity_echo_is_checked(case):
    _, _, params, _, payload = case
    for field in (
        "studio_id",
        "actor_id",
        "workflow_id",
        "test_delivery_id",
        "preparation_id",
        "attempt_id",
    ):
        if field in payload and "p_" + field in params:
            changed = deepcopy(payload)
            changed[field] = OTHER
            assert_unavailable(lambda changed=changed: sdk_result(case, {"payload": changed}))
    result = payload.get("result")
    if result is not None:
        for field in ("operation_id", "test_delivery_id"):
            if "p_" + field in params or field in payload:
                changed = deepcopy(payload)
                changed["result"][field] = OTHER
                assert_unavailable(lambda changed=changed: sdk_result(case, {"payload": changed}))


@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize("has_execution", [False, True])
def test_reserve_fresh_replay_grant_matrix(replayed, has_execution):
    payload = reserved(replayed=replayed, execution=execution() if has_execution else None)
    if replayed != has_execution:
        assert service.Reserved.model_validate(payload).replayed == replayed
    else:
        with pytest.raises(ValidationError):
            service.Reserved.model_validate(payload)


@pytest.mark.parametrize("outcome", ["begun", "already_begun", "stopped", "lease_lost"])
@pytest.mark.parametrize("state", [None, "queued", "sending", "accepted", "failed", "unknown"])
@pytest.mark.parametrize("has_attempt", [False, True])
def test_complete_begin_result_nullability_and_state_matrix(outcome, state, has_attempt):
    valid = (
        outcome == "begun"
        and state == "sending"
        and has_attempt
        or outcome == "already_begun"
        and state in {"sending", "accepted", "failed", "unknown"}
        and not has_attempt
        or outcome == "stopped"
        and state == "failed"
        and not has_attempt
        or outcome == "lease_lost"
        and state is None
        and not has_attempt
    )
    payload = begun(
        outcome=outcome,
        result=None if state is None else public(state),
        attempt=attempt() if has_attempt else None,
    )
    if valid:
        assert service.Begun.model_validate(payload).outcome == outcome
    else:
        with pytest.raises(ValidationError):
            service.Begun.model_validate(payload)


@pytest.mark.parametrize("updated", [False, True])
@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize("state", [None, "queued", "sending", "accepted", "failed", "unknown"])
def test_complete_preflight_finish_matrix(updated, replayed, state):
    valid = updated and state == "failed" or not updated and not replayed and state is None
    payload = finished(updated=updated, replayed=replayed, result=public(state) if state else None)
    if valid:
        assert service.Finished.model_validate(payload).updated == updated
    else:
        with pytest.raises(ValidationError):
            service.Finished.model_validate(payload)


@pytest.mark.parametrize("updated", [False, True])
@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize("state", [None, "queued", "sending", "accepted", "failed", "unknown"])
@pytest.mark.parametrize(
    "result_state", [None, "queued", "sending", "accepted", "failed", "unknown"]
)
def test_complete_settlement_truth_and_null_matrix(updated, replayed, state, result_state):
    valid = (
        updated
        and state in {"accepted", "failed", "unknown"}
        and result_state == state
        or not updated
        and not replayed
        and state is None
        and result_state is None
    )
    payload = settled(
        updated=updated,
        replayed=replayed,
        state=state,
        result=public(result_state) if result_state else None,
    )
    if valid:
        assert service.Settled.model_validate(payload).updated == updated
    else:
        with pytest.raises(ValidationError):
            service.Settled.model_validate(payload)


@pytest.mark.parametrize("allowed", [False, True])
@pytest.mark.parametrize("mode", ["ready", "cooldown", "auth_blocked"])
@pytest.mark.parametrize("token", [None, TOKEN])
@pytest.mark.parametrize("probe", [None, PROBE])
@pytest.mark.parametrize("lease", [None, LEASE])
@pytest.mark.parametrize("retry", [None, LEASE])
@pytest.mark.parametrize("reason", [None, "sender_unavailable"])
def test_complete_test_preparation_grant_matrix(allowed, mode, token, probe, lease, retry, reason):
    valid = (
        allowed
        and token is not None
        and lease is not None
        and retry is None
        and reason is None
        and (probe is not None) == (mode != "ready")
        or not allowed
        and token is None
        and probe is None
        and lease is None
        and reason is not None
    )
    payload = claimed(
        allowed=allowed,
        mode=mode,
        preparation_token=token,
        probe_token=probe,
        lease_expires_at=lease,
        retry_at=retry,
        reason=reason,
    )
    if valid:
        assert service.PreparationClaim.model_validate(payload).allowed == allowed
    else:
        with pytest.raises(ValidationError):
            service.PreparationClaim.model_validate(payload)


@pytest.mark.parametrize("field", ["replayed", "allowed", "updated"])
@pytest.mark.parametrize("value", [0, 1, "true", None])
def test_private_booleans_never_coerce(field, value):
    model, base = {
        "replayed": (service.Reserved, reserved()),
        "allowed": (service.PreparationClaim, claimed()),
        "updated": (service.Finished, finished()),
    }[field]
    with pytest.raises(ValidationError):
        model.model_validate({**base, field: value})


@pytest.mark.parametrize(
    "field,value",
    [
        ("execution_token", 1),
        ("execution_token", TOKEN.upper().replace("-", "")),
        ("execution_token", "{" + TOKEN + "}"),
        ("scope_fingerprint", "F" * 64),
        ("scope_fingerprint", "f" * 63),
        ("reference_time", "2026-10-05T21:00:00"),
        ("reference_time", float("nan")),
        ("reference_time", "10000-01-01T00:00:00Z"),
        ("lease_expires_at", NOW.isoformat()),
        ("recipient_email", "USER@example.com"),
        ("reply_to", "reply@example.com\nBcc: injected@example.com"),
        ("subject_template", "x\x00y"),
        ("body_template", "x\ud800y"),
    ],
)
def test_private_bounds_and_canonical_identities(field, value):
    with pytest.raises(ValidationError):
        service.Execution.model_validate(execution(**{field: value}))


@pytest.mark.parametrize("event", list(CATALOG["triggers"]))
@pytest.mark.parametrize("offset", [None, -1, -129600, 0, -129601, True, "-1"])
def test_trigger_context_offset_null_and_strict_integer_matrix(event, offset):
    data = request_for(event)
    payload = execution(data)
    payload["trigger_context"]["offset_minutes"] = offset
    valid = (offset is None and not CATALOG["triggers"][event]["supports_offset"]) or (
        CATALOG["triggers"][event]["supports_offset"]
        and type(offset) is int
        and -129600 <= offset <= -1
    )
    if valid:
        service.Execution.model_validate(payload)
    else:
        with pytest.raises(ValidationError):
            service.Execution.model_validate(payload)


@pytest.mark.parametrize("event", list(CATALOG["triggers"]))
def test_trigger_program_filter_matrix(event):
    payload = execution(request_for(event))
    payload["trigger_context"]["program_id"] = OTHER
    if CATALOG["triggers"][event]["supports_program_filter"]:
        service.Execution.model_validate(payload)
    else:
        with pytest.raises(ValidationError):
            service.Execution.model_validate(payload)


@pytest.mark.parametrize(
    "subject,body",
    [
        ("x" * 200, "x" * 20000),
        ("\U0001f642" * 200, "\U0001f642" * 20000),
        ("Subject", '"' * 20000),
    ],
)
def test_exact_synthetic_content_size_limits(subject, body):
    content = assemble_synthetic_test_email(subject, body)
    parsed = service.Rendered.model_validate(
        {key: getattr(content, key) for key in service.Rendered.model_fields}
    )
    assert len(parsed.subject.encode("utf8")) <= 807
    assert len(parsed.text_body.encode("utf8")) <= 80046
    assert len(parsed.html_body.encode("utf8")) <= 120317


@pytest.mark.parametrize(
    "field,value",
    [
        ("subject", "Ordinary"),
        ("subject", "[Test] "),
        ("subject", "[Test] " + "x" * 201),
        ("subject", "[Test] x\ny"),
        ("subject", "[Test] x\x7fy"),
        ("text_body", "Ordinary"),
        ("text_body", "Synthetic automation test. Sample data only.\n\n"),
        ("text_body", "Synthetic automation test. Sample data only.\n\nx\ry"),
        ("text_body", "Synthetic automation test. Sample data only.\n\n" + "x" * 20001),
        ("html_body", "x" * 120318),
        ("html_body", "<script>private</script>"),
    ],
)
def test_synthetic_rendered_profile_rejects_unsafe_labels_controls_size_and_html(field, value):
    with pytest.raises(ValidationError):
        service.Rendered.model_validate({**rendered(), field: value})


@pytest.mark.parametrize(
    "reason",
    [
        "invalid_email_template",
        "invalid_email_context",
        "unsupported_currency",
        "invalid_email_url",
        "facts_unavailable",
        "sender_unavailable",
        "subscription_required",
        "recipient_changed",
        "recipient_suppressed",
        "lease_expired",
        "budget_exhausted",
    ],
)
def test_exact_preflight_reason_set(reason):
    assert service.FinishRequest(**SCOPE, p_reason=reason).p_reason == reason


@pytest.mark.parametrize(
    "reason", ["provider_rejected", "accepted", "private@example.com", "retry_wait", None]
)
def test_preflight_rejects_provider_or_unbound_reasons(reason):
    with pytest.raises(ValidationError):
        service.FinishRequest(**SCOPE, p_reason=reason)


@pytest.mark.parametrize("field", ["workflow_id", "operation_id", "test_delivery_id"])
def test_post_recovery_requires_original_workflow_operation_and_test(scope, field):
    scope.replay = True
    payload = current("accepted")
    if field == "workflow_id":
        payload[field] = OTHER
    else:
        payload["result"][field] = OTHER
    scope.handlers[service.CURRENT] = {"payload": payload}
    assert_unavailable(scope.run)
    scope.transport_factory.assert_not_called()


@pytest.mark.parametrize("phase", [service.PREPARE, service.BEGIN])
@pytest.mark.parametrize(
    "cause",
    ["recipient_changed", "recipient_suppressed", "role_removed", "frequency", "consumed_grant"],
)
def test_sql_current_admission_refusal_cannot_be_overridden(scope, phase, cause):
    if phase == service.PREPARE:
        scope.handlers[phase] = lambda params: {
            "payload": claimed(
                params,
                allowed=False,
                preparation_token=None,
                lease_expires_at=None,
                reason=cause,
            )
        }
    else:
        scope.handlers[phase] = {
            "payload": begun(outcome="stopped", result=public("failed"), attempt=None)
        }
    assert scope.run().state == "failed"
    scope.transport.send_prepared.assert_not_called()
    assert len(scope.params(service.BEGIN)) <= 1


@pytest.mark.parametrize(
    "error",
    [
        "invalid_email_template",
        "invalid_email_context",
        "unsupported_currency",
        "invalid_email_url",
        "facts_unavailable",
    ],
)
def test_renderer_failure_uses_exact_closed_preflight_reason(scope, monkeypatch, error):
    monkeypatch.setattr(
        service, "render_workflow_email", Mock(side_effect=WorkflowEmailRenderError(error))
    )
    assert scope.run().state == "failed"
    assert scope.params(service.FINISH)[0]["p_reason"] == error
    scope.transport_factory.assert_not_called()


def test_no_second_finish_or_current_read_on_failed_recovery(scope):
    scope.handlers[service.FINISH] = None
    scope.handlers[service.CURRENT] = None
    scope.transport.prepare.side_effect = None
    scope.transport.prepare.return_value = None
    assert_unavailable(scope.run)
    assert len(scope.params(service.FINISH)) == len(scope.params(service.CURRENT)) == 1


def test_no_second_current_read_when_possible_begin_recovery_fails(scope):
    scope.handlers[service.BEGIN] = None
    scope.handlers[service.CURRENT] = None
    assert_unavailable(scope.run)
    assert len(scope.params(service.BEGIN)) == len(scope.params(service.CURRENT)) == 1
    assert not scope.params(service.FINISH)


@pytest.mark.parametrize("phase", [service.PREPARE, PREPARED])
@pytest.mark.parametrize("failure", ["lost", "malformed", "missing_rpc"])
def test_unconfirmed_preparation_keeps_scope_and_possible_probe_for_explicit_recovery(
    scope, phase, failure
):
    scope.preparation_mode = "auth_blocked"
    if failure == "lost":
        scope.handlers[phase] = httpx.ReadTimeout("PRIVATE committed probe response lost")
    elif failure == "malformed":
        scope.handlers[phase] = {"payload": {"private": "malformed grant"}}
    else:
        scope.handlers[phase] = httpx.Response(
            404, json={"code": "PGRST202", "message": "PRIVATE missing RPC"}
        )
    assert_unavailable(scope.run)
    assert len(scope.params(phase)) == 1
    assert not scope.params(service.FINISH) and not scope.params(service.CURRENT)
    assert not scope.params(service.BEGIN) and not scope.params(service.SETTLE)
    scope.transport.send_prepared.assert_not_called()
    assert scope.transport.prepare.call_count == int(phase == PREPARED)
    assert scope.read().state == "queued"
    assert len(scope.params(service.CURRENT)) == 1


def test_test_preparation_preserves_current_authorization_error(scope):
    scope.handlers[service.PREPARE] = httpx.Response(
        403,
        json={
            "code": "42501",
            "message": "AUTOMATION_ADMIN_REQUIRED",
            "details": "PRIVATE",
        },
    )
    with pytest.raises(HTTPException) as caught:
        scope.run()
    assert caught.value.status_code == 403 and caught.value.detail == service.ADMIN_REQUIRED_DETAIL
    assert not scope.params(service.FINISH) and not scope.params(service.CURRENT)
    scope.transport_factory.assert_not_called()


def test_local_budget_refusal_before_preparation_settlement_is_not_a_lost_rpc(scope):
    def prepare(**kwargs):
        scope.clock.now = 115.0
        return scope.prepared

    scope.transport.prepare.side_effect = prepare
    assert scope.run().state == "failed"
    assert not scope.params(PREPARED)
    assert scope.params(service.FINISH)[0]["p_reason"] == "budget_exhausted"
    scope.transport.send_prepared.assert_not_called()
    assert not scope.params(service.CURRENT)


@pytest.mark.parametrize(
    "code,message",
    [
        ("P0002", "AUTOMATION_NOT_FOUND"),
        ("22023", "AUTOMATION_INVALID_REQUEST"),
        ("P0001", "AUTOMATION_REVISION_CONFLICT"),
        ("P0001", "AUTOMATION_OPERATION_CONFLICT"),
        ("P0001", "AUTOMATION_STATE_CONFLICT"),
        ("P0001", "AUTOMATION_STUDIO_BUSY"),
    ],
)
def test_failed_preparation_claim_non_authorization_errors_are_always_unavailable(
    scope, code, message
):
    scope.handlers[service.PREPARE] = httpx.Response(400, json={"code": code, "message": message})
    assert_unavailable(scope.run)
    assert not scope.params(service.FINISH) and not scope.params(service.CURRENT)
    scope.transport_factory.assert_not_called()


def test_gate_can_enable_flag_is_not_test_admission_authority(scope, monkeypatch):
    monkeypatch.setattr(
        service,
        "email_delivery_status",
        lambda *_: {
            "configured": True,
            "can_enable": False,
            "test_recipient": "untrusted@example.com",
        },
    )
    scope.preparation_mode = "auth_blocked"
    assert scope.run().state == "accepted"
    assert scope.transport.send_prepared.call_args.args[0].to_address == "koaryu@outlook.com"
    assert scope.params("claim_automation_sender_preparation_v1") == []


def test_unrestricted_allowlist_still_uses_only_sql_derived_pinned_address(scope):
    scope.settings = deepcopy(scope.settings)
    scope.settings.EMAIL_ALLOWED_RECIPIENTS = ""
    destination = "current-verified-admin@example.com"
    scope.handlers[service.CREATE] = {
        "payload": reserved(execution=execution(recipient_email=destination))
    }
    approved = attempt()
    approved["message"]["to_address"] = destination
    scope.handlers[service.BEGIN] = {"payload": begun(attempt=approved)}
    assert scope.run().state == "accepted"
    assert scope.params(service.CREATE)[0]["p_runtime"]["allowed_recipients"] == []
    assert scope.params(service.PREPARE)[0]["p_allowed_recipients"] == []
    assert scope.transport.send_prepared.call_args.args[0].to_address == destination
