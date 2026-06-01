from __future__ import annotations

from typing import Any

from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.program import ProgramUsageResponse


OPTIONAL_PROGRAM_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


def _is_optional_program_schema_error(exc: PostgrestAPIError) -> bool:
    return exc.code in OPTIONAL_PROGRAM_SCHEMA_ERROR_CODES


class ProgramUsageCalculator:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def _usage_for_programs(
        self,
        studio_id: str,
        program_ids: list[str],
    ) -> dict[str, ProgramUsageResponse]:
        usage = {program_id: ProgramUsageResponse() for program_id in program_ids}
        if not program_ids:
            return usage

        try:
            membership_rows = (
                self.supabase.table("student_program_memberships")
                .select("program_id, status, ended_at")
                .eq("studio_id", studio_id)
                .in_("program_id", program_ids)
                .execute()
            )
            memberships = membership_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            student_rows = (
                self.supabase.table("students")
                .select("program_id, status")
                .eq("studio_id", studio_id)
                .in_("program_id", program_ids)
                .is_("deleted_at", "null")
                .execute()
            )
            memberships = [
                {
                    "program_id": row.get("program_id"),
                    "status": row.get("status") or "active",
                    "ended_at": None,
                }
                for row in (student_rows.data or [])
            ]

        try:
            session_rows = (
                self.supabase.table("class_sessions")
                .select("program_id, status")
                .eq("studio_id", studio_id)
                .in_("program_id", program_ids)
                .execute()
            )
            sessions = session_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            sessions = []

        try:
            lead_rows = (
                self.supabase.table("leads")
                .select("program_id")
                .eq("studio_id", studio_id)
                .in_("program_id", program_ids)
                .execute()
            )
            leads = lead_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            leads = []

        try:
            ladder_rows = (
                self.supabase.table("belt_ladders")
                .select("program_id")
                .eq("studio_id", studio_id)
                .in_("program_id", program_ids)
                .execute()
            )
            ladders = ladder_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            ladders = []

        for row in memberships:
            program_id = row.get("program_id")
            if program_id not in usage:
                continue
            item = usage[program_id]
            item.student_count += 1
            if row.get("status") in {"active", "paused"} and not row.get("ended_at"):
                item.active_student_count += 1

        for row in sessions:
            program_id = row.get("program_id")
            if program_id not in usage:
                continue
            item = usage[program_id]
            item.class_count += 1
            if row.get("status") in {"scheduled", "in_progress"}:
                item.active_class_count += 1

        for row in leads:
            program_id = row.get("program_id")
            if program_id in usage:
                usage[program_id].lead_count += 1

        for row in ladders:
            program_id = row.get("program_id")
            if program_id in usage:
                usage[program_id].belt_ladder_count += 1

        return usage

    def _usage_for_program(self, program_id: str, studio_id: str) -> ProgramUsageResponse:
        try:
            membership_rows = (
                self.supabase.table("student_program_memberships")
                .select("id, status, ended_at")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            memberships = membership_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            student_rows = (
                self.supabase.table("students")
                .select("id, status")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .is_("deleted_at", "null")
                .execute()
            )
            memberships = [
                {"status": row.get("status") or "active", "ended_at": None}
                for row in (student_rows.data or [])
            ]

        try:
            session_rows = (
                self.supabase.table("class_sessions")
                .select("id, status")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            sessions = session_rows.data or []
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            sessions = []

        try:
            lead_rows = (
                self.supabase.table("leads")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            lead_count = len(lead_rows.data or [])
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            lead_count = 0

        try:
            ladder_rows = (
                self.supabase.table("belt_ladders")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .execute()
            )
            belt_ladder_count = len(ladder_rows.data or [])
        except PostgrestAPIError as exc:
            if not _is_optional_program_schema_error(exc):
                raise
            belt_ladder_count = 0

        return ProgramUsageResponse(
            student_count=len(memberships),
            active_student_count=len([
                row for row in memberships
                if row.get("status") in {"active", "paused"} and not row.get("ended_at")
            ]),
            class_count=len(sessions),
            active_class_count=len([
                row for row in sessions
                if row.get("status") in {"scheduled", "in_progress"}
            ]),
            lead_count=lead_count,
            belt_ladder_count=belt_ladder_count,
        )
