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

class BillingPaymentIntentLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_succeeded_payment_without_latest_charge_is_not_refundable(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
            "billing_payments": [],
            "billing_invoices": [],
            "billing_refunds": [],
            "billing_disputes": [],
        })
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent({
            "id": "pi_no_charge",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "payment_intent.succeeded", event_created=100)

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertIsNone(payment["stripe_charge_id"])
        self.assertEqual(payment["net_collected_amount_cents"], 12900)
        self.assertEqual(payment["refundable_amount_cents"], 0)

    def test_invoice_payment_intent_retrieval_failure_projects_nonrefundable_fallback(self):
        service = self.service()
        local_invoice = {
            "id": "invoice_1",
            "studio_id": "studio_1",
            "payer_id": "payer_1",
            "stripe_invoice_id": "in_1",
            "stripe_payment_intent_id": "pi_1",
            "stripe_account_id": "acct_1",
            "status": "paid",
            "amount_due_cents": 200,
            "amount_paid_cents": 200,
            "amount_remaining_cents": 0,
            "currency": "usd",
            "application_fee_amount_cents": 0,
            "paid_at": "2026-05-18T00:00:00Z",
        }
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "billing_status": "current",
                "balance_cents": 0,
            }],
            "billing_invoices": [local_invoice],
            "billing_payments": [],
            "billing_refunds": [],
            "billing_disputes": [],
        })

        with patch(
            "app.services.billing_service.StripeService.retrieve_connected_payment_intent",
            side_effect=RuntimeError("transient retrieval failure"),
        ):
            service._project_payment_from_invoice({
                "id": "in_1",
                "payment_intent": "pi_1",
                "amount_paid": 200,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
            }, "acct_1", local_invoice, event_created=100)

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertIsNone(payment["stripe_charge_id"])
        self.assertEqual(payment["net_collected_amount_cents"], 200)
        self.assertEqual(payment["refundable_amount_cents"], 0)
        self.assertEqual(local_invoice["amount_remaining_cents"], 0)

    def test_processing_then_succeeded_payment_has_exact_accounting(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
            "billing_payments": [],
            "billing_invoices": [],
            "billing_refunds": [],
            "billing_disputes": [],
        })
        intent = {
            "id": "pi_1",
            "amount": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }

        service._project_payment_intent(
            intent,
            "acct_1",
            "payment_intent.processing",
            event_created=100,
        )
        processing = service.supabase.tables["billing_payments"][0]
        self.assertEqual(processing["status"], "processing")
        self.assertEqual(processing["net_collected_amount_cents"], 0)
        self.assertEqual(processing["refundable_amount_cents"], 0)

        service._project_payment_intent(
            {**intent, "amount_received": 12900},
            "acct_1",
            "payment_intent.succeeded",
            event_created=200,
        )
        succeeded = service.supabase.tables["billing_payments"][0]
        self.assertEqual(succeeded["status"], "succeeded")
        self.assertEqual(succeeded["refunded_amount_cents"], 0)
        self.assertEqual(succeeded["disputed_amount_cents"], 0)
        self.assertEqual(succeeded["net_collected_amount_cents"], 12900)
        self.assertEqual(succeeded["refundable_amount_cents"], 12900)

    def test_failed_payment_has_zero_collected_and_refundable_amounts(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
            "billing_payments": [],
            "billing_invoices": [],
            "billing_refunds": [],
            "billing_disputes": [],
        })

        service._project_payment_intent({
            "id": "pi_failed",
            "amount": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "payment_intent.payment_failed", event_created=100)

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "failed")
        self.assertEqual(payment["net_collected_amount_cents"], 0)
        self.assertEqual(payment["refundable_amount_cents"], 0)

    def test_delayed_payment_projection_after_reconnect_preserves_established_identity(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "metadata": {"connect_account_generation": 2},
            }],
            "billing_payers": [],
            "billing_invoices": [],
            "billing_refunds": [],
            "billing_disputes": [],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_original",
                "invoice_id": "invoice_original",
                "stripe_customer_id": "cus_original",
                "stripe_invoice_id": "in_original",
                "stripe_payment_intent_id": "pi_1",
                "stripe_charge_id": "ch_original",
                "stripe_account_id": "acct_1",
                "connect_account_generation": 1,
                "stripe_payment_method_id": "pm_original",
                "status": "succeeded",
                "amount_cents": 12900,
                "refunded_amount_cents": 0,
                "disputed_amount_cents": 0,
                "net_collected_amount_cents": 12900,
                "refundable_amount_cents": 12900,
                "last_stripe_event_created": 100,
            }],
        })
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent({
            "id": "pi_1",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_replayed",
            "invoice": "in_replayed",
            "latest_charge": "ch_replayed",
            "payment_method": "pm_replayed",
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_replayed",
                "product": "koaryu_payments",
            },
        }, "acct_1", "payment_intent.succeeded", event_created=200)

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["payer_id"], "payer_original")
        self.assertEqual(payment["invoice_id"], "invoice_original")
        self.assertEqual(payment["stripe_customer_id"], "cus_original")
        self.assertEqual(payment["stripe_invoice_id"], "in_original")
        self.assertEqual(payment["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(payment["stripe_charge_id"], "ch_original")
        self.assertEqual(payment["stripe_account_id"], "acct_1")
        self.assertEqual(payment["connect_account_generation"], 1)
        self.assertEqual(payment["stripe_payment_method_id"], "pm_original")

    def test_stale_failed_payment_intent_does_not_regress_succeeded_payment(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "processed_at": "2026-04-28T00:00:00Z",
                "last_stripe_event_created": 200,
            }],
            "billing_invoices": [],
            "billing_disputes": [],
            "billing_payers": [],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "amount": 12900,
            "currency": "usd",
            "metadata": {"studio_id": "studio_1"},
            "last_payment_error": {"message": "Declined"},
        }, "acct_1", "payment_intent.payment_failed", event_created=100)

        self.assertEqual(service.supabase.tables["billing_payments"][0]["status"], "succeeded")
        self.assertEqual(service.supabase.tables["billing_payments"][0]["processed_at"], "2026-04-28T00:00:00Z")
        self.assertIsNone(service.supabase.tables["billing_payments"][0].get("failure_message"))

    def test_payment_intent_event_records_event_created_for_ordering(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payments": [],
            "billing_invoices": [],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
        })

        service.project_connect_event({
            "id": "evt_pi_1",
            "account": "acct_1",
            "created": 300,
            "type": "payment_intent.succeeded",
            "data": {"object": {
                "id": "pi_1",
                "status": "succeeded",
                "amount": 12900,
                "amount_received": 12900,
                "currency": "usd",
                "customer": "cus_1",
                "metadata": {
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                },
            }},
        })

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertEqual(payment["last_stripe_event_created"], 300)

    def test_stale_payment_intent_event_does_not_overwrite_newer_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "status": "open",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "currency": "usd",
                "last_stripe_event_created": 300,
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
            "id": "pi_1",
            "status": "succeeded",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "invoice": "in_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "payment_intent.succeeded", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["amount_paid_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 12900)
        self.assertEqual(invoice["last_stripe_event_created"], 300)

    def test_stale_payment_intent_event_with_dispute_does_not_refresh_newer_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "status": "paid",
                "amount_due_cents": 12900,
                "amount_paid_cents": 12900,
                "amount_remaining_cents": 0,
                "currency": "usd",
                "paid_at": "2026-05-18T00:00:00Z",
                "last_stripe_event_created": 300,
            }],
            "billing_payments": [],
            "billing_disputes": [{
                "id": "dispute_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "payment_id": None,
                "stripe_payment_intent_id": None,
                "status": "needs_response",
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "current",
                "balance_cents": 0,
            }],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "invoice": "in_1",
            "latest_charge": "ch_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "payment_intent.succeeded", event_created=200)

        invoice = service.supabase.tables["billing_invoices"][0]
        dispute = service.supabase.tables["billing_disputes"][0]
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 12900)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["last_stripe_event_created"], 300)
        self.assertIsNone(dispute["payment_id"])

    def test_newer_payment_intent_event_advances_invoice_watermark(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
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

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 12900,
            "amount_received": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "invoice": "in_1",
            "metadata": {"studio_id": "studio_1", "payer_id": "payer_1"},
        }, "acct_1", "payment_intent.succeeded", event_created=300)

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
        self.assertEqual(invoice["last_stripe_event_created"], 300)

    def test_payment_intent_without_invoice_id_does_not_match_open_invoice_by_customer_amount(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payments": [],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "status": "open",
                "amount_due_cents": 50,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 50,
                "currency": "usd",
                "application_fee_amount_cents": 0,
                "created_at": "2026-05-18T19:00:00Z",
            }],
            "billing_disputes": [],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1"}],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 50,
            "amount_received": 50,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "payment_method_types": ["card"],
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(service.supabase.tables["billing_payments"], [])
        self.assertEqual(invoice["status"], "open")
        self.assertIsNone(invoice.get("stripe_payment_intent_id"))
        self.assertEqual(invoice["application_fee_amount_cents"], 0)
        self.assertEqual(invoice["amount_paid_cents"], 0)

    def test_metadata_empty_payment_intent_derives_payer_from_connected_customer(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
            "billing_payments": [],
            "billing_invoices": [],
            "billing_disputes": [],
        })
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["studio_id"], "studio_1")
        self.assertEqual(payment["payer_id"], "payer_1")
        self.assertIsNone(payment["invoice_id"])
        self.assertEqual(payment["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(payment["application_fee_amount_cents"], 1)

    def test_unrelated_metadata_empty_payment_intent_is_ignored(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payers": [],
            "billing_payments": [],
            "billing_invoices": [],
            "billing_disputes": [],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "currency": "usd",
            "customer": "cus_unknown",
            "latest_charge": "ch_1",
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        self.assertEqual(service.supabase.tables["billing_payments"], [])

    def test_payment_intent_does_not_amount_match_ambiguous_open_invoices(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payments": [],
            "billing_invoices": [
                {
                    "id": "invoice_1",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                    "stripe_invoice_id": "in_1",
                    "stripe_account_id": "acct_1",
                    "stripe_customer_id": "cus_1",
                    "status": "open",
                    "amount_due_cents": 200,
                    "amount_paid_cents": 0,
                    "amount_remaining_cents": 200,
                    "currency": "usd",
                    "created_at": "2026-05-18T19:00:00Z",
                },
                {
                    "id": "invoice_2",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                    "stripe_invoice_id": "in_2",
                    "stripe_account_id": "acct_1",
                    "stripe_customer_id": "cus_1",
                    "status": "open",
                    "amount_due_cents": 200,
                    "amount_paid_cents": 0,
                    "amount_remaining_cents": 200,
                    "currency": "usd",
                    "created_at": "2026-05-18T20:00:00Z",
                },
            ],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
        })
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payment = service.supabase.tables["billing_payments"][0]
        self.assertIsNone(payment["invoice_id"])
        self.assertIsNone(payment["stripe_invoice_id"])
        self.assertIsNone(service.supabase.tables["billing_invoices"][0].get("stripe_payment_intent_id"))
        self.assertIsNone(service.supabase.tables["billing_invoices"][1].get("stripe_payment_intent_id"))

    def test_payment_intent_does_not_amount_match_historical_paid_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payments": [],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_payment_intent_id": None,
                "status": "paid",
                "amount_due_cents": 200,
                "amount_paid_cents": 200,
                "amount_remaining_cents": 0,
                "currency": "usd",
            }],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
            }],
        })
        service._recompute_payer_balance = lambda *_args: None

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertIsNone(payment["invoice_id"])
        self.assertIsNone(payment["stripe_invoice_id"])
        self.assertIsNone(invoice["stripe_payment_intent_id"])
        self.assertEqual(invoice["status"], "paid")
