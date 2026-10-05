"""Closed result matrices and the real installed PostgREST payload parser."""

import json
from copy import deepcopy
from uuid import UUID

import httpx
import pytest
from pydantic import ValidationError
from test_automation_email import email_settings
from test_automation_rpc_compatibility import MockPostgrestClient
from test_automation_service import (
    ATTEMPT_ID,
    CLAIM_TOKEN,
    DELIVERY_ID,
    LEASE,
    PREPARATION_TOKEN,
    Clock,
    preparation_claim,
    preparation_settled,
    snapshot,
)
from test_workflow_dispatcher import (
    ADVANCE,
    BEGIN,
    CLAIM_RPC,
    DEFER,
    NODE,
    OTHER,
    PLAN,
    PREPARE,
    PREPARED,
    RESOLVE,
    RUN,
    SCOPE,
    SETTLE,
    STUDIO,
    TOKEN,
    begun,
    claim,
    facts,
    plan,
    planned,
    position,
    settled,
    transition,
)

from app.schemas import workflow_dispatch as dto
from app.services import automation_service as service
from app.services.automation_email import delivery_configuration, sender_identity_binding

SETTINGS = email_settings(AUTOMATION_WORKER_ENABLED=True)
BINDING = sender_identity_binding(delivery_configuration(SETTINGS))
SCOPE_PARAMS = {"p_" + key: value for key, value in SCOPE.items()}
PLAN_PARAMS = {
    **SCOPE_PARAMS,
    "p_node_id": NODE,
    "p_allowed_recipients": ["koaryu@outlook.com"],
    "p_default_reply_to": "reply@example.com",
    "p_public_api_url": "https://api.example.com/api/v1",
}
BOUND_PARAMS = {**PLAN_PARAMS, "p_plan_fingerprint": "f" * 64, "p_unsubscribe_token": "a" * 64}
GRANT_PARAMS = {
    "p_preparation_id": OTHER,
    "p_preparation_token": PREPARATION_TOKEN,
    "p_probe_token": None,
}
ACCEPTED = {
    "outcome": "accepted",
    "error_code": None,
    "provider_request_id": None,
    "retry_after_seconds": None,
    "submission_evidence": None,
    "failure_scope": None,
    "credential_revision": None,
}
PREPARATION = {
    "outcome": "prepared",
    "credential_revision": 1,
    "sender_binding": BINDING,
    "safe_reason": None,
    "retry_after_seconds": None,
}
LEGACY_BEGUN = {
    "delivery_id": DELIVERY_ID,
    "claim_token": CLAIM_TOKEN,
    "ready": True,
    "state": "sending",
    "reason": None,
    "attempt_id": ATTEMPT_ID,
    "lease_expires_at": LEASE,
    "credential_revision": 1,
    "sender_binding": BINDING,
    "message": snapshot(),
}
LEGACY_SETTLED = {
    "delivery_id": DELIVERY_ID,
    "attempt_id": ATTEMPT_ID,
    "updated": True,
    "replayed": False,
    "state": "accepted",
    "reason": None,
}

