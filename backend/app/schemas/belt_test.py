"""Static belt-test event contracts for resolved instants and display zones."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints, model_validator

from app.schemas.trial_appointment import IANATimezone, Location, Revision, UTCInstant

EventName = Annotated[
    str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=140)
]
BeltTestStatus = Literal["draft", "scheduled", "completed", "canceled"]


class BeltTestModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


def _validate_window(starts_at: datetime, ends_at: datetime) -> None:
    if not timedelta(0) < ends_at - starts_at <= timedelta(days=1):
        raise ValueError("Belt tests must last more than zero and at most one day.")


class BeltTestEventCreate(BeltTestModel):
    operation_id: UUID
    name: EventName
    ladder_id: UUID
    starts_at: UTCInstant
    ends_at: UTCInstant
    timezone: IANATimezone
    location: Location = ""
    status: Literal["draft", "scheduled"] = "draft"

    @model_validator(mode="after")
    def validate_window(self) -> BeltTestEventCreate:
        _validate_window(self.starts_at, self.ends_at)
        return self


class BeltTestEventUpdate(BeltTestModel):
    operation_id: UUID
    expected_revision: Revision
    # Defaults represent omission only. Explicit null still fails the field type.
    name: EventName = None
    ladder_id: UUID = None
    starts_at: UTCInstant = None
    ends_at: UTCInstant = None
    timezone: IANATimezone = None
    location: Location = None
    status: BeltTestStatus = None

    @model_validator(mode="after")
    def validate_patch(self) -> BeltTestEventUpdate:
        edits = self.model_fields_set - {"operation_id", "expected_revision"}
        if not edits:
            raise ValueError("Provide at least one belt-test event change.")
        if {"starts_at", "ends_at"}.issubset(edits):
            _validate_window(self.starts_at, self.ends_at)
        return self


class BeltTestEventResponse(BeltTestModel):
    id: UUID
    studio_id: UUID
    name: EventName
    ladder_id: UUID
    program_id: UUID | None
    starts_at: UTCInstant
    ends_at: UTCInstant
    timezone: IANATimezone
    location: Location
    status: BeltTestStatus
    revision: Revision
    schedule_revision: Revision
    created_by: UUID | None
    created_at: UTCInstant
    updated_at: UTCInstant

    @model_validator(mode="after")
    def validate_window(self) -> BeltTestEventResponse:
        _validate_window(self.starts_at, self.ends_at)
        return self


class BeltTestEventListResponse(BeltTestModel):
    items: Annotated[list[BeltTestEventResponse], Field(strict=True, max_length=100)]
    next_cursor: Annotated[str, Field(strict=True, min_length=1, max_length=512)] | None
    has_more: StrictBool

    @model_validator(mode="after")
    def validate_cursor_presence(self) -> BeltTestEventListResponse:
        if self.has_more != (self.next_cursor is not None):
            raise ValueError("Invalid belt-test event page.")
        return self
