from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import patch

from tests.platform_billing_helpers import PlatformBillingServiceTestCase


class PlatformBillingStatusRepairTest(PlatformBillingServiceTestCase):
    def test_email_usage_uses_aggregation_rpc(self):
        service = self.service([{"studio_id": "studio_1", "status": "active", "comped": False}])
        now = datetime.now(timezone.utc)
        service.supabase.tables["email_usage_events"] = [
            {"studio_id": "studio_1", "quantity": 2, "sent_at": now.replace(day=1).isoformat()},
            {"studio_id": "studio_1", "quantity": 3, "sent_at": now.isoformat()},
            {"studio_id": "studio_2", "quantity": 99, "sent_at": now.isoformat()},
        ]

        usage = service._email_usage("studio_1")

        self.assertEqual(usage.sent, 5)
        self.assertEqual(
            [name for name, _params in service.supabase.rpc_calls],
            ["sum_email_usage_for_period"],
        )

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

    def test_get_access_status_repairs_stale_incomplete_subscription_status(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "incomplete",
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
            row = service.get_access_status_row("studio_1")

        self.assertEqual(FakeStripeService.calls, 1)
        self.assertEqual(row["status"], "active")
        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["current_period_end"], "1970-01-01T00:03:20+00:00")

    def test_get_access_status_repairs_expired_trialing_state(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "comped": False,
            "trial_end": "1970-01-01T00:05:00+00:00",
            "current_period_start": "1970-01-01T00:01:40+00:00",
            "current_period_end": "2999-01-01T00:03:20+00:00",
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
            row = service.get_access_status_row("studio_1")

        self.assertEqual(FakeStripeService.calls, 1)
        self.assertEqual(row["status"], "active")
        self.assertEqual(rows[0]["status"], "active")

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
