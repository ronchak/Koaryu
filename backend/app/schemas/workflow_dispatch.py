"""Closed private SQL dispatch protocol. These models grant no source authority."""

from __future__ import annotations

import re
from typing import Annotated, Generic, Literal, TypeVar
from uuid import UUID

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    ValidationInfo,
    model_validator,
)

from app.schemas.automation import AutomationReason, AutomationState
from app.schemas.trial_appointment import Revision, UTCInstant
from app.schemas.workflow_run import GraphId, ReasonCode, RunState, TriggerEvent
from app.services.automation_email import (
    DeliveryResult,
    normalize_email_address,
    validate_public_api_url,
)
from app.services.workflow_catalog import CATALOG
from app.services.workflow_simulation_service import _decode_facts, _Facts

TRANSPORT_CODES = frozenset(
    {
        "authentication_required",
        "credential_refresh_conflict",
        "credential_store_unavailable",
        "invalid_message",
        "provider_connection_failed",
        "provider_rejected",
        "provider_submission_unknown",
        "provider_throttled",
        "provider_unavailable",
        "recipient_not_allowed",
        "send_budget_exhausted",
        "sending_disabled",
        "setup_required",
        "token_refresh_invalid",
        "token_refresh_rejected",
        "token_refresh_throttled",
        "token_refresh_unavailable",
    }
)
TERMINAL = {"completed", "cancelled", "failed", "unknown"}
OWNED = {"claimed", "running"}


def _mailbox(value: object) -> str:
    if type(value) is not str or normalize_email_address(value) != value:
        raise ValueError("invalid_dispatch_mailbox")
    return value


def _text(value: object) -> str:
    if type(value) is not str or "\x00" in value:
        raise ValueError("invalid_dispatch_text")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError("invalid_dispatch_text") from None
    return value


def _code(value: object) -> str:
    if type(value) is not str or value not in TRANSPORT_CODES:
        raise ValueError("invalid_dispatch_code")
    return value


Mailbox = Annotated[str, BeforeValidator(_mailbox)]
Text = Annotated[str, BeforeValidator(_text)]
Hex64 = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]
SafeCode = Annotated[str, BeforeValidator(_code)]
Limit = Annotated[int, Field(strict=True, ge=1, le=10)]
Retry = Annotated[int, Field(strict=True, ge=1, le=86400)]
PreparationRetry = Annotated[int, Field(strict=True, ge=1, le=3600)]
RecipientPolicy = Literal[
    "student_or_guardian", "lead_or_guardian", "invoice_payer", "assigned_staff"
]
RecipientKind = Literal["student", "guardian", "lead", "invoice_payer", "assigned_staff"]


class DispatchModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", revalidate_instances="always", hide_input_in_errors=True
    )

    def __repr_args__(self):
        # Parent containers must not reveal nested facts, messages, tokens or addresses.
        return iter(())


T = TypeVar("T", bound=DispatchModel)


class Envelope(DispatchModel, Generic[T]):
    payload: T = Field(repr=False)


class RunPosition(DispatchModel):
    state: RunState
    current_node_id: GraphId
    next_due_at: UTCInstant | None
    reason: ReasonCode | None

    @model_validator(mode="after")
    def coherent(self):
        if (self.state in {"queued", "waiting", "claimed", "running"}) != (
            self.next_due_at is not None
        ):
            raise ValueError("invalid_dispatch_due_time")
        return self


class Scope(DispatchModel):
    studio_id: UUID
    run_id: UUID
    claim_token: UUID = Field(repr=False)


class NodeScope(Scope):
    node_id: GraphId


class Claim(Scope):
    lease_expires_at: UTCInstant


class Claims(DispatchModel):
    claims: Annotated[list[Claim], Field(strict=True, max_length=10, repr=False)]
    has_more: StrictBool

    @model_validator(mode="after")
    def unique(self):
        if len({c.run_id for c in self.claims}) != len(self.claims) or len(
            {c.claim_token for c in self.claims}
        ) != len(self.claims):
            raise ValueError("duplicate_dispatch_claim")
        return self


def _position(outcome: str, run: RunPosition | None, *, node_id: str | None = None) -> None:
    if outcome == "lease_lost":
        valid = run is None
    elif run is None:
        valid = False
    elif outcome in {"continue", "email", "stale_plan", "planned"}:
        valid = run.state in OWNED
    elif outcome == "waiting":
        valid = run.state == "waiting"
    elif outcome == "stopped":
        valid = run.state in TERMINAL
    elif outcome == "skipped":
        valid = run.state in TERMINAL | {"queued"}
    elif outcome == "begun":
        valid = run.state == "sending"
    else:  # already_begun returns current truth, never another grant.
        valid = outcome == "already_begun"
    if not valid or (
        node_id is not None
        and outcome in {"planned", "stale_plan", "begun"}
        and run.current_node_id != node_id
    ):
        raise ValueError("invalid_dispatch_position")


