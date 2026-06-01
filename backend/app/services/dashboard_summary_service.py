import asyncio
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from supabase import Client

from app.schemas.auth import AuthResponse
from app.schemas.dashboard_summary import (
    DashboardSummaryInactivityCounts,
    DashboardSummaryOperationalCounts,
    DashboardSummaryResponse,
    DashboardSummaryScheduleCounts,
    DashboardSummaryStudio,
    DashboardSummaryTestReadinessCounts,
)
from app.services.auth_service import AuthService
from app.services.dashboard_summary_attendance import DashboardSummaryAttendanceMetrics
from app.services.dashboard_summary_actions import build_dashboard_summary_actions
from app.services.dashboard_summary_counts import DashboardSummaryCounts
from app.services.dashboard_summary_store import DashboardSummaryStore
from app.services.studio_scope import ensure_platform_subscription_access


PRIVATE_CACHE_CONTROL = "no-store, private"
PRIVATE_VARY = "Authorization, X-Studio-Id"


class DashboardSummaryService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _store(self) -> DashboardSummaryStore:
        return DashboardSummaryStore(self.supabase)

    def _attendance_metrics(self) -> DashboardSummaryAttendanceMetrics:
        return DashboardSummaryAttendanceMetrics(self._store())

    def _counts(self) -> DashboardSummaryCounts:
        return DashboardSummaryCounts(self.supabase, self._store())

    @staticmethod
    def server_timing_value(timings: dict[str, float]) -> str:
        return ", ".join(
            f"koaryu_summary_{label};dur={duration_ms:.1f}"
            for label, duration_ms in timings.items()
        )

    @staticmethod
    def _studio_today(timezone_name: Optional[str]) -> tuple[date, str]:
        normalized_timezone = timezone_name or "UTC"
        try:
            zone = ZoneInfo(normalized_timezone)
        except ZoneInfoNotFoundError:
            normalized_timezone = "UTC"
            zone = timezone.utc
        return datetime.now(zone).date(), normalized_timezone

    def _fetch_studio_summary(self, studio_id: str) -> dict[str, Any]:
        return self._counts().fetch_studio_summary(studio_id)

    def _today_class_count(self, studio_id: str, today: date) -> int:
        return self._attendance_metrics().today_class_count(studio_id, today)

    def _inactivity_counts(
        self,
        studio_id: str,
        student_rows: list[dict[str, Any]],
        today: date,
        lookback_14: date,
        lookback_30: date,
        lookback_90: date,
        timezone_name: str,
    ) -> DashboardSummaryInactivityCounts:
        return self._attendance_metrics().inactivity_counts(
            studio_id,
            student_rows,
            today,
            lookback_14,
            lookback_30,
            lookback_90,
            timezone_name,
        )

    def _operational_counts(
        self,
        studio_id: str,
        lookback_30: date,
        today: date,
    ) -> DashboardSummaryOperationalCounts:
        return self._attendance_metrics().operational_counts(studio_id, lookback_30, today)

    def _test_readiness_counts(self, studio_id: str) -> DashboardSummaryTestReadinessCounts:
        # Full readiness depends on attendance, promotions, and program memberships.
        # The summary endpoint intentionally defers that heavier eligibility engine.
        return DashboardSummaryTestReadinessCounts(available=False)

    def _build_summary_sync(
        self,
        auth: AuthResponse,
        studio_row: dict[str, Any],
        *,
        today_override: Optional[date] = None,
    ) -> tuple[DashboardSummaryResponse, dict[str, float]]:
        total_started = time.perf_counter()
        timings: dict[str, float] = {}

        def timed(label: str, callback: Callable[[], Any]) -> Any:
            started = time.perf_counter()
            result = callback()
            timings[label] = (time.perf_counter() - started) * 1000
            return result

        studio_id = auth.studio_id
        if not studio_id:
            generated_at = datetime.now(timezone.utc).isoformat()
            timings["total"] = (time.perf_counter() - total_started) * 1000
            return DashboardSummaryResponse(auth=auth, generated_at=generated_at), timings

        today, normalized_timezone = (
            (today_override, studio_row.get("timezone") or "UTC")
            if today_override
            else self._studio_today(studio_row.get("timezone"))
        )
        today_text = today.isoformat()
        generated_at = datetime.now(timezone.utc).isoformat()
        lookback_14 = today - timedelta(days=14)
        lookback_30 = today - timedelta(days=30)
        lookback_90 = today - timedelta(days=90)
        year_start = date(today.year, 1, 1)
        counts = self._counts()

        student_rows = timed(
            "student_rows",
            lambda: counts.fetch_rows(
                "students",
                "id, legal_first_name, legal_last_name, preferred_name, status, hold_start_date, hold_end_date, membership_start_date, created_at, program_id, current_belt_rank_id",
                lambda query: query.eq("studio_id", studio_id).is_("deleted_at", "null"),
            ),
        )
        student_counts = timed("student_counts", lambda: counts.student_counts(studio_id, student_rows, today))
        lead_counts = timed("lead_counts", lambda: counts.lead_counts(studio_id, today))
        schedule_counts = timed(
            "schedule_counts",
            lambda: DashboardSummaryScheduleCounts(today_sessions=self._today_class_count(studio_id, today)),
        )
        belt_counts = timed("belt_counts", lambda: counts.belt_counts(studio_id))
        inactivity_counts = timed(
            "inactivity_counts",
            lambda: self._inactivity_counts(
                studio_id,
                student_rows,
                today,
                lookback_14,
                lookback_30,
                lookback_90,
                normalized_timezone,
            ),
        )
        new_student_counts = timed(
            "new_student_counts",
            lambda: counts.new_student_counts(
                student_rows,
                today,
                lookback_14,
                lookback_30,
                lookback_90,
                year_start,
            ),
        )
        operational_counts = timed("operational_counts", lambda: self._operational_counts(studio_id, lookback_30, today))
        churn_counts = timed("churn_counts", lambda: counts.churn_counts(studio_id, student_counts.total_students))
        test_readiness = timed("test_readiness", lambda: self._test_readiness_counts(studio_id))
        billing_counts = timed("billing_counts", lambda: counts.billing_counts(studio_id, auth.role, today))
        setup_flags = timed(
            "setup_flags",
            lambda: counts.setup_flags(studio_id, student_counts, belt_counts, schedule_counts, billing_counts),
        )
        recent_students = timed("recent_students", lambda: counts.recent_students(studio_id))
        actions = build_dashboard_summary_actions(
            lead_counts=lead_counts,
            schedule_counts=schedule_counts,
            belt_counts=belt_counts,
            inactivity_counts=inactivity_counts,
            test_readiness=test_readiness,
            billing_counts=billing_counts,
            today_label=today_text,
        )

        timings["total"] = (time.perf_counter() - total_started) * 1000
        return (
            DashboardSummaryResponse(
                auth=auth,
                studio=DashboardSummaryStudio(
                    id=studio_row["id"],
                    name=studio_row["name"],
                    timezone=normalized_timezone,
                ),
                generated_at=generated_at,
                today=today_text,
                timezone=normalized_timezone,
                students=student_counts,
                leads=lead_counts,
                schedule=schedule_counts,
                belts=belt_counts,
                inactivity=inactivity_counts,
                new_students=new_student_counts,
                operational=operational_counts,
                churn=churn_counts,
                test_readiness=test_readiness,
                billing=billing_counts,
                setup=setup_flags,
                recent_students=recent_students,
                actions=actions,
            ),
            timings,
        )

    async def build_for_authorized_studio(
        self,
        auth: AuthResponse,
        studio_row: dict[str, Any],
    ) -> tuple[DashboardSummaryResponse, dict[str, float]]:
        return await asyncio.to_thread(self._build_summary_sync, auth, studio_row)

    async def get_dashboard_summary(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
    ) -> tuple[DashboardSummaryResponse, dict[str, float]]:
        total_started = time.perf_counter()
        auth = await AuthService(self.supabase).get_user_profile(user_id, requested_studio_id)

        if not auth.studio_id:
            generated_at = datetime.now(timezone.utc).isoformat()
            return (
                DashboardSummaryResponse(auth=auth, generated_at=generated_at),
                {"total": (time.perf_counter() - total_started) * 1000},
            )

        ensure_platform_subscription_access(self.supabase, auth.studio_id)
        studio_row = await asyncio.to_thread(self._fetch_studio_summary, auth.studio_id)
        summary, timings = await self.build_for_authorized_studio(auth, studio_row)
        timings["route_total"] = (time.perf_counter() - total_started) * 1000
        return summary, timings
