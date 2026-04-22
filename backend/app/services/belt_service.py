import json
from typing import Any, Optional
from datetime import datetime, timezone
from supabase import Client
from fastapi import HTTPException
from app.schemas.belt import (
    BeltLadderCreate, BeltLadderUpdate, BeltLadderSyncRequest, BeltLadderResponse,
    BeltRankCreate, BeltRankUpdate, BeltRankResponse,
    PromoteStudent, PromotionResponse,
    EligibilityEntry,
)
from app.services.studio_scope import ensure_optional_studio_record, ensure_studio_record


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
        result = (
            self.supabase.table("belt_ladders")
            .select("*, belt_ranks(*)")
            .eq("studio_id", studio_id)
            .order("created_at")
            .execute()
        )
        return [self._build_ladder_response(row) for row in (result.data or [])]

    async def create_ladder(
        self, data: BeltLadderCreate, studio_id: str, actor_id: str
    ) -> BeltLadderResponse:
        row = data.model_dump()
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            row.get("program_id"),
            studio_id,
            "Program not found",
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
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            update_dict.get("program_id"),
            studio_id,
            "Program not found",
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

    async def get_eligibility(
        self, studio_id: str, ladder_id: Optional[str] = None
    ) -> list[EligibilityEntry]:
        """Compute promotion eligibility for all active students."""
        # Get all ranks in order
        rank_query = (
            self.supabase.table("belt_ranks")
            .select("*")
            .eq("studio_id", studio_id)
            .order("display_order")
        )
        if ladder_id:
            rank_query = rank_query.eq("ladder_id", ladder_id)
        ranks_result = rank_query.execute()
        ranks = ranks_result.data or []

        if not ranks:
            return []

        # Build rank lookup and next-rank map
        rank_map = {r["id"]: r for r in ranks}
        next_rank_map: dict[str, dict] = {}
        for i, r in enumerate(ranks):
            if i + 1 < len(ranks):
                next_rank_map[r["id"]] = ranks[i + 1]

        # Get active students with belt ranks
        students_result = (
            self.supabase.table("students")
            .select("id, legal_first_name, legal_last_name, preferred_name, current_belt_rank_id")
            .eq("studio_id", studio_id)
            .eq("status", "active")
            .is_("deleted_at", "null")
            .execute()
        )

        entries = []
        now = datetime.now(timezone.utc)

        for s in students_result.data or []:
            current_rank_id = s.get("current_belt_rank_id")
            current_rank = rank_map.get(current_rank_id) if current_rank_id else None

            # If no rank, the next rank is the first one
            if not current_rank:
                next_rank = ranks[0] if ranks else None
                if not next_rank:
                    continue
                entries.append(EligibilityEntry(
                    student_id=s["id"],
                    student_name=f"{s.get('preferred_name') or s['legal_first_name']} {s['legal_last_name']}",
                    current_rank_id=None,
                    current_rank_name=None,
                    current_rank_color=None,
                    next_rank_id=next_rank["id"],
                    next_rank_name=next_rank["name"],
                    next_rank_color=next_rank["color_hex"],
                    classes_since_promo=0,
                    classes_required=next_rank["min_classes"],
                    days_at_rank=0,
                    days_required=next_rank["min_months"] * 30,
                    classes_met=next_rank["min_classes"] == 0,
                    time_met=next_rank["min_months"] == 0,
                    needs_approval=next_rank["requires_approval"],
                    is_eligible=next_rank["min_classes"] == 0 and next_rank["min_months"] == 0,
                ))
                continue

            next_rank = next_rank_map.get(current_rank_id)
            if not next_rank:
                continue  # Already at highest rank

            # Count attendance since last promotion
            promo_result = (
                self.supabase.table("promotions")
                .select("promoted_at")
                .eq("student_id", s["id"])
                .eq("studio_id", studio_id)
                .order("promoted_at", desc=True)
                .limit(1)
                .execute()
            )
            last_promo_date = None
            if promo_result.data:
                last_promo_date = promo_result.data[0]["promoted_at"]

            # Count classes attended since last promotion
            att_query = (
                self.supabase.table("attendance")
                .select("id", count="exact")
                .eq("student_id", s["id"])
                .eq("studio_id", studio_id)
                .neq("status", "absent")
            )
            if last_promo_date:
                att_query = att_query.gte("checked_in_at", last_promo_date)
            att_result = att_query.execute()
            classes_since = att_result.count or 0

            # Days at current rank
            if last_promo_date:
                promo_dt = datetime.fromisoformat(last_promo_date.replace("Z", "+00:00"))
                days_at = (now - promo_dt).days
            else:
                days_at = 0

            classes_req = next_rank["min_classes"]
            days_req = next_rank["min_months"] * 30
            classes_met = classes_since >= classes_req
            time_met = days_at >= days_req
            needs_approval = next_rank["requires_approval"]

            entries.append(EligibilityEntry(
                student_id=s["id"],
                student_name=f"{s.get('preferred_name') or s['legal_first_name']} {s['legal_last_name']}",
                current_rank_id=current_rank_id,
                current_rank_name=current_rank["name"],
                current_rank_color=current_rank["color_hex"],
                next_rank_id=next_rank["id"],
                next_rank_name=next_rank["name"],
                next_rank_color=next_rank["color_hex"],
                classes_since_promo=classes_since,
                classes_required=classes_req,
                days_at_rank=days_at,
                days_required=days_req,
                classes_met=classes_met,
                time_met=time_met,
                needs_approval=needs_approval,
                is_eligible=classes_met and time_met and not needs_approval,
            ))

        return entries

    # ---- Promote ----

    async def promote_student(
        self, data: PromoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        ensure_studio_record(
            self.supabase,
            "belt_ranks",
            data.to_rank_id,
            studio_id,
            "Target belt rank not found",
        )

        # Get current rank
        student_result = (
            self.supabase.table("students")
            .select("current_belt_rank_id")
            .eq("id", data.student_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not student_result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        from_rank_id = student_result.data.get("current_belt_rank_id")

        # Create promotion record
        promo = {
            "studio_id": studio_id,
            "student_id": data.student_id,
            "from_rank_id": from_rank_id,
            "to_rank_id": data.to_rank_id,
            "promoted_by": actor_id,
            "notes": data.notes,
        }
        result = self.supabase.table("promotions").insert(promo).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record promotion")

        # Update student's current rank
        self.supabase.table("students").update(
            {"current_belt_rank_id": data.to_rank_id}
        ).eq("id", data.student_id).execute()

        # Audit log
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.promoted",
            "entity_type": "promotion",
            "entity_id": result.data[0]["id"],
            "metadata": {
                "student_id": data.student_id,
                "from_rank_id": from_rank_id,
                "to_rank_id": data.to_rank_id,
            },
        }).execute()

        return PromotionResponse(**result.data[0])
