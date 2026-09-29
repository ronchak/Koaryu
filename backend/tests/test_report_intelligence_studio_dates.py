import asyncio
import unittest
from datetime import date
from unittest.mock import patch

from app.services.report_export_catalog import build_report_catalog
from app.services.report_export_service import ReportExportService
from app.services.report_intelligence_growth import (
    build_owner_kpi_summary,
    build_quiet_churn_watchlist,
)
from app.services.report_intelligence_helpers import _attendance_events
from app.services.report_intelligence_operations import build_belt_momentum_testing_pipeline
from app.services.report_intelligence_revenue import build_revenue_leakage
from tests.test_report_belt_momentum_credit import report_dataset


TODAY = date(2026, 6, 1)
TIMEZONE = "America/Los_Angeles"


class IntelligenceStudioDatesTest(unittest.TestCase):
    def test_missing_session_timestamp_uses_studio_day_and_session_date_stays_literal(self):
        events = _attendance_events(
            {
                "sessions": [{"id": "known", "date": "2026-05-02", "status": "scheduled"}],
                "attendance": [
                    {
                        "id": "missing",
                        "session_id": "missing",
                        "status": "present",
                        "checked_in_at": "2026-06-01T02:00:00Z",
                    },
                    {
                        "id": "known",
                        "session_id": "known",
                        "status": "present",
                        "checked_in_at": "2026-05-03T02:00:00Z",
                    },
                    {
                        "id": "offset",
                        "session_id": "missing",
                        "status": "present",
                        "checked_in_at": "2026-06-01T04:00:00+02:00",
                    },
                ],
            },
            timezone=TIMEZONE,
        )
        self.assertEqual(
            [date(2026, 5, 31), date(2026, 5, 2), date(2026, 5, 31)],
            [event["event_date"] for event in events],
        )

    def test_created_at_windows_use_studio_day(self):
        boundary = "2026-05-03T02:00:00Z"  # May 2 in Los Angeles, before the 30-day window.
        data = {
            "students": [{"id": "student", "status": "active", "created_at": boundary}],
            "leads": [{"id": "lead", "created_at": boundary}],
            "invoices": [{"id": "invoice", "student_id": "student", "status": "paid"}],
            "billing_payers": [{"id": "payer", "display_name": "Family"}],
            "payments": [
                {
                    "id": "payment",
                    "invoice_id": "invoice",
                    "payer_id": "payer",
                    "status": "failed",
                    "created_at": boundary,
                    "amount_cents": 100,
                }
            ],
        }
        metrics = {
            row["metric"]: row["value"]
            for row in build_owner_kpi_summary(data, TODAY, timezone=TIMEZONE)
        }
        self.assertEqual(0, metrics["new_students_30_days"])
        self.assertEqual(0, metrics["new_leads_30_days"])
        self.assertEqual(0, metrics["failed_payment_amount_30_days_cents"])
        self.assertFalse(
            any(
                row["leakage_type"] == "failed_payment_last_30_days"
                for row in build_revenue_leakage(data, TODAY, timezone=TIMEZONE)
            )
        )

    def test_csv_builder_uses_authorized_studio_calendar(self):
        services = [ReportExportService(None), ReportExportService(None)]
        for service in services:
            service._single_row = lambda table, columns, studio_id: {
                "timezone": TIMEZONE if studio_id == "west" else "Asia/Tokyo"
            }
            service._fetch_intelligence_dataset = lambda studio_id: {
                "leads": [{"id": "lead", "created_at": "2026-05-03T02:00:00Z"}]
            }
        report = build_report_catalog(ReportExportService)["owner_kpi_summary"]
        with patch(
            "app.services.report_export_service.studio_today",
            side_effect=lambda name: (TODAY, name),
        ):
            west_csv, _ = asyncio.run(services[0].build_csv_for_report(report, "west"))
            east_csv, _ = asyncio.run(services[1].build_csv_for_report(report, "east"))
        self.assertIn("new_leads_30_days,0,", west_csv)
        self.assertIn("new_leads_30_days,1,", east_csv)

    def test_quiet_churn_promotion_display_uses_studio_day(self):
        rows = build_quiet_churn_watchlist(
            {
                "students": [
                    {"id": "student", "status": "active", "membership_start_date": "2026-05-03"}
                ],
                "promotions": [{"student_id": "student", "promoted_at": "2026-06-01T02:00:00Z"}],
            },
            TODAY,
            timezone=TIMEZONE,
        )
        self.assertEqual("2026-05-03", rows[0]["membership_start_date"])
        self.assertEqual("2026-05-31", rows[0]["last_promotion_at"])
        self.assertEqual(1, rows[0]["days_since_last_promotion"])

    def test_belt_display_day_changes_but_instant_credit_does_not(self):
        data = report_dataset()
        data["promotions"][0]["promoted_at"] = "2026-05-16T02:00:00Z"
        data["attendance"][0]["checked_in_at"] = "2026-05-16T01:59:59Z"
        data["attendance"][1]["checked_in_at"] = "2026-05-16T03:00:00Z"
        data["attendance"][2]["checked_in_at"] = "2026-05-16T02:00:00Z"
        data["attendance"][3]["checked_in_at"] = "2026-05-16T02:00:01Z"
        row = next(
            row
            for row in build_belt_momentum_testing_pipeline(data, TODAY, timezone=TIMEZONE)
            if row["membership_id"] == "membership-1"
        )
        self.assertEqual(17, row["days_at_rank"])
        self.assertEqual(3, row["classes_since_rank_start"])
