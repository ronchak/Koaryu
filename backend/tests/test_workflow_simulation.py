"""Pure preview and mocked RPC proofs. No SQL, provider or customer reads."""

import json
from copy import deepcopy
from datetime import UTC, date, datetime, timedelta, timezone
from importlib.metadata import version
from itertools import pairwise
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import ValidationError

from app.schemas.workflow_management import guard_workflow_request
from app.schemas.workflow_simulation import (
    WorkflowSimulationRequest,
    WorkflowSimulationResponse,
    WorkflowSimulationTrace,
)
from app.services import workflow_simulation_service as boundary
from app.services.workflow_catalog import CATALOG, build_preset
from app.services.workflow_email import WorkflowEventTimeValue, WorkflowMoneyValue
from app.services.workflow_graph import validate_workflow_graph
from app.services.workflow_management_service import UNAVAILABLE_DETAIL
from app.services.workflow_simulation_service import (
    SIMULATION_RPC,
    WorkflowSimulationService,
    build_synthetic_workflow_facts,
)
from tests.test_workflow_management import SyntheticPostgrestClient, huge_safe_draft

STUDIO, ACTOR, WORKFLOW, ENTITY, OTHER = (str(UUID(int=n)) for n in range(1, 6))
NOW = datetime(2026, 10, 5, 12, 30, 10, 123456, tzinfo=UTC)
INSTANT = NOW.isoformat().replace("+00:00", "Z")
ISSUE = {
    "code": "reference_unavailable",
    "message": "Choose an available program or rank.",
    "node_id": "trigger",
    "edge_id": None,
    "field": "config.program_id",
}


def node(node_id, kind, **config):
    return {"id": node_id, "type": kind, "config": config}


def email(
    node_id="mail",
    recipient="lead_or_guardian",
    subject="Hello {{recipient_name}}",
    body="{{studio_name}}",
):
    return node(
        node_id,
        "email",
        recipient=recipient,
        subject_template=subject,
        body_template=body,
        reply_to_email="",
    )


def graph_for(event="lead.created", *middle):
    trigger = node("trigger", "trigger", event_type=event, program_id=None)
    if CATALOG["triggers"][event]["supports_offset"]:
        trigger["config"]["offset_minutes"] = -1440
    nodes = [trigger, *middle, node("end", "end")]
    edges = []
    for source, target in pairwise(nodes):
        port = "yes" if source["type"] == "condition" else "next"
        edges.append(
            {
                "id": source["id"] + "_" + port,
                "source": source["id"],
                "target": target["id"],
                "port": port,
            }
        )
        if port == "yes":
            edges.append(
                {"id": source["id"] + "_no", "source": source["id"], "target": "end", "port": "no"}
            )
    return {"schema_version": 1, "nodes": nodes, "edges": edges}


def request_for(graph=None, *, entity=False):
    graph = graph if graph is not None else graph_for("lead.created", email())
    event = graph["nodes"][0]["config"]["event_type"]
    context = {"kind": "synthetic"}
    if entity:
        context = {
            "kind": "entity",
            "entity_type": CATALOG["triggers"][event]["simulation_entity_type"],
            "entity_id": ENTITY,
        }
    return WorkflowSimulationRequest.model_validate({"graph": graph, "context": context})


def wire_facts(*, recipients=("lead_or_guardian",)):
    return {
        "source_decision": "eligible",
        "source_reason": None,
        "condition_facts": {},
        "template_facts": {"studio_name": {"kind": "text", "value": "Private studio"}},
        "anchors": {},
        "recipients": {
            policy: {
                "decision": "ready",
                "reason": None,
                "template_facts": {
                    "recipient_name": {"kind": "text", "value": "Private " + policy}
                },
            }
            for policy in recipients
        },
    }


def envelope(request=None, *, facts=None, valid=True, issues=None):
    request = request if request is not None else request_for()
    triggers = [n for n in request.graph.nodes if n.type == "trigger"]
    event = (
        triggers[0].config.event_type
        if len(triggers) == 1 and triggers[0].config.event_type in CATALOG["triggers"]
        else None
    )
    return {
        "payload": {
            "studio_id": STUDIO,
            "workflow_id": WORKFLOW,
            "context": request.context.model_dump(mode="json"),
            "reference_time": INSTANT,
            "valid": valid,
            "issues": issues if issues is not None else [],
            "event_type": event,
            "facts": facts,
        }
    }


class ReadClient:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, deepcopy(params)))

        def execute():
            if isinstance(self.result, Exception):
                raise self.result
            return SimpleNamespace(data=deepcopy(self.result))

        return SimpleNamespace(execute=execute)


def simulate(request=None, *, facts=None, result=None):
    request = request if request is not None else request_for(entity=facts is not None)
    client = ReadClient(result if result is not None else envelope(request, facts=facts))
    response = WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request)
    assert len(client.calls) == 1
    assert client.calls[0] == (
        SIMULATION_RPC,
        {
            "p_studio_id": STUDIO,
            "p_actor_id": ACTOR,
            "p_workflow_id": WORKFLOW,
            "p_graph": request.graph.model_dump(mode="json"),
            "p_context": request.context.model_dump(mode="json"),
        },
    )
    return response


def unavailable(request, result):
    client = ReadClient(result)
    with pytest.raises(HTTPException) as caught:
        WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request)
    assert caught.value.status_code == 503
    assert caught.value.detail == UNAVAILABLE_DETAIL
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
    assert len(client.calls) == 1


@pytest.mark.parametrize(
    "preset, outcomes",
    [
        ("welcome", ["entered", "would_send", "completed"]),
        ("promotion_congratulations", ["entered", "would_send", "completed"]),
        ("new_lead_follow_up", ["entered", "would_send", "waiting"]),
        ("trial_reminder", ["entered", "would_send", "completed"]),
        ("trial_completion_follow_up", ["entered", "waiting"]),
        ("trial_no_show", ["entered", "matched", "would_send", "would_follow_up", "completed"]),
        ("overdue_recovery", ["entered", "would_send", "waiting"]),
        ("failed_payment_notice", ["entered", "matched", "would_send", "completed"]),
        ("belt_test_invitation", ["entered", "would_send", "waiting"]),
    ],
)
def test_all_presets_stop_before_future_nodes(preset, outcomes):
    request = request_for(build_preset(preset))
    original = request.model_dump(mode="json")
    result = simulate(request)
    assert result.valid and not result.issues
    assert [row.outcome for row in result.trace] == outcomes
    assert result.reference_time == NOW
    assert result.future_conditions_rechecked is True
    assert len(result.next_actions) == sum(outcome.startswith("would_") for outcome in outcomes)
    assert all(
        action.scheduled_at is None and action.reason is None for action in result.next_actions
    )
    assert original == request.model_dump(mode="json")
    for row in result.trace:
        assert set(row.model_dump()) == {
            "node_id",
            "outcome",
            "edge_id",
            "reason",
            "scheduled_at",
            "action_kind",
            "rendered_subject",
            "rendered_body",
        }
        if row.rendered_body:
            assert "Unsubscribe" not in row.rendered_body and "<html" not in row.rendered_body
    result.validate_graph_path(request.graph)


