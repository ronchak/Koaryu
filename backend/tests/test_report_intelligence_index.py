import unittest
from datetime import date, timedelta

from app.services.report_intelligence_helpers import (
    _attendance_events,
    _count_events,
    _last_event_date,
    _last_first_visit,
    _student_risk,
)


class ReportIntelligenceAttendanceIndexTest(unittest.TestCase):
    def test_canceled_and_missing_session_events_keep_authoritative_semantics(self):
        data = {
            "sessions": [
                {"id": "canceled", "date": "2026-05-29", "status": "canceled", "name": "Canceled"},
                {"id": "normal", "date": "2026-05-30", "status": "scheduled", "name": "Normal"},
            ],
            "attendance": [
                {"id": "absent", "session_id": "normal", "student_id": "student-1", "status": "absent"},
                {"id": "canceled-event", "session_id": "canceled", "student_id": "student-1", "status": "present", "checked_in_at": "2026-05-29T18:00:00Z"},
                {"id": "missing-event", "session_id": "missing", "student_id": "student-1", "status": "present", "checked_in_at": "2026-05-28T18:00:00Z"},
                {"id": "normal-event", "session_id": "normal", "student_id": "student-1", "status": "present", "checked_in_at": "2026-05-30T18:00:00Z"},
            ],
        }

        index = _attendance_events(data)

        self.assertEqual(["canceled-event", "missing-event", "normal-event"], [event["id"] for event in index])
        self.assertEqual(date(2026, 5, 29), index.events[0]["event_date"])
        self.assertEqual("canceled", index.events[0]["session_status"])
        self.assertEqual(date(2026, 5, 28), index.events[1]["event_date"])
        self.assertEqual("missing", index.events[1]["session_id"])
        self.assertEqual(3, _count_events(index, student_id="student-1", start=date(2026, 5, 28), end=date(2026, 5, 30)))
        self.assertEqual(date(2026, 5, 28), _last_first_visit(index, "student-1", first=True))
        self.assertEqual(date(2026, 5, 30), _last_event_date(index, "student-1"))
        self.assertEqual(1, len(index.events_by_session["canceled"]))
        self.assertEqual(1, len(index.events_by_session["normal"]))

    def test_student_risk_queries_scale_with_students_not_attendance_rows(self):
        def build_dataset(scale):
            today = date(2026, 6, 1)
            students = []
            attendance = []
            sessions = []
            for student_number in range(16 * scale):
                student_id = f"student-{student_number}"
                students.append({"id": student_id, "status": "active"})
                for visit_number in range(4):
                    session_id = f"session-{student_number}-{visit_number}"
                    event_date = today - timedelta(days=visit_number * 10)
                    sessions.append({"id": session_id, "date": event_date.isoformat(), "status": "scheduled"})
                    attendance.append({
                        "id": f"attendance-{student_number}-{visit_number}",
                        "session_id": session_id,
                        "student_id": student_id,
                        "status": "present",
                    })
            counter = {}
            index = _attendance_events({"sessions": sessions, "attendance": attendance}, operation_counter=counter)
            enrollments_by_student = {}
            payers_by_id = {}
            for student in students:
                _student_risk(student, index, enrollments_by_student, payers_by_id, today)
            return counter, len(attendance), len(students)

        small_counter, small_events, small_students = build_dataset(1)
        large_counter, large_events, large_students = build_dataset(2)

        self.assertEqual(small_events, small_counter["attendance_rows_examined"])
        self.assertEqual(large_events, large_counter["attendance_rows_examined"])
        self.assertEqual(small_events, small_counter["event_objects_materialized"])
        self.assertEqual(large_events, large_counter["event_objects_materialized"])
        self.assertEqual(small_students * 5, small_counter["attendance_index_lookups"])
        self.assertEqual(large_students * 5, large_counter["attendance_index_lookups"])
        self.assertEqual(2 * small_events, large_counter["attendance_rows_examined"])
        self.assertEqual(2 * small_counter["attendance_index_lookups"], large_counter["attendance_index_lookups"])


if __name__ == "__main__":
    unittest.main()
