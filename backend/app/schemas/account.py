from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


AccountDeletionStatus = Literal["scheduled", "canceled", "completed"]


class AccountDeletionRequestCreate(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=500)

    @field_validator("reason", mode="before")
    @classmethod
    def strip_reason(cls, value):
        if value is None:
            return value
        return str(value).strip() or None


class AccountDeletionRequestResponse(BaseModel):
    id: str
    user_id: str
    studio_id: Optional[str] = None
    requester_email: str
    status: AccountDeletionStatus
    requested_at: str
    scheduled_for: str
    canceled_at: Optional[str] = None
    completed_at: Optional[str] = None
    reason: Optional[str] = None


class AccountDeletionProcessFailure(BaseModel):
    request_id: str
    user_id: Optional[str] = None
    detail: str


class AccountDeletionProcessResponse(BaseModel):
    processed: int = 0
    completed: int = 0
    blocked: int = 0
    failed: int = 0
    failures: list[AccountDeletionProcessFailure] = Field(default_factory=list)
