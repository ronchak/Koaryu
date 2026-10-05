"""Mocked run-history proofs, with no SQL, hosted service, or mail execution."""

import base64
import json
from copy import deepcopy
from importlib.metadata import version
from itertools import product
from typing import get_args
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import TypeAdapter, ValidationError

from app.schemas import workflow_run as schema
from app.schemas.trial_appointment import MAX_REVISION
from app.schemas.workflow_management import AutomationOperationResponse, RunCancelOperationResponse
from app.services import workflow_run_service as boundary
from app.services.workflow_catalog import CATALOG
from app.services.workflow_management_service import WorkflowManagementService
from tests.test_workflow_management import (
    ACTOR,
    INSTANT,
    OPERATION,
    OPERATION_RPC,
    OTHER,
    STUDIO,
    VERSION,
    WORKFLOW,
    Database,
    SyntheticPostgrestClient,
    operation_receipt,
)

RUN, STEP, ATTEMPT, SUBJECT = (str(UUID(int=value)) for value in range(20, 24))
LATER = "2020-10-01T12:01:00Z"
EARLIER = "2020-10-01T11:59:00Z"
SUMMARY = {
    "id": RUN,
    "studio_id": STUDIO,
    "workflow_id": WORKFLOW,
    "version_id": VERSION,
    "version_number": 2,
    "event_type": "lead.created",
    "subject_kind": "lead",
    "subject_id": SUBJECT,
    "subject_label": "Aiko Tanaka",
    "state": "sending",
    "revision": 8,
    "current_node_id": "email",
    "next_due_at": None,
    "reason": None,
    "cancel_requested_at": None,
    "cancel_reason": None,
    "can_cancel": True,
    "created_at": INSTANT,
    "updated_at": INSTANT,
}
STEP_ROW = {
    "id": STEP,
    "sequence": 1,
    "node_id": "email",
    "node_type": "email",
    "outcome": "sending",
    "edge_id": None,
    "reason": None,
    "scheduled_at": None,
    "entered_at": INSTANT,
    "finished_at": None,
}
ATTEMPT_ROW = {
    "id": ATTEMPT,
    "node_id": "email",
    "attempt_number": 1,
    "state": "sending",
    "reason": None,
    "recipient_email": "aiko@example.com",
    "recipient_kind": "lead",
    "began_at": INSTANT,
    "settled_at": None,
    "submission_evidence": None,
    "failure_scope": None,
}
DETAIL = {"run": SUMMARY, "steps": [STEP_ROW], "attempts": [ATTEMPT_ROW]}
CANCELLED = {
    **DETAIL,
    "run": {
        **SUMMARY,
        "revision": 9,
        "can_cancel": False,
        "cancel_requested_at": LATER,
        "cancel_reason": "admin_cancelled",
    },
}
REQUEST = {"operation_id": OPERATION, "expected_revision": 8}
PAGE = {"items": [SUMMARY], "next_cursor": None, "has_more": False}
CURSOR = {"created_at": INSTANT, "id": RUN}
LIST_RPC = "list_automation_workflow_runs_v1"
GET_RPC = "get_automation_workflow_run_v1"
CANCEL_RPC = "cancel_automation_workflow_run_v1"
RPCS = [LIST_RPC, GET_RPC, CANCEL_RPC]
MODELS = [
    (schema.WorkflowRunSummary, SUMMARY),
    (schema.WorkflowRunStep, STEP_ROW),
    (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW),
    (schema.WorkflowRunDetail, DETAIL),
    (schema.WorkflowRunListResponse, PAGE),
    (schema.WorkflowRunCancelRequest, REQUEST),
]


def cancel_envelope(replayed=False):
    return {"payload": deepcopy(CANCELLED), "operation_id": OPERATION, "replayed": replayed}


def receipt():
    return operation_receipt("run.cancel", CANCELLED, "workflow_run", RUN)


def database():
    db = Database()
    db.handlers.update(
        {
            LIST_RPC: {"payload": deepcopy(PAGE)},
            GET_RPC: {"payload": deepcopy(DETAIL)},
            CANCEL_RPC: cancel_envelope(),
            OPERATION_RPC: receipt(),
        }
    )
    return db


