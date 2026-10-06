"""Synthetic SQL grants exercise the unmounted consumer, never source authority."""

from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import HTTPException
from test_automation_email import email_settings
from test_automation_service import (
    ATTEMPT_ID,
    LEASE,
    Clock,
    WorkerDatabase,
    preparation_claim,
    preparation_settled,
    prepared_sender,
)
from test_workflow_capabilities import V38, exact_preflight_row

from app.schemas import workflow_dispatch as dto
from app.services import automation_service as shared
from app.services import workflow_dispatcher as worker
from app.services.automation_email import (
    DeliveryResult,
    delivery_configuration,
    sender_identity_binding,
)
from app.services.workflow_capabilities import RELEASE_PREFLIGHT_RPC
from app.services.workflow_email import render_workflow_email
from app.services.workflow_simulation_service import _decode_facts

STUDIO = str(UUID(int=501))
RUN = str(UUID(int=601))
TOKEN = str(UUID(int=701))
OTHER = str(UUID(int=801))
NODE = "email"
CLAIM_RPC = "claim_automation_workflow_runs_v1"
ADVANCE = "advance_automation_workflow_run_v1"
DEFER = "defer_automation_workflow_run_v1"
PLAN = "get_workflow_email_plan_v1"
RESOLVE = "resolve_workflow_email_without_attempt_v1"
BEGIN = "begin_workflow_email_v1"
SETTLE = "settle_workflow_email_v1"
PREPARE = "claim_automation_sender_preparation_v1"
PREPARED = "settle_automation_sender_preparation_v1"
SCOPE = {"studio_id": STUDIO, "run_id": RUN, "claim_token": TOKEN}


def position(state="running", node=NODE, reason=None):
    return {
        "state": state,
        "current_node_id": node,
        "next_due_at": LEASE if state in {"queued", "waiting", "claimed", "running"} else None,
        "reason": reason,
    }


def claim(**changes):
    return {**SCOPE, "lease_expires_at": LEASE, **changes}


def facts(**changes):
    return {
        "source_decision": "eligible",
        "source_reason": None,
        "condition_facts": {},
        "template_facts": {
            "studio_name": {"kind": "text", "value": "Example"},
            "lead_first_name": {"kind": "text", "value": "Sam"},
        },
        "anchors": {},
        "recipients": {
            "lead_or_guardian": {
                "decision": "ready",
                "reason": None,
                "template_facts": {
                    "recipient_name": {"kind": "text", "value": "Selected Guardian"}
                },
            }
        },
        **changes,
    }


def plan(**changes):
    return {
        "fingerprint": "f" * 64,
        "disposition": "send",
        "reason": None,
        "event_type": "lead.created",
        "recipient_policy": "lead_or_guardian",
        "recipient_email": "koaryu@outlook.com",
        "recipient_kind": "guardian",
        "subject_template": "Hi {{recipient_name}}",
        "body_template": "{{lead_first_name}} at {{studio_name}}",
        "reply_to": "reply@example.com",
        "unsubscribe_token": "a" * 64,
        "unsubscribe_url": "https://api.example.com/api/v1/automations/unsubscribe#" + "a" * 64,
        "facts": facts(),
        **changes,
    }


def echo(params, *, node=False):
    keys = ["studio_id", "run_id", "claim_token"] + (["node_id"] if node else [])
    return {key: params["p_" + key] for key in keys}


def transition(outcome="email", run=None, **changes):
    return {**SCOPE, "outcome": outcome, "run": run if run is not None else position(), **changes}


def planned(**changes):
    return {
        **SCOPE,
        "node_id": NODE,
        "outcome": "planned",
        "run": position(),
        "plan": plan(),
        **changes,
    }


def begun(settings, **changes):
    selected = dto.Plan.model_validate(plan())
    decoded = _decode_facts(
        selected.facts, selected.event_type, frozenset({selected.recipient_policy})
    )
    content = render_workflow_email(
        selected.event_type,
        selected.subject_template,
        selected.body_template,
        {**decoded.template_facts, **decoded.recipients[selected.recipient_policy].template_facts},
        unsubscribe_url=selected.unsubscribe_url,
    )
    return {
        **SCOPE,
        "node_id": NODE,
        "outcome": "begun",
        "run": position("sending"),
        "attempt": {
            "id": ATTEMPT_ID,
            "attempt_number": 1,
            "lease_expires_at": LEASE,
            "credential_revision": 1,
            "sender_binding": sender_identity_binding(delivery_configuration(settings)),
            "message": {
                "to_address": selected.recipient_email,
                "reply_to": selected.reply_to,
                "attempt_id": ATTEMPT_ID,
                "subject": content.subject,
                "text_body": content.text_body,
                "html_body": content.html_body,
            },
        },
        **changes,
    }


def settled(state="accepted", **changes):
    return {
        "studio_id": STUDIO,
        "attempt_id": ATTEMPT_ID,
        "updated": True,
        "replayed": False,
        "state": state,
        "reason": None,
        "run": position("unknown" if state == "unknown" else "queued", node="end"),
        **changes,
    }


