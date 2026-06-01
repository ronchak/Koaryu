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


class BillingConnectLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_standard_connect_account_uses_account_holder_dashboard_url(self):
        _FakeStripe.reset()
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        service._stripe = lambda: _FakeStripe

        url = service.create_connect_dashboard_url(account_id="acct_connected")

        self.assertEqual(
            url,
            "https://dashboard.stripe.com/test",
        )
        self.assertNotIn(("create_login_link", "acct_connected"), _FakeStripe.Account.calls)
        self.assertNotIn(("retrieve", None), _FakeStripe.Account.calls)

    def test_connect_dashboard_link_uses_account_holder_dashboard_url_for_full_dashboard_account(self):
        _FakeStripe.reset()
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        service._stripe = lambda: _FakeStripe

        link = service.create_connect_dashboard_link(account_id="acct_connected")

        self.assertEqual(link, {
            "url": "https://dashboard.stripe.com/test",
        })
        self.assertNotIn(("create_login_link", "acct_connected"), _FakeStripe.Account.calls)
        self.assertNotIn(("retrieve", None), _FakeStripe.Account.calls)

    def test_connect_account_creation_uses_accounts_v2_full_dashboard(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2", "object": "v2.core.account"}

        service._stripe_v2_post = fake_v2_post

        account = service.create_connect_account(
            studio_id="studio_1",
            business_name="River City Martial Arts",
            contact_email="owner@example.com",
        )

        self.assertEqual(account["id"], "acct_v2")
        path, payload, idempotency_key = calls[0]
        self.assertEqual(path, "/v2/core/accounts")
        self.assertEqual(idempotency_key, "koaryu-connect-account-studio_1-g1")
        self.assertEqual(payload["dashboard"], "full")
        self.assertEqual(payload["contact_email"], "owner@example.com")
        self.assertEqual(payload["identity"]["entity_type"], "company")
        self.assertEqual(payload["metadata"]["business_entity_type"], "company")
        self.assertEqual(payload["configuration"]["merchant"]["capabilities"]["card_payments"]["requested"], True)
        self.assertEqual(payload["defaults"]["responsibilities"]["fees_collector"], "stripe")
        self.assertEqual(payload["defaults"]["responsibilities"]["losses_collector"], "stripe")

    def test_connect_account_creation_passes_individual_entity_type(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2", "object": "v2.core.account"}

        service._stripe_v2_post = fake_v2_post

        service.create_connect_account(
            studio_id="studio_1",
            business_name="River City Martial Arts",
            contact_email="owner@example.com",
            business_entity_type="individual",
        )

        payload = calls[0][1]
        self.assertEqual(payload["identity"]["entity_type"], "individual")
        self.assertNotIn("business_details", payload["identity"])
        self.assertEqual(payload["metadata"]["business_entity_type"], "individual")

    def test_connect_onboarding_link_uses_accounts_v2_account_links(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"url": "https://connect.stripe.test/v2/acct_v2", "object": "v2.core.account_link"}

        service._stripe_v2_post = fake_v2_post
        service._stripe = lambda: self.fail("Accounts v2 onboarding must not call Stripe v1 AccountLink APIs.")

        link = service.create_connect_onboarding_link(
            account_id="acct_v2",
            refresh_url="https://app.koaryu.test/billing/connect/refresh",
            return_url="https://app.koaryu.test/billing?connect=return",
        )

        self.assertEqual(link["url"], "https://connect.stripe.test/v2/acct_v2")
        path, payload, idempotency_key = calls[0]
        self.assertEqual(path, "/v2/core/account_links")
        self.assertIsNone(idempotency_key)
        self.assertEqual(payload["account"], "acct_v2")
        self.assertEqual(payload["use_case"]["type"], "account_onboarding")
        onboarding = payload["use_case"]["account_onboarding"]
        self.assertEqual(onboarding["configurations"], ["merchant"])
        self.assertEqual(onboarding["collection_options"], {"fields": "eventually_due"})
        self.assertEqual(onboarding["refresh_url"], "https://app.koaryu.test/billing/connect/refresh")
        self.assertEqual(onboarding["return_url"], "https://app.koaryu.test/billing?connect=return")

    def test_connect_onboarding_link_falls_back_to_accounts_v1_when_accounts_v2_blocked(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        class _LegacyAccountLink:
            @staticmethod
            def create(**payload):
                calls.append(payload)
                return {"url": "https://connect.stripe.test/setup/acct_v1"}

        class _LegacyStripe:
            AccountLink = _LegacyAccountLink()

        def fake_v2_post(*_args, **_kwargs):
            raise _StripeV2RequestError(code="accounts_v2_access_blocked", message="blocked")

        service._stripe_v2_post = fake_v2_post
        service._stripe = lambda: _LegacyStripe

        link = service.create_connect_onboarding_link(
            account_id="acct_v1",
            refresh_url="https://app.koaryu.test/billing/connect/refresh",
            return_url="https://app.koaryu.test/billing?connect=return",
        )

        self.assertEqual(link["url"], "https://connect.stripe.test/setup/acct_v1")
        self.assertEqual(calls[0], {
            "account": "acct_v1",
            "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
            "return_url": "https://app.koaryu.test/billing?connect=return",
            "type": "account_onboarding",
        })

    def test_connected_account_branding_update_uses_accounts_v2(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        def fake_v2_patch(path, payload, *, idempotency_key=None):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2"}

        service._stripe_v2_patch = fake_v2_patch

        service.update_connect_account_branding(
            account_id="acct_v2",
            primary_color="#0B0D10",
            secondary_color="#D6B25E",
            icon_file_id="file_icon",
            logo_file_id="file_logo",
        )

        path, payload, idempotency_key = calls[0]
        self.assertEqual(path, "/v2/core/accounts/acct_v2")
        self.assertEqual(idempotency_key, "koaryu-connect-branding-acct_v2")
        self.assertEqual(payload["configuration"]["merchant"]["branding"], {
            "primary_color": "#0B0D10",
            "secondary_color": "#D6B25E",
            "icon": "file_icon",
            "logo": "file_logo",
        })

    def test_connected_account_branding_update_falls_back_to_accounts_v1(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        calls = []

        class _BrandingAccount:
            @staticmethod
            def modify(account_id, **payload):
                calls.append((account_id, payload))
                return {"id": account_id}

        class _BrandingStripe:
            Account = _BrandingAccount()

        def fake_v2_patch(*_args, **_kwargs):
            raise _StripeV2RequestError(code="accounts_v2_access_blocked", message="blocked")

        service._stripe_v2_patch = fake_v2_patch
        service._stripe = lambda: _BrandingStripe

        service.update_connect_account_branding(
            account_id="acct_v1",
            primary_color="#0B0D10",
            secondary_color="#D6B25E",
        )

        account_id, payload = calls[0]
        self.assertEqual(account_id, "acct_v1")
        self.assertEqual(payload["settings"]["branding"], {
            "primary_color": "#0B0D10",
            "secondary_color": "#D6B25E",
        })
        self.assertEqual(payload["idempotency_key"], "koaryu-connect-branding-acct_v1")

    def test_existing_connect_account_uses_default_refresh_and_return_urls_without_studio_lookup(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "onboarding_incomplete",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.onboarding_calls = []
        service._audit = lambda *_args, **_kwargs: self.fail("Hot onboarding path should not wait on audit writes.")

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            link = asyncio.run(service.create_connect_onboarding_link("studio_1", "user_1", business_entity_type="individual"))

        self.assertEqual(link.url, "https://connect.stripe.test/setup/acct_existing")
        self.assertEqual(_FakeStripeService.onboarding_calls[0]["refresh_url"], "https://app.koaryu.test/billing/connect/refresh")
        self.assertEqual(_FakeStripeService.onboarding_calls[0]["return_url"], "https://app.koaryu.test/billing?connect=return")

    def test_connect_onboarding_rejects_untrusted_redirect_urls(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "onboarding_incomplete",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.onboarding_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_connect_onboarding_link(
                    "studio_1",
                    "user_1",
                    refresh_url="https://evil.example/billing/connect/refresh",
                    return_url="https://app.koaryu.test/billing?connect=return",
                    business_entity_type="individual",
                ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("not allowed", context.exception.detail)
        self.assertEqual(_FakeStripeService.onboarding_calls, [])

    def test_connect_onboarding_validates_redirect_before_creating_account(self):
        service = self.service()
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": None,
                "status": "not_connected",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "studios": [{
                "id": "studio_1",
                "name": "River City Martial Arts",
                "owner_id": "owner_1",
            }],
        })
        _FakeStripeService.connect_account_calls = []
        _FakeStripeService.onboarding_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(service.create_connect_onboarding_link(
                    "studio_1",
                    "user_1",
                    refresh_url="https://evil.example/billing/connect/refresh",
                    return_url="https://app.koaryu.test/billing?connect=return",
                    business_entity_type="individual",
                ))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("not allowed", context.exception.detail)
        self.assertEqual(_FakeStripeService.connect_account_calls, [])
        self.assertEqual(_FakeStripeService.onboarding_calls, [])
        self.assertIsNone(service.supabase.tables["studio_payment_accounts"][0]["stripe_connected_account_id"])

    def test_connect_sync_projects_current_stripe_account_requirements(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "onboarding_incomplete",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": False,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["external_account"]},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.sync_connect_account("studio_1"))

        self.assertEqual(response.status, "action_required")
        self.assertEqual(_FakeStripeService.retrieve_calls, ["acct_existing"])
        self.assertFalse(response.charges_enabled)
        self.assertTrue(response.payouts_enabled)
        self.assertTrue(response.details_submitted)
        self.assertEqual(response.requirements_due, ["external_account"])

    def test_get_payment_account_refreshes_stale_connected_account(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
                "updated_at": "2026-01-01T00:00:00+00:00",
            }],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": False,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["individual.id_number"]},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.get_payment_account("studio_1"))

        self.assertEqual(_FakeStripeService.retrieve_calls, ["acct_existing"])
        self.assertEqual(response.status, "action_required")
        self.assertFalse(response.charges_enabled)
        self.assertEqual(response.requirements_due, ["individual.id_number"])

    def test_connect_ready_uses_live_stripe_status_before_hosted_actions(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": False,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["external_account"]},
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as context:
                service._ensure_connect_ready("studio_1")

        self.assertEqual(_FakeStripeService.retrieve_calls, ["acct_existing"])
        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("charges are not enabled", context.exception.detail)

    def test_billing_system_status_reports_live_readiness_and_webhook_health(self):
        service = self.service()
        now = datetime.now(timezone.utc)
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "STRIPE_SECRET_KEY": "sk_live_123",
            "STRIPE_KOARYU_CORE_PRICE_ID": "price_core",
            "STRIPE_PLATFORM_WEBHOOK_SECRET": "whsec_platform",
            "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
                "updated_at": now.isoformat(),
            }],
            "stripe_events": [
                {
                    "stripe_account_id": None,
                    "type": "customer.subscription.updated",
                    "processing_status": "processed",
                    "processed_at": now.isoformat(),
                    "created_at": now.isoformat(),
                },
                {
                    "stripe_account_id": "acct_existing",
                    "type": "invoice.paid",
                    "processing_status": "processed",
                    "processed_at": now.isoformat(),
                    "created_at": now.isoformat(),
                },
            ],
        })

        response = asyncio.run(service.get_system_status("studio_1"))

        self.assertTrue(response.ready_for_live_payments)
        self.assertEqual(response.payment_account.status, "charges_enabled")
        self.assertEqual(response.connect_webhooks.latest_event_type, "invoice.paid")
        self.assertIn("Supabase billing read", {check.name for check in response.checks})
        self.assertNotIn("Supabase write path", {check.name for check in response.checks})
        self.assertFalse([check for check in response.checks if check.status == "fail"])

    def test_billing_system_status_flags_stale_connect_webhook_processing(self):
        service = self.service()
        old = datetime.now(timezone.utc) - timedelta(minutes=20)
        service.settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "STRIPE_SECRET_KEY": "sk_live_123",
            "STRIPE_KOARYU_CORE_PRICE_ID": "price_core",
            "STRIPE_PLATFORM_WEBHOOK_SECRET": "whsec_platform",
            "STRIPE_CONNECT_WEBHOOK_SECRET": "whsec_connect",
        })()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }],
            "stripe_events": [{
                "stripe_account_id": "acct_existing",
                "type": "invoice.paid",
                "processing_status": "processing",
                "processed_at": None,
                "created_at": old.isoformat(),
            }],
        })

        response = asyncio.run(service.get_system_status("studio_1"))

        self.assertFalse(response.ready_for_live_payments)
        self.assertEqual(response.connect_webhooks.stale_processing_count, 1)

    def test_reconcile_invoice_by_stripe_id_repairs_local_projection(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_existing",
                "payer_id": "payer_1",
                "status": "draft",
                "amount_due_cents": 0,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 0,
                "currency": "usd",
            }],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1", "billing_status": "current", "balance_cents": 0}],
            "audit_logs": [],
        })
        _FakeStripeService.retrieve_calls = []
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.invoice_response = {
            "id": "in_1",
            "status": "open",
            "amount_due": 123,
            "amount_paid": 0,
            "amount_remaining": 123,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {"studio_id": "studio_1", "invoice_id": "invoice_1"},
            "created": 200,
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.reconcile_stripe_object(
                BillingReconcileRequest(object_type="invoice", stripe_object_id="in_1"),
                "studio_1",
                "user_1",
            ))

        self.assertEqual(response.local_object_id, "invoice_1")
        self.assertEqual(response.status, "open")
        self.assertEqual(service.supabase.tables["billing_invoices"][0]["amount_due_cents"], 123)
        self.assertEqual(service.supabase.tables["billing_payers"][0]["balance_cents"], 123)

    def test_reconcile_invoice_falls_back_to_stored_subscription_webhook_shape(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_existing",
                "status": "charges_enabled",
                "charges_enabled": True,
                "payouts_enabled": True,
                "details_submitted": True,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_invoices": [{
                "id": "invoice_1",
                "studio_id": "studio_1",
                "stripe_invoice_id": "in_1",
                "stripe_account_id": "acct_existing",
                "payer_id": "payer_1",
                "student_id": None,
                "enrollment_id": None,
                "invoice_type": "manual",
                "status": "paid",
                "amount_due_cents": 0,
                "amount_paid_cents": 0,
                "amount_remaining_cents": 0,
                "currency": "usd",
                "last_stripe_event_created": 400,
            }],
            "billing_subscriptions": [{
                "id": "subscription_1",
                "studio_id": "studio_1",
                "stripe_account_id": "acct_existing",
                "stripe_subscription_id": "sub_1",
                "current_period_start": None,
                "current_period_end": None,
                "last_stripe_event_created": 400,
            }],
            "student_billing_enrollments": [{
                "id": "enrollment_1",
                "studio_id": "studio_1",
                "student_id": "student_1",
                "stripe_subscription_item_id": "si_1",
            }],
            "billing_payers": [{"id": "payer_1", "studio_id": "studio_1", "billing_status": "current", "balance_cents": 0}],
            "billing_payments": [],
            "stripe_events": [{
                "stripe_account_id": "acct_existing",
                "type": "invoice.paid",
                "created_at": "2026-05-18T21:37:49+00:00",
                "payload": {"data": {"object": {
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
                                "product": "koaryu_payments",
                            },
                        },
                    },
                    "lines": {"data": [{
                        "metadata": {
                            "studio_id": "studio_1",
                            "payer_id": "payer_1",
                            "billing_subscription_id": "subscription_1",
                            "product": "koaryu_payments",
                        },
                        "parent": {
                            "type": "subscription_item_details",
                            "subscription_item_details": {
                                "subscription": "sub_1",
                                "subscription_item": "si_1",
                                "proration": False,
                            },
                        },
                        "period": {"start": 1779140262, "end": 1781818662},
                    }]},
                    "created": 300,
                }}},
            }],
            "audit_logs": [],
        })
        _FakeStripeService.retrieve_account_response = {
            "id": "acct_existing",
            "charges_enabled": True,
            "payouts_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": []},
        }
        _FakeStripeService.invoice_response = {
            "id": "in_1",
            "status": "paid",
            "amount_due": 200,
            "amount_paid": 200,
            "amount_remaining": 0,
            "currency": "usd",
            "customer": "cus_1",
            "metadata": {},
            "created": 300,
        }

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            response = asyncio.run(service.reconcile_stripe_object(
                BillingReconcileRequest(object_type="invoice", stripe_object_id="in_1"),
                "studio_1",
                "user_1",
            ))

        invoice = service.supabase.tables["billing_invoices"][0]
        subscription = service.supabase.tables["billing_subscriptions"][0]
        self.assertEqual(response.local_object_id, "invoice_1")
        self.assertEqual(invoice["stripe_subscription_id"], "sub_1")
        self.assertEqual(invoice["status"], "paid")
        self.assertEqual(invoice["amount_paid_cents"], 200)
        self.assertEqual(invoice["invoice_type"], "tuition")
        self.assertEqual(invoice["student_id"], "student_1")
        self.assertEqual(invoice["enrollment_id"], "enrollment_1")
        self.assertEqual(subscription["current_period_start"], "2026-05-18T21:37:42+00:00")
        self.assertEqual(subscription["current_period_end"], "2026-06-18T21:37:42+00:00")
        self.assertEqual(subscription["last_stripe_event_created"], 400)

    def test_connect_reset_clears_stale_account_when_no_stripe_history_exists(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_stale",
                "status": "action_required",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": ["external_account"],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_plans": [],
            "billing_payers": [],
            "billing_subscriptions": [],
            "billing_invoices": [],
            "billing_payments": [],
            "billing_refunds": [],
            "billing_disputes": [],
            "audit_logs": [],
        })

        response = asyncio.run(service.reset_connect_account("studio_1", "user_1"))

        self.assertEqual(response.status, "not_connected")
        self.assertIsNone(response.stripe_connected_account_id)
        self.assertEqual(
            service.supabase.tables["studio_payment_accounts"][0]["metadata"]["previous_stripe_connected_account_ids"],
            ["acct_stale"],
        )
        self.assertEqual(
            service.supabase.tables["studio_payment_accounts"][0]["metadata"]["connect_account_generation"],
            2,
        )

    def test_connect_reset_blocks_when_stripe_history_exists(self):
        service = self.service()
        service.supabase = _FakeSupabase({
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_stale",
                "status": "action_required",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {},
            }],
            "billing_plans": [{"id": "plan_1", "studio_id": "studio_1", "stripe_price_id": "price_1"}],
            "billing_payers": [],
            "billing_subscriptions": [],
            "billing_invoices": [],
            "billing_payments": [],
            "billing_refunds": [],
            "billing_disputes": [],
        })

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.reset_connect_account("studio_1", "user_1"))

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("already has Stripe billing history", context.exception.detail)

    def test_stale_connected_account_returns_actionable_conflict(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_live_123"})()
        service._stripe = lambda: _FakeStripeWithMismatchedAccount

        with self.assertRaises(HTTPException) as context:
            service.create_connect_dashboard_url(account_id="acct_from_other_platform")

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("Reconnect Stripe Payments in live mode", context.exception.detail)
