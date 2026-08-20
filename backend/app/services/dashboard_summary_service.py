import asyncio
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Mapping, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import ValidationError
from supabase import Client

from app.core.deps import ProviderDependency, run_supabase_operation
from app.schemas.auth import AuthResponse
from app.schemas.dashboard_summary import (
    DashboardSummaryInactivityCounts,
    DashboardSummaryOperationalCounts,
    DashboardSummaryResponse,
    DashboardSummaryScheduleCounts,
    DashboardSummaryStudio,
    DashboardSummaryTestReadinessCounts,
    DashboardSummaryTodaySchedule,
)
from app.services.auth_service import AuthService
from app.services.dashboard_summary_attendance import DashboardSummaryAttendanceMetrics
from app.services.dashboard_summary_actions import build_dashboard_summary_actions
from app.services.dashboard_summary_cache import (
    DashboardSummaryCacheKey,
    DashboardSummaryFactCache,
    DashboardSummaryVisibility,
)
from app.services.dashboard_summary_counts import DashboardSummaryCounts
from app.services.dashboard_summary_store import DashboardSummaryStore
from app.services.studio_scope import ensure_platform_subscription_access


PRIVATE_CACHE_CONTROL = "no-store, private"
PRIVATE_VARY = "Authorization, X-Studio-Id, Cookie"
DASHBOARD_SUMMARY_FORMULA_VERSION = "dashboard-summary-v1"
BILLING_VISIBLE_ROLES = {"admin", "front_desk"}


@dataclass(frozen=True, slots=True)
class DashboardSummaryRequestContext:
    """Per-request identity and authorization context for fact assembly."""

    auth: AuthResponse
    key: DashboardSummaryCacheKey | None


class DashboardSummaryFactMismatch(ValueError):
    """The provider returned facts for a different request contract."""


