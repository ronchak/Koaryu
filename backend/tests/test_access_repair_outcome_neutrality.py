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
from copy import deepcopy
from itertools import product
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


def split_brain():
    """A Stripe whose two endpoints disagree.

    `_should_repair_missing_subscription` consults `list_customer_subscriptions`,
    while the other two guards consult `retrieve_subscription`. So the Stripe
    identifiers do not merely decide *whether* a repair is pending — they decide
    *which endpoint* the pending repair will ask, and the two can return
    different statuses for the same studio. A stub whose `list` always returns
    `[]` can never show that, which is why the sweep below could not see that
    the ids are load-bearing.
    """

    class SplitBrainStripeService:
        calls = 0

        def retrieve_subscription(self, subscription_id):
            type(self).calls += 1
            status_value = "canceled" if subscription_id == "sub_from_list" else "active"
            return {
                "id": subscription_id or "sub_123",
                "customer": "cus_123",
                "status": status_value,
                "items": {"data": [{}]},
                "cancel_at_period_end": False,
            }

        def list_customer_subscriptions(self, customer_id):
            type(self).calls += 1
            if customer_id != "cus_123":
                return []
            return [{
                "id": "sub_from_list",
                "customer": customer_id,
                "status": "canceled",
                # select_core_subscription only considers subscriptions whose
                # metadata names this studio, so without it nothing is ever
                # selected and the two endpoints cannot be seen to disagree.
                "metadata": {"studio_id": "studio_1"},
                "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                "cancel_at_period_end": False,
            }]

    return SplitBrainStripeService


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
    # A second customer id, so the sweep can swap between customers rather than
    # only nulling one. Nulling a customer id only ever switches the
    # missing-subscription guard off, which cannot change an outcome; pointing
    # it at a *different* customer changes what that guard finds.
    "active with another customer id and no subscription id": row(
        stripe_subscription_id=None, stripe_customer_id="cus_unknown"
    ),
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

PERIOD_SHAPES = {
    "valid periods": (100, 200),
    "missing periods": (None, None),
    "inverted periods": (300, 200),
    "unparseable periods": ("not-a-period", "still-not-a-period"),
}
TRIAL_END_SHAPES = {
    "future trial end": FUTURE,
    "missing trial end": None,
    "expired trial end": PAST,
    "unparseable trial end": "not-a-date",
}
DIMENSION_STATUSES = (
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "paused",
    "canceled",
    "incomplete",
)


