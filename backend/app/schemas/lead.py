from pydantic import BaseModel
from typing import Literal, Optional


# ---- Lead ----

LeadSource = Literal["walk_in", "referral", "social", "search", "website", "other"]
LeadStage = Literal["inquiry", "trial_scheduled", "trial_completed", "offer_sent", "enrolled", "closed_lost"]
LeadMutationStage = Literal["inquiry", "trial_scheduled", "trial_completed", "offer_sent", "closed_lost"]
LostReason = Literal["no_show", "price_objection", "timing", "no_response", "other"]
LeadConvertStudentStatus = Literal["active", "trialing", "inactive", "paused", "canceled"]


class LeadCreate(BaseModel):
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    source: LeadSource = "walk_in"
    stage: LeadMutationStage = "inquiry"
    program_interest: Optional[str] = None
    program_id: Optional[str] = None
    is_minor: bool = False
    guardian_name: Optional[str] = None
    guardian_email: Optional[str] = None
    guardian_phone: Optional[str] = None
    assigned_staff_id: Optional[str] = None
    follow_up_date: Optional[str] = None
    notes: Optional[str] = None


class LeadUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    source: Optional[LeadSource] = None
    stage: Optional[LeadMutationStage] = None
    program_interest: Optional[str] = None
    program_id: Optional[str] = None
    is_minor: Optional[bool] = None
    guardian_name: Optional[str] = None
    guardian_email: Optional[str] = None
    guardian_phone: Optional[str] = None
    assigned_staff_id: Optional[str] = None
    follow_up_date: Optional[str] = None
    notes: Optional[str] = None
    lost_reason: Optional[LostReason] = None


class LeadResponse(BaseModel):
    id: str
    studio_id: str
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    source: LeadSource
    stage: LeadStage
    program_interest: Optional[str] = None
    program_id: Optional[str] = None
    is_minor: bool
    guardian_name: Optional[str] = None
    guardian_email: Optional[str] = None
    guardian_phone: Optional[str] = None
    assigned_staff_id: Optional[str] = None
    follow_up_date: Optional[str] = None
    lost_reason: Optional[LostReason] = None
    notes: Optional[str] = None
    converted_student_id: Optional[str] = None
    created_at: str
    updated_at: str


# ---- Lead Activity ----

class LeadActivityCreate(BaseModel):
    activity_type: str  # note, stage_change, email, call, meeting, follow_up
    description: Optional[str] = None


class LeadActivityResponse(BaseModel):
    id: str
    studio_id: str
    lead_id: str
    activity_type: str
    description: Optional[str] = None
    created_by: Optional[str] = None
    created_at: str


# ---- Conversion ----

class LeadConvert(BaseModel):
    status: LeadConvertStudentStatus = "active"
    membership_start_date: Optional[str] = None
    program_id: Optional[str] = None