class WorkflowDatabase(WorkerDatabase):
    def __init__(self, settings):
        super().__init__(settings)
        self.workflow_claims = [claim()]
        self.graph_handlers = {}
        self.transition_queue = []
        self.selected_plan = plan()
        self.claim_has_more = False

    def rpc(self, name, params):
        if name not in {CLAIM_RPC, ADVANCE, DEFER, PLAN, RESOLVE, BEGIN, SETTLE}:
            return super().rpc(name, params)
        self.calls.append((name, params))

        def execute():
            self.executed.append((name, params))
            if self.on_execute:
                self.on_execute(name, params)
            if name in self.graph_handlers:
                result = self.graph_handlers[name]
                if isinstance(result, Exception):
                    raise result
                result = result(params) if callable(result) else result
            elif name == CLAIM_RPC:
                assert params == {"p_limit": 1}
                result = {
                    "claims": self.workflow_claims[:1],
                    "has_more": len(self.workflow_claims) > 1 or self.claim_has_more,
                }
                self.workflow_claims = self.workflow_claims[1:]
            elif name == ADVANCE:
                result = {
                    **echo(params),
                    **(
                        self.transition_queue.pop(0)
                        if self.transition_queue
                        else {"outcome": "email", "run": position()}
                    ),
                }
            elif name == DEFER:
                result = {
                    **echo(params),
                    "outcome": "waiting",
                    "run": position("waiting", reason=params["p_reason"]),
                }
            elif name == PLAN:
                result = {
                    **echo(params, node=True),
                    "outcome": "planned",
                    "run": position(),
                    "plan": deepcopy(self.selected_plan),
                }
            elif name == RESOLVE:
                result = {
                    **echo(params, node=True),
                    "outcome": "waiting",
                    "run": position("waiting"),
                }
            elif name == BEGIN:
                result = begun(self.settings)
                result.update(echo(params, node=True))
                result["attempt"]["message"].update(params["p_rendered"])
                result["attempt"]["message"]["to_address"] = self.selected_plan["recipient_email"]
                result["attempt"]["message"]["reply_to"] = self.selected_plan["reply_to"]
            else:
                result = settled(
                    {
                        "accepted": "accepted",
                        "unknown": "unknown",
                        "retryable_failure": "failed",
                        "permanent_failure": "failed",
                    }[params["p_result"]["outcome"]]
                )
                result["studio_id"] = params["p_studio_id"]
                result["attempt_id"] = params["p_attempt_id"]
            return SimpleNamespace(data={"payload": result})

        return SimpleNamespace(execute=execute)


@pytest.fixture
def runner(monkeypatch):
    settings = email_settings(AUTOMATION_WORKER_ENABLED=True)
    database = WorkflowDatabase(settings)
    clock = Clock()
    handle = prepared_sender(settings)
    transport = SimpleNamespace(
        prepare=Mock(return_value=handle),
        send_prepared=Mock(return_value=DeliveryResult("accepted")),
    )
    factory = Mock(return_value=database)
    closer = Mock()
    transport_factory = Mock(return_value=transport)
    access = Mock(return_value={"subscription_required": False})
    monkeypatch.setattr(worker, "get_platform_subscription_access", access)

    def run(**kwargs):
        return worker.process_due_workflow_automations(
            settings,
            clock=clock,
            client_factory=factory,
            client_closer=closer,
            transport_factory=transport_factory,
            **kwargs,
        ).model_dump()

    return SimpleNamespace(
        settings=settings,
        database=database,
        clock=clock,
        handle=handle,
        transport=transport,
        factory=factory,
        closer=closer,
        transport_factory=transport_factory,
        access=access,
        run=run,
        requests=lambda name: [params for called, params in database.executed if called == name],
    )


def assert_counts(result, *, claimed=1, processed=1, **expected):
    assert result["claimed"] == claimed and result["processed"] == processed
    assert (
        sum(
            result[k]
            for k in (
                "accepted",
                "retry_wait",
                "failed",
                "unknown",
                "skipped",
                "completed",
                "waiting",
            )
        )
        == processed
    )
    for key, value in expected.items():
        assert result[key] == value


def test_exact_plan_render_prepare_begin_send_settle_and_release(runner):
    assert_counts(runner.run(limit=1), accepted=1, has_more=True)
    runner.factory.assert_called_once_with(postgrest_client_timeout=5.0)
    runner.closer.assert_called_once_with(runner.database)
    assert runner.access.call_args.kwargs == {"allow_provider_repairs": False, "read_only": True}
    message, handle = runner.transport.send_prepared.call_args.args
    assert handle is runner.handle and message.subject == "Hi Selected Guardian"
    assert message.reply_to == "reply@example.com" and message.attempt_id == ATTEMPT_ID
    assert runner.transport.send_prepared.call_args.kwargs == {"deadline": 120.0}
    begin = runner.requests(BEGIN)[0]
    assert {k: getattr(message, k) for k in dto.Rendered.model_fields} == begin["p_rendered"]
    assert begin["p_unsubscribe_token"] == "a" * 64
    assert len(runner.requests(PLAN)[0]["p_candidate_unsubscribe_token"]) == 64
    assert runner.requests(PLAN)[0]["p_candidate_unsubscribe_token"] != "a" * 64
    assert runner.requests(SETTLE)[0]["p_result"]["submission_evidence"] is None
    assert [name for name, _ in runner.database.executed] == [
        RELEASE_PREFLIGHT_RPC,
        V38,
        CLAIM_RPC,
        ADVANCE,
        "get_automation_email_credential_v1",
        PLAN,
        PREPARE,
        PREPARED,
        BEGIN,
        SETTLE,
    ]


@pytest.mark.parametrize("flag", [False, None, 0, "true"])
def test_worker_disabled_never_creates_client(runner, flag):
    runner.settings.AUTOMATION_WORKER_ENABLED = flag
    assert_counts(runner.run(), claimed=0, processed=0, has_more=False)
    runner.factory.assert_not_called()


@pytest.mark.parametrize("limit", [False, 0, 11, "1", 1.0, None])
def test_strict_limit_before_flags(runner, limit):
    runner.settings.AUTOMATION_WORKER_ENABLED = False
    with pytest.raises(ValueError, match="limit"):
        runner.run(limit=limit)
    runner.factory.assert_not_called()


