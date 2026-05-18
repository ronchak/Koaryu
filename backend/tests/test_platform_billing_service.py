from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.services.platform_billing_service import PlatformBillingService


class Result:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    def __init__(self, rows: list[dict]):
        self.tables = {
            "studio_subscriptions": rows,
            "email_usage_events": [],
            "studios": [{"id": "studio_1", "name": "Koaryu Test Studio"}],
            "audit_logs": [],
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
        service.settings = type("Settings", (), {
            "FRONTEND_URL": "https://koaryu.test",
            "STRIPE_KOARYU_CORE_PRICE_ID": "price_core",
        })()
        return service

    def test_create_checkout_uses_idempotent_customer_and_session_keys(self):
        rows = [{"studio_id": "studio_1", "status": "incomplete", "comped": False}]
        service = self.service(rows)
        calls = []

        class FakeStripeService:
            def create_customer(self, *, name, metadata, idempotency_key=None):
                calls.append(("customer", name, metadata, idempotency_key))
                return {"id": "cus_123"}

            def create_core_checkout_session(self, **payload):
                calls.append(("checkout", payload))
                return {"url": "https://checkout.stripe.test/session"}

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.create_checkout_link(
                "studio_1",
                "user_1",
                "https://koaryu.test/billing?success",
                "https://koaryu.test/billing?cancel",
                "click-key",
            ))

        self.assertEqual(response.url, "https://checkout.stripe.test/session")
        self.assertEqual(calls[0][3], "koaryu:core-customer:studio_1")
        self.assertEqual(calls[1][1]["idempotency_key"], "koaryu:core-checkout:studio_1:click-key")
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")

    def test_create_checkout_blocks_when_core_subscription_is_live(self):
        service = self.service([{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_123",
            "status": "active",
            "comped": False,
        }])

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("already active", context.exception.detail)

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

    def test_stale_subscription_webhook_does_not_regress_core_status(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_stripe_event_created": 200,
        }]
        service = self.service(rows)

        service.project_subscription_event({
            "id": "evt_old",
            "created": 100,
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "canceled",
                },
            },
        })

        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["last_stripe_event_created"], 200)

    def test_newer_subscription_webhook_records_event_created(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "last_stripe_event_created": 100,
        }]
        service = self.service(rows)

        service.project_subscription_event({
            "id": "evt_new",
            "created": 200,
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "active",
                },
            },
        })

        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["last_stripe_event_created"], 200)

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

    def test_get_status_repairs_missing_subscription_from_customer(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
        }]
        service = self.service(rows)

        class FakeStripeService:
            calls = 0

            def list_customer_subscriptions(self, customer_id):
                FakeStripeService.calls += 1
                assert customer_id == "cus_123"
                return {
                    "data": [{
                        "id": "sub_123",
                        "customer": "cus_123",
                        "status": "trialing",
                        "metadata": {"studio_id": "studio_1", "product": "koaryu_core"},
                        "trial_start": 50,
                        "trial_end": 300,
                        "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                        "cancel_at_period_end": False,
                    }]
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(FakeStripeService.calls, 1)
        self.assertEqual(response.status, "trialing")
        self.assertEqual(response.stripe_subscription_id, "sub_123")
        self.assertEqual(response.trial_end, "1970-01-01T00:05:00+00:00")

    def test_get_status_does_not_repair_comped_customer(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "comped",
            "comped": True,
        }]
        service = self.service(rows)

        class FakeStripeService:
            calls = 0

            def list_customer_subscriptions(self, customer_id):
                FakeStripeService.calls += 1
                return {"data": []}

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(FakeStripeService.calls, 0)
        self.assertEqual(response.status, "comped")


if __name__ == "__main__":
    unittest.main()
