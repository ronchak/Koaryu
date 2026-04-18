from pydantic import BaseModel
from typing import Optional
from datetime import date, time


# ---- Class Template ----

class ClassTemplateCreate(BaseModel):
    name: str
    day_of_week: int  # 0=Sunday
    start_time: str   # HH:MM
    end_time: str     # HH:MM
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = None


class ClassTemplateUpdate(BaseModel):
    name: Optional[str] = None
    day_of_week: Optional[int] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    instructor_id: Optional[str] = None
    program_id: Optional[str] = None
    capacity: Optional[int] = None
    is_active: Optional[bool] = None


class ClassTemplateResponse(BaseModel):
    id: str
    studio_id: str
    name: str
    day_of_week: int
    start_time: str
    end_time: str
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
    capacity: Optional[int] = None
    notes: Optional[str] = None


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
