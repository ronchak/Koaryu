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

    def test_missing_subscription_repair_accepts_exact_tokenized_checkout(self):
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {
                "core_checkout_epoch": 1,
                "core_checkout_session": {
                    "state": "published",
                    "token": token,
                    "epoch": 1,
                    "id": "cs_exact",
                },
            },
        }]
        service = self.service(rows)

        class FakeStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": [{
                    "id": "sub_exact",
                    "customer": "cus_123",
                    "status": "trialing",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }]}

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(response.stripe_subscription_id, "sub_exact")
        self.assertEqual(response.status, "trialing")
        self.assertEqual(
            rows[0]["metadata"]["core_checkout_session"]["state"],
            "completed",
        )

    def test_missing_subscription_repair_rejects_and_cancels_stale_tokenized_checkout(self):
        stale_token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {"core_checkout_epoch": 2},
        }]
        service = self.service(rows)
        canceled = []

        class FakeStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": [{
                    "id": "sub_stale",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": stale_token,
                        "core_checkout_epoch": "1",
                    },
                }]}

            def cancel_core_subscription(self, **payload):
                canceled.append(payload["subscription_id"])

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(canceled, ["sub_stale"])
        self.assertIsNone(response.stripe_subscription_id)
        self.assertEqual(response.status, "incomplete")

    def test_missing_subscription_repair_does_not_project_historical_acceptance(self):
        old_token = "00000000-0000-4000-8000-000000000001"
        new_token = "00000000-0000-4000-8000-000000000002"
        archived = {
            "state": "completed",
            "token": old_token,
            "epoch": 1,
            "id": "cs_old",
            "accepted_subscription_id": "sub_old",
        }
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {
                "core_checkout_epoch": 2,
                "core_checkout_acceptances": {"sub_old": archived},
                "core_checkout_session": {
                    "state": "published",
                    "token": new_token,
                    "epoch": 2,
                    "id": "cs_new",
                },
            },
        }]
        service = self.service(rows)

        class FakeStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": [{
                    "id": "sub_old",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": old_token,
                        "core_checkout_epoch": "1",
                    },
                }]}

            def cancel_core_subscription(self, **_payload):
                raise AssertionError("historical accepted subscriptions are acknowledged only")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertIsNone(response.stripe_subscription_id)
        self.assertEqual(response.status, "incomplete")
        self.assertEqual(rows[0]["metadata"]["core_checkout_session"]["id"], "cs_new")

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

    def test_admin_status_leaves_broken_comped_provider_snapshot_untouched(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_local",
            "stripe_subscription_id": "sub_local",
            "status": "active",
            "comped": True,
            "trial_end": None,
            "current_period_start": None,
            "current_period_end": None,
            "cancel_at_period_end": False,
        }]
        service = self.service(rows)

        class ProviderMustNotBeConsulted:
            def retrieve_subscription(self, subscription_id):
                raise AssertionError(
                    "Admin refresh must not reconcile a comped provider snapshot"
                )

        with patch(
            "app.services.platform_billing_service.StripeService",
            ProviderMustNotBeConsulted,
        ):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertEqual(response.status, "active")
        self.assertEqual(response.stripe_customer_id, "cus_local")
        self.assertEqual(response.stripe_subscription_id, "sub_local")
        self.assertIsNone(response.current_period_start)
        self.assertIsNone(response.current_period_end)
        self.assertTrue(rows[0]["comped"])

    def test_checkout_capability_follows_the_server_side_kill_switch(self):
        """Disabling self-checkout must close the flow, not break it.

        `can_start_checkout` drove the frontend's checkout button from row state
        alone, so with the switch off the UI still offered checkout while
        StripeMutationPolicy rejected the operation.
        """
        rows = [{
            "studio_id": "studio_1",
            "status": "incomplete",
            "comped": False,
        }]
        service = self.service(rows)

        service.settings.CORE_SELF_CHECKOUT_ENABLED = True
        self.assertTrue(asyncio.run(service.get_status("studio_1")).can_start_checkout)

        service.settings.CORE_SELF_CHECKOUT_ENABLED = False
        self.assertFalse(asyncio.run(service.get_status("studio_1")).can_start_checkout)

    def test_repair_never_projects_a_previously_rejected_subscription(self):
        """A transient cancel failure must not make a rejection forgettable.

        The rejection previously existed only as an attempted Stripe
        cancellation. If that cancel failed and the comp was later revoked, the
        repair guard reopened against provider state alone and could project the
        still-live rejected subscription as the studio's active one.
        """
        rejected_token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": None,
            "status": "incomplete",
            "comped": False,
            "metadata": {
                "core_checkout_rejections": {
                    "sub_rejected": {
                        "subscription_id": "sub_rejected",
                        "reason": "invalid_paid_subscription_event",
                    },
                },
            },
        }]
        service = self.service(rows)

        class FakeStripeService:
            def list_customer_subscriptions(self, _customer_id):
                return {"data": [{
                    "id": "sub_rejected",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": rejected_token,
                        "core_checkout_epoch": "1",
                    },
                }]}

            def cancel_core_subscription(self, **_payload):
                pass

        # Force the acceptance decision to *approve* this binding. That is the
        # exact state the durable rejection exists for: a transient cancel
        # failure left the subscription live, and nothing in provider or
        # acceptance state still says it was rejected.
        service.supabase._rpc_accept_core_checkout_subscription_atomic = (
            lambda _params: "accepted"
        )

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            response = asyncio.run(service.get_status("studio_1"))

        self.assertIsNone(response.stripe_subscription_id)
        self.assertEqual(response.status, "incomplete")
        self.assertIsNone(rows[0]["stripe_subscription_id"])

    def test_terminal_delete_clears_a_concurrently_projected_rejection(self):
        """The deleted event is the last chance to undo a projected rejection."""
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_rejected",
            "status": "active",
            "comped": False,
            "metadata": {"core_checkout_epoch": 2},
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True

        class FakeStripeService:
            def cancel_core_subscription(self, **_payload):
                raise AssertionError("a deleted subscription must not be cancelled again")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "created": 100,
                "type": "customer.subscription.deleted",
                "data": {"object": {
                    "id": "sub_rejected",
                    "customer": "cus_123",
                    "status": "canceled",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            })

        self.assertIsNone(rows[0]["stripe_subscription_id"])
        self.assertEqual(rows[0]["status"], "incomplete")

    def test_rejection_is_recorded_even_when_no_compensation_is_owed(self):
        """A trialing rejection owes no refund but must still be durable."""
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "status": "incomplete",
            "comped": False,
            "metadata": {"core_checkout_epoch": 2},
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True

        class FakeStripeService:
            def cancel_core_subscription(self, **_payload):
                pass

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "created": 100,
                "type": "customer.subscription.updated",
                "data": {"object": {
                    "id": "sub_trial_rejected",
                    "customer": "cus_123",
                    "status": "trialing",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            })

        metadata = rows[0]["metadata"]
        self.assertIn("sub_trial_rejected", metadata["core_checkout_rejections"])
        self.assertNotIn("core_checkout_compensations", metadata)
