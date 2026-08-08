from __future__ import annotations

import asyncio
from unittest.mock import patch

from fastapi import HTTPException

from tests.platform_billing_helpers import PlatformBillingServiceTestCase


class PlatformBillingPortalTest(PlatformBillingServiceTestCase):
    def test_create_portal_returns_session_for_valid_customer(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "comped": False,
        }]
        service = self.service(rows)
        keys = []

        class FakeStripeService:
            def create_customer_portal_session(self, *, customer_id, return_url, studio_id=None, idempotency_key=None):
                keys.append(idempotency_key)
                return {"url": f"https://billing.stripe.test/session?customer={customer_id}&return={return_url}"}

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.create_portal_link("studio_1", "user_1", "https://koaryu.test/billing"))

        self.assertIn("https://billing.stripe.test/session", response.url)
        self.assertEqual(keys, ["koaryu:core-portal:studio_1:cus_123"])

    def test_create_portal_repairs_stale_customer_and_blocks_for_checkout(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_deleted",
            "stripe_subscription_id": "sub_deleted",
            "status": "trialing",
            "comped": False,
            "metadata": {"core_checkout_session": {"url": "old", "expires_at": 9999999999}},
        }]
        service = self.service(rows)

        class NoSuchCustomerError(Exception):
            __module__ = "stripe.error"

        class FakeStripeService:
            def create_customer_portal_session(self, *, customer_id, return_url, studio_id=None, idempotency_key=None):
                raise NoSuchCustomerError("No such customer: cus_deleted")

            def create_customer(self, *, name, metadata, studio_id=None, idempotency_key=None):
                return {"id": "cus_new"}

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_portal_link("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_new")
        self.assertIsNone(rows[0]["stripe_subscription_id"])
        self.assertNotIn("core_checkout_session", rows[0]["metadata"])

    def test_stale_portal_customer_repair_does_not_end_an_operator_comp(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_deleted",
            "stripe_subscription_id": "sub_deleted",
            "status": "canceled",
            "comped": True,
            "metadata": {
                "comp": {
                    "state": "granted",
                    "at": "2026-07-27T00:00:00+00:00",
                },
            },
        }]
        service = self.service(rows)

        class NoSuchCustomerError(Exception):
            __module__ = "stripe.error"

        class FakeStripeService:
            def create_customer_portal_session(self, **_payload):
                raise NoSuchCustomerError("No such customer: cus_deleted")

            def create_customer(self, **_payload):
                return {"id": "cus_new"}

        with patch(
            "app.services.platform_billing_service.StripeService",
            FakeStripeService,
        ):
            with self.assertRaises(HTTPException):
                asyncio.run(
                    service.create_portal_link("studio_1", "user_1")
                )

        self.assertEqual(rows[0]["stripe_customer_id"], "cus_new")
        self.assertTrue(rows[0]["comped"])
