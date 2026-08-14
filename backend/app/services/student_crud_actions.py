from __future__ import annotations

import uuid
from typing import Any, Callable

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.student import (
    GuardianResponse,
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
        create_signed_photo_url: Callable[[str], str | None],
    ):
        self.supabase = supabase
        self.membership_store = membership_store
        self.prepare_student_write = prepare_student_write
        self.row_to_response = row_to_response
        self.create_signed_photo_url = create_signed_photo_url

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

        result = execute_required_rpc(self.supabase, "write_student_profile_v2_atomic", {
            "p_student_id": student_id,
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_student": student_dict,
            "p_program_ids": program_ids,
            "p_guardians": [guardian.model_dump() for guardian in guardians_data],
            "p_replace_programs": True,
            "p_audit_action": "student.created",
        })
        payload = first_rpc_row(result)
        if not payload or not isinstance(payload.get("result_student"), dict):
            raise HTTPException(status_code=500, detail="Failed to create student")
        return self._write_response(payload)

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
        try:
            result = execute_required_rpc(self.supabase, "write_student_profile_v2_atomic", {
                "p_student_id": student_id,
                "p_studio_id": studio_id,
                "p_actor_id": actor_id,
                "p_student": update_dict,
                "p_program_ids": program_ids,
                "p_guardians": [],
                "p_replace_programs": program_ids is not None,
                "p_audit_action": "student.updated",
            })
        except PostgrestAPIError as exc:
            message = (getattr(exc, "message", None) or str(exc)).lower()
            if getattr(exc, "code", None) == "P0001" and (
                "student not found for update" in message
                or "student id already belongs to another studio" in message
            ):
                raise HTTPException(status_code=404, detail="Student not found") from exc
            raise
        payload = first_rpc_row(result)
        if not payload or not isinstance(payload.get("result_student"), dict):
            raise HTTPException(status_code=404, detail="Student not found")

        return self._write_response(payload)

    def _write_response(self, payload: dict) -> StudentResponse:
        student = payload["result_student"]
        guardians = [
            GuardianResponse.model_validate(row)
            for row in payload.get("result_guardians") or []
        ]
        memberships = [
            StudentProgramMembershipResponse.model_validate(row)
            for row in payload.get("result_program_memberships") or []
        ]
        photo_url = None
        if student.get("photo_path"):
            try:
                photo_url = self.create_signed_photo_url(student["photo_path"])
            except Exception:
                # The write has committed. Storage signing must be best-effort
                # so a transient failure cannot invite a duplicate retry.
                photo_url = None
        return self.row_to_response(
            student,
            guardians=guardians,
            memberships=memberships,
            photo_url=photo_url,
        )

    async def soft_delete_student(
        self, student_id: str, studio_id: str, actor_id: str
    ) -> None:
        result = execute_required_rpc(self.supabase, "soft_delete_student_atomic", {
            "p_student_id": student_id,
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
        })
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")