def reconciliation_dimension_rows(*, comped: bool):
    for (
        has_subscription_id,
        status_value,
        (period_label, periods),
        (trial_label, trial_end),
    ) in product(
        (False, True),
        DIMENSION_STATUSES,
        PERIOD_SHAPES.items(),
        TRIAL_END_SHAPES.items(),
    ):
        label = (
            f"comped={comped} / subscription_id={has_subscription_id} / "
            f"status={status_value} / {period_label} / {trial_label}"
        )
        yield label, row(
            comped=comped,
            stripe_subscription_id="sub_123" if has_subscription_id else None,
            status=status_value,
            current_period_start=periods[0],
            current_period_end=periods[1],
            trial_end=trial_end,
        )


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

        Dropping `status`, `trial_end`, `stripe_subscription_id` or
        `stripe_customer_id` from `_row_fingerprint` fails this.

        The Stripe ids need the `endpoints that disagree` stub to show up. They
        do not merely flip pending-ness: they decide *which* provider endpoint
        the pending repair consults — `_should_repair_missing_subscription` asks
        `list_customer_subscriptions`, the other two guards ask
        `retrieve_subscription` — and those can answer differently for the same
        studio. A stub whose `list` always returns `[]` makes them look
        interchangeable.

        Nulling a customer id can never diverge — it only switches the
        missing-subscription guard off — so the shapes include a second customer
        id, letting the sweep swap between customers rather than only clearing
        one.

        The two period fields survive, and that is a fact about the code rather
        than a gap here; see `_row_fingerprint`. `comped` no longer survives:
        all three guards now treat a grant as a reconciliation stop, so changing
        it alone can invalidate the recorded pending state.
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
            "endpoints that disagree": split_brain(),
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

    def _record_cell(self, subscription_row, stripe_cls, *, legacy_projection):
        platform_billing_service._access_repair_retry_after.clear()
        stripe_cls.calls = 0
        supabase = FakeSupabase([deepcopy(subscription_row)])
        original_projection = (
            platform_billing_service.PlatformBillingService._project_subscription
        )

        def project_like_d12f5b8(service, subscription, *, clear_comp=False):
            update = original_projection(
                service,
                subscription,
                clear_comp=clear_comp,
            )
            update["comped"] = False
            return update

        projection = (
            patch.object(
                platform_billing_service.PlatformBillingService,
                "_project_subscription",
                project_like_d12f5b8,
            )
            if legacy_projection
            else patch.object(
                platform_billing_service.PlatformBillingService,
                "_project_subscription",
                original_projection,
            )
        )
        with projection:
            outcomes = (
                self.attempt(supabase, stripe_cls, 0.0),
                self.attempt(supabase, stripe_cls, 1.0),
            )

        window = platform_billing_service._access_repair_retry_after.get("studio_1")
        throttle = None if window is None else (
            window.retry_after,
            window.replay_fault,
            window.row_fingerprint,
        )
        return {
            "outcomes": outcomes,
            "persisted_row": deepcopy(
                supabase.tables["studio_subscriptions"][0]
            ),
            "provider_calls": stripe_cls.calls,
            "throttle": throttle,
        }

    def test_non_comped_dimension_cells_are_exactly_neutral_to_d12f5b8(self):
        """The projection payload changed; non-comped behaviour did not.

        The reference run restores the old projector's unconditional
        `comped=False` seed. Every cell then compares outcome class, persisted
        row, provider call count, and the complete recorded throttle state.
        """
        recorded_rows = list(reconciliation_dimension_rows(comped=False))
        recorded_rows.extend(
            (f"curated / {label}", subscription_row)
            for label, subscription_row in ROW_SHAPES.items()
            if subscription_row.get("comped") is False
        )
        for label, subscription_row in recorded_rows:
            for reachability, stripe_cls in STRIPE_REACHABILITY.items():
                with self.subTest(f"{label} / {reachability}"):
                    expected = self._record_cell(
                        subscription_row,
                        stripe_cls,
                        legacy_projection=True,
                    )
                    actual = self._record_cell(
                        subscription_row,
                        stripe_cls,
                        legacy_projection=False,
                    )
                    self.assertEqual(actual, expected)


