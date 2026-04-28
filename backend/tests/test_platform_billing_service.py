from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from app.services.platform_billing_service import PlatformBillingService


class Result:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    def __init__(self, rows: list[dict]):
        self.tables = {
            "studio_subscriptions": rows,
            "email_usage_events": [],
        }

    def table(self, name: str):
        return FakeTable(self, name)


class FakeTable:
    def __init__(self, supabase: FakeSupabase, name: str):
        self.supabase = supabase
        self.name = name
        self.filters = []
        self.update_payload = None
        self.insert_payload = None
        self.single_row = False

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def gte(self, *_args, **_kwargs):
        return self

    def lt(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def maybe_single(self):
        self.single_row = True
        return self

    def single(self):
        self.single_row = True
        return self

    def update(self, payload):
        self.update_payload = payload
        return self

    def insert(self, payload):
        self.insert_payload = payload
        return self

    def execute(self):
        rows = self.supabase.tables[self.name]
        if self.insert_payload is not None:
            row = dict(self.insert_payload)
            rows.append(row)
            return Result([dict(row)])
        matching_rows = [
            row for row in rows
            if all(row.get(key) == value for key, value in self.filters)
        ]
        if self.update_payload is not None:
            for row in matching_rows:
                row.update(self.update_payload)
            return Result([dict(row) for row in matching_rows])
        if self.single_row:
            return Result(dict(matching_rows[0]) if matching_rows else None)
        return Result([dict(row) for row in matching_rows])


class PlatformBillingServiceTest(unittest.TestCase):
    def service(self, rows: list[dict]) -> PlatformBillingService:
        service = object.__new__(PlatformBillingService)
        service.supabase = FakeSupabase(rows)
        return service

    def test_project_subscription_uses_item_period_bounds_and_clears_trial_fields(self):
        service = self.service([])

        projected = service._project_subscription({
            "id": "sub_123",
            "customer": {"id": "cus_123"},
            "status": "active",
            "trial_start": None,
            "trial_end": None,
            "cancel_at_period_end": True,
            "items": {
                "data": [
                    {"current_period_start": 200, "current_period_end": 400},
                    {"current_period_start": 100, "current_period_end": 500},
                ],
            },
        })

        self.assertEqual(projected["stripe_subscription_id"], "sub_123")
        self.assertEqual(projected["stripe_customer_id"], "cus_123")
        self.assertIsNone(projected["trial_start"])
        self.assertIsNone(projected["trial_end"])
        self.assertEqual(projected["current_period_start"], "1970-01-01T00:01:40+00:00")
        self.assertEqual(projected["current_period_end"], "1970-01-01T00:08:20+00:00")
        self.assertTrue(projected["cancel_at_period_end"])

    def test_subscription_webhook_allows_nullable_trial_field_clearing(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "trial_start": "old",
            "trial_end": "old",
        }]
        service = self.service(rows)

        service.project_subscription_event({
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "active",
                    "trial_start": None,
                    "trial_end": None,
                    "current_period_start": 100,
                    "current_period_end": 200,
                    "cancel_at_period_end": False,
                },
            },
        })

        self.assertIsNone(rows[0]["trial_start"])
        self.assertIsNone(rows[0]["trial_end"])
        self.assertEqual(rows[0]["current_period_start"], "1970-01-01T00:01:40+00:00")
        self.assertEqual(rows[0]["current_period_end"], "1970-01-01T00:03:20+00:00")

    def test_checkout_completed_fetches_subscription_projection_when_available(self):
        rows = [{"studio_id": "studio_1", "status": "incomplete", "comped": False}]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                assert subscription_id == "sub_123"
                return {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "active",
                    "trial_start": 50,
                    "trial_end": 100,
                    "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                    "cancel_at_period_end": False,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "customer": "cus_123",
                        "subscription": "sub_123",
                        "payment_status": "paid",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
            })

        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")
        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_123")
        self.assertEqual(rows[0]["current_period_start"], "1970-01-01T00:01:40+00:00")

    def test_get_status_repairs_missing_live_periods_once(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "comped": False,
            "current_period_start": None,
            "current_period_end": None,
        }]
        service = self.service(rows)

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
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(FakeStripeService.calls, 1)
        self.assertEqual(response.current_period_start, "1970-01-01T00:01:40+00:00")
        self.assertEqual(response.current_period_end, "1970-01-01T00:03:20+00:00")

    def test_get_status_repairs_trialing_subscription_missing_trial_end(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "comped": False,
            "trial_end": None,
            "current_period_start": "1970-01-01T00:01:40+00:00",
            "current_period_end": "1970-01-01T00:03:20+00:00",
        }]
        service = self.service(rows)

        class FakeStripeService:
            calls = 0

            def retrieve_subscription(self, subscription_id):
                FakeStripeService.calls += 1
                assert subscription_id == "sub_123"
                return {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "trialing",
                    "trial_start": 50,
                    "trial_end": 300,
                    "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                    "cancel_at_period_end": False,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(FakeStripeService.calls, 1)
        self.assertEqual(response.trial_end, "1970-01-01T00:05:00+00:00")


if __name__ == "__main__":
    unittest.main()