RPC_CASES = [
    (
        CLAIM_RPC,
        dto.ClaimRequest,
        {"p_limit": 1},
        dto.Claims,
        {"claims": [claim()], "has_more": False},
    ),
    (
        ADVANCE,
        dto.AdvanceRequest,
        {**SCOPE_PARAMS, "p_step_limit": 1},
        dto.Transition,
        transition(),
    ),
    (
        DEFER,
        dto.DeferRequest,
        {**SCOPE_PARAMS, "p_reason": "facts_unavailable"},
        dto.Deferred,
        transition("waiting", position("waiting")),
    ),
    (
        PLAN,
        dto.PlanRequest,
        {**PLAN_PARAMS, "p_candidate_unsubscribe_token": "b" * 64},
        dto.Planned,
        planned(),
    ),
    (
        RESOLVE,
        dto.ResolveRequest,
        {**BOUND_PARAMS, "p_resolution": {"kind": "plan_decision"}},
        dto.Resolved,
        {**SCOPE, "node_id": NODE, "outcome": "continue", "run": position(node="next")},
    ),
    (
        PREPARE,
        dto.PreparationClaimRequest,
        {
            "p_provider_key": "microsoft_graph:primary",
            "p_preparation_id": OTHER,
            "p_sender_binding": BINDING,
        },
        dto.PreparationClaim,
        preparation_claim({"p_preparation_id": OTHER}),
    ),
    (
        PREPARED,
        dto.PreparationSettleRequest,
        {
            "p_preparation_id": OTHER,
            "p_preparation_token": PREPARATION_TOKEN,
            "p_result": PREPARATION,
        },
        dto.PreparationSettled,
        preparation_settled({"p_preparation_id": OTHER, "p_result": PREPARATION}),
    ),
    (
        BEGIN,
        dto.BeginRequest,
        {
            **BOUND_PARAMS,
            **GRANT_PARAMS,
            "p_rendered": {
                key: begun(SETTINGS)["attempt"]["message"][key] for key in dto.Rendered.model_fields
            },
        },
        dto.Begun,
        begun(SETTINGS),
    ),
    (
        SETTLE,
        dto.SettleRequest,
        {
            "p_studio_id": STUDIO,
            "p_attempt_id": ATTEMPT_ID,
            "p_claim_token": TOKEN,
            "p_result": ACCEPTED,
        },
        dto.Settled,
        settled(),
    ),
    (
        "begin_missed_class_automation_v2",
        dto.LegacyBeginRequest,
        {
            "p_delivery_id": DELIVERY_ID,
            "p_claim_token": CLAIM_TOKEN,
            **GRANT_PARAMS,
            "p_allowed_recipients": [],
        },
        dto.LegacyBegun,
        LEGACY_BEGUN,
    ),
    (
        "settle_missed_class_automation_v2",
        dto.LegacySettleRequest,
        {
            "p_delivery_id": DELIVERY_ID,
            "p_claim_token": CLAIM_TOKEN,
            "p_attempt_id": ATTEMPT_ID,
            "p_result": ACCEPTED,
        },
        dto.LegacySettled,
        LEGACY_SETTLED,
    ),
]


def sdk_call(case, payload, *, status=200, raw=False, clock=None, on_builder=None):
    name, request_type, parameters, response_type, _ = case
    requests = []

    def handle(request):
        requests.append(request)
        if isinstance(payload, Exception):
            raise payload
        return httpx.Response(status, **({"content": payload} if raw else {"json": payload}))

    client = MockPostgrestClient(handle, 5.0)
    original = client.rpc

    def rpc(func, params):
        result = original(func, params)
        if on_builder:
            on_builder()
        return result

    client.rpc = rpc
    budget = service._WorkerBudget(125, clock or Clock())
    try:
        result = service._dispatch_rpc(
            service._WorkerClient(client, budget),
            name,
            request_type.model_validate(parameters),
            response_type,
        )
        return result, requests, client
    finally:
        client.aclose()


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
def test_every_dispatch_rpc_parses_real_sdk_payload_and_preserves_exact_request(case):
    result, requests, client = sdk_call(case, {"payload": case[4]})
    assert result == case[3].model_validate(case[4])
    assert client.session.is_closed and len(requests) == 1
    request = requests[0]
    assert request.url.path == "/rest/v1/rpc/" + case[0] and request.method == "POST"
    assert json.loads(request.content) == case[2]
    assert request.headers["authorization"] == "Bearer synthetic-service-role"
    assert request.extensions["timeout"] == {"connect": 5.0, "read": 5.0, "write": 5.0, "pool": 5.0}
    client.builders[0][1].execute.assert_called_once()


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
@pytest.mark.parametrize(
    "shape", ["bare", "array", "missing", "extra", "message", "null", "wrong_payload"]
)
def test_no_rpc_accepts_legacy_or_loose_envelope(case, shape):
    payload = {
        "bare": case[4],
        "array": [{"payload": case[4]}],
        "missing": {},
        "extra": {"payload": case[4], "extra": None},
        "message": {"message": case[4]},
        "null": None,
        "wrong_payload": {"payload": []},
    }[shape]
    with pytest.raises(ValueError, match="^invalid_automation_dispatch_result$"):
        sdk_call(case, payload)


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
@pytest.mark.parametrize(
    "error",
    [
        {"code": "42501", "message": "AUTOMATION_SERVICE_REQUIRED"},
        {"code": "22023", "message": "AUTOMATION_INVALID_REQUEST"},
        {"code": "P0001", "message": "AUTOMATION_STUDIO_BUSY"},
        {"code": "42883", "message": "private missing function"},
        {"code": "PGRST202", "message": "private missing function"},
        {"code": [], "message": {}},
        {"code": {}, "message": []},
    ],
)
def test_all_rpc_errors_are_fixed_unavailable_not_safe_refusal_or_retry(case, error):
    with pytest.raises(ValueError, match="^invalid_automation_dispatch_result$") as caught:
        sdk_call(case, error, status=400)
    assert "private" not in str(caught.value)


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
def test_rpc_lost_response_has_no_automatic_retry(case):
    with pytest.raises(ValueError, match="^invalid_automation_dispatch_result$"):
        sdk_call(case, httpx.ReadError("private lost response"))


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
def test_rpc_budget_is_rechecked_after_builder_before_http(case):
    clock = Clock()
    with pytest.raises(service._BudgetExhausted):
        sdk_call(
            case, {"payload": case[4]}, clock=clock, on_builder=lambda: setattr(clock, "now", 116)
        )


