from __future__ import annotations

from unittest.mock import patch

from tests.platform_billing_helpers import PlatformBillingServiceTestCase


class PlatformBillingSubscriptionProjectionTest(PlatformBillingServiceTestCase):
    @staticmethod
    def published_checkout(token: str, *, epoch: int = 1, session_id: str = "cs_accepted"):
        return {
            "core_checkout_epoch": epoch,
            "core_checkout_session": {
                "state": "published",
                "token": token,
                "epoch": epoch,
                "id": session_id,
                "url": "https://checkout.stripe.test/accepted",
                "expires_at": 9999999999,
            },
        }

    def test_invalidated_checkout_completion_cancels_subscription_without_clearing_comp(self):
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "status": "incomplete",
            "comped": True,
            "metadata": {"core_checkout_epoch": 2},
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True
        canceled = []

        class FakeStripeService:
            def cancel_core_subscription(self, **payload):
                canceled.append(payload["subscription_id"])

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_invalidated",
                "created": 100,
                "type": "checkout.session.completed",
                "data": {"object": {
                    "id": "cs_invalidated",
                    "customer": "cus_123",
                    "subscription": "sub_invalidated",
                    "payment_status": "paid",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            })

        self.assertEqual(canceled, ["sub_invalidated"])
        self.assertTrue(rows[0]["comped"])
        self.assertIsNone(rows[0].get("stripe_subscription_id"))

    def test_checkout_completion_replay_preserves_durable_acceptance(self):
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "status": "incomplete",
            "comped": False,
            "metadata": self.published_checkout(token),
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True
        event = {
            "created": 100,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_accepted",
                "customer": "cus_123",
                "subscription": "sub_accepted",
                "payment_status": "paid",
                "metadata": {
                    "studio_id": "studio_1",
                    "core_checkout_reservation_token": token,
                    "core_checkout_epoch": "1",
                },
            }},
        }

        service.project_subscription_event(event, hydrate_subscription=False)
        service.project_subscription_event(event, hydrate_subscription=False)

        session = rows[0]["metadata"]["core_checkout_session"]
        self.assertEqual(session["state"], "completed")
        self.assertEqual(session["accepted_subscription_id"], "sub_accepted")
        self.assertTrue(rows[0]["metadata"]["core_trial_consumed"])
        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_accepted")

    def test_archived_acceptance_replays_both_event_families_without_cancellation(self):
        old_token = "00000000-0000-4000-8000-000000000001"
        new_token = "00000000-0000-4000-8000-000000000002"
        archived = {
            "state": "completed",
            "token": old_token,
            "epoch": 1,
            "id": "cs_old",
            "accepted_subscription_id": "sub_old",
            "completed_event_created": 100,
        }
        rows = [{
            "studio_id": "studio_1",
            "stripe_customer_id": "cus_123",
            "stripe_subscription_id": "sub_new",
            "status": "active",
            "comped": False,
            "last_stripe_event_created": 200,
            "metadata": {
                "core_trial_consumed": True,
                "core_subscription_event_created": 200,
                "core_invoice_payment_event_created": 200,
                "core_checkout_epoch": 2,
                "core_checkout_acceptances": {"sub_old": archived},
                "core_checkout_session": {
                    "state": "published",
                    "token": new_token,
                    "epoch": 2,
                    "id": "cs_new",
                    "url": "https://checkout.stripe.test/new",
                    "expires_at": 9999999999,
                },
            },
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True

        class CancellationMustNotRun:
            def cancel_core_subscription(self, **_payload):
                raise AssertionError("an archived accepted binding must replay successfully")

        checkout_event = {
            "created": 201,
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_old",
                "customer": "cus_123",
                "subscription": "sub_old",
                "payment_status": "paid",
                "metadata": {
                    "studio_id": "studio_1",
                    "core_checkout_reservation_token": old_token,
                    "core_checkout_epoch": "1",
                },
            }},
        }
        subscription_event = {
            "created": 202,
            "type": "customer.subscription.updated",
            "data": {"object": {
                "id": "sub_old",
                "customer": "cus_123",
                "status": "canceled",
                "metadata": {
                    "studio_id": "studio_1",
                    "core_checkout_reservation_token": old_token,
                    "core_checkout_epoch": "1",
                },
            }},
        }

        with patch(
            "app.services.platform_billing_service.StripeService",
            CancellationMustNotRun,
        ):
            service.project_subscription_event(checkout_event, hydrate_subscription=False)
            service.project_subscription_event(subscription_event)

        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_new")
        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["metadata"]["core_checkout_session"]["id"], "cs_new")
        self.assertEqual(
            rows[0]["metadata"]["core_checkout_acceptances"]["sub_old"]
            ["accepted_subscription_id"],
            "sub_old",
        )

    def test_comped_archived_acceptance_is_rejected_by_both_event_families(self):
        token = "00000000-0000-4000-8000-000000000001"
        archived = {
            "state": "completed",
            "token": token,
            "epoch": 1,
            "id": "cs_comped",
            "accepted_subscription_id": "sub_comped",
            "completed_event_created": 100,
        }
        events = [
            {
                "created": 100,
                "type": "checkout.session.completed",
                "data": {"object": {
                    "id": "cs_comped",
                    "customer": "cus_123",
                    "subscription": "sub_comped",
                    "payment_status": "paid",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            },
            {
                "created": 100,
                "type": "customer.subscription.updated",
                "data": {"object": {
                    "id": "sub_comped",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            },
        ]

        for event in events:
            with self.subTest(event_type=event["type"]):
                rows = [{
                    "studio_id": "studio_1",
                    "stripe_customer_id": "cus_123",
                    "stripe_subscription_id": None,
                    "status": "comped",
                    "comped": True,
                    "metadata": {
                        "core_trial_consumed": True,
                        "core_checkout_epoch": 2,
                        "core_checkout_acceptances": {"sub_comped": dict(archived)},
                    },
                }]
                service = self.service(rows)
                service.settings.CORE_SELF_CHECKOUT_ENABLED = True
                canceled = []

                class FakeStripeService:
                    def cancel_core_subscription(self, **payload):
                        canceled.append(payload["subscription_id"])

                with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
                    service.project_subscription_event(event, hydrate_subscription=False)

                self.assertEqual(canceled, ["sub_comped"])
                self.assertTrue(rows[0]["comped"])
                self.assertEqual(rows[0]["status"], "comped")

    def test_explicit_core_comp_override_accepts_only_bound_subscription_replay(self):
        token = "00000000-0000-4000-8000-000000000001"
        archived = {
            "state": "completed",
            "token": token,
            "epoch": 1,
            "id": "cs_override",
            "accepted_subscription_id": "sub_override",
            "completed_event_created": 100,
        }
        events = [
            {
                "created": 300,
                "type": "checkout.session.completed",
                "data": {"object": {
                    "id": "cs_override",
                    "customer": "cus_123",
                    "subscription": "sub_override",
                    "payment_status": "paid",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            },
            {
                "created": 301,
                "type": "customer.subscription.updated",
                "data": {"object": {
                    "id": "sub_override",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            },
        ]

        for event in events:
            with self.subTest(event_type=event["type"]):
                rows = [{
                    "studio_id": "studio_1",
                    "stripe_customer_id": "cus_123",
                    "stripe_subscription_id": "sub_override",
                    "status": "active",
                    "comped": True,
                    "metadata": {
                        "core_checkout_epoch": 2,
                        "core_checkout_acceptances": {"sub_override": dict(archived)},
                        "comp": {
                            "state": "granted",
                            "live_subscription_override": True,
                            "live_subscription_override_subscription_id": "sub_override",
                        },
                    },
                }]
                service = self.service(rows)
                service.settings.CORE_SELF_CHECKOUT_ENABLED = True

                class CancellationMustNotRun:
                    def cancel_core_subscription(self, **_payload):
                        raise AssertionError("the explicitly retained subscription must not be canceled")

                with patch(
                    "app.services.platform_billing_service.StripeService",
                    CancellationMustNotRun,
                ):
                    service.project_subscription_event(event, hydrate_subscription=False)

                self.assertTrue(rows[0]["comped"])
                self.assertEqual(rows[0]["stripe_subscription_id"], "sub_override")
                self.assertEqual(rows[0]["status"], "active")

    def test_tokenized_subscription_event_accepts_before_checkout_completion(self):
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "status": "incomplete",
            "comped": False,
            "metadata": self.published_checkout(token),
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True

        service.project_subscription_event({
            "created": 90,
            "type": "customer.subscription.created",
            "data": {"object": {
                "id": "sub_first",
                "customer": "cus_123",
                "status": "trialing",
                "metadata": {
                    "studio_id": "studio_1",
                    "core_checkout_reservation_token": token,
                    "core_checkout_epoch": "1",
                },
            }},
        })

        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_first")
        self.assertEqual(
            rows[0]["metadata"]["core_checkout_session"]["accepted_subscription_id"],
            "sub_first",
        )

    def test_invalidated_tokenized_subscription_event_preserves_comp(self):
        token = "00000000-0000-4000-8000-000000000001"
        rows = [{
            "studio_id": "studio_1",
            "status": "comped",
            "comped": True,
            "metadata": {"core_checkout_epoch": 2},
        }]
        service = self.service(rows)
        service.settings.CORE_SELF_CHECKOUT_ENABLED = True
        canceled = []

        class FakeStripeService:
            def cancel_core_subscription(self, **payload):
                canceled.append(payload["subscription_id"])

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "created": 100,
                "type": "customer.subscription.created",
                "data": {"object": {
                    "id": "sub_invalid",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {
                        "studio_id": "studio_1",
                        "core_checkout_reservation_token": token,
                        "core_checkout_epoch": "1",
                    },
                }},
            })

        self.assertEqual(canceled, ["sub_invalid"])
        self.assertTrue(rows[0]["comped"])
        self.assertIsNone(rows[0].get("stripe_subscription_id"))

    @staticmethod
    def subscription_event(*, created):
        return {
            "created": created,
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_123",
                    "customer": "cus_123",
                    "status": "active",
                    "metadata": {"studio_id": "studio_1"},
                },
            },
        }

    @staticmethod
    def checkout_event(*, created):
        return {
            "created": created,
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "customer": "cus_123",
                    "subscription": "sub_123",
                    "payment_status": "paid",
                    "metadata": {"studio_id": "studio_1"},
                },
            },
        }

    def test_checkout_hydration_failure_logs_only_safe_diagnostics(self):
        rows = [{"studio_id": "studio_sensitive", "status": "incomplete"}]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, _subscription_id):
                raise RuntimeError("sk_live_secret req_sensitive")

        with self.assertLogs("app.services.platform_billing_service", level="ERROR") as captured_logs:
            with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
                service.project_subscription_event({
                    "id": "evt_sensitive",
                    "created": 100,
                    "type": "checkout.session.completed",
                    "data": {
                        "object": {
                            "customer": "cus_sensitive",
                            "subscription": "sub_sensitive",
                            "payment_status": "paid",
                            "metadata": {"studio_id": "studio_sensitive"},
                        },
                    },
                })

        log_record = captured_logs.records[0]
        self.assertRegex(log_record.getMessage(), r"reference=[0-9a-f]{32}; error_type=RuntimeError$")
        self.assertIsNone(log_record.exc_info)
        for sensitive_key in ("studio_id", "stripe_subscription_id"):
            self.assertNotIn(sensitive_key, log_record.__dict__)
        for sensitive_value in (
            "studio_sensitive",
            "sub_sensitive",
            "cus_sensitive",
            "evt_sensitive",
            "sk_live_secret",
            "req_sensitive",
        ):
            self.assertNotIn(sensitive_value, repr(log_record.__dict__))
        self.assertEqual(rows[0]["status"], "incomplete")

    def test_subscription_event_for_deleted_studio_is_ignored_without_inserting(self):
        rows = []
        service = self.service(rows)
        service.supabase.tables["studios"] = []

        with self.assertLogs("app.services.platform_billing_service", level="WARNING") as captured_logs:
            service.project_subscription_event(self.subscription_event(created=100))

        self.assertEqual(rows, [])
        self.assertRegex(
            captured_logs.records[0].getMessage(),
            r"^Ignored Stripe platform subscription event for a deleted studio; "
            r"reference=[0-9a-f]{32}; event_type=customer\.subscription\.updated$",
        )
        self.assertNotIn("studio_1", repr(captured_logs.records[0].__dict__))

    def test_checkout_event_for_deleted_studio_is_ignored_without_hydration(self):
        rows = []
        service = self.service(rows)
        service.supabase.tables["studios"] = []

        with self.assertLogs("app.services.platform_billing_service", level="WARNING") as captured_logs:
            with patch("app.services.platform_billing_service.StripeService") as stripe_service:
                service.project_subscription_event(self.checkout_event(created=100))

        self.assertEqual(rows, [])
        stripe_service.assert_not_called()
        self.assertIn("event_type=checkout.session.completed", captured_logs.records[0].getMessage())

    def test_project_subscription_uses_item_period_bounds_and_clears_trial_fields(self):
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
                },
            },
        })

        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_123")
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")
        self.assertIsNone(rows[0]["trial_start"])
        self.assertIsNone(rows[0]["trial_end"])
        self.assertEqual(rows[0]["current_period_start"], "1970-01-01T00:01:40+00:00")
        self.assertEqual(rows[0]["current_period_end"], "1970-01-01T00:08:20+00:00")
        self.assertTrue(rows[0]["cancel_at_period_end"])

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
            "metadata": {"core_subscription_event_created": 200},
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

    def test_legacy_last_event_watermark_still_blocks_stale_subscription_webhook(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_stripe_event_created": 200,
            "metadata": {},
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
        self.assertEqual(rows[0]["metadata"]["core_subscription_event_created"], 200)

    def test_invoice_event_does_not_make_subscription_update_stale(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "trialing",
            "last_stripe_event_created": 100,
            "metadata": {"core_subscription_event_created": 100},
        }]
        service = self.service(rows)

        service.project_subscription_event({
            "id": "evt_invoice",
            "created": 300,
            "type": "invoice.paid",
            "data": {"object": {"subscription": "sub_123", "customer": "cus_123"}},
        })
        service.project_subscription_event({
            "id": "evt_subscription",
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

        self.assertEqual(rows[0]["last_payment_status"], "paid")
        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["metadata"]["core_subscription_event_created"], 200)
        self.assertEqual(rows[0]["metadata"]["core_invoice_payment_event_created"], 300)

    def test_stale_invoice_payment_event_does_not_regress_last_payment_status(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_payment_status": "paid",
            "metadata": {"core_invoice_payment_event_created": 300},
        }]
        service = self.service(rows)

        service.project_subscription_event({
            "id": "evt_invoice_old",
            "created": 200,
            "type": "invoice.payment_failed",
            "data": {"object": {"subscription": "sub_123", "customer": "cus_123"}},
        })

        self.assertEqual(rows[0]["last_payment_status"], "paid")
        self.assertEqual(rows[0]["metadata"]["core_invoice_payment_event_created"], 300)

    def test_newer_invoice_payment_event_advances_last_payment_status(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_payment_status": "failed",
            "metadata": {"core_invoice_payment_event_created": 100},
        }]
        service = self.service(rows)

        service.project_subscription_event({
            "id": "evt_invoice_new",
            "created": 200,
            "type": "invoice.paid",
            "data": {"object": {"subscription": "sub_123", "customer": "cus_123"}},
        })

        self.assertEqual(rows[0]["last_payment_status"], "paid")
        self.assertEqual(rows[0]["metadata"]["core_invoice_payment_event_created"], 200)

    def test_old_checkout_completion_does_not_regress_newer_subscription_status(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_stripe_event_created": 200,
            "metadata": {"core_subscription_event_created": 200},
        }]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                raise RuntimeError("temporary Stripe retrieve failure")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_checkout_old",
                "created": 100,
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
        self.assertEqual(rows[0]["last_payment_status"], "paid")
        self.assertEqual(rows[0]["metadata"]["core_subscription_event_created"], 200)

    def test_old_checkout_completion_does_not_regress_newer_invoice_payment_status(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_payment_status": "failed",
            "metadata": {
                "core_subscription_event_created": 100,
                "core_invoice_payment_event_created": 300,
            },
        }]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                raise RuntimeError("temporary Stripe retrieve failure")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_checkout_old_payment",
                "created": 200,
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

        self.assertEqual(rows[0]["status"], "incomplete")
        self.assertEqual(rows[0]["last_payment_status"], "failed")
        self.assertEqual(rows[0]["metadata"]["core_invoice_payment_event_created"], 300)

    def test_old_checkout_subscription_fetch_does_not_lower_subscription_watermark(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "active",
            "last_stripe_event_created": 200,
            "metadata": {"core_subscription_event_created": 200},
        }]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                return {
                    "id": subscription_id,
                    "customer": "cus_123",
                    "status": "trialing",
                    "items": {"data": [{"current_period_start": 100, "current_period_end": 200}]},
                }

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_checkout_old",
                "created": 100,
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
        self.assertEqual(rows[0]["metadata"]["core_subscription_event_created"], 200)

    def test_old_checkout_completion_does_not_replace_newer_subscription_identity(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_new",
            "stripe_customer_id": "cus_new",
            "status": "active",
            "comped": False,
            "last_stripe_event_created": 200,
            "metadata": {"core_subscription_event_created": 200},
        }]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                raise AssertionError("stale checkout should not retrieve and project subscription details")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_checkout_old",
                "created": 100,
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "customer": "cus_old",
                        "subscription": "sub_old",
                        "payment_status": "paid",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
            })

        self.assertEqual(rows[0]["stripe_customer_id"], "cus_new")
        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_new")
        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[0]["last_payment_status"], "paid")

    def test_fresh_checkout_completion_marks_subscription_watermark_before_retrieve(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": None,
            "stripe_customer_id": "cus_123",
            "status": "incomplete",
            "comped": False,
            "metadata": {},
        }]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                raise RuntimeError("temporary Stripe retrieve failure")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_checkout_new",
                "created": 200,
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "customer": "cus_123",
                        "subscription": "sub_new",
                        "payment_status": "paid",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
            })
            service.project_subscription_event({
                "id": "evt_subscription_old",
                "created": 100,
                "type": "customer.subscription.updated",
                "data": {
                    "object": {
                        "id": "sub_new",
                        "customer": "cus_123",
                        "status": "canceled",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
            })

        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_new")
        self.assertEqual(rows[0]["status"], "incomplete")
        self.assertEqual(rows[0]["last_payment_status"], "paid")
        self.assertEqual(rows[0]["metadata"]["core_subscription_event_created"], 200)

    def test_checkout_completion_preserves_pending_cleanup_with_event_watermarks(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": None,
            "stripe_customer_id": "cus_123",
            "status": "incomplete",
            "comped": False,
            "metadata": {
                "core_checkout_session": {
                    "id": "cs_pending",
                    "url": "https://checkout.stripe.test/session",
                    "expires_at": 9999999999,
                }
            },
        }]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, subscription_id):
                raise RuntimeError("temporary Stripe retrieve failure")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event({
                "id": "evt_checkout_cleanup",
                "created": 200,
                "type": "checkout.session.completed",
                "data": {
                    "object": {
                        "customer": "cus_123",
                        "subscription": "sub_new",
                        "payment_status": "paid",
                        "metadata": {"studio_id": "studio_1"},
                    },
                },
            })

        self.assertNotIn("core_checkout_session", rows[0]["metadata"])
        self.assertEqual(rows[0]["metadata"]["core_subscription_event_created"], 200)
        self.assertEqual(rows[0]["metadata"]["core_invoice_payment_event_created"], 200)

    def test_checkout_completed_uses_retrieved_subscription_status(self):
        for subscription_status in ("active", "trialing", "past_due", "incomplete"):
            with self.subTest(subscription_status=subscription_status):
                rows = [{"studio_id": "studio_1", "status": "incomplete", "comped": False}]
                service = self.service(rows)

                class FakeStripeService:
                    def retrieve_subscription(self, subscription_id):
                        assert subscription_id == "sub_123"
                        return {
                            "id": "sub_123",
                            "customer": "cus_123",
                            "status": subscription_status,
                            "trial_start": 50 if subscription_status == "trialing" else None,
                            "trial_end": 100 if subscription_status == "trialing" else None,
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

                self.assertEqual(rows[0]["status"], subscription_status)
                self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")
                self.assertEqual(rows[0]["stripe_subscription_id"], "sub_123")
                self.assertEqual(rows[0]["current_period_start"], "1970-01-01T00:01:40+00:00")

    def test_checkout_completed_without_subscription_hydration_fails_closed(self):
        rows = [{"studio_id": "studio_1", "status": "incomplete", "comped": False}]
        service = self.service(rows)

        class FakeStripeService:
            def retrieve_subscription(self, _subscription_id):
                raise AssertionError("webhook acknowledgement path should not retrieve from Stripe")

        with patch("app.services.platform_billing_service.StripeService", FakeStripeService):
            service.project_subscription_event(
                {
                    "type": "checkout.session.completed",
                    "data": {
                        "object": {
                            "customer": "cus_123",
                            "subscription": "sub_123",
                            "payment_status": "paid",
                            "metadata": {"studio_id": "studio_1"},
                        },
                    },
                },
                hydrate_subscription=False,
            )

        self.assertEqual(rows[0]["status"], "incomplete")
        self.assertEqual(rows[0]["stripe_customer_id"], "cus_123")
        self.assertEqual(rows[0]["stripe_subscription_id"], "sub_123")
        self.assertNotIn("current_period_start", rows[0])

    def test_both_subscription_event_families_can_clear_an_older_comp(self):
        events = {
            "checkout": (self.checkout_event(created=101), False),
            "subscription": (self.subscription_event(created=101), True),
        }
        for label, (event, hydrate_subscription) in events.items():
            with self.subTest(label):
                rows = [{
                    "studio_id": "studio_1",
                    "stripe_subscription_id": "sub_123",
                    "stripe_customer_id": "cus_123",
                    "status": "canceled",
                    "comped": True,
                    "metadata": {
                        "comp": {
                            "state": "granted",
                            "at": "1970-01-01T00:01:40+00:00",
                        },
                    },
                }]
                service = self.service(rows)

                service.project_subscription_event(
                    event,
                    hydrate_subscription=hydrate_subscription,
                )

                self.assertFalse(rows[0]["comped"])
                self.assertEqual(
                    service.supabase.rpc_calls[-1],
                    (
                        "clear_studio_comp_for_billing_event",
                        {
                            "p_studio_id": "studio_1",
                            "p_event_created": 101,
                        },
                    ),
                )

    def test_non_object_comp_provenance_is_absent_and_does_not_wedge_clear(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "canceled",
            "comped": True,
            "metadata": {"comp": ["legacy"]},
        }]
        service = self.service(rows)

        service.project_subscription_event(
            self.subscription_event(created=101),
            hydrate_subscription=True,
        )

        self.assertFalse(rows[0]["comped"])
        self.assertEqual(rows[0]["metadata"]["comp"], ["legacy"])

    def test_postgres_incompatible_grant_offset_preserves_comp_in_fake(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "canceled",
            "comped": True,
            "metadata": {
                "comp": {
                    "state": "granted",
                    "at": "2026-07-27T00:00:00+16:00",
                },
            },
        }]
        service = self.service(rows)

        service.project_subscription_event(
            self.subscription_event(created=1785153600),
            hydrate_subscription=True,
        )

        self.assertTrue(rows[0]["comped"])

    def test_out_of_range_event_timestamp_preserves_comp_in_fake(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
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

        service.project_subscription_event(
            self.subscription_event(created=9223372036854775807),
            hydrate_subscription=True,
        )

        self.assertTrue(rows[0]["comped"])

    def test_only_a_strictly_older_event_loses_to_a_concurrent_grant(self):
        events = {
            "checkout before": (self.checkout_event(created=99), False, True),
            "checkout overlap": (self.checkout_event(created=100), False, False),
            "subscription before": (
                self.subscription_event(created=99),
                True,
                True,
            ),
            "subscription overlap": (
                self.subscription_event(created=100),
                True,
                False,
            ),
        }
        for label, (event, hydrate_subscription, expected_comped) in events.items():
            with self.subTest(label):
                rows = [{
                    "studio_id": "studio_1",
                    "stripe_subscription_id": "sub_123",
                    "stripe_customer_id": "cus_123",
                    "status": "canceled",
                    "comped": False,
                    "metadata": {},
                }]
                service = self.service(rows)

                def grant_after_webhook_read(_rows):
                    rows[0]["comped"] = True
                    rows[0]["metadata"] = {
                        "comp": {
                            "state": "granted",
                            "at": "1970-01-01T00:01:40.900000+00:00",
                        },
                    }

                service.supabase.before_update = grant_after_webhook_read
                service.project_subscription_event(
                    event,
                    hydrate_subscription=hydrate_subscription,
                )

                self.assertIs(rows[0]["comped"], expected_comped)
                self.assertEqual(
                    rows[0]["metadata"]["comp"]["state"],
                    "granted",
                )
                event_update = next(
                    entry["update"]
                    for entry in service.supabase.query_log
                    if entry["table"] == "studio_subscriptions"
                    and entry["update"] is not None
                )
                self.assertNotIn("comped", event_update)

    def test_comp_clear_rpc_failure_propagates_after_projection_for_webhook_retry(self):
        rows = [{
            "studio_id": "studio_1",
            "stripe_subscription_id": "sub_123",
            "stripe_customer_id": "cus_123",
            "status": "canceled",
            "comped": True,
            "metadata": {
                "comp": {
                    "state": "granted",
                    "at": "1970-01-01T00:01:40+00:00",
                },
            },
        }]
        service = self.service(rows)

        def fail_comp_clear(_params):
            raise RuntimeError("forced ordered comp clear failure")

        service.supabase._rpc_clear_studio_comp_for_billing_event = fail_comp_clear

        with self.assertRaisesRegex(
            RuntimeError,
            "forced ordered comp clear failure",
        ):
            service.project_subscription_event(
                self.subscription_event(created=101),
                hydrate_subscription=True,
            )

        self.assertEqual(rows[0]["status"], "active")
        self.assertTrue(rows[0]["comped"])