@pytest.mark.parametrize("event", CATALOG["triggers"])
def test_exact_applicable_sample_facts(event):
    metadata = CATALOG["triggers"][event]
    kwargs = {
        "program_id": None,
        "offset_minutes": -317 if metadata["supports_offset"] else None,
        "recipient_ids": frozenset(metadata["recipient_ids"]),
    }
    facts = build_synthetic_workflow_facts(event, NOW, **kwargs)
    assert facts.source_decision == "eligible" and facts.source_reason is None
    assert set(facts.condition_facts) == set(metadata["field_ids"])
    assert set(facts.template_facts) == set(metadata["template_variables"]) - {"recipient_name"}
    assert set(facts.anchors) == set(metadata["delay_fields"])
    assert set(facts.recipients) == set(metadata["recipient_ids"])
    expected = {
        "student.status": "active",
        "student.on_hold": False,
        "student.is_minor": False,
        "lead.source": "website",
        "lead.unconverted": True,
        "lead.stage": "trial_completed"
        if event == "trial.completed"
        else "trial_scheduled"
        if event.startswith("trial.")
        else "inquiry",
        "trial.status": {"trial.completed": "completed", "trial.no_show": "no_show"}.get(
            event, "scheduled"
        ),
        "invoice.open_balance": True,
        "invoice.overdue": event == "invoice.overdue",
        "invoice.collection_method": "send_invoice"
        if event == "invoice.overdue"
        else "charge_automatically",
        "program.id": "00000000-0000-4000-8000-000000000001",
        "promotion.rank_id": "00000000-0000-4000-8000-000000000002",
        "belt_test.event_scheduled": True,
        "belt_test.approval_current": True,
    }
    assert facts.condition_facts == {key: expected[key] for key in metadata["field_ids"]}
    for policy, recipient in facts.recipients.items():
        assert recipient.decision == "ready" and recipient.reason is None
        assert recipient.template_facts == {
            "recipient_name": {
                "student_or_guardian": "Sample student",
                "lead_or_guardian": "Sample lead",
                "assigned_staff": "Sample staff",
                "invoice_payer": "Sample payer",
            }[policy]
        }
    if event.startswith(("trial.", "belt_test.")):
        delta = (
            timedelta(minutes=317)
            if metadata["supports_offset"]
            else timedelta(days=2)
            if event == "trial.scheduled"
            else timedelta(days=7)
            if event == "belt_test.approved"
            else -timedelta(hours=2)
        )
        value = facts.template_facts["trial_start" if event.startswith("trial.") else "event_start"]
        assert type(value) is WorkflowEventTimeValue
        assert (
            value.instant == NOW + delta
            and value.instant.microsecond == 123456
            and value.timezone == "UTC"
        )
        assert all(anchor == value.instant for anchor in facts.anchors.values())
    if event.startswith("invoice."):
        assert facts.template_facts["invoice_balance"] == WorkflowMoneyValue(
            1234, "usd", "stripe_minor_units"
        )
        assert facts.template_facts["invoice_due_date"] == NOW.date() + timedelta(
            days=-7 if event == "invoice.overdue" else 7
        )
    again = build_synthetic_workflow_facts(event, NOW, **kwargs)
    assert facts == again
    for name in ("condition_facts", "template_facts", "anchors", "recipients"):
        assert getattr(facts, name) is not getattr(again, name)
    for policy in facts.recipients:
        assert (
            facts.recipients[policy].template_facts is not again.recipients[policy].template_facts
        )
    facts.template_facts["studio_name"] = "Changed"
    assert again.template_facts["studio_name"] == "Sample studio"


@pytest.mark.parametrize("event", CATALOG["triggers"])
def test_sample_program_filter_and_empty_recipient_selection(event):
    metadata = CATALOG["triggers"][event]
    program = UUID(OTHER) if metadata["supports_program_filter"] else None
    facts = build_synthetic_workflow_facts(
        event,
        NOW,
        program_id=program,
        offset_minutes=-1 if metadata["supports_offset"] else None,
        recipient_ids=frozenset(),
    )
    assert facts.recipients == {}
    if "program.id" in metadata["field_ids"]:
        assert facts.condition_facts["program.id"] == OTHER
    else:
        assert "program.id" not in facts.condition_facts
    if "program_name" in facts.template_facts:
        assert facts.template_facts["program_name"] == "Sample program"


@pytest.mark.parametrize("offset", [-129600, -1])
def test_upcoming_factory_preserves_exact_offset(offset):
    facts = build_synthetic_workflow_facts(
        "trial.upcoming", NOW, program_id=None, offset_minutes=offset, recipient_ids=frozenset()
    )
    assert facts.anchors["trial.starts_at"] == NOW - timedelta(minutes=offset)


@pytest.mark.parametrize(
    "event, instant, program, offset, recipients",
    [
        ("unknown", NOW, None, None, frozenset()),
        ("trial.upcoming", NOW, None, None, frozenset()),
        *[
            ("trial.upcoming", NOW, None, value, frozenset())
            for value in (True, False, -1.0, "-1", 0, 1, -129601)
        ],
        ("lead.created", NOW, None, -1, frozenset()),
        ("lead.created", NOW.replace(tzinfo=None), None, None, frozenset()),
        ("lead.created", NOW.astimezone(timezone(timedelta(hours=1))), None, None, frozenset()),
        ("lead.created", INSTANT, None, None, frozenset()),
        ("lead.created", NOW, OTHER, None, frozenset()),
        ("invoice.overdue", NOW, UUID(OTHER), None, frozenset()),
        ("lead.created", NOW, None, None, {"lead_or_guardian"}),
        ("lead.created", NOW, None, None, frozenset({"invoice_payer"})),
    ],
)
def test_factory_rejects_noncanonical_or_inapplicable_inputs(
    event, instant, program, offset, recipients
):
    with pytest.raises(ValueError):
        build_synthetic_workflow_facts(
            event, instant, program_id=program, offset_minutes=offset, recipient_ids=recipients
        )


