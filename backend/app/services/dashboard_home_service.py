"""Home dashboard: one facts RPC plus role-gated follow-ups and promotions.

Identity and access are resolved before any cache lookup. The facts RPC result
and the promotions result are cached per studio (15 seconds); follow-ups are
read per request. Role shaping happens after the cache and is never cached.
"""

import asyncio
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Awaitable, Callable, Optional, TypeVar

from fastapi import HTTPException
from supabase import Client

from app.core.deps import ProviderDependency, run_supabase_operation
from app.schemas.auth import AuthResponse
from app.schemas.dashboard_home import (
    DASHBOARD_HOME_FOLLOW_UP_LIMIT,
    DashboardHomeFollowUpRow,
    DashboardHomeFollowUps,
    DashboardHomeFollowUpStats,
    DashboardHomeResponse,
    DashboardHomeStats,
    DashboardHomeViewer,
)
from app.services.auth_service import AuthService
from app.services.belt_service import BeltService
from app.services.dashboard_home_sections import (
    CONTACT_ROLES,
    DASHBOARD_FACTS_RPC_FORMULA_VERSION,
    DASHBOARD_FACTS_RPC_NAME,
    EMPTY_DASHBOARD_HOME_PROMOTIONS,
    DashboardHomeFactMismatch,
    DashboardHomeFacts,
    DashboardHomePromotions,
    build_follow_ups,
    build_needs_attention,
    build_promotions,
    is_consistent_overdue_count,
    overdue_count_from_rows,
    validate_dashboard_home_facts,
)
from app.services.dashboard_summary_cache import (
    DashboardSummaryCacheKey,
    DashboardSummaryFactCache,
    DashboardSummaryVisibility,
)
from app.services.schedule_service import ScheduleService
from app.services.studio_business_date import studio_today
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)

DASHBOARD_HOME_FACTS_FORMULA_VERSION = "dashboard-home-facts-v1"
DASHBOARD_HOME_PROMOTIONS_FORMULA_VERSION = "dashboard-home-promotions-v1"
BILLING_VISIBLE_ROLES = frozenset({"admin", "front_desk"})
FOLLOW_UP_ROLES = frozenset({"admin", "front_desk"})
PROMOTION_ROLES = frozenset({"admin", "instructor"})
FOLLOW_UP_READ_ATTEMPTS = 2
ACCESS_FAILURE_STATUS_CODES = frozenset({401, 402, 403, 409})
ACCESS_FAILURE_PROVIDER_CODES = frozenset(
    {"42501", "28000", "28P01", "PGRST301", "PGRST302", "PGRST303"}
)
# Matches the RPC's missing-contact predicate: a null or exactly empty name.
MISSING_CONTACT_NAME_FILTER = "emergency_contact_name.is.null,emergency_contact_name.eq."

logger = logging.getLogger(__name__)
ResultT = TypeVar("ResultT")

dashboard_home_fact_cache: DashboardSummaryFactCache[DashboardHomeFacts] = (
    DashboardSummaryFactCache()
)
dashboard_home_promotion_cache: DashboardSummaryFactCache[DashboardHomePromotions] = (
    DashboardSummaryFactCache()
)


@dataclass(slots=True)
class _AgendaRecovery:
    """Serializes writing one studio day's missing sessions within this process."""

    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Monotonic time the last successful write finished; requests that began
    # reading before it reuse that write instead of writing again.
    written_at: Optional[float] = None
    users: int = 0


# Entries live only while a Home request for that studio day is reading facts.
_agenda_recoveries: dict[tuple[str, date], _AgendaRecovery] = {}


@contextmanager
def _agenda_recovery(studio_id: str, local_date: date) -> Iterator[_AgendaRecovery]:
    recovery_key = (studio_id, local_date)
    recovery = _agenda_recoveries.get(recovery_key)
    if recovery is None:
        recovery = _agenda_recoveries[recovery_key] = _AgendaRecovery()
    recovery.users += 1
    try:
        yield recovery
    finally:
        recovery.users -= 1
        if recovery.users == 0 and _agenda_recoveries.get(recovery_key) is recovery:
            del _agenda_recoveries[recovery_key]


@dataclass(frozen=True, slots=True)
class DashboardHomeRequestContext:
    """Per-request identity, resolved before either cache is consulted."""

    user_id: str
    auth: AuthResponse
    facts_key: Optional[DashboardSummaryCacheKey]
    promotions_key: Optional[DashboardSummaryCacheKey]


def is_access_failure(error: BaseException) -> bool:
    """Access denials propagate; every other section failure only hides that section."""

    if isinstance(error, HTTPException):
        return error.status_code in ACCESS_FAILURE_STATUS_CODES
    return getattr(error, "code", None) in ACCESS_FAILURE_PROVIDER_CODES