dashboard_summary_fact_cache: DashboardSummaryFactCache[dict[str, Any]] = (
    DashboardSummaryFactCache()
)


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
        except (ZoneInfoNotFoundError, ValueError):
            normalized_timezone = "UTC"
            zone = timezone.utc
        return datetime.now(zone).date(), normalized_timezone

    def _fetch_studio_summary(self, studio_id: str) -> dict[str, Any]:
        return self._counts().fetch_studio_summary(studio_id)

    def _fetch_studio_metadata(self, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("studios")
            .select("id, name, slug, timezone, logo_url")
            .eq("id", studio_id)
            .single()
            .execute()
        )
        if not isinstance(result.data, dict):
            raise DashboardSummaryFactMismatch("studio metadata response is invalid")
        return result.data

    def resolve_fact_context_sync(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
    ) -> DashboardSummaryRequestContext:
        """Resolve all identity-sensitive inputs before consulting fact cache."""

        auth = AuthService(self.supabase)._get_user_profile_sync(
            user_id,
            requested_studio_id,
        )
        if not auth.studio_id:
            return DashboardSummaryRequestContext(auth=auth, key=None)

        ensure_platform_subscription_access(self.supabase, auth.studio_id)
        studio_row = self._fetch_studio_metadata(auth.studio_id)
        _local_date, normalized_timezone = self._studio_today(studio_row.get("timezone"))
        visibility: DashboardSummaryVisibility = (
            "billing_visible"
            if auth.role in BILLING_VISIBLE_ROLES
            else "billing_hidden"
        )
        return DashboardSummaryRequestContext(
            auth=auth,
            key=DashboardSummaryCacheKey(
                studio_id=auth.studio_id,
                visibility=visibility,
                timezone=normalized_timezone,
                local_date=_local_date,
                formula_version=DASHBOARD_SUMMARY_FORMULA_VERSION,
            ),
        )

    @staticmethod
    def _rpc_response_data(response: Any) -> Mapping[str, Any]:
        data = getattr(response, "data", None)
        if not isinstance(data, dict):
            raise DashboardSummaryFactMismatch("dashboard fact RPC did not return an object")
        return data

    def fetch_dashboard_facts_sync(
        self,
        key: DashboardSummaryCacheKey,
    ) -> dict[str, Any]:
        """Fetch exactly one accepted fact RPC on the provider-owned worker."""

        response = self.supabase.rpc(
            "dashboard_summary_facts",
            {
                "p_studio_id": key.studio_id,
                "p_visibility": key.visibility,
                "p_timezone_name": key.timezone,
                "p_local_date": key.local_date.isoformat(),
                "p_formula_version": key.formula_version,
            },
        ).execute()
        return self._validate_dashboard_facts(self._rpc_response_data(response), key)

    @classmethod
    def _validate_dashboard_facts(
        cls,
        facts: Mapping[str, Any],
        key: DashboardSummaryCacheKey,
    ) -> dict[str, Any]:
        forbidden_identity_fields = {
            "auth",
            "access_token",
            "authorization",
            "bearer_token",
            "generated_at",
            "user",
            "user_id",
        }
        if forbidden_identity_fields.intersection(facts):
            raise DashboardSummaryFactMismatch("dashboard facts contain identity data")
        if facts.get("formula_version") != key.formula_version:
            raise DashboardSummaryFactMismatch("dashboard fact formula version mismatch")
        if facts.get("timezone") != key.timezone:
            raise DashboardSummaryFactMismatch("dashboard fact timezone mismatch")
        if facts.get("today") != key.local_date.isoformat():
            raise DashboardSummaryFactMismatch("dashboard fact local date mismatch")

        studio = facts.get("studio")
        if not isinstance(studio, dict):
            raise DashboardSummaryFactMismatch("dashboard fact studio is invalid")
        if studio.get("id") != key.studio_id:
            raise DashboardSummaryFactMismatch("dashboard fact studio mismatch")
        if studio.get("timezone") != key.timezone:
            raise DashboardSummaryFactMismatch("dashboard fact studio timezone mismatch")

        billing = facts.get("billing")
        if not isinstance(billing, dict):
            raise DashboardSummaryFactMismatch("dashboard fact billing is invalid")
        if key.visibility == "billing_visible":
            if billing.get("can_view_billing") is not True:
                raise DashboardSummaryFactMismatch("visible dashboard fact is not billing-visible")
            if not isinstance(billing.get("payment_attention_count"), int) or isinstance(
                billing.get("payment_attention_count"), bool
            ):
                raise DashboardSummaryFactMismatch("visible dashboard billing count is invalid")
            if not isinstance(billing.get("has_plans"), bool):
                raise DashboardSummaryFactMismatch("visible dashboard billing plan flag is invalid")
            if not isinstance(billing.get("payments_ready"), bool):
                raise DashboardSummaryFactMismatch("visible dashboard payment flag is invalid")
            amounts = billing.get("amounts")
            if not isinstance(amounts, dict) or amounts.get("available") is not False:
                raise DashboardSummaryFactMismatch("visible dashboard billing amounts are invalid")
        else:
            if billing.get("can_view_billing") is not False:
                raise DashboardSummaryFactMismatch("hidden dashboard fact exposes billing")
            if any(
                billing.get(field) is not None
                for field in ("payment_attention_count", "has_plans", "payments_ready")
            ) or "amounts" in billing:
                raise DashboardSummaryFactMismatch("hidden dashboard fact contains billing data")

        try:
            # Validate the complete accepted JSON shape through the unchanged
            # response model, then remove the request-specific fields before
            # storing the result.
            validated = DashboardSummaryResponse.model_validate(
                {
                    **facts,
                    "auth": {
                        "user": {
                            "id": "dashboard-fact-validation",
                            "email": "",
                        },
                        "staff_profiles_available": False,
                    },
                    "generated_at": "1970-01-01T00:00:00+00:00",
                }
            )
        except ValidationError as exc:
            raise DashboardSummaryFactMismatch("dashboard fact response shape is invalid") from exc

        return validated.model_dump(mode="python", exclude={"auth", "generated_at"})

    @staticmethod
    def assemble_fact_response(
        auth: AuthResponse,
        facts: Mapping[str, Any],
    ) -> DashboardSummaryResponse:
        """Attach fresh identity and response time to a cached fact payload."""

        return DashboardSummaryResponse.model_validate(
            {
                **facts,
                "auth": auth,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
        )

    @classmethod
    async def get_dashboard_summary_from_fact_context(
        cls,
        provider: ProviderDependency,
        context: DashboardSummaryRequestContext,
        *,
        cache: DashboardSummaryFactCache[dict[str, Any]] = dashboard_summary_fact_cache,
        timings: Optional[dict[str, float]] = None,
        total_started: Optional[float] = None,
    ) -> tuple[DashboardSummaryResponse, dict[str, float]]:
        """Load shared facts after the endpoint has resolved request context."""

        if timings is None:
            timings = {}
        if total_started is None:
            total_started = time.perf_counter()
        if context.key is None:
            payload = cls.assemble_fact_response(context.auth, {})
            timings["total"] = (time.perf_counter() - total_started) * 1000
            return payload, timings

        async def load_facts() -> dict[str, Any]:
            return await run_supabase_operation(
                provider,
                lambda client: cls(client).fetch_dashboard_facts_sync(context.key),
                lane="interactive",
            )

        facts_started = time.perf_counter()
        facts = await cache.get_or_load(context.key, load_facts)
        timings["facts"] = (time.perf_counter() - facts_started) * 1000
        payload = cls.assemble_fact_response(context.auth, facts)
        timings["total"] = (time.perf_counter() - total_started) * 1000
        return payload, timings

    def _today_schedule(
        self,
        studio_id: str,
        today: date,
    ) -> tuple[DashboardSummaryScheduleCounts, DashboardSummaryTodaySchedule]:
        return self._attendance_metrics().today_schedule(studio_id, today)

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
                "id, legal_first_name, legal_last_name, preferred_name, status, hold_start_date, hold_end_date, membership_start_date, created_at, program_id, current_belt_rank_id, emergency_contact_name",
                lambda query: query.eq("studio_id", studio_id).is_("deleted_at", "null"),
            ),
        )
        student_counts = timed("student_counts", lambda: counts.student_counts(studio_id, student_rows, today))
        emergency_contacts = timed(
            "emergency_contacts",
            lambda: counts.emergency_contact_counts(student_rows, student_counts.active_students),
        )
        lead_counts = timed("lead_counts", lambda: counts.lead_counts(studio_id, today))
        schedule_counts, today_schedule = timed(
            "schedule_counts",
            lambda: self._today_schedule(studio_id, today),
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
                today_schedule=today_schedule,
                emergency_contacts=emergency_contacts,
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
