from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import Client

from app.services.program_service import ProgramService


OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


def is_optional_student_membership_schema_error(exc: PostgrestAPIError) -> bool:
    return exc.code in OPTIONAL_MEMBERSHIP_SCHEMA_ERROR_CODES


class StudentProgramMembershipStore:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def rank_program_id(self, rank_id: Optional[str], studio_id: str) -> Optional[str]:
        if not rank_id:
            return None
        result = (
            self.supabase.table("belt_ranks")
            .select("id, belt_ladders!inner(program_id, studio_id)")
            .eq("id", rank_id)
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Current belt rank not found")
        ladder = result.data.get("belt_ladders") or {}
        if isinstance(ladder, list):
            ladder = ladder[0] if ladder else {}
        return ladder.get("program_id")

    def normalize_program_ids_for_write(
        self,
        studio_id: str,
        program_id: Optional[str],
        program_ids: Optional[list[str]],
    ) -> list[str]:
        values: list[str] = []
        if program_ids is not None:
            values.extend(program_ids)
        elif program_id:
            values.append(program_id)

        program_service = ProgramService(self.supabase)
        normalized = []
        seen: set[str] = set()
        for value in values:
            if value and value not in seen:
                program_service.ensure_program_active(studio_id, value)
                normalized.append(value)
                seen.add(value)

        if not normalized:
            normalized.append(program_service.get_unassigned_program_id(studio_id))

        return normalized

    @staticmethod
    def membership_write_payload(payload: dict) -> dict:
        next_payload = dict(payload)
        for key in ("started_at", "ended_at"):
            if next_payload.get(key):
                next_payload[key] = str(next_payload[key])
        return next_payload

    def sync_legacy_program_fields(
        self,
        student_id: str,
        studio_id: str,
        program_ids: list[str],
        current_belt_rank_id: Optional[str] = None,
    ) -> None:
        update_payload = {"program_id": program_ids[0] if program_ids else None}
        if current_belt_rank_id is not None:
            update_payload["current_belt_rank_id"] = current_belt_rank_id
        (
            self.supabase.table("students")
            .update(update_payload)
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )

    def replace_active_memberships(
        self,
        student_id: str,
        studio_id: str,
        program_ids: list[str],
        *,
        current_belt_rank_id: Optional[str] = None,
        started_at: Optional[str] = None,
    ) -> None:
        try:
            existing = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, status, ended_at")
                .eq("student_id", student_id)
                .eq("studio_id", studio_id)
                .is_("ended_at", "null")
                .execute()
            )
            existing_by_program = {
                row["program_id"]: row
                for row in existing.data or []
                if row.get("program_id")
            }
            desired = set(program_ids)
            now = datetime.now(timezone.utc).date().isoformat()

            for existing_program_id, row in existing_by_program.items():
                if existing_program_id not in desired:
                    (
                        self.supabase.table("student_program_memberships")
                        .update({"status": "ended", "ended_at": now, "current_belt_rank_id": None})
                        .eq("id", row["id"])
                        .eq("studio_id", studio_id)
                        .execute()
                    )

            rank_program_id = self.rank_program_id(current_belt_rank_id, studio_id) if current_belt_rank_id else None
            membership_rows = []
            for next_program_id in program_ids:
                rank_for_membership = (
                    current_belt_rank_id
                    if current_belt_rank_id and (rank_program_id in {None, next_program_id})
                    else None
                )
                row = existing_by_program.get(next_program_id)
                if row:
                    update_payload = {
                        "status": "active",
                        "ended_at": None,
                        "current_belt_rank_id": rank_for_membership,
                    }
                    if started_at:
                        update_payload["started_at"] = started_at
                    (
                        self.supabase.table("student_program_memberships")
                        .update(update_payload)
                        .eq("id", row["id"])
                        .eq("studio_id", studio_id)
                        .execute()
                    )
                    continue

                membership_rows.append({
                    "studio_id": studio_id,
                    "student_id": student_id,
                    "program_id": next_program_id,
                    "status": "active",
                    "started_at": started_at,
                    "current_belt_rank_id": rank_for_membership,
                })

            if membership_rows:
                self.supabase.table("student_program_memberships").insert(membership_rows).execute()
        except PostgrestAPIError as exc:
            if not is_optional_student_membership_schema_error(exc):
                raise

        self.sync_legacy_program_fields(student_id, studio_id, program_ids, current_belt_rank_id)
