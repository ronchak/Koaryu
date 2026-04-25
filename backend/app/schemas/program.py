from pydantic import BaseModel, Field
from typing import Optional


class ProgramCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = None
    color_hex: str = "#64748B"
    sort_order: int = 0


class ProgramUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = None
    color_hex: Optional[str] = None
    sort_order: Optional[int] = None


class ProgramUsageResponse(BaseModel):
    student_count: int = 0
    active_student_count: int = 0
    class_count: int = 0
    active_class_count: int = 0
    lead_count: int = 0
    belt_ladder_count: int = 0


class ProgramResponse(BaseModel):
    id: str
    studio_id: str
    name: str
    description: Optional[str] = None
    color_hex: str = "#64748B"
    sort_order: int = 0
    is_system: bool = False
    archived_at: Optional[str] = None
    created_at: str
    updated_at: str
    usage: ProgramUsageResponse = Field(default_factory=ProgramUsageResponse)
