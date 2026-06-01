import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.schemas.auth import AuthResponse, UserProfile
from app.services.dashboard_bootstrap_service import DashboardBootstrapService


class DashboardBootstrapServiceTest(unittest.TestCase):
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
        supabase = object()
        service = DashboardBootstrapService(supabase=supabase)
        auth = AuthResponse(
            user=UserProfile(id="user-1", email="owner@example.com", full_name="Owner"),
            studio_id="studio-1",
            role="admin",
        )

        def fake_timed_fetch(label, _method_name, studio_id):
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
