"""Strict public contracts for a bounded, non-sending workflow preview."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, BeforeValidator, Field, StrictBool, field_validator, model_validator

from app.schemas.trial_appointment import UTCInstant
from app.schemas.workflow import WorkflowGraph, WorkflowValidationIssue
from app.schemas.workflow_management import (
    INVALID_REQUEST_DETAIL,
    WorkflowManagementModel,
    WorkflowRequest,
    guard_workflow_request,
    require_complete_issues,
)
from app.schemas.workflow_run import GraphId, ReasonCode


class WorkflowSimulationSyntheticContext(WorkflowManagementModel):
    kind: Literal["synthetic"]


class WorkflowSimulationEntityContext(WorkflowManagementModel):
    kind: Literal["entity"]
    entity_type: Literal[
        "student",
        "promotion",
        "lead",
        "trial_appointment",
        "invoice",
        "payment",
        "belt_test_recipient",
    ]
    entity_id: UUID


SimulationContext = Annotated[
    WorkflowSimulationSyntheticContext | WorkflowSimulationEntityContext,
    Field(discriminator="kind"),
]
SimulationIssues = Annotated[
    list[WorkflowValidationIssue], Field(strict=True), BeforeValidator(require_complete_issues)
]
ActionKind = Literal["email", "lead_follow_up"]


def guard_workflow_simulation_request(value: object) -> None:
    """Keep transport guard precedence, then reject text JSONB cannot represent."""
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    guard_workflow_request(value)
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str) and "\x00" in item:
            raise HTTPException(422, INVALID_REQUEST_DETAIL)
        if isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)


class WorkflowSimulationRequest(WorkflowRequest):
    graph: WorkflowGraph
    context: SimulationContext

    @model_validator(mode="before")
    @classmethod
    def bound_request(cls, value: object) -> object:
        guard_workflow_simulation_request(value)
        return value


class WorkflowSimulationTrace(WorkflowManagementModel):
    node_id: GraphId
    outcome: Literal[
        "entered",
        "matched",
        "not_matched",
        "waiting",
        "would_send",
        "would_follow_up",
        "skipped",
        "completed",
    ]
    edge_id: GraphId | None
    reason: ReasonCode | None
    scheduled_at: UTCInstant | None
    action_kind: ActionKind | None
    rendered_subject: Annotated[str, Field(strict=True, max_length=200)] | None = Field(repr=False)
    rendered_body: Annotated[str, Field(strict=True, max_length=20000)] | None = Field(repr=False)

    @model_validator(mode="after")
    def consistent_outcome(self) -> WorkflowSimulationTrace:
        expected_action = {"would_send": "email", "would_follow_up": "lead_follow_up"}.get(
            self.outcome
        )
        if self.action_kind != expected_action:
            raise ValueError("Invalid simulation action.")
        if self.outcome == "would_send":
            if self.rendered_subject is None or self.rendered_body is None:
                raise ValueError("Missing simulation message.")
        elif self.rendered_subject is not None or self.rendered_body is not None:
            raise ValueError("Unexpected simulation message.")
        if self.outcome in {"waiting", "completed"} and self.edge_id is not None:
            raise ValueError("Invalid simulation stop.")
        if self.outcome not in {"waiting", "skipped"} and self.reason is not None:
            raise ValueError("Unexpected simulation reason.")
        return self


class WorkflowSimulationAction(WorkflowManagementModel):
    node_id: GraphId
    scheduled_at: UTCInstant | None
    action_kind: ActionKind
    reason: ReasonCode | None


class WorkflowSimulationResponse(WorkflowManagementModel):
    valid: StrictBool
    issues: SimulationIssues
    trace: Annotated[list[WorkflowSimulationTrace], Field(strict=True, max_length=40)]
    next_actions: Annotated[list[WorkflowSimulationAction], Field(strict=True, max_length=40)]
    reference_time: UTCInstant
    future_conditions_rechecked: Literal[True]

    @field_validator("future_conditions_rechecked", mode="before")
    @classmethod
    def literal_true(cls, value: object) -> object:
        if value is not True:
            raise ValueError("Future conditions must be rechecked.")
        return value

    @model_validator(mode="after")
    def consistent_result(self) -> WorkflowSimulationResponse:
        if self.valid != (not self.issues) or (
            not self.valid and (self.trace or self.next_actions)
        ):
            raise ValueError("Invalid simulation validation result.")
        if self.valid and not self.trace:
            raise ValueError("Missing simulation trace.")
        if len({row.node_id for row in self.trace}) != len(self.trace):
            raise ValueError("Repeated simulation node.")
        expected = [
            WorkflowSimulationAction(
                node_id=row.node_id, scheduled_at=None, action_kind=row.action_kind, reason=None
            )
            for row in self.trace
            if row.action_kind is not None
        ]
        if self.next_actions != expected:
            raise ValueError("Invalid simulation actions.")
        return self

    def validate_graph_path(self, graph: WorkflowGraph) -> None:
        """Check the public result against its submitted executable graph."""
        if not self.valid:
            return
        nodes = {node.id: node for node in graph.nodes}
        edges = {edge.id: edge for edge in graph.edges}
        triggers = [node.id for node in graph.nodes if node.type == "trigger"]
        if triggers != [self.trace[0].node_id]:
            raise ValueError("Invalid simulation start.")
        outcomes = {
            "trigger": {"entered", "waiting", "skipped"},
            "condition": {"matched", "not_matched", "waiting"},
            "delay": {"entered", "waiting"},
            "email": {"would_send", "skipped", "waiting"},
            "lead_follow_up": {"would_follow_up"},
            "end": {"completed"},
        }
        for index, row in enumerate(self.trace):
            node = nodes.get(row.node_id)
            if node is None or row.outcome not in outcomes[node.type]:
                raise ValueError("Invalid simulation node.")
            if node.type != "delay" and row.scheduled_at is not None:
                raise ValueError("Unexpected simulation schedule.")
            stop = row.outcome in {"waiting", "completed"} or (
                node.type == "trigger" and row.outcome == "skipped"
            )
            if stop:
                if row.edge_id is not None or index != len(self.trace) - 1:
                    raise ValueError("Invalid simulation stop.")
                continue
            edge = edges.get(row.edge_id)
            port = {"matched": "yes", "not_matched": "no"}.get(row.outcome, "next")
            if (
                edge is None
                or edge.source != row.node_id
                or edge.port != port
                or index + 1 >= len(self.trace)
                or self.trace[index + 1].node_id != edge.target
            ):
                raise ValueError("Invalid simulation edge.")