class DashboardHomeService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    @staticmethod
    def server_timing_value(timings: dict[str, float]) -> str:
        return ", ".join(
            f"koaryu_home_{label};dur={duration_ms:.1f}" for label, duration_ms in timings.items()
        )

    @staticmethod
    def _studio_today(timezone_name: Optional[str]) -> tuple[date, str]:
        return studio_today(timezone_name)

    # ---- Context ----

    def _fetch_studio_timezone(self, studio_id: str) -> Optional[str]:
        result = (
            self.supabase.table("studios")
            .select("id, timezone")
            .eq("id", studio_id)
            .single()
            .execute()
        )
        if not isinstance(result.data, dict):
            raise DashboardHomeFactMismatch("studio metadata response is invalid")
        return result.data.get("timezone")

    def resolve_context_sync(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
    ) -> DashboardHomeRequestContext:
        auth = AuthService(self.supabase)._get_user_profile_sync(user_id, requested_studio_id)
        if not auth.studio_id:
            return DashboardHomeRequestContext(
                user_id=user_id, auth=auth, facts_key=None, promotions_key=None
            )

        ensure_platform_subscription_access(self.supabase, auth.studio_id)
        local_date, timezone_name = self._studio_today(self._fetch_studio_timezone(auth.studio_id))
        visibility: DashboardSummaryVisibility = (
            "billing_visible" if auth.role in BILLING_VISIBLE_ROLES else "billing_hidden"
        )
        return DashboardHomeRequestContext(
            user_id=user_id,
            auth=auth,
            facts_key=DashboardSummaryCacheKey(
                studio_id=auth.studio_id,
                visibility=visibility,
                timezone=timezone_name,
                local_date=local_date,
                formula_version=DASHBOARD_HOME_FACTS_FORMULA_VERSION,
            ),
            # Promotions carry no billing data, so every allowed role shares one entry.
            promotions_key=DashboardSummaryCacheKey(
                studio_id=auth.studio_id,
                visibility="billing_hidden",
                timezone=timezone_name,
                local_date=local_date,
                formula_version=DASHBOARD_HOME_PROMOTIONS_FORMULA_VERSION,
            ),
        )

    # ---- Provider reads and the one write ----

    def fetch_facts_sync(
        self,
        key: DashboardSummaryCacheKey,
        *,
        materialization_attempted: bool = False,
    ) -> DashboardHomeFacts:
        response = self.supabase.rpc(
            DASHBOARD_FACTS_RPC_NAME,
            {
                "p_studio_id": key.studio_id,
                "p_visibility": key.visibility,
                "p_timezone_name": key.timezone,
                "p_local_date": key.local_date.isoformat(),
                "p_formula_version": DASHBOARD_FACTS_RPC_FORMULA_VERSION,
            },
        ).execute()
        data = getattr(response, "data", None)
        if not isinstance(data, dict):
            raise DashboardHomeFactMismatch("dashboard fact RPC did not return an object")
        return validate_dashboard_home_facts(
            data, key, materialization_attempted=materialization_attempted
        )

    def _open_follow_ups(self, columns: str, studio_id: str):
        return (
            self.supabase.table("leads")
            .select(columns, count="exact")
            .eq("studio_id", studio_id)
            .neq("stage", "enrolled")
            .neq("stage", "closed_lost")
        )

    def fetch_due_follow_ups_sync(
        self, studio_id: str, today: str
    ) -> tuple[list[DashboardHomeFollowUpRow], int]:
        """Rows and the due count from one query: due on or before today, oldest first."""

        result = (
            self._open_follow_ups("id, first_name, last_name, stage, follow_up_date", studio_id)
            .lte("follow_up_date", today)
            .order("follow_up_date")
            .order("id")
            .limit(DASHBOARD_HOME_FOLLOW_UP_LIMIT)
            .execute()
        )
        rows, count = result.data, result.count
        if (
            not isinstance(rows, list)
            or not isinstance(count, int)
            or isinstance(count, bool)
            or len(rows) != min(count, DASHBOARD_HOME_FOLLOW_UP_LIMIT)
        ):
            # Rows and count share one snapshot, so the bounded rows must be complete.
            raise ValueError("Home follow-up response is invalid")
        return [DashboardHomeFollowUpRow.model_validate(row) for row in rows], count

    def fetch_overdue_follow_up_count_sync(self, studio_id: str, today: str) -> int:
        # limit(0) keeps this count-only; postgrest-py's head=True reports count 0.
        result = (
            self._open_follow_ups("id", studio_id).lt("follow_up_date", today).limit(0).execute()
        )
        count = result.count
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise ValueError("Home overdue follow-up count is invalid")
        return count

    def fetch_single_missing_contact_student_id_sync(self, studio_id: str) -> Optional[str]:
        """The one active or trialing student without a named emergency contact, if exactly one."""

        result = (
            self.supabase.table("students")
            .select("id")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .in_("status", ["active", "trialing"])
            .or_(MISSING_CONTACT_NAME_FILTER)
            .limit(2)
            .execute()
        )
        rows = result.data
        if not isinstance(rows, list):
            raise ValueError("Home contact lookup response is invalid")
        if len(rows) != 1 or not isinstance(rows[0], dict):
            return None
        student_id = rows[0].get("id")
        return student_id if isinstance(student_id, str) and student_id else None

    async def materialize_today(self, user_id: str, key: DashboardSummaryCacheKey) -> None:
        """Insert today's missing recurring sessions, nothing else.

        Applies the same access check as POST /schedule/window/materialize and
        the same idempotent, atomic RPC, bounded to the studio's today.
        """

        resolve_write_staff_role_for_user(
            self.supabase,
            user_id,
            key.studio_id,
            require_platform_subscription=True,
        )
        today = key.local_date.isoformat()
        await ScheduleService(self.supabase)._materialize_sessions_for_range(
            key.studio_id, today, today
        )

    async def fetch_promotions(self, studio_id: str) -> DashboardHomePromotions:
        """Ready students on the primary ladder: the first the bootstrap would pick."""

        belts = BeltService(self.supabase)
        ladders = await belts.list_ladders(studio_id)
        if not ladders:
            return EMPTY_DASHBOARD_HOME_PROMOTIONS
        primary = ladders[0]
        entries = await belts.get_eligibility(studio_id, primary.id)
        return build_promotions(entries, [rank.id for rank in primary.ranks])

    # ---- Assembly ----

    @classmethod
    async def get_dashboard_home_from_context(
        cls,
        provider: ProviderDependency,
        context: DashboardHomeRequestContext,
        *,
        fact_cache: DashboardSummaryFactCache[DashboardHomeFacts] = dashboard_home_fact_cache,
        promotion_cache: DashboardSummaryFactCache[
            DashboardHomePromotions
        ] = dashboard_home_promotion_cache,
        fresh: bool = False,
        timings: Optional[dict[str, float]] = None,
        total_started: Optional[float] = None,
    ) -> tuple[DashboardHomeResponse, dict[str, float]]:
        timings = {} if timings is None else timings
        total_started = time.perf_counter() if total_started is None else total_started
        viewer = DashboardHomeViewer(role=context.auth.role)
        key = context.facts_key
        if key is None:
            timings["total"] = (time.perf_counter() - total_started) * 1000
            return DashboardHomeResponse(generated_at=_utc_now(), viewer=viewer), timings

        role = context.auth.role
        studio_id = key.studio_id
        today = key.local_date.isoformat()

        def run(operation: Callable[[Any], Awaitable[ResultT] | ResultT]) -> Awaitable[ResultT]:
            return run_supabase_operation(provider, operation, lane="interactive")

        async def timed(label: str, awaitable: Awaitable[ResultT]) -> ResultT:
            started = time.perf_counter()
            try:
                return await awaitable
            finally:
                timings[label] = (time.perf_counter() - started) * 1000

        async def optional_section(label: str, awaitable: Awaitable[ResultT]) -> Optional[ResultT]:
            try:
                return await timed(label, awaitable)
            except Exception as error:
                if is_access_failure(error):
                    raise
                logger.warning(
                    "Home section unavailable",
                    extra={"section": label, "error_type": type(error).__name__},
                )
                return None

        async def best_effort(label: str, awaitable: Awaitable[ResultT]) -> Optional[ResultT]:
            # Materializing is a write on a read path. A viewer who may read
            # Home but not write sessions still gets Home, without today's classes.
            try:
                return await timed(label, awaitable)
            except Exception as error:
                logger.warning(
                    "Home write skipped",
                    extra={"section": label, "error_type": type(error).__name__},
                )
                return None

        async def load_facts(*, use_cache: bool, after_materialize: bool) -> DashboardHomeFacts:
            async def loader() -> DashboardHomeFacts:
                return await run(
                    lambda client: cls(client).fetch_facts_sync(
                        key, materialization_attempted=after_materialize
                    )
                )

            return await (fact_cache.get_or_load(key, loader) if use_cache else loader())

        async def materialize(client: Any) -> bool:
            await cls(client).materialize_today(context.user_id, key)
            return True

        async def recover_agenda(
            recovery: _AgendaRecovery, facts: DashboardHomeFacts, read_started: float
        ) -> DashboardHomeFacts:
            # The RPC cannot list today's classes until recurrences exist as
            # session rows. Requests that read the same unavailable day queue
            # here, so the day is written and invalidated once, not once per
            # request (repeated invalidation would exhaust the cache's retry).
            async with recovery.lock:
                written_by_another = (
                    recovery.written_at is not None and recovery.written_at >= read_started
                )
                if not written_by_another:
                    # Each request writes with its own authorization; a denied or
                    # failed write leaves the next queued request free to try.
                    if not await best_effort("materialize", run(materialize)):
                        return facts
                    recovery.written_at = time.monotonic()
                    fact_cache.invalidate(studio_id, domain="dashboard")
                # Re-read this request's own key (visibility differs by role). It
                # is cached, so a still-unavailable day is not written again until
                # that entry expires.
                return await timed(
                    "facts_after_materialize",
                    load_facts(use_cache=not fresh, after_materialize=True),
                )

        async def facts_section() -> tuple[DashboardHomeFacts, Optional[str]]:
            with _agenda_recovery(studio_id, key.local_date) as recovery:
                read_started = time.monotonic()
                facts = await timed(
                    "facts", load_facts(use_cache=not fresh, after_materialize=False)
                )
                if facts.classes_today is None and not facts.materialization_attempted:
                    facts = await recover_agenda(recovery, facts, read_started)
            contact_student_id = None
            if role in CONTACT_ROLES and facts.missing_contact_count == 1:
                contact_student_id = await optional_section(
                    "contact",
                    run(
                        lambda client: cls(client).fetch_single_missing_contact_student_id_sync(
                            studio_id
                        )
                    ),
                )
            return facts, contact_student_id

        async def consistent_follow_ups() -> Optional[
            tuple[DashboardHomeFollowUpStats, DashboardHomeFollowUps]
        ]:
            for _attempt in range(FOLLOW_UP_READ_ATTEMPTS):
                rows, due_count = await run(
                    lambda client: cls(client).fetch_due_follow_ups_sync(studio_id, today)
                )
                overdue_count = overdue_count_from_rows(rows, due_count, today)
                if overdue_count is None:
                    # Every returned row is overdue and more leads are due, so
                    # only a separate count can say how many are overdue. It is
                    # another snapshot: use it only if it agrees with the rows.
                    counted = await run(
                        lambda client: cls(client).fetch_overdue_follow_up_count_sync(
                            studio_id, today
                        )
                    )
                    if is_consistent_overdue_count(rows, due_count, today, counted):
                        overdue_count = counted
                if overdue_count is not None:
                    return build_follow_ups(rows, due_count, overdue_count)
            logger.warning("Home follow-ups omitted: overdue count disagreed with rows twice")
            return None

        async def follow_ups_section() -> Optional[
            tuple[DashboardHomeFollowUpStats, DashboardHomeFollowUps]
        ]:
            if role not in FOLLOW_UP_ROLES:
                return None
            return await optional_section("follow_ups", consistent_follow_ups())

        async def promotions_section() -> Optional[DashboardHomePromotions]:
            if role not in PROMOTION_ROLES or context.promotions_key is None:
                return None

            async def loader() -> DashboardHomePromotions:
                return await run(lambda client: cls(client).fetch_promotions(studio_id))

            return await optional_section(
                "promotions",
                loader() if fresh else promotion_cache.get_or_load(context.promotions_key, loader),
            )

        # An access denial in any section outranks a transient facts failure.
        (facts, contact_student_id), follow_ups, promotions = await _gather_or_raise(
            facts_section(),
            follow_ups_section(),
            promotions_section(),
        )

        payload = DashboardHomeResponse(
            generated_at=_utc_now(),
            viewer=viewer,
            studio=facts.studio,
            needs_attention=build_needs_attention(
                facts, role, contact_student_id=contact_student_id
            ),
            classes_today=facts.classes_today,
            stats=DashboardHomeStats(
                active_students=facts.active_students,
                attendance=facts.attendance,
                follow_ups=follow_ups[0] if follow_ups else None,
                promotions=promotions.stats if promotions else None,
            ),
            follow_ups=follow_ups[1] if follow_ups else None,
            ready_to_promote=promotions.ready_to_promote if promotions else None,
            recent_students=list(facts.recent_students),
        )
        timings["total"] = (time.perf_counter() - total_started) * 1000
        return payload, timings


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


async def _gather_or_raise(*awaitables: Awaitable[Any]) -> list[Any]:
    """Run sections concurrently, wait for all, then raise a failure.

    An access failure wins over any other, so a transient error in one read
    cannot hide a denial in another.
    """

    results = await asyncio.gather(*awaitables, return_exceptions=True)
    failures = [result for result in results if isinstance(result, BaseException)]
    if failures:
        raise next((error for error in failures if is_access_failure(error)), failures[0])
    return list(results)
