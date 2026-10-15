import asyncio
import logging
import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Callable, Optional

from fastapi import HTTPException, status

from app.core.deps import ProviderDependency, run_supabase_operation
from app.schemas.auth import AuthResponse
from app.schemas.belt import BeltLadderResponse, BeltRankResponse
from app.schemas.dashboard_bootstrap import (
    DashboardBootstrapResponse,
    DashboardBootstrapStudioSummary,
    DashboardWorkspaceResponse,
)
from app.schemas.lead import LeadResponse
from app.services.studio_business_date import studio_today
from app.services.program_service import ProgramService
from app.services.auth_service import AuthService
from app.services.student_service import StudentService
from app.services.studio_scope import ensure_platform_subscription_access
from app.services.lead_reads import fetch_lead_rows

logger = logging.getLogger(__name__)

BOOTSTRAP_VIEW_DATASETS = {
    # Home reads its facts from /dashboard/home; it needs only the studio and programs.
    "home": frozenset({"studio", "programs"}),
    "students": frozenset({"studio", "programs", "students"}),
    "billing": frozenset({"studio"}),
    "schedule": frozenset({"studio", "programs"}),
    "settings": frozenset({"studio", "programs"}),
    "leads": frozenset({"studio", "programs", "leads"}),
    "reports": frozenset({"studio", "programs", "leads"}),
    "training": frozenset({"studio", "programs", "belts"}),
}


@dataclass(frozen=True, slots=True)
class DashboardBootstrapContext:
    auth: AuthResponse
    datasets: frozenset[str]