class CompedRepairPreservationTest(unittest.TestCase):
    def setUp(self):
        platform_billing_service._access_repair_retry_after.clear()
        ReachableStripeService.calls = 0
        UnreachableStripeService.calls = 0

    def tearDown(self):
        platform_billing_service._access_repair_retry_after.clear()

    @staticmethod
    def service(subscription_row):
        with patch(
            "app.services.platform_billing_service.get_settings",
            return_value=ProductionSettings(),
        ):
            return platform_billing_service.PlatformBillingService(
                FakeSupabase([subscription_row])
            )

    def attempt(self, subscription_row, stripe_cls, *, legacy_period_repair=False):
        supabase = FakeSupabase([deepcopy(subscription_row)])

        def guard_without_comp(service, candidate):
            candidate = {**candidate, "comped": False}
            return original_guard(service, candidate)

        def legacy_projection(service, subscription, *, clear_comp=False):
            update = original_projection(
                service,
                subscription,
                clear_comp=clear_comp,
            )
            update["comped"] = False
            return update

        original_guard = (
            platform_billing_service.PlatformBillingService
            ._should_repair_subscription_periods
        )
        original_projection = (
            platform_billing_service.PlatformBillingService._project_subscription
        )
        guard_patch = patch.object(
            platform_billing_service.PlatformBillingService,
            "_should_repair_subscription_periods",
            guard_without_comp if legacy_period_repair else original_guard,
        )
        projection_patch = patch.object(
            platform_billing_service.PlatformBillingService,
            "_project_subscription",
            legacy_projection if legacy_period_repair else original_projection,
        )
        with (
            guard_patch,
            projection_patch,
            patch("app.services.platform_billing_service.StripeService", stripe_cls),
            patch(
                "app.services.platform_billing_service.get_settings",
                return_value=ProductionSettings(),
            ),
            patch("app.services.studio_scope.get_settings", return_value=ProductionSettings()),
        ):
            try:
                access = studio_scope.get_platform_subscription_access(
                    supabase,
                    "studio_1",
                )
            except HTTPException as exc:
                return str(exc.status_code), supabase
            outcome = "allowed" if not access["subscription_required"] else "402"
            return outcome, supabase

    def test_period_guard_skips_every_comped_period_shape_without_a_provider_call(self):
        service = self.service(row(comped=True))
        cases = {
            "no subscription id": (
                row(comped=True, stripe_subscription_id=None),
                False,
            ),
            "active valid": (row(comped=True), False),
            "active missing": (
                row(
                    comped=True,
                    current_period_start=None,
                    current_period_end=None,
                ),
                False,
            ),
            "active inverted": (
                row(
                    comped=True,
                    current_period_start=300,
                    current_period_end=200,
                ),
                False,
            ),
            "active unparseable": (
                row(
                    comped=True,
                    current_period_start="bad-start",
                    current_period_end="bad-end",
                ),
                False,
            ),
            "trialing missing trial end": (
                row(comped=True, status="trialing", trial_end=None),
                False,
            ),
            "canceled": (row(comped=True, status="canceled"), False),
        }

        with patch(
            "app.services.platform_billing_service.StripeService",
            UnreachableStripeService,
        ):
            for label, (candidate, expected) in cases.items():
                with self.subTest(label):
                    self.assertEqual(
                        service._should_repair_subscription_periods(candidate),
                        expected,
                    )
                    self.assertIs(
                        service._repair_subscription_periods(candidate),
                        candidate,
                    )

        self.assertEqual(UnreachableStripeService.calls, 0)

    def test_every_reconciliation_repair_omits_comped_during_a_concurrent_grant(self):
        cases = (
            (
                "missing subscription",
                row(
                    stripe_subscription_id=None,
                    status="incomplete",
                ),
                "_repair_missing_subscription",
                "list_customer_subscriptions",
            ),
            (
                "stale subscription state",
                row(status="canceled"),
                "_repair_stale_subscription_state",
                "retrieve_subscription",
            ),
            (
                "subscription periods",
                row(current_period_start=None, current_period_end=None),
                "_repair_subscription_periods",
                "retrieve_subscription",
            ),
        )

        for (
            label,
            subscription_row,
            repair_name,
            provider_method,
        ), strict_repairs in product(cases, (False, True)):
            with self.subTest(f"{label} / strict={strict_repairs}"):
                subscription_row = deepcopy(subscription_row)
                service = self.service(subscription_row)

                def grant_comp():
                    persisted = service.supabase.tables["studio_subscriptions"][0]
                    persisted["comped"] = True
                    persisted["metadata"] = {
                        "comp": {
                            "state": "granted",
                            "at": "2026-07-27T00:00:00+00:00",
                        },
                    }

                class GrantsDuringProviderCall:
                    def retrieve_subscription(self, subscription_id):
                        grant_comp()
                        return {
                            "id": subscription_id or "sub_123",
                            "customer": "cus_123",
                            "status": "active",
                            "metadata": {"studio_id": "studio_1"},
                            "items": {
                                "data": [{
                                    "current_period_start": 100,
                                    "current_period_end": 200,
                                }]
                            },
                        }

                    def list_customer_subscriptions(self, customer_id):
                        grant_comp()
                        return {
                            "data": [{
                                "id": "sub_123",
                                "customer": customer_id,
                                "status": "active",
                                "metadata": {"studio_id": "studio_1"},
                                "items": {
                                    "data": [{
                                        "current_period_start": 100,
                                        "current_period_end": 200,
                                    }]
                                },
                            }]
                        }

                self.assertTrue(
                    hasattr(GrantsDuringProviderCall, provider_method)
                )
                with patch(
                    "app.services.platform_billing_service.StripeService",
                    GrantsDuringProviderCall,
                ):
                    repaired = getattr(service, repair_name)(
                        subscription_row,
                        strict_repairs=strict_repairs,
                    )

                updates = [
                    entry["update"]
                    for entry in service.supabase.query_log
                    if entry["table"] == "studio_subscriptions"
                    and entry["update"] is not None
                ]
                self.assertEqual(len(updates), 1)
                self.assertNotIn("comped", updates[0])
                self.assertTrue(repaired["comped"])
                self.assertTrue(
                    service.supabase.tables["studio_subscriptions"][0]["comped"]
                )

    def test_repair_does_not_restore_a_comp_cleared_while_stripe_is_in_flight(self):
        subscription_row = row(
            comped=True,
            current_period_start=None,
            current_period_end=None,
        )
        service = self.service(subscription_row)

        class WebhookClearsDuringProviderCall:
            def retrieve_subscription(self, subscription_id):
                persisted = service.supabase.tables["studio_subscriptions"][0]
                persisted["comped"] = False
                persisted["metadata"] = {
                    "comp": {
                        "state": "granted",
                        "at": "2026-07-27T00:00:00+00:00",
                    },
                }
                return {
                    "id": subscription_id,
                    "customer": "cus_123",
                    "status": "active",
                    "items": {
                        "data": [{
                            "current_period_start": 100,
                            "current_period_end": 200,
                        }]
                    },
                }

        with (
            patch.object(
                service,
                "_should_repair_subscription_periods",
                return_value=True,
            ),
            patch(
                "app.services.platform_billing_service.StripeService",
                WebhookClearsDuringProviderCall,
            ),
        ):
            repaired = service._repair_subscription_periods(subscription_row)

        update = next(
            entry["update"]
            for entry in service.supabase.query_log
            if entry["table"] == "studio_subscriptions"
            and entry["update"] is not None
        )
        self.assertNotIn("comped", update)
        self.assertFalse(repaired["comped"])
        self.assertFalse(
            service.supabase.tables["studio_subscriptions"][0]["comped"]
        )

    def test_comped_rows_remain_comped_across_the_full_reconciliation_sweep(self):
        for label, subscription_row in reconciliation_dimension_rows(comped=True):
            for strict_repairs in (False, True):
                with self.subTest(f"{label} / strict={strict_repairs}"):
                    ReachableStripeService.calls = 0
                    service = self.service(deepcopy(subscription_row))
                    with patch(
                        "app.services.platform_billing_service.StripeService",
                        ReachableStripeService,
                    ):
                        persisted = service.get_access_status_row(
                            "studio_1",
                            strict_repairs=strict_repairs,
                        )

                    self.assertTrue(persisted["comped"])
                    self.assertTrue(
                        service.supabase.tables["studio_subscriptions"][0]["comped"]
                    )
                    self.assertEqual(ReachableStripeService.calls, 0)

    def test_comped_outcome_changes_are_explicit_and_expired_trial_stays_denied(self):
        broken_active = row(
            comped=True,
            status="active",
            current_period_start=None,
            current_period_end=None,
        )

        current, _ = self.attempt(broken_active, UnreachableStripeService)
        legacy, _ = self.attempt(
            broken_active,
            UnreachableStripeService,
            legacy_period_repair=True,
        )
        self.assertEqual((legacy, current), ("503", "allowed"))

        for provider_status in ("past_due", "unpaid", "paused"):
            with self.subTest(provider_status):
                stripe_cls = confirming(provider_status, periods=True)
                current, current_db = self.attempt(broken_active, stripe_cls)
                legacy, legacy_db = self.attempt(
                    broken_active,
                    stripe_cls,
                    legacy_period_repair=True,
                )
                self.assertEqual((legacy, current), ("402", "allowed"))
                self.assertFalse(
                    legacy_db.tables["studio_subscriptions"][0]["comped"]
                )
                self.assertTrue(
                    current_db.tables["studio_subscriptions"][0]["comped"]
                )

        expired_trial = row(
            comped=True,
            status="trialing",
            trial_end=PAST,
        )
        outcome, expired_db = self.attempt(
            expired_trial,
            ReachableStripeService,
        )
        self.assertEqual(outcome, "402")
        self.assertTrue(expired_db.tables["studio_subscriptions"][0]["comped"])
        self.assertEqual(ReachableStripeService.calls, 0)


if __name__ == "__main__":
    unittest.main()
