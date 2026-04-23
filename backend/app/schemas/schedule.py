from pydantic import BaseModel, Field, model_validator
from typing import Literal, Optional


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

    @model_validator(mode="after")
    def validate_schedule_window(self):
        if self.end_time <= self.start_time:
            raise ValueError("End time must be after start time")
        if self.end_date and self.start_date and self.end_date < self.start_date:
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

    @model_validator(mode="after")
    def validate_schedule_window(self):
        if self.start_time and self.end_time and self.end_time <= self.start_time:
            raise ValueError("End time must be after start time")
        if self.end_date and self.start_date and self.end_date < self.start_date:
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

    @model_validator(mode="after")
    def validate_session_window(self):
        if self.end_time <= self.start_time:
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
    status: str
    notes: Optional[str] = None
    created_at: str
    attendance_count: int = 0


class ClassSessionDeleteScope(BaseModel):
    scope: Literal["session", "future_series"] = "session"


# ---- Attendance ----

class AttendanceCheckIn(BaseModel):
    session_id: str
    student_id: str
    status: str = "present"  # present, late, excused, absent


class AttendanceResponse(BaseModel):
    id: str
    studio_id: str
    session_id: str
    student_id: str
    status: str
    checked_in_at: str
    checked_in_by: Optional[str] = None
    # Joined student info for display
    student_name: Optional[str] = None


class AttendanceBulkCheckIn(BaseModel):
    session_id: str
    check_ins: list[AttendanceCheckIn]
