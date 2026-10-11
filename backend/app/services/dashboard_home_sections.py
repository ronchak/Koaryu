"""Pure builders for the Home payload: facts, attention items, promotions, preferences.

Nothing here performs I/O. ``dashboard_home_service`` loads the inputs and
applies role shaping; these functions turn provider data into response models
exactly once.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any, Mapping, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas.belt import EligibilityEntry
from app.schemas.dashboard_home import (
    DASHBOARD_HOME_ATTENTION_LIMIT,
    DASHBOARD_HOME_CLASS_ROW_LIMIT,
    DASHBOARD_HOME_FOLLOW_UP_LIMIT,
    DASHBOARD_HOME_PREFERENCES_VERSION,
    DASHBOARD_HOME_PROMOTION_LIMIT,
    DashboardHomeActiveStudents,
    DashboardHomeAttendance,
    DashboardHomeAttentionItem,
    DashboardHomeAwayItem,
    DashboardHomeBelt,
    DashboardHomeClassesToday,
    DashboardHomeClassRow,
    DashboardHomeContactItem,
    DashboardHomeFollowUpRow,
    DashboardHomeFollowUps,
    DashboardHomeFollowUpStats,
    DashboardHomeNeedsAttention,
    DashboardHomePanelId,
    DashboardHomePanelSize,
    DashboardHomePaymentsItem,
    DashboardHomePreferences,
    DashboardHomePromotionRow,
    DashboardHomePromotionStats,
    DashboardHomeReadyToPromote,
    DashboardHomeRecentStudent,
    DashboardHomeSetupItem,
    DashboardHomeSetupStep,
    DashboardHomeStudio,
)
from app.services.dashboard_summary_cache import DashboardSummaryCacheKey

# The accepted facts RPC only answers this formula version (V53, pinned by V57).
DASHBOARD_FACTS_RPC_NAME = "dashboard_summary_facts"
DASHBOARD_FACTS_RPC_FORMULA_VERSION = "dashboard-summary-v1"

PAYMENTS_ROLES = frozenset({"admin", "front_desk"})
SETUP_ROLES = frozenset({"admin"})
AWAY_ROLES = frozenset({"admin", "front_desk", "instructor"})
CONTACT_ROLES = frozenset({"admin", "front_desk"})

_FORBIDDEN_IDENTITY_FIELDS = frozenset(
    {"auth", "access_token", "authorization", "bearer_token", "generated_at", "user", "user_id"}
)


class DashboardHomeFactMismatch(ValueError):
    """The provider returned facts for a different request contract."""


# ---- Accepted RPC shape (only the facts Home reads) ----


class _RpcModel(BaseModel):
    model_config = ConfigDict(extra="ignore")


class _RpcStudio(_RpcModel):
    id: str
    name: str
    timezone: str


class _RpcStudents(_RpcModel):
    total_students: int = Field(ge=0)
    active_students: int = Field(ge=0)
    trialing_students: int = Field(ge=0)
    on_hold_students: int = Field(ge=0)


class _RpcOperational(_RpcModel):
    attendance_with_capacity: int = Field(ge=0)
    total_capacity: int = Field(ge=0)
    sessions_tracked: int = Field(ge=0)


class _RpcSchedule(_RpcModel):
    today_sessions: int = Field(ge=0)


class _RpcTodaySession(_RpcModel):
    id: str
    name: str
    start_time: str
    end_time: str
    capacity: Optional[int] = None
    attendance_count: int = Field(ge=0)


class _RpcTodaySchedule(_RpcModel):
    available: bool
    rows: list[_RpcTodaySession] = Field(max_length=DASHBOARD_HOME_CLASS_ROW_LIMIT)
    overflow_count: Optional[int] = Field(default=None, ge=0)


class _RpcInactivity(_RpcModel):
    watch_14: int = Field(ge=0)


class _RpcEmergencyContacts(_RpcModel):
    available: bool
    students_missing_contact_name: int = Field(ge=0)


class _RpcBilling(_RpcModel):
    can_view_billing: bool
    payment_attention_count: Optional[int] = Field(default=None, ge=0)


class _RpcSetup(_RpcModel):
    has_programs: bool
    has_students: bool
    has_belt_system: bool
    has_weekly_classes: bool
    has_tuition_plans: Optional[bool] = None


class _RpcRecentStudent(_RpcModel):
    id: str
    display_name: str
    status: str
    started_on: Optional[str] = None


class _RpcFacts(_RpcModel):
    studio: _RpcStudio
    today: str
    students: _RpcStudents
    operational: _RpcOperational
    schedule: _RpcSchedule
    today_schedule: _RpcTodaySchedule
    inactivity: _RpcInactivity
    emergency_contacts: _RpcEmergencyContacts
    billing: _RpcBilling
    setup: _RpcSetup
    recent_students: list[_RpcRecentStudent]


# ---- Cached values ----


@dataclass(frozen=True, slots=True)
class DashboardHomeFacts:
    """Role-independent Home facts for one cache key; never holds identity."""

    studio: DashboardHomeStudio
    active_students: DashboardHomeActiveStudents
    attendance: DashboardHomeAttendance
    # None when the RPC reports today's agenda unavailable (unmaterialized
    # recurrences or an invalid live row). Never read as "no classes".
    classes_today: Optional[DashboardHomeClassesToday]
    recent_students: tuple[DashboardHomeRecentStudent, ...]
    payment_attention_count: Optional[int]
    incomplete_setup_steps: tuple[DashboardHomeSetupStep, ...]
    away_count: int
    missing_contact_count: Optional[int]
    # Set on facts re-read after Home materialized today, so a still-unavailable
    # agenda is not materialized again until this cache entry expires.
    materialization_attempted: bool = False


@dataclass(frozen=True, slots=True)
class DashboardHomePromotions:
    stats: DashboardHomePromotionStats
    ready_to_promote: DashboardHomeReadyToPromote


EMPTY_DASHBOARD_HOME_PROMOTIONS = DashboardHomePromotions(
    stats=DashboardHomePromotionStats(ready_count=0, needs_approval=0),
    ready_to_promote=DashboardHomeReadyToPromote(rows=[]),
)


# ---- Facts ----


def _check_accepted_contract(facts: Mapping[str, Any], key: DashboardSummaryCacheKey) -> None:
    """Identity, request-match and billing-leak checks, copied from the summary adapter."""

    if _FORBIDDEN_IDENTITY_FIELDS.intersection(facts):
        raise DashboardHomeFactMismatch("dashboard facts contain identity data")
    if facts.get("formula_version") != DASHBOARD_FACTS_RPC_FORMULA_VERSION:
        raise DashboardHomeFactMismatch("dashboard fact formula version mismatch")
    if facts.get("timezone") != key.timezone:
        raise DashboardHomeFactMismatch("dashboard fact timezone mismatch")
    if facts.get("today") != key.local_date.isoformat():
        raise DashboardHomeFactMismatch("dashboard fact local date mismatch")

    studio = facts.get("studio")
    if not isinstance(studio, dict):
        raise DashboardHomeFactMismatch("dashboard fact studio is invalid")
    if studio.get("id") != key.studio_id:
        raise DashboardHomeFactMismatch("dashboard fact studio mismatch")
    if studio.get("timezone") != key.timezone:
        raise DashboardHomeFactMismatch("dashboard fact studio timezone mismatch")

    billing = facts.get("billing")
    if not isinstance(billing, dict):
        raise DashboardHomeFactMismatch("dashboard fact billing is invalid")
    if key.visibility == "billing_visible":
        count = billing.get("payment_attention_count")
        if billing.get("can_view_billing") is not True:
            raise DashboardHomeFactMismatch("visible dashboard fact is not billing-visible")
        if not isinstance(count, int) or isinstance(count, bool):
            raise DashboardHomeFactMismatch("visible dashboard billing count is invalid")
        if not isinstance(billing.get("has_plans"), bool):
            raise DashboardHomeFactMismatch("visible dashboard billing plan flag is invalid")
        if not isinstance(billing.get("payments_ready"), bool):
            raise DashboardHomeFactMismatch("visible dashboard payment flag is invalid")
        amounts = billing.get("amounts")
        if not isinstance(amounts, dict) or amounts.get("available") is not False:
            raise DashboardHomeFactMismatch("visible dashboard billing amounts are invalid")
    else:
        if billing.get("can_view_billing") is not False:
            raise DashboardHomeFactMismatch("hidden dashboard fact exposes billing")
        if (
            any(
                billing.get(field) is not None
                for field in ("payment_attention_count", "has_plans", "payments_ready")
            )
            or "amounts" in billing
        ):
            raise DashboardHomeFactMismatch("hidden dashboard fact contains billing data")


def _incomplete_setup_steps(
    setup: _RpcSetup, *, billing_visible: bool
) -> tuple[DashboardHomeSetupStep, ...]:
    # Same steps and completion rules as the current dashboard checklist; tuition
    # counts only for billing-visible roles and is complete only when plans exist.
    steps: list[tuple[DashboardHomeSetupStep, bool]] = [
        ("programs", setup.has_programs),
        ("students", setup.has_students),
        ("belts", setup.has_belt_system),
        ("classes", setup.has_weekly_classes),
    ]
    if billing_visible:
        steps.append(("billing", setup.has_tuition_plans is True))
    return tuple(step for step, complete in steps if not complete)


def _classes_today(parsed: _RpcFacts) -> Optional[DashboardHomeClassesToday]:
    agenda = parsed.today_schedule
    if not agenda.available:
        return None
    if agenda.overflow_count is None:
        raise DashboardHomeFactMismatch("available dashboard agenda has no overflow count")
    return DashboardHomeClassesToday(
        total=parsed.schedule.today_sessions,
        overflow=agenda.overflow_count,
        rows=[
            DashboardHomeClassRow(
                id=row.id,
                name=row.name,
                start_time=row.start_time,
                end_time=row.end_time,
                checked_in=row.attendance_count,
                capacity=row.capacity,
            )
            for row in agenda.rows
        ],
    )


def validate_dashboard_home_facts(
    facts: Mapping[str, Any],
    key: DashboardSummaryCacheKey,
    *,
    materialization_attempted: bool = False,
) -> DashboardHomeFacts:
    """Validate one accepted RPC payload once and build its response pieces."""

    _check_accepted_contract(facts, key)
    try:
        parsed = _RpcFacts.model_validate(facts)
        billing_visible = key.visibility == "billing_visible"
        return DashboardHomeFacts(
            studio=DashboardHomeStudio(
                id=parsed.studio.id,
                name=parsed.studio.name,
                timezone=parsed.studio.timezone,
                today=parsed.today,
            ),
            active_students=DashboardHomeActiveStudents(
                total=parsed.students.total_students,
                active=parsed.students.active_students,
                trialing=parsed.students.trialing_students,
                on_hold=parsed.students.on_hold_students,
            ),
            attendance=DashboardHomeAttendance(
                sessions=parsed.operational.sessions_tracked,
                seats_filled=parsed.operational.attendance_with_capacity,
                capacity=parsed.operational.total_capacity,
            ),
            classes_today=_classes_today(parsed),
            recent_students=tuple(
                DashboardHomeRecentStudent(
                    id=row.id,
                    name=row.display_name,
                    status=row.status,
                    started_on=row.started_on,
                )
                for row in parsed.recent_students
            ),
            payment_attention_count=(
                parsed.billing.payment_attention_count if billing_visible else None
            ),
            incomplete_setup_steps=_incomplete_setup_steps(
                parsed.setup, billing_visible=billing_visible
            ),
            away_count=parsed.inactivity.watch_14,
            missing_contact_count=(
                parsed.emergency_contacts.students_missing_contact_name
                if parsed.emergency_contacts.available
                else None
            ),
            materialization_attempted=materialization_attempted,
        )
    except ValidationError as exc:
        raise DashboardHomeFactMismatch("dashboard fact response shape is invalid") from exc


# ---- Needs attention ----


def build_needs_attention(
    facts: DashboardHomeFacts,
    role: Optional[str],
    *,
    contact_student_id: Optional[str] = None,
) -> DashboardHomeNeedsAttention:
    """Fixed severity order: payments, setup, away, contact. Zero counts are omitted."""

    items: list[DashboardHomeAttentionItem] = []
    if role in PAYMENTS_ROLES and facts.payment_attention_count:
        items.append(DashboardHomePaymentsItem(count=facts.payment_attention_count))
    if role in SETUP_ROLES and facts.incomplete_setup_steps:
        items.append(
            DashboardHomeSetupItem(
                count=len(facts.incomplete_setup_steps),
                next_step=facts.incomplete_setup_steps[0],
            )
        )
    if role in AWAY_ROLES and facts.away_count:
        items.append(DashboardHomeAwayItem(count=facts.away_count))
    if role in CONTACT_ROLES and facts.missing_contact_count:
        items.append(
            DashboardHomeContactItem(
                count=facts.missing_contact_count,
                student_id=contact_student_id if facts.missing_contact_count == 1 else None,
            )
        )
    return DashboardHomeNeedsAttention(items=items[:DASHBOARD_HOME_ATTENTION_LIMIT])


# ---- Follow-ups ----


def _overdue_rows(rows: Sequence[DashboardHomeFollowUpRow], today: str) -> int:
    return sum(1 for row in rows if row.follow_up_date < today)


def overdue_count_from_rows(
    rows: Sequence[DashboardHomeFollowUpRow], due_count: int, today: str
) -> Optional[int]:
    """The overdue count when the due rows alone settle it, else ``None``.

    Rows are oldest first and share one snapshot with ``due_count``. When every
    due lead was returned, or the last returned row is due today, every overdue
    lead is among the rows.
    """

    if due_count <= DASHBOARD_HOME_FOLLOW_UP_LIMIT or (rows and rows[-1].follow_up_date == today):
        return _overdue_rows(rows, today)
    return None


def is_consistent_overdue_count(
    rows: Sequence[DashboardHomeFollowUpRow], due_count: int, today: str, overdue_count: int
) -> bool:
    """A separately counted overdue total cannot undercount the rows or exceed due."""

    return _overdue_rows(rows, today) <= overdue_count <= due_count


def build_follow_ups(
    rows: Sequence[DashboardHomeFollowUpRow], due_count: int, overdue_count: int
) -> tuple[DashboardHomeFollowUpStats, DashboardHomeFollowUps]:
    return (
        DashboardHomeFollowUpStats(
            due_count=due_count,
            overdue_count=overdue_count,
            due_today_count=due_count - overdue_count,
            oldest_due_date=rows[0].follow_up_date if rows else None,
        ),
        DashboardHomeFollowUps(rows=list(rows)),
    )


# ---- Promotions ----


def is_ready_to_promote(entry: EligibilityEntry) -> bool:
    """Belt Tracker readiness: classes and time met, whether or not approval is needed."""

    return entry.classes_met and entry.time_met


def _progress(entry: EligibilityEntry) -> float:
    classes = entry.classes_since_promo / entry.classes_required if entry.classes_required else 1
    days = entry.days_at_rank / entry.days_required if entry.days_required else 1
    return classes + days


def _name_key(value: str) -> tuple[str, str]:
    # Approximates JavaScript localeCompare: case-insensitive first, then exact.
    return value.casefold(), value


def order_like_belt_tracker(
    entries: Sequence[EligibilityEntry],
    ladder_rank_ids: Sequence[str],
) -> list[EligibilityEntry]:
    """The Belt Tracker's ready list order (``buildEligibilityGroups``).

    Groups by current rank: unranked first, then ladder rank order, then label.
    Inside a group: progress descending, then student name.
    """

    rank_order = {rank_id: index for index, rank_id in enumerate(ladder_rank_ids)}
    groups: dict[str, list[EligibilityEntry]] = {}
    group_sort: dict[str, tuple[int, tuple[str, str]]] = {}
    for entry in entries:
        group_key = entry.current_rank_id if entry.current_rank_id is not None else "unranked"
        if group_key not in groups:
            sort_index = (
                rank_order.get(entry.current_rank_id, sys.maxsize) if entry.current_rank_id else -1
            )
            label = entry.current_rank_name if entry.current_rank_name is not None else "Unranked"
            groups[group_key] = []
            group_sort[group_key] = (sort_index, _name_key(label))
        groups[group_key].append(entry)

    ordered: list[EligibilityEntry] = []
    for group_key in sorted(groups, key=lambda key: group_sort[key]):
        ordered.extend(
            sorted(
                groups[group_key],
                key=lambda entry: (-_progress(entry), _name_key(entry.student_name)),
            )
        )
    return ordered


def _promotion_row(entry: EligibilityEntry) -> DashboardHomePromotionRow:
    if entry.next_rank_name is None:
        raise ValueError("eligibility entry has no next rank")
    if entry.current_rank_id is not None and entry.current_rank_name is None:
        raise ValueError("eligibility entry has an unnamed current rank")
    return DashboardHomePromotionRow(
        student_id=entry.student_id,
        name=entry.student_name,
        from_=(
            DashboardHomeBelt(name=entry.current_rank_name, color=entry.current_rank_color)
            if entry.current_rank_id is not None
            else None
        ),
        to=DashboardHomeBelt(name=entry.next_rank_name, color=entry.next_rank_color),
        classes_at_rank=entry.classes_since_promo,
        needs_approval=entry.needs_approval,
    )


def build_promotions(
    entries: Sequence[EligibilityEntry],
    ladder_rank_ids: Sequence[str],
) -> DashboardHomePromotions:
    """Count every ready entry on the primary ladder and keep the first six rows."""

    ready = [entry for entry in entries if is_ready_to_promote(entry)]
    ordered = order_like_belt_tracker(ready, ladder_rank_ids)
    return DashboardHomePromotions(
        stats=DashboardHomePromotionStats(
            ready_count=len(ready),
            needs_approval=sum(1 for entry in ready if entry.needs_approval),
        ),
        ready_to_promote=DashboardHomeReadyToPromote(
            rows=[_promotion_row(entry) for entry in ordered[:DASHBOARD_HOME_PROMOTION_LIMIT]]
        ),
    )


# ---- Preferences ----

# Default panel order. Appended panels take this order; recent_students starts hidden.
HOME_PANEL_DEFAULT_ORDER: tuple[DashboardHomePanelId, ...] = (
    "follow_ups",
    "ready_to_promote",
    "recent_students",
)
HOME_PANEL_DEFAULT_HIDDEN: frozenset[DashboardHomePanelId] = frozenset({"recent_students"})
# The roles that receive each panel's section from GET /dashboard/home.
HOME_PANEL_ROLES: Mapping[DashboardHomePanelId, frozenset[str]] = {
    "follow_ups": frozenset({"admin", "front_desk"}),
    "ready_to_promote": frozenset({"admin", "instructor"}),
    "recent_students": frozenset({"admin", "front_desk", "instructor"}),
}
# The sizes each panel declares. None do in version one, so every size is dropped.
HOME_PANEL_SIZES: Mapping[DashboardHomePanelId, frozenset[DashboardHomePanelSize]] = {}


def entitled_home_panels(role: Optional[str]) -> tuple[DashboardHomePanelId, ...]:
    """The optional panels this role may see, in default order."""

    return tuple(panel for panel in HOME_PANEL_DEFAULT_ORDER if role in HOME_PANEL_ROLES[panel])


def default_home_preferences(role: Optional[str]) -> DashboardHomePreferences:
    order = list(entitled_home_panels(role))
    return DashboardHomePreferences(
        version=DASHBOARD_HOME_PREFERENCES_VERSION,
        order=order,
        hidden=[panel for panel in order if panel in HOME_PANEL_DEFAULT_HIDDEN],
        size={},
    )


def reconcile_home_preferences(
    stored: Any, role: Optional[str]
) -> Optional[DashboardHomePreferences]:
    """Fit stored or submitted preferences to what this role may see now.

    Unknown, repeated and non-entitled ids are dropped; entitled ids missing
    from ``order`` are appended in default order, hidden when ``hidden``
    already lists them or their default is hidden; ``hidden`` becomes the
    subset of ``order`` that is off, in ``order``'s order; ``size`` keeps only
    sizes a panel declares. Returns ``None`` when the value is not a version-1
    preferences object, so the caller can treat it as never saved.
    """

    if not isinstance(stored, Mapping):
        return None
    version = stored.get("version")
    if type(version) is not int or version != DASHBOARD_HOME_PREFERENCES_VERSION:
        return None
    stored_order = stored.get("order")
    stored_hidden = stored.get("hidden", ())
    stored_size = stored.get("size", {})
    if (
        not isinstance(stored_order, (list, tuple))
        or not isinstance(stored_hidden, (list, tuple))
        or not isinstance(stored_size, Mapping)
    ):
        return None

    entitled = entitled_home_panels(role)
    order: list[DashboardHomePanelId] = []
    for panel in stored_order:
        if isinstance(panel, str) and panel in entitled and panel not in order:
            order.append(panel)
    appended = [panel for panel in entitled if panel not in order]
    order.extend(appended)

    off = {panel for panel in stored_hidden if isinstance(panel, str)}
    off.update(panel for panel in appended if panel in HOME_PANEL_DEFAULT_HIDDEN)
    size: dict[DashboardHomePanelId, DashboardHomePanelSize] = {}
    for panel in order:
        value = stored_size.get(panel)
        if isinstance(value, str) and value in HOME_PANEL_SIZES.get(panel, frozenset()):
            size[panel] = value
    return DashboardHomePreferences(
        version=DASHBOARD_HOME_PREFERENCES_VERSION,
        order=order,
        hidden=[panel for panel in order if panel in off],
        size=size,
    )