@pytest.mark.parametrize(
    "bad",
    [
        None,
        {},
        {"ready": True},
        RuntimeError("private missing function"),
        {**exact_preflight_row(), "manifest_version": "release-db-attestation-v56"},
    ],
)
def test_real_readiness_fails_closed_before_any_claim(runner, bad):
    runner.database.handlers[V38] = bad
    with pytest.raises(HTTPException) as exc:
        runner.run()
    assert exc.value.status_code == 503 and exc.value.detail == shared.UNAVAILABLE_DETAIL
    assert not runner.requests(CLAIM_RPC) and not runner.requests(PREPARE)
    runner.transport_factory.assert_not_called()
    runner.closer.assert_called_once()


@pytest.mark.parametrize("send_enabled", [True, False])
def test_internal_work_uses_sql_without_mail_setup(runner, send_enabled):
    runner.settings.EMAIL_SEND_ENABLED = send_enabled
    runner.settings.EMAIL_GRAPH_CLIENT_SECRET = ""
    runner.database.transition_queue = [
        {"outcome": "continue", "run": position(node="followup")},
        {"outcome": "stopped", "run": position("completed", node="end")},
    ]
    assert_counts(runner.run(limit=1), completed=1)
    assert len(runner.requests(ADVANCE)) == 2 and not runner.requests(PLAN)
    assert not any(name.startswith("get_automation_email") for name, _ in runner.database.executed)
    runner.transport_factory.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"EMAIL_SEND_ENABLED": False},
        {"EMAIL_PROVIDER": "disabled"},
        {"EMAIL_GRAPH_CLIENT_SECRET": ""},
        {"AUTOMATION_PUBLIC_API_URL": "https://api.example.com/" + "x" * 1950},
    ],
)
def test_reached_paused_or_unconfigured_email_defers_without_attempt(runner, changes):
    for key, value in changes.items():
        setattr(runner.settings, key, value)
    assert_counts(runner.run(limit=1), waiting=1)
    assert runner.requests(DEFER)[0]["p_reason"] == "sender_unavailable"
    assert not runner.requests(PLAN) and not runner.requests(PREPARE)
    runner.transport_factory.assert_not_called()


@pytest.mark.parametrize(
    "access,reason",
    [
        ({"subscription_required": True}, "subscription_required"),
        ({}, "facts_unavailable"),
        (HTTPException(503, "private"), "facts_unavailable"),
    ],
)
def test_entitlement_denial_defers_before_sql_effects(runner, access, reason):
    if isinstance(access, Exception):
        runner.access.side_effect = access
    else:
        runner.access.return_value = access
    assert_counts(runner.run(limit=1), waiting=1)
    assert runner.requests(DEFER)[0]["p_reason"] == reason
    assert not runner.requests(ADVANCE) and not runner.requests(PREPARE)


def test_entitlement_is_rechecked_per_claim_same_studio(runner):
    runner.database.workflow_claims.append(claim(run_id=OTHER, claim_token=OTHER))
    runner.database.graph_handlers[ADVANCE] = lambda p: {
        **echo(p),
        "outcome": "stopped",
        "run": position("completed"),
    }
    assert_counts(runner.run(limit=2), claimed=2, processed=2, completed=2)
    assert runner.access.call_count == 2
    assert all(p == {"p_limit": 1} for p in runner.requests(CLAIM_RPC))


@pytest.mark.parametrize(
    "outcome,state,expected",
    [
        ("waiting", "waiting", "waiting"),
        ("stopped", "completed", "completed"),
        ("stopped", "cancelled", "skipped"),
        ("stopped", "failed", "skipped"),
        ("stopped", "unknown", "unknown"),
        ("lease_lost", None, "skipped"),
    ],
)
def test_authoritative_advance_dispositions(runner, outcome, state, expected):
    runner.database.graph_handlers[ADVANCE] = {
        **transition(outcome),
        "run": position(state) if state else None,
    }
    assert_counts(runner.run(limit=1), **{expected: 1})
    assert not runner.requests(PLAN)


@pytest.mark.parametrize("name", [CLAIM_RPC, ADVANCE, DEFER, PLAN, RESOLVE, PREPARE, PREPARED])
def test_lost_non_begin_rpc_never_retries_or_submits(runner, name):
    if name == DEFER:
        runner.access.return_value = {"subscription_required": True}
    if name == RESOLVE:
        runner.database.selected_plan.update(disposition="wait", reason="facts_unavailable")
    target = (
        runner.database.graph_handlers
        if name in {CLAIM_RPC, ADVANCE, DEFER, PLAN, RESOLVE}
        else runner.database.handlers
    )
    target[name] = RuntimeError("private SQL token or facts")
    with pytest.raises(HTTPException) as exc:
        runner.run()
    assert exc.value.detail == shared.UNAVAILABLE_DETAIL
    assert len(runner.requests(name)) == 1
    runner.transport.send_prepared.assert_not_called()
    runner.closer.assert_called_once()


def test_transition_limit_authoritatively_defers_without_python_graph_walk(runner):
    runner.database.graph_handlers[ADVANCE] = transition("continue")
    assert_counts(runner.run(limit=1), waiting=1)
    assert len(runner.requests(ADVANCE)) == 40
    assert all(p["p_step_limit"] == 1 for p in runner.requests(ADVANCE))
    assert runner.requests(DEFER)[0]["p_reason"] == "facts_unavailable"