ECHO_CASES = [
    (case, field)
    for case in RPC_CASES
    for field in (
        "studio_id",
        "run_id",
        "claim_token",
        "node_id",
        "attempt_id",
        "delivery_id",
        "preparation_id",
    )
    if field in case[4] and "p_" + field in case[2]
]


@pytest.mark.parametrize(
    "case,field", ECHO_CASES, ids=[case[0] + ":" + field for case, field in ECHO_CASES]
)
def test_every_identity_echo_must_match_exact_request(case, field):
    data = deepcopy(case[4])
    data[field] = "other_node" if field == "node_id" else str(UUID(int=9999))
    with pytest.raises(ValueError, match="^invalid_automation_dispatch_result$"):
        sdk_call(case, {"payload": data})


MODEL_CASES = [
    (model, data)
    for _, request, parameters, response, payload in RPC_CASES
    for model, data in ((request, parameters), (response, payload))
]
MODEL_CASES += [
    (dto.RunPosition, position()),
    (dto.Plan, plan()),
    (dto.Attempt, begun(SETTINGS)["attempt"]),
    (dto.Message, begun(SETTINGS)["attempt"]["message"]),
    (
        dto.Rendered,
        {key: begun(SETTINGS)["attempt"]["message"][key] for key in dto.Rendered.model_fields},
    ),
    (dto.Delivery, ACCEPTED),
    (dto.PreparationResult, PREPARATION),
    (dto.LegacySnapshot, snapshot()),
]
MISSING_CASES = [(model, data, key) for model, data in MODEL_CASES for key in data]


@pytest.mark.parametrize(
    "model,data,key",
    MISSING_CASES,
    ids=[model.__name__ + ":" + key for model, _, key in MISSING_CASES],
)
def test_all_protocol_fields_including_nullable_values_are_required(model, data, key):
    malformed = deepcopy(data)
    del malformed[key]
    with pytest.raises(ValidationError):
        model.model_validate(malformed)


@pytest.mark.parametrize(
    "model,data", MODEL_CASES, ids=[model.__name__ for model, _ in MODEL_CASES]
)
def test_every_protocol_object_rejects_extra_fields_and_hides_parent_repr(model, data):
    with pytest.raises(ValidationError):
        model.model_validate({**data, "unexpected": "private extra"})
    parsed = model.model_validate(data)
    assert "private" not in repr(parsed)
    assert "a" * 64 not in repr(parsed) and "koaryu@outlook.com" not in repr(parsed)


@pytest.mark.parametrize(
    "state",
    [
        "queued",
        "waiting",
        "claimed",
        "running",
        "sending",
        "completed",
        "cancelled",
        "failed",
        "unknown",
    ],
)
def test_run_position_due_matrix_and_nonnull_current_node(state):
    data = position(state)
    dto.RunPosition.model_validate(data)
    with pytest.raises(ValidationError):
        dto.RunPosition.model_validate(
            {**data, "next_due_at": None if data["next_due_at"] else LEASE}
        )
    for node in (None, True, 12, "", "a b", "x" * 65):
        with pytest.raises(ValidationError):
            dto.RunPosition.model_validate({**data, "current_node_id": node})


