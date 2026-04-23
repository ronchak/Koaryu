from datetime import date, datetime, timedelta, timezone
from typing import Literal, Optional
from supabase import Client
from fastapi import HTTPException
from pydantic import ValidationError
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

    @staticmethod
    def _parse_date(value: str) -> date:
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Invalid persisted schedule date '{value}'. Review schedule data and migrations.",
            ) from exc

    @staticmethod
    def _studio_weekday(value: date) -> int:
        # Python: Monday=0 ... Sunday=6. Koaryu schema: Sunday=0 ... Saturday=6.
        return (value.weekday() + 1) % 7

    async def _materialize_sessions_for_range(
        self, studio_id: str, start_date: str, end_date: str
    ) -> None:
        start = self._parse_date(start_date)
        end = self._parse_date(end_date)
        templates = await self.list_templates(studio_id)
        if not templates:
            return

        existing = (
            self.supabase.table("class_sessions")
            .select("template_id, date")
            .eq("studio_id", studio_id)
            .gte("date", start_date)
            .lte("date", end_date)
            .execute()
        )
        existing_keys = {
            (row["template_id"], row["date"])
            for row in (existing.data or [])
            if row.get("template_id")
        }

        rows_to_create = []
        for template in templates:
            template_start = self._parse_date(template.start_date)
            template_end = self._parse_date(template.end_date) if template.end_date else end
            range_start = max(start, template_start)
            range_end = min(end, template_end)
            if range_start > range_end:
                continue

            current = range_start
            while current <= range_end:
                if self._studio_weekday(current) == template.day_of_week:
                    session_key = (template.id, current.isoformat())
                    if session_key not in existing_keys:
                        rows_to_create.append({
                            "studio_id": studio_id,
                            "template_id": template.id,
                            "name": template.name,
                            "date": current.isoformat(),
                            "start_time": template.start_time,
                            "end_time": template.end_time,
                            "instructor_id": template.instructor_id,
                            "program_id": template.program_id,
                            "capacity": template.capacity,
                        })
                        existing_keys.add(session_key)
                current += timedelta(days=1)

        if rows_to_create:
            result = self.supabase.table("class_sessions").insert(rows_to_create).execute()
            if not result.data:
                raise HTTPException(status_code=500, detail="Failed to generate recurring class sessions")

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
        templates: list[ClassTemplateResponse] = []
        for row in result.data or []:
            try:
                templates.append(ClassTemplateResponse(**row))
            except ValidationError as exc:
                raise HTTPException(
                    status_code=500,
                    detail="Schedule template data is incompatible with the current backend schema. Apply the latest schedule migrations.",
                ) from exc
        return templates

    async def create_template(
        self, data: ClassTemplateCreate, studio_id: str, actor_id: str
    ) -> ClassTemplateResponse:
        try:
            row = data.model_dump()
            row["start_date"] = row.get("start_date") or date.today().isoformat()
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
        except HTTPException:
            raise
        except ValidationError as exc:
            raise HTTPException(
                status_code=500,
                detail="Class template was created but could not be read back. Verify schedule schema migrations.",
            ) from exc
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail="Schedule template creation failed. Verify schedule schema migrations and backend connectivity.",
            ) from exc

    async def update_template(
        self, template_id: str, data: ClassTemplateUpdate, studio_id: str, actor_id: str
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
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "class_template.updated",
            "entity_type": "class_template",
            "entity_id": template_id,
            "metadata": update_dict,
        }).execute()
        return ClassTemplateResponse(**result.data[0])

    async def delete_template(self, template_id: str, studio_id: str, actor_id: str) -> None:
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
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "class_template.deleted",
            "entity_type": "class_template",
            "entity_id": template_id,
            "metadata": {},
        }).execute()

    # ---- Class Sessions ----

    async def list_sessions(
        self, studio_id: str, start_date: str, end_date: str
    ) -> list[ClassSessionResponse]:
        try:
            await self._materialize_sessions_for_range(studio_id, start_date, end_date)
            result = (
                self.supabase.table("class_sessions")
                .select("*")
                .eq("studio_id", studio_id)
                .is_("deleted_at", "null")
                .gte("date", start_date)
                .lte("date", end_date)
                .order("date")
                .order("start_time")
                .execute()
            )
            session_ids = [row["id"] for row in (result.data or [])]
            attendance_counts: dict[str, int] = {}

            if session_ids:
                attendance_rows = (
                    self.supabase.table("attendance")
                    .select("session_id")
                    .eq("studio_id", studio_id)
                    .in_("session_id", session_ids)
                    .neq("status", "absent")
                    .execute()
                )
                for row in attendance_rows.data or []:
                    session_id = row["session_id"]
                    attendance_counts[session_id] = attendance_counts.get(session_id, 0) + 1

            sessions = []
            for r in result.data or []:
                sessions.append(ClassSessionResponse(
                    **r,
                    attendance_count=attendance_counts.get(r["id"], 0),
                ))
            return sessions
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail="Schedule load failed. Verify schedule schema migrations and backend connectivity.",
            ) from exc

    async def create_session(
        self, data: ClassSessionCreate, studio_id: str, actor_id: str
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
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "class_session.created",
            "entity_type": "class_session",
            "entity_id": result.data[0]["id"],
            "metadata": {
                "name": row["name"],
                "date": row["date"],
                "template_id": row.get("template_id"),
            },
        }).execute()
        return ClassSessionResponse(**result.data[0], attendance_count=0)

    async def generate_sessions_for_week(
        self, studio_id: str, week_start: str
    ) -> list[ClassSessionResponse]:
        """Generate sessions for a week from templates."""
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
                actor_id="system",
            )
            created.append(session)
        return created

    async def delete_session(
        self,
        session_id: str,
        studio_id: str,
        actor_id: str,
        scope: Literal["session", "future_series"] = "session",
    ) -> None:
        existing = (
            self.supabase.table("class_sessions")
            .select("*")
            .eq("id", session_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .maybe_single()
            .execute()
        )
        session = existing.data
        if not session:
            raise HTTPException(status_code=404, detail="Class session not found")

        deleted_at = datetime.now(timezone.utc).isoformat()

        if scope == "future_series":
            if not session.get("template_id"):
                raise HTTPException(
                    status_code=400,
                    detail="Only recurring classes can be deleted for the full series",
                )

            template_result = (
                self.supabase.table("class_templates")
                .update({
                    "is_active": False,
                    "end_date": session["date"],
                })
                .eq("id", session["template_id"])
                .eq("studio_id", studio_id)
                .execute()
            )
            if not template_result.data:
                raise HTTPException(status_code=404, detail="Class template not found")

            deleted = (
                self.supabase.table("class_sessions")
                .update({
                    "deleted_at": deleted_at,
                    "status": "canceled",
                })
                .eq("studio_id", studio_id)
                .eq("template_id", session["template_id"])
                .gte("date", session["date"])
                .is_("deleted_at", "null")
                .execute()
            )
            if not deleted.data:
                raise HTTPException(status_code=409, detail="Failed to delete recurring class series")

            self.supabase.table("audit_logs").insert({
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "class_series.deleted",
                "entity_type": "class_template",
                "entity_id": session["template_id"],
                "metadata": {
                    "start_date": session["date"],
                    "session_name": session["name"],
                },
            }).execute()
            return

        deleted = (
            self.supabase.table("class_sessions")
            .update({
                "deleted_at": deleted_at,
                "status": "canceled",
            })
            .eq("id", session_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        if not deleted.data:
            raise HTTPException(status_code=409, detail="Failed to delete class session")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "class_session.deleted",
            "entity_type": "class_session",
            "entity_id": session_id,
            "metadata": {
                "template_id": session.get("template_id"),
                "date": session["date"],
                "name": session["name"],
            },
        }).execute()

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