@pytest.mark.parametrize("disposition", ["skip", "wait", "stop"])
def test_non_send_plan_uses_fingerprint_bound_sql_resolution(runner, disposition):
    runner.database.selected_plan.update(
        disposition=disposition, reason="contact_changed", recipient_email=None
    )
    assert_counts(runner.run(limit=1), waiting=1)
    resolution = runner.requests(RESOLVE)[0]
    assert resolution["p_resolution"] == {"kind": "plan_decision"}
    assert resolution["p_plan_fingerprint"] == "f" * 64
    assert resolution["p_unsubscribe_token"] == "a" * 64
    assert not runner.requests(BEGIN)
    runner.transport_factory.assert_not_called()


def test_resolver_continue_retains_same_claim_for_fresh_sql_advance(runner):
    runner.database.selected_plan.update(disposition="skip", reason="suppressed")
    runner.database.graph_handlers[RESOLVE] = {
        **SCOPE,
        "node_id": NODE,
        "outcome": "continue",
        "run": position(node="followup"),
    }
    runner.database.transition_queue = [
        {"outcome": "email", "run": position()},
        {"outcome": "stopped", "run": position("completed", node="end")},
    ]
    assert_counts(runner.run(limit=1), completed=1)
    assert len(runner.requests(CLAIM_RPC)) == 1 and len(runner.requests(ADVANCE)) == 2
    assert all(p["p_claim_token"] == TOKEN for p in runner.requests(ADVANCE))


@pytest.mark.parametrize(
    "reason,kind",
    [
        ("facts_unavailable", "facts_unavailable"),
        ("unsupported_currency", "render_failed"),
        ("invalid_email_template", "render_failed"),
        ("invalid_email_context", "render_failed"),
        ("invalid_email_url", "sender_unavailable"),
    ],
)
def test_render_failure_has_only_bound_no_attempt_resolution(runner, monkeypatch, reason, kind):
    monkeypatch.setattr(
        worker, "render_workflow_email", Mock(side_effect=worker.WorkflowEmailRenderError(reason))
    )
    assert_counts(runner.run(limit=1), waiting=1)
    expected = {"kind": kind, **({"reason": reason} if kind == "render_failed" else {})}
    assert runner.requests(RESOLVE)[0]["p_resolution"] == expected
    assert not runner.requests(PREPARE) and not runner.requests(BEGIN)


def test_missing_selected_name_remains_missing_and_defers(runner):
    runner.database.selected_plan["facts"]["recipients"]["lead_or_guardian"]["template_facts"] = {}
    assert_counts(runner.run(limit=1), waiting=1)
    assert runner.requests(RESOLVE)[0]["p_resolution"] == {"kind": "facts_unavailable"}


@pytest.mark.parametrize("where", [BEGIN, RESOLVE])
@pytest.mark.parametrize("repeat", [False, True])
def test_one_stale_refresh_then_bound_defer_or_success(runner, where, repeat):
    if where == RESOLVE:
        runner.database.selected_plan.update(disposition="wait", reason="facts_unavailable")
    responses = 0

    def reply(params):
        nonlocal responses
        responses += 1
        if where == RESOLVE:
            # Time-dependent eligibility can become send without a fingerprint change.
            runner.database.selected_plan.update(disposition="send", reason=None)
            if repeat:
                runner.database.graph_handlers[BEGIN] = {
                    **SCOPE,
                    "node_id": NODE,
                    "outcome": "stale_plan",
                    "run": position(),
                    "attempt": None,
                }
        if repeat or responses == 1:
            return {
                **echo(params, node=True),
                "outcome": "stale_plan",
                "run": position(),
                **({"attempt": None} if where == BEGIN else {}),
            }
        return begun(runner.settings)

    runner.database.graph_handlers[where] = reply
    assert_counts(runner.run(limit=1), **{"waiting" if repeat else "accepted": 1})
    assert len(runner.requests(PLAN)) == 2
    assert len(runner.requests(DEFER)) == int(repeat)
    if repeat:
        runner.transport.send_prepared.assert_not_called()
    else:
        runner.transport.send_prepared.assert_called_once()


@pytest.mark.parametrize(
    "outcome,state,expected",
    [
        ("waiting", "waiting", "waiting"),
        ("skipped", "queued", "skipped"),
        ("skipped", "completed", "completed"),
        ("stopped", "cancelled", "skipped"),
        ("lease_lost", None, "skipped"),
        ("already_begun", "sending", "unknown"),
        ("already_begun", "completed", "unknown"),
    ],
)
def test_non_grant_begin_never_sends_or_reuses_claim(runner, outcome, state, expected):
    runner.database.graph_handlers[BEGIN] = {
        **SCOPE,
        "node_id": NODE,
        "outcome": outcome,
        "run": position(state, node="end") if state else None,
        "attempt": None,
    }
    assert_counts(runner.run(limit=1), **{expected: 1})
    assert len(runner.requests(ADVANCE)) == 1
    runner.transport.send_prepared.assert_not_called()
    assert not runner.requests(SETTLE)


