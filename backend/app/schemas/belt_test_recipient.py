"""Belt-test approval requests and historical recipient snapshots."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StrictBool, model_validator

from app.schemas.belt_test import BeltTestModel
from app.schemas.trial_appointment import Revision, UTCInstant


class BeltTestRecipientResponse(BeltTestModel):
    id: UUID
    studio_id: UUID
    event_id: UUID
    student_id: UUID
    student_program_membership_id: UUID | None
    approved_schedule_revision: Revision
    approved_current_rank_id: UUID | None
    approved_target_rank_id: UUID
    state: Literal["approved", "revoked"]
    revision: Revision
    approved_by: UUID | None
    approved_at: UTCInstant
    revoked_at: UTCInstant | None
    created_at: UTCInstant
    updated_at: UTCInstant


class BeltTestRecipientSelection(BeltTestModel):
    student_id: UUID
    student_program_membership_id: UUID | None = None


class BeltTestRecipientApprove(BeltTestModel):
    operation_id: UUID
    expected_event_revision: Revision
    recipients: Annotated[
        list[BeltTestRecipientSelection], Field(strict=True, min_length=1, max_length=100)
    ]

    @model_validator(mode="after")
    def validate_unique_pairs(self) -> BeltTestRecipientApprove:
        pairs = {(row.student_id, row.student_program_membership_id) for row in self.recipients}
        if len(pairs) != len(self.recipients):
            raise ValueError("Select each belt-test student and membership pair only once.")
        return self


class BeltTestRecipientRevoke(BeltTestModel):
    operation_id: UUID
    expected_revision: Revision


class BeltTestRecipientApprovalResponse(BeltTestModel):
    items: Annotated[
        list[BeltTestRecipientResponse], Field(strict=True, min_length=1, max_length=100)
    ]
    event_revision: Revision
    schedule_revision: Revision


class BeltTestRecipientListResponse(BeltTestModel):
    items: Annotated[list[BeltTestRecipientResponse], Field(strict=True, max_length=100)]
    next_cursor: Annotated[str, Field(strict=True, min_length=1, max_length=512)] | None
    has_more: StrictBool

    @model_validator(mode="after")
    def validate_cursor_presence(self) -> BeltTestRecipientListResponse:
        if self.has_more != (self.next_cursor is not None):
            raise ValueError("Invalid belt-test recipient page.")
        return self
