"""Read one current-fact projection and preview one hypothetical graph path.

SQL owns source and recipient authority. This preview grants no enrollment or
delivery permission and stops before any future condition would be evaluated.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import Field, StrictBool, StrictStr, model_validator

from app.schemas.trial_appointment import IANATimezone, UTCInstant
from app.schemas.workflow import WorkflowGraph, WorkflowValidationIssue
from app.schemas.workflow_management import WorkflowManagementModel, guard_workflow_request
from app.schemas.workflow_run import ReasonCode, TriggerEvent
from app.schemas.workflow_simulation import (
    SimulationContext,
    SimulationIssues,
    WorkflowSimulationAction,
    WorkflowSimulationEntityContext,
    WorkflowSimulationRequest,
    WorkflowSimulationResponse,
    WorkflowSimulationTrace,
)
from app.services.workflow_catalog import CATALOG
from app.services.workflow_email import (
    WorkflowEmailRenderError,
    WorkflowEventTimeValue,
    WorkflowMoneyValue,
    render_workflow_email,
)
from app.services.workflow_graph import validate_workflow_graph
from app.services.workflow_management_service import ADMIN_REQUIRED_DETAIL, UNAVAILABLE_DETAIL
from app.services.workflow_policies import MISSING, condition_fact_available, condition_matches

SIMULATION_RPC = "get_automation_workflow_simulation_facts_v1"
NOT_FOUND_DETAIL = "Workflow or simulation entity not found."
_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND"): (404, NOT_FOUND_DETAIL),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid workflow request."),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (409, "The studio is busy. Try again shortly."),
}
_SAMPLE_PROGRAM = UUID("00000000-0000-4000-8000-000000000001")
_SAMPLE_RANK = UUID("00000000-0000-4000-8000-000000000002")
_TEMPLATE_KINDS = {
    "invoice_balance": "money",
    "invoice_due_date": "date",
    "trial_start": "event_time",
    "event_start": "event_time",
}
TemplateValue = str | None | date | WorkflowMoneyValue | WorkflowEventTimeValue


@dataclass(frozen=True)
class WorkflowSimulationRecipient:
    decision: Literal["ready", "skip", "unavailable"]
    reason: str | None
    template_facts: dict[str, str | None] = field(repr=False)


@dataclass(frozen=True)
class WorkflowSimulationFacts:
    source_decision: Literal["eligible", "ineligible", "unavailable"]
    source_reason: str | None
    condition_facts: dict[str, bool | str | None] = field(repr=False)
    template_facts: dict[str, TemplateValue] = field(repr=False)
    anchors: dict[str, datetime] = field(repr=False)
    recipients: dict[str, WorkflowSimulationRecipient] = field(repr=False)


class _Text(WorkflowManagementModel):
    kind: Literal["text"]
    value: Annotated[str, Field(strict=True, max_length=5001)] | None = Field(repr=False)


class _Money(WorkflowManagementModel):
    kind: Literal["money"]
    amount_minor_units: Annotated[int, Field(strict=True, ge=-(2**63), lt=2**63)]
    currency: Annotated[str, Field(strict=True, pattern=r"^[A-Za-z]{3}$")]
    unit_convention: Literal["stripe_minor_units", "usd_cents"]


class _EventTime(WorkflowManagementModel):
    kind: Literal["event_time"]
    instant: UTCInstant
    timezone: IANATimezone


class _Date(WorkflowManagementModel):
    kind: Literal["date"]
    value: StrictStr | None

    @model_validator(mode="after")
    def canonical_date(self) -> _Date:
        if self.value is not None:
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", self.value):
                raise ValueError("Invalid simulation date.")
            date.fromisoformat(self.value)
        return self


_WireValue = Annotated[_Text | _Money | _EventTime | _Date, Field(discriminator="kind")]


class _Recipient(WorkflowManagementModel):
    decision: Literal["ready", "skip", "unavailable"]
    reason: ReasonCode | None
    template_facts: Annotated[dict[StrictStr, _Text], Field(strict=True, repr=False)]

    @model_validator(mode="after")
    def consistent_recipient(self) -> _Recipient:
        if (self.decision == "ready") != (self.reason is None) or set(self.template_facts) - {
            "recipient_name"
        }:
            raise ValueError("Invalid simulation recipient.")
        return self


class _Facts(WorkflowManagementModel):
    source_decision: Literal["eligible", "ineligible", "unavailable"]
    source_reason: ReasonCode | None
    condition_facts: Annotated[
        dict[StrictStr, StrictBool | StrictStr | None], Field(strict=True, repr=False)
    ]
    template_facts: Annotated[dict[StrictStr, _WireValue], Field(strict=True, repr=False)]
    anchors: Annotated[dict[StrictStr, UTCInstant], Field(strict=True, repr=False)]
    recipients: Annotated[dict[StrictStr, _Recipient], Field(strict=True, repr=False)]

    @model_validator(mode="after")
    def consistent_source(self) -> _Facts:
        if (self.source_decision == "eligible") != (self.source_reason is None):
            raise ValueError("Invalid simulation source decision.")
        return self


class _Payload(WorkflowManagementModel):
    studio_id: UUID
    workflow_id: UUID
    context: SimulationContext
    reference_time: UTCInstant
    valid: StrictBool
    issues: SimulationIssues
    event_type: TriggerEvent | None
    facts: _Facts | None = Field(repr=False)

    @model_validator(mode="after")
    def consistent_validation(self) -> _Payload:
        if self.valid != (not self.issues):
            raise ValueError("Invalid simulation validation result.")
        if not self.valid and self.facts is not None:
            raise ValueError("Unexpected simulation facts.")
        if self.valid:
            entity = isinstance(self.context, WorkflowSimulationEntityContext)
            if self.event_type is None or entity != (self.facts is not None):
                raise ValueError("Missing or unexpected simulation facts.")
        return self


class _Envelope(WorkflowManagementModel):
    payload: _Payload


def _decode_facts(
    wire: _Facts, event_type: str, recipient_ids: frozenset[str]
) -> WorkflowSimulationFacts:
    trigger = CATALOG["triggers"][event_type]
    if (
        set(wire.condition_facts) - set(trigger["field_ids"])
        or set(wire.template_facts) - (set(trigger["template_variables"]) - {"recipient_name"})
        or set(wire.anchors) - set(trigger["delay_fields"])
        or set(wire.recipients) - recipient_ids
        or set(wire.recipients) - set(trigger["recipient_ids"])
    ):
        raise ValueError("Inapplicable simulation facts.")
    values = {}
    for name, value in wire.template_facts.items():
        if value.kind != _TEMPLATE_KINDS.get(name, "text"):
            raise ValueError("Invalid simulation template kind.")
        if isinstance(value, _Money):
            values[name] = WorkflowMoneyValue(
                value.amount_minor_units, value.currency, value.unit_convention
            )
        elif isinstance(value, _EventTime):
            values[name] = WorkflowEventTimeValue(value.instant, value.timezone)
        elif isinstance(value, _Date):
            values[name] = date.fromisoformat(value.value) if value.value is not None else None
        else:
            values[name] = value.value
    return WorkflowSimulationFacts(
        source_decision=wire.source_decision,
        source_reason=wire.source_reason,
        condition_facts=dict(wire.condition_facts),
        template_facts=values,
        anchors=dict(wire.anchors),
        recipients={
            policy: WorkflowSimulationRecipient(
                entry.decision,
                entry.reason,
                {key: value.value for key, value in entry.template_facts.items()},
            )
            for policy, entry in wire.recipients.items()
        },
    )


def build_synthetic_workflow_facts(
    event_type: str,
    reference_time: datetime,
    *,
    program_id: UUID | None,
    offset_minutes: int | None,
    recipient_ids: frozenset[str],
) -> WorkflowSimulationFacts:
    """Create fresh fictional facts; no customer read or effect authority."""
    if type(event_type) is not str or event_type not in CATALOG["triggers"]:
        raise ValueError("Invalid synthetic trigger.")
    trigger = CATALOG["triggers"][event_type]
    if (
        type(reference_time) is not datetime
        or reference_time.tzinfo is None
        or reference_time.utcoffset() != timedelta(0)
        or (program_id is not None and type(program_id) is not UUID)
        or (program_id is not None and not trigger["supports_program_filter"])
        or type(recipient_ids) is not frozenset
        or any(
            type(policy) is not str or policy not in trigger["recipient_ids"]
            for policy in recipient_ids
        )
    ):
        raise ValueError("Invalid synthetic context.")
    if trigger["supports_offset"]:
        if type(offset_minutes) is not int or not -129600 <= offset_minutes <= -1:
            raise ValueError("Invalid synthetic offset.")
    elif offset_minutes is not None:
        raise ValueError("Unexpected synthetic offset.")
    start = None
    if trigger["supports_offset"]:
        start = reference_time - timedelta(minutes=offset_minutes)
    elif event_type == "trial.scheduled":
        start = reference_time + timedelta(days=2)
    elif event_type in {"trial.completed", "trial.no_show"}:
        start = reference_time - timedelta(hours=2)
    elif event_type == "belt_test.approved":
        start = reference_time + timedelta(days=7)
    trial_status = {"trial.completed": "completed", "trial.no_show": "no_show"}.get(
        event_type, "scheduled"
    )
    conditions = {
        "student.status": "active",
        "student.on_hold": False,
        "student.is_minor": False,
        "lead.source": "website",
        "lead.unconverted": True,
        "lead.stage": "trial_completed"
        if event_type == "trial.completed"
        else "trial_scheduled"
        if event_type.startswith("trial.")
        else "inquiry",
        "trial.status": trial_status,
        "invoice.open_balance": True,
        "invoice.overdue": event_type == "invoice.overdue",
        "invoice.collection_method": "send_invoice"
        if event_type == "invoice.overdue"
        else "charge_automatically",
        "program.id": str(program_id or _SAMPLE_PROGRAM),
        "promotion.rank_id": str(_SAMPLE_RANK),
        "belt_test.event_scheduled": True,
        "belt_test.approval_current": True,
    }
    templates = {
        "studio_name": "Sample studio",
        "student_first_name": "Sample student",
        "lead_first_name": "Sample lead",
        "rank_name": "Sample blue belt",
        "program_name": "Sample program",
        "trial_location": "Sample trial room",
        "invoice_number": "SAMPLE-001",
        "invoice_balance": WorkflowMoneyValue(1234, "usd", "stripe_minor_units"),
        "invoice_due_date": reference_time.date()
        + timedelta(days=-7 if event_type == "invoice.overdue" else 7),
        "event_name": "Sample belt test",
        "event_location": "Sample event room",
    }
    if start is not None:
        templates["trial_start"] = templates["event_start"] = WorkflowEventTimeValue(start, "UTC")
    names = {
        "student_or_guardian": "Sample student",
        "lead_or_guardian": "Sample lead",
        "assigned_staff": "Sample staff",
        "invoice_payer": "Sample payer",
    }
    return WorkflowSimulationFacts(
        source_decision="eligible",
        source_reason=None,
        condition_facts={key: conditions[key] for key in trigger["field_ids"]},
        template_facts={
            key: templates[key] for key in trigger["template_variables"] if key != "recipient_name"
        },
        anchors={key: start for key in trigger["delay_fields"]},
        recipients={
            policy: WorkflowSimulationRecipient("ready", None, {"recipient_name": names[policy]})
            for policy in sorted(recipient_ids)
        },
    )


def _walk(
    graph: WorkflowGraph, event_type: str, facts: WorkflowSimulationFacts, reference_time: datetime
) -> list[WorkflowSimulationTrace]:
    nodes = {node.id: node for node in graph.nodes}
    edges = {(edge.source, edge.port): edge for edge in graph.edges}
    node = next(node for node in graph.nodes if node.type == "trigger")
    trace = []
    while len(trace) < 40:
        row = {
            "node_id": node.id,
            "outcome": "entered",
            "edge_id": None,
            "reason": None,
            "scheduled_at": None,
            "action_kind": None,
            "rendered_subject": None,
            "rendered_body": None,
        }
        port = "next"
        stop = False
        if node.type == "trigger":
            if facts.source_decision != "eligible":
                row.update(
                    outcome="waiting" if facts.source_decision == "unavailable" else "skipped",
                    reason=facts.source_reason,
                )
                stop = True
        elif node.type == "condition":
            actual = facts.condition_facts.get(node.config.field, MISSING)
            if not condition_fact_available(node.config.field, actual):
                row.update(outcome="waiting", reason="facts_unavailable")
                stop = True
            else:
                matched = condition_matches(
                    node.config.field, node.config.operator, node.config.value, actual
                )
                row["outcome"] = "matched" if matched else "not_matched"
                port = "yes" if matched else "no"
        elif node.type == "delay":
            if node.config.mode == "duration":
                anchor, minutes = reference_time, node.config.minutes
            else:
                anchor = facts.anchors.get(node.config.field)
                minutes = node.config.offset_minutes
            try:
                due = anchor + timedelta(minutes=minutes) if anchor is not None else None
            except OverflowError:
                due = None
            row["scheduled_at"] = due
            if due is None or due > reference_time:
                row.update(outcome="waiting", reason="facts_unavailable" if due is None else None)
                stop = True
        elif node.type == "email":
            recipient = facts.recipients.get(node.config.recipient)
            if recipient is None or recipient.decision == "unavailable":
                row.update(
                    outcome="waiting", reason=recipient.reason if recipient else "facts_unavailable"
                )
                stop = True
            elif recipient.decision == "skip":
                row.update(outcome="skipped", reason=recipient.reason)
            else:
                try:
                    content = render_workflow_email(
                        event_type,
                        node.config.subject_template,
                        node.config.body_template,
                        {**facts.template_facts, **recipient.template_facts},
                        unsubscribe_url=None,
                    )
                    row.update(
                        outcome="would_send",
                        action_kind="email",
                        rendered_subject=content.subject,
                        rendered_body=content.text_body,
                    )
                except WorkflowEmailRenderError as exc:
                    stop = exc.reason == "facts_unavailable"
                    row.update(outcome="waiting" if stop else "skipped", reason=exc.reason)
        elif node.type == "lead_follow_up":
            row.update(outcome="would_follow_up", action_kind="lead_follow_up")
        else:
            row["outcome"] = "completed"
            stop = True
        edge = None if stop else edges[(node.id, port)]
        row["edge_id"] = edge.id if edge is not None else None
        trace.append(WorkflowSimulationTrace.model_validate(row))
        if stop:
            return trace
        node = nodes[edge.target]
    raise ValueError("Simulation path exceeded its bound.")


class WorkflowSimulationService:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def _read(self, params: dict) -> object:
        try:
            return self.supabase.rpc(SIMULATION_RPC, params).execute().data
        except APIError as exc:
            code, message = getattr(exc, "code", None), getattr(exc, "message", None)
            error = (503, UNAVAILABLE_DETAIL)
            if isinstance(code, str) and isinstance(message, str):
                error = _ERRORS.get((code, message), error)
            raise HTTPException(*error) from None
        except Exception:  # noqa: BLE001 - Transport details stay private and no read is retried.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def simulate(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        workflow_id: UUID,
        data: WorkflowSimulationRequest,
    ) -> WorkflowSimulationResponse:
        guard_workflow_request(data)
        graph = data.graph
        python_result = validate_workflow_graph(graph, catalog=CATALOG)
        triggers = [node for node in graph.nodes if node.type == "trigger"]
        trigger = triggers[0] if len(triggers) == 1 else None
        event_type = (
            trigger.config.event_type
            if trigger and trigger.config.event_type in CATALOG["triggers"]
            else None
        )
        context_issues = []
        if (
            isinstance(data.context, WorkflowSimulationEntityContext)
            and event_type
            and data.context.entity_type
            != CATALOG["triggers"][event_type]["simulation_entity_type"]
        ):
            context_issues.append(
                WorkflowValidationIssue(
                    code="context_mismatch",
                    message="Select the entity type for this trigger.",
                    node_id=trigger.id,
                    edge_id=None,
                    field="context.entity_type",
                )
            )
        result = self._read(
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_workflow_id": str(workflow_id),
                "p_graph": graph.model_dump(mode="json"),
                "p_context": data.context.model_dump(mode="json"),
            }
        )
        try:
            payload = _Envelope.model_validate(result).payload
            if (
                payload.studio_id != UUID(str(studio_id))
                or payload.workflow_id != workflow_id
                or payload.context != data.context
                or payload.event_type != event_type
            ):
                raise ValueError("Invalid simulation scope or trigger.")
            if payload.valid and context_issues:
                raise ValueError("Invalid simulation context applicability.")
            issues = {}
            for issue in [*python_result.issues, *context_issues, *payload.issues]:
                key = (issue.code, issue.message, issue.node_id, issue.edge_id, issue.field)
                issues.setdefault(key, issue)
            trace = []
            if python_result.valid and payload.valid and not context_issues:
                recipient_ids = frozenset(
                    node.config.recipient for node in graph.nodes if node.type == "email"
                )
                facts = (
                    _decode_facts(payload.facts, event_type, recipient_ids)
                    if payload.facts is not None
                    else build_synthetic_workflow_facts(
                        event_type,
                        payload.reference_time,
                        program_id=UUID(trigger.config.program_id)
                        if trigger.config.program_id
                        else None,
                        offset_minutes=trigger.config.offset_minutes
                        if "offset_minutes" in trigger.config.model_fields_set
                        else None,
                        recipient_ids=recipient_ids,
                    )
                )
                trace = _walk(graph, event_type, facts, payload.reference_time)
            response = WorkflowSimulationResponse(
                valid=not issues,
                issues=list(issues.values()),
                trace=trace,
                next_actions=[
                    WorkflowSimulationAction(
                        node_id=row.node_id,
                        scheduled_at=None,
                        action_kind=row.action_kind,
                        reason=None,
                    )
                    for row in trace
                    if row.action_kind is not None
                ],
                reference_time=payload.reference_time,
                future_conditions_rechecked=True,
            )
            response.validate_graph_path(graph)
            return response
        except Exception:  # noqa: BLE001 - Malformed private projections never escape into responses.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
