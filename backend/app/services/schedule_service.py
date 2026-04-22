from typing import Optional
from supabase import Client
from fastapi import HTTPException
from app.schemas.schedule import (
    ClassTemplateCreate, ClassTemplateUpdate, ClassTemplateResponse,
    ClassSessionCreate, ClassSessionResponse,
    AttendanceCheckIn, AttendanceResponse, AttendanceBulkCheckIn,
)
from app.services.studio_scope import (
    ensure_optional_studio_record,
    ensure_staff_user_in_studio,
    ensure_studio_record,
)


class ScheduleService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    # ---- Class Templates ----

    async def list_templates(self, studio_id: str) -> list[ClassTemplateResponse]:
        result = (
            self.supabase.table("class_templates")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("is_active", True)
            .order("day_of_week")
            .order("start_time")
            .execute()
        )
        return [ClassTemplateResponse(**r) for r in (result.data or [])]

    async def create_template(
        self, data: ClassTemplateCreate, studio_id: str, actor_id: str
    ) -> ClassTemplateResponse:
        row = data.model_dump()
        ensure_staff_user_in_studio(
            self.supabase,
            row.get("instructor_id"),
            studio_id,
            "Instructor not found in this studio",
        )
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            row.get("program_id"),
            studio_id,
            "Program not found",
        )
        row["studio_id"] = studio_id
        result = self.supabase.table("class_templates").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create class template")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "class_template.created",
            "entity_type": "class_template",
            "entity_id": result.data[0]["id"],
            "metadata": {"name": data.name},
        }).execute()

        return ClassTemplateResponse(**result.data[0])

    async def update_template(
        self, template_id: str, data: ClassTemplateUpdate, studio_id: str
    ) -> ClassTemplateResponse:
        update_dict = data.model_dump(exclude_none=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        ensure_staff_user_in_studio(
            self.supabase,
            update_dict.get("instructor_id"),
            studio_id,
            "Instructor not found in this studio",
        )
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            update_dict.get("program_id"),
            studio_id,
            "Program not found",
        )
        result = (
            self.supabase.table("class_templates")
            .update(update_dict)
            .eq("id", template_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Template not found")
        return ClassTemplateResponse(**result.data[0])

    async def delete_template(self, template_id: str, studio_id: str) -> None:
        # Soft-deactivate
        result = (
            self.supabase.table("class_templates")
            .update({"is_active": False})
            .eq("id", template_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Template not found")

    # ---- Class Sessions ----

    async def list_sessions(
        self, studio_id: str, start_date: str, end_date: str
    ) -> list[ClassSessionResponse]:
        result = (
            self.supabase.table("class_sessions")
            .select("*")
            .eq("studio_id", studio_id)
            .gte("date", start_date)
            .lte("date", end_date)
            .order("date")
            .order("start_time")
            .execute()
        )
        sessions = []
        for r in result.data or []:
            # Count attendance
            att_result = (
                self.supabase.table("attendance")
                .select("id", count="exact")
                .eq("session_id", r["id"])
                .eq("studio_id", studio_id)
                .neq("status", "absent")
                .execute()
            )
            sessions.append(ClassSessionResponse(
                **r,
                attendance_count=att_result.count or 0,
            ))
        return sessions

    async def create_session(
        self, data: ClassSessionCreate, studio_id: str
    ) -> ClassSessionResponse:
        row = data.model_dump()
        ensure_optional_studio_record(
            self.supabase,
            "class_templates",
            row.get("template_id"),
            studio_id,
            "Class template not found",
        )
        ensure_staff_user_in_studio(
            self.supabase,
            row.get("instructor_id"),
            studio_id,
            "Instructor not found in this studio",
        )
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            row.get("program_id"),
            studio_id,
            "Program not found",
        )
        row["studio_id"] = studio_id
        result = self.supabase.table("class_sessions").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create session")
        return ClassSessionResponse(**result.data[0], attendance_count=0)

    async def generate_sessions_for_week(
        self, studio_id: str, week_start: str
    ) -> list[ClassSessionResponse]:
        """Generate sessions for a week from templates."""
        from datetime import datetime, timedelta
        start = datetime.strptime(week_start, "%Y-%m-%d").date()

        templates = await self.list_templates(studio_id)
        created = []
        for t in templates:
            # Calculate the date for this template's day_of_week
            days_ahead = t.day_of_week - start.weekday()
            if days_ahead < 0:
                days_ahead += 7
            # Adjust: Python weekday() is Mon=0, our schema is Sun=0
            days_ahead = (t.day_of_week - (start.isoweekday() % 7))
            if days_ahead < 0:
                days_ahead += 7
            session_date = start + timedelta(days=days_ahead)

            # Check if session already exists
            existing = (
                self.supabase.table("class_sessions")
                .select("id")
                .eq("template_id", t.id)
                .eq("studio_id", studio_id)
                .eq("date", str(session_date))
                .execute()
            )
            if existing.data:
                continue

            session = await self.create_session(
                ClassSessionCreate(
                    template_id=t.id,
                    name=t.name,
                    date=str(session_date),
                    start_time=t.start_time,
                    end_time=t.end_time,
                    instructor_id=t.instructor_id,
                    program_id=t.program_id,
                    capacity=t.capacity,
                ),
                studio_id,
            )
            created.append(session)
        return created

    # ---- Attendance ----

    async def get_session_attendance(
        self, session_id: str, studio_id: str
    ) -> list[AttendanceResponse]:
        result = (
            self.supabase.table("attendance")
            .select("*, students(legal_first_name, legal_last_name, preferred_name)")
            .eq("session_id", session_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        items = []
        for r in result.data or []:
            student = r.pop("students", {}) or {}
            name = f"{student.get('preferred_name') or student.get('legal_first_name', '')} {student.get('legal_last_name', '')}"
            items.append(AttendanceResponse(
                **{k: v for k, v in r.items()},
                student_name=name.strip(),
            ))
        return items

    async def check_in(
        self, data: AttendanceCheckIn, studio_id: str, actor_id: str
    ) -> AttendanceResponse:
        ensure_studio_record(
            self.supabase,
            "class_sessions",
            data.session_id,
            studio_id,
            "Class session not found",
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

        # Upsert — if already checked in, update status
        result = (
            self.supabase.table("attendance")
            .upsert(row, on_conflict="session_id,student_id")
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to record attendance")
        return AttendanceResponse(**result.data[0])

    async def bulk_check_in(
        self, data: AttendanceBulkCheckIn, studio_id: str, actor_id: str
    ) -> list[AttendanceResponse]:
        results = []
        for ci in data.check_ins:
            ci_data = AttendanceCheckIn(
                session_id=data.session_id,
                student_id=ci.student_id,
                status=ci.status,
            )
            r = await self.check_in(ci_data, studio_id, actor_id)
            results.append(r)
        return results