class Transition(Scope):
    outcome: Literal["continue", "email", "waiting", "stopped", "lease_lost"]
    run: RunPosition | None = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        _position(self.outcome, self.run)
        return self


class Deferred(Transition):
    outcome: Literal["waiting", "stopped", "lease_lost"]


class Resolved(NodeScope):
    outcome: Literal["continue", "waiting", "stopped", "stale_plan", "lease_lost"]
    run: RunPosition | None = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        _position(self.outcome, self.run, node_id=self.node_id)
        return self


class Plan(DispatchModel):
    fingerprint: Hex64
    disposition: Literal["send", "skip", "wait", "stop"]
    reason: ReasonCode | None
    event_type: TriggerEvent
    recipient_policy: RecipientPolicy
    recipient_email: Mailbox | None = Field(repr=False)
    recipient_kind: RecipientKind | None
    subject_template: Annotated[Text, Field(max_length=200, repr=False)]
    body_template: Annotated[Text, Field(max_length=5000, repr=False)]
    reply_to: Mailbox = Field(repr=False)
    unsubscribe_token: Hex64 = Field(repr=False)
    unsubscribe_url: Annotated[Text, Field(max_length=2048, repr=False)]
    facts: _Facts = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        if self.recipient_policy not in CATALOG["triggers"][self.event_type]["recipient_ids"]:
            raise ValueError("invalid_dispatch_recipient_policy")
        facts = _decode_facts(self.facts, self.event_type, frozenset({self.recipient_policy}))
        kinds = {
            "student_or_guardian": {"student", "guardian"},
            "lead_or_guardian": {"lead", "guardian"},
            "invoice_payer": {"invoice_payer"},
            "assigned_staff": {"assigned_staff"},
        }
        if (
            self.recipient_kind is not None
            and self.recipient_kind not in kinds[self.recipient_policy]
        ):
            raise ValueError("invalid_dispatch_recipient_kind")
        if (self.disposition == "send") != (self.reason is None):
            raise ValueError("invalid_dispatch_plan_reason")
        if self.disposition == "send" and (
            self.recipient_email is None
            or self.recipient_kind is None
            or facts.source_decision != "eligible"
            or self.recipient_policy not in facts.recipients
            or facts.recipients[self.recipient_policy].decision != "ready"
        ):
            raise ValueError("invalid_dispatch_send_plan")
        return self


class Planned(NodeScope):
    outcome: Literal["planned", "lease_lost"]
    run: RunPosition | None = Field(repr=False)
    plan: Plan | None = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        _position(self.outcome, self.run, node_id=self.node_id)
        if (self.outcome == "planned") != (self.plan is not None):
            raise ValueError("invalid_dispatch_plan")
        return self


class Rendered(DispatchModel):
    subject: Annotated[Text, Field(max_length=200, repr=False)]
    text_body: Annotated[Text, Field(max_length=22084, repr=False)]
    html_body: Annotated[Text, Field(max_length=132383, repr=False)]

    @model_validator(mode="after")
    def bounded_bytes(self):
        if any(
            len(getattr(self, key).encode("utf-8")) > bound
            for key, bound in (("subject", 800), ("text_body", 88228), ("html_body", 132383))
        ):
            raise ValueError("oversized_dispatch_message")
        return self


class Message(Rendered):
    to_address: Mailbox = Field(repr=False)
    reply_to: Mailbox = Field(repr=False)
    attempt_id: UUID


class Attempt(DispatchModel):
    id: UUID
    attempt_number: Annotated[int, Field(strict=True, ge=1, le=3)]
    lease_expires_at: UTCInstant
    credential_revision: Revision
    sender_binding: Hex64
    message: Message = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        if self.message.attempt_id != self.id:
            raise ValueError("invalid_dispatch_attempt_identity")
        return self


class Begun(NodeScope):
    outcome: Literal[
        "begun", "stale_plan", "waiting", "skipped", "stopped", "lease_lost", "already_begun"
    ]
    run: RunPosition | None = Field(repr=False)
    attempt: Attempt | None = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        _position(self.outcome, self.run, node_id=self.node_id)
        if (self.outcome == "begun") != (self.attempt is not None):
            raise ValueError("invalid_dispatch_begin")
        return self


class Settlement(DispatchModel):
    updated: StrictBool
    replayed: StrictBool
    state: Literal["accepted", "failed", "unknown"] | None
    reason: ReasonCode | None

    @model_validator(mode="after")
    def coherent(self):
        if self.updated != (self.state is not None) or (
            not self.updated and (self.replayed or self.reason is not None)
        ):
            raise ValueError("invalid_dispatch_settlement")
        return self


