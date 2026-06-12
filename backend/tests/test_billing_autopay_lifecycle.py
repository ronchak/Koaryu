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


class BillingAutopayLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_successful_invoice_payment_stores_payment_method_without_enabling_autopay(self):
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
                "amount_due_cents": 200,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 200,
                "currency": "usd",
                "application_fee_amount_cents": 1,
                "created_at": "2026-05-18T19:00:00Z",
            }],
            "billing_disputes": [],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "autopay_status": "not_configured",
            }],
        })
        service._store_invoice_payment_method = lambda studio_id, payer_id, account_id, customer_id, payment_method: service.supabase.tables["billing_payers"][0].update({
            "stripe_account_id": account_id,
            "stripe_customer_id": customer_id,
            "default_payment_method_id": payment_method["id"],
            "default_payment_method_brand": payment_method["card"]["brand"],
            "default_payment_method_last4": payment_method["card"]["last4"],
        })

        service._project_payment_intent({
            "id": "pi_1",
            "status": "succeeded",
            "amount": 200,
            "amount_received": 200,
            "application_fee_amount": 1,
            "currency": "usd",
            "customer": "cus_1",
            "latest_charge": "ch_1",
            "payment_method": {
                "id": "pm_1",
                "type": "card",
                "card": {"brand": "visa", "last4": "2167"},
            },
            "metadata": {},
        }, "acct_1", "payment_intent.succeeded")

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["default_payment_method_id"], "pm_1")
        self.assertEqual(payer["default_payment_method_brand"], "visa")
        self.assertEqual(payer["default_payment_method_last4"], "2167")
        self.assertEqual(payer["autopay_status"], "not_configured")

    def test_payer_sync_stores_saved_card_without_enabling_autopay(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "no_payment_method",
            }],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            payer = service._sync_payer_customer(
                service.supabase.tables["billing_payers"][0],
                {"stripe_connected_account_id": "acct_1"},
            )

        self.assertEqual(payer["default_payment_method_id"], "pm_123")
        self.assertEqual(payer["default_payment_method_last4"], "2167")
        self.assertEqual(payer["autopay_status"], "not_configured")

    def test_autopay_setup_requires_explicit_terms_acceptance(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("accepted autopay terms", context.exception.detail)

    def test_autopay_setup_uses_explicit_terms_and_allowed_redirect(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
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
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.setup_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            link = asyncio.run(service.create_autopay_setup_link(
                "payer_1",
                BillingPayerAutopaySetupRequest(
                    return_url="https://app.koaryu.test/billing",
                    terms_accepted=True,
                ),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(link.url, "https://app.koaryu.test/billing")
        self.assertEqual(service.supabase.tables["billing_payers"][0]["autopay_status"], "enabled")
        self.assertIsNotNone(service.supabase.tables["billing_payers"][0]["autopay_terms_accepted_at"])
        self.assertEqual(_FakeStripeService.setup_calls, [])

    def test_checkout_projection_keeps_autopay_pending_when_payment_method_lookup_fails(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "pending",
                "autopay_terms_accepted_at": "2026-05-18T00:00:00Z",
                "billing_status": "no_payment_method",
                "metadata": {},
            }],
        })

        class FailingStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                raise RuntimeError("Stripe timeout")

        with patch("app.services.billing_service.StripeService", FailingStripeService):
            service._project_checkout_session({
                "id": "cs_1",
                "customer": "cus_1",
                "setup_intent": "seti_1",
                "metadata": {
                    "product": "koaryu_payments_autopay",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                },
            }, "acct_1")

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "pending")
        self.assertEqual(payer["billing_status"], "no_payment_method")
        self.assertIsNone(payer.get("autopay_authorized_at"))
        self.assertEqual(payer["metadata"]["autopay_projection_error"]["type"], "RuntimeError")

    def test_successful_checkout_projection_clears_stale_projection_error_metadata(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "autopay_status": "pending",
                "autopay_terms_accepted_at": "2026-05-18T00:00:00Z",
                "billing_status": "no_payment_method",
                "metadata": {
                    "autopay_projection_error": {"type": "RuntimeError"},
                    "support_note": "keep me",
                },
            }],
        })

        class SuccessfulStripeService:
            def retrieve_connected_setup_intent(self, **_payload):
                return {
                    "id": "seti_1",
                    "payment_method": {
                        "id": "pm_123",
                        "type": "card",
                        "card": {
                            "brand": "visa",
                            "last4": "2167",
                            "exp_month": 12,
                            "exp_year": 2030,
                        },
                    },
                }

            def set_connected_customer_default_payment_method(self, **_payload):
                return {
                    "id": "cus_1",
                    "invoice_settings": {
                        "default_payment_method": {
                            "id": "pm_123",
                            "type": "card",
                            "card": {
                                "brand": "visa",
                                "last4": "2167",
                                "exp_month": 12,
                                "exp_year": 2030,
                            },
                        },
                    },
                }

        with patch("app.services.billing_service.StripeService", SuccessfulStripeService):
            service._project_checkout_session({
                "id": "cs_1",
                "customer": "cus_1",
                "setup_intent": "seti_1",
                "metadata": {
                    "product": "koaryu_payments_autopay",
                    "studio_id": "studio_1",
                    "payer_id": "payer_1",
                },
            }, "acct_1")

        payer = service.supabase.tables["billing_payers"][0]
        self.assertEqual(payer["autopay_status"], "enabled")
        self.assertEqual(payer["billing_status"], "current")
        self.assertEqual(payer["default_payment_method_id"], "pm_123")
        self.assertNotIn("autopay_projection_error", payer["metadata"])
        self.assertEqual(payer["metadata"]["support_note"], "keep me")

    def test_disable_autopay_rewires_active_subscription_to_invoice_collection(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Family One",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "default_payment_method_id": "pm_123",
                "autopay_status": "enabled",
                "autopay_terms_accepted_at": "2026-05-18T00:00:00Z",
                "billing_status": "current",
                "balance_cents": 0,
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "collection_mode": "autopay",
                "status": "active",
                "default_payment_method_id": "pm_123",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "subscription_1",
                "collection_mode": "autopay",
                "status": "active",
                "billing_status": "current",
                "start_date": "2026-05-18",
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "studio_payment_accounts": [],
            "audit_logs": [],
        })
        _FakeStripeService.subscription_update_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.disable_autopay("payer_1", "studio_1", "user_1"))

        self.assertEqual(response.autopay_status, "disabled")
        self.assertEqual(_FakeStripeService.subscription_update_calls, [{
            "account_id": "acct_1",
            "subscription_id": "sub_1",
            "collection_method": "send_invoice",
            "days_until_due": 7,
            "default_payment_method": "",
        }])
        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(subscription["collection_mode"], "invoice_link")
        self.assertIsNone(subscription["default_payment_method_id"])
        self.assertEqual(
            service.supabase.tables["student_billing_enrollments"][0]["collection_mode"],
            "invoice_link",
        )
        self.assertEqual(
            service.supabase.tables["audit_logs"][0]["metadata"]["rewired_subscription_ids"],
            ["subscription_1"],
        )

    def test_disable_autopay_marks_subscription_pending_before_stripe_mutation(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "billing_payers": [{
                "id": "payer_1",
                "studio_id": "studio_1",
                "display_name": "Family One",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "default_payment_method_id": "pm_123",
                "autopay_status": "enabled",
                "autopay_terms_accepted_at": "2026-05-18T00:00:00Z",
                "billing_status": "current",
                "balance_cents": 0,
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_subscription_id": "sub_1",
                "collection_mode": "autopay",
                "status": "active",
                "default_payment_method_id": "pm_123",
                "metadata": {},
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "subscription_1",
                "collection_mode": "autopay",
                "status": "active",
                "billing_status": "current",
                "start_date": "2026-05-18",
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "studio_payment_accounts": [],
            "audit_logs": [],
        })
        test_case = self

        class ObservingStripeService(_FakeStripeService):
            def update_connected_subscription(self, **payload):
                metadata = service.supabase.tables["billing_subscriptions"][0]["metadata"]
                test_case.assertIn("autopay_disable_pending", metadata)
                test_case.assertEqual(metadata["autopay_disable_pending"]["reason"], "payer_disabled_autopay")
                test_case.assertEqual(metadata["autopay_disable_pending"]["stripe_subscription_id"], "sub_1")
                return super().update_connected_subscription(**payload)

        with patch("app.services.billing_service.StripeService", ObservingStripeService):
            asyncio.run(service.disable_autopay("payer_1", "studio_1", "user_1"))

        metadata = service.supabase.tables["billing_subscriptions"][0]["metadata"]
        self.assertNotIn("autopay_disable_pending", metadata)
        self.assertEqual(metadata["autopay_disable_history"][0]["stripe_subscription_id"], "sub_1")

    def test_autopay_invoice_requires_authorized_payer_terms(self):
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
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "default_payment_method_id": "pm_123",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_invoices": [],
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
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_invoice(
                    BillingInvoiceCreate(
                        payer_id="payer_1",
                        collection_mode="autopay",
                        amount_cents=200,
                        description="Autopay consent rehearsal",
                    ),
                    "studio_1",
                    "user_1",
                ))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("accepted autopay terms", context.exception.detail)

    def test_autopay_enrollment_requires_authorized_payer_terms(self):
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
                "display_name": "Rehearsal Payer",
                "stripe_customer_id": "cus_1",
                "default_payment_method_id": "pm_123",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                service._activate_stripe_enrollment(
                    {
                        "id": "enrollment_1",
                        "studio_id": "studio_1",
                        "student_id": "student_1",
                        "payer_id": "payer_1",
                        "collection_mode": "autopay",
                    },
                    {
                        "id": "plan_1",
                        "studio_id": "studio_1",
                        "name": "Live Autopay Rehearsal",
                        "amount_cents": 200,
                        "currency": "usd",
                        "billing_interval": "monthly",
                        "trial_days": 0,
                        "stripe_price_id": "price_1",
                    },
                    "studio_1",
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("accepted autopay terms", context.exception.detail)

    def test_activation_marks_enrollment_attach_pending_before_subscription_item_mutation(self):
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
                "display_name": "Family One",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "autopay_status": "not_configured",
                "billing_status": "current",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_subscription_id": "sub_1",
                "collection_mode": "invoice_link",
                "billing_interval": "monthly",
                "currency": "usd",
                "status": "active",
            }],
            "student_billing_enrollments": [
                {
                    "id": "enrollment_1",
                    "studio_id": "studio_1",
                    "student_id": "student_1",
                    "payer_id": "payer_1",
                    "billing_plan_id": "plan_1",
                    "billing_subscription_id": None,
                    "stripe_subscription_id": None,
                    "stripe_subscription_item_id": None,
                    "collection_mode": "invoice_link",
                    "status": "pending",
                    "billing_status": "no_payment_method",
                    "start_date": "2026-05-18",
                    "metadata": {},
                    "created_at": "2026-05-18T00:00:00Z",
                    "updated_at": "2026-05-18T00:00:00Z",
                },
                {
                    "id": "enrollment_existing",
                    "studio_id": "studio_1",
                    "student_id": "student_2",
                    "payer_id": "payer_1",
                    "billing_plan_id": "plan_1",
                    "billing_subscription_id": "subscription_1",
                    "stripe_subscription_id": "sub_1",
                    "stripe_subscription_item_id": "si_existing",
                    "collection_mode": "invoice_link",
                    "status": "active",
                    "billing_status": "upcoming",
                    "start_date": "2026-05-18",
                    "metadata": {},
                    "created_at": "2026-05-18T00:00:00Z",
                    "updated_at": "2026-05-18T00:00:00Z",
                },
            ],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        test_case = self
        final_attach_updates = []

        def observe_final_attach_update(query, _rows):
            if (
                query.name == "student_billing_enrollments"
                and query.update_payload
                and query.update_payload.get("stripe_subscription_item_id") == "si_existing"
            ):
                final_attach_updates.append(query.update_payload)
                test_case.assertIn(
                    "stripe_quantity_sync_lock",
                    service.supabase.tables["billing_subscriptions"][0].get("metadata", {}),
                )
            return None

        service.supabase.on_update_query = observe_final_attach_update

        class ObservingStripeService(_FakeStripeService):
            def update_connected_subscription_item(self, **payload):
                metadata = service.supabase.tables["student_billing_enrollments"][0]["metadata"]
                test_case.assertIn("stripe_attach_pending", metadata)
                test_case.assertEqual(metadata["stripe_attach_pending"]["reason"], "activate")
                test_case.assertEqual(metadata["stripe_attach_pending"]["billing_plan_id"], "plan_1")
                return super().update_connected_subscription_item(**payload)

        with patch("app.services.billing_service.StripeService", ObservingStripeService):
            response = service._activate_stripe_enrollment(
                service.supabase.tables["student_billing_enrollments"][0],
                {
                    "id": "plan_1",
                    "studio_id": "studio_1",
                    "name": "Monthly Tuition",
                    "amount_cents": 200,
                    "currency": "usd",
                    "billing_interval": "monthly",
                    "trial_days": 0,
                    "stripe_price_id": "price_1",
                },
                "studio_1",
            )

        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(response["status"], "active")
        self.assertEqual(response["billing_subscription_id"], "subscription_1")
        self.assertEqual(response["stripe_subscription_item_id"], "si_existing")
        self.assertNotIn("stripe_attach_pending", enrollment["metadata"])
        self.assertEqual(
            enrollment["metadata"]["stripe_attach_history"][0]["stripe_subscription_item_id"],
            "si_existing",
        )
        self.assertEqual(_FakeStripeService.subscription_item_update_calls[-1]["quantity"], 2)
        self.assertEqual(
            _FakeStripeService.subscription_item_update_calls[-1]["idempotency_key"],
            "koaryu:subscription-item-quantity:si_existing:2",
        )
        self.assertEqual(len(final_attach_updates), 1)
        self.assertNotIn(
            "stripe_quantity_sync_lock",
            service.supabase.tables["billing_subscriptions"][0].get("metadata", {}),
        )

    def test_subscription_item_quantity_update_rejects_concurrent_sync_lock(self):
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
                "display_name": "Family One",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "billing_status": "current",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "payer_id": "payer_1",
                "stripe_account_id": "acct_1",
                "stripe_customer_id": "cus_1",
                "stripe_subscription_id": "sub_1",
                "collection_mode": "invoice_link",
                "billing_interval": "monthly",
                "currency": "usd",
                "status": "active",
                "metadata": {
                    "stripe_quantity_sync_lock": {
                        "token": "other-worker",
                        "locked_at": "2026-01-01T00:00:00Z",
                    },
                },
            }],
            "student_billing_enrollments": [
                {
                    "id": "enrollment_1",
                    "studio_id": "studio_1",
                    "student_id": "student_1",
                    "payer_id": "payer_1",
                    "billing_plan_id": "plan_1",
                    "billing_subscription_id": None,
                    "stripe_subscription_id": None,
                    "stripe_subscription_item_id": None,
                    "collection_mode": "invoice_link",
                    "status": "pending",
                    "billing_status": "no_payment_method",
                    "start_date": "2026-05-18",
                    "metadata": {},
                    "created_at": "2026-05-18T00:00:00Z",
                    "updated_at": "2026-05-18T00:00:00Z",
                },
                {
                    "id": "enrollment_existing",
                    "studio_id": "studio_1",
                    "student_id": "student_2",
                    "payer_id": "payer_1",
                    "billing_plan_id": "plan_1",
                    "billing_subscription_id": "subscription_1",
                    "stripe_subscription_id": "sub_1",
                    "stripe_subscription_item_id": "si_existing",
                    "collection_mode": "invoice_link",
                    "status": "active",
                    "billing_status": "upcoming",
                    "start_date": "2026-05-18",
                    "metadata": {},
                    "created_at": "2026-05-18T00:00:00Z",
                    "updated_at": "2026-05-18T00:00:00Z",
                },
            ],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_1",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                service._activate_stripe_enrollment(
                    service.supabase.tables["student_billing_enrollments"][0],
                    {
                        "id": "plan_1",
                        "studio_id": "studio_1",
                        "name": "Monthly Tuition",
                        "amount_cents": 200,
                        "currency": "usd",
                        "billing_interval": "monthly",
                        "trial_days": 0,
                        "stripe_price_id": "price_1",
                    },
                    "studio_1",
                )

        self.assertEqual(context.exception.status_code, 409)
        self.assertEqual(_FakeStripeService.subscription_item_update_calls, [])

    def test_cancel_last_subscription_enrollment_cancels_subscription_without_deleting_last_item(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "collection_mode": "autopay",
                "status": "active",
                "billing_status": "current",
                "start_date": "2026-05-18",
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "status": "active",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.subscription_cancel_calls = []
        _FakeStripeService.subscription_item_delete_calls = []
        _FakeStripeService.subscription_item_update_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.set_enrollment_status(
                "enrollment_1",
                "canceled",
                "studio_1",
                "user_1",
            ))

        self.assertEqual(response.status, "canceled")
        self.assertIsNone(service.supabase.tables["student_billing_enrollments"][0]["stripe_subscription_item_id"])
        self.assertEqual(service.supabase.tables["billing_subscriptions"][0]["status"], "canceled")
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [{
            "account_id": "acct_1",
            "subscription_id": "sub_1",
        }])
        self.assertEqual(_FakeStripeService.subscription_item_delete_calls, [])
        self.assertEqual(_FakeStripeService.subscription_item_update_calls, [])

    def test_cancel_uses_subscription_stripe_account_when_studio_account_rotated(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_new",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "collection_mode": "autopay",
                "status": "active",
                "billing_status": "current",
                "start_date": "2026-05-18",
                "metadata": {},
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_old",
                "status": "active",
            }],
            "audit_logs": [],
        })

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.set_enrollment_status(
                "enrollment_1",
                "canceled",
                "studio_1",
                "user_1",
            ))

        self.assertEqual(response.status, "canceled")
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [{
            "account_id": "acct_old",
            "subscription_id": "sub_1",
        }])
        self.assertEqual(service.supabase.tables["billing_subscriptions"][0]["status"], "canceled")

    def test_cancel_marks_enrollment_detach_pending_before_stripe_mutation(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "collection_mode": "autopay",
                "status": "active",
                "billing_status": "current",
                "start_date": "2026-05-18",
                "metadata": {},
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "status": "active",
            }],
            "audit_logs": [],
        })
        test_case = self

        class ObservingStripeService(_FakeStripeService):
            def cancel_connected_subscription(self, **payload):
                metadata = service.supabase.tables["student_billing_enrollments"][0]["metadata"]
                test_case.assertIn("stripe_detach_pending", metadata)
                test_case.assertEqual(metadata["stripe_detach_pending"]["reason"], "canceled")
                test_case.assertEqual(metadata["stripe_detach_pending"]["stripe_subscription_id"], "sub_1")
                return super().cancel_connected_subscription(**payload)

        with patch("app.services.billing_service.StripeService", ObservingStripeService):
            asyncio.run(service.set_enrollment_status(
                "enrollment_1",
                "canceled",
                "studio_1",
                "user_1",
            ))

        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertIsNone(enrollment["billing_subscription_id"])
        self.assertIsNone(enrollment["stripe_subscription_id"])
        self.assertIsNone(enrollment["stripe_subscription_item_id"])
        self.assertNotIn("stripe_detach_pending", enrollment["metadata"])
        self.assertEqual(
            enrollment["metadata"]["stripe_detach_history"][0]["stripe_subscription_item_id"],
            "si_1",
        )

    def test_update_enrollment_to_external_records_local_detach_before_canceling_stripe(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "payer_id": "payer_1",
                "billing_plan_id": "plan_1",
                "billing_subscription_id": "subscription_1",
                "stripe_subscription_id": "sub_1",
                "stripe_subscription_item_id": "si_1",
                "collection_mode": "autopay",
                "status": "active",
                "billing_status": "current",
                "start_date": "2026-05-18",
                "metadata": {},
                "created_at": "2026-05-18T00:00:00Z",
                "updated_at": "2026-05-18T00:00:00Z",
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "status": "active",
            }],
            "audit_logs": [],
        })
        test_case = self

        class ObservingStripeService(_FakeStripeService):
            def cancel_connected_subscription(self, **payload):
                metadata = service.supabase.tables["student_billing_enrollments"][0]["metadata"]
                test_case.assertIn("stripe_detach_pending", metadata)
                test_case.assertEqual(metadata["stripe_detach_pending"]["reason"], "rewire")
                return super().cancel_connected_subscription(**payload)

        with patch("app.services.billing_service.StripeService", ObservingStripeService):
            response = asyncio.run(service.update_enrollment(
                "enrollment_1",
                StudentBillingEnrollmentUpdate(collection_mode="external"),
                "studio_1",
                "user_1",
            ))

        enrollment = service.supabase.tables["student_billing_enrollments"][0]
        self.assertEqual(response.collection_mode, "external")
        self.assertEqual(enrollment["billing_status"], "externally_paid")
        self.assertIsNone(enrollment["billing_subscription_id"])
        self.assertIsNone(enrollment["stripe_subscription_id"])
        self.assertIsNone(enrollment["stripe_subscription_item_id"])
        self.assertNotIn("stripe_detach_pending", enrollment["metadata"])
        self.assertEqual(_FakeStripeService.subscription_cancel_calls[-1], {
            "account_id": "acct_1",
            "subscription_id": "sub_1",
        })

    def test_cancel_one_of_multiple_subscription_enrollments_deletes_only_that_item(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_1",
            }],
            "student_billing_enrollments": [
                {
                    "id": "enrollment_1",
                    "studio_id": "studio_1",
                    "student_id": "student_1",
                    "payer_id": "payer_1",
                    "billing_plan_id": "plan_1",
                    "billing_subscription_id": "subscription_1",
                    "stripe_subscription_id": "sub_1",
                    "stripe_subscription_item_id": "si_1",
                    "collection_mode": "autopay",
                    "status": "active",
                    "billing_status": "current",
                    "start_date": "2026-05-18",
                    "created_at": "2026-05-18T00:00:00Z",
                    "updated_at": "2026-05-18T00:00:00Z",
                },
                {
                    "id": "enrollment_2",
                    "studio_id": "studio_1",
                    "student_id": "student_2",
                    "payer_id": "payer_1",
                    "billing_plan_id": "plan_2",
                    "billing_subscription_id": "subscription_1",
                    "stripe_subscription_id": "sub_1",
                    "stripe_subscription_item_id": "si_2",
                    "collection_mode": "autopay",
                    "status": "active",
                    "billing_status": "current",
                    "start_date": "2026-05-18",
                    "created_at": "2026-05-18T00:00:00Z",
                    "updated_at": "2026-05-18T00:00:00Z",
                },
            ],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "status": "active",
            }],
            "audit_logs": [],
        })
        _FakeStripeService.subscription_cancel_calls = []
        _FakeStripeService.subscription_item_delete_calls = []
        _FakeStripeService.subscription_item_update_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.set_enrollment_status(
                "enrollment_1",
                "canceled",
                "studio_1",
                "user_1",
            ))

        self.assertEqual(response.status, "canceled")
        self.assertEqual(service.supabase.tables["billing_subscriptions"][0]["status"], "active")
        self.assertEqual(_FakeStripeService.subscription_cancel_calls, [])
        self.assertEqual(_FakeStripeService.subscription_item_delete_calls, [{
            "account_id": "acct_1",
            "subscription_item_id": "si_1",
        }])