@pytest.mark.parametrize(
    "mutation",
    [
        "revision",
        "binding",
        "attempt",
        "node",
        "address",
        "reply_to",
        "subject",
        "text_body",
        "html_body",
        "scope",
        "missing",
        "extra",
    ],
)
def test_malformed_or_mismatched_begin_stops_unknown_with_zero_submission(runner, mutation):
    result = begun(runner.settings)
    if mutation == "revision":
        result["attempt"]["credential_revision"] = 2
    elif mutation == "binding":
        result["attempt"]["sender_binding"] = "0" * 64
    elif mutation == "attempt":
        result["attempt"]["message"]["attempt_id"] = OTHER
    elif mutation == "node":
        result["run"]["current_node_id"] = "other"
    elif mutation == "scope":
        result["studio_id"] = OTHER
    elif mutation == "missing":
        del result["run"]
    elif mutation == "extra":
        result["unexpected"] = True
    else:
        result["attempt"]["message"]["to_address" if mutation == "address" else mutation] = (
            "other@example.com" if mutation in {"address", "reply_to"} else "changed"
        )
    runner.database.graph_handlers[BEGIN] = result
    assert_counts(runner.run(), unknown=1)
    runner.transport.send_prepared.assert_not_called()
    assert len(runner.requests(BEGIN)) == 1 and not runner.requests(SETTLE)
    assert len(runner.requests(CLAIM_RPC)) == 1


@pytest.mark.parametrize("where", [BEGIN, SETTLE])
def test_lost_begin_or_settlement_stops_batch_without_reclaim(runner, where):
    runner.database.workflow_claims.append(claim(run_id=OTHER, claim_token=OTHER))
    runner.database.graph_handlers[where] = RuntimeError("private uncertain response")
    assert_counts(runner.run(), unknown=1, has_more=True)
    assert len(runner.requests(where)) == 1 and len(runner.requests(CLAIM_RPC)) == 1
    assert runner.transport.send_prepared.call_count == int(where == SETTLE)


@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize(
    "state", ["claimed", "running", "sending", "cancelled", "queued", "completed"]
)
def test_settlement_replay_keeps_current_run_truth_and_never_reuses_old_claim(
    runner, replayed, state
):
    runner.database.graph_handlers[SETTLE] = settled(
        replayed=replayed, run=position(state, node="later")
    )
    expected = (
        "unknown" if not replayed and state in {"claimed", "running", "sending"} else "accepted"
    )
    assert_counts(runner.run(), **{expected: 1})
    assert len(runner.requests(ADVANCE)) == 1
    assert len(runner.requests(CLAIM_RPC)) == (1 if expected == "unknown" else 2)
    runner.transport.send_prepared.assert_called_once()


@pytest.mark.parametrize(
    "outcome,evidence,run_state,expected",
    [
        ("accepted", None, "cancelled", "accepted"),
        ("accepted", "accepted", "queued", "accepted"),
        ("retryable_failure", "rejected", "waiting", "retry_wait"),
        ("permanent_failure", "not_submitted", "queued", "failed"),
        ("retryable_failure", None, "unknown", "unknown"),
        ("permanent_failure", None, "unknown", "unknown"),
        ("unknown", "unknown", "unknown", "unknown"),
    ],
)
def test_actual_attempt_truth_counts_independently_of_cancellation(
    runner, outcome, evidence, run_state, expected
):
    runner.transport.send_prepared.return_value = DeliveryResult(
        outcome, submission_evidence=evidence
    )
    state = (
        "accepted"
        if outcome == "accepted"
        else "unknown"
        if evidence in {None, "unknown"}
        else "failed"
    )
    runner.database.graph_handlers[SETTLE] = settled(state, run=position(run_state, node="end"))
    assert_counts(runner.run(limit=1), **{expected: 1})


@pytest.mark.parametrize(
    "outcome,evidence",
    [
        ("unknown", "unknown"),
        ("retryable_failure", "not_submitted"),
        ("permanent_failure", "rejected"),
    ],
)
@pytest.mark.parametrize("replayed", [False, True])
def test_rpc_cannot_upgrade_failure_or_unknown_to_acceptance(runner, outcome, evidence, replayed):
    runner.transport.send_prepared.return_value = DeliveryResult(
        outcome, submission_evidence=evidence
    )
    runner.database.graph_handlers[SETTLE] = settled(replayed=replayed)
    assert_counts(runner.run(), unknown=1, accepted=0)
    assert len(runner.requests(CLAIM_RPC)) == 1


@pytest.mark.parametrize(
    "result",
    [
        None,
        {},
        DeliveryResult("retryable_failure", "provider_connection_failed"),
        DeliveryResult("permanent_failure", "provider_rejected"),
        DeliveryResult("accepted", credential_revision=2),
        DeliveryResult("accepted", retry_after_seconds=True),
        DeliveryResult("accepted", retry_after_seconds=86401),
    ],
)
def test_unproved_or_malformed_transport_is_fixed_unknown(runner, result):
    runner.transport.send_prepared.return_value = result
    assert_counts(runner.run(), unknown=1)
    wire = runner.requests(SETTLE)[0]["p_result"]
    assert wire["outcome"] == "unknown" and wire["error_code"] == "provider_submission_unknown"
    assert wire["submission_evidence"] == "unknown" and wire["failure_scope"] == "unclassified"
    assert wire["retry_after_seconds"] is None


@pytest.mark.parametrize("code", sorted(dto.TRANSPORT_CODES))
def test_known_transport_error_codes_are_preserved_only_with_affirmative_evidence(code):
    result = shared._delivery_result(
        DeliveryResult("retryable_failure", code, submission_evidence="not_submitted")
    )
    assert result.error_code == code and result.outcome == "retryable_failure"
    uncertain = shared._delivery_result(DeliveryResult("retryable_failure", code))
    assert uncertain.error_code == "provider_submission_unknown" and uncertain.outcome == "unknown"


@pytest.mark.parametrize("code", [None, "private provider text", {}, [], 42])
def test_unknown_transport_code_is_never_stored_or_used_as_truth(code):
    result = shared._delivery_result(
        DeliveryResult("permanent_failure", code, submission_evidence="rejected")
    )
    assert result.error_code == "provider_unavailable"
    accepted = shared._delivery_result(DeliveryResult("accepted", code))
    assert (
        accepted.outcome == "accepted"
        and accepted.error_code is None
        and accepted.submission_evidence is None
    )