class Settled(Settlement):
    studio_id: UUID
    attempt_id: UUID
    run: RunPosition | None = Field(repr=False)

    @model_validator(mode="after")
    def current_position(self):
        if self.updated != (self.run is not None) or (
            self.updated and not self.replayed and self.run.state in OWNED | {"sending"}
        ):
            raise ValueError("invalid_dispatch_settled_position")
        return self


class PreparationFields(DispatchModel):
    preparation_id: UUID
    generation: Revision
    preparation_token: UUID | None = Field(repr=False)
    probe_token: UUID | None = Field(repr=False)
    lease_expires_at: UTCInstant | None
    retry_at: UTCInstant | None
    reason: ReasonCode | None

    def check_grant(self, allowed: bool):
        if allowed:
            valid = (
                self.preparation_token is not None
                and self.lease_expires_at is not None
                and self.retry_at is None
                and self.reason is None
            )
        else:
            valid = (
                self.preparation_token is None
                and self.probe_token is None
                and self.lease_expires_at is None
                and self.reason is not None
            )
        if not valid:
            raise ValueError("invalid_dispatch_preparation_grant")


class PreparationClaim(PreparationFields):
    allowed: StrictBool
    mode: Literal["ready", "cooldown", "auth_blocked"]

    @model_validator(mode="after")
    def coherent(self):
        self.check_grant(self.allowed)
        if self.allowed:
            valid = self.mode != "auth_blocked" and (self.probe_token is not None) == (
                self.mode == "cooldown"
            )
        else:
            valid = (self.mode != "cooldown" or self.retry_at is not None) and (
                self.mode != "auth_blocked" or self.retry_at is None
            )
        if not valid:
            raise ValueError("invalid_dispatch_preparation_mode")
        return self


class PreparationSettled(PreparationFields):
    outcome: Literal["prepared", "deferred", "blocked", "stale"]

    @model_validator(mode="after")
    def coherent(self):
        self.check_grant(self.outcome == "prepared")
        if (self.outcome == "deferred" and self.retry_at is None) or (
            self.outcome == "blocked" and self.retry_at is not None
        ):
            raise ValueError("invalid_dispatch_preparation_result")
        return self


class PreparationResult(DispatchModel):
    outcome: Literal["prepared", "sender_transient", "sender_auth"]
    credential_revision: Revision | None
    sender_binding: Hex64
    safe_reason: SafeCode | None
    retry_after_seconds: PreparationRetry | None

    @model_validator(mode="after")
    def coherent(self):
        if self.outcome == "prepared":
            valid = (
                self.credential_revision is not None
                and self.safe_reason is None
                and self.retry_after_seconds is None
            )
        else:
            valid = self.credential_revision is None and self.safe_reason is not None
        if not valid:
            raise ValueError("invalid_dispatch_preparation_evidence")
        return self


class Delivery(DispatchModel):
    outcome: Literal["accepted", "retryable_failure", "permanent_failure", "unknown"]
    error_code: SafeCode | None
    provider_request_id: (
        Annotated[str, Field(strict=True, pattern=r"^[A-Za-z0-9_.:-]{1,200}$")] | None
    )
    retry_after_seconds: Retry | None
    submission_evidence: Literal["not_submitted", "rejected", "accepted", "unknown"] | None
    failure_scope: Literal["sender_auth", "sender_transient", "message", "unclassified"] | None
    credential_revision: Revision | None

    @model_validator(mode="after")
    def coherent(self):
        DeliveryResult(**self.model_dump())
        if (self.outcome == "accepted" and self.error_code is not None) or (
            self.outcome in {"retryable_failure", "permanent_failure"}
            and self.submission_evidence not in {"not_submitted", "rejected"}
        ):
            raise ValueError("unproved_dispatch_evidence")
        return self


class LegacySnapshot(DispatchModel):
    delivery_id: UUID
    attempt_id: StrictStr
    student_first_name: StrictStr = Field(repr=False)
    studio_name: StrictStr = Field(repr=False)
    days_absent: Annotated[int, Field(strict=True)]
    recipient_email: StrictStr = Field(repr=False)
    subject_template: StrictStr = Field(repr=False)
    body_template: StrictStr = Field(repr=False)
    reply_to_email: StrictStr = Field(repr=False)
    unsubscribe_token: StrictStr = Field(repr=False)

    @model_validator(mode="after")
    def identity(self):
        if (
            re.fullmatch(re.escape(str(self.delivery_id)) + r":[1-9][0-9]*", self.attempt_id)
            is None
        ):
            raise ValueError("invalid_legacy_attempt_identity")
        return self


