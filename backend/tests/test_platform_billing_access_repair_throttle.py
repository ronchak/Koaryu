from __future__ import annotations

from unittest.mock import patch

from fastapi import HTTPException

from app.services import platform_billing_service
from app.services.platform_billing_service import (
    ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
    ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS,
    AccessRepairDeferred,
    AccessRepairProviderError,
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
        raise TimeoutError("Stripe timeout")

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")


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

        # Every later request inside the backoff is answered without waiting out
        # another provider timeout, so the worker is free. It replays the fault
        # rather than the unverified row: this method used to assert that the
        # raw row came back, which is precisely how the suppressed path came to
        # hand an unverified row to the access evaluator.
        for tick in (1.0, 2.0, 30.0, 59.0):
            with self.assertRaises(AccessRepairDeferred):
                self.access(service, UnreachableStripeService, tick)

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

    # --- which failure bought which window --------------------------------

    @staticmethod
    def failing_stripe(exc: Exception):
        class FailingStripeService:
            calls = 0

            def retrieve_subscription(self, subscription_id):
                type(self).calls += 1
                raise exc

            def list_customer_subscriptions(self, customer_id):
                type(self).calls += 1
                raise exc

        return FailingStripeService

    def window_bought_by(self, exc: Exception, *, expect_raises=AccessRepairProviderError):
        """The backoff a single failure of this kind opens, or None for no window.

        `expect_raises` is asserted rather than swallowed: catching bare
        Exception here would let a mistake in this harness pass for the failure
        under test, which is how an earlier version of this method silently
        measured a TypeError of its own.
        """
        platform_billing_service._access_repair_retry_after.clear()
        service = self.service(lapsed_rows())
        service.settings = type("S", (), {"ENVIRONMENT": "production"})()
        with self.assertRaises(expect_raises):
            self.access(service, self.failing_stripe(exc), 0.0)
        window = platform_billing_service._access_repair_retry_after.get("studio_1")
        return None if window is None else window.retry_after

    def test_an_unreachable_stripe_buys_the_long_backoff(self):
        """The only failure the 60s window is justified for.

        It is justified because the request stalls the worker for a full timeout
        and because Stripe confirms no payments while it is unreachable, so
        retrying sooner cannot let a paid studio in any earlier.
        """
        for exc in (TimeoutError("timed out"), ConnectionError("connection refused")):
            with self.subTest(type(exc).__name__):
                self.assertEqual(self.window_bought_by(exc), ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS)

    def test_a_reachable_but_erroring_stripe_buys_only_the_short_window(self):
        """A 5xx, a rate limit or a stale subscription id returns fast.

        None of them tie up the worker, which is the sole thing the long backoff
        buys, and checkout and webhook delivery are separate surfaces from the
        retrieve — a payment can land while a retrieve is erroring. Backing these
        off for a minute costs a paid studio real time for no availability gain.
        """
        for exc in (
            RuntimeError("stripe returned 502"),
            ValueError("no such subscription: sub_stale"),
        ):
            with self.subTest(type(exc).__name__):
                self.assertEqual(self.window_bought_by(exc), ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS)

    def test_our_own_failures_buy_no_window_at_all(self):
        """A persistence or projection fault is not a provider outage.

        Backing off cannot help, and recording one would present our own outage
        as Stripe's.
        """
        service = self.service(lapsed_rows(status="incomplete"))
        CountingStripeService.reported_status = "active"

        with patch(
            "app.services.platform_billing_service.PlatformBillingService._update_subscription_row",
            side_effect=HTTPException(status_code=404, detail="Koaryu Core billing record not found."),
        ):
            with self.assertRaises(HTTPException):
                self.access(service, CountingStripeService, 0.0)

        self.assertNotIn("studio_1", platform_billing_service._access_repair_retry_after)

    def test_a_missing_stripe_configuration_is_not_treated_as_an_outage(self):
        """It is a deployment fault, and _can_degrade_access_repair still has to
        recognise it by type, so it must reach the repair methods unwrapped."""
        missing_config = HTTPException(
            status_code=409,
            detail=platform_billing_service.MISSING_STRIPE_CONFIGURATION_DETAIL,
        )

        # It reaches the repair method unwrapped, so _can_degrade_access_repair
        # still recognises it and it is re-raised as itself outside development.
        self.assertIsNone(self.window_bought_by(missing_config, expect_raises=HTTPException))

    def test_a_missing_stripe_sdk_is_not_treated_as_an_outage_either(self):
        """The 409 config error's sibling, raised one function away in StripeService.

        It means the same class of thing — Stripe could not be called because
        this deployment is not set up — so it must classify the same way. While
        only the 409 was carved out, a broken deploy bought a provider backoff
        and answered a lapsed studio with SUBSCRIPTION_REQUIRED, reporting a
        Koaryu deployment fault as the studio's billing problem.
        """
        missing_sdk = HTTPException(
            status_code=500,
            detail="Stripe SDK is not installed. Install backend requirements before using live billing.",
        )

        self.assertIsNone(self.window_bought_by(missing_sdk, expect_raises=HTTPException))

    def test_deployment_errors_are_distinguished_from_provider_errors(self):
        """The classifier itself, so the boundary is pinned rather than implied."""
        service = self.service(lapsed_rows())

        deployment = [
            HTTPException(status_code=409, detail=platform_billing_service.MISSING_STRIPE_CONFIGURATION_DETAIL),
            HTTPException(status_code=500, detail="Stripe SDK is not installed. Install backend requirements."),
        ]
        not_deployment = [
            # Our own persistence failure, which happens to share the type.
            HTTPException(status_code=404, detail="Koaryu Core billing record not found."),
            HTTPException(status_code=500, detail="Something else entirely."),
            TimeoutError("timed out"),
            RuntimeError("stripe returned 502"),
        ]

        for exc in deployment:
            with self.subTest(f"deployment: {exc.detail}"):
                self.assertTrue(service._is_stripe_deployment_error(exc))
        for exc in not_deployment:
            with self.subTest(f"not deployment: {exc}"):
                self.assertFalse(service._is_stripe_deployment_error(exc))

    def test_outage_backoff_is_longer_than_the_healthy_recheck(self):
        """Backing off hard during an outage costs no entitlement latency,
        because Stripe cannot confirm a payment while it is unreachable."""
        self.assertGreater(
            ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
            ACCESS_REPAIR_RECHECK_INTERVAL_SECONDS,
        )

    # --- the guard list cannot drift from the repair chain -----------------

    def test_every_repair_in_the_chain_is_visible_to_the_throttle_predicate(self):
        """A repair the predicate cannot see is a repair the throttle cannot bound.

        The chain and the predicate used to be two hand-maintained lists that
        happened to agree. A fourth repair added to one and missed in the other
        would silently restore an unthrottled retry for its shape — deny-side
        and availability-only, and so invisible until it was measured.
        """
        guards = [guard for guard, _repair in platform_billing_service.ACCESS_REPAIR_STEPS]
        repairs = [repair for _guard, repair in platform_billing_service.ACCESS_REPAIR_STEPS]

        self.assertEqual(len(guards), len(set(guards)))
        self.assertEqual(len(repairs), len(set(repairs)))

        # Every `_repair_*` method that takes strict_repairs is part of the
        # authorization chain, so it must be paired with a guard here.
        chain_repairs = {
            name
            for name in dir(platform_billing_service.PlatformBillingService)
            if name.startswith("_repair_")
        }
        self.assertEqual({repair.__name__ for repair in repairs}, chain_repairs)

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