@pytest.mark.parametrize(
    "request_id", [None, "a.B_:-0", "x" * 200, "x" * 201, "private body\n", "é", 2, [], {}]
)
def test_request_identifier_is_bounded_safe_ascii(request_id):
    result = shared._delivery_result(DeliveryResult("accepted", provider_request_id=request_id))
    expected = (
        request_id if isinstance(request_id, str) and request_id in {"a.B_:-0", "x" * 200} else None
    )
    assert result.provider_request_id == expected and result.outcome == "accepted"


@pytest.mark.parametrize("retry", [0, -1, True, "1", 1.5, 86401, float("nan"), []])
def test_invalid_retry_never_becomes_coerced_delay(retry):
    result = shared._delivery_result(
        DeliveryResult(
            "retryable_failure", retry_after_seconds=retry, submission_evidence="not_submitted"
        )
    )
    assert result.outcome == "unknown" and result.retry_after_seconds is None


def test_unknown_keeps_only_safely_validated_used_revision_and_request_id():
    result = shared._delivery_result(
        DeliveryResult("unknown", "unsafe text", "request:1", credential_revision=7)
    )
    assert result.credential_revision == 7 and result.provider_request_id == "request:1"
    assert result.error_code == "provider_submission_unknown"
    overflow = shared._delivery_result(DeliveryResult("accepted", credential_revision=2**63))
    assert overflow.outcome == "unknown" and overflow.credential_revision is None


@pytest.mark.parametrize("mode", ["ready", "cooldown", "auth_blocked"])
def test_sql_preparation_refusal_never_calls_provider_prepare(runner, monkeypatch, mode):
    monkeypatch.setattr(
        worker, "email_delivery_status", lambda *_: {"configured": True, "can_enable": False}
    )
    runner.database.handlers[PREPARE] = lambda p: {
        "payload": preparation_claim(
            p,
            allowed=False,
            mode=mode,
            preparation_token=None,
            lease_expires_at=None,
            retry_at=LEASE if mode == "cooldown" else None,
            reason="sender_unavailable",
        )
    }
    assert_counts(runner.run(limit=1), waiting=1)
    assert len(runner.requests(PREPARE)) == 1 and not runner.requests(PREPARED)
    runner.transport.prepare.assert_not_called()
    runner.transport.send_prepared.assert_not_called()
    assert runner.requests(RESOLVE)[0]["p_resolution"] == {"kind": "sender_unavailable"}


def test_due_cooldown_probe_requires_exact_owned_tokens(runner, monkeypatch):
    monkeypatch.setattr(
        worker, "email_delivery_status", lambda *_: {"configured": True, "can_enable": False}
    )
    runner.database.handlers[PREPARE] = lambda p: {
        "payload": preparation_claim(p, mode="cooldown", probe_token=OTHER)
    }
    runner.database.handlers[PREPARED] = lambda p: {
        "payload": preparation_settled(p, probe_token=OTHER)
    }
    assert_counts(runner.run(limit=1), accepted=1)
    assert runner.requests(BEGIN)[0]["p_probe_token"] == OTHER
    assert runner.requests(SETTLE)[0]["p_result"]["submission_evidence"] is None
    # This caller has no gate-clear RPC. SQL must require explicit acceptance evidence.
    assert not any("clear" in name or "recover" in name for name, _ in runner.database.executed)


@pytest.mark.parametrize(
    "change",
    [
        {"generation": 2},
        {"preparation_token": OTHER},
        {"probe_token": OTHER},
        {"lease_expires_at": "2026-10-05T22:00:01Z"},
    ],
)
def test_preparation_replay_cannot_change_generation_tokens_or_extend_lease(runner, change):
    runner.database.handlers[PREPARED] = lambda p: {"payload": preparation_settled(p, **change)}
    with pytest.raises(HTTPException):
        runner.run()
    runner.transport.prepare.assert_called_once()
    assert not runner.requests(BEGIN)
    runner.transport.send_prepared.assert_not_called()


@pytest.mark.parametrize("outcome", ["deferred", "blocked", "stale"])
def test_expired_or_changed_preparation_grant_defers_no_begin(runner, outcome):
    runner.database.handlers[PREPARED] = lambda p: {
        "payload": preparation_settled(
            p,
            outcome=outcome,
            preparation_token=None,
            probe_token=None,
            lease_expires_at=None,
            retry_at=LEASE if outcome == "deferred" else None,
            reason="sender_unavailable",
        )
    }
    assert_counts(runner.run(limit=1), waiting=1)
    assert not runner.requests(BEGIN)
    runner.transport.send_prepared.assert_not_called()


@pytest.mark.parametrize(
    "failure,expected",
    [
        (
            DeliveryResult(
                "permanent_failure",
                "authentication_required",
                submission_evidence="not_submitted",
                failure_scope="sender_auth",
            ),
            "sender_auth",
        ),
        (
            DeliveryResult(
                "retryable_failure",
                "token_refresh_throttled",
                retry_after_seconds=30,
                submission_evidence="not_submitted",
                failure_scope="sender_transient",
            ),
            "sender_transient",
        ),
        (DeliveryResult("permanent_failure", "authentication_required"), "sender_transient"),
        (None, "sender_transient"),
    ],
)
def test_preparation_failure_never_invents_credential_revision(runner, failure, expected):
    runner.transport.prepare.return_value = failure
    assert_counts(runner.run(limit=1), waiting=1)
    evidence = runner.requests(PREPARED)[0]["p_result"]
    assert evidence["outcome"] == expected and evidence["credential_revision"] is None
    assert not runner.requests(BEGIN)