def test_sample_values_are_not_changed_to_satisfy_conditions():
    graph = graph_for(
        "student.promoted",
        node("condition", "condition", field="promotion.rank_id", operator="eq", value=OTHER),
        email(recipient="student_or_guardian"),
    )
    result = simulate(request_for(graph))
    assert [row.outcome for row in result.trace] == ["entered", "not_matched", "completed"]
    assert result.trace[1].edge_id == "condition_no" and not result.next_actions


@pytest.mark.parametrize(
    "decision,outcome", [("ineligible", "skipped"), ("unavailable", "waiting")]
)
def test_source_decision_stops_at_trigger_without_recomputing_conditions(decision, outcome):
    facts = wire_facts()
    facts.update(source_decision=decision, source_reason="source_unavailable")
    facts["condition_facts"] = {"lead.unconverted": True}
    result = simulate(facts=facts)
    assert result.valid and len(result.trace) == 1 and not result.next_actions
    assert result.trace[0].model_dump() == {
        "node_id": "trigger",
        "outcome": outcome,
        "edge_id": None,
        "reason": "source_unavailable",
        "scheduled_at": None,
        "action_kind": None,
        "rendered_subject": None,
        "rendered_body": None,
    }


def test_eligible_source_is_consumed_without_a_second_source_policy():
    facts = wire_facts()
    facts["condition_facts"] = {"lead.unconverted": False, "lead.stage": "closed_lost"}
    assert simulate(facts=facts).trace[1].outcome == "would_send"


@pytest.mark.parametrize(
    "field,actual",
    [
        ("lead.unconverted", None),
        ("lead.unconverted", "true"),
        ("lead.stage", "unknown"),
        ("program.id", "not-a-uuid"),
        ("lead.source", "x" * 501),
    ],
)
def test_selected_invalid_scalar_waits_instead_of_taking_no(field, actual):
    expected = {
        "lead.unconverted": True,
        "lead.stage": "inquiry",
        "program.id": OTHER,
        "lead.source": "website",
    }[field]
    graph = graph_for(
        "lead.created",
        node("condition", "condition", field=field, operator="neq", value=expected),
        email(),
    )
    facts = wire_facts()
    facts["condition_facts"][field] = actual
    result = simulate(request_for(graph, entity=True), facts=facts)
    assert [row.outcome for row in result.trace] == ["entered", "waiting"]
    assert result.trace[-1].reason == "facts_unavailable" and result.trace[-1].edge_id is None
    assert not result.next_actions


@pytest.mark.parametrize(
    "present,actual,outcome",
    [(False, None, "waiting"), (True, None, "matched"), (True, OTHER, "not_matched")],
)
def test_missing_and_known_null_condition_facts_differ(present, actual, outcome):
    graph = graph_for(
        "lead.created",
        node("condition", "condition", field="program.id", operator="eq", value=None),
        email(),
    )
    facts = wire_facts()
    if present:
        facts["condition_facts"]["program.id"] = actual
    result = simulate(request_for(graph, entity=True), facts=facts)
    assert result.trace[1].outcome == outcome
    assert bool(result.next_actions) == (outcome == "matched")


@pytest.mark.parametrize("minutes", [0, 1, 129600])
def test_duration_is_relative_to_hypothetical_trigger_now(minutes):
    graph = graph_for(
        "lead.created",
        node("delay", "delay", mode="duration", minutes=minutes),
        node("condition", "condition", field="lead.unconverted", operator="eq", value=True),
        email(),
    )
    result = simulate(request_for(graph))
    delay = result.trace[1]
    assert delay.scheduled_at == NOW + timedelta(minutes=minutes)
    assert delay.outcome == ("waiting" if minutes else "entered")
    assert delay.edge_id == (None if minutes else "delay_next")
    assert len(result.trace) == (2 if minutes else 5)
    assert len(result.next_actions) == (0 if minutes else 1)


@pytest.mark.parametrize("anchor_delta,offset", [(10, -11), (10, -10), (10, -9), (-10, 20)])
def test_until_uses_exact_anchor_and_stops_only_when_future(anchor_delta, offset):
    graph = graph_for(
        "trial.scheduled",
        node("delay", "delay", mode="until", field="trial.starts_at", offset_minutes=offset),
        email(),
    )
    facts = wire_facts()
    facts["anchors"]["trial.starts_at"] = (NOW + timedelta(minutes=anchor_delta)).isoformat()
    result = simulate(request_for(graph, entity=True), facts=facts)
    due = NOW + timedelta(minutes=anchor_delta + offset)
    assert result.trace[1].scheduled_at == due
    assert result.trace[1].outcome == ("waiting" if due > NOW else "entered")
    assert bool(result.next_actions) == (due <= NOW)


def test_missing_anchor_waits_with_no_due_time_or_downstream_action():
    graph = graph_for(
        "trial.scheduled",
        node("delay", "delay", mode="until", field="trial.starts_at", offset_minutes=0),
        email(),
    )
    result = simulate(request_for(graph, entity=True), facts=wire_facts())
    assert result.trace[-1].outcome == "waiting" and result.trace[-1].reason == "facts_unavailable"
    assert result.trace[-1].scheduled_at is None and result.trace[-1].edge_id is None
    assert not result.next_actions


def simulate_delay_projection(request, projection, sdk):
    if not sdk:
        return simulate(request, result=projection)
    calls = []

    def handler(http_request):
        calls.append(http_request)
        return httpx.Response(200, json=projection)

    with SyntheticPostgrestClient(handler) as client:
        result = WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request)
    assert len(calls) == 1 and calls[0].url.path == "/rest/v1/rpc/" + SIMULATION_RPC
    assert json.loads(calls[0].content)["p_graph"] == request.graph.model_dump(mode="json")
    return result