def invoke(service, rpc):
    if rpc == LIST_RPC:
        return service.list(STUDIO, ACTOR, UUID(WORKFLOW))
    if rpc == GET_RPC:
        return service.get(STUDIO, ACTOR, UUID(RUN))
    return service.cancel(STUDIO, ACTOR, UUID(RUN), schema.WorkflowRunCancelRequest(**REQUEST))


def unavailable(call, detail=boundary.UNAVAILABLE_DETAIL):
    with pytest.raises(HTTPException) as error:
        call()
    assert (error.value.status_code, error.value.detail) == (503, detail)
    assert error.value.__suppress_context__ is True
    assert error.value.__cause__ is None


@pytest.mark.parametrize("model,payload", MODELS)
def test_exact_complete_public_fields_and_schema(model, payload):
    assert model.model_validate(payload).model_dump(mode="json") == payload
    for mode in ["validation", "serialization"]:
        document = model.model_json_schema(mode=mode)
        assert set(document["required"]) == set(payload)
        assert set(document["properties"]) == set(payload)
        assert document["additionalProperties"] is False


@pytest.mark.parametrize(
    "model,payload,field",
    [(model, payload, field) for model, payload in MODELS for field in payload],
)
def test_every_field_is_required_even_when_nullable(model, payload, field):
    row = deepcopy(payload)
    del row[field]
    with pytest.raises(ValidationError):
        model.model_validate(row)


@pytest.mark.parametrize("model,payload", MODELS)
@pytest.mark.parametrize(
    "field",
    [
        "body",
        "subject_template",
        "body_template",
        "raw_event_context",
        "credential_revision",
        "credential_token",
        "binding",
        "probe",
        "claim_token",
        "unsubscribe_token",
        "provider_response",
    ],
)
def test_private_extras_are_rejected_at_every_public_level(model, payload, field):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: "private"})