@pytest.mark.parametrize(
    "instant",
    [
        None,
        0,
        True,
        float("inf"),
        "infinity",
        "2026-10-05",
        "2026-10-05T22:00:00",
        "9999-12-31T23:59:59-23:59",
        "0001-01-01T00:00:00+23:59",
    ],
)
def test_claim_lease_requires_finite_utc_time_without_local_chronology_policy(instant):
    with pytest.raises(ValidationError):
        dto.Claim.model_validate(claim(lease_expires_at=instant))
    # SQL owns lease freshness. Valid old wire instants remain structurally valid.
    dto.Claim.model_validate(claim(lease_expires_at="2000-01-01T00:00:00Z"))


@pytest.mark.parametrize(
    "change", [{"run_id": RUN, "claim_token": OTHER}, {"run_id": OTHER, "claim_token": TOKEN}, {}]
)
def test_claim_uniqueness_is_run_and_token_independently(change):
    with pytest.raises(ValidationError):
        dto.Claims.model_validate({"claims": [claim(), claim(**change)], "has_more": False})


def test_reply_claim_count_cannot_exceed_requested_limit():
    case = RPC_CASES[0]
    data = {"claims": [claim(), claim(run_id=OTHER, claim_token=OTHER)], "has_more": True}
    dto.Claims.model_validate(data)
    with pytest.raises(ValueError, match="invalid_automation_dispatch_result"):
        sdk_call(case, {"payload": data})


@pytest.mark.parametrize(
    "outcome,states",
    [
        ("continue", {"claimed", "running"}),
        ("email", {"claimed", "running"}),
        ("waiting", {"waiting"}),
        ("stopped", dto.TERMINAL),
        ("lease_lost", {None}),
    ],
)
def test_transition_outcomes_accept_only_bound_run_states(outcome, states):
    for state in [
        None,
        "queued",
        "waiting",
        "claimed",
        "running",
        "sending",
        "completed",
        "cancelled",
        "failed",
        "unknown",
    ]:
        data = {**SCOPE, "outcome": outcome, "run": position(state) if state else None}
        if state in states:
            dto.Transition.model_validate(data)
        else:
            with pytest.raises(ValidationError):
                dto.Transition.model_validate(data)


@pytest.mark.parametrize("outcome", ["continue", "email", "stale_plan", "already_begun"])
def test_ordinary_defer_cannot_advance_or_grant_send(outcome):
    with pytest.raises(ValidationError):
        dto.Deferred.model_validate(transition(outcome))


@pytest.mark.parametrize(
    "outcome,states",
    [
        ("continue", dto.OWNED),
        ("waiting", {"waiting"}),
        ("stopped", dto.TERMINAL),
        ("stale_plan", dto.OWNED),
        ("lease_lost", {None}),
    ],
)
def test_no_attempt_resolver_state_matrix(outcome, states):
    for state in [
        None,
        "queued",
        "waiting",
        "claimed",
        "running",
        "sending",
        "completed",
        "cancelled",
        "failed",
        "unknown",
    ]:
        data = {
            **SCOPE,
            "node_id": NODE,
            "outcome": outcome,
            "run": position(state) if state else None,
        }
        if state in states:
            dto.Resolved.model_validate(data)
        else:
            with pytest.raises(ValidationError):
                dto.Resolved.model_validate(data)


@pytest.mark.parametrize("disposition", ["send", "skip", "wait", "stop"])
@pytest.mark.parametrize(
    "recipient_email,recipient_kind",
    [
        (None, None),
        (None, "guardian"),
        ("koaryu@outlook.com", None),
        ("koaryu@outlook.com", "guardian"),
    ],
)
def test_plan_recipient_nullability_preserves_known_routing_kind(
    disposition, recipient_email, recipient_kind
):
    data = plan(
        disposition=disposition,
        reason=None if disposition == "send" else "contact_changed",
        recipient_email=recipient_email,
        recipient_kind=recipient_kind,
    )
    if disposition == "send" and (recipient_email is None or recipient_kind is None):
        with pytest.raises(ValidationError):
            dto.Plan.model_validate(data)
    else:
        parsed = dto.Plan.model_validate(data)
        assert parsed.recipient_kind == recipient_kind


