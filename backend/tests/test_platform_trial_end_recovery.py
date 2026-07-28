"""A denial the authorization path can talk itself out of.

`_trial_has_ended` fails closed on a `trial_end` it cannot parse — an
unreadable trial is treated as an ended one, which is the behaviour
`docs/billing-boundary.md` asks for. The bug was not that pessimism; it was
that `_should_repair_subscription_state` read the same field optimistically,
so nothing in the authorization path ever revisited the row. The evaluator
denied on every request and the repair machinery saw nothing to fix, which
made the denial permanent rather than merely strict.

These drive the real `get_platform_subscription_access`, because the defect is
an interaction between two modules and neither one is wrong on its own.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.services import platform_billing_service, studio_scope
from tests.platform_billing_helpers import FakeSettings, FakeSupabase


class ProductionSettings(FakeSettings):
    ENVIRONMENT = "production"


class ConfirmsHealthyTrialStripe:
    """Stripe knows the studio is mid-trial and returns a clean trial_end."""

    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        return {
            "id": subscription_id or "sub_123",
            "customer": "cus_123",
            "status": "trialing",
            "trial_end": 4102444800,  # 2100-01-01
            "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
            "cancel_at_period_end": False,
        }

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        return []


class ConfirmsCanceledStripe:
    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        return {
            "id": subscription_id or "sub_123",
            "customer": "cus_123",
            "status": "canceled",
            "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
            "cancel_at_period_end": False,
        }

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        return []


class UnreachableStripe:
    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")


def trialing_row(**overrides) -> dict:
    base = {
        "studio_id": "studio_1",
        "stripe_subscription_id": "sub_123",
        "stripe_customer_id": "cus_123",
        "status": "trialing",
        "comped": False,
        "trial_end": "not-a-date",
        "current_period_start": 100,
        "current_period_end": 200,
    }
    base.update(overrides)
    return base


class TrialEndRecoveryTest(unittest.TestCase):
    def setUp(self):
        platform_billing_service._access_repair_retry_after.clear()
        for stub in (ConfirmsHealthyTrialStripe, ConfirmsCanceledStripe, UnreachableStripe):
            stub.calls = 0

    def tearDown(self):
        platform_billing_service._access_repair_retry_after.clear()

    def attempt(self, supabase, stripe_cls, now: float) -> str:
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

    # --- the bug ----------------------------------------------------------

    def test_an_unreadable_trial_end_is_repaired_rather_than_denied_forever(self):
        """The studio must be able to get out of this state on its own.

        Before the fix: 402 on every request, zero provider calls, and the row
        unchanged — so webhook projection or an Admin refresh were the only
        things that could ever have fixed it, and neither is part of the
        authorization path.
        """
        supabase = FakeSupabase([trialing_row()])

        first = self.attempt(supabase, ConfirmsHealthyTrialStripe, 0.0)

        self.assertEqual(first, "allowed")
        self.assertEqual(ConfirmsHealthyTrialStripe.calls, 1, "Stripe was never consulted")
        self.assertEqual(
            supabase.tables["studio_subscriptions"][0]["trial_end"],
            "2100-01-01T00:00:00+00:00",
            "the unreadable value is still in the row, so the denial would recur",
        )

    def test_the_repaired_row_needs_no_further_provider_calls(self):
        """Recovery has to be permanent, not re-earned on every request."""
        supabase = FakeSupabase([trialing_row()])

        outcomes = [self.attempt(supabase, ConfirmsHealthyTrialStripe, float(t)) for t in range(5)]

        self.assertEqual(outcomes, ["allowed"] * 5)
        self.assertEqual(ConfirmsHealthyTrialStripe.calls, 1)

    # --- and it must not have become a way in -----------------------------

    def test_an_unreadable_trial_end_is_not_trusted_when_stripe_disagrees(self):
        """Repairing is not the same as admitting. Stripe decides."""
        supabase = FakeSupabase([trialing_row()])

        outcomes = [self.attempt(supabase, ConfirmsCanceledStripe, float(t)) for t in range(3)]

        self.assertEqual(outcomes, ["402"] * 3)

    def test_an_unreadable_trial_end_still_denies_while_stripe_is_unreachable(self):
        """The row cannot be verified, so it is not believed.

        The local row is deny-side on its own reading — an unreadable trial is
        an ended trial — so 402 is the accurate answer rather than 503.
        """
        supabase = FakeSupabase([trialing_row()])

        outcomes = [self.attempt(supabase, UnreachableStripe, float(t)) for t in range(3)]

        self.assertEqual(outcomes, ["402"] * 3)
        self.assertEqual(UnreachableStripe.calls, 1, "the repair throttle still applies")

    # --- neighbouring shapes must not have moved --------------------------

    def test_a_readable_trial_end_is_unaffected(self):
        cases = {
            "future": ("2099-01-01T00:00:00+00:00", "allowed", 0),
            "past": ("2000-01-01T00:00:00+00:00", "allowed", 1),  # repaired, Stripe says trialing
        }
        for label, (trial_end, expected, expected_calls) in cases.items():
            with self.subTest(label):
                platform_billing_service._access_repair_retry_after.clear()
                ConfirmsHealthyTrialStripe.calls = 0
                supabase = FakeSupabase([trialing_row(trial_end=trial_end)])

                self.assertEqual(self.attempt(supabase, ConfirmsHealthyTrialStripe, 0.0), expected)
                self.assertEqual(ConfirmsHealthyTrialStripe.calls, expected_calls)

    def test_an_absent_trial_end_is_not_routed_through_the_state_repair(self):
        """A falsy trial_end is a different case and already had an owner.

        The evaluator ignores it and admits the row, and
        _should_repair_subscription_periods already treats a trialing row
        without a trial_end as repairable. Widening the state guard to cover it
        would be redundant, so the guard must stay indifferent to it.
        """
        service = platform_billing_service.PlatformBillingService(FakeSupabase([]))

        for absent in (None, ""):
            with self.subTest(repr(absent)):
                self.assertFalse(
                    service._should_repair_subscription_state(trialing_row(trial_end=absent))
                )

        self.assertTrue(
            service._should_repair_subscription_state(trialing_row(trial_end="not-a-date"))
        )


if __name__ == "__main__":
    unittest.main()