@pytest.mark.parametrize("sdk", [False, True])
def test_original_until_overflow_returns_a_complete_waiting_dto(sdk):
    graph = {
        "schema_version": 1,
        "nodes": [
            node("t", "trigger", event_type="trial.scheduled", program_id=None),
            node("d", "delay", mode="until", field="trial.starts_at", offset_minutes=1),
            node("e", "end"),
        ],
        "edges": [
            {"id": "t_d", "source": "t", "target": "d", "port": "next"},
            {"id": "d_e", "source": "d", "target": "e", "port": "next"},
        ],
    }
    request = request_for(graph, entity=True)
    assert validate_workflow_graph(request.graph, catalog=CATALOG).valid
    facts = wire_facts(recipients=())
    facts["anchors"]["trial.starts_at"] = "9999-12-31T23:59:00Z"
    projection = envelope(request, facts=facts)
    projection["payload"]["reference_time"] = "2026-10-06T00:00:00Z"
    result = simulate_delay_projection(request, projection, sdk)
    assert result.valid and result.issues == [] and result.next_actions == []
    assert result.reference_time == datetime(2026, 10, 6, tzinfo=UTC)
    assert result.future_conditions_rechecked is True
    assert [row.node_id for row in result.trace] == ["t", "d"]
    assert result.trace[-1].model_dump() == {
        "node_id": "d",
        "outcome": "waiting",
        "edge_id": None,
        "reason": "facts_unavailable",
        "scheduled_at": None,
        "action_kind": None,
        "rendered_subject": None,
        "rendered_body": None,
    }
    assert WorkflowSimulationResponse.model_validate_json(result.model_dump_json()) == result


@pytest.mark.parametrize("sdk", [False, True])
@pytest.mark.parametrize("earlier_action", [False, True])
@pytest.mark.parametrize(
    "mode,instant,minutes",
    [
        ("until", "9999-12-31T23:59:00Z", 1),
        ("until", "0001-01-01T00:00:00Z", -1),
        ("until", "9999-12-31T23:59:59.999999Z", 129600),
        ("until", "0001-01-01T00:00:00Z", -129600),
        ("duration", "9999-12-31T23:59:00Z", 1),
    ],
)
def test_delay_overflow_stops_without_downstream_work(mode, instant, minutes, earlier_action, sdk):
    config = (
        {"mode": mode, "minutes": minutes}
        if mode == "duration"
        else {"mode": mode, "field": "trial.starts_at", "offset_minutes": minutes}
    )
    graph = graph_for(
        "trial.scheduled",
        *([email("before")] if earlier_action else []),
        node("delay", "delay", **config),
        node("condition", "condition", field="trial.status", operator="eq", value="scheduled"),
        email("after"),
    )
    request = request_for(graph, entity=True)
    assert validate_workflow_graph(request.graph, catalog=CATALOG).valid
    facts = wire_facts()
    facts["condition_facts"]["trial.status"] = "scheduled"
    if mode == "until":
        facts["anchors"]["trial.starts_at"] = instant
    projection = envelope(request, facts=facts)
    if mode == "duration":
        projection["payload"]["reference_time"] = instant
    result = simulate_delay_projection(request, projection, sdk)
    assert result.valid and result.issues == [] and result.future_conditions_rechecked is True
    assert result.reference_time == datetime.fromisoformat(projection["payload"]["reference_time"])
    assert [row.node_id for row in result.trace] == [
        "trigger",
        *(["before"] if earlier_action else []),
        "delay",
    ]
    assert result.trace[-1].model_dump() == {
        "node_id": "delay",
        "outcome": "waiting",
        "edge_id": None,
        "reason": "facts_unavailable",
        "scheduled_at": None,
        "action_kind": None,
        "rendered_subject": None,
        "rendered_body": None,
    }
    assert [action.node_id for action in result.next_actions] == (
        ["before"] if earlier_action else []
    )
    assert all(action.scheduled_at is None for action in result.next_actions)
    assert len({row.node_id for row in result.trace}) == len(result.trace)


MIN_DUE = datetime.min.replace(tzinfo=UTC)
MAX_DUE = datetime.max.replace(tzinfo=UTC)


@pytest.mark.parametrize(
    "mode,anchor,minutes,reference,due",
    [
        ("until", MIN_DUE + timedelta(minutes=1), -1, NOW, MIN_DUE),
        ("until", MAX_DUE - timedelta(minutes=1), 1, NOW, MAX_DUE),
        ("until", MIN_DUE + timedelta(days=90), -129600, NOW, MIN_DUE),
        ("until", MAX_DUE - timedelta(days=90), 129600, NOW, MAX_DUE),
        ("until", MIN_DUE, 0, MIN_DUE, MIN_DUE),
        ("until", MAX_DUE, 0, MAX_DUE, MAX_DUE),
        ("duration", None, 0, MIN_DUE, MIN_DUE),
        ("duration", None, 0, MAX_DUE, MAX_DUE),
        ("duration", None, 129600, MAX_DUE - timedelta(days=90), MAX_DUE),
        ("duration", None, 1, NOW, NOW + timedelta(minutes=1)),
    ],
)
def test_exact_representable_delay_bounds_keep_due_and_path(mode, anchor, minutes, reference, due):
    config = (
        {"mode": mode, "minutes": minutes}
        if mode == "duration"
        else {"mode": mode, "field": "trial.starts_at", "offset_minutes": minutes}
    )
    request = request_for(
        graph_for("trial.scheduled", node("delay", "delay", **config)), entity=True
    )
    assert validate_workflow_graph(request.graph, catalog=CATALOG).valid
    facts = wire_facts(recipients=())
    if anchor is not None:
        facts["anchors"]["trial.starts_at"] = anchor.isoformat()
    projection = envelope(request, facts=facts)
    projection["payload"]["reference_time"] = reference.isoformat()
    result = simulate(request, result=projection)
    row = result.trace[1]
    assert row.scheduled_at == due and row.reason is None
    assert row.outcome == ("waiting" if due > reference else "entered")
    assert row.edge_id == (None if due > reference else "delay_next")
    assert len(result.trace) == (2 if due > reference else 3)
    assert result.valid and not result.issues and not result.next_actions


@pytest.mark.parametrize("field", ["anchor", "reference_time"])
@pytest.mark.parametrize(
    "value",
    [
        "0000-01-01T00:00:00Z",
        "10000-01-01T00:00:00Z",
        "9999-12-31T23:59:59-01:00",
        "not an instant",
    ],
)
def test_invalid_delay_inputs_remain_protocol_503(field, value):
    request = request_for(
        graph_for(
            "trial.scheduled",
            node("delay", "delay", mode="until", field="trial.starts_at", offset_minutes=1),
        ),
        entity=True,
    )
    facts = wire_facts(recipients=())
    facts["anchors"]["trial.starts_at"] = value if field == "anchor" else INSTANT
    projection = envelope(request, facts=facts)
    if field == "reference_time":
        projection["payload"][field] = value
    unavailable(request, projection)


