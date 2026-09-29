import unittest
from datetime import date

from app.services.report_intelligence_operations import (
    build_instructor_staff_impact,
    build_schedule_utilization_demand,
)


class ReportExportUtilizationTest(unittest.TestCase):
    def test_staff_mixed_capacity_excludes_uncapped_visits_from_utilization(self):
        data = {
            "sessions": [
                {
                    "id": "capped",
                    "date": "2026-05-30",
                    "instructor_id": "staff-1",
                    "capacity": 10,
                    "status": "scheduled",
                },
                {
                    "id": "uncapped",
                    "date": "2026-05-30",
                    "instructor_id": "staff-1",
                    "capacity": None,
                    "status": "scheduled",
                },
            ],
            "attendance": [
                {"session_id": "capped", "student_id": "student-1", "status": "present"},
                {"session_id": "uncapped", "student_id": "student-2", "status": "present"},
            ],
        }

        row = build_instructor_staff_impact(data, date(2026, 6, 1))[0]
        self.assertEqual(2, row["total_attendance_90_days"])
        self.assertEqual(1, row["sessions_with_capacity"])
        self.assertEqual(0.1, row["utilization_rate"])

    def test_utilization_uses_visits_from_the_sessions_offering_seats(self):
        sessions = []
        attendance = []

        def add_session(name, staff_id, session_id, capacity, visits, **changes):
            sessions.append(
                {
                    "id": session_id,
                    "name": name,
                    "date": "2026-05-30",
                    "start_time": "18:00",
                    "program_id": "program-1",
                    "instructor_id": staff_id,
                    "capacity": capacity,
                    "status": "scheduled",
                    **changes,
                }
            )
            attendance.extend(
                {
                    "id": f"{session_id}-visit-{index}",
                    "session_id": session_id,
                    "student_id": f"{session_id}-student-{index}",
                    "status": "present",
                }
                for index in range(visits)
            )

        add_session("Mixed", "staff-mixed", "mixed-capped", 10, 2)
        add_session("Mixed", "staff-mixed", "mixed-uncapped", None, 3)
        add_session("Mixed", "staff-mixed", "mixed-canceled", 50, 1, status="canceled")
        add_session("Mixed", "staff-mixed", "mixed-deleted", 70, 1, deleted_at="2026-06-01")
        add_session("Uncapped", "staff-uncapped", "uncapped", 0, 2)
        add_session("Over capacity", "staff-over", "over", 10, 12)
        add_session("Canceled seats", "staff-canceled", "canceled-live", 10, 1)
        add_session("Canceled seats", "staff-canceled", "canceled", 50, 1, status="canceled")
        data = {
            "programs": [{"id": "program-1", "name": "Program"}],
            "sessions": sessions,
            "attendance": attendance,
        }

        schedule = {
            row["class_name"]: row
            for row in build_schedule_utilization_demand(data, date(2026, 6, 1))
        }
        staff = {
            row["staff_user_id"]: row
            for row in build_instructor_staff_impact(data, date(2026, 6, 1))
        }

        self.assertEqual(3, schedule["Mixed"]["sessions_scheduled"])
        self.assertEqual(1, schedule["Mixed"]["sessions_canceled"])
        self.assertEqual(1, schedule["Mixed"]["sessions_with_capacity"])
        self.assertEqual(10, schedule["Mixed"]["total_capacity"])
        self.assertEqual(5, schedule["Mixed"]["total_attendance"])
        self.assertEqual(5, schedule["Mixed"]["unique_students"])
        self.assertEqual(2.5, schedule["Mixed"]["average_attendance"])
        self.assertEqual(0.2, schedule["Mixed"]["utilization_rate"])
        self.assertEqual(2, staff["staff-mixed"]["classes_taught_90_days"])
        self.assertEqual(5, staff["staff-mixed"]["total_attendance_90_days"])
        self.assertEqual(5, staff["staff-mixed"]["unique_students_90_days"])
        self.assertEqual(2.5, staff["staff-mixed"]["average_attendance_per_class"])
        self.assertEqual(1, staff["staff-mixed"]["sessions_with_capacity"])
        self.assertEqual(0.2, staff["staff-mixed"]["utilization_rate"])

        self.assertEqual(2, schedule["Uncapped"]["total_attendance"])
        self.assertEqual(0, schedule["Uncapped"]["sessions_with_capacity"])
        self.assertEqual(0, schedule["Uncapped"]["total_capacity"])
        self.assertEqual("", schedule["Uncapped"]["utilization_rate"])
        self.assertEqual(2, staff["staff-uncapped"]["total_attendance_90_days"])
        self.assertEqual(0, staff["staff-uncapped"]["sessions_with_capacity"])
        self.assertEqual("", staff["staff-uncapped"]["utilization_rate"])

        self.assertEqual(12, schedule["Over capacity"]["total_attendance"])
        self.assertEqual(10, schedule["Over capacity"]["total_capacity"])
        self.assertEqual(1.2, schedule["Over capacity"]["utilization_rate"])
        self.assertEqual(12, staff["staff-over"]["total_attendance_90_days"])
        self.assertEqual(1.2, staff["staff-over"]["utilization_rate"])

        self.assertEqual(2, schedule["Canceled seats"]["sessions_scheduled"])
        self.assertEqual(1, schedule["Canceled seats"]["sessions_canceled"])
        self.assertEqual(1, schedule["Canceled seats"]["sessions_with_capacity"])
        self.assertEqual(10, schedule["Canceled seats"]["total_capacity"])
        self.assertEqual(1, schedule["Canceled seats"]["total_attendance"])
        self.assertEqual(0.1, schedule["Canceled seats"]["utilization_rate"])
        self.assertEqual(1, staff["staff-canceled"]["classes_taught_90_days"])
        self.assertEqual(1, staff["staff-canceled"]["total_attendance_90_days"])
        self.assertEqual(0.1, staff["staff-canceled"]["utilization_rate"])


if __name__ == "__main__":
    unittest.main()
