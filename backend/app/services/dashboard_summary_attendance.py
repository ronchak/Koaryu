from datetime import date, datetime, time as datetime_time, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.schemas.dashboard_summary import (
    DashboardSummaryInactivityCounts,
    DashboardSummaryOperationalCounts,
)
from app.services.dashboard_summary_store import DashboardSummaryStore


ACTIVE_STUDENT_STATUSES = {"active", "trialing", "paused"}


class DashboardSummaryAttendanceMetrics:
    def __init__(self, store: DashboardSummaryStore):
        self.store = store

    @staticmethod
    def _parse_date(value: Any) -> Optional[date]:
        if not value:
            return None
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        return date.fromisoformat(str(value)[:10])

    @staticmethod
    def _as_start_of_day(value: date, timezone_name: Optional[str]) -> str:
        try:
            zone = ZoneInfo(timezone_name or "UTC")
        except ZoneInfoNotFoundError:
            zone = timezone.utc
        return datetime.combine(value, datetime_time.min, tzinfo=zone).astimezone(timezone.utc).isoformat()

    @staticmethod
    def _timestamp_to_studio_date(value: Any, timezone_name: Optional[str]) -> Optional[date]:
        if not value:
            return None
        try:
            zone = ZoneInfo(timezone_name or "UTC")
        except ZoneInfoNotFoundError:
            zone = timezone.utc
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(zone).date()

    @staticmethod
    def _studio_weekday(value: date) -> int:
        return (value.weekday() + 1) % 7

    @staticmethod
    def _chunked(values: list[str], size: int = 100) -> list[list[str]]:
        return [values[index:index + size] for index in range(0, len(values), size)]

    @staticmethod
    def _is_student_on_hold_now(row: dict[str, Any], today: date) -> bool:
        if row.get("status") == "paused":
            return True

        hold_start = DashboardSummaryAttendanceMetrics._parse_date(row.get("hold_start_date"))
        if not hold_start or hold_start > today:
            return False

        hold_end = DashboardSummaryAttendanceMetrics._parse_date(row.get("hold_end_date"))
        return not hold_end or hold_end >= today

    @staticmethod
    def _student_start_date(row: dict[str, Any]) -> Optional[date]:
        return (
            DashboardSummaryAttendanceMetrics._parse_date(row.get("membership_start_date"))
            or DashboardSummaryAttendanceMetrics._parse_date(row.get("created_at"))
        )

    def today_class_count(self, studio_id: str, today: date) -> int:
        today_text = today.isoformat()
        session_rows = self.store.fetch_rows(
            "class_sessions",
            "id, template_id, status, deleted_at",
            lambda query: query.eq("studio_id", studio_id).eq("date", today_text),
        )
        represented_template_ids = {
            row["template_id"]
            for row in session_rows
            if row.get("template_id")
        }
        persisted_live_count = sum(
            1
            for row in session_rows
            if not row.get("deleted_at") and row.get("status") != "canceled"
        )

        template_rows = self.store.fetch_rows(
            "class_templates",
            "id, day_of_week, start_date, end_date, is_active",
            lambda query: query
            .eq("studio_id", studio_id)
            .eq("is_active", True)
            .eq("day_of_week", self._studio_weekday(today)),
        )
        generated_count = 0
        for row in template_rows:
            template_id = row.get("id")
            if not template_id or template_id in represented_template_ids:
                continue
            start_date = self._parse_date(row.get("start_date"))
            end_date = self._parse_date(row.get("end_date"))
            if start_date and start_date > today:
                continue
            if end_date and end_date < today:
                continue
            generated_count += 1

        return persisted_live_count + generated_count

    def inactivity_counts(
        self,
        studio_id: str,
        student_rows: list[dict[str, Any]],
        today: date,
        lookback_14: date,
        lookback_30: date,
        lookback_90: date,
        timezone_name: str,
    ) -> DashboardSummaryInactivityCounts:
        eligible_students = [
            row
            for row in student_rows
            if row.get("status") in ACTIVE_STUDENT_STATUSES and not self._is_student_on_hold_now(row, today)
        ]
        student_ids = [row["id"] for row in eligible_students if row.get("id")]
        last_attendance_by_student: dict[str, date] = {}

        for student_id_chunk in self._chunked(student_ids):
            attendance_rows = self.store.fetch_rows(
                "attendance",
                "student_id, checked_in_at",
                lambda query, student_id_chunk=student_id_chunk: query
                .eq("studio_id", studio_id)
                .in_("student_id", student_id_chunk)
                .neq("status", "absent")
                .gte("checked_in_at", self._as_start_of_day(lookback_90, timezone_name))
                .order("checked_in_at", desc=True),
            )
            for row in attendance_rows:
                student_id = row.get("student_id")
                checked_in_on = self._timestamp_to_studio_date(row.get("checked_in_at"), timezone_name)
                if student_id and checked_in_on and student_id not in last_attendance_by_student:
                    last_attendance_by_student[student_id] = checked_in_on

        watch_14 = 0
        watch_30 = 0
        watch_90 = 0
        for row in eligible_students:
            reference_date = last_attendance_by_student.get(row["id"]) or self._student_start_date(row)
            if not reference_date or reference_date > today:
                continue
            if reference_date <= lookback_14:
                watch_14 += 1
            if reference_date <= lookback_30:
                watch_30 += 1
            if reference_date <= lookback_90:
                watch_90 += 1

        return DashboardSummaryInactivityCounts(
            watch_14=watch_14,
            watch_30=watch_30,
            watch_90=watch_90,
        )

    def operational_counts(
        self,
        studio_id: str,
        lookback_30: date,
        today: date,
    ) -> DashboardSummaryOperationalCounts:
        session_rows = self.store.fetch_rows(
            "class_sessions",
            "id, capacity, status, deleted_at",
            lambda query: query
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .gte("date", lookback_30.isoformat())
            .lte("date", today.isoformat()),
        )
        session_rows = [row for row in session_rows if row.get("status") != "canceled"]
        session_ids = [row["id"] for row in session_rows if row.get("id")]
        attendance_by_session: dict[str, int] = {}

        for session_id_chunk in self._chunked(session_ids):
            attendance_rows = self.store.fetch_rows(
                "attendance",
                "session_id",
                lambda query, session_id_chunk=session_id_chunk: query
                .eq("studio_id", studio_id)
                .in_("session_id", session_id_chunk)
                .neq("status", "absent"),
            )
            for row in attendance_rows:
                session_id = row.get("session_id")
                if session_id:
                    attendance_by_session[session_id] = attendance_by_session.get(session_id, 0) + 1

        attendance_with_capacity = 0
        total_capacity = 0
        total_check_ins = 0
        sessions_with_capacity = 0
        for row in session_rows:
            attendees = attendance_by_session.get(row["id"], 0)
            total_check_ins += attendees
            capacity = row.get("capacity")
            if capacity and capacity > 0:
                attendance_with_capacity += attendees
                total_capacity += capacity
                sessions_with_capacity += 1

        sessions_tracked = len(session_rows)
        return DashboardSummaryOperationalCounts(
            attendance_with_capacity=attendance_with_capacity,
            total_capacity=total_capacity,
            sessions_tracked=sessions_tracked,
            sessions_with_capacity=sessions_with_capacity,
            utilization_rate=attendance_with_capacity / total_capacity if total_capacity else None,
            average_attendance=total_check_ins / sessions_tracked if sessions_tracked else 0,
        )