@pytest.mark.parametrize(
    "changes",
    [
        {"reason": "skip"},
        {"disposition": "skip", "reason": None},
        {"recipient_email": " Koaryu@Outlook.COM "},
        {"reply_to": "Reply@Example.com"},
        {"recipient_kind": "student"},
        {"recipient_policy": "invoice_payer"},
        {"facts": facts(source_decision="ineligible", source_reason="contact_changed")},
        {"facts": facts(recipients={})},
        {"facts": facts(condition_facts={"forged": True})},
        {"facts": facts(template_facts={"forged": {"kind": "text", "value": "x"}})},
        {"facts": facts(anchors={"forged": LEASE})},
        {"unsubscribe_token": "A" * 64},
        {"fingerprint": "f" * 63},
        {"subject_template": "x\x00"},
        {"body_template": "\ud800"},
    ],
)
def test_plan_rejects_noncanonical_or_inapplicable_fact_and_routing_fields(changes):
    with pytest.raises(ValidationError):
        dto.Plan.model_validate(plan(**changes))


def test_plan_known_null_and_missing_selected_template_values_remain_distinct():
    explicit = facts(template_facts={"studio_name": {"kind": "text", "value": None}})
    missing = facts(template_facts={})
    assert (
        dto.Plan.model_validate(plan(facts=explicit)).facts.template_facts["studio_name"].value
        is None
    )
    assert "studio_name" not in dto.Plan.model_validate(plan(facts=missing)).facts.template_facts


@pytest.mark.parametrize(
    "changes",
    [
        {"outcome": "planned", "plan": None},
        {"outcome": "lease_lost"},
        {"run": None},
        {"run": position("sending")},
        {"run": position(node="other")},
    ],
)
def test_plan_envelope_coherence(changes):
    with pytest.raises(ValidationError):
        dto.Planned.model_validate(planned(**changes))
    dto.Planned.model_validate(planned(outcome="lease_lost", plan=None, run=None))


@pytest.mark.parametrize(
    "resolution",
    [
        {"kind": "plan_decision"},
        {"kind": "render_failed", "reason": "unsupported_currency"},
        {"kind": "render_failed", "reason": "invalid_email_template"},
        {"kind": "render_failed", "reason": "invalid_email_context"},
        {"kind": "facts_unavailable"},
        {"kind": "sender_unavailable"},
    ],
)
def test_exact_no_attempt_resolution_union(resolution):
    dto.ResolveRequest.model_validate({**BOUND_PARAMS, "p_resolution": resolution})
    with pytest.raises(ValidationError):
        dto.ResolveRequest.model_validate(
            {**BOUND_PARAMS, "p_resolution": {**resolution, "extra": True}}
        )


@pytest.mark.parametrize(
    "resolution",
    [
        {"kind": "render_failed"},
        {"kind": "render_failed", "reason": "invalid_email_url"},
        {"kind": "render_failed", "reason": "facts_unavailable"},
        {"kind": "sender_unavailable", "reason": "authentication_required"},
        {"kind": "skip"},
        None,
    ],
)
def test_no_reason_only_or_unbound_resolution(resolution):
    with pytest.raises(ValidationError):
        dto.ResolveRequest.model_validate({**BOUND_PARAMS, "p_resolution": resolution})


@pytest.mark.parametrize(
    "mode,allowed,probe,retry,valid",
    [
        ("ready", True, None, None, True),
        ("cooldown", True, OTHER, None, True),
        ("auth_blocked", True, None, None, False),
        ("ready", True, OTHER, None, False),
        ("cooldown", True, None, None, False),
        ("cooldown", True, OTHER, LEASE, False),
        ("ready", False, None, None, True),
        ("ready", False, None, LEASE, True),
        ("cooldown", False, None, LEASE, True),
        ("cooldown", False, None, None, False),
        ("auth_blocked", False, None, None, True),
        ("auth_blocked", False, None, LEASE, False),
    ],
)
def test_preparation_claim_nullability_and_mode_matrix(mode, allowed, probe, retry, valid):
    data = preparation_claim(
        {"p_preparation_id": OTHER},
        mode=mode,
        allowed=allowed,
        probe_token=probe,
        retry_at=retry,
        preparation_token=PREPARATION_TOKEN if allowed else None,
        lease_expires_at=LEASE if allowed else None,
        reason=None if allowed else "sender_unavailable",
    )
    if valid:
        dto.PreparationClaim.model_validate(data)
    else:
        with pytest.raises(ValidationError):
            dto.PreparationClaim.model_validate(data)