@pytest.mark.parametrize(
    "decision,reason,outcome,continues",
    [
        ("skip", "recipient_missing", "skipped", True),
        ("skip", "recipient_ambiguous", "skipped", True),
        ("skip", "recipient_suppressed", "skipped", True),
        ("skip", "recipient_unusable", "skipped", True),
        ("unavailable", "facts_unavailable", "waiting", False),
    ],
)
def test_recipient_decision_controls_only_its_email(decision, reason, outcome, continues):
    graph = graph_for(
        "lead.created",
        email(),
        node("staff", "lead_follow_up", due_in_days=90, note="Private note"),
    )
    facts = wire_facts()
    facts["recipients"]["lead_or_guardian"].update(decision=decision, reason=reason)
    result = simulate(request_for(graph, entity=True), facts=facts)
    assert result.trace[1].outcome == outcome and result.trace[1].reason == reason
    assert result.trace[1].rendered_body is None and result.trace[1].action_kind is None
    assert len(result.trace) == (4 if continues else 2)
    assert [action.action_kind for action in result.next_actions] == (
        ["lead_follow_up"] if continues else []
    )
    if continues:
        assert result.trace[2].scheduled_at is None
        assert "Private note" not in result.model_dump_json()


def test_missing_recipient_policy_is_unavailable():
    facts = wire_facts(recipients=())
    result = simulate(facts=facts)
    assert result.trace[-1].outcome == "waiting" and result.trace[-1].reason == "facts_unavailable"
    assert not result.next_actions


@pytest.mark.parametrize(
    "name_present,name,outcome,subject",
    [
        (False, None, "waiting", None),
        (True, None, "would_send", "Hello there"),
        (True, "Known", "would_send", "Hello Known"),
    ],
)
def test_ready_recipient_name_preserves_missing_vs_null(name_present, name, outcome, subject):
    facts = wire_facts()
    facts["recipients"]["lead_or_guardian"]["template_facts"] = (
        {"recipient_name": {"kind": "text", "value": name}} if name_present else {}
    )
    result = simulate(facts=facts)
    assert result.trace[1].outcome == outcome and result.trace[1].rendered_subject == subject


def test_unused_missing_names_and_condition_facts_do_not_block():
    facts = wire_facts()
    facts["recipients"]["lead_or_guardian"]["template_facts"] = {}
    graph = graph_for("lead.created", email(subject="Fixed subject"))
    assert simulate(request_for(graph, entity=True), facts=facts).trace[1].outcome == "would_send"


def test_per_policy_name_overlay_and_one_render_per_email(monkeypatch):
    graph = graph_for("lead.created", email("lead"), email("staff", "assigned_staff"))
    facts = wire_facts(recipients=("lead_or_guardian", "assigned_staff"))
    original = deepcopy(facts)
    render = Mock(wraps=boundary.render_workflow_email)
    monkeypatch.setattr(boundary, "render_workflow_email", render)
    result = simulate(request_for(graph, entity=True), facts=facts)
    assert [row.rendered_subject for row in result.trace[1:3]] == [
        "Hello Private lead_or_guardian",
        "Hello Private assigned_staff",
    ]
    assert render.call_count == 2
    assert all(call.kwargs == {"unsubscribe_url": None} for call in render.call_args_list)
    assert facts == original and "recipient_name" not in facts["template_facts"]
    assert "Private" not in repr(result) and "Private" not in repr(result.trace[1])


@pytest.mark.parametrize(
    "text,reason",
    [
        ("x" * 5001, "invalid_email_context"),
        ("Secret\tname", "invalid_email_context"),
        ("Secret\nname", "invalid_email_context"),
        ("Secret\x85name", "invalid_email_context"),
    ],
)
def test_invalid_known_text_skips_and_never_leaks_or_truncates(text, reason):
    facts = wire_facts()
    facts["recipients"]["lead_or_guardian"]["template_facts"]["recipient_name"]["value"] = text
    result = simulate(facts=facts)
    assert result.trace[1].outcome == "skipped" and result.trace[1].reason == reason
    assert result.trace[1].rendered_subject is None and not result.next_actions
    assert result.trace[-1].outcome == "completed"


@pytest.mark.parametrize(
    "wire,expected",
    [
        (
            {
                "kind": "money",
                "amount_minor_units": 1234,
                "currency": "usd",
                "unit_convention": "stripe_minor_units",
            },
            "USD 12.34",
        ),
        (
            {
                "kind": "money",
                "amount_minor_units": -12,
                "currency": "JPY",
                "unit_convention": "stripe_minor_units",
            },
            "JPY -12",
        ),
        (
            {
                "kind": "money",
                "amount_minor_units": 1234,
                "currency": "KWD",
                "unit_convention": "stripe_minor_units",
            },
            "KWD 1.234",
        ),
    ],
)
def test_money_adapter_uses_exact_wrapper_and_formatter(wire, expected):
    facts = wire_facts(recipients=("invoice_payer",))
    facts["template_facts"]["invoice_balance"] = wire
    graph = graph_for(
        "invoice.overdue", email(recipient="invoice_payer", body="{{invoice_balance}}")
    )
    result = simulate(request_for(graph, entity=True), facts=facts)
    assert result.trace[1].rendered_body == expected


@pytest.mark.parametrize(
    "present,currency,reason,outcome",
    [
        (False, "USD", "facts_unavailable", "waiting"),
        (True, "ZZZ", "unsupported_currency", "skipped"),
    ],
)
def test_money_missing_and_known_unsupported_have_distinct_outcomes(
    present, currency, reason, outcome
):
    facts = wire_facts(recipients=("invoice_payer",))
    if present:
        facts["template_facts"]["invoice_balance"] = {
            "kind": "money",
            "amount_minor_units": 1234,
            "currency": currency,
            "unit_convention": "stripe_minor_units",
        }
    graph = graph_for(
        "invoice.overdue", email(recipient="invoice_payer", body="{{invoice_balance}}")
    )
    result = simulate(request_for(graph, entity=True), facts=facts)
    assert result.trace[1].reason == reason and result.trace[1].outcome == outcome


