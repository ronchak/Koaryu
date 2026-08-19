from __future__ import annotations

import asyncio
import threading
import unittest
from unittest.mock import patch

from app.core.deps import get_current_studio_id
from app.services.platform_billing_service import (
    AccessRepairDeferred,
    PlatformBillingService,
)
from app.services.student_list_query import StudentListQuery
from app.services.student_service import StudentService
from tests.platform_billing_helpers import FakeSettings, FakeSupabase


class AsyncRequestIOConcurrencyTest(unittest.IsolatedAsyncioTestCase):
    async def test_studio_scope_supabase_io_does_not_block_event_loop(self):
        release = threading.Event()
        provider_timed_out = []

        def resolve_role(*_args, **_kwargs):
            provider_timed_out.append(not release.wait(timeout=0.5))
            return {"studio_id": "studio_1", "role": "admin"}

        loop = asyncio.get_running_loop()
        loop.call_later(0.02, release.set)

        with patch(
            "app.core.deps.resolve_staff_role_for_user",
            new=resolve_role,
        ):
            studio_id = await get_current_studio_id(
                "user_1",
                "studio_1",
                object(),
            )

        self.assertEqual(studio_id, "studio_1")
        self.assertEqual(
            provider_timed_out,
            [False],
            "the event loop could not release the controlled studio-scope query",
        )

    async def test_student_list_supabase_io_does_not_block_event_loop(self):
        release = threading.Event()
        provider_timed_out = []

        def fetch_page(_query, *_args, **_kwargs):
            provider_timed_out.append(not release.wait(timeout=0.5))
            return [], 0

        loop = asyncio.get_running_loop()
        loop.call_later(0.02, release.set)

        with patch.object(StudentListQuery, "fetch_page", new=fetch_page):
            response = await StudentService(object()).list_students("studio_1")

        self.assertEqual(response.total, 0)
        self.assertEqual(
            provider_timed_out,
            [False],
            "the event loop could not release the controlled Supabase call",
        )

    async def test_platform_billing_stripe_io_does_not_block_event_loop(self):
        release = threading.Event()
        provider_timed_out = []

        class BlockingStripeService:
            def create_customer_portal_session(self, **_payload):
                provider_timed_out.append(not release.wait(timeout=0.5))
                return {"url": "https://billing.stripe.test/portal"}

        with patch(
            "app.services.platform_billing_service.get_settings",
            return_value=FakeSettings(),
        ):
            service = PlatformBillingService(
                FakeSupabase(
                    [
                        {
                            "studio_id": "studio_1",
                            "stripe_customer_id": "cus_123",
                            "status": "incomplete",
                            "comped": False,
                        }
                    ]
                )
            )

        loop = asyncio.get_running_loop()
        loop.call_later(0.02, release.set)

        with patch(
            "app.services.platform_billing_service.StripeService",
            BlockingStripeService,
        ):
            response = await service.create_portal_link("studio_1", "user_1")

        self.assertEqual(response.url, "https://billing.stripe.test/portal")
        self.assertEqual(
            provider_timed_out,
            [False],
            "the event loop could not release the controlled Stripe call",
        )

    async def test_threadpool_boundary_preserves_provider_failures(self):
        provider_error = RuntimeError("controlled Supabase failure")

        with patch.object(
            StudentListQuery,
            "fetch_page",
            side_effect=provider_error,
        ):
            with self.assertRaises(RuntimeError) as context:
                await StudentService(object()).list_students("studio_1")

        self.assertIs(context.exception, provider_error)

    async def test_cancellation_does_not_pretend_to_stop_inflight_sync_io(self):
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()

        def fetch_page(_query, *_args, **_kwargs):
            started.set()
            release.wait(timeout=1)
            finished.set()
            return [], 0

        with patch.object(StudentListQuery, "fetch_page", new=fetch_page):
            task = asyncio.create_task(
                StudentService(object()).list_students("studio_1")
            )
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.005)

            self.assertTrue(started.is_set())
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

            self.assertFalse(finished.is_set())
            release.set()
            worker_finished = await asyncio.to_thread(finished.wait, 1)

        self.assertTrue(worker_finished)

    async def test_strict_access_repairs_remain_single_flight_per_studio(self):
        started = threading.Event()
        release = threading.Event()
        provider_calls = []

        class BlockingRepairStripeService:
            def retrieve_subscription(self, subscription_id):
                provider_calls.append(subscription_id)
                started.set()
                release.wait(timeout=1)
                return {
                    "id": subscription_id,
                    "customer": "cus_123",
                    "status": "canceled",
                    "items": {
                        "data": [
                            {
                                "current_period_start": 100,
                                "current_period_end": 200,
                            }
                        ]
                    },
                    "cancel_at_period_end": False,
                }

        with patch(
            "app.services.platform_billing_service.get_settings",
            return_value=FakeSettings(),
        ):
            service = PlatformBillingService(
                FakeSupabase(
                    [
                        {
                            "studio_id": "studio_1",
                            "stripe_customer_id": "cus_123",
                            "stripe_subscription_id": "sub_123",
                            "status": "canceled",
                            "comped": False,
                        }
                    ]
                )
            )

        with patch(
            "app.services.platform_billing_service.StripeService",
            BlockingRepairStripeService,
        ):
            first = asyncio.create_task(
                asyncio.to_thread(
                    service.get_access_status_row,
                    "studio_1",
                    strict_repairs=True,
                )
            )
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.005)
            self.assertTrue(started.is_set())

            second = asyncio.create_task(
                asyncio.to_thread(
                    service.get_access_status_row,
                    "studio_1",
                    strict_repairs=True,
                )
            )
            with self.assertRaises(AccessRepairDeferred):
                await asyncio.wait_for(second, timeout=0.2)

            self.assertFalse(first.done())
            self.assertEqual(provider_calls, ["sub_123"])
            release.set()
            first_row = await first
            replayed_row = await asyncio.to_thread(
                service.get_access_status_row,
                "studio_1",
                strict_repairs=True,
            )

        self.assertEqual(first_row["status"], "canceled")
        self.assertEqual(replayed_row["status"], "canceled")
        self.assertEqual(provider_calls, ["sub_123"])

    async def test_concurrent_checkouts_reuse_one_stripe_session(self):
        checkout_started = threading.Event()
        release_checkout = threading.Event()
        checkout_calls = []

        class BlockingCheckoutStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": []}

            def create_core_checkout_session(self, **payload):
                checkout_calls.append(payload)
                checkout_started.set()
                release_checkout.wait(timeout=1)
                return {
                    "id": "cs_123",
                    "url": "https://checkout.stripe.test/session",
                    "expires_at": 9999999999,
                }

        with patch(
            "app.services.platform_billing_service.get_settings",
            return_value=FakeSettings(),
        ):
            service = PlatformBillingService(
                FakeSupabase(
                    [
                        {
                            "studio_id": "studio_1",
                            "stripe_customer_id": "cus_123",
                            "stripe_subscription_id": None,
                            "status": "incomplete",
                            "comped": False,
                        }
                    ]
                )
            )

        with patch(
            "app.services.platform_billing_service.StripeService",
            BlockingCheckoutStripeService,
        ):
            first = asyncio.create_task(
                service.create_checkout_link(
                    "studio_1",
                    "user_1",
                    idempotency_key="tab-one",
                )
            )
            for _ in range(100):
                if checkout_started.is_set():
                    break
                await asyncio.sleep(0.005)
            self.assertTrue(checkout_started.is_set())

            second = asyncio.create_task(
                service.create_checkout_link(
                    "studio_1",
                    "user_1",
                    idempotency_key="tab-two",
                )
            )
            await asyncio.sleep(0.02)
            self.assertEqual(len(checkout_calls), 1)

            release_checkout.set()
            responses = await asyncio.gather(first, second)

        self.assertEqual(
            [response.url for response in responses],
            [
                "https://checkout.stripe.test/session",
                "https://checkout.stripe.test/session",
            ],
        )
        self.assertEqual(len(checkout_calls), 1)

    async def test_checkout_cancellation_keeps_serialization_until_worker_finishes(self):
        checkout_started = threading.Event()
        release_checkout = threading.Event()
        checkout_calls = []

        class BlockingCheckoutStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": []}

            def create_core_checkout_session(self, **payload):
                checkout_calls.append(payload)
                checkout_started.set()
                release_checkout.wait(timeout=1)
                return {
                    "id": "cs_123",
                    "url": "https://checkout.stripe.test/session",
                    "expires_at": 9999999999,
                }

        with patch(
            "app.services.platform_billing_service.get_settings",
            return_value=FakeSettings(),
        ):
            service = PlatformBillingService(
                FakeSupabase(
                    [
                        {
                            "studio_id": "studio_1",
                            "stripe_customer_id": "cus_123",
                            "stripe_subscription_id": None,
                            "status": "incomplete",
                            "comped": False,
                        }
                    ]
                )
            )

        with patch(
            "app.services.platform_billing_service.StripeService",
            BlockingCheckoutStripeService,
        ):
            cancelled_leader = asyncio.create_task(
                service.create_checkout_link(
                    "studio_1",
                    "user_1",
                    idempotency_key="tab-one",
                )
            )
            for _ in range(100):
                if checkout_started.is_set():
                    break
                await asyncio.sleep(0.005)
            self.assertTrue(checkout_started.is_set())

            cancelled_leader.cancel()
            follower = asyncio.create_task(
                service.create_checkout_link(
                    "studio_1",
                    "user_1",
                    idempotency_key="tab-two",
                )
            )
            await asyncio.sleep(0.02)
            cancelled_leader.cancel()
            await asyncio.sleep(0.01)

            self.assertFalse(cancelled_leader.done())
            self.assertFalse(follower.done())
            self.assertEqual(len(checkout_calls), 1)

            release_checkout.set()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled_leader
            follower_response = await follower

        self.assertEqual(
            follower_response.url,
            "https://checkout.stripe.test/session",
        )
        self.assertEqual(len(checkout_calls), 1)


if __name__ == "__main__":
    unittest.main()
