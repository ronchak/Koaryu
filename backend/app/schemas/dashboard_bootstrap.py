from pydantic import BaseModel, Field
from typing import Optional

from app.schemas.auth import AuthResponse
from app.schemas.belt import BeltLadderResponse
from app.schemas.dashboard_summary import DashboardSummaryResponse
from app.schemas.lead import LeadResponse
from app.schemas.program import ProgramResponse
from app.schemas.student import StudentResponse


class DashboardBootstrapStudioSummary(BaseModel):
    id: str
    name: str
    slug: str
    timezone: str
    logo_url: Optional[str] = None


class DashboardBootstrapResponse(BaseModel):
    auth: AuthResponse
    studio: Optional[DashboardBootstrapStudioSummary] = None
    studio_name: Optional[str] = None
    students: list[StudentResponse] = Field(default_factory=list)
    students_total: int = 0
    students_page_size: int = 200
    students_may_be_partial: bool = False
    programs: list[ProgramResponse] = Field(default_factory=list)
    leads: list[LeadResponse] = Field(default_factory=list)
    belt_ladders: list[BeltLadderResponse] = Field(default_factory=list)
    primary_belt_ladder: Optional[BeltLadderResponse] = None
    summary: Optional[DashboardSummaryResponse] = None
