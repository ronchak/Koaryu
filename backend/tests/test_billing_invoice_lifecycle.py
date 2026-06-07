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

class BillingInvoiceLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_interval_mapping_for_stripe_prices(self):
        service = self.service()

        self.assertEqual(service._stripe_recurring_for_interval("monthly"), ({"interval": "month", "interval_count": 1}, 1))
        self.assertEqual(service._stripe_recurring_for_interval("biweekly"), ({"interval": "week", "interval_count": 2}, 2))
        self.assertEqual(service._stripe_recurring_for_interval("annual"), ({"interval": "year", "interval_count": 1}, 1))
        self.assertEqual(service._stripe_recurring_for_interval("paid_in_full"), (None, 1))

    def test_application_fee_percent_and_amount_use_platform_bps(self):
        service = self.service()
        account = {"platform_fee_bps": 50}

        self.assertEqual(service._application_fee_percent(account), 0.5)
        self.assertEqual(service._application_fee_amount(12900, account), 64)

    def test_out_of_band_paid_invoice_projects_external_totals_without_fee(self):
        service = self.service()

        projection = service._invoice_projection({
            "id": "in_123",
            "status": "paid",
            "paid_out_of_band": True,
            "amount_due": 234,
            "amount_paid": 0,
            "amount_remaining": 234,
            "currency": "usd",
            "application_fee_amount": 1,
        }, "acct_123")

        self.assertEqual(projection["status"], "paid")
        self.assertEqual(projection["amount_paid_cents"], 234)
        self.assertEqual(projection["amount_remaining_cents"], 0)
        self.assertEqual(projection["application_fee_amount_cents"], 0)

    def test_invoice_projection_does_not_clear_missing_application_fee(self):
        service = self.service()

        projection = service._invoice_projection({
            "id": "in_123",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "application_fee_amount": None,
        }, "acct_123")

        self.assertNotIn("application_fee_amount_cents", projection)

    def test_non_card_payment_method_summary_uses_method_type(self):
        service = self.service()

        fields = service._payment_method_fields_from_payment_method({
            "id": "pm_link",
            "type": "link",
        })

        self.assertEqual(fields["default_payment_method_id"], "pm_link")
        self.assertEqual(fields["default_payment_method_brand"], "link")
        self.assertIsNone(fields["default_payment_method_last4"])

    def test_frontend_enrollment_payload_aliases_are_accepted(self):
        payload = StudentBillingEnrollmentCreate.model_validate({
            "student_id": "student_1",
            "payer_id": "payer_1",
            "plan_id": "plan_1",
            "collection_mode": "invoice_link",
            "start_date": "2026-04-28",
            "next_bill_date": "2026-05-01",
        })

        self.assertEqual(payload.billing_plan_id, "plan_1")
        self.assertEqual(payload.next_bill_on, "2026-05-01")

    def test_enrollment_response_exposes_frontend_aliases(self):
        response = StudentBillingEnrollmentResponse.model_validate({
            "id": "enrollment_1",
            "studio_id": "studio_1",
            "student_id": "student_1",
            "payer_id": "payer_1",
            "billing_plan_id": "plan_1",
            "billing_subscription_id": "billing_sub_1",
            "collection_mode": "autopay",
            "status": "active",
            "billing_status": "current",
            "start_date": "2026-04-28",
            "next_bill_on": "2026-05-01",
            "created_at": "2026-04-28T00:00:00Z",
            "updated_at": "2026-04-28T00:00:00Z",
        })

        self.assertEqual(response.plan_id, "plan_1")
        self.assertEqual(response.subscription_id, "billing_sub_1")
        self.assertEqual(response.next_bill_date, "2026-05-01")

    def test_invoice_response_exposes_stripe_number_alias(self):
        response = BillingInvoiceResponse.model_validate({
            "id": "invoice_1",
            "studio_id": "studio_1",
            "invoice_number": "INV-001",
            "invoice_type": "tuition",
            "status": "open",
            "amount_due_cents": 12900,
            "amount_paid_cents": 0,
            "currency": "usd",
            "external": False,
            "created_at": "2026-04-28T00:00:00Z",
            "updated_at": "2026-04-28T00:00:00Z",
        })

        self.assertEqual(response.number, "INV-001")

    def test_invoice_response_redacts_legacy_external_stripe_sync_errors(self):
        response = BillingInvoiceResponse.model_validate({
            "id": "invoice_1",
            "studio_id": "studio_1",
            "invoice_type": "tuition",
            "status": "open",
            "amount_due_cents": 12900,
            "amount_paid_cents": 0,
            "currency": "usd",
            "last_payment_error": (
                "External payment recorded locally but Stripe sync failed: sk_live leaked value"
            ),
            "external": False,
            "created_at": "2026-04-28T00:00:00Z",
            "updated_at": "2026-04-28T00:00:00Z",
        })

        self.assertEqual(
            response.last_payment_error,
            "Stripe sync failed after local payment recording. Contact support if it persists.",
        )
        self.assertNotIn("sk_live", response.last_payment_error)

    def test_invoice_request_hash_is_stable_for_equivalent_payloads(self):
        service = self.service()

        first = BillingInvoiceCreate(payer_id="payer_1", amount_cents=12900, description="May tuition")
        second = BillingInvoiceCreate.model_validate({
            "description": "May tuition",
            "amount_cents": 12900,
            "payer_id": "payer_1",
        })

        self.assertEqual(service._invoice_request_hash(first), service._invoice_request_hash(second))

    def test_finalize_invoice_sanitizes_hosted_invoice_send_failures(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "invoice_type": "manual",
                "status": "draft",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "currency": "usd",
                "application_fee_amount_cents": 64,
                "external": False,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.send_invoice_error = RuntimeError(
            "Stripe request req_123 with sk_live secret detail"
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            invoice = asyncio.run(service.finalize_invoice("invoice_1", "studio_1", "actor_1"))

        self.assertIn("Koaryu could not send the email", invoice.last_payment_error)
        self.assertRegex(invoice.last_payment_error, r"Reference: [0-9a-f]{32}$")
        self.assertNotIn("req_123", invoice.last_payment_error)
        self.assertNotIn("sk_live", invoice.last_payment_error)

    def test_create_invoice_reuses_matching_idempotency_key(self):
        service = self.service()
        data = BillingInvoiceCreate(
            payer_id="payer_1",
            collection_mode="invoice_link",
            amount_cents=12900,
            description="May tuition",
        )
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Test Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "idempotency_key": "invoice-key",
                "request_hash": _test_invoice_request_hash(data),
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "invoice_type": "manual",
                "status": "draft",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "currency": "usd",
                "application_fee_amount_cents": 64,
                "external": False,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "billing_invoice_items": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            invoice = asyncio.run(service.create_invoice(data, "studio_1", "user_1", idempotency_key="invoice-key"))

        self.assertEqual(invoice.id, "invoice_1")
        self.assertEqual(len(service.supabase.tables["billing_invoices"]), 1)

    def test_create_invoice_rejects_reused_key_for_different_payload(self):
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
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Test Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "idempotency_key": "invoice-key",
                "request_hash": "original-hash",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "invoice_type": "manual",
                "status": "draft",
                "amount_due_cents": 12900,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 12900,
                "currency": "usd",
                "application_fee_amount_cents": 64,
                "external": False,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "billing_invoice_items": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as exc:
                asyncio.run(service.create_invoice(
                    BillingInvoiceCreate(payer_id="payer_1", amount_cents=8900, description="Changed tuition"),
                    "studio_1",
                    "user_1",
                    idempotency_key="invoice-key",
                ))

        self.assertEqual(exc.exception.status_code, 409)

    def test_late_payment_intent_links_existing_dispute_and_marks_payment_disputed(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_disputes": [{
                "id": "dispute_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "payment_id": None,
                "stripe_payment_intent_id": None,
                "status": "needs_response",
            }],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
            }],
        })

        payment = service._link_disputes_to_payment({
            "id": "payment_1",
            "studio_id": "studio_1",
            "stripe_account_id": "acct_1",
            "stripe_charge_id": "ch_1",
            "stripe_payment_intent_id": "pi_1",
            "status": "succeeded",
        }, "acct_1")

        dispute = service.supabase.tables["billing_disputes"][0]
        stored_payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "disputed")
        self.assertEqual(stored_payment["status"], "disputed")
        self.assertEqual(dispute["payment_id"], "payment_1")
        self.assertEqual(dispute["stripe_payment_intent_id"], "pi_1")

    def test_late_payment_intent_dispute_link_does_not_re_mark_invoice_paid(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_disputes": [{
                "id": "dispute_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "payment_id": None,
                "stripe_payment_intent_id": None,
                "status": "needs_response",
            }],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "amount_cents": 200,
                "refunded_amount_cents": 0,
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "paid",
                "amount_due_cents": 200,
                "amount_paid_cents": 200,
                "amount_remaining_cents": 0,
                "currency": "usd",
                "paid_at": "2026-05-18T00:00:00Z",
                "application_fee_amount_cents": 0,
                "external": False,
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
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "invoice": "in_1",
            "latest_charge": "ch_1",
            "payment_method_types": ["card"],
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payment["status"], "disputed")
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["amount_paid_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 200)
        self.assertIsNone(invoice["paid_at"])
        self.assertEqual(payer["balance_cents"], 200)
        self.assertEqual(payer["billing_status"], "past_due")

    def test_refund_projection_updates_invoice_and_payer_balance(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_refunds": [],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "amount_cents": 200,
                "refunded_amount_cents": 0,
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "paid",
                "amount_due_cents": 200,
                "amount_paid_cents": 200,
                "amount_remaining_cents": 0,
                "paid_at": "2026-05-18T00:00:00Z",
                "external": False,
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "current",
                "balance_cents": 0,
            }],
        })

        service._project_refund({
            "id": "re_1",
            "charge": "ch_1",
            "payment_intent": "pi_1",
            "amount": 50,
            "status": "succeeded",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1")

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payment["refunded_amount_cents"], 50)
        self.assertEqual(payment["status"], "succeeded")
        self.assertEqual(invoice["status"], "partially_refunded")
        self.assertEqual(invoice["amount_paid_cents"], 150)
        self.assertEqual(invoice["amount_remaining_cents"], 50)
        self.assertIsNone(invoice["paid_at"])
        self.assertEqual(payer["balance_cents"], 50)
        self.assertEqual(payer["billing_status"], "past_due")

    def test_full_refund_projection_closes_invoice_without_reopened_balance(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_refunds": [],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "amount_cents": 200,
                "refunded_amount_cents": 0,
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "paid",
                "amount_due_cents": 200,
                "amount_paid_cents": 200,
                "amount_remaining_cents": 0,
                "paid_at": "2026-05-18T00:00:00Z",
                "external": False,
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "current",
                "balance_cents": 0,
            }],
        })

        service._project_refund({
            "id": "re_1",
            "charge": "ch_1",
            "payment_intent": "pi_1",
            "amount": 200,
            "status": "succeeded",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1")

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payment["status"], "refunded")
        self.assertEqual(payment["refunded_amount_cents"], 200)
        self.assertEqual(invoice["status"], "refunded")
        self.assertEqual(invoice["amount_paid_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertIsNone(invoice["paid_at"])
        self.assertEqual(payer["balance_cents"], 0)
        self.assertEqual(payer["billing_status"], "current")

    def test_dispute_projection_updates_invoice_and_payer_balance(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_disputes": [],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "amount_cents": 200,
                "refunded_amount_cents": 0,
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "paid",
                "amount_due_cents": 200,
                "amount_paid_cents": 200,
                "amount_remaining_cents": 0,
                "paid_at": "2026-05-18T00:00:00Z",
                "external": False,
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "current",
                "balance_cents": 0,
            }],
        })

        service._project_dispute({
            "id": "dp_1",
            "charge": "ch_1",
            "amount": 200,
            "status": "needs_response",
            "reason": "fraudulent",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1")

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payment["status"], "disputed")
        self.assertEqual(invoice["status"], "open")
        self.assertEqual(invoice["amount_paid_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 200)
        self.assertIsNone(invoice["paid_at"])
        self.assertEqual(payer["balance_cents"], 200)
        self.assertEqual(payer["billing_status"], "past_due")