@pytest.mark.parametrize(
    "model,payload,field",
    [
        (model, payload, field)
        for model, payload in MODELS
        for field in payload
        if field == "id"
        or field.endswith("_id")
        and field not in {"node_id", "current_node_id", "edge_id"}
    ],
)
@pytest.mark.parametrize("bad", [True, 1, "invalid", {}, [], None])
def test_ids_are_uuid_values(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


@pytest.mark.parametrize(
    "model,payload,field",
    [
        (schema.WorkflowRunSummary, SUMMARY, "version_number"),
        (schema.WorkflowRunSummary, SUMMARY, "revision"),
        (schema.WorkflowRunStep, STEP_ROW, "sequence"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "attempt_number"),
        (schema.WorkflowRunCancelRequest, REQUEST, "expected_revision"),
    ],
)
@pytest.mark.parametrize("bad", [True, False, "1", 1.0, 0, -1, None])
def test_integer_fields_are_strict_positive(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


@pytest.mark.parametrize(
    "model,payload,field,bad",
    [
        (schema.WorkflowRunSummary, SUMMARY, "revision", MAX_REVISION + 1),
        (schema.WorkflowRunCancelRequest, REQUEST, "expected_revision", MAX_REVISION + 1),
        (schema.WorkflowRunStep, STEP_ROW, "sequence", 41),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "attempt_number", 4),
        (schema.WorkflowRunSummary, SUMMARY, "subject_label", ""),
        (schema.WorkflowRunSummary, SUMMARY, "subject_label", "a" * 241),
        (schema.WorkflowRunSummary, SUMMARY, "subject_label", 42),
        (schema.WorkflowRunSummary, SUMMARY, "can_cancel", 1),
        (schema.WorkflowRunListResponse, PAGE, "has_more", "false"),
        (schema.WorkflowRunDetail, DETAIL, "steps", (STEP_ROW,)),
        (schema.WorkflowRunDetail, DETAIL, "attempts", (ATTEMPT_ROW,)),
        (schema.WorkflowRunListResponse, PAGE, "items", (SUMMARY,)),
    ],
)
def test_invalid_scalars_and_collections(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


@pytest.mark.parametrize(
    "model,payload,field",
    [
        (schema.WorkflowRunSummary, SUMMARY, "current_node_id"),
        (schema.WorkflowRunStep, STEP_ROW, "node_id"),
        (schema.WorkflowRunStep, STEP_ROW, "edge_id"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "node_id"),
    ],
)
@pytest.mark.parametrize("bad", ["", "a" * 65, "a b", "é", "a\n", 1, True, b"email"])
def test_graph_id_grammar(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


@pytest.mark.parametrize(
    "model,payload,field",
    [
        (schema.WorkflowRunSummary, SUMMARY, "reason"),
        (schema.WorkflowRunSummary, CANCELLED["run"], "cancel_reason"),
        (schema.WorkflowRunStep, STEP_ROW, "reason"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "reason"),
    ],
)
@pytest.mark.parametrize("bad", ["", "Provider error", "unknown\n", "a" * 81, "0code", {}, [], 1])
def test_owned_reason_grammar(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


@pytest.mark.parametrize(
    "model,payload,field",
    [
        (schema.WorkflowRunSummary, SUMMARY, "event_type"),
        (schema.WorkflowRunSummary, SUMMARY, "state"),
        (schema.WorkflowRunSummary, SUMMARY, "subject_kind"),
        (schema.WorkflowRunStep, STEP_ROW, "node_type"),
        (schema.WorkflowRunStep, STEP_ROW, "outcome"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "state"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "recipient_kind"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "submission_evidence"),
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, "failure_scope"),
    ],
)
@pytest.mark.parametrize("bad", ["future_value", 1, {}, []])
def test_only_known_literals(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


def test_trigger_literals_match_current_catalog():
    assert set(get_args(schema.TriggerEvent)) == set(CATALOG["triggers"])


@pytest.mark.parametrize(
    "bad",
    [
        " Aiko@example.com",
        "Aiko@example.com",
        "",
        "a\n@example.com",
        "a@example",
        "Aiko <a@example.com>",
        "a@example.com,b@example.com",
        1,
    ],
)
def test_recipient_is_already_one_normalized_mailbox(bad):
    with pytest.raises(ValidationError):
        schema.WorkflowEmailAttemptSummary.model_validate({**ATTEMPT_ROW, "recipient_email": bad})


@pytest.mark.parametrize(
    "model,payload,field",
    [
        (schema.WorkflowRunSummary, SUMMARY, field)
        for field in ["created_at", "updated_at", "next_due_at", "cancel_requested_at"]
    ]
    + [
        (schema.WorkflowRunStep, STEP_ROW, field)
        for field in ["entered_at", "finished_at", "scheduled_at"]
    ]
    + [
        (schema.WorkflowEmailAttemptSummary, ATTEMPT_ROW, field)
        for field in ["began_at", "settled_at"]
    ],
)
@pytest.mark.parametrize(
    "bad", ["2020-10-01T12:00:00", "infinity", "2020-02-30T12:00:00Z", 1, True, {}, []]
)
def test_instants_are_valid_finite_and_offset_aware(model, payload, field, bad):
    with pytest.raises(ValidationError):
        model.model_validate({**payload, field: bad})


@pytest.mark.parametrize("state", get_args(schema.RunState))
@pytest.mark.parametrize("intent", [False, True])
def test_exact_run_state_matrix(state, intent):
    pending = state in {"queued", "waiting", "claimed", "running"}
    row = {
        **SUMMARY,
        "state": state,
        "next_due_at": INSTANT if pending else None,
        "cancel_requested_at": INSTANT if intent else None,
        "cancel_reason": "source_cancelled" if intent else None,
        "can_cancel": (pending or state == "sending") and not intent,
    }
    schema.WorkflowRunSummary.model_validate(row)
    for field, value in [
        ("next_due_at", None if pending else INSTANT),
        ("can_cancel", not row["can_cancel"]),
        ("cancel_requested_at", None if intent else INSTANT),
        ("cancel_reason", None if intent else "admin_cancelled"),
    ]:
        with pytest.raises(ValidationError):
            schema.WorkflowRunSummary.model_validate({**row, field: value})


@pytest.mark.parametrize(
    "outcome", get_args(schema.WorkflowRunStep.model_fields["outcome"].annotation)
)
def test_step_finish_matrix_and_local_chronology(outcome):
    pending = outcome in {"entered", "waiting", "sending"}
    row = {**STEP_ROW, "outcome": outcome, "finished_at": None if pending else INSTANT}
    schema.WorkflowRunStep.model_validate(row)
    for bad in [INSTANT] if pending else [None, EARLIER]:
        with pytest.raises(ValidationError):
            schema.WorkflowRunStep.model_validate({**row, "finished_at": bad})


@pytest.mark.parametrize(
    "state,evidence,scope",
    product(
        ["sending", "accepted", "failed", "unknown"],
        [None, "not_submitted", "rejected", "accepted", "unknown"],
        [None, "sender_auth", "sender_transient", "message", "unclassified"],
    ),
)
def test_attempt_nullable_evidence_matrix(state, evidence, scope):
    row = {
        **ATTEMPT_ROW,
        "state": state,
        "settled_at": None if state == "sending" else LATER,
        "submission_evidence": evidence,
        "failure_scope": scope,
    }
    compatible_evidence = {
        "sending": {None},
        "accepted": {None, "accepted"},
        "failed": {None, "not_submitted", "rejected"},
        "unknown": {None, "unknown"},
    }
    compatible_scope = {
        "sending": {None},
        "accepted": {None},
        "failed": {None, "sender_auth", "sender_transient", "message", "unclassified"},
        "unknown": {None, "unclassified"},
    }
    if evidence in compatible_evidence[state] and scope in compatible_scope[state]:
        assert schema.WorkflowEmailAttemptSummary.model_validate(row).model_dump(mode="json") == row
    else:
        with pytest.raises(ValidationError):
            schema.WorkflowEmailAttemptSummary.model_validate(row)


@pytest.mark.parametrize("state", ["sending", "accepted", "failed", "unknown"])
def test_attempt_settlement_matrix_and_local_chronology(state):
    for bad in [INSTANT] if state == "sending" else [None, EARLIER]:
        with pytest.raises(ValidationError):
            schema.WorkflowEmailAttemptSummary.model_validate(
                {**ATTEMPT_ROW, "state": state, "settled_at": bad}
            )
    if state != "sending":
        schema.WorkflowEmailAttemptSummary.model_validate(
            {**ATTEMPT_ROW, "state": state, "settled_at": INSTANT}
        )


def bounded_detail():
    return {
        "run": deepcopy(SUMMARY),
        "steps": [
            {**STEP_ROW, "id": str(UUID(int=100 + i)), "sequence": i + 1, "node_id": f"email_{i}"}
            for i in range(40)
        ],
        "attempts": [
            {
                **ATTEMPT_ROW,
                "id": str(UUID(int=200 + i * 3 + j)),
                "node_id": f"email_{i}",
                "attempt_number": j + 1,
            }
            for i in range(40)
            for j in range(3)
        ],
    }


def test_full_bounded_detail_and_absence_of_unstated_cross_row_clock_restrictions():
    detail = bounded_detail()
    assert len(schema.WorkflowRunDetail.model_validate(detail).attempts) == 120
    detail["run"].update(
        state="unknown",
        can_cancel=False,
        cancel_requested_at=EARLIER,
        cancel_reason="source_cancelled",
        created_at="2099-01-01T00:00:00Z",
    )
    detail["attempts"][0].update(
        state="unknown",
        settled_at=LATER,
        began_at=EARLIER,
        submission_evidence="unknown",
        failure_scope="unclassified",
    )
    # A terminal run can still retain in-flight step facts and different clocks.
    schema.WorkflowRunDetail.model_validate(detail)
    schema.WorkflowRunDetail.model_validate({"run": SUMMARY, "steps": [], "attempts": []})


@pytest.mark.parametrize(
    "case",
    [
        "steps_bound",
        "attempts_bound",
        "step_id",
        "node_id",
        "sequence",
        "step_order",
        "attempt_id",
        "ordinal",
        "attempt_order",
        "absent_node",
        "not_email",
    ],
)
def test_history_bounds_uniqueness_ownership_and_order(case):
    detail = bounded_detail()
    if case == "steps_bound":
        detail["steps"].append(deepcopy(detail["steps"][-1]))
    elif case == "attempts_bound":
        detail["attempts"].append(deepcopy(detail["attempts"][-1]))
    elif case in {"step_id", "node_id", "sequence"}:
        field = "id" if case == "step_id" else case
        detail["steps"][1][field] = detail["steps"][0][field]
    elif case == "step_order":
        detail["steps"].reverse()
    elif case == "attempt_order":
        detail["attempts"].reverse()
    elif case in {"attempt_id", "ordinal"}:
        field = "id" if case == "attempt_id" else "attempt_number"
        detail["attempts"][1][field] = detail["attempts"][0][field]
    elif case == "absent_node":
        detail["attempts"][0]["node_id"] = "missing"
    else:
        detail["steps"][0]["node_type"] = "delay"
    with pytest.raises(ValidationError):
        schema.WorkflowRunDetail.model_validate(detail)


@pytest.mark.parametrize("rpc", RPCS)
def test_exact_rpc_signatures_and_no_history_prereads(rpc):
    db = database()
    invoke(boundary.WorkflowRunService(db), rpc)
    params = {"p_studio_id": STUDIO, "p_actor_id": ACTOR}
    params.update(
        {"p_workflow_id": WORKFLOW, "p_limit": 50, "p_cursor": None}
        if rpc == LIST_RPC
        else {"p_run_id": RUN}
    )
    if rpc == CANCEL_RPC:
        params.update(p_operation_id=OPERATION, p_expected_revision=8)
    assert db.rpc_calls == [(rpc, params)]
    assert db.execute_calls == [rpc]
    assert not db.query_log


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize("field", ["studio_id", "id"])
def test_foreign_studio_and_target_identity_fail_closed(rpc, field):
    db = database()
    payload = db.handlers[rpc]["payload"]
    if rpc == LIST_RPC:
        payload["items"][0]["studio_id" if field == "studio_id" else "workflow_id"] = OTHER
    else:
        payload["run"][field] = OTHER
    unavailable(lambda: invoke(boundary.WorkflowRunService(db), rpc))
    assert db.execute_calls == [rpc]


@pytest.mark.parametrize("replayed", [False, True])
def test_fresh_and_replayed_cancel_preserve_original_sending_snapshot(replayed):
    db = database()
    db.handlers[CANCEL_RPC] = cancel_envelope(replayed)
    # Today's GET has advanced, but cancellation must not consult it.
    db.handlers[GET_RPC]["payload"]["run"].update(state="unknown", revision=12, can_cancel=False)
    result = invoke(boundary.WorkflowRunService(db), CANCEL_RPC)
    assert result.payload.model_dump(mode="json") == CANCELLED
    assert result.replayed is replayed
    assert db.execute_calls == [CANCEL_RPC]


@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize(
    "case",
    [
        "revision_old",
        "revision_later",
        "intent_missing",
        "reason_missing",
        "can_cancel",
        "operation_id",
        "replayed_scalar",
    ],
)
def test_cancel_rejects_nonoriginal_revision_or_incomplete_intent(replayed, case):
    db = database()
    result = cancel_envelope(replayed)
    if case.startswith("revision"):
        result["payload"]["run"]["revision"] = 8 if case == "revision_old" else 10
    elif case in {"intent_missing", "reason_missing", "can_cancel"}:
        field, value = {
            "intent_missing": ("cancel_requested_at", None),
            "reason_missing": ("cancel_reason", None),
            "can_cancel": ("can_cancel", True),
        }[case]
        result["payload"]["run"][field] = value
    else:
        result["operation_id" if case == "operation_id" else "replayed"] = (
            OTHER if case == "operation_id" else "true"
        )
    db.handlers[CANCEL_RPC] = result
    unavailable(lambda: invoke(boundary.WorkflowRunService(db), CANCEL_RPC))
    assert db.execute_calls == [CANCEL_RPC]


def cursor_token(value):
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.mark.parametrize(
    "cursor",
    [
        "",
        "a" * 513,
        "=",
        "a",
        "{}",
        "é",
        cursor_token({}),
        cursor_token({**CURSOR, "extra": 1}),
        cursor_token({**CURSOR, "created_at": "infinity"}),
        cursor_token(b'{"id":null,"id":null}'),
        cursor_token(b'{"id":NaN}'),
        cursor_token(b"\xff"),
    ],
)
def test_cursor_rejected_before_rpc(cursor):
    db = database()
    with pytest.raises(HTTPException) as error:
        boundary.WorkflowRunService(db).list(STUDIO, ACTOR, UUID(WORKFLOW), cursor=cursor)
    assert error.value.status_code == 422
    assert not db.rpc_calls


@pytest.mark.parametrize("limit", [True, False, 0, 101, "1", 1.0])
def test_limit_rejected_before_rpc(limit):
    db = database()
    with pytest.raises(HTTPException) as error:
        boundary.WorkflowRunService(db).list(STUDIO, ACTOR, UUID(WORKFLOW), limit=limit)
    assert error.value.status_code == 422 and not db.rpc_calls


def test_cursor_roundtrip_and_descending_keyset():
    db = database()
    db.handlers[LIST_RPC]["payload"].update(next_cursor=CURSOR, has_more=True)
    service = boundary.WorkflowRunService(db)
    first = service.list(STUDIO, ACTOR, UUID(WORKFLOW), limit=1)
    db.handlers[LIST_RPC]["payload"] = {
        "items": [{**SUMMARY, "id": OTHER}],
        "next_cursor": None,
        "has_more": False,
    }
    second = service.list(STUDIO, ACTOR, UUID(WORKFLOW), cursor=first.next_cursor)
    assert second.items[0].id == UUID(OTHER)
    assert db.rpc_calls[-1][1]["p_cursor"] == CURSOR


@pytest.mark.parametrize(
    "case",
    [
        "over_limit",
        "over_bound",
        "has_more",
        "missing_more",
        "cursor_id",
        "cursor_time",
        "empty_cursor",
        "duplicate",
        "order",
        "past_cursor",
        "extra_cursor",
    ],
)
def test_malformed_pages_fail_closed(case):
    db = database()
    page = db.handlers[LIST_RPC]["payload"]
    cursor = None
    if case in {"over_limit", "over_bound", "duplicate"}:
        page["items"] *= 101 if case == "over_bound" else 2
    elif case == "has_more":
        page["has_more"] = True
    elif case == "missing_more":
        page["next_cursor"] = CURSOR
    elif case in {"cursor_id", "cursor_time", "extra_cursor", "empty_cursor"}:
        page.update(next_cursor=deepcopy(CURSOR), has_more=True)
        if case == "empty_cursor":
            page["items"] = []
        else:
            page["next_cursor"].update(
                {
                    "cursor_id": {"id": OTHER},
                    "cursor_time": {"created_at": LATER},
                    "extra_cursor": {"extra": True},
                }[case]
            )
    elif case == "order":
        page["items"] = [{**SUMMARY, "id": OTHER}, SUMMARY]
    else:
        cursor = cursor_token(CURSOR)
    unavailable(
        lambda: boundary.WorkflowRunService(db).list(
            STUDIO, ACTOR, UUID(WORKFLOW), limit=1 if case == "over_limit" else 50, cursor=cursor
        )
    )


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize("bad", [None, [], {}, "private", {"payload": []}, {"payload": None}])
def test_strict_envelopes_no_bare_or_list_fallback(rpc, bad):
    db = database()
    db.handlers[rpc] = bad
    unavailable(lambda: invoke(boundary.WorkflowRunService(db), rpc))
    assert db.execute_calls == [rpc]


@pytest.mark.parametrize("rpc", RPCS)
def test_envelope_extras_rejected(rpc):
    db = database()
    db.handlers[rpc]["credential"] = "private"
    unavailable(lambda: invoke(boundary.WorkflowRunService(db), rpc))


@pytest.mark.parametrize("rpc", RPCS)
def test_pinned_sdk_success_once(rpc):
    assert version("postgrest") == "0.17.2"
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=database().handlers[rpc])

    with SyntheticPostgrestClient(handler) as client:
        invoke(boundary.WorkflowRunService(client), rpc)
    assert len(calls) == 1 and calls[0].url.path == f"/rest/v1/rpc/{rpc}"


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("value", [None, [], {}, 1, 1.5, True, False])
def test_pinned_sdk_unhashable_and_malformed_errors_are_fixed_503(rpc, field, value):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            503,
            json={
                "code": "P0001",
                "message": "AUTOMATION_STATE_CONFLICT",
                "details": "private",
                "hint": "private",
                field: value,
            },
        )

    with SyntheticPostgrestClient(handler) as client:
        unavailable(lambda: invoke(boundary.WorkflowRunService(client), rpc))
    assert len(calls) == 1


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize("pair,mapped", boundary._ERRORS.items())
def test_owned_errors_are_safe_and_not_retried(rpc, pair, mapped):
    db = database()
    db.handlers[rpc] = APIError(
        {"code": pair[0], "message": pair[1], "details": "private", "hint": "private"}
    )
    with pytest.raises(HTTPException) as error:
        invoke(boundary.WorkflowRunService(db), rpc)
    assert (error.value.status_code, error.value.detail) == mapped
    assert db.execute_calls == [rpc]


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("private"),
        APIError(
            {"code": "PGRST202", "message": "private", "details": "private", "hint": "private"}
        ),
    ],
)
def test_unknown_provider_failures_do_not_retry(rpc, error):
    db = database()
    db.handlers[rpc] = error
    unavailable(lambda: invoke(boundary.WorkflowRunService(db), rpc))
    assert db.execute_calls == [rpc]


