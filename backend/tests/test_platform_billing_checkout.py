from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

from fastapi import HTTPException

from tests.platform_billing_helpers import PlatformBillingServiceTestCase


class PlatformBillingCheckoutTest(PlatformBillingServiceTestCase):
    def test_completed_checkout_blocks_new_session_until_subscription_projection(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {
                "core_trial_consumed": True,
                "core_checkout_session": {
                    "state": "completed",
                    "token": "00000000-0000-4000-8000-000000000001",
                    "epoch": 1,
                    "id": "cs_accepted",
                    "accepted_subscription_id": "sub_accepted",
                },
            },
        }]
        service = self.service(rows)

        class ProviderMustNotCreateCheckout:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": []}

            def create_core_checkout_session(self, **_payload):
                raise AssertionError("accepted checkout must block a second provider session")

        with patch(
            "app.services.platform_billing_service.StripeService",
            ProviderMustNotCreateCheckout,
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("already active", context.exception.detail)
        self.assertEqual(
            rows[0]["metadata"]["core_checkout_session"]["accepted_subscription_id"],
            "sub_accepted",
        )

    def test_terminal_accepted_subscription_can_start_new_epoch_without_new_trial(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_old",
            "status": "canceled",
            "comped": False,
            "metadata": {
                "core_trial_consumed": True,
                "core_checkout_epoch": 1,
                "core_checkout_session": {
                    "state": "completed",
                    "token": "00000000-0000-4000-8000-000000000001",
                    "epoch": 1,
                    "id": "cs_old",
                    "accepted_subscription_id": "sub_old",
                },
            },
        }]
        service = self.service(rows)
        checkout_payloads = []

        class FakeStripeService:
            def create_core_checkout_session(self, **payload):
                checkout_payloads.append(payload)
                return {
                    "id": "cs_new",
                    "url": "https://checkout.stripe.test/new",
                    "expires_at": 9999999999,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(response.url, "https://checkout.stripe.test/new")
        self.assertIsNone(checkout_payloads[0]["trial_period_days"])
        self.assertEqual(
            rows[0]["metadata"]["core_checkout_acceptances"]["sub_old"]
            ["accepted_subscription_id"],
            "sub_old",
        )
        self.assertEqual(rows[0]["metadata"]["core_checkout_session"]["id"], "cs_new")

    def test_trial_decision_uses_locked_subscription_state_not_stale_service_snapshot(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {},
        }]
        service = self.service(rows)
        checkout_payloads = []

        def project_accepted_terminal_subscription():
            rows[0]["stripe_subscription_id"] = "sub_accepted"
            rows[0]["status"] = "canceled"
            rows[0]["metadata"] = {
                "core_trial_consumed": True,
                "core_checkout_epoch": 1,
                "core_checkout_session": {
                    "state": "completed",
                    "token": "00000000-0000-4000-8000-000000000001",
                    "epoch": 1,
                    "id": "cs_accepted",
                    "accepted_subscription_id": "sub_accepted",
                },
            }

        service.supabase.before_reserve_core_checkout = project_accepted_terminal_subscription

        class FakeStripeService:
            def create_core_checkout_session(self, **payload):
                checkout_payloads.append(payload)
                return {
                    "id": "cs_after_projection",
                    "url": "https://checkout.stripe.test/after-projection",
                    "expires_at": 9999999999,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(response.url, "https://checkout.stripe.test/after-projection")
        self.assertIsNone(checkout_payloads[0]["trial_period_days"])
        self.assertEqual(rows[0]["metadata"]["core_checkout_epoch"], 2)

    def test_create_checkout_uses_idempotent_customer_and_session_keys(self):
        rows = [{"studio_id": "studio_1", "status": "incomplete", "comped": False}]
        service = self.service(rows)
        calls = []

        class FakeStripeService:
            def create_customer(self, *, name, metadata, studio_id=None, idempotency_key=None):
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
        self.assertEqual(
            calls[1][1]["idempotency_key"],
            "koaryu:core-checkout:studio_1:1:00000000-0000-4000-8000-000000000001",
        )
        self.assertEqual(calls[1][1]["checkout_epoch"], 1)
        self.assertEqual(calls[1][1]["trial_period_days"], 30)
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")

    def test_create_checkout_does_not_repeat_trial_after_prior_subscription(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_canceled",
            "status": "canceled",
            "comped": False,
            "metadata": {"core_trial_consumed": True},
        }]
        service = self.service(rows)
        checkout_payloads = []

        class FakeStripeService:
            def create_core_checkout_session(self, **payload):
                checkout_payloads.append(payload)
                return {
                    "id": "cs_returning",
                    "url": "https://checkout.stripe.test/returning",
                    "expires_at": 9999999999,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(response.url, "https://checkout.stripe.test/returning")
        self.assertIsNone(checkout_payloads[0]["trial_period_days"])

    def test_missing_customer_retry_redecides_trial_under_second_reservation_lock(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_deleted",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {},
        }]
        service = self.service(rows)
        checkout_payloads = []

        class NoSuchCustomerError(Exception):
            __module__ = "stripe.error"
            code = "resource_missing"
            param = "customer"

        def consume_trial_before_second_reservation():
            rows[0]["stripe_subscription_id"] = "sub_prior"
            rows[0]["status"] = "canceled"
            rows[0]["metadata"]["core_trial_consumed"] = True

        class FakeStripeService:
            def create_customer(self, **_payload):
                return {"id": "cus_repaired"}

            def create_core_checkout_session(self, **payload):
                checkout_payloads.append(payload)
                if len(checkout_payloads) == 1:
                    service.supabase.before_reserve_core_checkout = consume_trial_before_second_reservation
                    raise NoSuchCustomerError("No such customer: cus_deleted")
                return {
                    "id": "cs_repaired",
                    "url": "https://checkout.stripe.test/repaired",
                    "expires_at": 9999999999,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(response.url, "https://checkout.stripe.test/repaired")
        self.assertEqual(checkout_payloads[0]["trial_period_days"], 30)
        self.assertIsNone(checkout_payloads[1]["trial_period_days"])
        self.assertEqual(checkout_payloads[1]["checkout_epoch"], 2)

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

    def test_concurrent_distinct_request_keys_create_exactly_one_provider_session(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
        }]
        service = self.service(rows)
        provider_entered = Event()
        release_provider = Event()
        checkout_calls = []

        class FakeStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": []}

            def create_core_checkout_session(self, **payload):
                checkout_calls.append(payload)
                provider_entered.set()
                release_provider.wait(timeout=2)
                return {
                    "id": "cs_single",
                    "url": "https://checkout.stripe.test/single",
                    "expires_at": 9999999999,
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(
                    lambda: asyncio.run(service.create_checkout_link(
                        "studio_1", "user_1", idempotency_key="tab-one",
                    ))
                )
                self.assertTrue(provider_entered.wait(timeout=2))
                second = executor.submit(
                    lambda: asyncio.run(service.create_checkout_link(
                        "studio_1", "user_1", idempotency_key="tab-two",
                    ))
                )
                with self.assertRaises(HTTPException) as context:
                    second.result(timeout=2)
                self.assertEqual(context.exception.status_code, 409)
                release_provider.set()
                self.assertEqual(
                    first.result(timeout=2).url,
                    "https://checkout.stripe.test/single",
                )

        self.assertEqual(len(checkout_calls), 1)

    def test_comp_granted_before_publication_expires_the_new_session(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
        }]
        service = self.service(rows)
        expired = []

        class FakeStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": []}

            def create_core_checkout_session(self, **_payload):
                rows[0]["comped"] = True
                rows[0]["metadata"] = {"core_checkout_epoch": 2}
                return {
                    "id": "cs_invalidated",
                    "url": "https://checkout.stripe.test/invalidated",
                    "expires_at": 9999999999,
                }

            def expire_core_checkout_session(self, **payload):
                expired.append(payload["session_id"])

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(expired, ["cs_invalidated"])

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

    def test_starting_checkout_is_blocked_for_an_operator_comp(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": None,
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": True,
            "metadata": {
                "comp": {
                    "state": "granted",
                    "at": "2026-07-27T00:00:00+00:00",
                },
            },
        }]
        service = self.service(rows)

        class ProviderMustNotBeCalled:
            def __init__(self):
                raise AssertionError("comped checkout must stop before provider initialization")

        with patch(
            "app.services.platform_billing_service.StripeService",
            ProviderMustNotBeCalled,
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_checkout_link("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("comped", context.exception.detail)
        self.assertIsNone(rows[0]["stripe_customer_id"])
        self.assertTrue(rows[0]["comped"])

    def test_comped_local_live_status_can_still_block_checkout(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_123",
            "status": "active",
            "comped": True,
            "current_period_start": None,
            "current_period_end": None,
        }]
        service = self.service(rows)

        class ProviderMustNotBeConsulted:
            def retrieve_subscription(self, subscription_id):
                raise AssertionError(
                    "checkout must not reconcile a comped provider snapshot"
                )

        with patch(
            "app.services.platform_billing_service.StripeService",
            ProviderMustNotBeConsulted,
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(
                    service.create_checkout_link("studio_1", "user_1")
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("comped", context.exception.detail)
        self.assertTrue(rows[0]["comped"])