def test_preparation_uses_handle_exact_refreshed_revision(runner):
    handle = replace(runner.handle, envelope=replace(runner.handle.envelope, revision=8))
    runner.transport.prepare.return_value = handle
    response = begun(runner.settings)
    response["attempt"]["credential_revision"] = 8
    runner.database.graph_handlers[BEGIN] = response
    runner.transport.send_prepared.return_value = DeliveryResult(
        "accepted", submission_evidence="accepted", credential_revision=8
    )
    assert_counts(runner.run(limit=1), accepted=1)
    assert runner.transport.send_prepared.call_args.args[1] is handle
    assert runner.requests(PREPARED)[0]["p_result"]["credential_revision"] == 8
    assert runner.requests(SETTLE)[0]["p_result"]["credential_revision"] == 8


@pytest.mark.parametrize(
    "phase", [RELEASE_PREFLIGHT_RPC, V38, CLAIM_RPC, ADVANCE, PLAN, PREPARE, PREPARED]
)
def test_each_database_phase_consumes_the_same_absolute_budget(runner, phase):
    runner.database.on_execute = lambda name, p: (
        setattr(runner.clock, "now", 116.0) if name == phase else None
    )
    result = runner.run()
    assert result["processed"] == 0
    runner.transport.send_prepared.assert_not_called()
    runner.closer.assert_called_once()
    assert not runner.requests(BEGIN)


def test_budget_exit_before_readiness_creates_no_client(runner):
    assert_counts(runner.run(deadline_monotonic=109), claimed=0, processed=0)
    runner.factory.assert_not_called()


def test_nested_entitlement_query_budget_is_not_misread_as_denial(runner):
    def access(client, studio, **kwargs):
        client.table("studio_subscriptions").select("*").execute()
        runner.clock.now = 116
        try:
            client.table("studio_subscriptions").select("*").execute()
        except shared._BudgetExhausted:
            raise HTTPException(503, "wrapped timeout") from None

    runner.access.side_effect = access
    assert_counts(runner.run(), processed=0)
    assert len(runner.database.query_log) == 1
    assert not runner.requests(DEFER)


@pytest.mark.parametrize("elapsed", [19.5, 20, 26])
def test_late_begin_respects_provider_and_settlement_deadlines(runner, elapsed):
    runner.database.on_execute = lambda name, _: (
        setattr(runner.clock, "now", 100 + elapsed) if name == BEGIN else None
    )
    result = runner.run(limit=1)
    assert_counts(result, **{"accepted" if elapsed == 19.5 else "unknown": 1})
    assert runner.transport.send_prepared.call_count == int(elapsed == 19.5)
    assert len(runner.requests(SETTLE)) == int(elapsed == 19.5)


def test_two_processors_share_deadline_without_double_budget_or_client_close(runner, monkeypatch):
    database = runner.database
    database.transition_queue = [{"outcome": "stopped", "run": position("completed")}]
    database.on_execute = lambda name, _: (
        setattr(runner.clock, "now", 111) if name == ADVANCE else None
    )
    raw = database
    no_close = Mock()
    monkeypatch.setattr(
        shared,
        "get_platform_subscription_access",
        Mock(return_value={"subscription_required": False}),
    )
    first = worker.process_due_workflow_automations(
        runner.settings,
        limit=1,
        deadline_monotonic=125,
        clock=runner.clock,
        client_factory=lambda **_: raw,
        client_closer=no_close,
        transport_factory=runner.transport_factory,
    )
    assert first.completed == 1
    database.on_execute = lambda name, _: (
        setattr(runner.clock, "now", 116) if name == "enqueue_missed_class_automations_v1" else None
    )
    second = shared.process_due_missed_class_automations(
        runner.settings,
        deadline_monotonic=125,
        clock=runner.clock,
        client_factory=lambda **_: raw,
        client_closer=no_close,
        transport_factory=runner.transport_factory,
    )
    assert second.processed == 0 and runner.clock.now == 116
    runner.transport.send_prepared.assert_not_called()
    assert no_close.call_count == 2
    # The future coordinator owns the one real closer; both inner closers are no-ops.
    runner.closer(raw)
    runner.closer.assert_called_once_with(raw)


def test_late_send_response_is_unknown_and_cannot_start_next_claim(runner):
    def send(*args, **kwargs):
        runner.clock.now = 126
        return DeliveryResult("accepted")

    runner.transport.send_prepared.side_effect = send
    assert_counts(runner.run(), unknown=1)
    assert not runner.requests(SETTLE) and len(runner.requests(CLAIM_RPC)) == 1


def test_close_failure_does_not_erase_attempt_truth(runner):
    runner.closer.side_effect = RuntimeError("private client failure")
    assert_counts(runner.run(limit=1), accepted=1)
    runner.transport.send_prepared.assert_called_once()


def test_no_private_message_facts_token_in_model_or_parent_repr(runner):
    values = [
        dto.Plan.model_validate(plan()),
        dto.Planned.model_validate(planned()),
        dto.Begun.model_validate(begun(runner.settings)),
        dto.Envelope[dto.Planned].model_validate({"payload": planned()}),
        shared._PreparedGrant(
            runner.handle,
            dto.PreparationClaim.model_validate(preparation_claim({"p_preparation_id": OTHER})),
        ),
    ]
    for value in values:
        visible = repr(value) + str(value)
        for secret in [
            "Selected Guardian",
            "koaryu@outlook.com",
            "a" * 64,
            "Hi",
            "synthetic-access-only",
        ]:
            assert secret not in visible


