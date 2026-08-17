from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_serializer

from app.schemas.auth import AuthResponse


class DashboardSummaryStudio(BaseModel):
    id: str
    name: str
    timezone: str


class DashboardSummaryStudentCounts(BaseModel):
    total_students: int = 0
    active_students: int = 0
    trialing_students: int = 0
    on_hold_students: int = 0


class DashboardSummaryLeadCounts(BaseModel):
    active_leads: int = 0
    enrolled_leads: int = 0
    due_today_leads: int = 0


class DashboardSummaryScheduleCounts(BaseModel):
    today_sessions: int = 0


class DashboardSummaryTodaySession(BaseModel):
    id: str
    start_time: str
    end_time: str
    name: str
    capacity: Optional[int] = None
    attendance_count: int = Field(default=0, ge=0)
    expected_count: Optional[int] = Field(default=None, ge=0)

    @model_serializer(mode="wrap")
    def _omit_unavailable_expected_count(self, handler: Any):
        data = handler(self)
        if self.expected_count is None:
            data.pop("expected_count", None)
        return data


class DashboardSummaryTodaySchedule(BaseModel):
    available: bool = False
    expected_counts_available: bool = False
    rows: list[DashboardSummaryTodaySession] = Field(default_factory=list, max_length=5)
    overflow_count: Optional[int] = Field(default=None, ge=0)

    @model_serializer(mode="wrap")
    def _omit_unavailable_overflow_count(self, handler: Any):
        data = handler(self)
        if self.overflow_count is None:
            data.pop("overflow_count", None)
        return data


class DashboardSummaryBeltCounts(BaseModel):
    belt_count: int = 0
    tip_count: int = 0


class DashboardSummaryInactivityCounts(BaseModel):
    watch_14: int = 0
    watch_30: int = 0
    watch_90: int = 0


class DashboardSummaryNewStudentCounts(BaseModel):
    new_14: int = 0
    new_30: int = 0
    new_90: int = 0
    new_year_to_date: int = 0


class DashboardSummaryOperationalCounts(BaseModel):
    attendance_with_capacity: int = 0
    total_capacity: int = 0
    sessions_tracked: int = 0
    sessions_with_capacity: int = 0
    utilization_rate: Optional[float] = None
    average_attendance: float = 0


class DashboardSummaryChurnCounts(BaseModel):
    inactive_students: int = 0
    canceled_students: int = 0
    churn_marked_students: int = 0
    churn_rate: Optional[float] = None


class DashboardSummaryTestReadinessCounts(BaseModel):
    ready_to_test: Optional[int] = None
    needs_approval: Optional[int] = None
    available: bool = False


class DashboardSummaryBillingAmounts(BaseModel):
    available: bool = False
    payment_attention_amount_cents: Optional[int] = None
    due_this_week_amount_cents: Optional[int] = None

    @model_serializer(mode="wrap")
    def _omit_unavailable_amount_values(self, handler: Any):
        data = handler(self)
        if self.payment_attention_amount_cents is None:
            data.pop("payment_attention_amount_cents", None)
        if self.due_this_week_amount_cents is None:
            data.pop("due_this_week_amount_cents", None)
        return data


class DashboardSummaryBillingCounts(BaseModel):
    can_view_billing: bool = False
    payment_attention_count: Optional[int] = None
    has_plans: Optional[bool] = None
    payments_ready: Optional[bool] = None
    amounts: Optional[DashboardSummaryBillingAmounts] = None

    @model_serializer(mode="wrap")
    def _omit_unauthorized_amounts(self, handler: Any):
        data = handler(self)
        if self.amounts is None:
            data.pop("amounts", None)
        return data


class DashboardSummaryEmergencyContacts(BaseModel):
    available: bool = False
    active_students: int = Field(default=0, ge=0)
    students_with_contact_name: int = Field(default=0, ge=0)
    students_missing_contact_name: int = Field(default=0, ge=0)


class DashboardSummarySetupFlags(BaseModel):
    has_programs: bool = False
    has_students: bool = False
    has_belt_system: bool = False
    has_weekly_classes: bool = False
    has_tuition_plans: Optional[bool] = None


class DashboardSummaryRecentStudent(BaseModel):
    id: str
    display_name: str
    status: str
    started_on: Optional[str] = None


class DashboardSummaryAction(BaseModel):
    id: str
    title: str
    description: str
    href: str
    tone: Literal["accent", "warning", "success", "danger", "neutral"] = "neutral"
    meta: Optional[str] = None


class DashboardSummaryResponse(BaseModel):
    auth: AuthResponse
    studio: Optional[DashboardSummaryStudio] = None
    generated_at: str
    today: Optional[str] = None
    timezone: Optional[str] = None
    today_schedule: Optional[DashboardSummaryTodaySchedule] = None
    emergency_contacts: Optional[DashboardSummaryEmergencyContacts] = None
    students: DashboardSummaryStudentCounts = Field(default_factory=DashboardSummaryStudentCounts)
    leads: DashboardSummaryLeadCounts = Field(default_factory=DashboardSummaryLeadCounts)
    schedule: DashboardSummaryScheduleCounts = Field(default_factory=DashboardSummaryScheduleCounts)
    belts: DashboardSummaryBeltCounts = Field(default_factory=DashboardSummaryBeltCounts)
    inactivity: DashboardSummaryInactivityCounts = Field(default_factory=DashboardSummaryInactivityCounts)
    new_students: DashboardSummaryNewStudentCounts = Field(default_factory=DashboardSummaryNewStudentCounts)
    operational: DashboardSummaryOperationalCounts = Field(default_factory=DashboardSummaryOperationalCounts)
    churn: DashboardSummaryChurnCounts = Field(default_factory=DashboardSummaryChurnCounts)
    test_readiness: DashboardSummaryTestReadinessCounts = Field(default_factory=DashboardSummaryTestReadinessCounts)
    billing: DashboardSummaryBillingCounts = Field(default_factory=DashboardSummaryBillingCounts)
    setup: DashboardSummarySetupFlags = Field(default_factory=DashboardSummarySetupFlags)
    recent_students: list[DashboardSummaryRecentStudent] = Field(default_factory=list)
    actions: list[DashboardSummaryAction] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def _omit_absent_enrichments(self, handler: Any):
        data = handler(self)
        if self.today_schedule is None:
            data.pop("today_schedule", None)
        if self.emergency_contacts is None:
            data.pop("emergency_contacts", None)
        return data