def test_event_time_and_date_decode_without_scalar_coercion():
    facts = wire_facts()
    facts["template_facts"]["trial_start"] = {
        "kind": "event_time",
        "instant": INSTANT,
        "timezone": "America/Los_Angeles",
    }
    graph = graph_for("trial.scheduled", email(body="{{trial_start}}"))
    assert (
        simulate(request_for(graph, entity=True), facts=facts).trace[1].rendered_body
        == "2026-10-05 05:30:10.123456-07:00 [America/Los_Angeles]"
    )
    for value, expected in [("2026-10-05", "2026-10-05"), (None, "No due date listed")]:
        facts = wire_facts(recipients=("invoice_payer",))
        facts["template_facts"]["invoice_due_date"] = {"kind": "date", "value": value}
        graph = graph_for(
            "invoice.overdue", email(recipient="invoice_payer", body="{{invoice_due_date}}")
        )
        assert (
            simulate(request_for(graph, entity=True), facts=facts).trace[1].rendered_body
            == expected
        )


@pytest.mark.parametrize("count", [1, 38])
def test_maximum_path_has_one_row_per_node_and_actions_only_for_visited_nodes(count):
    graph = graph_for("lead.created", *(email("mail" + str(i)) for i in range(count)))
    result = simulate(request_for(graph))
    assert len(result.trace) == count + 2 and len(result.next_actions) == count
    assert len({row.node_id for row in result.trace}) == count + 2


def test_earlier_hypothetical_action_survives_a_later_unavailable_condition():
    graph = graph_for(
        "lead.created",
        email(),
        node("condition", "condition", field="lead.unconverted", operator="eq", value=True),
        node("staff", "lead_follow_up", due_in_days=0, note=""),
    )
    result = simulate(request_for(graph, entity=True), facts=wire_facts())
    assert [row.outcome for row in result.trace] == ["entered", "would_send", "waiting"]
    assert [action.node_id for action in result.next_actions] == ["mail"]


def test_complete_python_issues_precede_unique_sql_issues():
    graph = graph_for()
    graph["edges"] = []
    request = request_for(graph)
    python = validate_workflow_graph(request.graph, catalog=CATALOG)
    result = simulate(
        request,
        result=envelope(request, valid=False, issues=[python.issues[0].model_dump(), ISSUE, ISSUE]),
    )
    assert result.issues == [*python.issues, boundary.WorkflowValidationIssue.model_validate(ISSUE)]
    assert not result.valid and not result.trace and not result.next_actions


def test_python_invalid_graph_never_walks_even_if_sql_claims_valid():
    graph = graph_for()
    graph["edges"] = []
    result = simulate(request_for(graph))
    assert not result.valid and result.issues and not result.trace


def test_sql_reference_failure_prevents_walk_for_valid_dirty_graph():
    request = request_for()
    result = simulate(request, result=envelope(request, valid=False, issues=[ISSUE]))
    assert not result.valid and not result.trace and not result.next_actions


@pytest.mark.parametrize("event", CATALOG["triggers"])
def test_all_entity_kinds_are_catalog_bound(event):
    request = request_for(graph_for(event), entity=True)
    facts = wire_facts(recipients=())
    assert simulate(request, facts=facts).valid
    request.context.entity_type = "student" if request.context.entity_type != "student" else "lead"
    result = simulate(request, result=envelope(request, valid=False, issues=[ISSUE]))
    assert not result.valid and result.issues[0].code == "context_mismatch"
    assert result.issues[0].field == "context.entity_type"
    assert not result.trace
    unavailable(request, envelope(request, facts=facts))


@pytest.mark.parametrize(
    "field,value",
    [
        ("studio_id", OTHER),
        ("workflow_id", OTHER),
        ("context", {"kind": "entity", "entity_type": "lead", "entity_id": OTHER}),
        ("context", {"kind": "synthetic", "entity_id": ENTITY}),
        ("reference_time", "infinity"),
        ("reference_time", "2026-10-05T12:30:00"),
        ("reference_time", 123),
        ("valid", "true"),
        ("valid", 1),
        ("event_type", "student.enrolled"),
        ("event_type", None),
        ("event_type", "private event"),
        ("issues", [ISSUE]),
        ("facts", None),
    ],
)
def test_wrong_payload_types_scope_and_entity_null_are_protocol_errors(field, value):
    request = request_for(entity=True)
    result = envelope(request, facts=wire_facts())
    result["payload"][field] = value
    unavailable(request, result)


@pytest.mark.parametrize(
    "field",
    [
        "studio_id",
        "workflow_id",
        "context",
        "reference_time",
        "valid",
        "issues",
        "event_type",
        "facts",
    ],
)
def test_every_payload_field_is_required(field):
    result = envelope()
    del result["payload"][field]
    unavailable(request_for(), result)


@pytest.mark.parametrize(
    "result",
    [
        None,
        [],
        "private",
        {},
        {"payload": None},
        {"payload": {}},
        {"payload": envelope()["payload"], "message": "private"},
    ],
)
def test_closed_envelope_rejects_malformed_results(result):
    unavailable(request_for(), result)


@pytest.mark.parametrize("field", ISSUE)
def test_sql_issues_never_fill_omitted_fields_with_null(field):
    issue = {key: value for key, value in ISSUE.items() if key != field}
    unavailable(request_for(), envelope(valid=False, issues=[issue]))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda f: f.update(private="secret"),
        lambda f: f.pop("anchors"),
        lambda f: f.update(source_decision="unknown"),
        lambda f: f.update(source_reason="raw private diagnostic"),
        lambda f: f.update(source_reason="facts_unavailable"),
        lambda f: f.update(source_decision="ineligible"),
        lambda f: f["condition_facts"].update(unknown=True),
        lambda f: f["condition_facts"].update({"student.status": "active"}),
        lambda f: f["condition_facts"].update({"lead.unconverted": 1}),
        lambda f: f["condition_facts"].update({"program.id": {"private": "fact"}}),
        lambda f: f["template_facts"].update(recipient_name={"kind": "text", "value": "private"}),
        lambda f: f["template_facts"].update(unknown={"kind": "text", "value": "private"}),
        lambda f: f["template_facts"].update(studio_name="private"),
        lambda f: f["template_facts"].update(studio_name={"kind": "text", "value": 4}),
        lambda f: f["template_facts"].update(studio_name={"kind": "text", "value": "\ud800"}),
        lambda f: f["template_facts"].update(studio_name={"kind": "text", "value": "x" * 5002}),
        lambda f: f["template_facts"].update(
            studio_name={"kind": "text", "value": None, "private": True}
        ),
        lambda f: f["template_facts"].update(studio_name={"kind": "date", "value": None}),
        lambda f: f["anchors"].update({"trial.starts_at": INSTANT}),
        lambda f: f["recipients"].update(
            assigned_staff={"decision": "ready", "reason": None, "template_facts": {}}
        ),
        lambda f: f["recipients"]["lead_or_guardian"].update(address="private@example.com"),
        lambda f: f["recipients"]["lead_or_guardian"].update(
            decision="ready", reason="recipient_missing"
        ),
        lambda f: f["recipients"]["lead_or_guardian"].update(decision="skip", reason=None),
        lambda f: f["recipients"]["lead_or_guardian"]["template_facts"].update(
            studio_name={"kind": "text", "value": "private"}
        ),
    ],
)
def test_closed_fact_protocol_rejects_wrong_keys_types_and_decisions(mutate):
    request = request_for(entity=True)
    facts = wire_facts()
    mutate(facts)
    unavailable(request, envelope(request, facts=facts))


