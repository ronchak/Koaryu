from __future__ import annotations

from unittest.mock import patch

from fastapi import HTTPException

from app.services import platform_billing_service
from app.services.platform_billing_service import (
    ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
    ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS,
)
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


class UnreachableStripeService:
    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        raise RuntimeError("Stripe timeout")

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        raise RuntimeError("Stripe timeout")


class AccessRepairThrottleTest(PlatformBillingServiceTestCase):
    def setUp(self):
        platform_billing_service._access_repair_retry_after.clear()
        CountingStripeService.calls = 0
        CountingStripeService.reported_status = "canceled"
        UnreachableStripeService.calls = 0

    def tearDown(self):
        platform_billing_service._access_repair_retry_after.clear()

    def access(self, service, stripe_cls, now):
        with (
            patch("app.services.platform_billing_service.StripeService", stripe_cls),
            patch("app.services.platform_billing_service.monotonic", return_value=now),
            patch(
                "app.services.platform_billing_service.get_settings",
                return_value=type("S", (), {"ENVIRONMENT": "production"})(),
            ),
        ):
            return service.get_access_status_row("studio_1", strict_repairs=True)

    # --- provider healthy -------------------------------------------------

    def test_lapsed_studio_is_not_rechecked_on_every_request(self):
        service = self.service(lapsed_rows())

        for tick in (0.0, 1.0, 2.0, 3.0, 4.0):
            row = self.access(service, CountingStripeService, tick)
            self.assertEqual(row["status"], "canceled")

        self.assertEqual(CountingStripeService.calls, 1)

    def test_a_paid_studio_gets_in_within_the_recheck_window(self):
        """The delay a real person feels after paying when their webhook is lost.

        Only a repair can notice the payment, so this bounds how long they wait.
        """
        service = self.service(lapsed_rows(status="incomplete"))
        CountingStripeService.reported_status = "incomplete"

        self.assertEqual(self.access(service, CountingStripeService, 0.0)["status"], "incomplete")

        CountingStripeService.reported_status = "active"  # payment lands, no webhook

        still_waiting = self.access(service, CountingStripeService, ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS - 1)
        self.assertEqual(still_waiting["status"], "incomplete")

        recovered = self.access(service, CountingStripeService, ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS + 0.1)
        self.assertEqual(recovered["status"], "active")

    def test_recheck_window_stays_imperceptible(self):
        self.assertLessEqual(
            ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS,
            5,
            "this is how long a studio waits after a confirmed payment when its "
            "webhook is lost; anything longer is felt by the user",
        )

    def test_successful_repair_clears_the_window(self):
        service = self.service(lapsed_rows(status="incomplete"))
        CountingStripeService.reported_status = "active"

        row = self.access(service, CountingStripeService, 0.0)

        self.assertEqual(row["status"], "active")
        self.assertNotIn("studio_1", platform_billing_service._access_repair_retry_after)

    # --- provider failing -------------------------------------------------

    def test_provider_outage_is_backed_off_after_the_first_timeout(self):
        """The case the throttle exists for.

        A previous version recorded the window only after a *successful* repair,
        so an outage — the one thing that stalls the worker — went entirely
        unthrottled and every request paid a full Stripe timeout.
        """
        service = self.service(lapsed_rows())

        # The first request discovers the outage and fails closed.
        with self.assertRaises(Exception):
            self.access(service, UnreachableStripeService, 0.0)

        # Every later request inside the backoff resolves from the local row
        # instead of waiting out another provider timeout. The studio is still
        # denied downstream — the row is unchanged — but the worker is free.
        for tick in (1.0, 2.0, 30.0, 59.0):
            row = self.access(service, UnreachableStripeService, tick)
            self.assertEqual(row["status"], "canceled")

        self.assertEqual(UnreachableStripeService.calls, 1)

    def test_provider_outage_backoff_expires_so_recovery_is_noticed(self):
        service = self.service(lapsed_rows())

        with self.assertRaises(Exception):
            self.access(service, UnreachableStripeService, 0.0)
        self.assertEqual(UnreachableStripeService.calls, 1)

        row = self.access(
            service,
            CountingStripeService,
            ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS + 0.1,
        )
        self.assertEqual(CountingStripeService.calls, 1)
        self.assertEqual(row["status"], "canceled")

    def test_outage_backoff_is_longer_than_the_healthy_recheck(self):
        """Backing off hard during an outage costs no entitlement latency,
        because Stripe cannot confirm a payment while it is unreachable."""
        self.assertGreater(
            ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
            ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS,
        )

    # --- scoping ----------------------------------------------------------

    def test_admin_status_refresh_is_not_throttled(self):
        """strict_repairs=False is the explicit billing read, which must always
        reconcile so an operator can force a refresh."""
        service = self.service(lapsed_rows())

        with patch("app.services.platform_billing_service.StripeService", CountingStripeService):
            for _ in range(3):
                service.get_access_status_row("studio_1")

        self.assertEqual(CountingStripeService.calls, 3)
        self.assertNotIn("studio_1", platform_billing_service._access_repair_retry_after)

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

        self.access(service, CountingStripeService, 0.0)
        with patch("app.services.platform_billing_service.StripeService", CountingStripeService):
            with patch("app.services.platform_billing_service.monotonic", return_value=0.0):
                service.get_access_status_row("studio_2", strict_repairs=True)

        self.assertEqual(CountingStripeService.calls, 2)
