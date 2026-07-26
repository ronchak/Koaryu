"""The invariant the repair throttle has to satisfy, stated once over every shape.

    With the local row unchanged between them, a request that is answered from a
    recorded throttle window produces the same authorization outcome as the
    request that opened it.

This is what makes the throttle safe to have at all. It is deliberately not a
claim about *which* rows reach the throttle — reasoning of that kind is what
produced the defect this file was written after, because the set of rows that
trigger a repair and the set of rows the access evaluator denies overlap without
either containing the other. Stated as an outcome property it needs no case
analysis and cannot be defeated by adding a repair guard later.

The row-shape matrix used to be an uncommitted script run by hand after each
revision. It was also single-request, so it could not have caught that defect:
first-request outcomes were identical before and after the throttle existed.
Committed here with the second-request dimension it was missing.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.services import platform_billing_service, studio_scope
from tests.platform_billing_helpers import FakeSettings, FakeSupabase


class ProductionSettings(FakeSettings):
    ENVIRONMENT = "production"


class ReachableStripeService:
    """Reports the subscription as still lapsed, which is what Stripe does for a
    genuinely lapsed studio, so the repair succeeds without repairing."""

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


class UnreachableStripeService:
    calls = 0

    def retrieve_subscription(self, subscription_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")

    def list_customer_subscriptions(self, customer_id):
        type(self).calls += 1
        raise TimeoutError("Stripe timeout")


def confirming(status_value: str, *, periods: bool, trial_end=None):
    """A reachable Stripe that confirms a particular state.

    The single-field sweep below can only observe a field that is missing from
    the fingerprint if the row the window was recorded for is one where that
    field is load-bearing — and after a successful repair, that row is whatever
    Stripe said. One stub that always answers `canceled` with valid periods
    therefore leaves `comped` and `trial_end` untestable, because no reachable
    row shape makes them matter. These span the states that do.
    """

    class ConfirmingStripeService:
        calls = 0

        def retrieve_subscription(self, subscription_id):
            type(self).calls += 1
            item = (
                {"current_period_start": 100, "current_period_end": 200}
                if periods
                else {}
            )
            payload = {
                "id": subscription_id or "sub_123",
                "customer": "cus_123",
                "status": status_value,
                "items": {"data": [item]},
                "cancel_at_period_end": False,
            }
            if trial_end is not None:
                payload["trial_end"] = trial_end
            return payload

        def list_customer_subscriptions(self, customer_id):
            type(self).calls += 1
            return []

    return ConfirmingStripeService


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


FUTURE = "2099-01-01T00:00:00+00:00"
PAST = "2000-01-01T00:00:00+00:00"

ROW_SHAPES = {
    # entitled and self-consistent — no provider call at all
    "active": row(),
    "trialing with a future trial_end": row(status="trialing", trial_end=FUTURE),
    "comped": row(comped=True, status="canceled"),
    "comped with no subscription id": row(comped=True, stripe_subscription_id=None),
    # entitled by status, but repair-pending — the overlap that broke
    "active with null periods": row(current_period_start=None, current_period_end=None),
    "active with a missing period end": row(current_period_end=None),
    "active with inverted periods": row(current_period_start=900, current_period_end=100),
    "trialing with no trial_end": row(status="trialing", trial_end=None),
    "active with no subscription id": row(stripe_subscription_id=None),
    "trialing with no subscription id": row(status="trialing", trial_end=FUTURE, stripe_subscription_id=None),
    # deny-side
    "canceled": row(status="canceled"),
    "incomplete": row(status="incomplete"),
    "incomplete_expired": row(status="incomplete_expired"),
    "past_due": row(status="past_due"),
    "unpaid": row(status="unpaid"),
    "trialing past its trial_end": row(status="trialing", trial_end=PAST),
    "trialing with a garbage trial_end": row(status="trialing", trial_end="not-a-date"),
    # degenerate
    "null status": row(status=None),
    "garbage status": row(status="wat"),
    "no stripe identifiers at all": row(stripe_subscription_id=None, stripe_customer_id=None),
    "missing status key": {"studio_id": "studio_1", "stripe_subscription_id": "sub_123", "stripe_customer_id": "cus_123"},
    "bare row": {"studio_id": "studio_1"},
}

STRIPE_REACHABILITY = {
    "stripe reachable": ReachableStripeService,
    "stripe unreachable": UnreachableStripeService,
}


class AccessRepairOutcomeNeutralityTest(unittest.TestCase):
    def setUp(self):
        platform_billing_service._access_repair_retry_after.clear()

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

    def test_a_throttled_request_answers_exactly_as_the_request_that_opened_the_window(self):
        for reachability, stripe_cls in STRIPE_REACHABILITY.items():
            for label, subscription_row in ROW_SHAPES.items():
                with self.subTest(f"{label} / {reachability}"):
                    platform_billing_service._access_repair_retry_after.clear()
                    stripe_cls.calls = 0
                    supabase = FakeSupabase([dict(subscription_row)])

                    first = self.attempt(supabase, stripe_cls, 0.0)
                    # Inside whichever window the first request recorded, if any.
                    second = self.attempt(supabase, stripe_cls, 1.0)

                    self.assertEqual(
                        second,
                        first,
                        f"a throttled request changed the answer for {label} "
                        f"({reachability}): {first} then {second}",
                    )

    def test_no_shape_is_ever_allowed_while_stripe_is_unreachable_unless_it_needs_no_repair(self):
        """The fail-closed control, stated directly.

        A row may only be admitted during an outage if it is entitled *and*
        self-consistent, because such a row is never sent to Stripe in the first
        place. Anything that would have needed verification must not be admitted
        on the strength of an unverified local row.
        """
        for label, subscription_row in ROW_SHAPES.items():
            with self.subTest(label):
                platform_billing_service._access_repair_retry_after.clear()
                UnreachableStripeService.calls = 0
                supabase = FakeSupabase([dict(subscription_row)])

                outcomes = [
                    self.attempt(supabase, UnreachableStripeService, tick)
                    for tick in (0.0, 1.0, 2.0)
                ]

                if UnreachableStripeService.calls == 0:
                    continue  # entitled and self-consistent; Stripe never consulted

                self.assertNotIn(
                    "allowed",
                    outcomes,
                    f"{label} was admitted on an unverified row during an outage",
                )

    def test_a_row_rewritten_mid_window_is_answered_on_its_own_merits(self):
        """The invariant again, across every transition rather than every shape.

        A window is a statement about one row state. The row is re-read each
        request, and webhook projection or an Admin refresh can rewrite it
        mid-window, so the second request must produce whatever the rewritten
        row is worth with no window at all — never the verdict recorded for the
        row it replaced.

        This is stated over all ~500 shape transitions rather than a handful of
        hand-picked ones because the field that has to stay in the fingerprint
        is not the same field for every row: `comped` is load-bearing only for
        a row the evaluator would otherwise deny, `trial_end` only for a
        `trialing` row, and so on. Picking examples tests whichever fields the
        examples happened to exercise.
        """
        for reachability, stripe_cls in STRIPE_REACHABILITY.items():
            for before_label, before_row in ROW_SHAPES.items():
                for after_label, after_row in ROW_SHAPES.items():
                    if before_row == after_row:
                        continue
                    with self.subTest(f"{before_label} -> {after_label} / {reachability}"):
                        # What the rewritten row is worth on its own.
                        platform_billing_service._access_repair_retry_after.clear()
                        baseline = self.attempt(
                            FakeSupabase([dict(after_row)]), stripe_cls, 0.0
                        )

                        platform_billing_service._access_repair_retry_after.clear()
                        supabase = FakeSupabase([dict(before_row)])
                        self.attempt(supabase, stripe_cls, 0.0)
                        supabase.tables["studio_subscriptions"][0].clear()
                        supabase.tables["studio_subscriptions"][0].update(dict(after_row))

                        self.assertEqual(
                            self.attempt(supabase, stripe_cls, 1.0),
                            baseline,
                            f"{before_label} -> {after_label} ({reachability}) was answered "
                            f"under a verdict recorded for the row it replaced",
                        )

    def test_every_fingerprinted_field_is_load_bearing_somewhere(self):
        """Change exactly one field, from every shape, to every value it takes.

        Whole-shape transitions cannot test this: they move several fields at
        once, so the fields still in the fingerprint cover for the one that is
        missing. And a hand-picked single-field example only tests the fields
        that example happens to be sensitive to — `comped` matters only for a
        row the evaluator would otherwise deny, `trial_end` only for a
        `trialing` row, `stripe_customer_id` only when there is no subscription
        id. So this sweeps every (shape, field, value) combination and asserts
        the replayed answer still equals what the mutated row is worth alone.

        Dropping `status` or `trial_end` from `_row_fingerprint` fails this.
        The other five survive, and that is a fact about the code rather than a
        gap here: the evaluator reads only status, comped and trial_end, so the
        period fields and the Stripe ids can only flip pending-ness — which
        takes the clear-the-window path and already matches an unthrottled
        request — and no repair writes `comped`, so a repaired row and an
        unrepaired one never disagree about it. They are kept in the fingerprint
        defensively; see `_row_fingerprint`.
        """
        fields = (
            "status",
            "comped",
            "trial_end",
            "current_period_start",
            "current_period_end",
            "stripe_subscription_id",
            "stripe_customer_id",
        )
        values = {
            field: {shape.get(field) for shape in ROW_SHAPES.values()}
            for field in fields
        }

        confirmations = {
            "canceled+periods": confirming("canceled", periods=True),
            "canceled": confirming("canceled", periods=False),
            "active": confirming("active", periods=False),
            "trialing past its trial_end": confirming("trialing", periods=False, trial_end=PAST),
        }

        for confirms_label, stripe_cls in confirmations.items():
          for base_label, base_row in ROW_SHAPES.items():
            for field in fields:
                for value in values[field]:
                    if base_row.get(field) == value:
                        continue
                    with self.subTest(f"{base_label} / {field}={value!r} / {confirms_label}"):
                        platform_billing_service._access_repair_retry_after.clear()
                        supabase = FakeSupabase([dict(base_row)])
                        self.attempt(supabase, stripe_cls, 0.0)
                        if "studio_1" not in platform_billing_service._access_repair_retry_after:
                            continue  # no window was recorded; nothing to replay

                        # The window fingerprints the row as it stands *after*
                        # the repair, so the single field has to be changed
                        # relative to that row. Mutating the pre-repair row
                        # instead moves several fields at once and every
                        # fingerprint field covers for every other one.
                        recorded = dict(supabase.tables["studio_subscriptions"][0])
                        if recorded.get(field) == value:
                            continue
                        mutated = {**recorded, field: value}

                        supabase.tables["studio_subscriptions"][0].clear()
                        supabase.tables["studio_subscriptions"][0].update(dict(mutated))
                        replayed = self.attempt(supabase, stripe_cls, 1.0)

                        platform_billing_service._access_repair_retry_after.clear()
                        baseline = self.attempt(
                            FakeSupabase([dict(mutated)]), stripe_cls, 0.0
                        )

                        self.assertEqual(
                            replayed,
                            baseline,
                            f"changing {field} alone on {base_label} did not void the "
                            f"window, so the row was answered under a verdict "
                            f"recorded for the row it replaced",
                        )

    def test_the_throttle_still_bounds_provider_calls_for_every_shape(self):
        """Neutrality must not have been bought by disabling the throttle."""
        for label, subscription_row in ROW_SHAPES.items():
            with self.subTest(label):
                platform_billing_service._access_repair_retry_after.clear()
                UnreachableStripeService.calls = 0
                supabase = FakeSupabase([dict(subscription_row)])

                for tick in (0.0, 1.0, 2.0, 3.0, 4.0):
                    self.attempt(supabase, UnreachableStripeService, tick)

                self.assertLessEqual(
                    UnreachableStripeService.calls,
                    1,
                    f"{label} kept calling Stripe inside the backoff window",
                )


if __name__ == "__main__":
    unittest.main()
