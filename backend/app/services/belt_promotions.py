from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.belt import DemoteStudent, PromoteStudent, PromotionResponse
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


class BeltPromotionRecorder:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    async def promote_student(
        self, data: PromoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        return self._record_transition(data, studio_id, actor_id, "promotion", data.notes)

    async def demote_student(
        self, data: DemoteStudent, studio_id: str, actor_id: str
    ) -> PromotionResponse:
        return self._record_transition(data, studio_id, actor_id, "demotion", data.reason)

    def _record_transition(
        self,
        data: PromoteStudent | DemoteStudent,
        studio_id: str,
        actor_id: str,
        kind: str,
        notes: str | None,
    ) -> PromotionResponse:
        # SQL resolves context and checks replay under the operation lock, before
        # current-rank validation. Pre-reading those facts would race a retry.
        try:
            result = execute_required_rpc(self.supabase, "record_student_rank_transition_v3", {
                "p_studio_id": studio_id,
                "p_student_id": data.student_id,
                "p_student_program_membership_id": data.student_program_membership_id,
                "p_program_id": data.program_id,
                "p_to_rank_id": data.to_rank_id,
                "p_actor_id": actor_id,
                "p_notes": notes,
                "p_transition_kind": kind,
                "p_operation_id": str(data.operation_id or uuid4()),
            })
        except PostgrestAPIError as exc:
            status_code = {
                ("22023", "rank_transition_conflict"): 409,
                ("22023", "rank_transition_invalid"): 400,
                ("P0001", "rank_transition_invalid"): 400,
                ("P0002", "rank_transition_not_found"): 404,
            }.get((exc.code, exc.details))
            if status_code is None:
                raise
            # Only our owned domain markers may expose their static message.
            # Unknown provider/trigger errors retain their server-error behavior.
            detail = (
                "This rank change could not be verified against the recorded history. "
                "Check the student's history before trying again."
                if status_code == 409 else exc.message
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

        row = first_rpc_row(result)
        if row is None:
            raise HTTPException(status_code=500, detail="Failed to record rank transition")
        return PromotionResponse.model_validate({
            **row,
            "from_rank_name": row.get("from_rank_name_snapshot"),
            "to_rank_name": row.get("to_rank_name_snapshot"),
        })