class LegacyBegun(DispatchModel):
    delivery_id: UUID
    claim_token: UUID = Field(repr=False)
    ready: StrictBool
    state: AutomationState | None
    reason: AutomationReason | None
    attempt_id: UUID | None
    lease_expires_at: UTCInstant | None
    credential_revision: Revision | None
    sender_binding: Hex64 | None
    message: LegacySnapshot | None = Field(repr=False)

    @model_validator(mode="after")
    def coherent(self):
        grant = (
            self.attempt_id,
            self.lease_expires_at,
            self.credential_revision,
            self.sender_binding,
            self.message,
        )
        if self.ready:
            valid = (
                all(v is not None for v in grant)
                and self.state == "sending"
                and self.reason is None
                and self.message.delivery_id == self.delivery_id
            )
        else:
            valid = all(v is None for v in grant)
        if not valid:
            raise ValueError("invalid_legacy_begin")
        return self


class LegacySettled(Settlement):
    delivery_id: UUID
    attempt_id: UUID
    state: Literal["accepted", "retry_wait", "failed", "unknown"] | None
    reason: AutomationReason | None


class ClaimRequest(DispatchModel):
    p_limit: Limit


class ScopeRequest(DispatchModel):
    p_studio_id: UUID
    p_run_id: UUID
    p_claim_token: UUID = Field(repr=False)


class AdvanceRequest(ScopeRequest):
    p_step_limit: Limit


class DeferRequest(ScopeRequest):
    p_reason: Literal["facts_unavailable", "subscription_required", "sender_unavailable"]


class PlanParameters(ScopeRequest):
    p_node_id: GraphId
    p_allowed_recipients: Annotated[list[Mailbox], Field(strict=True, repr=False)]
    p_default_reply_to: Mailbox = Field(repr=False)
    p_public_api_url: Annotated[str, BeforeValidator(validate_public_api_url)] = Field(repr=False)


class PlanRequest(PlanParameters):
    p_candidate_unsubscribe_token: Hex64 = Field(repr=False)


class PlanDecision(DispatchModel):
    kind: Literal["plan_decision"]


class RenderFailed(DispatchModel):
    kind: Literal["render_failed"]
    reason: Literal["unsupported_currency", "invalid_email_template", "invalid_email_context"]


class Unavailable(DispatchModel):
    kind: Literal["facts_unavailable", "sender_unavailable"]


class BoundPlanRequest(PlanParameters):
    p_plan_fingerprint: Hex64
    p_unsubscribe_token: Hex64 = Field(repr=False)


class ResolveRequest(BoundPlanRequest):
    p_resolution: Annotated[
        PlanDecision | RenderFailed | Unavailable, Field(discriminator="kind", repr=False)
    ]


class BeginRequest(BoundPlanRequest):
    p_rendered: Rendered = Field(repr=False)
    p_preparation_id: UUID
    p_preparation_token: UUID = Field(repr=False)
    p_probe_token: UUID | None = Field(repr=False)


class PreparationClaimRequest(DispatchModel):
    p_provider_key: Literal["microsoft_graph:primary"]
    p_preparation_id: UUID
    p_sender_binding: Hex64


class PreparationSettleRequest(DispatchModel):
    p_preparation_id: UUID
    p_preparation_token: UUID = Field(repr=False)
    p_result: PreparationResult = Field(repr=False)


class SettleRequest(DispatchModel):
    p_studio_id: UUID
    p_attempt_id: UUID
    p_claim_token: UUID = Field(repr=False)
    p_result: Delivery = Field(repr=False)


class LegacyBeginRequest(DispatchModel):
    p_delivery_id: UUID
    p_claim_token: UUID = Field(repr=False)
    p_preparation_id: UUID
    p_preparation_token: UUID = Field(repr=False)
    p_allowed_recipients: Annotated[list[Mailbox], Field(strict=True, repr=False)]
    p_probe_token: UUID | None = Field(repr=False)


class LegacySettleRequest(DispatchModel):
    p_delivery_id: UUID
    p_claim_token: UUID = Field(repr=False)
    p_attempt_id: UUID
    p_result: Delivery = Field(repr=False)


Count = Annotated[int, Field(strict=True, ge=0, le=10)]


class WorkflowProcessResponse(DispatchModel):
    claimed: Count = 0
    processed: Count = 0
    accepted: Count = 0
    retry_wait: Count = 0
    failed: Count = 0
    unknown: Count = 0
    skipped: Count = 0
    completed: Count = 0
    waiting: Count = 0
    has_more: StrictBool = False

    @model_validator(mode="after")
    def coherent(self, info: ValidationInfo):
        if (
            self.claimed > (info.context or {}).get("limit", 10)
            or self.processed > self.claimed
            or self.processed
            != sum(
                getattr(self, key)
                for key in (
                    "accepted",
                    "retry_wait",
                    "failed",
                    "unknown",
                    "skipped",
                    "completed",
                    "waiting",
                )
            )
        ):
            raise ValueError("invalid_dispatch_counts")
        return self
