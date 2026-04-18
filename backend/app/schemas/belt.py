from pydantic import BaseModel
from typing import Optional


# ---- Belt Ladder ----

class BeltLadderCreate(BaseModel):
    name: str
    program_id: Optional[str] = None


class BeltLadderResponse(BaseModel):
    id: str
    studio_id: str
    name: str
    program_id: Optional[str] = None
    created_at: str
    updated_at: str
    ranks: list["BeltRankResponse"] = []


# ---- Belt Rank ----

class BeltRankCreate(BaseModel):
    name: str
    color_hex: str = "#FFFFFF"
    display_order: int = 0
    min_classes: int = 0
    min_months: int = 0
    requires_approval: bool = False


class BeltRankUpdate(BaseModel):
    name: Optional[str] = None
    color_hex: Optional[str] = None
    display_order: Optional[int] = None
    min_classes: Optional[int] = None
    min_months: Optional[int] = None
    requires_approval: Optional[bool] = None


class BeltRankResponse(BaseModel):
    id: str
    ladder_id: str
    studio_id: str
    name: str
    color_hex: str
    display_order: int
    min_classes: int
    min_months: int
    requires_approval: bool
    created_at: str


# ---- Promotion ----

class PromoteStudent(BaseModel):
    student_id: str
    to_rank_id: str
    notes: Optional[str] = None


class PromotionResponse(BaseModel):
    id: str
    studio_id: str
    student_id: str
    from_rank_id: Optional[str] = None
    to_rank_id: str
    promoted_by: str
    notes: Optional[str] = None
    promoted_at: str
    # Joined names for display
    student_name: Optional[str] = None
    from_rank_name: Optional[str] = None
    to_rank_name: Optional[str] = None


# ---- Eligibility ----

class EligibilityEntry(BaseModel):
    student_id: str
    student_name: str
    current_rank_name: Optional[str] = None
    current_rank_color: Optional[str] = None
    next_rank_name: Optional[str] = None
    next_rank_color: Optional[str] = None
    classes_since_promo: int = 0
    classes_required: int = 0
    days_at_rank: int = 0
    days_required: int = 0
    classes_met: bool = False
    time_met: bool = False
    needs_approval: bool = False
    is_eligible: bool = False
