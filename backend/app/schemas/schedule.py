from datetime import date, time
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Literal, Optional


ClassSessionStatus = Literal["scheduled", "in_progress", "completed", "canceled"]
AttendanceStatus = Literal["present", "late", "excused", "absent"]
ClassSessionDeleteScopeValue = Literal["session", "future_series"]


def _parse_schedule_time(value: str) -> time:
    if not isinstance(value, str) or len(value) != 5 or value[2] != ":":
        raise ValueError("Time must use HH:MM format")
    try:
        return time.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Time must use HH:MM format") from exc


def _parse_schedule_date(value: str) -> date:
    if (
        not isinstance(value, str)
        or len(value) != 10
        or value[4] != "-"
        or value[7] != "-"
    ):
        raise ValueError("Date must use YYYY-MM-DD format")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Date must use YYYY-MM-DD format") from exc


# ---- Class Template ----

class ClassTemplateCreate(BaseModel):
    name: str
    day_of_week: int = Field(ge=0, le=6)  # 0=Sunday
    start_time: str   # HH:MM
    end_time: str     # HH:MM
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = Field(default=None, gt=0)

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time_format(cls, value: str) -> str:
        _parse_schedule_time(value)
        return value

    @field_validator("start_date", "end_date")
    @classmethod
    def validate_date_format(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            _parse_schedule_date(value)
        return value

    @model_validator(mode="after")
    def validate_schedule_window(self):
        if _parse_schedule_time(self.end_time) <= _parse_schedule_time(self.start_time):
            raise ValueError("End time must be after start time")
        if self.end_date and self.start_date and _parse_schedule_date(self.end_date) < _parse_schedule_date(self.start_date):
            raise ValueError("End date cannot be before start date")
        return self


class ClassTemplateUpdate(BaseModel):
    name: Optional[str] = None
    day_of_week: Optional[int] = Field(default=None, ge=0, le=6)
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = Field(default=None, gt=0)
    is_active: Optional[bool] = None

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time_format(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            _parse_schedule_time(value)
        return value

    @field_validator("start_date", "end_date")
    @classmethod
    def validate_date_format(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            _parse_schedule_date(value)
        return value

    @model_validator(mode="after")
    def validate_schedule_window(self):
        if self.start_time and self.end_time and _parse_schedule_time(self.end_time) <= _parse_schedule_time(self.start_time):
            raise ValueError("End time must be after start time")
        if self.end_date and self.start_date and _parse_schedule_date(self.end_date) < _parse_schedule_date(self.start_date):
            raise ValueError("End date cannot be before start date")
        return self


class ClassTemplateResponse(BaseModel):
    id: str
    studio_id: str
    name: str
    day_of_week: int
    start_time: str
    end_time: str
    start_date: str
    end_date: Optional[str] = None
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = None
    is_active: bool
    created_at: str
    updated_at: str


# ---- Class Session ----

class ClassSessionCreate(BaseModel):
    template_id: Optional[str] = None
    name: str
    date: str  # YYYY-MM-DD
    start_time: str
    end_time: str
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = Field(default=None, gt=0)
    notes: Optional[str] = None

    @field_validator("date")
    @classmethod
    def validate_date_format(cls, value: str) -> str:
        _parse_schedule_date(value)
        return value

    @field_validator("start_time", "end_time")
    @classmethod
    def validate_time_format(cls, value: str) -> str:
        _parse_schedule_time(value)
        return value

    @model_validator(mode="after")
    def validate_session_window(self):
        if _parse_schedule_time(self.end_time) <= _parse_schedule_time(self.start_time):
            raise ValueError("End time must be after start time")
        return self


class ClassSessionResponse(BaseModel):
    id: str
    studio_id: str
    template_id: Optional[str] = None
    name: str
    date: str
    start_time: str
    end_time: str
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = None
    status: ClassSessionStatus
    notes: Optional[str] = None
    created_at: str
    attendance_count: int = 0


class ClassSessionDeleteScope(BaseModel):
    scope: ClassSessionDeleteScopeValue = "session"


# ---- Attendance ----

class AttendanceCheckIn(BaseModel):
    session_id: str
    student_id: str
    status: AttendanceStatus = "present"
    counts_toward_eligibility: Optional[bool] = None
    override_reason: Optional[str] = None


class AttendanceResponse(BaseModel):
    id: str
    studio_id: str
    session_id: str
    student_id: str
    status: AttendanceStatus
    checked_in_at: str
    checked_in_by: Optional[str] = None
    is_cross_program: bool = False
    counts_toward_eligibility: bool = True
    override_reason: Optional[str] = None
    # Joined student info for display
    student_name: Optional[str] = None


class AttendanceBulkCheckIn(BaseModel):
    session_id: str
    check_ins: list[AttendanceCheckIn]
