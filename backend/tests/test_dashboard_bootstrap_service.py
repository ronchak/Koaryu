import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.schemas.auth import AuthResponse, UserProfile
from app.schemas.dashboard_bootstrap import DashboardBootstrapResponse
from app.services.dashboard_bootstrap_service import DashboardBootstrapService


class DashboardBootstrapServiceTest(unittest.TestCase):
    def test_bootstrap_schema_inherits_optional_dashboard_enrichments(self):
        schema = DashboardBootstrapResponse.model_json_schema()

        self.assertEqual(
            schema["properties"]["summary"]["anyOf"][0]["$ref"],
            "#/$defs/DashboardSummaryResponse",
        )
        summary_schema = schema["$defs"]["DashboardSummaryResponse"]
        self.assertIn("today_schedule", summary_schema["properties"])
        self.assertIn("emergency_contacts", summary_schema["properties"])
        self.assertNotIn("today_schedule", summary_schema["required"])
        self.assertNotIn("emergency_contacts", summary_schema["required"])
        billing_schema = schema["$defs"]["DashboardSummaryBillingCounts"]
        self.assertIn("amounts", billing_schema["properties"])
        self.assertNotIn("amounts", billing_schema.get("required", []))
        amounts_schema = schema["$defs"]["DashboardSummaryBillingAmounts"]
        self.assertEqual(
            set(amounts_schema["properties"]),
            {
                "available",
                "payment_attention_amount_cents",
                "due_this_week_amount_cents",
            },
        )
        today_schema = schema["$defs"]["DashboardSummaryTodaySchedule"]
        self.assertEqual(
            set(today_schema["properties"]),
            {"available", "expected_counts_available", "rows", "overflow_count"},
        )
        self.assertNotIn("overflow_count", today_schema.get("required", []))
        today_row_schema = schema["$defs"]["DashboardSummaryTodaySession"]
        self.assertEqual(
            set(today_row_schema["properties"]),
            {
                "id",
                "start_time",
                "end_time",
                "name",
                "capacity",
                "attendance_count",
                "expected_count",
            },
        )
        self.assertNotIn("expected_count", today_row_schema.get("required", []))

    def test_server_timing_value_uses_safe_labels_and_durations(self):
        value = DashboardBootstrapService.server_timing_value({
            "studio": 12.345,
            "students": 4.0,
            "total": 20.123,
        })

        self.assertEqual(
            value,
            "koaryu_studio;dur=12.3, koaryu_students;dur=4.0, koaryu_total;dur=20.1",
        )

    def test_bootstrap_does_not_build_dashboard_summary_inline(self):
        supabase = SimpleNamespace(options=SimpleNamespace(postgrest_client_timeout=10.0))
        service = DashboardBootstrapService(supabase=supabase)
        auth = AuthResponse(
            user=UserProfile(id="user-1", email="owner@example.com", full_name="Owner"),
            staff_profiles_available=True,
            studio_id="studio-1",
            role="admin",
        )

        def fake_timed_fetch(label, _method_name, studio_id, postgrest_client_timeout):
            self.assertEqual(postgrest_client_timeout, 10.0)
            self.assertEqual(studio_id, "studio-1")
            if label == "studio":
                return (
                    SimpleNamespace(data={
                        "id": "studio-1",
                        "name": "River City",
                        "slug": "river-city",
                        "timezone": "UTC",
                        "logo_url": None,
                    }),
                    (label, 1.0),
                )
            if label == "students":
                return SimpleNamespace(data=[], count=250), (label, 1.0)
            if label in {"leads", "belts"}:
                return SimpleNamespace(data=[]), (label, 1.0)
            if label == "programs":
                return [], (label, 1.0)
            raise AssertionError(f"Unexpected bootstrap fetch label: {label}")

        with patch(
            "app.services.dashboard_bootstrap_service.AuthService.get_user_profile",
            new=AsyncMock(return_value=auth),
        ), patch(
            "app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"
        ) as ensure_access, patch.object(
            DashboardBootstrapService,
            "_timed_fetch_with_isolated_client",
            side_effect=fake_timed_fetch,
        ):
            payload, timings = asyncio.run(
                service.get_dashboard_bootstrap("user-1")
            )

        ensure_access.assert_called_once_with(supabase, "studio-1")
        self.assertIsNone(payload.summary)
        self.assertEqual(payload.students_total, 250)
        self.assertTrue(payload.students_may_be_partial)
        self.assertNotIn("summary", timings)
        self.assertIn("total", timings)


if __name__ == "__main__":
    unittest.main()
