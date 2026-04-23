import asyncio
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.belt import BeltLadderResponse, BeltRankResponse
from app.schemas.dashboard_bootstrap import (
    DashboardBootstrapResponse,
    DashboardBootstrapStudioSummary,
)
from app.schemas.lead import LeadResponse
from app.schemas.student import StudentResponse
from app.services.auth_service import AuthService


class DashboardBootstrapService:
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
            .select("*")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .order("legal_last_name")
            .order("legal_first_name")
            .limit(200)
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

    def _fetch_belt_ladders(self, studio_id: str):
        return (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .order("created_at")
            .execute()
        )

    async def get_dashboard_bootstrap(
        self,
        user_id: str,
        requested_studio_id: Optional[str] = None,
    ) -> DashboardBootstrapResponse:
        auth = await AuthService(self.supabase).get_user_profile(user_id, requested_studio_id)

        if not auth.studio_id:
            return DashboardBootstrapResponse(auth=auth)

        studio_id = auth.studio_id

        studio_result, students_result, leads_result, ladders_result = await asyncio.gather(
            asyncio.to_thread(self._fetch_studio_summary, studio_id),
            asyncio.to_thread(self._fetch_students, studio_id),
            asyncio.to_thread(self._fetch_leads, studio_id),
            asyncio.to_thread(self._fetch_belt_ladders, studio_id),
        )

        if not studio_result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Studio not found",
            )

        students = [
            StudentResponse(
                **{
                    **{key: value for key, value in row.items() if key not in ("deleted_at",)},
                    "tags": row.get("tags") or [],
                },
                guardians=[],
            )
            for row in (students_result.data or [])
        ]

        leads = [LeadResponse(**row) for row in (leads_result.data or [])]

        belt_ladders = [
            self._build_ladder_response(ladder_row)
            for ladder_row in (ladders_result.data or [])
        ]
        primary_belt_ladder = belt_ladders[0] if belt_ladders else None

        studio = DashboardBootstrapStudioSummary(**studio_result.data)

        return DashboardBootstrapResponse(
            auth=auth,
            studio=studio,
            studio_name=studio.name,
            students=students,
            leads=leads,
            belt_ladders=belt_ladders,
            primary_belt_ladder=primary_belt_ladder,
        )
