from __future__ import annotations

from unittest.mock import patch

from tests.platform_billing_helpers import PlatformBillingServiceTestCase


class PlatformBillingSubscriptionProjectionTest(PlatformBillingServiceTestCase):
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