@pytest.mark.parametrize("field", ["preparation_token", "probe_token", "lease_expires_at"])
def test_refused_preparation_cannot_retain_stale_permission(field):
    data = preparation_claim(
        {"p_preparation_id": OTHER},
        allowed=False,
        preparation_token=None,
        probe_token=None,
        lease_expires_at=None,
        reason="sender_unavailable",
    )
    data[field] = LEASE if field == "lease_expires_at" else PREPARATION_TOKEN
    with pytest.raises(ValidationError):
        dto.PreparationClaim.model_validate(data)


@pytest.mark.parametrize(
    "outcome,retry,valid",
    [
        ("prepared", None, True),
        ("prepared", LEASE, False),
        ("deferred", LEASE, True),
        ("deferred", None, False),
        ("blocked", None, True),
        ("blocked", LEASE, False),
        ("stale", None, True),
        ("stale", LEASE, True),
    ],
)
def test_preparation_settlement_nullability_matrix(outcome, retry, valid):
    data = preparation_settled(
        {"p_preparation_id": OTHER, "p_result": PREPARATION},
        outcome=outcome,
        retry_at=retry,
        preparation_token=PREPARATION_TOKEN if outcome == "prepared" else None,
        lease_expires_at=LEASE if outcome == "prepared" else None,
        reason=None if outcome == "prepared" else "sender_unavailable",
    )
    if valid:
        dto.PreparationSettled.model_validate(data)
    else:
        with pytest.raises(ValidationError):
            dto.PreparationSettled.model_validate(data)


@pytest.mark.parametrize("value", [None, True, False, 0, -1, 1.0, "1", 2**63])
@pytest.mark.parametrize(
    "model,base,field",
    [
        (dto.PreparationClaim, preparation_claim({"p_preparation_id": OTHER}), "generation"),
        (dto.Attempt, begun(SETTINGS)["attempt"], "credential_revision"),
    ],
)
def test_generations_and_revisions_are_actual_positive_signed64(model, base, field, value):
    with pytest.raises(ValidationError):
        model.model_validate({**base, field: value})
    model.model_validate({**base, field: 2**63 - 1})


@pytest.mark.parametrize("outcome", ["sender_transient", "sender_auth"])
def test_preparation_failure_carries_no_invented_revision(outcome):
    data = {
        **PREPARATION,
        "outcome": outcome,
        "credential_revision": None,
        "safe_reason": "provider_unavailable",
        "retry_after_seconds": 3600,
    }
    dto.PreparationResult.model_validate(data)
    for changes in (
        {"credential_revision": 1},
        {"safe_reason": None},
        {"retry_after_seconds": 3601},
        {"retry_after_seconds": True},
        {"retry_after_seconds": "1"},
    ):
        with pytest.raises(ValidationError):
            dto.PreparationResult.model_validate({**data, **changes})


@pytest.mark.parametrize(
    "outcome,states",
    [
        ("begun", {"sending"}),
        ("stale_plan", dto.OWNED),
        ("waiting", {"waiting"}),
        ("skipped", dto.TERMINAL | {"queued"}),
        ("stopped", dto.TERMINAL),
        ("lease_lost", {None}),
        (
            "already_begun",
            {
                "queued",
                "waiting",
                "claimed",
                "running",
                "sending",
                "completed",
                "cancelled",
                "failed",
                "unknown",
            },
        ),
    ],
)
def test_begin_outcome_and_send_grant_matrix(outcome, states):
    for state in [
        None,
        "queued",
        "waiting",
        "claimed",
        "running",
        "sending",
        "completed",
        "cancelled",
        "failed",
        "unknown",
    ]:
        data = begun(SETTINGS, outcome=outcome, run=position(state) if state else None)
        if outcome != "begun":
            data["attempt"] = None
        if state in states:
            dto.Begun.model_validate(data)
        else:
            with pytest.raises(ValidationError):
                dto.Begun.model_validate(data)


@pytest.mark.parametrize(
    "changes",
    [
        {"attempt_number": True},
        {"attempt_number": 0},
        {"attempt_number": 4},
        {"attempt_number": "1"},
        {"credential_revision": False},
        {"lease_expires_at": None},
        {"sender_binding": "b" * 63},
    ],
)
def test_attempt_grant_is_complete_and_strict(changes):
    data = begun(SETTINGS)["attempt"]
    with pytest.raises(ValidationError):
        dto.Attempt.model_validate({**data, **changes})


