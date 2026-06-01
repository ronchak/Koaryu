from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import HTTPException

from app.schemas.student import (
    GuardianResponse,
    StudentCreate,
    StudentProgramMembershipResponse,
    StudentResponse,
    StudentUpdate,
)
from app.services.student_program_memberships import StudentProgramMembershipStore
from app.services.studio_scope import ensure_optional_studio_record


class StudentCrudActions:
    def __init__(
        self,
        *,
        supabase: Any,
        membership_store: StudentProgramMembershipStore,
        prepare_student_write: Callable[..., dict],
        row_to_response: Callable[..., StudentResponse],
        fetch_memberships_for_student: Callable[[str], list[StudentProgramMembershipResponse]],
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
        student_dict["program_id"] = program_ids[0]
        student_dict["studio_id"] = studio_id
        student_dict = self.prepare_student_write(student_dict, set_default_is_minor=True)

        result = self.supabase.table("students").insert(student_dict).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create student")

        student = result.data[0]
        self.membership_store.replace_active_memberships(
            student["id"],
            studio_id,
            program_ids,
            current_belt_rank_id=student.get("current_belt_rank_id"),
            started_at=student.get("membership_start_date"),
        )

        guardian_responses = []
        for guardian in guardians_data:
            guardian_dict = guardian.model_dump()
            guardian_dict["studio_id"] = studio_id
            guardian_result = self.supabase.table("guardians").insert(guardian_dict).execute()
            if guardian_result.data:
                guardian_id = guardian_result.data[0]["id"]
                self.supabase.table("student_guardians").insert({
                    "student_id": student["id"],
                    "guardian_id": guardian_id,
                }).execute()
                guardian_responses.append(GuardianResponse(**guardian_result.data[0]))

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.created",
            "entity_type": "student",
            "entity_id": student["id"],
            "metadata": {"name": f"{data.legal_first_name} {data.legal_last_name}"},
        }).execute()

        return self.row_to_response(student, guardians=guardian_responses)

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

        result = (
            self.supabase.table("students")
            .update(update_dict)
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")
        if program_ids is not None:
            self.membership_store.replace_active_memberships(
                student_id,
                studio_id,
                program_ids,
                current_belt_rank_id=update_dict.get("current_belt_rank_id") or result.data[0].get("current_belt_rank_id"),
                started_at=result.data[0].get("membership_start_date"),
                )
        elif "current_belt_rank_id" in update_dict:
            memberships = self.fetch_memberships_for_student(student_id)
            active_program_ids = [
                membership.program_id
                for membership in memberships
                if membership.status in {"active", "paused"} and not membership.ended_at
            ]
            if active_program_ids:
                self.membership_store.replace_active_memberships(
                    student_id,
                    studio_id,
                    active_program_ids,
                    current_belt_rank_id=result.data[0].get("current_belt_rank_id"),
                    started_at=result.data[0].get("membership_start_date"),
                )

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.updated",
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": update_dict,
        }).execute()

        return self.row_to_response(result.data[0])

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
