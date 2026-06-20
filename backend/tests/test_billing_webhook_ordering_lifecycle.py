from __future__ import annotations

from tests.billing_lifecycle_helpers import (
    BillingInvoiceCreate,
    BillingInvoiceResponse,
    BillingPayerAutopaySetupRequest,
    BillingPaymentsLifecycleTestBase,
    BillingReconcileRequest,
    BillingService,
    HTTPException,
    StripeService,
    StudentBillingEnrollmentCreate,
    StudentBillingEnrollmentResponse,
    StudentBillingEnrollmentUpdate,
    _FakeBillingSettings,
    _FakeStripe,
    _FakeStripeService,
    _FakeStripeWithMismatchedAccount,
    _FakeSupabase,
    _StripeV2RequestError,
    _test_invoice_request_hash,
    asyncio,
    datetime,
    patch,
    timedelta,
    timezone,
)


class BillingWebhookOrderingLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_stale_invoice_event_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": None,
                "status": "paid",
                "last_stripe_event_created": 200,
            }],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "open",
            "amount_due": 12900,
            "amount_paid": 0,
            "amount_remaining": 12900,
            "currency": "usd",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", "invoice.finalized", event_created=100)

        self.assertEqual(service.supabase.tables["billing_invoices"][0]["status"], "paid")

    def test_payment_intent_without_invoice_reference_does_not_guess_by_customer_amount(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_invoice_id": "in_1",
                "stripe_payment_intent_id": None,
                "status": "open",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "currency": "usd",
            }],
            "billing_payments": [],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "past_due",
                "balance_cents": 12900,
            }],
        })

        service._project_payment_intent({
            "id": "pi_unlinked",
            "status": "succeeded",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "product": "koaryu_payments"},
        }, "acct_1", "payment_intent.succeeded", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        payment = service.supabase.tables["billing_payments"][0]
        self.assertIsNone(payment["invoice_id"])
        self.assertEqual(payment["stripe_invoice_id"], None)
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["stripe_payment_intent_id"], None)

    def test_same_second_invoice_event_does_not_regress_paid_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_payment_intent_id": "pi_paid",
                "payer_id": "payer_1",
                "status": "paid",
                "amount_due_cents": 12900,
                "amount_paid_cents": 12900,
                "amount_remaining_cents": 0,
                "paid_at": "2026-05-18T21:37:42+00:00",
                "last_stripe_event_created": 200,
            }],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "open",
            "amount_due": 12900,
            "amount_paid": 0,
            "amount_remaining": 12900,
            "currency": "usd",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "invoice.finalized", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 12900)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["stripe_payment_intent_id"], "pi_paid")
        self.assertEqual(invoice["last_stripe_event_created"], 200)

    def test_invoice_update_guard_does_not_overwrite_newer_racing_event(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": None,
                "status": "open",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "last_stripe_event_created": 100,
            }],
        })

        def newer_event_wins(rows):
            rows[0].update({
                "status": "paid",
                "amount_paid_cents": 12900,
                "amount_remaining_cents": 0,
                "last_stripe_event_created": 300,
            })

        service.supabase.before_update = newer_event_wins

        service._project_invoice_event({
            "id": "in_1",
            "status": "open",
            "amount_due": 12900,
            "amount_paid": 0,
            "amount_remaining": 12900,
            "currency": "usd",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", "invoice.finalized", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 12900)
        self.assertEqual(invoice["last_stripe_event_created"], 300)

    def test_racing_stale_invoice_paid_event_does_not_project_payment(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "currency": "usd",
                "last_stripe_event_created": 100,
            }],
            "billing_payments": [],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "past_due",
                "balance_cents": 12900,
            }],
        })

        def newer_event_wins(rows):
            rows[0].update({
                "status": "open",
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "last_stripe_event_created": 300,
            })

        service.supabase.before_update = newer_event_wins

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 12900,
            "amount_paid": 12900,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "payment_intent": "pi_stale",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "invoice.paid", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["last_stripe_event_created"], 300)
        self.assertEqual(service.supabase.tables["billing_payments"], [])

    def test_same_second_invoice_paid_event_does_not_regress_refund_state(self):
        for status_value, paid, remaining in (
            ("partially_refunded", 10000, 2900),
            ("refunded", 0, 0),
        ):
            with self.subTest(status=status_value):
                service = self.service()
                service.supabase = _FakeSupabase({
                    "billing_invoices": [{
                        "id": "invoice_1",
                        "studio_id": "studio_1",
                        "stripe_invoice_id": "in_1",
                        "stripe_account_id": "acct_1",
                        "stripe_payment_intent_id": "pi_paid",
                        "payer_id": "payer_1",
                        "status": status_value,
                        "amount_due_cents": 12900,
                        "amount_paid_cents": paid,
                        "amount_remaining_cents": remaining,
                        "paid_at": "2026-05-18T21:37:42+00:00",
                        "last_stripe_event_created": 200,
                    }],
                    "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
                })

                service._project_invoice_event({
                    "id": "in_1",
                    "status": "paid",
                    "amount_due": 12900,
                    "amount_paid": 12900,
                    "amount_remaining": 0,
                    "currency": "usd",
                    "payment_intent": "pi_paid",
                    "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                }, "acct_1", "invoice.paid", event_created=200)

                invoice = service.supabase.tables["billing_invoices"][0]
                self.assertEqual(invoice["status"], status_value)
                self.assertEqual(invoice["amount_paid_cents"], paid)
                self.assertEqual(invoice["amount_remaining_cents"], remaining)
                self.assertEqual(invoice["last_stripe_event_created"], 200)

    def test_invoice_metadata_for_other_connected_account_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_2",
                "stripe_connected_account_id": "acct_2",
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "last_stripe_event_created": 100,
            }],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_2",
            "status": "paid",
            "amount_due": 12900,
            "amount_paid": 12900,
            "amount_remaining": 0,
            "currency": "usd",
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
            },
        }, "acct_2", "invoice.paid", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["stripe_account_id"], "acct_1")
        self.assertEqual(invoice["amount_paid_cents"], 0)

    def test_invoice_metadata_for_unknown_connected_account_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [],
            "billing_invoices": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_unknown",
            "status": "paid",
            "amount_due": 12900,
            "amount_paid": 12900,
            "amount_remaining": 0,
            "currency": "usd",
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
            },
        }, "acct_unknown", "invoice.paid", event_created=200)

        self.assertEqual(service.supabase.tables["billing_invoices"], [])

    def test_connect_invoice_event_without_account_is_not_projected_from_metadata(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_invoices": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service.project_connect_event({
            "id": "evt_missing_account",
            "created": 200,
            "type": "invoice.paid",
            "data": {"object": {
                "id": "in_missing_account",
                "status": "paid",
                "amount_due": 12900,
                "amount_paid": 12900,
                "amount_remaining": 0,
                "currency": "usd",
                "metadata": {
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                },
            }},
        })

        self.assertEqual(service.supabase.tables["billing_invoices"], [])

    def test_payment_intent_metadata_for_unknown_connected_account_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [],
            "billing_invoices": [],
            "billing_payments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_payment_intent({
            "id": "pi_unknown",
            "status": "succeeded",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_unknown",
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
            },
        }, "acct_unknown", "payment_intent.succeeded")

        self.assertEqual(service.supabase.tables["billing_payments"], [])

    def test_stale_connect_account_update_does_not_regress_ready_account(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "last_stripe_event_created": 200,
            }],
        })

        service.project_connect_event({
            "id": "evt_account_stale",
            "account": "acct_1",
            "created": 100,
            "type": "account.updated",
            "data": {"object": {
                "id": "acct_1",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements": {"currently_due": ["external_account"]},
            }},
        })

        account = service.supabase.tables["studio_payment_accounts"][0]
        self.assertEqual(account["status"], "charges_enabled")
        self.assertTrue(account["charges_enabled"])
        self.assertEqual(account["last_stripe_event_created"], 200)

    def test_same_second_account_update_does_not_reauthorize_deauthorized_account(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "deauthorized",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "last_stripe_event_created": 200,
            }],
        })

        service.project_connect_event({
            "id": "evt_account_same_second",
            "account": "acct_1",
            "created": 200,
            "type": "account.updated",
            "data": {"object": {
                "id": "acct_1",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements": {"currently_due": []},
            }},
        })

        account = service.supabase.tables["studio_payment_accounts"][0]
        self.assertEqual(account["status"], "deauthorized")
        self.assertFalse(account["charges_enabled"])
        self.assertEqual(account["last_stripe_event_created"], 200)

    def test_same_second_subscription_update_does_not_regress_canceled_subscription(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "status": "canceled",
                "last_stripe_event_created": 200,
            }],
            "student_billing_enrollments": [],
        })

        service._project_subscription({
            "id": "sub_1",
            "status": "active",
            "customer": "cus_1",
            "items": {"data": []},
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "customer.subscription.updated", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["status"], "canceled")
        self.assertEqual(subscription["last_stripe_event_created"], 200)

    def test_subscription_update_guard_does_not_overwrite_newer_racing_event(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "status": "active",
                "last_stripe_event_created": 100,
            }],
            "student_billing_enrollments": [],
        })

        def newer_event_wins(rows):
            rows[0].update({
                "status": "canceled",
                "last_stripe_event_created": 300,
            })

        service.supabase.before_update = newer_event_wins

        service._project_subscription({
            "id": "sub_1",
            "status": "active",
            "customer": "cus_1",
            "items": {"data": []},
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "customer.subscription.updated", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["status"], "canceled")
        self.assertEqual(subscription["last_stripe_event_created"], 300)

    def test_racing_stale_subscription_event_does_not_update_items(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "status": "active",
                "last_stripe_event_created": 100,
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_item_id": "si_1",
                "status": "active",
                "billing_status": "past_due",
            }],
        })

        def newer_event_wins(rows):
            rows[0].update({
                "status": "canceled",
                "last_stripe_event_created": 300,
            })

        service.supabase.before_update = newer_event_wins

        service._project_subscription({
            "id": "sub_1",
            "status": "active",
            "customer": "cus_1",
            "items": {"data": [{"id": "si_1", "metadata": {}}]},
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "customer.subscription.updated", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(subscription["status"], "canceled")
        self.assertEqual(subscription["last_stripe_event_created"], 300)
        self.assertEqual(enrollment["billing_status"], "past_due")

    def test_subscription_deleted_detaches_linked_enrollments(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "status": "active",
                "last_stripe_event_created": 100,
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "status": "active",
                "billing_status": "current",
            }],
        })

        service._project_subscription({
            "id": "sub_1",
            "status": "canceled",
            "customer": "cus_1",
            "items": {"data": []},
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "customer.subscription.deleted", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(subscription["status"], "canceled")
        self.assertEqual(enrollment["status"], "canceled")
        self.assertEqual(enrollment["billing_status"], "unpaid")
        self.assertIsNone(enrollment["stripe_subscription_id"])
        self.assertIsNone(enrollment["stripe_subscription_item_id"])

    def test_subscription_metadata_for_other_connected_account_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_2",
                "stripe_connected_account_id": "acct_2",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "status": "active",
                "last_stripe_event_created": 100,
            }],
            "student_billing_enrollments": [],
        })

        service._project_subscription({
            "id": "sub_2",
            "status": "canceled",
            "customer": "cus_1",
            "items": {"data": []},
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "billing_subscription_id": "subscription_1",
            },
        }, "acct_2", "customer.subscription.deleted", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["status"], "active")
        self.assertEqual(subscription["stripe_account_id"], "acct_1")

    def test_subscription_metadata_for_unknown_connected_account_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [],
            "billing_subscriptions": [],
            "student_billing_enrollments": [],
        })

        response = service._project_subscription({
            "id": "sub_unknown",
            "status": "active",
            "customer": "cus_unknown",
            "items": {"data": []},
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
            },
        }, "acct_unknown", "customer.subscription.updated", event_created=200)

        self.assertIsNone(response)
        self.assertEqual(service.supabase.tables["billing_subscriptions"], [])