@pytest.mark.parametrize(
    "field,length,character",
    [
        ("subject", 201, "x"),
        ("text_body", 22085, "x"),
        ("html_body", 132384, "x"),
        ("html_body", 40000, "🙂"),
    ],
)
def test_rendered_message_bounds_count_both_codepoints_and_utf8(field, length, character):
    data = {
        "subject": "Hi",
        "text_body": "Body",
        "html_body": "<p>Body</p>",
        field: character * length,
    }
    with pytest.raises(ValidationError):
        dto.Rendered.model_validate(data)


@pytest.mark.parametrize("field", ["subject", "text_body", "html_body"])
@pytest.mark.parametrize("value", [None, True, 1, b"x", "x\x00", "\udfff"])
def test_rendered_content_requires_valid_unicode_without_nul(field, value):
    with pytest.raises(ValidationError):
        dto.Rendered.model_validate(
            {"subject": "Hi", "text_body": "Body", "html_body": "<p>Body</p>", field: value}
        )


@pytest.mark.parametrize(
    "updated,replayed,state,valid",
    [
        (True, False, "accepted", True),
        (True, True, "accepted", True),
        (True, False, "failed", True),
        (True, True, "unknown", True),
        (False, False, None, True),
        (False, True, None, False),
        (False, False, "accepted", False),
        (True, False, None, False),
    ],
)
def test_settlement_refusal_and_terminal_replay_matrix(updated, replayed, state, valid):
    data = settled(
        state, updated=updated, replayed=replayed, run=position("cancelled") if updated else None
    )
    if valid:
        dto.Settled.model_validate(data)
    else:
        with pytest.raises(ValidationError):
            dto.Settled.model_validate(data)


@pytest.mark.parametrize("field", ["updated", "replayed", "ready", "allowed", "has_more"])
@pytest.mark.parametrize("value", [1, 0, "true", None])
def test_protocol_boolean_fields_do_not_coerce(field, value):
    model, data = {
        "updated": (dto.Settled, settled()),
        "replayed": (dto.Settled, settled()),
        "ready": (dto.LegacyBegun, LEGACY_BEGUN),
        "allowed": (dto.PreparationClaim, preparation_claim({"p_preparation_id": OTHER})),
        "has_more": (dto.Claims, {"claims": [], "has_more": False}),
    }[field]
    with pytest.raises(ValidationError):
        model.model_validate({**data, field: value})


@pytest.mark.parametrize(
    "field", ["attempt_id", "lease_expires_at", "credential_revision", "sender_binding", "message"]
)
def test_legacy_false_grant_clears_every_permission_field(field):
    base = {
        **LEGACY_BEGUN,
        "ready": False,
        "state": "sending",
        "attempt_id": None,
        "lease_expires_at": None,
        "credential_revision": None,
        "sender_binding": None,
        "message": None,
    }
    dto.LegacyBegun.model_validate(base)
    with pytest.raises(ValidationError):
        dto.LegacyBegun.model_validate({**base, field: LEGACY_BEGUN[field]})


@pytest.mark.parametrize("state", ["accepted", "retry_wait", "failed", "unknown"])
def test_legacy_settlement_keeps_existing_public_states(state):
    dto.LegacySettled.model_validate({**LEGACY_SETTLED, "state": state})
    for reason in ("sender_unavailable", "facts_unavailable", "private provider failure"):
        with pytest.raises(ValidationError):
            dto.LegacySettled.model_validate({**LEGACY_SETTLED, "state": state, "reason": reason})


@pytest.mark.parametrize(
    "outcome,evidence",
    [
        ("accepted", None),
        ("accepted", "accepted"),
        ("retryable_failure", "not_submitted"),
        ("permanent_failure", "rejected"),
        ("unknown", "unknown"),
    ],
)
def test_delivery_wire_preserves_allowed_optional_evidence(outcome, evidence):
    value = dto.Delivery.model_validate(
        {**ACCEPTED, "outcome": outcome, "submission_evidence": evidence}
    )
    assert value.submission_evidence == evidence


