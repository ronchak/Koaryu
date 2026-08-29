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
from app.services.billing_payment_projection import BillingPaymentEventProjector
from app.services.billing_provider_operations import (
    BillingProviderOperationContext,
    BillingProviderOperationCoordinator,
)
from app.services.platform_billing_helpers import stable_hash
from postgrest.exceptions import APIError as PostgrestAPIError


def _unique_conflict() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })


def _settled_payment_tables() -> dict[str, list[dict]]:
    return {
        "billing_refunds": [],
        "billing_disputes": [],
        "billing_payments": [{
            "id": "payment_1", "studio_id": "studio_1", "payer_id": "payer_1",
            "invoice_id": "invoice_1", "stripe_account_id": "acct_1",
            "connect_account_generation": 1,
            "stripe_charge_id": "ch_1", "stripe_payment_intent_id": "pi_1",
            "status": "succeeded", "amount_cents": 200, "refunded_amount_cents": 0,
            "disputed_amount_cents": 0, "net_collected_amount_cents": 200,
            "refundable_amount_cents": 200,
        }],
        "billing_invoices": [{
            "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
            "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
            "stripe_payment_intent_id": "pi_1", "status": "paid",
            "amount_due_cents": 200, "amount_paid_cents": 200,
            "amount_remaining_cents": 0, "currency": "usd",
            "paid_at": "2026-05-18T00:00:00Z", "application_fee_amount_cents": 0,
            "external": False,
        }],
        "billing_payers": [{
            "id": "payer_1", "studio_id": "studio_1", "billing_status": "current",
            "balance_cents": 0,
        }],
        "studio_payment_accounts": [{
            "studio_id": "studio_1", "stripe_connected_account_id": "acct_1",
            "metadata": {"connect_account_generation": 1},
        }],
    }


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
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "charges_enabled": True,
                "status": "charges_enabled",
                "metadata": {"connect_account_generation": 2},
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Finalize payer",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "connect_account_generation": 2,
            }],
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
                "collection_method": "send_invoice",
                "application_fee_amount_cents": 64,
                "external": False,
                "metadata": {"connect_account_generation": 2},
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.invoice_response = {
            "id": "in_1",
            "status": "draft",
            "collection_method": "send_invoice",
            "amount_due": 12900,
            "amount_paid": 0,
            "amount_remaining": 12900,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "invoice_id": "invoice_1",
            },
        }
        _FakeStripeService.send_invoice_error = RuntimeError(
            "Stripe request req_123 with sk_live secret detail"
        )

        with self.assertLogs("app.services.billing_invoices", level="ERROR") as captured_logs:
            with patch("app.services.billing_service.StripeService", _FakeStripeService):
                with self.assertRaises(HTTPException) as ambiguous:
                    asyncio.run(service.finalize_invoice(
                        "invoice_1", "studio_1", "actor_1", "finalize-send-key"
                    ))

        self.assertEqual(ambiguous.exception.status_code, 503)
        self.assertRegex(ambiguous.exception.detail, r"Reference: [0-9a-f]{32}$")
        self.assertNotIn("req_123", ambiguous.exception.detail)
        self.assertNotIn("sk_live", ambiguous.exception.detail)
        rendered_logs = "\n".join(captured_logs.output)
        self.assertIn("error_type=RuntimeError", rendered_logs)
        log_record = captured_logs.records[0]
        logged_reference = log_record.getMessage().split("reference=", 1)[1].split(";", 1)[0]
        self.assertEqual(
            ambiguous.exception.detail.rsplit("Reference: ", 1)[1],
            logged_reference,
        )
        self.assertIsNone(log_record.exc_info)
        self.assertNotIn("invoice_id", log_record.__dict__)
        self.assertNotIn("studio_id", log_record.__dict__)
        for sensitive_value in ("invoice_1", "studio_1", "actor_1", "req_123", "sk_live"):
            self.assertNotIn(sensitive_value, repr(log_record.__dict__))
        operation = next(iter(service.supabase.billing_provider_operations.values()))
        self.assertEqual(operation["state"], "reconciliation_required")
        self.assertEqual(len(_FakeStripeService.finalize_invoice_calls), 1)
        self.assertEqual(len(_FakeStripeService.send_invoice_calls), 1)

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

    @staticmethod
    def _retry_operation_tables():
        return {
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1", "invoice_type": "manual",
                "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123,
                "currency": "usd", "application_fee_amount_cents": 0,
                "external": False, "metadata": {"connect_account_generation": 1},
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "audit_logs": [],
        }

    @staticmethod
    def _retry_parent(service, request_key):
        return service.supabase.billing_provider_operations[
            ("studio_1", "invoice.retry", request_key)
        ]

    def test_retry_invoice_payment_reuses_stable_stripe_key_after_lost_response(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        _FakeStripeService.invoice_response = {
            "id": "in_1", "status": "paid", "amount_due": 123,
            "amount_paid": 123, "amount_remaining": 0, "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
        }
        _FakeStripeService.pay_invoice_error_after_call = TimeoutError(
            "sensitive provider timeout"
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "client-operation-1"
                ))
            _FakeStripeService.pay_invoice_error_after_call = None
            invoice = asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "client-operation-1"
            ))

        self.assertEqual(ambiguous.exception.status_code, 503)
        self.assertNotIn("sensitive", ambiguous.exception.detail)
        self.assertEqual(invoice.status, "paid")
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 1)
        parent = self._retry_parent(service, "client-operation-1")
        self.assertEqual(parent["state"], "completed")
        self.assertEqual(parent["provider_request_attempt_count"], 1)
        self.assertEqual(parent["provider_object_id"], "in_1")
    def test_retry_invoice_payment_adopts_completed_parent_for_a_new_client_key(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "client-operation-1"
            ))
            replay = asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "client-operation-2"
            ))

        self.assertEqual(replay.status, "paid")
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 1)
        canonical = self._retry_parent(service, "client-operation-1")
        self.assertEqual(canonical["state"], "completed")
        self.assertEqual(
            service.supabase.billing_provider_operation_aliases[
                ("studio_1", "invoice.retry", "client-operation-2")
            ],
            canonical["id"],
        )
    def test_retry_invoice_payment_replay_does_not_duplicate_audit(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())

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
            service.supabase.tables["audit_logs"][0]["metadata"]["operation_id"],
            self._retry_parent(service, "response-loss-operation")["id"],
        )
    def test_retry_card_decline_is_safe_4xx_and_new_operation_can_retry(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
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
            paid = asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "corrected-operation"
            ))

        self.assertEqual(declined.exception.status_code, 402)
        self.assertNotIn("sensitive", declined.exception.detail)
        self.assertEqual(paid.status, "paid")
        self.assertEqual(
            self._retry_parent(service, "declined-operation")["state"],
            "definitive_rejected",
        )
        self.assertEqual(
            self._retry_parent(service, "corrected-operation")["state"],
            "completed",
        )
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 2)
    def test_new_client_key_reconciles_and_resumes_active_server_operation(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        _FakeStripeService.invoice_response = {
            "id": "in_1", "status": "paid", "amount_due": 123,
            "amount_paid": 123, "amount_remaining": 0, "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
        }
        _FakeStripeService.pay_invoice_error_after_call = TimeoutError("response lost")

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "blocked-storage-key-1"
                ))
            _FakeStripeService.pay_invoice_error_after_call = None
            paid = asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "blocked-storage-key-2"
            ))
            replay = asyncio.run(service.retry_invoice_payment(
                "invoice_1", "studio_1", "actor_1", "blocked-storage-key-2"
            ))

        self.assertEqual(ambiguous.exception.status_code, 503)
        self.assertEqual(paid.status, replay.status, "paid")
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 1)
        canonical = self._retry_parent(service, "blocked-storage-key-1")
        alias_operation_id = service.supabase.billing_provider_operation_aliases[
            ("studio_1", "invoice.retry", "blocked-storage-key-2")
        ]
        self.assertEqual(alias_operation_id, canonical["id"])
        self.assertEqual(canonical["state"], "completed")
        self.assertEqual(len(service.supabase.billing_provider_operation_resources), 1)
    def test_aged_ambiguous_operation_never_auto_expires_or_pays_again(self):
        service = self.service()
        old = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        recent = datetime.now(timezone.utc).isoformat()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
                "status": "charges_enabled",
                "charges_enabled": True,
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_invoices": [{
                "id": "invoice_1", "studio_id": "studio_1", "payer_id": "payer_1",
                "stripe_invoice_id": "in_1", "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "invoice_type": "manual", "status": "open", "amount_due_cents": 123,
                "amount_paid_cents": 0, "amount_remaining_cents": 123, "currency": "usd",
                "application_fee_amount_cents": 0, "external": False,
                "metadata": {"connect_account_generation": 1},
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
        request_hash = stable_hash({
            "operation_type": "invoice.retry",
            "studio_id": "studio_1",
            "invoice_id": "invoice_1",
            "stripe_invoice_id": "in_1",
            "stripe_connected_account_id": "acct_1",
            "connect_account_generation": 1,
        })
        operations = BillingProviderOperationCoordinator(service.supabase)
        claimed = operations.claim_resource(
            studio_id="studio_1", actor_id="actor_1",
            operation_type="invoice.retry", resource_type="invoice",
            resource_id="invoice_1", payer_id="payer_1",
            caller_request_key="expired-key",
            request_sha256=request_hash, stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        operation = claimed["operation"]
        context = BillingProviderOperationContext(
            operation_id=operation["id"], studio_id="studio_1",
            actor_id=operation["actor_id"], operation_type="invoice.retry",
            caller_request_key=operation["caller_request_key"],
            request_sha256=request_hash, stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        operation = operations.transition(
            context, operation, "provider_request_in_flight"
        )
        operations.transition(
            context, operation, "reconciliation_required",
            reconciliation_reason_code="invoice_retry_provider_outcome_ambiguous",
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as expired:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "new-key-before-reconcile"
                ))
            self.assertEqual(_FakeStripeService.pay_invoice_calls, [])
            with self.assertRaises(HTTPException) as still_blocked:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "new-key-after-reconcile"
                ))

        self.assertEqual(expired.exception.status_code, 409)
        self.assertEqual(still_blocked.exception.status_code, 409)
        self.assertEqual(_FakeStripeService.pay_invoice_calls, [])
        canonical = self._retry_parent(service, "expired-key")
        self.assertEqual(canonical["state"], "reconciliation_required")
        for alias in ("new-key-before-reconcile", "new-key-after-reconcile"):
            self.assertEqual(
                service.supabase.billing_provider_operation_aliases[
                    ("studio_1", "invoice.retry", alias)
                ],
                canonical["id"],
            )

    def test_fresh_operation_lease_blocks_concurrent_reconciliation_and_records_aliases(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        request_hash = stable_hash({
            "operation_type": "invoice.retry",
            "studio_id": "studio_1",
            "invoice_id": "invoice_1",
            "stripe_invoice_id": "in_1",
            "stripe_connected_account_id": "acct_1",
            "connect_account_generation": 1,
        })
        operations = BillingProviderOperationCoordinator(service.supabase)
        claimed = operations.claim_resource(
            studio_id="studio_1",
            actor_id="actor_1",
            operation_type="invoice.retry",
            resource_type="invoice",
            resource_id="invoice_1",
            payer_id="payer_1",
            caller_request_key="owner-key",
            request_sha256=request_hash,
            stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        canonical = claimed["operation"]
        context = BillingProviderOperationContext(
            operation_id=canonical["id"],
            studio_id="studio_1",
            actor_id=canonical["actor_id"],
            operation_type="invoice.retry",
            caller_request_key=canonical["caller_request_key"],
            request_sha256=request_hash,
            stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        canonical = operations.transition(
            context,
            canonical,
            "provider_request_in_flight",
            result_code="invoice_retry_started",
            result_summary="invoice_retry_mode:pay",
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            for contender in ("contender-key-1", "contender-key-2"):
                with self.assertRaises(HTTPException) as in_flight:
                    asyncio.run(service.retry_invoice_payment(
                        "invoice_1", "studio_1", "actor_1", contender
                    ))
                self.assertEqual(in_flight.exception.status_code, 409)

        self.assertEqual(_FakeStripeService.pay_invoice_calls, [])
        self.assertEqual(canonical["state"], "provider_request_in_flight")
        for contender in ("contender-key-1", "contender-key-2"):
            self.assertEqual(
                service.supabase.billing_provider_operation_aliases[
                    ("studio_1", "invoice.retry", contender)
                ],
                canonical["id"],
            )
    def test_proof_bound_recovery_revision_compare_and_swap_allows_one_winner(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        request_hash = stable_hash({
            "operation_type": "invoice.retry",
            "studio_id": "studio_1",
            "invoice_id": "invoice_1",
            "stripe_invoice_id": "in_1",
            "stripe_connected_account_id": "acct_1",
            "connect_account_generation": 1,
        })
        operations = BillingProviderOperationCoordinator(service.supabase)
        claimed = operations.claim_resource(
            studio_id="studio_1", actor_id="actor_1",
            operation_type="invoice.retry", resource_type="invoice",
            resource_id="invoice_1", payer_id="payer_1",
            caller_request_key="owner-key",
            request_sha256=request_hash, stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        operation = claimed["operation"]
        context = BillingProviderOperationContext(
            operation_id=operation["id"], studio_id="studio_1",
            actor_id=operation["actor_id"], operation_type="invoice.retry",
            caller_request_key=operation["caller_request_key"],
            request_sha256=request_hash, stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        operation = operations.transition(context, operation, "provider_request_in_flight")
        operation = operations.transition(
            context, operation, "reconciliation_required",
            reconciliation_reason_code="invoice_retry_provider_outcome_ambiguous",
        )
        winner = operations.authorize_recovery(
            context,
            operation,
            recovery_actor_id="actor_admin",
            recovery_proof_sha256="a" * 64,
            recovery_outcome="provider_no_object_safe_to_retry",
            lease_owner="00000000-0000-4000-8000-000000000222",
        )
        with self.assertRaises(AssertionError):
            operations.authorize_recovery(
                context,
                operation,
                recovery_actor_id="actor_admin_2",
                recovery_proof_sha256="b" * 64,
                recovery_outcome="provider_no_object_safe_to_retry",
                lease_owner="00000000-0000-4000-8000-000000000333",
            )

        self.assertEqual(winner["state"], "recovery_authorized")
        self.assertEqual(
            winner["lease_owner"],
            "00000000-0000-4000-8000-000000000222",
        )

    def test_stripe_concurrency_idempotency_error_remains_ambiguous_and_active(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        _FakeStripeService.pay_invoice_error_after_call = StripeIdempotencyError(
            "another request with the same key is executing"
        )

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as ambiguous:
                asyncio.run(service.retry_invoice_payment(
                    "invoice_1", "studio_1", "actor_1", "concurrent-stripe-key"
                ))

        self.assertEqual(ambiguous.exception.status_code, 503)
        parent = self._retry_parent(service, "concurrent-stripe-key")
        self.assertEqual(parent["state"], "reconciliation_required")
        self.assertEqual(
            parent["reconciliation_reason_code"],
            "invoice_retry_provider_outcome_ambiguous",
        )
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 1)
    def test_nonterminal_stripe_response_keeps_operation_active_and_guards_new_retry(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        _FakeStripeService.invoice_response = {
            "id": "in_1", "status": "open", "amount_due": 123,
            "amount_paid": 0, "amount_remaining": 123, "currency": "usd",
            "customer": "cus_1",
            "payment_intent": {"id": "pi_1", "status": "processing"},
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
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
        self.assertEqual(adopted.exception.status_code, 409)
        self.assertEqual(len(_FakeStripeService.pay_invoice_calls), 1)
        canonical = self._retry_parent(service, "processing-key")
        self.assertEqual(canonical["state"], "reconciliation_required")
        self.assertEqual(
            service.supabase.billing_provider_operation_aliases[
                ("studio_1", "invoice.retry", "new-key-while-processing")
            ],
            canonical["id"],
        )
        self.assertEqual(service.supabase.tables["audit_logs"], [])
    def test_different_keys_claim_one_resource_owner_and_persist_aliases(self):
        service = self.service()
        service.supabase = _FakeSupabase(self._retry_operation_tables())
        request_hash = stable_hash({
            "operation_type": "invoice.retry",
            "studio_id": "studio_1",
            "invoice_id": "invoice_1",
            "stripe_invoice_id": "in_1",
            "stripe_connected_account_id": "acct_1",
            "connect_account_generation": 1,
        })
        operations = BillingProviderOperationCoordinator(service.supabase)
        first = operations.claim_resource(
            studio_id="studio_1", actor_id="actor_1",
            operation_type="invoice.retry", resource_type="invoice",
            resource_id="invoice_1", payer_id="payer_1",
            caller_request_key="winning-key",
            request_sha256=request_hash, stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000111",
        )
        adopter = operations.claim_resource(
            studio_id="studio_1", actor_id="actor_1",
            operation_type="invoice.retry", resource_type="invoice",
            resource_id="invoice_1", payer_id="payer_1",
            caller_request_key="adopter-key",
            request_sha256=request_hash, stripe_connected_account_id="acct_1",
            connect_account_generation=1,
            lease_owner="00000000-0000-4000-8000-000000000222",
        )

        self.assertEqual(first["outcome"], "claimed")
        self.assertEqual(adopter["outcome"], "adopted")
        self.assertEqual(adopter["operation"]["id"], first["operation"]["id"])
        self.assertEqual(len(service.supabase.billing_provider_operation_resources), 1)
        aliases = service.supabase.billing_provider_operation_aliases
        self.assertEqual(len(aliases), 2)
        self.assertEqual(
            aliases[("studio_1", "invoice.retry", "adopter-key")],
            first["operation"]["id"],
        )

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
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 1},
            }],
            "billing_payers": [{
                "id": "payer_1", "studio_id": "studio_1",
                "stripe_customer_id": "cus_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1,
                "autopay_status": "not_configured",
            }],
            "billing_invoices": [],
            "billing_invoice_items": [],
            "audit_logs": [],
        })
        service.supabase.insert_defaults["billing_invoices"] = {
            "created_at": "2026-05-01T00:00:00Z",
            "updated_at": "2026-05-01T00:00:00Z",
        }
        _FakeStripeService.invoice_response = {
            "id": "in_created", "status": "draft", "amount_due": 12900,
            "amount_paid": 0, "amount_remaining": 12900, "currency": "usd",
            "collection_method": "send_invoice",
            "customer": "cus_1",
            "metadata": {
                "studio_id": "studio_1", "payer_id": "payer_1",
                "invoice_id": "billing_invoices_1",
            },
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            persisted = asyncio.run(service.create_invoice(
                data, "studio_1", "user_1", idempotency_key="invoice-key"
            ))
            provider_counts = (
                len(_FakeStripeService.connected_invoice_calls),
                len(_FakeStripeService.connected_invoice_item_calls),
            )
            restarted_service = self.service()
            restarted_service.supabase = service.supabase
            replay = asyncio.run(restarted_service.create_invoice(
                data, "studio_1", "user_1", idempotency_key="invoice-key"
            ))

        self.assertEqual(persisted.id, replay.id)
        self.assertEqual(len(service.supabase.tables["billing_invoices"]), 1)
        self.assertEqual(provider_counts, (
            len(_FakeStripeService.connected_invoice_calls),
            len(_FakeStripeService.connected_invoice_item_calls),
        ))
        parent = service.supabase.billing_provider_operations[
            ("studio_1", "invoice.create", "invoice-key")
        ]
        self.assertEqual(parent["state"], "completed")
        self.assertEqual(parent["provider_object_id"], "ii_created")
    def test_paid_in_full_enrollment_uses_invoice_idempotency_path(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "students": [{"id": "student_1", "studio_id": "studio_1"}],
            "billing_payers": [{
                "id": "payer_1", "studio_id": "studio_1",
            }],
            "billing_plans": [{
                "id": "plan_1", "studio_id": "studio_1",
                "name": "Summer Camp", "amount_cents": 25000,
                "signup_fee_cents": 5000, "currency": "usd",
                "billing_interval": "paid_in_full",
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
            with self.assertRaises(HTTPException) as separate_invoice:
                asyncio.run(service.activate_enrollment(
                    enrollment.id,
                    "studio_1",
                    "actor_1",
                    "paid-in-full-activation-key",
                ))

        self.assertEqual(enrollment.status, "pending")
        self.assertEqual(enrollment.billing_status, "no_payment_method")
        self.assertEqual(separate_invoice.exception.status_code, 409)
        self.assertIn("separate invoice workflow", separate_invoice.exception.detail)
        self.assertEqual(service.supabase.tables["billing_invoices"], [])
        self.assertEqual(_FakeStripeService.connected_invoice_calls, [])
        self.assertEqual(_FakeStripeService.connected_invoice_item_calls, [])
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
                idempotency_key="cross-studio-item",
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
                        idempotency_key=f"item-mismatch-{detail}",
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
                "amount_cents": 200,
                "status": "needs_response",
            }],
            "billing_payments": [{
                "id": "payment_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_1",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "status": "succeeded",
                "amount_cents": 200,
            }],
        })

        payment = service._link_adjustments_to_payment({
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
                "amount_cents": 200,
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
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 200)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertIsNotNone(invoice["paid_at"])
        self.assertEqual(payer["balance_cents"], 0)
        self.assertEqual(payer["billing_status"], "current")

    def test_succeeded_refund_is_idempotent_and_does_not_regress(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())
        refund = {
            "id": "re_1", "charge": "ch_1", "payment_intent": "pi_1",
            "amount": 50, "status": "succeeded",
            "metadata": {"studio_id": "studio_1"},
        }

        for event in (
            {"type": "refund.updated", "account": "acct_1", "data": {"object": refund}},
            {"type": "refund.updated", "account": "acct_1", "data": {"object": refund}},
            {"type": "refund.created", "account": "acct_1", "data": {"object": {**refund, "status": "pending"}}},
        ):
            service.project_connect_event(event)

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        self.assertEqual(len(service.supabase.tables["billing_refunds"]), 1)
        self.assertEqual(service.supabase.tables["billing_refunds"][0]["status"], "succeeded")
        self.assertEqual(payment["refunded_amount_cents"], 50)
        self.assertEqual(payment["net_collected_amount_cents"], 150)
        self.assertEqual(payment["refundable_amount_cents"], 150)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_remaining_cents"], 0)

    def test_late_payment_intent_backlinks_existing_refund(self):
        service = self.service()
        tables = _settled_payment_tables()
        tables["billing_refunds"] = [{
            "id": "refund_1", "studio_id": "studio_1", "stripe_account_id": "acct_1",
            "connect_account_generation": 1,
            "stripe_charge_id": "ch_1", "stripe_payment_intent_id": None,
            "payment_id": None, "amount_cents": 50, "status": "succeeded",
        }]
        service.supabase = _FakeSupabase(tables)

        service._project_payment_intent({
            "id": "pi_1", "status": "succeeded", "amount": 200,
            "amount_received": 200, "application_fee_amount": 1, "currency": "usd",
            "customer": "cus_1", "invoice": "in_1", "latest_charge": "ch_1",
            "payment_method_types": ["card"], "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        refund = service.supabase.tables["billing_refunds"][0]
        self.assertEqual(refund["payment_id"], "payment_1")
        self.assertEqual(refund["stripe_payment_intent_id"], "pi_1")
        self.assertEqual(service.supabase.tables["billing_payments"][0]["refunded_amount_cents"], 50)

    def test_payment_intent_update_preserves_pending_refund_reservation(self):
        service = self.service()
        tables = _settled_payment_tables()
        tables["billing_refunds"] = [
            {
                "id": "refund_pending", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1", "amount_cents": 30,
                "status": "pending",
            },
            {
                "id": "refund_wrong_studio", "studio_id": "studio_other",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "stripe_charge_id": "ch_1",
                "amount_cents": 90, "status": "pending",
            },
            {
                "id": "refund_wrong_account", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_other",
                "connect_account_generation": 1, "stripe_charge_id": "ch_1",
                "amount_cents": 90, "status": "pending",
            },
            {
                "id": "refund_wrong_generation", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 2, "stripe_charge_id": "ch_1",
                "amount_cents": 90, "status": "pending",
            },
        ]
        service.supabase = _FakeSupabase(tables)

        service._project_payment_intent({
            "id": "pi_1", "status": "succeeded", "amount": 200,
            "amount_received": 200, "application_fee_amount": 0,
            "currency": "usd", "customer": "cus_1", "invoice": "in_1",
            "latest_charge": "ch_1", "payment_method_types": ["card"],
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["refunded_amount_cents"], 0)
        self.assertEqual(payment["net_collected_amount_cents"], 200)
        self.assertEqual(payment["refundable_amount_cents"], 170)

    def test_reconcile_payment_adjustments_reserves_only_matching_pending_refunds(self):
        service = self.service()
        tables = _settled_payment_tables()
        tables["billing_refunds"] = [
            {
                "id": "refund_succeeded", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "amount_cents": 50,
                "status": "succeeded",
            },
            {
                "id": "refund_pending", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "amount_cents": 40,
                "status": "pending",
            },
            {
                "id": "refund_failed", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "amount_cents": 80,
                "status": "failed",
            },
            {
                "id": "refund_unknown", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 1, "amount_cents": 80,
                "status": "unknown",
            },
            {
                "id": "refund_wrong_account", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_other",
                "connect_account_generation": 1, "amount_cents": 80,
                "status": "pending",
            },
            {
                "id": "refund_wrong_generation", "studio_id": "studio_1",
                "payment_id": "payment_1", "stripe_account_id": "acct_1",
                "connect_account_generation": 2, "amount_cents": 80,
                "status": "pending",
            },
        ]
        service.supabase = _FakeSupabase(tables)

        payment = BillingPaymentEventProjector(service)._reconcile_payment_adjustments(
            service.supabase.tables["billing_payments"][0],
            "acct_1",
        )

        self.assertEqual(payment["refunded_amount_cents"], 50)
        self.assertEqual(payment["net_collected_amount_cents"], 150)
        self.assertEqual(payment["refundable_amount_cents"], 110)

    def test_terminal_won_dispute_does_not_regress_or_reverse_balance(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())
        dispute = {
            "id": "dp_1", "charge": "ch_1", "amount": 200,
            "status": "won", "reason": "fraudulent",
            "metadata": {"studio_id": "studio_1"},
        }
        service.project_connect_event({
            "type": "charge.dispute.closed", "account": "acct_1", "data": {"object": dispute},
        })
        service.project_connect_event({
            "type": "charge.dispute.updated", "account": "acct_1",
            "data": {"object": {**dispute, "status": "under_review"}},
        })

        self.assertEqual(service.supabase.tables["billing_disputes"][0]["status"], "won")
        self.assertEqual(service.supabase.tables["billing_payments"][0]["status"], "succeeded")
        self.assertEqual(service.supabase.tables["billing_invoices"][0]["amount_remaining_cents"], 0)

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
        self.assertEqual(payment["net_collected_amount_cents"], 150)
        self.assertEqual(payment["refundable_amount_cents"], 150)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 200)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["paid_at"], "2026-05-18T00:00:00Z")
        self.assertEqual(payer["balance_cents"], 0)
        self.assertEqual(payer["billing_status"], "current")

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
        self.assertEqual(payment["net_collected_amount_cents"], 0)
        self.assertEqual(payment["refundable_amount_cents"], 0)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 200)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["paid_at"], "2026-05-18T00:00:00Z")
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
        self.assertEqual(payment["disputed_amount_cents"], 200)
        self.assertEqual(payment["net_collected_amount_cents"], 0)
        self.assertEqual(payment["refundable_amount_cents"], 0)
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 200)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(invoice["paid_at"], "2026-05-18T00:00:00Z")
        self.assertEqual(payer["balance_cents"], 0)
        self.assertEqual(payer["billing_status"], "current")

    def test_refund_and_dispute_totals_do_not_double_subtract_the_charge(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())

        service.project_connect_event({
            "id": "evt_refund",
            "type": "refund.updated",
            "account": "acct_1",
            "created": 100,
            "data": {"object": {
                "id": "re_1", "charge": "ch_1", "payment_intent": "pi_1",
                "amount": 75, "status": "succeeded",
                "metadata": {"studio_id": "studio_1"},
            }},
        })
        service.project_connect_event({
            "id": "evt_dispute",
            "type": "charge.dispute.updated",
            "account": "acct_1",
            "created": 101,
            "data": {"object": {
                "id": "dp_1", "charge": "ch_1", "amount": 200,
                "status": "needs_response", "reason": "fraudulent",
                "metadata": {"studio_id": "studio_1"},
            }},
        })

        payment = service.supabase.tables["billing_payments"][0]
        invoice = service.supabase.tables["billing_invoices"][0]
        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payment["amount_cents"], 200)
        self.assertEqual(payment["refunded_amount_cents"], 75)
        self.assertEqual(payment["disputed_amount_cents"], 125)
        self.assertEqual(payment["net_collected_amount_cents"], 0)
        self.assertEqual(payment["refundable_amount_cents"], 0)
        self.assertEqual(invoice["amount_remaining_cents"], 0)
        self.assertEqual(payer["billing_status"], "current")

    def test_adjustment_projection_uses_event_order_and_same_second_precedence(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())
        refund = {
            "id": "re_1", "charge": "ch_1", "payment_intent": "pi_1",
            "amount": 50, "metadata": {"studio_id": "studio_1"},
        }

        for created, status in ((200, "succeeded"), (199, "pending"), (200, "failed")):
            service.project_connect_event({
                "id": f"evt_{created}_{status}",
                "type": "refund.updated",
                "account": "acct_1",
                "created": created,
                "data": {"object": {**refund, "status": status}},
            })

        stored = service.supabase.tables["billing_refunds"][0]
        self.assertEqual(stored["status"], "succeeded")
        self.assertEqual(stored["last_stripe_event_created"], 200)
        self.assertEqual(service.supabase.tables["billing_payments"][0]["refunded_amount_cents"], 50)

    def test_refund_without_provider_success_status_does_not_change_financial_totals(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())

        service._project_refund({
            "id": "re_missing_status",
            "charge": "ch_1",
            "payment_intent": "pi_1",
            "amount": 50,
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1")

        refund = service.supabase.tables["billing_refunds"][0]
        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(refund["status"], "unknown")
        self.assertEqual(payment["refunded_amount_cents"], 0)
        self.assertEqual(payment["net_collected_amount_cents"], 200)
        self.assertEqual(payment["refundable_amount_cents"], 200)

    def test_concurrent_refund_insert_conflict_reloads_and_converges(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())
        service.supabase.unique_constraints["billing_refunds"] = [
            ("studio_id", "stripe_account_id", "stripe_refund_id"),
        ]
        service.supabase.unique_conflict_error_factory = lambda _table, _columns: _unique_conflict()

        def insert_competing_refund(table_name, _payloads, rows):
            if table_name != "billing_refunds" or rows:
                return
            rows.append({
                "id": "refund_competing",
                "studio_id": "studio_1",
                "payment_id": "payment_1",
                "stripe_refund_id": "re_concurrent",
                "stripe_charge_id": "ch_1",
                "stripe_payment_intent_id": "pi_1",
                "stripe_account_id": "acct_1",
                "connect_account_generation": 1,
                "amount_cents": 50,
                "status": "pending",
            })

        service.supabase.before_insert = insert_competing_refund
        service._project_refund({
            "id": "re_concurrent",
            "charge": "ch_1",
            "payment_intent": "pi_1",
            "amount": 50,
            "status": "succeeded",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", event_created=200)

        self.assertEqual(len(service.supabase.tables["billing_refunds"]), 1)
        self.assertEqual(service.supabase.tables["billing_refunds"][0]["status"], "succeeded")
        self.assertEqual(service.supabase.tables["billing_payments"][0]["refunded_amount_cents"], 50)

    def test_dispute_categories_converge_without_terminal_regression(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())
        dispute = {
            "id": "dp_1", "charge": "ch_1", "amount": 200,
            "reason": "fraudulent", "metadata": {"studio_id": "studio_1"},
        }

        for created, status, expected_category in (
            (100, "warning_needs_response", "warning"),
            (101, "needs_response", "active"),
            (102, "won", "won"),
            (101, "under_review", "won"),
            (102, "needs_response", "won"),
        ):
            service.project_connect_event({
                "id": f"evt_{created}_{status}",
                "type": "charge.dispute.updated",
                "account": "acct_1",
                "created": created,
                "data": {"object": {**dispute, "status": status}},
            })
            self.assertEqual(
                service.supabase.tables["billing_disputes"][0]["state_category"],
                expected_category,
            )

        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(payment["status"], "succeeded")
        self.assertEqual(payment["disputed_amount_cents"], 0)
        self.assertEqual(payment["net_collected_amount_cents"], 200)

    def test_adjustment_does_not_link_across_connect_generations(self):
        service = self.service()
        tables = _settled_payment_tables()
        tables["studio_payment_accounts"][0]["metadata"] = {"connect_account_generation": 2}
        service.supabase = _FakeSupabase(tables)

        service.project_connect_event({
            "id": "evt_new_generation_refund",
            "type": "refund.updated",
            "account": "acct_1",
            "created": 200,
            "data": {"object": {
                "id": "re_generation_2", "charge": "ch_1", "payment_intent": "pi_1",
                "amount": 50, "status": "succeeded",
                "metadata": {"studio_id": "studio_1"},
            }},
        })

        refund = service.supabase.tables["billing_refunds"][0]
        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(refund["connect_account_generation"], 2)
        self.assertIsNone(refund["payment_id"])
        self.assertEqual(payment["refunded_amount_cents"], 0)

    def test_delayed_adjustment_updates_after_reconnect_preserve_established_identity(self):
        service = self.service()
        tables = _settled_payment_tables()
        tables["studio_payment_accounts"][0]["metadata"] = {"connect_account_generation": 2}
        tables["billing_refunds"] = [{
            "id": "refund_1",
            "studio_id": "studio_1",
            "payment_id": "payment_1",
            "stripe_refund_id": "re_1",
            "stripe_charge_id": "ch_1",
            "stripe_payment_intent_id": "pi_1",
            "stripe_account_id": "acct_1",
            "connect_account_generation": 1,
            "amount_cents": 50,
            "status": "pending",
            "reconciliation_required": False,
            "reconciliation_reason_code": None,
            "last_stripe_event_created": 100,
        }]
        tables["billing_disputes"] = [{
            "id": "dispute_1",
            "studio_id": "studio_1",
            "payment_id": "payment_1",
            "stripe_dispute_id": "dp_1",
            "stripe_charge_id": "ch_1",
            "stripe_payment_intent_id": "pi_1",
            "stripe_account_id": "acct_1",
            "connect_account_generation": 1,
            "amount_cents": 200,
            "status": "under_review",
            "state_category": "active",
            "reconciliation_required": False,
            "reconciliation_reason_code": None,
            "last_stripe_event_created": 100,
        }]
        service.supabase = _FakeSupabase(tables)

        service._project_refund({
            "id": "re_1",
            "charge": "ch_replayed",
            "payment_intent": "pi_replayed",
            "amount": 50,
            "status": "succeeded",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", event_created=200)
        service._project_dispute({
            "id": "dp_1",
            "charge": "ch_replayed",
            "amount": 200,
            "status": "won",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", event_created=200)

        for table_name in ("billing_refunds", "billing_disputes"):
            adjustment = service.supabase.tables[table_name][0]
            self.assertEqual(adjustment["studio_id"], "studio_1")
            self.assertEqual(adjustment["payment_id"], "payment_1")
            self.assertEqual(adjustment["stripe_charge_id"], "ch_1")
            self.assertEqual(adjustment["stripe_payment_intent_id"], "pi_1")
            self.assertEqual(adjustment["stripe_account_id"], "acct_1")
            self.assertEqual(adjustment["connect_account_generation"], 1)
            self.assertFalse(adjustment["reconciliation_required"])

    def test_dispute_without_status_is_unknown_and_requires_reconciliation(self):
        service = self.service()
        service.supabase = _FakeSupabase(_settled_payment_tables())

        service._project_dispute({
            "id": "dp_missing_status",
            "charge": "ch_1",
            "amount": 200,
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", event_created=200)

        dispute = service.supabase.tables["billing_disputes"][0]
        payment = service.supabase.tables["billing_payments"][0]
        self.assertEqual(dispute["status"], "unknown")
        self.assertEqual(dispute["state_category"], "unknown")
        self.assertTrue(dispute["reconciliation_required"])
        self.assertEqual(dispute["reconciliation_reason_code"], "unknown_dispute_status")
        self.assertTrue(payment["adjustment_reconciliation_required"])
        self.assertEqual(
            payment["adjustment_reconciliation_reason_code"],
            "unknown_dispute_status",
        )

    def test_authoritative_terminal_dispute_resolves_missing_status_reconciliation(self):
        for terminal_status in ("won", "lost"):
            with self.subTest(terminal_status=terminal_status):
                service = self.service()
                service.supabase = _FakeSupabase(_settled_payment_tables())
                dispute = {
                    "id": f"dp_missing_then_{terminal_status}",
                    "charge": "ch_1",
                    "amount": 200,
                    "metadata": {"studio_id": "studio_1"},
                }

                service._project_dispute(dispute, "acct_1", event_created=100)
                service._project_dispute(
                    {**dispute, "status": terminal_status},
                    "acct_1",
                    event_created=200,
                )

                stored_dispute = service.supabase.tables["billing_disputes"][0]
                payment = service.supabase.tables["billing_payments"][0]
                self.assertEqual(stored_dispute["status"], terminal_status)
                self.assertEqual(stored_dispute["state_category"], terminal_status)
                self.assertFalse(stored_dispute["reconciliation_required"])
                self.assertIsNone(stored_dispute["reconciliation_reason_code"])
                self.assertFalse(payment["adjustment_reconciliation_required"])
                self.assertIsNone(payment["adjustment_reconciliation_reason_code"])
                if terminal_status == "won":
                    self.assertEqual(payment["status"], "succeeded")
                    self.assertEqual(payment["disputed_amount_cents"], 0)
                    self.assertEqual(payment["net_collected_amount_cents"], 200)
                else:
                    self.assertEqual(payment["status"], "disputed")
                    self.assertEqual(payment["disputed_amount_cents"], 200)
                    self.assertEqual(payment["net_collected_amount_cents"], 0)

    def test_delayed_historical_adjustment_keeps_unknown_generation_reconciliation(self):
        service = self.service()
        tables = _settled_payment_tables()
        tables["studio_payment_accounts"][0]["metadata"] = {"connect_account_generation": 2}
        payment = tables["billing_payments"][0]
        payment["connect_account_generation"] = None
        payment["adjustment_reconciliation_required"] = True
        payment["adjustment_reconciliation_reason_code"] = (
            "historical_connect_generation_unknown"
        )
        tables["billing_refunds"] = [{
            "id": "refund_historical",
            "studio_id": "studio_1",
            "payment_id": "payment_1",
            "stripe_refund_id": "re_historical",
            "stripe_charge_id": "ch_1",
            "stripe_payment_intent_id": "pi_1",
            "stripe_account_id": "acct_1",
            "connect_account_generation": None,
            "amount_cents": 50,
            "status": "pending",
            "reconciliation_required": True,
            "reconciliation_reason_code": "historical_connect_generation_unknown",
            "last_stripe_event_created": 100,
        }]
        service.supabase = _FakeSupabase(tables)

        service._project_refund({
            "id": "re_historical",
            "charge": "ch_1",
            "payment_intent": "pi_1",
            "amount": 50,
            "status": "succeeded",
            "metadata": {"studio_id": "studio_1"},
        }, "acct_1", event_created=200)

        stored_payment = service.supabase.tables["billing_payments"][0]
        self.assertIsNone(stored_payment["connect_account_generation"])
        self.assertTrue(stored_payment["adjustment_reconciliation_required"])
        self.assertEqual(
            stored_payment["adjustment_reconciliation_reason_code"],
            "historical_connect_generation_unknown",
        )

    def test_refund_projection_rejects_both_asymmetric_missing_generation_cases(self):
        for missing_side in ("current_account", "payment"):
            with self.subTest(missing_side=missing_side):
                service = self.service()
                tables = _settled_payment_tables()
                if missing_side == "current_account":
                    tables["studio_payment_accounts"] = []
                else:
                    tables["billing_payments"][0].pop("connect_account_generation")
                service.supabase = _FakeSupabase(tables)

                service.project_connect_event({
                    "id": f"evt_refund_missing_{missing_side}",
                    "type": "refund.updated",
                    "account": "acct_1",
                    "created": 200,
                    "data": {"object": {
                        "id": f"re_missing_{missing_side}",
                        "charge": "ch_1",
                        "payment_intent": "pi_1",
                        "amount": 50,
                        "status": "succeeded",
                        "metadata": {"studio_id": "studio_1"},
                    }},
                })

                refund = service.supabase.tables["billing_refunds"][0]
                payment = service.supabase.tables["billing_payments"][0]
                self.assertIsNone(refund["payment_id"])
                self.assertTrue(refund["reconciliation_required"])
                self.assertEqual(refund["reconciliation_reason_code"], "payment_identity_mismatch")
                self.assertEqual(payment["refunded_amount_cents"], 0)

    def test_dispute_projection_rejects_both_asymmetric_missing_generation_cases(self):
        for missing_side in ("current_account", "payment"):
            with self.subTest(missing_side=missing_side):
                service = self.service()
                tables = _settled_payment_tables()
                if missing_side == "current_account":
                    tables["studio_payment_accounts"] = []
                else:
                    tables["billing_payments"][0].pop("connect_account_generation")
                service.supabase = _FakeSupabase(tables)

                service.project_connect_event({
                    "id": f"evt_dispute_missing_{missing_side}",
                    "type": "charge.dispute.updated",
                    "account": "acct_1",
                    "created": 200,
                    "data": {"object": {
                        "id": f"dp_missing_{missing_side}",
                        "charge": "ch_1",
                        "amount": 200,
                        "status": "needs_response",
                        "metadata": {"studio_id": "studio_1"},
                    }},
                })

                dispute = service.supabase.tables["billing_disputes"][0]
                payment = service.supabase.tables["billing_payments"][0]
                self.assertIsNone(dispute["payment_id"])
                self.assertTrue(dispute["reconciliation_required"])
                self.assertEqual(dispute["reconciliation_reason_code"], "payment_identity_mismatch")
                self.assertEqual(payment["disputed_amount_cents"], 0)

    def test_payment_link_marks_both_asymmetric_missing_generation_cases_for_reconciliation(self):
        for missing_side in ("adjustments", "payment"):
            with self.subTest(missing_side=missing_side):
                service = self.service()
                tables = _settled_payment_tables()
                adjustment_generation = None if missing_side == "adjustments" else 1
                if missing_side == "payment":
                    tables["billing_payments"][0].pop("connect_account_generation")
                tables["billing_refunds"] = [{
                    "id": "refund_orphan",
                    "studio_id": "studio_1",
                    "stripe_account_id": "acct_1",
                    "connect_account_generation": adjustment_generation,
                    "stripe_charge_id": "ch_1",
                    "payment_id": None,
                    "amount_cents": 50,
                    "status": "succeeded",
                }]
                tables["billing_disputes"] = [{
                    "id": "dispute_orphan",
                    "studio_id": "studio_1",
                    "stripe_account_id": "acct_1",
                    "connect_account_generation": adjustment_generation,
                    "stripe_charge_id": "ch_1",
                    "payment_id": None,
                    "amount_cents": 200,
                    "status": "needs_response",
                    "state_category": "active",
                }]
                service.supabase = _FakeSupabase(tables)

                service._link_adjustments_to_payment(
                    service.supabase.tables["billing_payments"][0],
                    "acct_1",
                )

                for table_name in ("billing_refunds", "billing_disputes"):
                    adjustment = service.supabase.tables[table_name][0]
                    self.assertIsNone(adjustment["payment_id"])
                    self.assertTrue(adjustment["reconciliation_required"])
                    self.assertEqual(
                        adjustment["reconciliation_reason_code"],
                        "payment_identity_mismatch",
                    )

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