class DashboardBootstrapService:
    """Resolve access once, then load each selected dataset on an owned lane.

    Orchestration stays on the ASGI loop. A bootstrap submits 1 + N operations
    and reuses persistent worker clients instead of opening dataset transports.
    """

    STUDENTS_BOOTSTRAP_PAGE_SIZE = 200

    def __init__(self, supabase: ProviderDependency):
        self.supabase = supabase

    def _build_ladder_response(self, ladder_row: dict[str, Any]) -> BeltLadderResponse:
        ranks = sorted(
            [
                BeltRankResponse(**rank)
                for rank in (ladder_row.get("belt_ranks") or ladder_row.get("ranks") or [])
            ],
            key=lambda item: item.display_order,
        )
        return BeltLadderResponse(
            id=ladder_row["id"],
            studio_id=ladder_row["studio_id"],
            name=ladder_row["name"],
            program_id=ladder_row.get("program_id"),
            sub_rank_term=ladder_row.get("sub_rank_term") or "Stripe",
            created_at=ladder_row["created_at"],
            updated_at=ladder_row["updated_at"],
            ranks=ranks,
        )

    def _fetch_studio_summary(self, studio_id: str):
        return (
            self.supabase.table("studios")
            .select("id, name, slug, timezone, logo_url")
            .eq("id", studio_id)
            .single()
            .execute()
        )

    def _fetch_students(self, studio_id: str):
        return (
            self.supabase.table("students")
            .select("*", count="exact")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .order("legal_last_name")
            .order("legal_first_name")
            .limit(self.STUDENTS_BOOTSTRAP_PAGE_SIZE)
            .execute()
        )

    def _fetch_leads(self, studio_id: str):
        return SimpleNamespace(data=fetch_lead_rows(self.supabase, studio_id))

    def _fetch_programs(self, studio_id: str):
        return ProgramService(self.supabase).list_programs_metadata_sync(
            studio_id,
            include_archived=True,
        )

    @staticmethod
    def server_timing_value(timings: dict[str, float]) -> str:
        return ", ".join(
            f"koaryu_{label};dur={duration_ms:.1f}" for label, duration_ms in timings.items()
        )

    def _fetch_belt_ladders(self, studio_id: str):
        # The empty inner embed keeps only ladders of this studio's active,
        # non-system programs (a NULL is_system counts as false) without
        # returning program fields. A failed join reports belts unavailable.
        # Ordered as BeltService.list_ladders: the id breaks created_at ties.
        return (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*), programs!inner()")
            .eq("studio_id", studio_id)
            .eq("programs.studio_id", studio_id)
            .is_("programs.archived_at", "null")
            .not_.is_("programs.is_system", "true")
            .order("created_at")
            .order("id")
            .execute()
        )

    def get_workspace_sync(self, user_id: str, requested_studio_id: Optional[str] = None):
        """Authoritative access, subscription, and studio clock without feature reads."""
        auth = AuthService(self.supabase)._get_user_profile_sync(user_id, requested_studio_id)
        if not auth.studio_id or auth.membership_status != "active":
            return DashboardWorkspaceResponse(auth=auth)
        ensure_platform_subscription_access(self.supabase, auth.studio_id)
        result = self._fetch_studio_summary(auth.studio_id)
        if not result.data:
            raise HTTPException(status_code=404, detail="Studio not found")
        return DashboardWorkspaceResponse(
            auth=auth,
            studio=DashboardBootstrapStudioSummary(
                **{**result.data, "timezone": studio_today(result.data.get("timezone"))[1]}
            ),
        )

    def resolve_context_sync(
        self, user_id: str, requested_studio_id: Optional[str] = None, *, view: str = "home"
    ) -> DashboardBootstrapContext:
        auth = AuthService(self.supabase)._get_user_profile_sync(user_id, requested_studio_id)
        if auth.studio_id:
            ensure_platform_subscription_access(self.supabase, auth.studio_id)
        return DashboardBootstrapContext(auth, BOOTSTRAP_VIEW_DATASETS[view])

    async def get_dashboard_bootstrap(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
        *,
        allow_partial: bool = False,
        view: str = "home",
    ) -> tuple[DashboardBootstrapResponse, dict[str, float]]:
        """Orchestrate on the caller's event loop, never inside a lane worker."""
        total_started = time.perf_counter()
        context = await run_supabase_operation(
            self.supabase,
            lambda client: DashboardBootstrapService(client).resolve_context_sync(
                user_id, requested_studio_id, view=view
            ),
            lane="interactive",
        )
        return await self.get_dashboard_bootstrap_from_context(
            self.supabase, context, allow_partial=allow_partial, total_started=total_started
        )

    @classmethod
    async def get_dashboard_bootstrap_from_context(
        cls,
        provider: ProviderDependency,
        context: DashboardBootstrapContext,
        *,
        allow_partial: bool,
        total_started: float,
    ) -> tuple[DashboardBootstrapResponse, dict[str, float]]:
        auth = context.auth
        if not auth.studio_id:
            return DashboardBootstrapResponse(auth=auth), {
                "total": (time.perf_counter() - total_started) * 1000
            }
        studio_id = auth.studio_id
        errors: dict[str, str] = {}
        timings: dict[str, float] = {}
        projection_error_messages = {
            "studio": "Studio details could not be loaded. Please retry.",
            "students": "Student roster could not be loaded. Please retry.",
            "leads": "Leads could not be loaded. Please retry.",
            "belts": "Belt plans could not be loaded. Please retry.",
            "programs": "Programs could not be loaded. Please retry.",
        }

        def record_projection_failure(label: str, error: Exception) -> None:
            if not allow_partial:
                raise error
            # Access failures must never become partial-success responses.
            if isinstance(error, HTTPException) and (
                error.status_code in {401, 402, 403}
                or (label == "studio" and error.status_code == 404)
            ):
                raise error
            if getattr(error, "code", None) in {
                "42501",
                "28000",
                "28P01",
                "PGRST301",
                "PGRST302",
                "PGRST303",
            }:
                raise error
            errors[label] = projection_error_messages[label]
            logger.warning(
                "Dashboard bootstrap projection unavailable",
                extra={
                    "dataset": label,
                    "error_type": type(error).__name__,
                },
            )

        async def load_projection(
            label: str, method_name: str, project: Callable[..., Any], *, studio_task=None
        ):
            if label not in context.datasets:
                return None
            # Dependency failures belong to the studio projection. No students
            # operation has run yet, so do not classify them as students faults.
            studio = await studio_task if studio_task is not None else None
            started = time.perf_counter()
            try:

                def operation(client):
                    service = cls(client)
                    operation_started = time.perf_counter()
                    result = getattr(service, method_name)(studio_id)
                    value = (
                        project(service, result, studio)
                        if studio_task is not None
                        else project(service, result)
                    )
                    return value, (time.perf_counter() - operation_started) * 1000

                value, duration_ms = await run_supabase_operation(
                    provider, operation, lane="interactive"
                )
                timings[label] = duration_ms
                if label == "students" and value is None:
                    errors[label] = projection_error_messages[label]
                return value
            except Exception as error:
                record_projection_failure(label, error)
                timings[label] = (time.perf_counter() - started) * 1000
                return None

        def studio_projection(_service, result):
            if not result.data:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Studio not found"
                )
            return DashboardBootstrapStudioSummary(**result.data)

        def students_projection(service, result, studio):
            rows = result.data or []
            if studio is None and any(row.get("date_of_birth") for row in rows):
                return None
            total = getattr(result, "count", None)
            students = StudentService(service.supabase).rows_to_responses(
                rows,
                include_guardians=False,
                include_photo_urls=False,
                today=studio_today(studio.timezone)[0] if studio is not None else None,
            )
            return students, total if total is not None else len(rows)

        studio_task = asyncio.create_task(
            load_projection("studio", "_fetch_studio_summary", studio_projection)
        )
        tasks = [
            studio_task,
            asyncio.create_task(
                load_projection(
                    "students", "_fetch_students", students_projection, studio_task=studio_task
                )
            ),
            asyncio.create_task(
                load_projection(
                    "leads",
                    "_fetch_leads",
                    lambda _service, result: [LeadResponse(**row) for row in (result.data or [])],
                )
            ),
            asyncio.create_task(
                load_projection(
                    "belts",
                    "_fetch_belt_ladders",
                    lambda service, result: [
                        service._build_ladder_response(row) for row in (result.data or [])
                    ],
                )
            ),
            asyncio.create_task(
                load_projection("programs", "_fetch_programs", lambda _service, result: result)
            ),
        ]
        try:
            studio, student_projection, leads, belt_ladders, programs = await asyncio.gather(*tasks)
        finally:
            # Fatal failures and cancellation must not leave sibling lane
            # waiters submitting more work after this request has ended.
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        students, students_total = (
            student_projection if student_projection is not None else ([], None)
        )
        belt_ladders = belt_ladders if belt_ladders is not None else []
        timings["total"] = (time.perf_counter() - total_started) * 1000

        return (
            DashboardBootstrapResponse(
                auth=auth,
                studio=studio,
                studio_name=studio.name if studio is not None else None,
                students=students,
                students_total=students_total,
                students_page_size=cls.STUDENTS_BOOTSTRAP_PAGE_SIZE,
                students_may_be_partial=students_total is None or students_total > len(students),
                programs=programs if programs is not None else [],
                leads=leads if leads is not None else [],
                belt_ladders=belt_ladders,
                primary_belt_ladder=belt_ladders[0] if belt_ladders else None,
                dataset_errors=errors,
            ),
            timings,
        )
