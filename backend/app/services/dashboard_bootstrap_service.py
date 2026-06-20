import asyncio
import time
from types import SimpleNamespace
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.db.supabase import create_supabase_client
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
    def _fetch_with_isolated_client(method_name: str, studio_id: str):
        service = DashboardBootstrapService(create_supabase_client())
        return getattr(service, method_name)(studio_id)

    @staticmethod
    def _timed_fetch_with_isolated_client(label: str, method_name: str, studio_id: str):
        started = time.perf_counter()
        result = DashboardBootstrapService._fetch_with_isolated_client(method_name, studio_id)
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
    ) -> tuple[DashboardBootstrapResponse, dict[str, float]]:
        total_started = time.perf_counter()
        auth = await AuthService(self.supabase).get_user_profile(user_id, requested_studio_id)

        if not auth.studio_id:
            timings = {"total": (time.perf_counter() - total_started) * 1000}
            return DashboardBootstrapResponse(auth=auth), timings

        studio_id = auth.studio_id
        ensure_platform_subscription_access(self.supabase, studio_id)

        # supabase-py's sync client is not safe to share across parallel thread
        # calls, so each bootstrap read gets its own short-lived client.
        results = await asyncio.gather(
            asyncio.to_thread(self._timed_fetch_with_isolated_client, "studio", "_fetch_studio_summary", studio_id),
            asyncio.to_thread(self._timed_fetch_with_isolated_client, "students", "_fetch_students", studio_id),
            asyncio.to_thread(self._timed_fetch_with_isolated_client, "leads", "_fetch_leads", studio_id),
            asyncio.to_thread(self._timed_fetch_with_isolated_client, "belts", "_fetch_belt_ladders", studio_id),
            asyncio.to_thread(self._timed_fetch_with_isolated_client, "programs", "_fetch_programs", studio_id),
        )
        (studio_result, studio_timing), (students_result, students_timing), (leads_result, leads_timing), (ladders_result, ladders_timing), (programs, programs_timing) = results

        if not studio_result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Studio not found",
            )

        student_service = StudentService(self.supabase)
        students = student_service.rows_to_responses(
            students_result.data or [],
            include_guardians=False,
            include_photo_urls=False,
        )
        students_total = getattr(students_result, "count", None)
        if students_total is None:
            students_total = len(students)

        leads = [LeadResponse(**row) for row in (leads_result.data or [])]

        belt_ladders = [
            self._build_ladder_response(ladder_row)
            for ladder_row in (ladders_result.data or [])
        ]
        primary_belt_ladder = belt_ladders[0] if belt_ladders else None

        studio = DashboardBootstrapStudioSummary(**studio_result.data)

        timings = dict([studio_timing, students_timing, leads_timing, ladders_timing, programs_timing])
        timings["total"] = (time.perf_counter() - total_started) * 1000

        return (
            DashboardBootstrapResponse(
                auth=auth,
                studio=studio,
                studio_name=studio.name,
                students=students,
                students_total=students_total,
                students_page_size=self.STUDENTS_BOOTSTRAP_PAGE_SIZE,
                students_may_be_partial=students_total > len(students),
                programs=programs,
                leads=leads,
                belt_ladders=belt_ladders,
                primary_belt_ladder=primary_belt_ladder,
            ),
            timings,
        )
