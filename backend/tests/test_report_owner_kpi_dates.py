import unittest
from datetime import date

from app.services.report_intelligence_growth import build_owner_kpi_summary


class OwnerKpiStudentDatesTest(unittest.TestCase):
    def test_new_student_window_excludes_future_starts_and_keeps_inclusive_boundaries(self):
        cases = [
            ({"membership_start_date": "2026-05-02"}, 0),
            ({"membership_start_date": "2026-05-03"}, 1),
            ({"membership_start_date": "2026-06-01"}, 1),
            (
                {
                    "membership_start_date": "2026-06-02",
                    "created_at": "2026-05-20T12:00:00Z",
                },
                0,
            ),
            ({"created_at": "2026-06-02T02:00:00Z"}, 1),
            ({"created_at": "2026-06-02T07:00:00Z"}, 0),
            (
                {
                    "membership_start_date": "2026-06-01",
                    "deleted_at": "2026-06-01T12:00:00Z",
                },
                0,
            ),
        ]
        for dates, expected in cases:
            with self.subTest(dates=dates):
                metrics = {
                    row["metric"]: row["value"]
                    for row in build_owner_kpi_summary(
                        {"students": [{"id": "student", "status": "active", **dates}]},
                        date(2026, 6, 1),
                        timezone="America/Los_Angeles",
                    )
                }
                self.assertEqual(expected, metrics["new_students_30_days"])
