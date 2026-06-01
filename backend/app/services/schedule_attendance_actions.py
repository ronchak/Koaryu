from datetime import datetime
from typing import Optional

from fastapi import HTTPException
from supabase import Client

from app.schemas.schedule import (
    AttendanceBulkCheckIn,
    AttendanceCheckIn,
    AttendanceResponse,
)
from app.services.studio_scope import ensure_studio_record


class ScheduleAttendanceActions:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    @staticmethod
    def _parse_query_date(value: str, field_name: str):
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"{field_name} must be in YYYY-MM-DD format",
            ) from exc

    @staticmethod
    def _normalize_session_ids(session_ids: Optional[list[str]]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in session_ids or []:
            for raw_session_id in value.split(","):
                session_id = raw_session_id.strip()
                if session_id and session_id not in seen:
                    normalized.append(session_id)
                    seen.add(session_id)
        return normalized

    @staticmethod
    def attendance_response_from_row(row: dict) -> AttendanceResponse:
        data = {
            k: v
            for k, v in row.items()
            if k not in {"students", "class_sessions"}
        }
        student = row.get("students", {}) or {}
        first_name = student.get("preferred_name") or student.get("legal_first_name", "")
        name = f"{first_name} {student.get('legal_last_name', '')}"
        return AttendanceResponse(
            **data,
            student_name=name.strip(),
        )

    async def get_session_attendance(
        self, session_id: str, studio_id: str
    ) -> list[AttendanceResponse]:
        result = (
            self.supabase.table("attendance")
            .select(
                "*, students(legal_first_name, legal_last_name, preferred_name), "
                "class_sessions!inner(studio_id, status, deleted_at)"
            )
            .eq("session_id", session_id)
            .eq("studio_id", studio_id)
            .eq("class_sessions.studio_id", studio_id)
            .is_("class_sessions.deleted_at", "null")
            .neq("class_sessions.status", "canceled")
            .execute()
        )
        return [self.attendance_response_from_row(row) for row in result.data or []]

    async def list_attendance(
        self,
        studio_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        session_ids: Optional[list[str]] = None,
    ) -> list[AttendanceResponse]:
        normalized_session_ids = self._normalize_session_ids(session_ids)
        if normalized_session_ids:
            result = (
                self.supabase.table("attendance")
                .select(
                    "*, students(legal_first_name, legal_last_name, preferred_name), "
                    "class_sessions!inner(studio_id, status, deleted_at)"
                )
                .eq("studio_id", studio_id)
                .in_("session_id", normalized_session_ids)
                .eq("class_sessions.studio_id", studio_id)
                .is_("class_sessions.deleted_at", "null")
                .neq("class_sessions.status", "canceled")
                .order("session_id")
                .order("checked_in_at")
                .execute()
            )
            return [self.attendance_response_from_row(row) for row in result.data or []]

        if not start_date or not end_date:
            raise HTTPException(
                status_code=400,
                detail="Provide session_ids or both start_date and end_date",
            )

        start = self._parse_query_date(start_date, "start_date")
        end = self._parse_query_date(end_date, "end_date")
        if end < start:
            raise HTTPException(
                status_code=400,
                detail="end_date cannot be before start_date",
            )

        result = (
            self.supabase.table("attendance")
            .select(
                "*, students(legal_first_name, legal_last_name, preferred_name), "
                "class_sessions!inner(studio_id, date, status, deleted_at)"
            )
            .eq("studio_id", studio_id)
            .eq("class_sessions.studio_id", studio_id)
            .is_("class_sessions.deleted_at", "null")
            .neq("class_sessions.status", "canceled")
            .gte("class_sessions.date", start_date)
            .lte("class_sessions.date", end_date)
            .order("session_id")
            .order("checked_in_at")
            .execute()
        )
        return [self.attendance_response_from_row(row) for row in result.data or []]

    async def check_in(
        self, data: AttendanceCheckIn, studio_id: str, actor_id: str
    ) -> AttendanceResponse:
        session_result = (
            self.supabase.table("class_sessions")
            .select("id, program_id, status, deleted_at")
            .eq("id", data.session_id)
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if not session_result.data:
            raise HTTPException(status_code=404, detail="Class session not found")
        if session_result.data.get("deleted_at") or session_result.data.get("status") == "canceled":
            raise HTTPException(
                status_code=409,
                detail="Cannot record attendance for a canceled or deleted class session.",
            )
        ensure_studio_record(
            self.supabase,
            "students",
            data.student_id,
            studio_id,
            "Student not found",
        )

        row = data.model_dump()
        row["studio_id"] = studio_id
        row["checked_in_by"] = actor_id

        session_program_id = session_result.data.get("program_id")
        if session_program_id:
            membership_result = (
                self.supabase.table("student_program_memberships")
                .select("id")
                .eq("studio_id", studio_id)
                .eq("student_id", data.student_id)
                .eq("program_id", session_program_id)
                .in_("status", ["active", "paused"])
                .is_("ended_at", "null")
                .limit(1)
                .execute()
            )
            is_cross_program = not bool(membership_result.data)
            row["is_cross_program"] = is_cross_program
            if is_cross_program and data.counts_toward_eligibility is None:
                row["counts_toward_eligibility"] = False
            elif data.counts_toward_eligibility is None:
                row["counts_toward_eligibility"] = True
        elif data.counts_toward_eligibility is None:
            row["counts_toward_eligibility"] = True

        result = (
            self.supabase.table("attendance")
            .upsert(row, on_conflict="session_id,student_id")
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record attendance")
        return AttendanceResponse(**result.data[0])

    async def clear_attendance(
        self,
        session_id: str,
        student_id: str,
        studio_id: str,
    ) -> None:
        self.supabase.table("attendance").delete() \
            .eq("studio_id", studio_id) \
            .eq("session_id", session_id) \
            .eq("student_id", student_id) \
            .execute()

    async def bulk_check_in(
        self, data: AttendanceBulkCheckIn, studio_id: str, actor_id: str
    ) -> list[AttendanceResponse]:
        results = []
        for ci in data.check_ins:
            ci_data = AttendanceCheckIn(
                session_id=data.session_id,
                student_id=ci.student_id,
                status=ci.status,
                counts_toward_eligibility=ci.counts_toward_eligibility,
                override_reason=ci.override_reason,
            )
            result = await self.check_in(ci_data, studio_id, actor_id)
            results.append(result)
        return results
