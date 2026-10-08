"""Bounded, metadata-only workflow history and cancellation contracts."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.schemas.trial_appointment import Revision, UTCInstant
from app.schemas.workflow import WorkflowId
from app.services.automation_email import normalize_email_address

ReasonCode = Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_]{0,79}$")]
GraphId = Annotated[WorkflowId, Field(strict=True)]
RunState = Literal[
    "queued",
    "waiting",
    "claimed",
    "running",
    "sending",
    "completed",
    "cancelled",
    "failed",
    "unknown",
]
TriggerEvent = Literal[
    "student.enrolled",
    "student.promoted",
    "lead.created",
    "lead.stage_changed",
    "trial.scheduled",
    "trial.completed",
    "trial.no_show",
    "trial.upcoming",
    "invoice.overdue",
    "invoice.payment_failed",
    "belt_test.approved",
    "belt_test.upcoming",
]


class WorkflowRunModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class WorkflowRunSummary(WorkflowRunModel):
    id: UUID
    studio_id: UUID
    workflow_id: UUID
    version_id: UUID
    version_number: Annotated[int, Field(strict=True, ge=1)]
    event_type: TriggerEvent
    subject_kind: Literal["student", "promotion", "lead", "trial", "invoice", "belt_test"]
    subject_id: UUID
    subject_label: Annotated[str, Field(strict=True, min_length=1, max_length=240)]
    state: RunState
    revision: Revision
    current_node_id: GraphId
    next_due_at: UTCInstant | None
    reason: ReasonCode | None
    cancel_requested_at: UTCInstant | None
    cancel_reason: ReasonCode | None
    can_cancel: StrictBool
    created_at: UTCInstant
    updated_at: UTCInstant

    @model_validator(mode="after")
    def consistent_state(self) -> WorkflowRunSummary:
        pending = self.state in {"queued", "waiting", "claimed", "running"}
        if pending != (self.next_due_at is not None):
            raise ValueError("Invalid run due time.")
        intent = self.cancel_requested_at is not None
        if intent != (self.cancel_reason is not None):
            raise ValueError("Incomplete cancellation intent.")
        if self.can_cancel != ((pending or self.state == "sending") and not intent):
            raise ValueError("Invalid cancellation availability.")
        return self


class WorkflowRunStep(WorkflowRunModel):
    id: UUID
    sequence: Annotated[int, Field(strict=True, ge=1, le=40)]
    node_id: GraphId
    node_type: Literal["trigger", "condition", "delay", "email", "lead_follow_up", "end"]
    outcome: Literal[
        "entered",
        "matched",
        "not_matched",
        "waiting",
        "sending",
        "accepted",
        "skipped",
        "failed",
        "unknown",
        "cancelled",
        "completed",
    ]
    edge_id: GraphId | None
    reason: ReasonCode | None
    scheduled_at: UTCInstant | None
    entered_at: UTCInstant
    finished_at: UTCInstant | None

    @model_validator(mode="after")
    def consistent_finish(self) -> WorkflowRunStep:
        pending = self.outcome in {"entered", "waiting", "sending"}
        if pending != (self.finished_at is None) or (
            self.finished_at is not None and self.finished_at < self.entered_at
        ):
            raise ValueError("Invalid step finish time.")
        return self


class WorkflowEmailAttemptSummary(WorkflowRunModel):
    id: UUID
    node_id: GraphId
    attempt_number: Annotated[int, Field(strict=True, ge=1, le=3)]
    state: Literal["sending", "accepted", "failed", "unknown"]
    reason: ReasonCode | None
    recipient_email: Annotated[str, Field(strict=True, min_length=1, max_length=254)]
    recipient_kind: Literal["student", "guardian", "lead", "invoice_payer", "assigned_staff"]
    began_at: UTCInstant
    settled_at: UTCInstant | None
    submission_evidence: Literal["not_submitted", "rejected", "accepted", "unknown"] | None
    failure_scope: Literal["sender_auth", "sender_transient", "message", "unclassified"] | None

    @field_validator("recipient_email")
    @classmethod
    def normalized_mailbox(cls, value: str) -> str:
        if normalize_email_address(value) != value:
            raise ValueError("Use a normalized mailbox.")
        return value

    @model_validator(mode="after")
    def consistent_settlement(self) -> WorkflowEmailAttemptSummary:
        if (self.state == "sending") != (self.settled_at is None) or (
            self.settled_at is not None and self.settled_at < self.began_at
        ):
            raise ValueError("Invalid attempt settlement time.")
        evidence = {
            "sending": set(),
            "accepted": {"accepted"},
            "failed": {"not_submitted", "rejected"},
            "unknown": {"unknown"},
        }
        scopes = {
            "sending": set(),
            "accepted": set(),
            "failed": {"sender_auth", "sender_transient", "message", "unclassified"},
            "unknown": {"unclassified"},
        }
        if (
            self.submission_evidence is not None
            and self.submission_evidence not in evidence[self.state]
        ) or (self.failure_scope is not None and self.failure_scope not in scopes[self.state]):
            raise ValueError("Invalid attempt evidence.")
        return self


class WorkflowRunDetail(WorkflowRunModel):
    run: WorkflowRunSummary
    steps: Annotated[list[WorkflowRunStep], Field(strict=True, max_length=40)]
    attempts: Annotated[list[WorkflowEmailAttemptSummary], Field(strict=True, max_length=120)]

    @model_validator(mode="after")
    def ordered_history(self) -> WorkflowRunDetail:
        sequences = [step.sequence for step in self.steps]
        if (
            len({step.id for step in self.steps}) != len(self.steps)
            or len({step.node_id for step in self.steps}) != len(self.steps)
            or len(set(sequences)) != len(sequences)
            or sequences != sorted(sequences)
        ):
            raise ValueError("Invalid step history.")
        email_steps = {
            step.node_id: step.sequence for step in self.steps if step.node_type == "email"
        }
        if (
            len({attempt.id for attempt in self.attempts}) != len(self.attempts)
            or len({(attempt.node_id, attempt.attempt_number) for attempt in self.attempts})
            != len(self.attempts)
            or any(attempt.node_id not in email_steps for attempt in self.attempts)
        ):
            raise ValueError("Invalid attempt history.")
        order = [
            (email_steps[attempt.node_id], attempt.attempt_number, attempt.id)
            for attempt in self.attempts
        ]
        if order != sorted(order):
            raise ValueError("Invalid attempt order.")
        return self


class WorkflowRunListResponse(WorkflowRunModel):
    items: Annotated[list[WorkflowRunSummary], Field(strict=True, max_length=100)]
    next_cursor: Annotated[str, Field(strict=True, min_length=1, max_length=512)] | None
    has_more: StrictBool

    @model_validator(mode="after")
    def consistent_cursor(self) -> WorkflowRunListResponse:
        if self.has_more != (self.next_cursor is not None):
            raise ValueError("Invalid run page.")
        return self


class WorkflowRunCancelRequest(WorkflowRunModel):
    operation_id: UUID
    expected_revision: Revision