@pytest.mark.parametrize(
    "name,value",
    [
        (
            "invoice_balance",
            {
                "kind": "money",
                "amount_minor_units": True,
                "currency": "USD",
                "unit_convention": "stripe_minor_units",
            },
        ),
        (
            "invoice_balance",
            {
                "kind": "money",
                "amount_minor_units": 1.0,
                "currency": "USD",
                "unit_convention": "stripe_minor_units",
            },
        ),
        (
            "invoice_balance",
            {
                "kind": "money",
                "amount_minor_units": 2**63,
                "currency": "USD",
                "unit_convention": "stripe_minor_units",
            },
        ),
        (
            "invoice_balance",
            {
                "kind": "money",
                "amount_minor_units": 1,
                "currency": None,
                "unit_convention": "stripe_minor_units",
            },
        ),
        (
            "invoice_balance",
            {
                "kind": "money",
                "amount_minor_units": 1,
                "currency": "US",
                "unit_convention": "stripe_minor_units",
            },
        ),
        (
            "invoice_balance",
            {
                "kind": "money",
                "amount_minor_units": 1,
                "currency": "USD",
                "unit_convention": "guessed",
            },
        ),
        *[
            ("invoice_due_date", {"kind": "date", "value": value})
            for value in (
                1,
                False,
                "2026-1-1",
                "2026-02-30",
                "2026-01-01T00:00:00Z",
                date(2026, 1, 1),
            )
        ],
        *[
            ("trial_start", {"kind": "event_time", "instant": value, "timezone": "UTC"})
            for value in (1, None, "2026-01-01", "infinity")
        ],
        ("trial_start", {"kind": "event_time", "instant": INSTANT, "timezone": "unknown"}),
        ("trial_start", {"kind": "event_time", "instant": INSTANT, "timezone": None}),
        (
            "trial_start",
            {"kind": "event_time", "instant": INSTANT, "timezone": "UTC", "extra": "private"},
        ),
    ],
)
def test_tagged_fact_adapter_rejects_coercion_and_bad_units_dates_zones(name, value):
    trial = name == "trial_start"
    event = "trial.scheduled" if trial else "invoice.overdue"
    policy = "lead_or_guardian" if trial else "invoice_payer"
    graph = graph_for(event, email(recipient=policy, body="{{" + name + "}}"))
    request = request_for(graph, entity=True)
    facts = wire_facts(recipients=(policy,))
    facts["template_facts"][name] = value
    unavailable(request, envelope(request, facts=facts))


def test_synthetic_facts_are_only_allowed_as_explicit_null():
    unavailable(request_for(), envelope(facts=wire_facts()))


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError("private secret"),
        TimeoutError("private secret"),
        APIError({"code": "XX000", "message": "private secret"}),
        APIError({"code": ["private"], "message": {"secret": True}}),
    ],
)
def test_rpc_faults_are_safe_and_never_retried(failure):
    unavailable(request_for(), failure)


@pytest.mark.parametrize(
    "code,message,status",
    [
        ("42501", "AUTOMATION_ADMIN_REQUIRED", 403),
        ("P0002", "AUTOMATION_NOT_FOUND", 404),
        ("22023", "AUTOMATION_INVALID_REQUEST", 422),
        ("P0001", "AUTOMATION_STUDIO_BUSY", 409),
    ],
)
def test_known_rpc_errors_keep_fixed_scoped_mapping(code, message, status):
    client = ReadClient(APIError({"code": code, "message": message, "details": "private"}))
    with pytest.raises(HTTPException) as error:
        WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request_for())
    assert error.value.status_code == status and "private" not in str(error.value.detail)
    assert len(client.calls) == 1 and error.value.__cause__ is None


@pytest.mark.parametrize(
    "changes",
    [
        {"layout": {}},
        {"operation_id": OTHER},
        {"reference_time": INSTANT},
        {"facts": {}},
        {"send": True},
    ],
)
def test_request_has_no_overrides_or_write_fields(changes):
    body = request_for().model_dump(mode="json")
    body.update(changes)
    with pytest.raises(ValidationError):
        WorkflowSimulationRequest.model_validate(body)


def test_whole_request_guard_runs_before_nested_models():
    body = {"graph": huge_safe_draft(), "context": {"kind": "invalid"}}
    with pytest.raises(HTTPException) as error:
        WorkflowSimulationRequest.model_validate(body)
    assert error.value.status_code == 422 and error.value.detail == "Workflow request is too large."


NUL_LOCATIONS = (
    "subject",
    "body",
    "note",
    "condition",
    "condition_list",
    "trigger",
    "node_id",
    "context",
    "request_key",
    "graph_key",
    "context_key",
)


def request_with_nul(location):
    graph = graph_for(
        "lead.created",
        email(),
        node("condition", "condition", field="lead.stage", operator="eq", value="inquiry"),
        node("staff", "lead_follow_up", due_in_days=0, note="Note"),
    )
    body = request_for(graph).model_dump(mode="json")
    text = "A\x00B"
    if location in {"subject", "body"}:
        graph = body["graph"]
        graph["nodes"][1]["config"][location + "_template"] = text
    elif location == "note":
        body["graph"]["nodes"][3]["config"]["note"] = text
    elif location.startswith("condition"):
        config = body["graph"]["nodes"][2]["config"]
        config["value"] = [text] if location == "condition_list" else text
        config["operator"] = "in" if location == "condition_list" else "eq"
    elif location == "trigger":
        body["graph"]["nodes"][0]["config"]["event_type"] = text
    elif location == "node_id":
        body["graph"]["nodes"][1]["id"] = text
    elif location == "context":
        body["context"]["kind"] = text
    else:
        target = {"request_key": body, "graph_key": body["graph"], "context_key": body["context"]}[
            location
        ]
        target[text] = None
    return body


