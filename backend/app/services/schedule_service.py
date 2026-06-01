from datetime import date, datetime, timedelta, timezone
from typing import Optional
from supabase import Client
from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError
from pydantic import ValidationError
from app.schemas.schedule import (
    ClassTemplateCreate, ClassTemplateUpdate, ClassTemplateResponse,
    ClassSessionCreate, ClassSessionResponse,
    ClassSessionDeleteScopeValue,
    AttendanceCheckIn, AttendanceResponse, AttendanceBulkCheckIn,
)
from app.services.studio_scope import (
    ensure_optional_studio_record,
    ensure_staff_user_in_studio,
)
from app.services.program_service import ProgramService
from app.services.schedule_attendance_actions import ScheduleAttendanceActions


SCHEDULE_SESSION_CONFLICT_CODES = {"23505"}
SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS = 93
SCHEDULE_SESSION_MATERIALIZATION_RANGE_MAX_DAYS = 93


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
    def _parse_query_date(value: str, field_name: str) -> date:
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"{field_name} must be in YYYY-MM-DD format",
            ) from exc

    def _validate_session_date_range(
        self,
        start_date: str,
        end_date: str,
        *,
        max_days: int,
        operation_name: str,
    ) -> tuple[date, date]:
        start = self._parse_query_date(start_date, "start_date")
        end = self._parse_query_date(end_date, "end_date")
        if end < start:
            raise HTTPException(
                status_code=400,
                detail="end_date cannot be before start_date",
            )

        requested_days = (end - start).days + 1
        if requested_days > max_days:
            raise HTTPException(
                status_code=400,
                detail=f"{operation_name} date range cannot exceed {max_days} days",
            )
        return start, end

    @staticmethod
    def _studio_weekday(value: date) -> int:
        # Python: Monday=0 ... Sunday=6. Koaryu schema: Sunday=0 ... Saturday=6.
        return (value.weekday() + 1) % 7

    def _attendance_actions(self) -> ScheduleAttendanceActions:
        return ScheduleAttendanceActions(self.supabase)

    async def _materialize_sessions_for_range(
        self, studio_id: str, start_date: str, end_date: str
    ) -> None:
        start, end = self._validate_session_date_range(
            start_date,
            end_date,
            max_days=SCHEDULE_SESSION_MATERIALIZATION_RANGE_MAX_DAYS,
            operation_name="Recurring session materialization",
        )
        start_date = start.isoformat()
        end_date = end.isoformat()
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
            try:
                result = self.supabase.table("class_sessions").insert(rows_to_create).execute()
                if not result.data:
                    raise HTTPException(status_code=500, detail="Failed to generate recurring class sessions")
            except PostgrestAPIError as exc:
                if exc.code not in SCHEDULE_SESSION_CONFLICT_CODES:
                    raise
                self._insert_materialized_sessions_with_conflict_skip(rows_to_create)

    def _insert_materialized_sessions_with_conflict_skip(self, rows: list[dict]) -> None:
        for row in rows:
            try:
                result = self.supabase.table("class_sessions").insert(row).execute()
            except PostgrestAPIError as exc:
                if exc.code in SCHEDULE_SESSION_CONFLICT_CODES:
                    continue
                raise
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
            ProgramService(self.supabase).ensure_program_active(studio_id, row.get("program_id"))
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
        ProgramService(self.supabase).ensure_program_active(studio_id, update_dict.get("program_id"))
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
            start, end = self._validate_session_date_range(
                start_date,
                end_date,
                max_days=SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS,
                operation_name="Schedule session list",
            )
            start_date = start.isoformat()
            end_date = end.isoformat()
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
        ProgramService(self.supabase).ensure_program_active(studio_id, row.get("program_id"))
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
        scope: ClassSessionDeleteScopeValue = "session",
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
        return await self._attendance_actions().get_session_attendance(session_id, studio_id)

    async def list_attendance(
        self,
        studio_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        session_ids: Optional[list[str]] = None,
    ) -> list[AttendanceResponse]:
        return await self._attendance_actions().list_attendance(
            studio_id,
            start_date=start_date,
            end_date=end_date,
            session_ids=session_ids,
        )

    async def check_in(
        self, data: AttendanceCheckIn, studio_id: str, actor_id: str
    ) -> AttendanceResponse:
        return await self._attendance_actions().check_in(data, studio_id, actor_id)

    async def clear_attendance(
        self,
        session_id: str,
        student_id: str,
        studio_id: str,
    ) -> None:
        await self._attendance_actions().clear_attendance(session_id, student_id, studio_id)

    async def bulk_check_in(
        self, data: AttendanceBulkCheckIn, studio_id: str, actor_id: str
    ) -> list[AttendanceResponse]:
        return await self._attendance_actions().bulk_check_in(data, studio_id, actor_id)
