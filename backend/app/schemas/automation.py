"""Public contracts for the single missed-class automation."""

from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.services.automation_email import (
    DEFAULT_MISSED_CLASS_BODY,
    DEFAULT_MISSED_CLASS_SUBJECT,
    normalize_email_address,
    validate_missed_class_templates,
)

AutomationState = Literal[
    "queued", "claimed", "sending", "accepted", "retry_wait", "failed", "unknown", "skipped"
]
AutomationReason = Literal[
    "rule_paused",
    "subscription_required",
    "student_unavailable",
    "inactive",
    "on_hold",
    "invalid_birth_date",
    "never_attended",
    "recent_attendance",
    "invalid_email",
    "guardian_missing",
    "guardian_ambiguous",
    "suppressed",
    "episode_already_attempted",
    "attendance_changed",
    "contact_changed",
    "lease_expired",
    "rate_limited",
    "connection_failed",
    "authentication_required",
    "provider_rejected",
    "provider_unknown",
    "retry_exhausted",
    "unavailable",
    "recipient_not_allowed",
]


class MissedClassPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inactivity_days: int = Field(ge=1, le=90, strict=True)
    subject_template: str = Field(min_length=1, max_length=200)
    body_template: str = Field(min_length=1, max_length=5000)
    reply_to_email: str = Field(max_length=254)

    @field_validator("reply_to_email", mode="before")
    @classmethod
    def validate_reply_to(cls, value: str) -> str:
        return normalize_email_address(value)

    @model_validator(mode="after")
    def validate_templates(self) -> Self:
        validate_missed_class_templates(self.subject_template, self.body_template)
        return self


class MissedClassRuleUpdate(MissedClassPreviewRequest):
    enabled: bool = Field(strict=True)
    expected_revision: int = Field(ge=0, le=2**63 - 1, strict=True)


class MissedClassRuleResponse(BaseModel):
    enabled: bool = False
    inactivity_days: int = Field(default=14, ge=1, le=90)
    subject_template: str = DEFAULT_MISSED_CLASS_SUBJECT
    body_template: str = DEFAULT_MISSED_CLASS_BODY
    reply_to_email: str
    revision: int = Field(default=0, ge=0)
    updated_at: str | None


class AutomationDeliveryStatus(BaseModel):
    mode: Literal["disabled", "test", "live"]
    configured: bool
    can_enable: bool
    sender: str
    test_recipient: str | None
    reason: (
        Literal["setup_required", "sending_disabled", "authentication_required", "unavailable"]
        | None
    )


class MissedClassSettingsResponse(BaseModel):
    rule: MissedClassRuleResponse
    delivery_status: AutomationDeliveryStatus


class MissedClassPreviewRecipient(BaseModel):
    student_id: str
    student_name: str
    last_attendance_date: str | None
    days_absent: int | None
    recipient_name: str | None
    recipient_email: str | None
    recipient_kind: Literal["student", "guardian"] | None
    skip_reason: AutomationReason | None
    rendered_subject: str | None
    rendered_body: str | None


class MissedClassPreviewResponse(BaseModel):
    reference_date: str
    eligible_count: int = Field(ge=0)
    skipped_count: int = Field(ge=0)
    recipients: list[MissedClassPreviewRecipient] = Field(max_length=100)
    truncated: bool


class MissedClassActivityItem(BaseModel):
    id: str
    student_id: str
    student_name: str
    recipient_email: str
    state: AutomationState
    created_at: str
    attempted_at: str | None
    settled_at: str | None
    attempts: int = Field(ge=0)
    reason: AutomationReason | None


class MissedClassActivityResponse(BaseModel):
    items: list[MissedClassActivityItem] = Field(max_length=100)
    has_more: bool


class MissedClassProcessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=10, ge=1, le=10, strict=True)


class MissedClassProcessResponse(BaseModel):
    enqueued: int = Field(default=0, ge=0, le=10, strict=True)
    processed: int = Field(default=0, ge=0, le=10, strict=True)
    accepted: int = Field(default=0, ge=0, le=10, strict=True)
    retry_wait: int = Field(default=0, ge=0, le=10, strict=True)
    failed: int = Field(default=0, ge=0, le=10, strict=True)
    unknown: int = Field(default=0, ge=0, le=10, strict=True)
    skipped: int = Field(default=0, ge=0, le=10, strict=True)
    has_more: bool = False

    @model_validator(mode="after")
    def validate_counts(self) -> Self:
        if self.processed != sum(
            (self.accepted, self.retry_wait, self.failed, self.unknown, self.skipped)
        ):
            raise ValueError("inconsistent_automation_counts")
        return self