def test_typed_receipt_replays_original_snapshot_without_inventing_original_cas():
    db = database()
    db.handlers[OPERATION_RPC]["payload"]["result"]["run"]["revision"] = 100
    result = WorkflowManagementService(db).operation(STUDIO, ACTOR, UUID(OPERATION), "admin")
    assert isinstance(result, RunCancelOperationResponse)
    assert result.result.run.revision == 100
    assert db.execute_calls == [OPERATION_RPC]


@pytest.mark.parametrize(
    "case",
    [
        "studio_id",
        "entity_id",
        "operation_id",
        "entity_type",
        "command",
        "result_type",
        "private_extra",
        "no_intent",
    ],
)
def test_cancel_receipt_rejects_wrong_identity_type_scope_or_private_payload(case):
    from app.services.workflow_management_service import UNAVAILABLE_DETAIL

    db = database()
    result = db.handlers[OPERATION_RPC]["payload"]
    if case == "studio_id":
        result["result"]["run"]["studio_id"] = OTHER
    elif case in {"entity_id", "operation_id"}:
        result[case] = OTHER
    elif case == "entity_type":
        result[case] = "workflow"
    elif case == "command":
        result[case] = "run.retry"
    elif case == "result_type":
        result["result"] = SUMMARY
    elif case == "private_extra":
        result["result"]["attempts"][0]["body"] = "private"
    else:
        result["result"]["run"].update(
            can_cancel=True, cancel_requested_at=None, cancel_reason=None
        )
    unavailable(
        lambda: WorkflowManagementService(db).operation(STUDIO, ACTOR, UUID(OPERATION), "admin"),
        UNAVAILABLE_DETAIL,
    )
    assert db.execute_calls == [OPERATION_RPC]


def test_front_desk_cannot_read_cancel_even_if_sql_returns_it():
    db = database()
    with pytest.raises(HTTPException) as error:
        WorkflowManagementService(db).operation(STUDIO, ACTOR, UUID(OPERATION), "front_desk")
    assert error.value.status_code == 403
    assert isinstance(
        TypeAdapter(AutomationOperationResponse).validate_python(receipt()["payload"]),
        RunCancelOperationResponse,
    )
