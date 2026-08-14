from __future__ import annotations

from datetime import datetime, timezone
import uuid
from typing import Any, Callable

from fastapi import HTTPException

from app.schemas.student import (
    StudentCreate,
    StudentProgramMembershipResponse,
    StudentResponse,
    StudentUpdate,
)
from app.services.student_program_memberships import StudentProgramMembershipStore
from app.services.studio_scope import ensure_optional_studio_record
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


class StudentCrudActions:
    def __init__(
        self,
        *,
        supabase: Any,
        membership_store: StudentProgramMembershipStore,
        prepare_student_write: Callable[..., dict],
        row_to_response: Callable[..., StudentResponse],
        fetch_memberships_for_student: Callable[..., list[StudentProgramMembershipResponse]],
    ):
        self.supabase = supabase
        self.membership_store = membership_store
        self.prepare_student_write = prepare_student_write
        self.row_to_response = row_to_response
        self.fetch_memberships_for_student = fetch_memberships_for_student

    async def create_student(
        self, data: StudentCreate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        guardians_data = data.guardians
        raw_data = data.model_dump(exclude={"guardians"})
        program_ids = self.membership_store.normalize_program_ids_for_write(
            studio_id,
            raw_data.get("program_id"),
            raw_data.pop("program_ids", None),
        )
        student_dict = raw_data
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            program_ids[0] if program_ids else None,
            studio_id,
            "Program not found",
        )
        student_id = str(uuid.uuid4())
        student_dict["id"] = student_id
        student_dict["program_id"] = program_ids[0]
        student_dict["studio_id"] = studio_id
        student_dict = self.prepare_student_write(student_dict, set_default_is_minor=True)

        result = execute_required_rpc(self.supabase, "write_student_profile_atomic", {
            "p_student_id": student_id,
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_student": student_dict,
            "p_program_ids": program_ids,
            "p_guardians": [guardian.model_dump() for guardian in guardians_data],
            "p_replace_programs": True,
            "p_audit_action": "student.created",
        })
        student = first_rpc_row(result)
        if not student:
            raise HTTPException(status_code=500, detail="Failed to create student")
        return self._write_response(student, studio_id)

    async def get_student(self, student_id: str, studio_id: str) -> StudentResponse:
        result = (
            self.supabase.table("students")
            .select("*")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .maybe_single()
            .execute()
        )
        if not result or not result.data:
            raise HTTPException(status_code=404, detail="Student not found")
        return self.row_to_response(result.data)

    async def update_student(
        self, student_id: str, data: StudentUpdate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        program_ids_were_set = "program_ids" in update_dict or "program_id" in update_dict
        program_ids = None
        if program_ids_were_set:
            program_ids = self.membership_store.normalize_program_ids_for_write(
                studio_id,
                update_dict.get("program_id"),
                update_dict.pop("program_ids", None),
            )
            update_dict["program_id"] = program_ids[0]
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            update_dict.get("program_id"),
            studio_id,
            "Program not found",
        )

        update_dict = self.prepare_student_write(update_dict, set_default_is_minor=False)
        if program_ids is None and "current_belt_rank_id" in update_dict:
            memberships = self.fetch_memberships_for_student(student_id, studio_id)
            active_program_ids = [
                membership.program_id
                for membership in memberships
                if membership.status in {"active", "paused"} and not membership.ended_at
            ]
            if active_program_ids:
                primary_program_id = self._current_primary_program_id(
                    student_id,
                    studio_id,
                )
                program_ids = (
                    [primary_program_id]
                    + [
                        program_id
                        for program_id in active_program_ids
                        if program_id != primary_program_id
                    ]
                    if primary_program_id in active_program_ids
                    else active_program_ids
                )

        result = execute_required_rpc(self.supabase, "write_student_profile_atomic", {
            "p_student_id": student_id,
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_student": update_dict,
            "p_program_ids": program_ids,
            "p_guardians": [],
            "p_replace_programs": program_ids is not None,
            "p_audit_action": "student.updated",
        })
        student = first_rpc_row(result)
        if not student:
            raise HTTPException(status_code=404, detail="Student not found")

        return self._write_response(student, studio_id)

    def _current_primary_program_id(
        self,
        student_id: str,
        studio_id: str,
    ) -> str | None:
        result = (
            self.supabase.table("students")
            .select("program_id")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .maybe_single()
            .execute()
        )
        row = result.data if result else None
        return row.get("program_id") if isinstance(row, dict) else None

    def _write_response(self, student: dict, studio_id: str) -> StudentResponse:
        memberships = self.fetch_memberships_for_student(student["id"], studio_id)
        if not student.get("current_belt_rank_id"):
            primary_membership = next(
                (
                    membership
                    for membership in memberships
                    if membership.program_id == student.get("program_id")
                    and membership.status in {"active", "paused"}
                    and not membership.ended_at
                    and membership.current_belt_rank_id
                ),
                None,
            )
            if primary_membership:
                student = {
                    **student,
                    "current_belt_rank_id": primary_membership.current_belt_rank_id,
                }
        return self.row_to_response(student, memberships=memberships)

    async def soft_delete_student(
        self, student_id: str, studio_id: str, actor_id: str
    ) -> None:
        result = (
            self.supabase.table("students")
            .update({"deleted_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.deleted",
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": {},
        }).execute()