@pytest.mark.parametrize(
    "changes",
    [
        {"outcome": "retryable_failure"},
        {"outcome": "permanent_failure"},
        {"submission_evidence": "not_submitted"},
        {"submission_evidence": "unknown"},
        {"failure_scope": "message"},
        {"error_code": "raw text"},
        {"provider_request_id": "private\n"},
        {"retry_after_seconds": False},
        {"retry_after_seconds": "1"},
    ],
)
def test_delivery_wire_never_accepts_contradictory_or_unproved_metadata(changes):
    with pytest.raises(ValidationError):
        dto.Delivery.model_validate({**ACCEPTED, **changes})


@pytest.mark.parametrize(
    "changes",
    [
        {"claimed": True},
        {"claimed": 11},
        {"processed": 1},
        {"claimed": 1, "processed": 1},
        {"claimed": 1, "processed": 1, "accepted": 2},
        {"has_more": 1},
    ],
)
def test_summary_is_strict_and_each_claim_has_at_most_one_disposition(changes):
    with pytest.raises(ValidationError):
        dto.WorkflowProcessResponse.model_validate(changes)


def test_summary_context_enforces_actual_requested_limit():
    dto.WorkflowProcessResponse.model_validate({"claimed": 1, "processed": 0}, context={"limit": 1})
    with pytest.raises(ValidationError):
        dto.WorkflowProcessResponse.model_validate(
            {"claimed": 2, "processed": 0}, context={"limit": 1}
        )


@pytest.mark.parametrize("case", RPC_CASES, ids=lambda case: case[0])
@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
@pytest.mark.parametrize(
    "origin", ["https://synthetic.invalid", "https://redirect.synthetic.invalid"]
)
def test_no_payload_rpc_can_redirect_to_a_forged_success(case, status, origin):
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path == "/redirected-grant":
            return httpx.Response(200, json={"payload": case[4]})
        return httpx.Response(status, headers={"Location": origin + "/redirected-grant"})

    client = MockPostgrestClient(handler, 5.0)
    try:
        with pytest.raises(ValueError, match="^invalid_automation_dispatch_result$"):
            service._dispatch_rpc(
                service._WorkerClient(client, service._WorkerBudget(125, Clock())),
                case[0],
                case[1].model_validate(case[2]),
                case[3],
            )
        assert len(requests) == 1 and requests[0].url.host == "synthetic.invalid"
        assert requests[0].url.path != "/redirected-grant"
        client.builders[0][1].execute.assert_called_once()
    finally:
        client.aclose()


@pytest.mark.parametrize("phase", ["readiness", CLAIM_RPC, BEGIN])
@pytest.mark.parametrize(
    "origin", ["https://synthetic.invalid", "https://redirect.synthetic.invalid"]
)
def test_complete_graph_processor_never_submits_after_redirect(monkeypatch, phase, origin):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from fastapi import HTTPException
    from test_automation_service import prepared_sender
    from test_workflow_dispatcher import WorkflowDatabase

    from app.services import workflow_dispatcher as worker
    from app.services.workflow_capabilities import RELEASE_PREFLIGHT_RPC

    target = RELEASE_PREFLIGHT_RPC if phase == "readiness" else phase
    database = WorkflowDatabase(SETTINGS)
    requests = []
    transport = SimpleNamespace(
        prepare=Mock(return_value=prepared_sender(SETTINGS)), send_prepared=Mock()
    )

    def handler(request):
        requests.append(request)
        name = request.url.path.rsplit("/", 1)[-1]
        if name == target:
            return httpx.Response(307, headers={"Location": origin + "/redirected-grant"})
        if name == "redirected-grant":
            return httpx.Response(200, json={"payload": begun(SETTINGS)})
        return httpx.Response(
            200, json=database.rpc(name, json.loads(request.content)).execute().data
        )

    client = MockPostgrestClient(handler, 5.0)
    monkeypatch.setattr(
        worker,
        "get_platform_subscription_access",
        Mock(return_value={"subscription_required": False}),
    )

    def run():
        return worker.process_due_workflow_automations(
            SETTINGS,
            limit=1,
            clock=Clock(),
            client_factory=lambda **_: client,
            client_closer=lambda c: c.aclose(),
            transport_factory=lambda *_: transport,
        )

    if phase == BEGIN:
        assert run().unknown == 1
    else:
        with pytest.raises(HTTPException):
            run()
    transport.send_prepared.assert_not_called()
    assert not any(request.url.path == "/redirected-grant" for request in requests)
    assert client.session.is_closed
