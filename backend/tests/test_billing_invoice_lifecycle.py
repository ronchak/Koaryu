from __future__ import annotations

from tests.billing_lifecycle_helpers import (
    BillingInvoiceCreate,
    BillingInvoiceResponse,
    BillingPayerAutopaySetupRequest,
    BillingPaymentsLifecycleTestBase,
    BillingReconcileRequest,
    ExternalPaymentCreate,
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
from stripe import CardError as StripeCardError, IdempotencyError as StripeIdempotencyError
from app.services.billing_invoices import BillingInvoiceManager
from postgrest.exceptions import APIError as PostgrestAPIError


def _unique_conflict() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })

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

        with self.assertLogs("app.services.billing_invoices", level="ERROR") as captured_logs:
            with patch("app.services.billing_service.StripeService", _FakeStripeService):
                invoice = asyncio.run(service.finalize_invoice("invoice_1", "studio_1", "actor_1"))

        self.assertIn("Koaryu could not send the email", invoice.last_payment_error)
        self.assertRegex(invoice.last_payment_error, r"Reference: [0-9a-f]{32}$")
        self.assertNotIn("req_123", invoice.last_payment_error)
        self.assertNotIn("sk_live", invoice.last_payment_error)
        rendered_logs = "\n".join(captured_logs.output)
        self.assertIn("error_type=RuntimeError", rendered_logs)
        log_record = captured_logs.records[0]
        logged_reference = log_record.getMessage().split("reference=", 1)[1].split(";", 1)[0]
        self.assertEqual(invoice.last_payment_error.rsplit("Reference: ", 1)[1], logged_reference)
        self.assertIsNone(log_record.exc_info)
        self.assertNotIn("invoice_id", log_record.__dict__)
        self.assertNotIn("studio_id", log_record.__dict__)
        for sensitive_value in ("invoice_1", "studio_1", "actor_1", "req_123", "sk_live"):
            self.assertNotIn(sensitive_value, repr(log_record.__dict__))

    def test_retry_invoice_payment_requires_request_idempotency_key(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.retry_invoice_payment("invoice_1", "studio_1", "actor_1"))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("Idempotency-Key", context.exception.detail)
        self.assertEqual(_FakeStripeService.pay_invoice_calls, [])

    def test_retry_invoice_payment_reuses_stable_stripe_key_after_lost_response(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "invoice_type": "manual",
                "status": "open",
                "amount_due_cents": 123,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 123,
                "currency": "usd",
                "application_fee_amount_cents": 0,
                "external": False,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.pay_invoice_error_after_call = TimeoutError("response lost")

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1",
                    "studio_1",
                    "actor_1",
                    "client-operation-1",
                ))
            self.assertEqual(ambiguous.exception.status_code, 503)
            _FakeStripeService.pay_invoice_error_after_call = None
            invoice = asyncio.run(service.retry_invoice_payment(
                "invoice_1",
                "studio_1",
                "actor_1",
                "client-operation-1",
            ))

        self.assertEqual(invoice.id, "invoice_1")
        self.assertEqual(
            [call["idempotency_key"] for call in _FakeStripeService.pay_invoice_calls],
            [
                "koaryu:invoice-retry:studio_1:invoice_1:client-operation-1",
                "koaryu:invoice-retry:studio_1:invoice_1:client-operation-1",
            ],
        )
        self.assertEqual(len(service.supabase.tables["audit_logs"]), 1)

    def test_retry_invoice_payment_distinguishes_separate_client_operations(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "invoice_type": "manual",
                "status": "open",
                "amount_due_cents": 123,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 123,
                "currency": "usd",
                "application_fee_amount_cents": 0,
                "external": False,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "client-operation-1"
            ))
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "client-operation-2"
            ))

        keys = [call["idempotency_key"] for call in _FakeStripeService.pay_invoice_calls]
        self.assertEqual(len(keys), 2)
        self.assertNotEqual(keys[0], keys[1])

    def test_retry_invoice_payment_replay_does_not_duplicate_audit(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_1",
                "invoice_type": "manual",
                "status": "open",
                "amount_due_cents": 123,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 123,
                "currency": "usd",
                "application_fee_amount_cents": 0,
                "external": False,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "response-loss-operation"
            ))
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "response-loss-operation"
            ))

        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 1)
        self.assertEqual(len(service.supabase.tables["audit_logs"]), 1)
        self.assertEqual(
            service.supabase.tables["audit_logs"][0]["metadata"]["idempotency_key"],
            "response-loss-operation",
        )

    def test_retry_card_decline_is_safe_4xx_and_new_operation_can_retry(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.pay_invoice_error_after_call = StripeCardError(
            "sensitive Stripe decline detail",
            param=None,
            code="card_declined",
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as declined:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "declined-operation"
                ))
            _FakeStripeService.pay_invoice_error_after_call = None
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "corrected-operation"
            ))

        self.assertEqual(declined.exception.status_code, 402)
        self.assertNotIn("sensitive", declined.exception.detail)
        operations = service.supabase.tables["billing_invoice_retry_operations"]
        self.assertEqual([row["status"] for row in operations], ["failed_definitive", "succeeded"])
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 2)

    def test_new_client_key_reconciles_and_resumes_active_server_operation(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.pay_invoice_error_after_call = TimeoutError("response lost")

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "blocked-storage-key-1"
                ))
            self.assertEqual(ambiguous.exception.status_code, 503)
            _FakeStripeService.pay_invoice_error_after_call = None
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "blocked-storage-key-2"
            ))
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "blocked-storage-key-2"
            ))

        keys = [call["idempotency_key"] for call in _FakeStripeService.pay_invoice_calls]
        self.assertEqual(keys, [keys[0], keys[0]])
        operations = service.supabase.tables["billing_invoice_retry_operations"]
        self.assertEqual(len(operations), 1)
        self.assertEqual(operations[0]["client_idempotency_key"], "blocked-storage-key-1")
        self.assertEqual(operations[0]["status"], "succeeded")
        aliases = service.supabase.tables["billing_invoice_retry_operation_aliases"]
        self.assertEqual(len(aliases), 1)
        self.assertEqual(aliases[0]["client_idempotency_key"], "blocked-storage-key-2")

    def test_expired_ambiguous_operation_reconciles_before_allowing_new_payment(self):
        service = self.service()
        old = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        recent = datetime.now(timezone.utc).isoformat()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "billing_invoice_retry_operations": [{
                "id": "operation_1", "studio_id": "studio_1", "invoice_id": "invoice_1",
                "client_idempotency_key": "expired-key", "stripe_idempotency_key": "stripe-expired-key",
                "status": "reconciliation_required", "processing_started_at": recent,
                "lease_token": None, "lease_expires_at": old,
                "created_at": old, "updated_at": old,
            }],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as expired:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "new-key-before-reconcile"
                ))
            self.assertEqual(_FakeStripeService.pay_invoice_calls, [])
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "new-key-after-reconcile"
            ))

        self.assertEqual(expired.exception.status_code, 409)
        self.assertIn("Stripe retry window expired", expired.exception.detail)
        operations = service.supabase.tables["billing_invoice_retry_operations"]
        self.assertEqual([row["status"] for row in operations], ["failed_definitive", "succeeded"])

    def test_fresh_operation_lease_blocks_concurrent_reconciliation_and_records_aliases(self):
        service = self.service()
        now = datetime.now(timezone.utc)
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "billing_invoice_retry_operations": [{
                "id": "operation_1", "studio_id": "studio_1", "invoice_id": "invoice_1",
                "client_idempotency_key": "owner-key", "stripe_idempotency_key": "stripe-owner-key",
                "status": "processing", "processing_started_at": now.isoformat(),
                "lease_token": "owner-token",
                "lease_expires_at": (now + timedelta(seconds=30)).isoformat(),
                "created_at": (now - timedelta(minutes=1)).isoformat(), "updated_at": now.isoformat(),
            }],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            for contender in ("contender-key-1", "contender-key-2"):
                with self.assertRaises(HTTPException) as ambiguous:
                    asyncio.run(service.retry_invoice_payment(
                        "invoice_1", "studio_1", "actor_1", contender
                    ))
                self.assertEqual(ambiguous.exception.status_code, 503)

        self.assertEqual(_FakeStripeService.pay_invoice_calls, [])
        aliases = service.supabase.tables["billing_invoice_retry_operation_aliases"]
        self.assertEqual(
            {row["client_idempotency_key"] for row in aliases},
            {"contender-key-1", "contender-key-2"},
        )

    def test_expired_operation_lease_compare_and_swap_allows_only_one_winner(self):
        service = self.service()
        old = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        operation = {
            "id": "operation_1", "studio_id": "studio_1", "invoice_id": "invoice_1",
            "client_idempotency_key": "owner-key", "stripe_idempotency_key": "stripe-owner-key",
            "status": "reconciliation_required", "processing_started_at": old,
            "lease_token": None, "lease_expires_at": old,
            "created_at": old, "updated_at": old,
        }
        service.supabase = _FakeSupabase({
            "billing_invoice_retry_operations": [operation],
        })
        manager = BillingInvoiceManager(service, stripe_service_cls=_FakeStripeService)

        winner = manager._acquire_invoice_retry_operation_lease(operation)
        with self.assertRaises(HTTPException) as loser:
            manager._acquire_invoice_retry_operation_lease(operation)

        self.assertTrue(winner["lease_token"])
        self.assertEqual(loser.exception.status_code, 503)

    def test_stripe_concurrency_idempotency_error_remains_ambiguous_and_active(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.pay_invoice_error_after_call = StripeIdempotencyError(
            "another request with the same key is executing"
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "concurrent-stripe-key"
                ))

        self.assertEqual(ambiguous.exception.status_code, 503)
        operation = service.supabase.tables["billing_invoice_retry_operations"][0]
        self.assertEqual(operation["status"], "reconciliation_required")
        self.assertIsNone(operation["lease_token"])

    def test_nonterminal_stripe_response_keeps_operation_active_and_guards_new_retry(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.invoice_response = {
            "id": "in_1", "status": "open", "amount_due": 123, "amount_paid": 0,
            "amount_remaining": 123, "currency": "usd", "customer": "cus_1",
            "payment_intent": {"id": "pi_1", "status": "processing"},
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
            "created": 200,
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as first:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "processing-key"
                ))
            with self.assertRaises(HTTPException) as adopted:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "new-key-while-processing"
                ))

        self.assertEqual(first.exception.status_code, 503)
        self.assertEqual(adopted.exception.status_code, 503)
        operations = service.supabase.tables["billing_invoice_retry_operations"]
        self.assertEqual(len(operations), 1)
        self.assertEqual(operations[0]["status"], "reconciliation_required")
        self.assertEqual(service.supabase.tables["audit_logs"], [])
        self.assertEqual(
            service.supabase.tables["billing_invoice_retry_operation_aliases"][0]["client_idempotency_key"],
            "new-key-while-processing",
        )

    def test_initial_claim_race_persists_adopter_alias_before_returning(self):
        service = self.service()
        now = datetime.now(timezone.utc)
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z",
            }],
            "billing_invoice_retry_operations": [],
            "audit_logs": [],
        })
        service.supabase.unique_constraints["billing_invoice_retry_operations"] = [("studio_id", "invoice_id")]
        service.supabase.unique_conflict_error_factory = lambda _table, _columns: _unique_conflict()

        def insert_competing_claim(table, _payloads, rows):
            if table != "billing_invoice_retry_operations":
                return
            service.supabase.before_insert = None
            rows.append({
                "id": "winning-operation", "studio_id": "studio_1", "invoice_id": "invoice_1",
                "client_idempotency_key": "winning-key", "stripe_idempotency_key": "stripe-winning-key",
                "status": "processing", "lease_token": "winning-lease",
                "lease_expires_at": (now + timedelta(seconds=30)).isoformat(),
                "processing_started_at": now.isoformat(), "created_at": now.isoformat(),
                "updated_at": now.isoformat(),
            })

        service.supabase.before_insert = insert_competing_claim
        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as racing_response:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "adopter-key"
                ))

            winning = service.supabase.tables["billing_invoice_retry_operations"][0]
            winning["status"] = "succeeded"
            winning["lease_token"] = None
            winning["lease_expires_at"] = now.isoformat()
            invoice = service.supabase.tables["billing_invoices"][0]
            invoice.update({"status": "paid", "amount_paid_cents": 123, "amount_remaining_cents": 0})
            replay = asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "adopter-key"
            ))

        self.assertEqual(racing_response.exception.status_code, 503)
        self.assertEqual(replay.status, "paid")
        self.assertEqual(_FakeStripeService.pay_invoice_calls, [])
        aliases = service.supabase.tables["billing_invoice_retry_operation_aliases"]
        self.assertEqual(len(aliases), 1)
        self.assertEqual(aliases[0]["operation_id"], "winning-operation")
        self.assertEqual(aliases[0]["client_idempotency_key"], "adopter-key")

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

    def test_paid_in_full_enrollment_uses_invoice_idempotency_path(self):
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
            "students": [{"id": "student_1", "studio_id": "studio_1"}],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Test Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_plans": [{
                "id": "plan_1",
                "studio_id": "studio_1",
                "name": "Summer Camp",
                "amount_cents": 25000,
                "signup_fee_cents": 5000,
                "currency": "usd",
                "billing_interval": "paid_in_full",
                "stripe_price_id": "price_1",
            }],
            "student_billing_enrollments": [],
            "billing_invoices": [],
            "billing_invoice_items": [],
            "audit_logs": [],
        })
        service.supabase.insert_defaults["student_billing_enrollments"] = {
            "billing_subscription_id": None,
            "stripe_subscription_id": None,
            "stripe_subscription_item_id": None,
            "billing_status": "no_payment_method",
            "status": "pending",
            "start_date": "2026-05-01",
            "end_date": None,
            "next_bill_on": None,
            "metadata": {},
            "created_at": "2026-05-01T00:00:00Z",
            "updated_at": "2026-05-01T00:00:00Z",
        }
        service.supabase.insert_defaults["billing_invoices"] = {
            "created_at": "2026-05-01T00:00:00Z",
            "updated_at": "2026-05-01T00:00:00Z",
            "external": False,
        }
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.invoice_response = {
            "id": "in_created",
            "status": "open",
            "amount_due": 30000,
            "amount_paid": 0,
            "amount_remaining": 30000,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "billing_invoices_1"},
            "created": 200,
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            enrollment = asyncio.run(service.add_student_billing_enrollment(
                StudentBillingEnrollmentCreate(
                    student_id="student_1",
                    billing_plan_id="plan_1",
                    payer_id="payer_1",
                    collection_mode="invoice_link",
                ),
                "studio_1",
                "actor_1",
            ))

        self.assertEqual(enrollment.billing_status, "upcoming")
        self.assertEqual(len(service.supabase.tables["billing_invoices"]), 1)
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(invoice["invoice_type"], "paid_in_full")
        self.assertEqual(invoice["idempotency_key"], "koaryu:paid-in-full:student_billing_enrollments_1")
        self.assertIsNotNone(invoice["request_hash"])
        self.assertEqual(len(service.supabase.tables["billing_invoice_items"]), 1)
        self.assertEqual(
            _FakeStripeService.connected_invoice_calls[0]["idempotency_key"],
            "koaryu:invoice:billing_invoices_1",
        )
        self.assertEqual(
            _FakeStripeService.connected_invoice_item_calls[0]["idempotency_key"],
            "koaryu:invoice-item:billing_invoices_1:0",
        )

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

    def test_create_invoice_rejects_cross_studio_item_refs_before_claiming_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Test Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "students": [{
                "id": "student_other",
                "studio_id": "studio_2",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_other",
                "studio_id": "studio_2",
                "student_id": "student_other",
                "billing_plan_id": "plan_other",
            }],
            "billing_plans": [{
                "id": "plan_other",
                "studio_id": "studio_2",
            }],
            "billing_invoices": [],
            "billing_invoice_items": [],
        })

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_invoice(
                BillingInvoiceCreate(
                    payer_id="payer_1",
                    items=[{
                        "description": "Cross-studio tuition",
                        "amount_cents": 1000,
                        "enrollment_id": "enrollment_other",
                        "billing_plan_id": "plan_other",
                    }],
                ),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(context.exception.status_code, 404)
        self.assertIn("Invoice item enrollment not found", context.exception.detail)
        self.assertEqual(service.supabase.tables["billing_invoices"], [])

    def test_create_invoice_rejects_item_enrollment_mismatches_before_claiming_invoice(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Test Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "students": [
                {"id": "student_1", "studio_id": "studio_1"},
                {"id": "student_2", "studio_id": "studio_1"},
            ],
            "student_billing_enrollments": [{
                "id": "enrollment_2",
                "studio_id": "studio_1",
                "student_id": "student_2",
                "billing_plan_id": "plan_2",
            }],
            "billing_plans": [
                {"id": "plan_1", "studio_id": "studio_1"},
                {"id": "plan_2", "studio_id": "studio_1"},
            ],
            "billing_invoices": [],
            "billing_invoice_items": [],
        })

        for item, detail in (
            (
                {
                    "description": "Mismatched student",
                    "amount_cents": 1000,
                    "student_id": "student_1",
                    "enrollment_id": "enrollment_2",
                },
                "different student",
            ),
            (
                {
                    "description": "Mismatched plan",
                    "amount_cents": 1000,
                    "enrollment_id": "enrollment_2",
                    "billing_plan_id": "plan_1",
                },
                "different billing plan",
            ),
        ):
            with self.subTest(detail=detail):
                with self.assertRaises(HTTPException) as context:
                    asyncio.run(service.create_invoice(
                        BillingInvoiceCreate(payer_id="payer_1", items=[item]),
                        "studio_1",
                        "user_1",
                    ))

                self.assertEqual(context.exception.status_code, 409)
                self.assertIn(detail, context.exception.detail)
                self.assertEqual(service.supabase.tables["billing_invoices"], [])

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

    def test_external_payment_rejects_invoice_overpayment(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "status": "open",
                "amount_due_cents": 200,
                "amount_paid_cents": 50,
                "amount_remaining_cents": 150,
                "currency": "usd",
                "external": False,
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "billing_status": "past_due",
                "balance_cents": 150,
            }],
            "billing_payments": [],
            "audit_logs": [],
        })

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.record_external_payment(
                ExternalPaymentCreate(
                    invoice_id="invoice_1",
                    amount_cents=151,
                    external_method="cash",
                ),
                "studio_1",
                "actor_1",
                idempotency_key="external-overpay",
            ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("remaining balance", context.exception.detail)
        self.assertEqual(service.supabase.tables["billing_payments"], [])
