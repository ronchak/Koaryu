"""Response contract for ``GET /dashboard/home``.

Role shaping is by absence: a section or field the viewer may not see, or that
the server could not compute, is omitted from the JSON rather than flagged.
Each model lists those fields in ``_absent_when_none``; every other ``None``
(``viewer.role``, a row's ``from``, a class's ``capacity``) is sent as null.
"""

from datetime import datetime
from typing import Annotated, Any, ClassVar, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_serializer

from app.schemas.staff import StaffRoleName

DashboardHomeSetupStep = Literal["programs", "students", "belts", "classes", "billing"]
DashboardHomeLeadStage = Literal["inquiry", "trial_scheduled", "trial_completed", "offer_sent"]

DASHBOARD_HOME_ATTENTION_LIMIT = 6
DASHBOARD_HOME_CLASS_ROW_LIMIT = 5
DASHBOARD_HOME_FOLLOW_UP_LIMIT = 6
DASHBOARD_HOME_PROMOTION_LIMIT = 6
DASHBOARD_HOME_ATTENDANCE_WINDOW_DAYS = 30


class DashboardHomeModel(BaseModel):
    """Omit the listed fields from the wire when they are ``None``."""

    _absent_when_none: ClassVar[tuple[str, ...]] = ()

    @model_serializer(mode="wrap")
    def _omit_absent_fields(self, handler: Any):
        # No return annotation: one would replace the fields in response OpenAPI.
        data = handler(self)
        for name in self._absent_when_none:
            if getattr(self, name) is None:
                data.pop(name, None)
        return data


class DashboardHomeViewer(DashboardHomeModel):
    role: Optional[StaffRoleName] = None


class DashboardHomeStudio(DashboardHomeModel):
    id: str
    name: str
    timezone: str
    today: str = Field(description="Studio-local business date, YYYY-MM-DD.")


class DashboardHomePaymentsItem(DashboardHomeModel):
    kind: Literal["payments"] = "payments"
    count: int = Field(ge=1)


class DashboardHomeSetupItem(DashboardHomeModel):
    kind: Literal["setup"] = "setup"
    count: int = Field(ge=1)
    next_step: DashboardHomeSetupStep


class DashboardHomeAwayItem(DashboardHomeModel):
    kind: Literal["away"] = "away"
    count: int = Field(ge=1)


class DashboardHomeContactItem(DashboardHomeModel):
    _absent_when_none = ("student_id",)

    kind: Literal["contact"] = "contact"
    count: int = Field(ge=1)
    student_id: Optional[str] = Field(
        default=None, description="Present only when exactly one student is missing a contact."
    )


DashboardHomeAttentionItem = Annotated[
    Union[
        DashboardHomePaymentsItem,
        DashboardHomeSetupItem,
        DashboardHomeAwayItem,
        DashboardHomeContactItem,
    ],
    Field(discriminator="kind"),
]


class DashboardHomeNeedsAttention(DashboardHomeModel):
    items: list[DashboardHomeAttentionItem] = Field(
        default_factory=list, max_length=DASHBOARD_HOME_ATTENTION_LIMIT
    )


class DashboardHomeClassRow(DashboardHomeModel):
    id: str
    name: str
    start_time: str = Field(description="Studio-local wall-clock start, as stored.")
    end_time: str = Field(description="Studio-local wall-clock end, as stored.")
    checked_in: int = Field(ge=0)
    capacity: Optional[int] = None


class DashboardHomeClassesToday(DashboardHomeModel):
    total: int = Field(ge=0)
    overflow: int = Field(ge=0)
    rows: list[DashboardHomeClassRow] = Field(
        default_factory=list, max_length=DASHBOARD_HOME_CLASS_ROW_LIMIT
    )


class DashboardHomeActiveStudents(DashboardHomeModel):
    total: int = Field(ge=0)
    active: int = Field(ge=0, description="Active plus trialing students.")
    trialing: int = Field(ge=0)
    on_hold: int = Field(ge=0)


class DashboardHomeAttendance(DashboardHomeModel):
    window_days: int = DASHBOARD_HOME_ATTENDANCE_WINDOW_DAYS
    sessions: int = Field(ge=0)
    seats_filled: int = Field(ge=0)
    capacity: int = Field(ge=0)


class DashboardHomeFollowUpStats(DashboardHomeModel):
    due_count: int = Field(ge=0)
    overdue_count: int = Field(ge=0)
    due_today_count: int = Field(ge=0)
    oldest_due_date: Optional[str] = None


class DashboardHomePromotionStats(DashboardHomeModel):
    ready_count: int = Field(ge=0)
    needs_approval: int = Field(ge=0)


class DashboardHomeStats(DashboardHomeModel):
    _absent_when_none = ("follow_ups", "promotions")

    active_students: DashboardHomeActiveStudents
    attendance: DashboardHomeAttendance
    follow_ups: Optional[DashboardHomeFollowUpStats] = None
    promotions: Optional[DashboardHomePromotionStats] = None


class DashboardHomeFollowUpRow(DashboardHomeModel):
    id: str
    first_name: str
    last_name: str
    stage: DashboardHomeLeadStage
    follow_up_date: str


class DashboardHomeFollowUps(DashboardHomeModel):
    rows: list[DashboardHomeFollowUpRow] = Field(
        default_factory=list, max_length=DASHBOARD_HOME_FOLLOW_UP_LIMIT
    )


class DashboardHomeBelt(DashboardHomeModel):
    name: str
    color: Optional[str] = None


class DashboardHomePromotionRow(DashboardHomeModel):
    model_config = ConfigDict(populate_by_name=True)

    student_id: str
    name: str
    from_: Optional[DashboardHomeBelt] = Field(alias="from")
    to: DashboardHomeBelt
    classes_at_rank: int = Field(ge=0)
    needs_approval: bool


class DashboardHomeReadyToPromote(DashboardHomeModel):
    rows: list[DashboardHomePromotionRow] = Field(
        default_factory=list, max_length=DASHBOARD_HOME_PROMOTION_LIMIT
    )


class DashboardHomeRecentStudent(DashboardHomeModel):
    id: str
    name: str
    status: str
    started_on: Optional[str] = None


class DashboardHomeResponse(DashboardHomeModel):
    _absent_when_none = (
        "studio",
        "needs_attention",
        "classes_today",
        "stats",
        "follow_ups",
        "ready_to_promote",
        "recent_students",
    )

    generated_at: datetime
    viewer: DashboardHomeViewer
    studio: Optional[DashboardHomeStudio] = None
    needs_attention: Optional[DashboardHomeNeedsAttention] = None
    classes_today: Optional[DashboardHomeClassesToday] = None
    stats: Optional[DashboardHomeStats] = None
    follow_ups: Optional[DashboardHomeFollowUps] = None
    ready_to_promote: Optional[DashboardHomeReadyToPromote] = None
    recent_students: Optional[list[DashboardHomeRecentStudent]] = None