@pytest.mark.parametrize("location", NUL_LOCATIONS)
def test_simulation_request_rejects_nul_without_rewriting_input(location):
    body = request_with_nul(location)
    original = deepcopy(body)
    with pytest.raises(HTTPException) as error:
        WorkflowSimulationRequest.model_validate(body)
    assert error.value.status_code == 422
    assert error.value.detail == "Invalid workflow request."
    assert body == original


def test_direct_service_rejects_nul_before_validation_or_rpc(monkeypatch):
    request = request_for()
    request.graph.nodes[1].config.body_template = "A\x00B"
    validate = Mock(side_effect=AssertionError("NUL must not reach semantic validation"))
    monkeypatch.setattr(boundary, "validate_workflow_graph", validate)
    client = ReadClient(envelope(request))
    with pytest.raises(HTTPException) as error:
        WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request)
    assert error.value.status_code == 422 and error.value.detail == "Invalid workflow request."
    assert client.calls == []
    validate.assert_not_called()
    assert request.graph.nodes[1].config.body_template == "A\x00B"


def test_size_guard_precedes_nul_rejection():
    body = {"graph": huge_safe_draft(), "context": {"kind": "synthetic"}, "A\x00B": None}
    with pytest.raises(HTTPException) as error:
        guard_workflow_request(body)
    assert error.value.status_code == 422 and error.value.detail == "Workflow request is too large."


def test_simulation_inherits_shared_utf8_and_nul_guard(monkeypatch):
    from app.schemas import workflow_management as management_schema

    guard = Mock(wraps=management_schema.guard_workflow_request)
    monkeypatch.setattr(management_schema, "guard_workflow_request", guard)
    body = {"graph": "\ud800", "context": {"kind": "A\x00B"}}
    with pytest.raises(HTTPException) as error:
        WorkflowSimulationRequest.model_validate(body)
    assert error.value.status_code == 422 and error.value.detail == "Invalid workflow request."
    guard.assert_called_once_with(body)


@pytest.mark.parametrize("value", [1, 0, "true", "false", False, None])
def test_response_requires_actual_literal_true(value):
    response = simulate().model_dump(mode="json")
    response["future_conditions_rechecked"] = value
    with pytest.raises(ValidationError):
        WorkflowSimulationResponse.model_validate(response)


@pytest.mark.parametrize(
    "field",
    ["valid", "issues", "trace", "next_actions", "reference_time", "future_conditions_rechecked"],
)
def test_response_requires_every_field(field):
    response = simulate().model_dump(mode="json")
    response.pop(field)
    with pytest.raises(ValidationError):
        WorkflowSimulationResponse.model_validate(response)


@pytest.mark.parametrize(
    "field",
    [
        "node_id",
        "outcome",
        "edge_id",
        "reason",
        "scheduled_at",
        "action_kind",
        "rendered_subject",
        "rendered_body",
    ],
)
def test_trace_requires_even_nullable_fields(field):
    row = simulate().trace[0].model_dump(mode="json")
    row.pop(field)
    with pytest.raises(ValidationError):
        WorkflowSimulationTrace.model_validate(row)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["trace"].append(r["trace"][0]),
        lambda r: r["next_actions"].clear(),
        lambda r: r["next_actions"][0].update(scheduled_at=INSTANT),
        lambda r: r["trace"][1].update(action_kind="lead_follow_up"),
        lambda r: r["trace"][1].update(rendered_subject="x" * 201),
        lambda r: r["trace"][1].update(rendered_body="x" * 20001),
        lambda r: r["trace"][1].update(reason="raw private diagnostics"),
        lambda r: r["trace"][0].update(node_id="bad/id"),
        lambda r: r.update(trace=r["trace"] * 14),
        lambda r: r.update(next_actions=r["next_actions"] * 41),
        lambda r: r.update(valid="true"),
        lambda r: r.update(private="secret"),
    ],
)
def test_public_response_rejects_inconsistent_or_unbounded_rows(mutate):
    response = simulate().model_dump(mode="json")
    mutate(response)
    with pytest.raises(ValidationError):
        WorkflowSimulationResponse.model_validate(response)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r["trace"][0].update(edge_id="missing"),
        lambda r: r["trace"][0].update(edge_id="mail_next"),
        lambda r: r["trace"][0].update(node_id="mail"),
        lambda r: r["trace"][1].update(scheduled_at=INSTANT),
        lambda r: r["trace"].pop(),
    ],
)
def test_path_consistency_checks_the_submitted_graph(mutate):
    request = request_for()
    response = simulate(request).model_dump(mode="json")
    mutate(response)
    with pytest.raises(ValueError):
        WorkflowSimulationResponse.model_validate(response).validate_graph_path(request.graph)


@pytest.mark.parametrize("kind", ["synthetic", "entity"])
def test_pinned_sdk_decodes_the_exact_closed_envelope(kind):
    assert version("postgrest") == "0.17.2"
    request = request_for(entity=kind == "entity")
    calls = []

    def handler(http_request):
        calls.append(http_request)
        return httpx.Response(
            200, json=envelope(request, facts=wire_facts() if kind == "entity" else None)
        )

    with SyntheticPostgrestClient(handler) as client:
        result = WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request)
    assert result.valid and len(calls) == 1
    assert calls[0].url.path == "/rest/v1/rpc/" + SIMULATION_RPC
    assert json.loads(calls[0].content)["p_graph"] == request.graph.model_dump(mode="json")


@pytest.mark.parametrize(
    "status,body",
    [
        (200, {"payload": {"private": "secret"}}),
        (500, {"code": "XX000", "message": "private secret", "details": "private"}),
        (404, {"code": "PGRST202", "message": "RPC missing", "details": "private"}),
    ],
)
def test_pinned_sdk_protocol_and_provider_failures_are_safe(status, body):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json=body)

    with SyntheticPostgrestClient(handler) as client, pytest.raises(HTTPException) as error:
        WorkflowSimulationService(client).simulate(STUDIO, ACTOR, UUID(WORKFLOW), request_for())
    assert error.value.status_code == 503 and error.value.detail == UNAVAILABLE_DETAIL
    assert len(calls) == 1
