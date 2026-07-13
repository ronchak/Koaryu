from typing import Any, Optional

from fastapi import HTTPException

from app.schemas.belt import DemoteStudent, PromoteStudent, PromotionResponse


class BeltPromotionRecorder:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    async def promote_student(
        self, data: PromoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        target_rank_result = (
            self.supabase.table("belt_ranks")
            .select("id, ladder_id")
            .eq("id", data.to_rank_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not target_rank_result.data:
            raise HTTPException(status_code=404, detail="Target belt rank not found")
        target_rank = target_rank_result.data

        target_ladder_result = (
            self.supabase.table("belt_ladders")
            .select("id, program_id")
            .eq("id", target_rank["ladder_id"])
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not target_ladder_result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        target_ladder = target_ladder_result.data

        student_result = (
            self.supabase.table("students")
            .select("program_id, current_belt_rank_id")
            .eq("id", data.student_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not student_result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        student_program_id = student_result.data.get("program_id")
        membership = None
        target_program_id = data.program_id or target_ladder.get("program_id") or student_program_id
        if data.student_program_membership_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, current_belt_rank_id, status, ended_at")
                .eq("id", data.student_program_membership_id)
                .eq("student_id", data.student_id)
                .eq("studio_id", studio_id)
                .maybe_single()
                .execute()
            )
            membership = membership_result.data
        elif target_program_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, current_belt_rank_id, status, ended_at")
                .eq("student_id", data.student_id)
                .eq("studio_id", studio_id)
                .eq("program_id", target_program_id)
                .in_("status", ["active", "paused"])
                .is_("ended_at", "null")
                .maybe_single()
                .execute()
            )
            membership = membership_result.data

        if target_ladder.get("program_id"):
            if not membership or membership.get("program_id") != target_ladder.get("program_id"):
                raise HTTPException(
                    status_code=400,
                    detail="This student does not belong to the selected program ladder.",
                )

        if membership and membership.get("ended_at"):
            raise HTTPException(status_code=400, detail="Cannot promote an ended program membership.")

        from_rank_id = (
            membership.get("current_belt_rank_id")
            if membership
            else student_result.data.get("current_belt_rank_id")
        )
        current_rank = None
        if from_rank_id:
            current_rank_result = (
                self.supabase.table("belt_ranks")
                .select("id, ladder_id")
                .eq("id", from_rank_id)
                .eq("studio_id", studio_id)
                .single()
                .execute()
            )
            current_rank = current_rank_result.data
            if not current_rank:
                raise HTTPException(status_code=404, detail="Current belt rank not found")
            if current_rank["ladder_id"] != target_rank["ladder_id"]:
                raise HTTPException(
                    status_code=400,
                    detail="Promotions must stay within the student's current belt ladder.",
                )

        ladder_ranks_result = (
            self.supabase.table("belt_ranks")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("ladder_id", target_rank["ladder_id"])
            .order("display_order")
            .execute()
        )
        ladder_rank_ids = [rank["id"] for rank in (ladder_ranks_result.data or []) if rank.get("id")]
        if not ladder_rank_ids:
            raise HTTPException(status_code=400, detail="The selected ladder has no ranks configured.")

        if from_rank_id:
            try:
                current_index = ladder_rank_ids.index(from_rank_id)
            except ValueError as exc:
                raise HTTPException(
                    status_code=400,
                    detail="The student's current rank is not part of the selected ladder.",
                ) from exc
            expected_next_rank_id = (
                ladder_rank_ids[current_index + 1]
                if current_index + 1 < len(ladder_rank_ids)
                else None
            )
            if expected_next_rank_id != data.to_rank_id:
                raise HTTPException(
                    status_code=400,
                    detail="Students can only be promoted to the next rank in their current ladder.",
                )
        elif ladder_rank_ids[0] != data.to_rank_id:
            raise HTTPException(
                status_code=400,
                detail="Unranked students can only be assigned the first rank in the selected ladder.",
            )

        promo = {
            "studio_id": studio_id,
            "student_id": data.student_id,
            "student_program_membership_id": membership.get("id") if membership else None,
            "program_id": membership.get("program_id") if membership else target_ladder.get("program_id"),
            "from_rank_id": from_rank_id,
            "to_rank_id": data.to_rank_id,
            "promoted_by": actor_id,
            "notes": data.notes,
        }
        promotion = self._record_promotion_atomic(
            promo,
            student_program_id=student_program_id,
        )
        return PromotionResponse(**promotion)

    async def demote_student(
        self, data: DemoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        target_rank_result = (
            self.supabase.table("belt_ranks")
            .select("id, ladder_id")
            .eq("id", data.to_rank_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not target_rank_result.data:
            raise HTTPException(status_code=404, detail="Target belt rank not found")
        target_rank = target_rank_result.data

        target_ladder_result = (
            self.supabase.table("belt_ladders")
            .select("id, program_id")
            .eq("id", target_rank["ladder_id"])
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not target_ladder_result.data:
            raise HTTPException(status_code=404, detail="Belt ladder not found")
        target_ladder = target_ladder_result.data

        student_result = (
            self.supabase.table("students")
            .select("program_id, current_belt_rank_id")
            .eq("id", data.student_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        if not student_result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        student_program_id = student_result.data.get("program_id")
        membership = None
        target_program_id = data.program_id or target_ladder.get("program_id") or student_program_id
        if data.student_program_membership_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, current_belt_rank_id, status, ended_at")
                .eq("id", data.student_program_membership_id)
                .eq("student_id", data.student_id)
                .eq("studio_id", studio_id)
                .maybe_single()
                .execute()
            )
            membership = membership_result.data
        elif target_program_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, current_belt_rank_id, status, ended_at")
                .eq("student_id", data.student_id)
                .eq("studio_id", studio_id)
                .eq("program_id", target_program_id)
                .in_("status", ["active", "paused"])
                .is_("ended_at", "null")
                .maybe_single()
                .execute()
            )
            membership = membership_result.data

        if target_ladder.get("program_id"):
            if not membership or membership.get("program_id") != target_ladder.get("program_id"):
                raise HTTPException(
                    status_code=400,
                    detail="This student does not belong to the selected program ladder.",
                )

        if membership and membership.get("ended_at"):
            raise HTTPException(status_code=400, detail="Cannot demote an ended program membership.")

        from_rank_id = (
            membership.get("current_belt_rank_id")
            if membership
            else student_result.data.get("current_belt_rank_id")
        )
        if not from_rank_id:
            raise HTTPException(status_code=400, detail="An unranked student cannot be demoted.")

        current_rank_result = (
            self.supabase.table("belt_ranks")
            .select("id, ladder_id")
            .eq("id", from_rank_id)
            .eq("studio_id", studio_id)
            .single()
            .execute()
        )
        current_rank = current_rank_result.data
        if not current_rank:
            raise HTTPException(status_code=404, detail="Current belt rank not found")
        if current_rank["ladder_id"] != target_rank["ladder_id"]:
            raise HTTPException(
                status_code=400,
                detail="Demotions must stay within the student's current belt ladder.",
            )

        ladder_ranks_result = (
            self.supabase.table("belt_ranks")
            .select("id")
            .eq("studio_id", studio_id)
            .eq("ladder_id", target_rank["ladder_id"])
            .order("display_order")
            .execute()
        )
        ladder_rank_ids = [rank["id"] for rank in (ladder_ranks_result.data or []) if rank.get("id")]
        try:
            current_index = ladder_rank_ids.index(from_rank_id)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail="The student's current rank is not part of the selected ladder.",
            ) from exc

        expected_previous_rank_id = ladder_rank_ids[current_index - 1] if current_index > 0 else None
        if expected_previous_rank_id != data.to_rank_id:
            raise HTTPException(
                status_code=400,
                detail="Students can only be demoted to the previous rank in their current ladder.",
            )

        demotion = self._record_demotion_atomic(
            {
                "studio_id": studio_id,
                "student_id": data.student_id,
                "student_program_membership_id": membership.get("id") if membership else None,
                "program_id": membership.get("program_id") if membership else target_ladder.get("program_id"),
                "from_rank_id": from_rank_id,
                "to_rank_id": data.to_rank_id,
                "demoted_by": actor_id,
                "reason": data.reason.strip(),
            },
            student_program_id=student_program_id,
        )
        return PromotionResponse(**demotion)

    def _record_promotion_atomic(
        self, promo: dict[str, Any], *, student_program_id: Optional[str]
    ) -> dict[str, Any]:
        result = self.supabase.rpc("record_student_promotion", {
            "p_studio_id": promo["studio_id"],
            "p_student_id": promo["student_id"],
            "p_student_program_membership_id": promo.get("student_program_membership_id"),
            "p_program_id": promo.get("program_id") or student_program_id,
            "p_from_rank_id": promo.get("from_rank_id"),
            "p_to_rank_id": promo["to_rank_id"],
            "p_promoted_by": promo.get("promoted_by"),
            "p_notes": promo.get("notes"),
        }).execute()
        if isinstance(result.data, list):
            promotion = result.data[0] if result.data else None
        else:
            promotion = result.data
        if not promotion:
            raise HTTPException(status_code=500, detail="Failed to record promotion")
        return promotion

    def _record_demotion_atomic(
        self, demotion: dict[str, Any], *, student_program_id: Optional[str]
    ) -> dict[str, Any]:
        result = self.supabase.rpc("record_student_demotion", {
            "p_studio_id": demotion["studio_id"],
            "p_student_id": demotion["student_id"],
            "p_student_program_membership_id": demotion.get("student_program_membership_id"),
            "p_program_id": demotion.get("program_id") or student_program_id,
            "p_from_rank_id": demotion["from_rank_id"],
            "p_to_rank_id": demotion["to_rank_id"],
            "p_demoted_by": demotion["demoted_by"],
            "p_reason": demotion["reason"],
        }).execute()
        if isinstance(result.data, list):
            row = result.data[0] if result.data else None
        else:
            row = result.data
        if not row:
            raise HTTPException(status_code=500, detail="Failed to record demotion")
        return row
