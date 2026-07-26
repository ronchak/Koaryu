"""Authorization across *consecutive* requests, which is where the throttle lives.

Every other throttle test decides a row shape once. The defect this file exists
for was invisible to all of them: first-request outcomes were identical before
and after the throttle, and the divergence only appeared on the second request
inside a recorded window. These therefore drive the real
`get_platform_subscription_access`, twice, and compare the authorization answer
rather than the row it was derived from.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.services import platform_billing_service, studio_scope
from app.services.platform_billing_service import (
    ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
)
from tests.platform_billing_helpers import FakeSettings, FakeSupabase


class ProductionSettings(FakeSettings):
    ENVIRONMENT = "production"


class UnreachableStripeService:
    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")


class ConfirmsActiveStripeService:
    """Reachable, and truthfully reports an active subscription whose period
    fields Stripe itself does not return. The repair succeeds, so the row is
    verified, but it stays repair-pending."""

    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        return {
            "id": subscription_id,
            "customer": "cus_123",
            "status": "active",
            "items": {"data": [{}]},
            "cancel_at_period_end": False,
        }

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        return []


def row(**overrides) -> dict:
    base = {
        "studio_id": "studio_1",
        "stripe_subscription_id": "sub_123",
        "stripe_customer_id": "cus_123",
        "status": "active",
        "comped": False,
        "trial_end": None,
        "current_period_start": 100,
        "current_period_end": 200,
    }
    base.update(overrides)
    return base


# Every one of these is locally ENTITLED — the access evaluator admits the row on
# `status` alone — and simultaneously triggers a repair, because the repair
# guards inspect Stripe identifiers and period integrity instead. That overlap is
# the whole defect: suppressing the repair for these rows hands an unverified but
# entitled-looking row straight to the access evaluator.
ENTITLED_BUT_REPAIR_PENDING = {
    "active with null periods": row(current_period_start=None, current_period_end=None),
    "active with inverted periods": row(current_period_start=900, current_period_end=100),
    "trialing without trial_end": row(status="trialing", trial_end=None),
    "active with customer id but no subscription id": row(stripe_subscription_id=None),
}


class AccessRepairSequenceTest(unittest.TestCase):
    def setUp(self):
        platform_billing_service._access_repair_retry_after.clear()
        UnreachableStripeService.calls = 0
        ConfirmsActiveStripeService.calls = 0

    def tearDown(self):
        platform_billing_service._access_repair_retry_after.clear()

    def attempt(self, supabase, stripe_cls, now: float) -> str:
        """The authorization outcome a tenant request would receive."""
        with (
            patch("app.services.platform_billing_service.StripeService", stripe_cls),
            patch("app.services.platform_billing_service.monotonic", return_value=now),
            patch(
                "app.services.platform_billing_service.get_settings",
                return_value=ProductionSettings(),
            ),
            patch("app.services.studio_scope.get_settings", return_value=ProductionSettings()),
        ):
            try:
                access = studio_scope.get_platform_subscription_access(supabase, "studio_1")
            except HTTPException as exc:
                return str(exc.status_code)
            return "allowed" if not access["subscription_required"] else "402"

    # --- the blocker ------------------------------------------------------

    def test_entitled_but_unverifiable_rows_stay_fail_closed_inside_the_window(self):
        """The row shapes where "a repair would run" and "the row is denied" disagree.

        Before this was fixed, request one failed closed with 503 and request two
        was ALLOWED, because the suppressed path returned the unverified row and
        the access evaluator saw `status == "active"`. During a sustained outage
        that granted unverified access for ~59 of every 60 seconds.
        """
        for label, subscription_row in ENTITLED_BUT_REPAIR_PENDING.items():
            with self.subTest(label):
                platform_billing_service._access_repair_retry_after.clear()
                UnreachableStripeService.calls = 0
                supabase = FakeSupabase([dict(subscription_row)])

                first = self.attempt(supabase, UnreachableStripeService, 0.0)
                second = self.attempt(supabase, UnreachableStripeService, 1.0)

                self.assertEqual(first, "503", "the first request must fail closed")
                self.assertEqual(second, "503", "so must every request inside the window")
                # The throttle still does its job: the second request did not
                # wait out another provider timeout on the single worker.
                self.assertEqual(UnreachableStripeService.calls, 1)

    def test_locally_lapsed_studio_is_denied_throughout_the_window(self):
        """The deny-side control. Unchanged, and still costs one provider call."""
        supabase = FakeSupabase([dict(row(status="canceled"))])

        first = self.attempt(supabase, UnreachableStripeService, 0.0)
        second = self.attempt(supabase, UnreachableStripeService, 1.0)

        self.assertEqual([first, second], ["402", "402"])
        self.assertEqual(UnreachableStripeService.calls, 1)

    def test_fail_closed_persists_across_the_whole_backoff(self):
        supabase = FakeSupabase([dict(ENTITLED_BUT_REPAIR_PENDING["active with null periods"])])

        self.assertEqual(self.attempt(supabase, UnreachableStripeService, 0.0), "503")
        for tick in (1.0, 30.0, ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS - 0.1):
            self.assertEqual(self.attempt(supabase, UnreachableStripeService, tick), "503")

        self.assertEqual(UnreachableStripeService.calls, 1)

    # --- what must NOT regress -------------------------------------------

    def test_a_verified_row_is_replayed_as_verified_not_as_a_fault(self):
        """A repair can succeed and still leave the row repair-pending.

        Stripe is reachable and confirms the subscription is active; it simply
        does not return period fields. That row is verified, so the studio is
        admitted — and the request one second later must be admitted too. Failing
        closed on "a repair is still pending" would deny a studio Stripe had
        affirmatively confirmed a moment earlier.
        """
        supabase = FakeSupabase([dict(ENTITLED_BUT_REPAIR_PENDING["active with null periods"])])

        first = self.attempt(supabase, ConfirmsActiveStripeService, 0.0)
        second = self.attempt(supabase, ConfirmsActiveStripeService, 1.0)

        self.assertEqual([first, second], ["allowed", "allowed"])
        self.assertEqual(ConfirmsActiveStripeService.calls, 1)

    def test_a_repair_landing_inside_the_window_takes_effect_immediately(self):
        """A webhook or an Admin refresh during the window is not ignored.

        The window is keyed to a row that needed repairing. Once that row no
        longer does, there is nothing left to suppress, and holding the recorded
        outcome for the rest of the window would discard reconciliation that has
        already happened.
        """
        supabase = FakeSupabase([dict(ENTITLED_BUT_REPAIR_PENDING["active with null periods"])])

        self.assertEqual(self.attempt(supabase, UnreachableStripeService, 0.0), "503")
        self.assertIn("studio_1", platform_billing_service._access_repair_retry_after)

        # Webhook projection writes a complete, self-consistent row.
        supabase.tables["studio_subscriptions"][0].update({
            "current_period_start": 100,
            "current_period_end": 200,
        })

        self.assertEqual(self.attempt(supabase, UnreachableStripeService, 1.0), "allowed")
        self.assertNotIn("studio_1", platform_billing_service._access_repair_retry_after)
        self.assertEqual(UnreachableStripeService.calls, 1)


if __name__ == "__main__":
    unittest.main()
