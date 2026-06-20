from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException
from supabase import Client

from app.schemas.student import (
    StudentProgramMembershipCreate,
    StudentProgramMembershipResponse,
    StudentProgramMembershipUpdate,
)
from app.services.program_service import ProgramService
from app.services.student_program_memberships import StudentProgramMembershipStore
from app.services.student_response_builder import StudentResponseBuilder


class StudentMembershipActions:
    def __init__(
        self,
        supabase: Client,
        membership_store: StudentProgramMembershipStore,
        response_builder: StudentResponseBuilder,
    ):
        self.supabase = supabase
        self.membership_store = membership_store
        self.response_builder = response_builder

    async def list(
        self,
        student_id: str,
        studio_id: str,
    ) -> list[StudentProgramMembershipResponse]:
        self._ensure_student_exists(student_id, studio_id)
        return self.response_builder.fetch_memberships_for_student(student_id, studio_id)

    async def add(
        self,
        student_id: str,
        data: StudentProgramMembershipCreate,
        studio_id: str,
        actor_id: str,
    ) -> StudentProgramMembershipResponse:
        self._ensure_student_exists(student_id, studio_id)
        ProgramService(self.supabase).ensure_program_active(studio_id, data.program_id)
        row = self.membership_store.membership_write_payload(data.model_dump())
        row["student_id"] = student_id
        row["studio_id"] = studio_id
        result = self.supabase.table("student_program_memberships").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add student program membership")

        self._write_audit_log(
            studio_id,
            actor_id,
            "student.program_added",
            "student",
            student_id,
            {"program_id": data.program_id},
        )
        self._sync_active_programs(student_id, studio_id)
        return self.response_builder.membership_row_to_response(result.data[0])

    async def update(
        self,
        student_id: str,
        membership_id: str,
        data: StudentProgramMembershipUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StudentProgramMembershipResponse:
        self._ensure_student_exists(student_id, studio_id)
        update_dict = self.membership_store.membership_write_payload(data.model_dump(exclude_unset=True))
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        if update_dict.get("status") == "ended" and not update_dict.get("ended_at"):
            update_dict["ended_at"] = datetime.now(timezone.utc).date().isoformat()
        if update_dict.get("status") in {"active", "paused"}:
            update_dict["ended_at"] = None

        result = (
            self.supabase.table("student_program_memberships")
            .update(update_dict)
            .eq("id", membership_id)
            .eq("student_id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student program membership not found")

        self._write_audit_log(
            studio_id,
            actor_id,
            "student.program_updated",
            "student_program_membership",
            membership_id,
            update_dict,
        )
        self._sync_active_programs(student_id, studio_id)
        return self.response_builder.membership_row_to_response(result.data[0])

    async def remove(
        self,
        student_id: str,
        membership_id: str,
        studio_id: str,
        actor_id: str,
    ) -> None:
        self._ensure_student_exists(student_id, studio_id)
        now = datetime.now(timezone.utc).date().isoformat()
        result = (
            self.supabase.table("student_program_memberships")
            .update({"status": "ended", "ended_at": now, "current_belt_rank_id": None})
            .eq("id", membership_id)
            .eq("student_id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student program membership not found")

        self._write_audit_log(
            studio_id,
            actor_id,
            "student.program_removed",
            "student_program_membership",
            membership_id,
            {"student_id": student_id},
        )
        active_program_ids = self._active_program_ids(student_id, studio_id)
        if not active_program_ids:
            active_program_ids = [ProgramService(self.supabase).get_unassigned_program_id(studio_id)]
            self.membership_store.replace_active_memberships(student_id, studio_id, active_program_ids)
            return
        self.membership_store.sync_legacy_program_fields(student_id, studio_id, active_program_ids)

    def _ensure_student_exists(self, student_id: str, studio_id: str) -> None:
        result = (
            self.supabase.table("students")
            .select("id")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")

    def _sync_active_programs(self, student_id: str, studio_id: str) -> None:
        active_program_ids = self._active_program_ids(student_id, studio_id)
        if active_program_ids:
            self.membership_store.sync_legacy_program_fields(student_id, studio_id, active_program_ids)

    def _active_program_ids(self, student_id: str, studio_id: str) -> list[str]:
        return [
            membership.program_id
            for membership in self.response_builder.fetch_memberships_for_student(student_id, studio_id)
            if membership.status in {"active", "paused"} and not membership.ended_at
        ]

    def _write_audit_log(
        self,
        studio_id: str,
        actor_id: str,
        action: str,
        entity_type: str,
        entity_id: str,
        metadata: dict,
    ) -> None:
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "metadata": metadata,
        }).execute()
