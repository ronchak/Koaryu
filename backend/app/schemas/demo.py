from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.belt import BeltLadderResponse, EligibilityEntry
from app.schemas.lead import LeadActivityResponse, LeadResponse
from app.schemas.program import ProgramResponse
from app.schemas.schedule import (
    AttendanceResponse,
    ClassSessionResponse,
    ClassTemplateResponse,
)
from app.schemas.student import StudentResponse


class DemoResetCounts(BaseModel):
    students: int = 0
    leads: int = 0
    belt_ranks: int = 0
    class_sessions: int = 0
    attendance_records: int = 0


class DemoResetResponse(BaseModel):
    studio_name: str
    programs: list[ProgramResponse] = Field(default_factory=list)
    students: list[StudentResponse] = Field(default_factory=list)
    leads: list[LeadResponse] = Field(default_factory=list)
    lead_activities: list[LeadActivityResponse] = Field(default_factory=list)
    belt_ladders: list[BeltLadderResponse] = Field(default_factory=list)
    primary_belt_ladder: Optional[BeltLadderResponse] = None
    eligibility: list[EligibilityEntry] = Field(default_factory=list)
    templates: list[ClassTemplateResponse] = Field(default_factory=list)
    sessions: list[ClassSessionResponse] = Field(default_factory=list)
    attendance: list[AttendanceResponse] = Field(default_factory=list)
    counts: DemoResetCounts = Field(default_factory=DemoResetCounts)


class StudioDataClearResponse(BaseModel):
    studio_name: str
    counts: DemoResetCounts = Field(default_factory=DemoResetCounts)
