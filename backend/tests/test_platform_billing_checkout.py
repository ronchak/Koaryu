from __future__ import annotations

import asyncio
from unittest.mock import patch

from fastapi import HTTPException

from tests.platform_billing_helpers import PlatformBillingServiceTestCase


class PlatformBillingCheckoutTest(PlatformBillingServiceTestCase):
    def test_create_checkout_uses_idempotent_customer_and_session_keys(self):
        rows = [{"studio_id": "studio_1", "status": "incomplete", "comped": False}]
        service = self.service(rows)
        calls = []

        class FakeStripeService:
            def create_customer(self, *, name, metadata, idempotency_key=None):
                calls.append(("customer", name, metadata, idempotency_key))
                return {"id": "cus_123"}

            def list_customer_subscriptions(self, customer_id):
                calls.append(("subscriptions", customer_id))
                return {"data": []}

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
        self.assertEqual(calls[1][0], "checkout")
        self.assertEqual(calls[1][1]["idempotency_key"], "koaryu:core-checkout:studio_1:click-key")
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")

    def test_create_checkout_repairs_missing_live_subscription_before_opening_new_session(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
        }]
        service = self.service(rows)

        class FakeStripeService:
            def list_customer_subscriptions(self, customer_id):
                return {
                    "data": [{
                        "id": "sub_123",
                        "customer": customer_id,
                        "status": "trialing",
                        "metadata": {"studio_id": "studio_1"},
                        "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                    }]
                }

            def create_core_checkout_session(self, **_payload):
                raise AssertionError("should not create checkout when Stripe already has a live Core subscription")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_123")

    def test_create_checkout_reuses_pending_session_for_second_device(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
        }]
        service = self.service(rows)
        calls = []

        class FakeStripeService:
            def list_customer_subscriptions(self, customer_id):
                calls.append(("subscriptions", customer_id))
                return {"data": []}

            def create_core_checkout_session(self, **payload):
                calls.append(("checkout", payload))
                return {
                    "id": "cs_123",
                    "url": "https://checkout.stripe.test/session",
                    "expires_at": 9999999999,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            first = asyncio.run(service.create_checkout_link("studio_1", "user_1", idempotency_key="tab-one"))
            second = asyncio.run(service.create_checkout_link("studio_1", "user_1", idempotency_key="tab-two"))

        self.assertEqual(first.url, "https://checkout.stripe.test/session")
        self.assertEqual(second.url, "https://checkout.stripe.test/session")
        self.assertEqual([call[0] for call in calls].count("checkout"), 1)

    def test_create_checkout_rejects_external_redirect_urls(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_canceled",
            "status": "canceled",
            "comped": False,
        }]
        service = self.service(rows)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_checkout_link(
                "studio_1",
                "user_1",
                success_url="https://evil.test/billing",
            ))

        self.assertEqual(context.exception.status_code, 400)

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
