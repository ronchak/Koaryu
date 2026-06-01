import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException, status

from app.services.studio_scope import (
    MISSING_STRIPE_CONFIGURATION_DETAIL,
    ensure_platform_subscription_access,
    get_platform_subscription_access,
)
from tests.fakes.supabase import TableBackedSupabase


def fake_supabase(row: dict) -> TableBackedSupabase:
    row.setdefault("studio_id", "studio_1")
    return TableBackedSupabase({"studio_subscriptions": [row]})


class StudioScopePlatformAccessTest(unittest.TestCase):
    def test_access_uses_repaired_platform_status_before_local_row(self):
        supabase = fake_supabase({
            "status": "incomplete",
            "comped": False,
            "trial_end": None,
        })
        repaired_row = {
            "status": "active",
            "comped": False,
            "trial_end": None,
        }

        with patch(
            "app.services.platform_billing_service.PlatformBillingService.get_access_status_row",
            return_value=repaired_row,
        ):
            access = get_platform_subscription_access(supabase, "studio_1")

        self.assertFalse(access["subscription_required"])
        self.assertEqual(access["status"], "active")
        self.assertEqual(supabase.query_log, [])

    def test_access_does_not_fall_back_to_stale_local_row_when_service_fails(self):
        supabase = fake_supabase({
            "status": "active",
            "comped": False,
            "trial_end": None,
        })

        with patch(
            "app.services.platform_billing_service.PlatformBillingService.get_access_status_row",
            side_effect=RuntimeError("Stripe unavailable"),
        ):
            with self.assertRaises(HTTPException) as context:
                get_platform_subscription_access(supabase, "studio_1")

        self.assertEqual(context.exception.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(context.exception.detail["code"], "BILLING_STATUS_UNAVAILABLE")
        self.assertEqual(supabase.query_log, [])

    def test_access_falls_back_to_local_row_when_stripe_is_not_configured(self):
        supabase = fake_supabase({
            "status": "active",
            "comped": False,
            "trial_end": None,
        })

        with patch(
            "app.services.platform_billing_service.PlatformBillingService.get_access_status_row",
            side_effect=HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=MISSING_STRIPE_CONFIGURATION_DETAIL,
            ),
        ):
            access = get_platform_subscription_access(supabase, "studio_1")

        self.assertFalse(access["subscription_required"])
        self.assertEqual(access["status"], "active")
        self.assertEqual(len(supabase.query_log), 1)

    def test_access_does_not_use_no_stripe_fallback_in_production(self):
        supabase = fake_supabase({
            "status": "active",
            "comped": False,
            "trial_end": None,
        })

        with (
            patch("app.services.studio_scope.get_settings", return_value=SimpleNamespace(ENVIRONMENT="production")),
            patch(
                "app.services.platform_billing_service.PlatformBillingService.get_access_status_row",
                side_effect=HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=MISSING_STRIPE_CONFIGURATION_DETAIL,
                ),
            ),
        ):
            with self.assertRaises(HTTPException) as context:
                get_platform_subscription_access(supabase, "studio_1")

        self.assertEqual(context.exception.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(context.exception.detail["code"], "BILLING_STATUS_UNAVAILABLE")
        self.assertEqual(supabase.query_log, [])

    def test_ensure_platform_subscription_access_allows_repaired_active_status(self):
        supabase = fake_supabase({
            "status": "incomplete",
            "comped": False,
            "trial_end": None,
        })
        repaired_row = {
            "status": "active",
            "comped": False,
            "trial_end": None,
        }

        with patch(
            "app.services.platform_billing_service.PlatformBillingService.get_access_status_row",
            return_value=repaired_row,
        ):
            ensure_platform_subscription_access(supabase, "studio_1")

    def test_ensure_platform_subscription_access_reports_unavailable_when_service_fails(self):
        supabase = fake_supabase({
            "status": "incomplete",
            "comped": False,
            "trial_end": None,
        })

        with patch(
            "app.services.platform_billing_service.PlatformBillingService.get_access_status_row",
            side_effect=RuntimeError("Stripe unavailable"),
        ):
            with self.assertRaises(HTTPException) as context:
                ensure_platform_subscription_access(supabase, "studio_1")

        self.assertEqual(context.exception.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(context.exception.detail["code"], "BILLING_STATUS_UNAVAILABLE")

    def test_access_repairs_stale_incomplete_subscription_before_denial(self):
        supabase = fake_supabase({
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "incomplete",
            "comped": False,
        })

        class FakeStripeService:
            calls = 0

            def retrieve_subscription(self, subscription_id):
                FakeStripeService.calls += 1
                assert subscription_id == "sub_123"
                return {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "active",
                    "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                    "cancel_at_period_end": False,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            access = get_platform_subscription_access(supabase, "studio_1")

        self.assertFalse(access["subscription_required"])
        self.assertEqual(access["status"], "active")
        self.assertEqual(supabase.tables["studio_subscriptions"][0]["status"], "active")
        self.assertEqual(FakeStripeService.calls, 1)

    def test_access_repairs_expired_trialing_subscription_before_denial(self):
        supabase = fake_supabase({
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "comped": False,
            "trial_end": "1970-01-01T00:05:00+00:00",
            "current_period_start": "1970-01-01T00:01:40+00:00",
            "current_period_end": "2999-01-01T00:03:20+00:00",
        })

        class FakeStripeService:
            calls = 0

            def retrieve_subscription(self, subscription_id):
                FakeStripeService.calls += 1
                assert subscription_id == "sub_123"
                return {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "active",
                    "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                    "cancel_at_period_end": False,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            ensure_platform_subscription_access(supabase, "studio_1")

        self.assertEqual(supabase.tables["studio_subscriptions"][0]["status"], "active")
        self.assertEqual(FakeStripeService.calls, 1)

    def test_access_reports_unavailable_when_strict_repair_fails(self):
        supabase = fake_supabase({
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "comped": False,
            "current_period_start": None,
            "current_period_end": None,
        })

        class FakeStripeService:
            calls = 0

            def retrieve_subscription(self, subscription_id):
                FakeStripeService.calls += 1
                assert subscription_id == "sub_123"
                raise RuntimeError("Stripe timeout")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                get_platform_subscription_access(supabase, "studio_1")

        self.assertEqual(context.exception.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(context.exception.detail["code"], "BILLING_STATUS_UNAVAILABLE")
        self.assertEqual(FakeStripeService.calls, 1)

    def test_access_uses_local_row_when_strict_repair_hits_missing_stripe_config(self):
        supabase = fake_supabase({
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "comped": False,
            "current_period_start": None,
            "current_period_end": None,
        })

        class FakeStripeService:
            calls = 0

            def retrieve_subscription(self, subscription_id):
                FakeStripeService.calls += 1
                assert subscription_id == "sub_123"
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=MISSING_STRIPE_CONFIGURATION_DETAIL,
                )

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            access = get_platform_subscription_access(supabase, "studio_1")

        self.assertFalse(access["subscription_required"])
        self.assertEqual(access["status"], "active")
        self.assertEqual(FakeStripeService.calls, 1)


if __name__ == "__main__":
    unittest.main()
