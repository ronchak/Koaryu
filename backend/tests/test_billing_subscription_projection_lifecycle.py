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

class BillingSubscriptionProjectionLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_subscription_invoice_parent_metadata_repairs_invoice_identity_and_period(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": None,
                "student_id": None,
                "enrollment_id": None,
                "invoice_type": "manual",
                "status": "open",
                "amount_due_cents": 0,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 0,
                "currency": "usd",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "current_period_start": None,
                "current_period_end": None,
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "stripe_subscription_item_id": "si_1",
            }],
            "billing_payments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {},
            "parent": {
                "type": "subscription_details",
                "subscription_details": {
                    "subscription": "sub_1",
                    "metadata": {
                        "studio_id": "studio_1",
                        "payer_id": "payer_1",
                        "billing_subscription_id": "subscription_1",
                    },
                },
            },
            "lines": {"data": [{
                "parent": {
                    "subscription_item_details": {
                        "subscription": "sub_1",
                        "subscription_item": "si_1",
                    },
                },
                "period": {"start": 1779140262, "end": 1781818662},
            }]},
        }, "acct_1", "invoice.paid", event_created=300)

        invoice = service.supabase.tables["billing_invoices"][0]
        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(invoice["payer_id"], "payer_1")
        self.assertEqual(invoice["student_id"], "student_1")
        self.assertEqual(invoice["enrollment_id"], "enrollment_1")
        self.assertEqual(invoice["invoice_type"], "tuition")
        self.assertEqual(invoice["stripe_subscription_id"], "sub_1")
        self.assertEqual(subscription["current_period_start"], "2026-05-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-06-18T21:37:42+00:00")

    def test_paid_subscription_invoice_links_orphan_payment_by_customer_amount(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_payment_intent_id": None,
                "status": "open",
                "amount_due_cents": 200,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 200,
                "currency": "usd",
                "application_fee_amount_cents": 0,
            }],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": None,
                "stripe_customer_id": "cus_1",
                "stripe_invoice_id": None,
                "stripe_payment_intent_id": "pi_1",
                "stripe_charge_id": "ch_1",
                "stripe_account_id": "acct_1",
                "status": "succeeded",
                "amount_cents": 200,
                "currency": "usd",
                "application_fee_amount_cents": 1,
                "processed_at": "2026-05-18T21:37:45+00:00",
            }],
            "billing_subscriptions": [],
            "student_billing_enrollments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {},
            "parent": {
                "type": "subscription_details",
                "subscription_details": {
                    "subscription": "sub_1",
                    "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                },
            },
        }, "acct_1", "invoice.paid", event_created=300)

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(payment["invoice_id"], "invoice_1")
        self.assertEqual(payment["stripe_invoice_id"], "in_1")
        self.assertEqual(invoice["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(invoice["application_fee_amount_cents"], 1)

    def test_paid_invoice_does_not_link_ambiguous_orphan_payments(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_payment_intent_id": None,
                "status": "open",
                "amount_due_cents": 200,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 200,
                "currency": "usd",
            }],
            "billing_payments": [
                {
                    "id": "payment_1",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                    "invoice_id": None,
                    "stripe_customer_id": "cus_1",
                    "stripe_invoice_id": None,
                    "stripe_payment_intent_id": "pi_1",
                    "stripe_account_id": "acct_1",
                    "status": "succeeded",
                    "amount_cents": 200,
                    "currency": "usd",
                    "application_fee_amount_cents": 1,
                    "processed_at": "2026-05-18T21:37:45+00:00",
                },
                {
                    "id": "payment_2",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                    "invoice_id": None,
                    "stripe_customer_id": "cus_1",
                    "stripe_invoice_id": None,
                    "stripe_payment_intent_id": "pi_2",
                    "stripe_account_id": "acct_1",
                    "status": "succeeded",
                    "amount_cents": 200,
                    "currency": "usd",
                    "application_fee_amount_cents": 1,
                    "processed_at": "2026-05-18T21:38:45+00:00",
                },
            ],
            "billing_subscriptions": [],
            "student_billing_enrollments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "invoice.paid", event_created=300)

        self.assertIsNone(service.supabase.tables["billing_payments"][0]["invoice_id"])
        self.assertIsNone(service.supabase.tables["billing_payments"][1]["invoice_id"])
        self.assertIsNone(service.supabase.tables["billing_invoices"][0]["stripe_payment_intent_id"])

    def test_orphan_payment_with_unknown_fee_does_not_overwrite_invoice_fee(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_payment_intent_id": None,
                "status": "open",
                "amount_due_cents": 200,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 200,
                "currency": "usd",
                "application_fee_amount_cents": 1,
            }],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": None,
                "stripe_customer_id": "cus_1",
                "stripe_invoice_id": None,
                "stripe_payment_intent_id": "pi_1",
                "stripe_account_id": "acct_1",
                "status": "succeeded",
                "amount_cents": 200,
                "currency": "usd",
                "application_fee_amount_cents": 0,
                "processed_at": "2026-05-18T21:37:45+00:00",
            }],
            "billing_subscriptions": [],
            "student_billing_enrollments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "invoice.paid", event_created=300)

        self.assertEqual(service.supabase.tables["billing_invoices"][0]["application_fee_amount_cents"], 1)

    def test_sparse_invoice_update_preserves_known_stripe_relationships(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_subscription_id": "sub_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "paid",
                "amount_due_cents": 200,
                "amount_paid_cents": 200,
                "amount_remaining_cents": 0,
                "currency": "usd",
            }],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._update_invoice_from_stripe("invoice_1", "studio_1", {
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1")

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["stripe_subscription_id"], "sub_1")
        self.assertEqual(invoice["stripe_payment_intent_id"], "pi_1")

    def test_subscription_projection_uses_item_period_bounds(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "current_period_start": None,
                "current_period_end": None,
            }],
            "student_billing_enrollments": [],
        })

        service.project_connect_event({
            "type": "customer.subscription.updated",
            "account": "acct_1",
            "data": {
                "object": {
                    "id": "sub_1",
                    "status": "active",
                    "customer": "cus_1",
                    "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                    "items": {"data": [{
                        "id": "si_1",
                        "current_period_start": 1779140262,
                        "current_period_end": 1781818662,
                        "metadata": {},
                    }]},
                }
            },
        })

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["current_period_start"], "2026-05-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-06-18T21:37:42+00:00")

    def test_canceled_subscription_projection_does_not_reattach_canceled_enrollment_item(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "status": "active",
                "current_period_start": "2026-05-18T21:37:42+00:00",
                "current_period_end": "2026-06-18T21:37:42+00:00",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": None,
                "status": "canceled",
                "billing_status": "upcoming",
            }],
        })

        service.project_connect_event({
            "type": "customer.subscription.deleted",
            "account": "acct_1",
            "data": {
                "object": {
                    "id": "sub_1",
                    "status": "canceled",
                    "customer": "cus_1",
                    "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
                    "items": {"data": [{
                        "id": "si_1",
                        "metadata": {"enrollment_id": "enrollment_1"},
                    }]},
                }
            },
        })

        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(enrollment["status"], "canceled")
        self.assertEqual(enrollment["billing_status"], "upcoming")
        self.assertIsNone(enrollment["stripe_subscription_item_id"])

    def test_old_invoice_period_does_not_regress_subscription_period(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": "payer_1",
                "status": "paid",
                "last_stripe_event_created": 100,
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "current_period_start": "2026-06-18T21:37:42+00:00",
                "current_period_end": "2026-07-18T21:37:42+00:00",
            }],
            "student_billing_enrollments": [],
            "billing_payments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            "parent": {
                "type": "subscription_details",
                "subscription_details": {"subscription": "sub_1", "metadata": {"studio_id": "studio_1"}},
            },
            "lines": {"data": [{
                "parent": {"subscription_item_details": {"subscription": "sub_1", "subscription_item": "si_1"}},
                "period": {"start": 1779140262, "end": 1781818662},
            }]},
        }, "acct_1", "invoice.paid", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["current_period_start"], "2026-06-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-07-18T21:37:42+00:00")

    def test_mixed_invoice_line_periods_do_not_repair_subscription_period(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "payer_id": "payer_1",
                "status": "paid",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "current_period_start": None,
                "current_period_end": None,
            }],
            "student_billing_enrollments": [],
            "billing_payments": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_invoice_event({
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            "parent": {
                "type": "subscription_details",
                "subscription_details": {"subscription": "sub_1", "metadata": {"studio_id": "studio_1"}},
            },
            "lines": {"data": [
                {
                    "parent": {"subscription_item_details": {"subscription": "sub_1", "subscription_item": "si_1"}},
                    "period": {"start": 1779140262, "end": 1781818662},
                },
                {
                    "parent": {"subscription_item_details": {"subscription": "sub_1", "subscription_item": "si_1"}},
                    "period": {"start": 1779053862, "end": 1779140262},
                    "proration": True,
                },
                {
                    "parent": {"subscription_item_details": {"subscription": "sub_1", "subscription_item": "si_1"}},
                    "period": {"start": 1781818662, "end": 1784410662},
                },
            ]},
        }, "acct_1", "invoice.paid", event_created=200)

        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertIsNone(subscription["current_period_start"])
        self.assertIsNone(subscription["current_period_end"])
