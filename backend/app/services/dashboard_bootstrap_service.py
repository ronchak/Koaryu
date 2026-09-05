import asyncio
import logging
import time
from types import SimpleNamespace
from typing import Any, Callable, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas.belt import BeltLadderResponse, BeltRankResponse
from app.schemas.dashboard_bootstrap import (
    DashboardBootstrapResponse,
    DashboardBootstrapStudioSummary,
)
from app.schemas.lead import LeadResponse
from app.services.program_service import ProgramService
from app.services.auth_service import AuthService
from app.services.student_service import StudentService
from app.services.studio_scope import ensure_platform_subscription_access

logger = logging.getLogger(__name__)


class DashboardBootstrapService:
    STUDENTS_BOOTSTRAP_PAGE_SIZE = 200

    def __init__(self, supabase: Client):
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
        return (
            self.supabase.table("leads")
            .select("*")
            .eq("studio_id", studio_id)
            .order("created_at", desc=True)
            .execute()
        )

    def _fetch_programs(self, studio_id: str):
        return ProgramService(self.supabase).list_programs_metadata_sync(
            studio_id,
            include_archived=True,
        )

    @staticmethod
    def _fetch_with_isolated_client(method_name: str, studio_id: str, postgrest_client_timeout: float):
        client = create_supabase_client(postgrest_client_timeout=postgrest_client_timeout)
        try:
            service = DashboardBootstrapService(client)
            return getattr(service, method_name)(studio_id)
        finally:
            if hasattr(getattr(client, "auth", None), "close"):
                close_supabase_client(client)

    @staticmethod
    def _timed_fetch_with_isolated_client(label: str, method_name: str, studio_id: str, postgrest_client_timeout: float):
        started = time.perf_counter()
        result = DashboardBootstrapService._fetch_with_isolated_client(method_name, studio_id, postgrest_client_timeout)
        duration_ms = (time.perf_counter() - started) * 1000
        return result, (label, duration_ms)

    @staticmethod
    def server_timing_value(timings: dict[str, float]) -> str:
        return ", ".join(
            f"koaryu_{label};dur={duration_ms:.1f}"
            for label, duration_ms in timings.items()
        )

    def _fetch_belt_ladders(self, studio_id: str):
        visible_programs = (
            self.supabase.table("programs")
            .select("id, is_system, archived_at")
            .eq("studio_id", studio_id)
            .execute()
        )
        visible_program_ids = [
            row["id"]
            for row in (visible_programs.data or [])
            if row.get("id") and not row.get("is_system") and not row.get("archived_at")
        ]
        if not visible_program_ids:
            return SimpleNamespace(data=[])
        return (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .in_("program_id", visible_program_ids)
            .order("created_at")
            .execute()
        )

    async def get_dashboard_bootstrap(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
        *,
        provider_owned: bool = False,
        allow_partial: bool = False,
    ) -> tuple[DashboardBootstrapResponse, dict[str, float]]:
        total_started = time.perf_counter()
        if provider_owned:
            auth = AuthService(self.supabase)._get_user_profile_sync(user_id, requested_studio_id)
        else:
            auth = await AuthService(self.supabase).get_user_profile(user_id, requested_studio_id)

        if not auth.studio_id:
            timings = {"total": (time.perf_counter() - total_started) * 1000}
            return DashboardBootstrapResponse(auth=auth), timings

        studio_id = auth.studio_id
        ensure_platform_subscription_access(self.supabase, studio_id)

        # supabase-py's sync client is not safe to share across parallel thread
        # calls, so each bootstrap read gets its own short-lived client. Carry
        # the owning lane's I/O policy into these clients before crossing threads.
        postgrest_client_timeout = self.supabase.options.postgrest_client_timeout
        errors: dict[str, str] = {}
        timings: dict[str, float] = {}

        async def load_projection(label: str, method_name: str, project: Callable[[Any], Any]):
            started = time.perf_counter()
            try:
                result, (_label, duration_ms) = await asyncio.to_thread(
                    self._timed_fetch_with_isolated_client,
                    label, method_name, studio_id, postgrest_client_timeout,
                )
                value = project(result)
                timings[label] = duration_ms
                return value
            except Exception as error:
                if not allow_partial:
                    raise
                # Access failures must never become partial-success responses.
                if isinstance(error, HTTPException) and (
                    error.status_code in {401, 402, 403}
                    or (label == "studio" and error.status_code == 404)
                ):
                    raise
                if getattr(error, "code", None) in {"42501", "28000", "28P01", "PGRST301", "PGRST302", "PGRST303"}:
                    raise
                errors[label] = {
                    "studio": "Studio details could not be loaded. Please retry.",
                    "students": "Student roster could not be loaded. Please retry.",
                    "leads": "Leads could not be loaded. Please retry.",
                    "belts": "Belt plans could not be loaded. Please retry.",
                    "programs": "Programs could not be loaded. Please retry.",
                }[label]
                timings[label] = (time.perf_counter() - started) * 1000
                logger.warning("Dashboard bootstrap projection unavailable", extra={
                    "dataset": label, "error_type": type(error).__name__,
                })
                return None

        def studio_projection(result):
            if not result.data:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Studio not found")
            return DashboardBootstrapStudioSummary(**result.data)

        def students_projection(result):
            students = StudentService(self.supabase).rows_to_responses(
                result.data or [], include_guardians=False, include_photo_urls=False,
            )
            total = getattr(result, "count", None)
            return students, total if total is not None else len(students)

        studio, student_projection, leads, belt_ladders, programs = await asyncio.gather(
            load_projection("studio", "_fetch_studio_summary", studio_projection),
            load_projection("students", "_fetch_students", students_projection),
            load_projection("leads", "_fetch_leads", lambda result: [LeadResponse(**row) for row in (result.data or [])]),
            load_projection("belts", "_fetch_belt_ladders", lambda result: [self._build_ladder_response(row) for row in (result.data or [])]),
            load_projection("programs", "_fetch_programs", lambda result: result),
        )
        students, students_total = student_projection if student_projection is not None else ([], None)
        belt_ladders = belt_ladders if belt_ladders is not None else []
        timings["total"] = (time.perf_counter() - total_started) * 1000

        return (
            DashboardBootstrapResponse(
                auth=auth,
                studio=studio,
                studio_name=studio.name if studio is not None else None,
                students=students,
                students_total=students_total,
                students_page_size=self.STUDENTS_BOOTSTRAP_PAGE_SIZE,
                students_may_be_partial=students_total is None or students_total > len(students),
                programs=programs if programs is not None else [],
                leads=leads if leads is not None else [],
                belt_ladders=belt_ladders,
                primary_belt_ladder=belt_ladders[0] if belt_ladders else None,
                dataset_errors=errors,
            ),
            timings,
        )
