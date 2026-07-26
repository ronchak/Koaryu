from __future__ import annotations

from unittest.mock import patch

from app.services import platform_billing_service
from app.services.platform_billing_service import ACCESS_REPAIR_RETRY_INTERVAL_SECONDS
from tests.platform_billing_helpers import PlatformBillingServiceTestCase


def lapsed_rows(status: str = "canceled") -> list[dict]:
    return [{
        "studio_id": "studio_1",
        "stripe_subscription_id": "sub_123",
        "stripe_customer_id": "cus_123",
        "status": status,
        "comped": False,
    }]


class CountingStripeService:
    """Returns the subscription unchanged, which is what Stripe does for a
    genuinely lapsed studio. The local row therefore never becomes repairable,
    which is what made the retry non-convergent."""

    calls = 0
    reported_status = "canceled"

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        return {
            "id": subscription_id,
            "customer": "cus_123",
            "status": self.reported_status,
            "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
            "cancel_at_period_end": False,
        }

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        return []


class AccessRepairThrottleTest(PlatformBillingServiceTestCase):
    def setUp(self):
        platform_billing_service._access_repair_attempts.clear()
        CountingStripeService.calls = 0
        CountingStripeService.reported_status = "canceled"

    def tearDown(self):
        platform_billing_service._access_repair_attempts.clear()

    def test_lapsed_studio_consults_stripe_once_across_repeated_access_checks(self):
        service = self.service(lapsed_rows())

        with patch("app.services.platform_billing_service.StripeService", CountingStripeService):
            rows = [
                service.get_access_status_row("studio_1", strict_repairs=True)
                for _ in range(5)
            ]

        self.assertEqual(CountingStripeService.calls, 1)
        # Throttling must not change the entitlement answer.
        for row in rows:
            self.assertEqual(row["status"], "canceled")

    def test_retry_window_reopens_after_the_interval(self):
        service = self.service(lapsed_rows())

        with (
            patch("app.services.platform_billing_service.StripeService", CountingStripeService),
            patch("app.services.platform_billing_service.monotonic", return_value=1000.0),
        ):
            service.get_access_status_row("studio_1", strict_repairs=True)
            service.get_access_status_row("studio_1", strict_repairs=True)

        self.assertEqual(CountingStripeService.calls, 1)

        later = 1000.0 + ACCESS_REPAIR_RETRY_INTERVAL_SECONDS + 1
        with (
            patch("app.services.platform_billing_service.StripeService", CountingStripeService),
            patch("app.services.platform_billing_service.monotonic", return_value=later),
        ):
            service.get_access_status_row("studio_1", strict_repairs=True)

        self.assertEqual(CountingStripeService.calls, 2)

    def test_admin_status_refresh_is_not_throttled(self):
        """strict_repairs=False is the explicit billing read, which must always
        reconcile so an operator can force a refresh."""
        service = self.service(lapsed_rows())

        with patch("app.services.platform_billing_service.StripeService", CountingStripeService):
            for _ in range(3):
                service.get_access_status_row("studio_1")

        self.assertEqual(CountingStripeService.calls, 3)
        self.assertNotIn("studio_1", platform_billing_service._access_repair_attempts)

    def test_successful_repair_clears_the_retry_window(self):
        service = self.service(lapsed_rows(status="incomplete"))
        CountingStripeService.reported_status = "active"

        with patch("app.services.platform_billing_service.StripeService", CountingStripeService):
            row = service.get_access_status_row("studio_1", strict_repairs=True)

        self.assertEqual(row["status"], "active")
        self.assertNotIn("studio_1", platform_billing_service._access_repair_attempts)

    def test_throttle_delays_but_does_not_lose_a_lost_webhook_upgrade(self):
        """Documents the cost of throttling, so it stays bounded and visible.

        Repairing on every request also acted as a safety net when webhook
        delivery failed: a studio that paid mid-session got in on its next
        request. Inside the retry window that no longer happens, so a studio
        whose webhook is lost stays denied until the window closes. The delay
        must stay bounded by ACCESS_REPAIR_RETRY_INTERVAL_SECONDS and must
        never become permanent.
        """
        service = self.service(lapsed_rows(status="incomplete"))
        # Stripe has not seen the payment yet, so the first repair is a no-op.
        CountingStripeService.reported_status = "incomplete"

        def access_row(now):
            with (
                patch("app.services.platform_billing_service.StripeService", CountingStripeService),
                patch("app.services.platform_billing_service.monotonic", return_value=now),
            ):
                return service.get_access_status_row("studio_1", strict_repairs=True)

        # Stripe agrees the studio is not yet paid; the retry window opens.
        first = access_row(0.0)
        self.assertEqual(first["status"], "incomplete")

        # The studio pays. No webhook arrives, so only a repair could notice.
        CountingStripeService.reported_status = "active"

        inside = access_row(ACCESS_REPAIR_RETRY_INTERVAL_SECONDS - 1)
        self.assertEqual(inside["status"], "incomplete", "still throttled inside the window")

        outside = access_row(ACCESS_REPAIR_RETRY_INTERVAL_SECONDS + 1)
        self.assertEqual(outside["status"], "active", "must recover once the window closes")

    def test_retry_window_stays_short_enough_to_bound_that_delay(self):
        self.assertLessEqual(
            ACCESS_REPAIR_RETRY_INTERVAL_SECONDS,
            60,
            "a longer window extends how long a paid studio can stay locked out "
            "when webhook delivery fails",
        )

    def test_throttle_is_scoped_per_studio(self):
        rows = lapsed_rows()
        rows.append({
            "studio_id": "studio_2",
            "stripe_subscription_id": "sub_456",
            "stripe_customer_id": "cus_456",
            "status": "canceled",
            "comped": False,
        })
        service = self.service(rows)

        with patch("app.services.platform_billing_service.StripeService", CountingStripeService):
            service.get_access_status_row("studio_1", strict_repairs=True)
            service.get_access_status_row("studio_2", strict_repairs=True)

        self.assertEqual(CountingStripeService.calls, 2)
