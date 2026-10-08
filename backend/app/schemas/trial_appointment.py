"""Static trial appointment contracts for resolved instants and display zones."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, model_validator

_INSTANT = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?"
    r"(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)"
)
_ZONE = re.compile(r"[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*")
MAX_REVISION = 2**63 - 1


def _utc_instant(value: object) -> datetime:
    if isinstance(value, str):
        if not _INSTANT.fullmatch(value):
            raise ValueError("Use a datetime with an explicit UTC offset.")
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("Use a valid datetime with an explicit UTC offset.") from None
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Use a datetime with an explicit UTC offset.")
    try:
        return value.astimezone(timezone.utc)
    except (OverflowError, ValueError):
        raise ValueError("Use a finite UTC datetime.") from None


def _iana_zone(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 128
        or not _ZONE.fullmatch(value)
        or any(part in {".", ".."} for part in value.split("/"))
        or value.split("/")[0] in {"localtime", "posixrules", "posix", "right"}
    ):
        raise ValueError("Use an explicit IANA timezone.")
    try:
        ZoneInfo(value)
    except (ValueError, OSError, ZoneInfoNotFoundError):
        raise ValueError("Use an explicit IANA timezone.") from None
    return value


UTCInstant = Annotated[datetime, BeforeValidator(_utc_instant)]
IANATimezone = Annotated[str, BeforeValidator(_iana_zone)]
Location = Annotated[str, Field(strict=True, max_length=240)]
Revision = Annotated[int, Field(strict=True, ge=1, le=MAX_REVISION)]
TrialStatus = Literal["scheduled", "completed", "no_show", "canceled"]


class TrialAppointmentModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


def _validate_window(starts_at: datetime, ends_at: datetime) -> None:
    if not timedelta(0) < ends_at - starts_at <= timedelta(days=1):
        raise ValueError("Trial appointments must last more than zero and at most one day.")


class TrialAppointmentCreate(TrialAppointmentModel):
    operation_id: UUID
    starts_at: UTCInstant
    ends_at: UTCInstant
    timezone: IANATimezone
    location: Location = ""
    program_id: UUID | None = None

    @model_validator(mode="after")
    def validate_window(self) -> TrialAppointmentCreate:
        _validate_window(self.starts_at, self.ends_at)
        return self


class TrialAppointmentUpdate(TrialAppointmentModel):
    operation_id: UUID
    expected_revision: Revision
    # Defaults represent omission only. Explicit null still fails the field type.
    starts_at: UTCInstant = None
    ends_at: UTCInstant = None
    timezone: IANATimezone = None
    location: Location = None
    program_id: UUID | None = None
    status: TrialStatus = None

    @model_validator(mode="after")
    def validate_patch(self) -> TrialAppointmentUpdate:
        edits = self.model_fields_set - {"operation_id", "expected_revision"}
        if not edits:
            raise ValueError("Provide at least one appointment change.")
        if self.status in {"completed", "no_show", "canceled"} and edits - {"status"}:
            raise ValueError("Submit an outcome separately from schedule changes.")
        if {"starts_at", "ends_at"}.issubset(edits):
            _validate_window(self.starts_at, self.ends_at)
        return self


class TrialAppointmentResponse(TrialAppointmentModel):
    id: UUID
    studio_id: UUID
    lead_id: UUID
    program_id: UUID | None
    starts_at: UTCInstant
    ends_at: UTCInstant
    timezone: IANATimezone
    location: Location
    status: TrialStatus
    revision: Revision
    created_by: UUID | None
    created_at: UTCInstant
    updated_at: UTCInstant

    @model_validator(mode="after")
    def validate_window(self) -> TrialAppointmentResponse:
        _validate_window(self.starts_at, self.ends_at)
        return self


class TrialAppointmentListResponse(TrialAppointmentModel):
    items: Annotated[list[TrialAppointmentResponse], Field(strict=True, max_length=100)]
    next_cursor: Annotated[str, Field(strict=True, min_length=1, max_length=512)] | None
    has_more: StrictBool

    @model_validator(mode="after")
    def validate_cursor_presence(self) -> TrialAppointmentListResponse:
        if self.has_more != (self.next_cursor is not None):
            raise ValueError("Invalid appointment page.")
        return self
