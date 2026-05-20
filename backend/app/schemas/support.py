import json
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


SupportTicketTopic = Literal[
    "billing",
    "account_access",
    "student_records",
    "bug_report",
    "product_question",
    "other",
]
SupportTicketSeverity = Literal["low", "normal", "high", "urgent"]
SupportTicketStatus = Literal["open", "triaging", "waiting_on_customer", "resolved", "closed"]


class SupportTicketCreate(BaseModel):
    topic: SupportTicketTopic
    severity: SupportTicketSeverity = "normal"
    subject: str = Field(min_length=3, max_length=160)
    details: str = Field(min_length=10, max_length=5000)
    page_url: Optional[str] = Field(default=None, max_length=1000)
    user_agent: Optional[str] = Field(default=None, max_length=1000)
    browser_context: dict[str, Any] = Field(default_factory=dict)

    @field_validator("subject", "details", "page_url", "user_agent", mode="before")
    @classmethod
    def strip_optional_text(cls, value):
        if value is None:
            return value
        return str(value).strip()

    @model_validator(mode="after")
    def limit_browser_context_size(self):
        try:
            encoded = json.dumps(self.browser_context, separators=(",", ":"), default=str)
        except (TypeError, ValueError) as exc:
            raise ValueError("Browser context must be JSON serializable.") from exc
        if len(encoded.encode("utf-8")) > 4000:
            raise ValueError("Browser context is too large.")
        return self


class SupportTicketResponse(BaseModel):
    id: str
    studio_id: str
    created_by: Optional[str] = None
    requester_email: str
    requester_name: Optional[str] = None
    topic: SupportTicketTopic
    severity: SupportTicketSeverity
    subject: str
    details: str
    page_url: Optional[str] = None
    user_agent: Optional[str] = None
    browser_context: dict[str, Any] = Field(default_factory=dict)
    status: SupportTicketStatus
    created_at: str
    updated_at: str
    resolved_at: Optional[str] = None


class SupportTriageFilters(BaseModel):
    statuses: list[SupportTicketStatus] = Field(default_factory=list, max_length=5)
    severities: list[SupportTicketSeverity] = Field(default_factory=list, max_length=4)
    topics: list[SupportTicketTopic] = Field(default_factory=list, max_length=6)
    limit: int = Field(default=50, ge=1, le=100)


class SupportTicketTriageUpdate(BaseModel):
    status: Optional[SupportTicketStatus] = None
    note: Optional[str] = Field(default=None, max_length=2000)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("note", mode="before")
    @classmethod
    def strip_note(cls, value):
        if value is None:
            return value
        text = str(value).strip()
        return text or None

    @model_validator(mode="after")
    def require_action_and_limit_metadata(self):
        if self.status is None and self.note is None:
            raise ValueError("A status change or note is required.")
        try:
            encoded = json.dumps(self.metadata, separators=(",", ":"), default=str)
        except (TypeError, ValueError) as exc:
            raise ValueError("Metadata must be JSON serializable.") from exc
        if len(encoded.encode("utf-8")) > 4000:
            raise ValueError("Metadata is too large.")
        return self