def test_invalid_reported_revision_is_not_replaced_with_handle_revision():
    result = shared._delivery_result(
        DeliveryResult("accepted", credential_revision=2), expected_revision=1
    )
    assert result.outcome == "unknown" and result.credential_revision is None


@pytest.mark.parametrize(
    "changes",
    [
        {"source_decision": "eligible", "source_reason": None},
        {"source_decision": "ineligible", "source_reason": "contact_changed"},
    ],
)
def test_non_send_resolution_leaves_current_source_precedence_with_sql(runner, changes):
    runner.database.selected_plan.update(disposition="stop", reason="contact_changed")
    runner.database.selected_plan["facts"].update(changes)
    runner.database.graph_handlers[RESOLVE] = {
        **SCOPE,
        "node_id": NODE,
        "outcome": "stopped",
        "run": position("cancelled", reason="source_unavailable"),
    }
    assert_counts(runner.run(limit=1), skipped=1)
    assert runner.requests(RESOLVE)[0]["p_resolution"] == {"kind": "plan_decision"}
    runner.transport_factory.assert_not_called()


@pytest.mark.parametrize(
    "url",
    [
        "https://other.example.com/automations/unsubscribe#" + "a" * 64,
        "https://api.example.com/api/v1/automations/unsubscribe#" + "b" * 64,
    ],
)
def test_returned_url_must_match_configured_base_path_and_returned_pinned_token(runner, url):
    runner.database.selected_plan["unsubscribe_url"] = url
    with pytest.raises(HTTPException) as caught:
        runner.run()
    assert caught.value.detail == shared.UNAVAILABLE_DETAIL
    assert not runner.requests(PREPARE) and not runner.requests(RESOLVE)
    runner.transport.send_prepared.assert_not_called()


@pytest.mark.parametrize("first", ["settle", "skipped"])
def test_consumed_claim_token_cannot_be_reissued_for_another_effect(runner, first):
    runner.database.workflow_claims.append(claim())
    if first == "skipped":
        runner.database.graph_handlers[BEGIN] = begun(
            runner.settings, outcome="skipped", run=position("queued", node="end"), attempt=None
        )
    with pytest.raises(HTTPException) as caught:
        runner.run()
    assert caught.value.detail == shared.UNAVAILABLE_DETAIL
    assert len(runner.requests(CLAIM_RPC)) == 2 and len(runner.requests(ADVANCE)) == 1
    assert runner.transport.send_prepared.call_count == int(first == "settle")


def test_same_run_with_fresh_claim_token_may_continue_after_settlement(runner):
    runner.database.workflow_claims.append(claim(claim_token=OTHER))
    runner.database.transition_queue = [
        {"outcome": "email", "run": position()},
        {"outcome": "stopped", "run": position("completed", node="end")},
    ]
    assert_counts(runner.run(limit=2), claimed=2, processed=2, accepted=1, completed=1)
    assert [p["p_claim_token"] for p in runner.requests(ADVANCE)] == [TOKEN, OTHER]
    assert len(runner.requests(SETTLE)) == 1


@pytest.mark.parametrize(
    "state",
    [
        "waiting",
        "claimed",
        "running",
        "sending",
        "queued",
        "completed",
        "cancelled",
        "failed",
        "unknown",
    ],
)
def test_replayed_failed_attempt_does_not_infer_retry_from_later_run(runner, state):
    runner.transport.send_prepared.return_value = DeliveryResult(
        "permanent_failure",
        "invalid_message",
        submission_evidence="not_submitted",
        failure_scope="message",
    )
    later_position = position(state, node="later_delay")
    runner.database.graph_handlers[SETTLE] = settled(
        "failed",
        replayed=True,
        run=deepcopy(later_position),
    )
    assert_counts(runner.run(), failed=1, retry_wait=0, waiting=0, has_more=False)
    assert runner.database.graph_handlers[SETTLE]["run"] == later_position
    assert len(runner.requests(CLAIM_RPC)) == 2
    assert len(runner.requests(ADVANCE)) == len(runner.requests(BEGIN)) == 1
    assert runner.requests(SETTLE)[0]["p_claim_token"] == TOKEN
    runner.transport.send_prepared.assert_called_once()


def test_fresh_failed_attempt_waiting_for_safe_retry_keeps_retry_wait_count(runner):
    runner.transport.send_prepared.return_value = DeliveryResult(
        "retryable_failure",
        "provider_throttled",
        submission_evidence="rejected",
        failure_scope="sender_transient",
    )
    runner.database.graph_handlers[SETTLE] = settled(
        "failed",
        replayed=False,
        run=position("waiting"),
    )
    assert_counts(runner.run(), retry_wait=1, failed=0, waiting=0)
    assert len(runner.requests(CLAIM_RPC)) == 2
    assert len(runner.requests(ADVANCE)) == len(runner.requests(SETTLE)) == 1
    runner.transport.send_prepared.assert_called_once()


@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize("state", ["accepted", "unknown"])
def test_fresh_and_replayed_nonfailure_keep_original_attempt_summary(runner, replayed, state):
    runner.transport.send_prepared.return_value = DeliveryResult(
        state,
        submission_evidence=None if state == "accepted" else "unknown",
    )
    runner.database.graph_handlers[SETTLE] = settled(
        state,
        replayed=replayed,
        run=position("cancelled" if state == "accepted" else "unknown"),
    )
    assert_counts(runner.run(), retry_wait=0, failed=0, **{state: 1})
    assert len(runner.requests(CLAIM_RPC)) == (2 if state == "accepted" else 1)
    runner.transport.send_prepared.assert_called_once()
