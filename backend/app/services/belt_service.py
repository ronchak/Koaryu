import json
from datetime import datetime
from typing import Any, Callable, Optional

from supabase import Client
from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from app.schemas.belt import (
    BeltLadderCreate, BeltLadderUpdate, BeltLadderSyncRequest, BeltLadderResponse,
    BeltRankCreate, BeltRankUpdate, BeltRankResponse,
    DemoteStudent, PromoteStudent, PromotionResponse,
    EligibilityEntry,
)
from app.services.belt_eligibility import BeltEligibilityCalculator
from app.services.belt_promotions import BeltPromotionRecorder
from app.services.studio_scope import ensure_studio_record
from app.services.program_service import ProgramService


class BeltService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def _build_ladder_response(self, ladder_row: dict[str, Any]) -> BeltLadderResponse:
        ladder_copy = dict(ladder_row)
        ranks_data = ladder_copy.pop("ranks", None)
        if ranks_data is None:
            ranks_data = ladder_copy.pop("belt_ranks", []) or []
        if isinstance(ranks_data, str):
            ranks_data = json.loads(ranks_data)
        ranks = sorted(
            [BeltRankResponse(**rank) for rank in ranks_data],
            key=lambda item: item.display_order,
        )
        return BeltLadderResponse(**ladder_copy, ranks=ranks)

    def _build_synced_ladder_response(self, rpc_data: Any) -> BeltLadderResponse:
        if isinstance(rpc_data, list):
            if not rpc_data:
                raise HTTPException(status_code=500, detail="Failed to sync belt ladder")
            ladder_row = rpc_data[0]
        elif isinstance(rpc_data, dict):
            ladder_row = rpc_data
        else:
            raise HTTPException(status_code=500, detail="Failed to sync belt ladder")

        if not isinstance(ladder_row, dict):
            raise HTTPException(status_code=500, detail="Failed to sync belt ladder")

        return self._build_ladder_response(ladder_row)

    def _raise_sync_error(self, exc: Exception) -> None:
        detail = getattr(exc, "message", None) or str(exc) or "Failed to sync belt ladder"
        detail_lower = detail.lower()

        if "belt ladder not found" in detail_lower:
            status_code = 404
        elif any(
            token in detail_lower
            for token in (
                "referenced rank",
                "duplicate",
                "payload must be",
                "rank name is required",
                "must be non-negative",
                "invalid",
            )
        ):
            status_code = 400
        else:
            status_code = 500

        raise HTTPException(status_code=status_code, detail=detail) from exc

    async def _get_ladder(self, ladder_id: str, studio_id: str) -> BeltLadderResponse:
        result = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("id", ladder_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        return self._build_ladder_response(result.data)

    def _get_ladder_row(self, ladder_id: str, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table("belt_ladders")
            .select("*")
            .eq("id", ladder_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        return result.data

    # ---- Ladders ----

    async def list_ranks(
        self, studio_id: str, ladder_id: Optional[str] = None
    ) -> list[BeltRankResponse]:
        query = (
            self.supabase.table("belt_ranks")
            .select("*")
            .eq("studio_id", studio_id)
            .order("ladder_id")
            .order("display_order")
        )
        if ladder_id:
            query = query.eq("ladder_id", ladder_id)

        result = query.execute()
        return [BeltRankResponse(**rank) for rank in (result.data or [])]

    async def list_ladders(self, studio_id: str) -> list[BeltLadderResponse]:
        active_program_rows = (
            self.supabase.table("programs")
            .select("id, is_system, archived_at")
            .eq("studio_id", studio_id)
            .execute()
        )
        visible_program_ids = {
            row["id"]
            for row in (active_program_rows.data or [])
            if row.get("id") and not row.get("is_system") and not row.get("archived_at")
        }
        if not visible_program_ids:
            return []

        result = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .in_("program_id", list(visible_program_ids))
            .order("created_at")
            .execute()
        )
        return [self._build_ladder_response(row) for row in (result.data or [])]

    async def list_promotions(
        self,
        studio_id: str,
        student_id: Optional[str] = None,
        include_names: bool = True,
    ) -> list[PromotionResponse]:
        query = (
            self.supabase.table("promotions")
            .select("*")
            .eq("studio_id", studio_id)
            .order("promoted_at", desc=True)
        )
        if student_id:
            query = query.eq("student_id", student_id)

        result = query.execute()
        promotion_rows = result.data or []

        if not promotion_rows:
            return []

        if not include_names:
            return [PromotionResponse(**row) for row in promotion_rows]

        student_ids = sorted(
            {
                row["student_id"]
                for row in promotion_rows
                if row.get("student_id")
            }
        )
        rank_ids = sorted(
            {
                rank_id
                for row in promotion_rows
                for rank_id in (row.get("from_rank_id"), row.get("to_rank_id"))
                if rank_id
            }
        )

        students_by_id: dict[str, str] = {}
        ranks_by_id: dict[str, str] = {}

        if student_ids:
            students_result = (
                self.supabase.table("students")
                .select("id, legal_first_name, legal_last_name, preferred_name")
                .in_("id", student_ids)
                .eq("studio_id", studio_id)
                .execute()
            )
            students_by_id = {
                row["id"]: f'{row.get("preferred_name") or row.get("legal_first_name") or ""} {row.get("legal_last_name") or ""}'.strip()
                for row in (students_result.data or [])
            }

        if rank_ids:
            ranks_result = (
                self.supabase.table("belt_ranks")
                .select("id, name")
                .in_("id", rank_ids)
                .eq("studio_id", studio_id)
                .execute()
            )
            ranks_by_id = {
                row["id"]: row["name"]
                for row in (ranks_result.data or [])
            }

        return [
            PromotionResponse(
                **row,
                student_name=students_by_id.get(row["student_id"]),
                from_rank_name=ranks_by_id.get(row.get("from_rank_id")),
                to_rank_name=ranks_by_id.get(row["to_rank_id"]),
            )
            for row in promotion_rows
        ]

    async def create_ladder(
        self, data: BeltLadderCreate, studio_id: str, actor_id: str
    ) -> BeltLadderResponse:
        row = data.model_dump()
        program_id = row.get("program_id")
        if not program_id:
            raise HTTPException(
                status_code=400,
                detail="Create a program first. Each program owns exactly one belt configuration.",
            )
        ProgramService(self.supabase).ensure_program_active(studio_id, program_id)
        existing = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .eq("program_id", program_id)
            .order("created_at")
            .execute()
        )
        existing_rows = existing.data or []
        if existing_rows:
            raise HTTPException(
                status_code=409,
                detail="This program already has a belt configuration. Edit the existing program ranks instead of creating another one.",
            )
        row["studio_id"] = studio_id
        result = self.supabase.table("belt_ladders").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create ladder")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "belt_ladder.created",
            "entity_type": "belt_ladder",
            "entity_id": result.data[0]["id"],
            "metadata": {"name": data.name},
        }).execute()

        return BeltLadderResponse(**result.data[0], ranks=[])

    async def update_ladder(
        self,
        ladder_id: str,
        data: BeltLadderUpdate,
        studio_id: str,
        actor_id: str,
    ) -> BeltLadderResponse:
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")

        ensure_studio_record(
            self.supabase,
            "belt_ladders",
            ladder_id,
            studio_id,
            "Belt ladder not found",
        )
        ProgramService(self.supabase).ensure_program_active(studio_id, update_dict.get("program_id"))
        current_ladder = self._get_ladder_row(ladder_id, studio_id)
        if "program_id" in update_dict and update_dict.get("program_id") != current_ladder.get("program_id"):
            raise HTTPException(
                status_code=409,
                detail="A belt configuration cannot be moved to another program.",
            )
        if update_dict.get("program_id"):
            existing = (
                self.supabase.table("belt_ladders")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("program_id", update_dict["program_id"])
                .neq("id", ladder_id)
                .order("created_at")
                .execute()
            )
            if existing.data:
                raise HTTPException(
                    status_code=409,
                    detail="This program already has a belt ladder. Edit the existing ladder instead of assigning a second ladder to the same program.",
                )

        result = (
            self.supabase.table("belt_ladders")
            .update(update_dict)
            .eq("id", ladder_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")

        updated_ladder = result.data[0]
        if update_dict.get("name") and updated_ladder.get("program_id"):
            try:
                (
                    self.supabase.table("programs")
                    .update({"name": update_dict["name"]})
                    .eq("id", updated_ladder["program_id"])
                    .eq("studio_id", studio_id)
                    .execute()
                )
            except PostgrestAPIError:
                pass

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "belt_ladder.updated",
            "entity_type": "belt_ladder",
            "entity_id": ladder_id,
            "metadata": update_dict,
        }).execute()

        ranks = await self.list_ranks(studio_id, ladder_id)
        return BeltLadderResponse(**result.data[0], ranks=ranks)

    async def sync_ladder(
        self,
        ladder_id: str,
        data: BeltLadderSyncRequest,
        studio_id: str,
        actor_id: str,
    ) -> BeltLadderResponse:
        ensure_studio_record(
            self.supabase,
            "belt_ladders",
            ladder_id,
            studio_id,
            "Belt ladder not found",
        )

        sub_rank_term = data.sub_rank_term.strip() if data.sub_rank_term is not None else None
        if sub_rank_term == "":
            sub_rank_term = None

        sync_payload = [
            {
                "id": rank.id,
                "name": rank.name,
                "color_hex": rank.color_hex,
                "display_order": index,
                "min_classes": rank.min_classes,
                "min_months": rank.min_months,
                "requires_approval": rank.requires_approval,
                "is_tip": rank.is_tip,
                "tip_color_hex": rank.tip_color_hex if rank.is_tip else None,
            }
            for index, rank in enumerate(data.ranks)
        ]

        try:
            result = self.supabase.rpc(
                "sync_belt_ladder_ranks",
                {
                    "p_ladder_id": ladder_id,
                    "p_studio_id": studio_id,
                    "p_sub_rank_term": sub_rank_term,
                    "p_ranks": sync_payload,
                },
            ).execute()
        except Exception as exc:
            self._raise_sync_error(exc)

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "belt_ladder.synced",
            "entity_type": "belt_ladder",
            "entity_id": ladder_id,
            "metadata": {
                "rank_count": len(sync_payload),
                "sub_rank_term": sub_rank_term,
            },
        }).execute()

        return self._build_synced_ladder_response(result.data)

    # ---- Ranks ----

    async def create_rank(
        self, ladder_id: str, data: BeltRankCreate, studio_id: str
    ) -> BeltRankResponse:
        ensure_studio_record(
            self.supabase,
            "belt_ladders",
            ladder_id,
            studio_id,
            "Belt ladder not found",
        )
        row = data.model_dump()
        row["ladder_id"] = ladder_id
        row["studio_id"] = studio_id
        result = self.supabase.table("belt_ranks").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create rank")
        return BeltRankResponse(**result.data[0])

    async def update_rank(
        self, rank_id: str, data: BeltRankUpdate, studio_id: str
    ) -> BeltRankResponse:
        update_dict = data.model_dump(exclude_unset=True)
        result = (
            self.supabase.table("belt_ranks")
            .update(update_dict)
            .eq("id", rank_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Rank not found")
        return BeltRankResponse(**result.data[0])

    async def delete_rank(self, rank_id: str, studio_id: str) -> None:
        self.supabase.table("belt_ranks").delete().eq("id", rank_id).eq("studio_id", studio_id).execute()

    # ---- Eligibility ----

    @staticmethod
    def _chunked(values: list[str], size: int = 100) -> list[list[str]]:
        return BeltEligibilityCalculator._chunked(values, size)

    @staticmethod
    def _parse_datetime(value: Any) -> datetime:
        return BeltEligibilityCalculator._parse_datetime(value)

    def _fetch_paged(
        self,
        query_factory: Callable[[], Any],
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        return BeltEligibilityCalculator(self.supabase)._fetch_paged(query_factory, page_size)

    def _fetch_latest_promotions_by_context(
        self,
        studio_id: str,
        eligibility_contexts: list[dict[str, Any]],
    ) -> dict[str, Optional[str]]:
        return BeltEligibilityCalculator(self.supabase)._fetch_latest_promotions_by_context(
            studio_id,
            eligibility_contexts,
        )

    def _fetch_attendance_counts_by_student(
        self,
        studio_id: str,
        eligibility_contexts: list[dict[str, Any]],
        latest_promotions_by_context: dict[str, Optional[str]],
        ladder_meta: dict[str, dict[str, Any]],
    ) -> dict[str, int]:
        return BeltEligibilityCalculator(self.supabase)._fetch_attendance_counts_by_student(
            studio_id,
            eligibility_contexts,
            latest_promotions_by_context,
            ladder_meta,
        )

    async def get_eligibility(
        self, studio_id: str, ladder_id: Optional[str] = None
    ) -> list[EligibilityEntry]:
        return await BeltEligibilityCalculator(self.supabase).get_eligibility(studio_id, ladder_id)

    async def promote_student(
        self, data: PromoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        return await BeltPromotionRecorder(self.supabase).promote_student(data, studio_id, actor_id)

    async def demote_student(
        self, data: DemoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        return await BeltPromotionRecorder(self.supabase).demote_student(data, studio_id, actor_id)

    def _record_promotion_atomic(self, promo: dict[str, Any], *, student_program_id: Optional[str]) -> dict[str, Any]:
        return BeltPromotionRecorder(self.supabase)._record_promotion_atomic(
            promo,
            student_program_id=student_program_id,
        )
