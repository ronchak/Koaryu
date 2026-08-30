from __future__ import annotations

from app.services.studio_live_billing_authorizations import ConnectOnboardingBootstrapContext

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


class _BootstrapLifecycleSupabase(_FakeSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.bootstrap_id = "bootstrap_1"
        self.bootstrap = None
        self.bootstrap_create = None
        self.bootstrap_link = None
        self.fail_bind_once = False
        self.force_support_required = False
        self.bootstrap_response = None
        self.delivery_receipt_sha256 = None
        self.bootstrap_delivered = False
        self.ordinary_authorized = False

    def _recovery_row(self):
        if self.bootstrap is None or self.bootstrap_delivered:
            return []
        return [{
            "bootstrap_id": self.bootstrap_id,
            "studio_id": self.bootstrap["p_studio_id"],
            "connect_account_generation": self.bootstrap["p_connect_account_generation"],
            "recovery_context": self.bootstrap["p_recovery_context"],
            "account_create_idempotency_key": self.bootstrap["p_account_create_idempotency_key"],
            "initial_link_idempotency_key": self.bootstrap["p_initial_link_idempotency_key"],
            "stripe_connected_account_id": self.bootstrap.get("stripe_connected_account_id"),
            "phase": (
                "initial_link_delivery_pending" if self.bootstrap_response
                else "initial_link_retry" if self.bootstrap.get("stripe_connected_account_id")
                else "account_create"
            ),
        }]

    def _rpc_load_connect_onboarding_bootstrap_recovery_context(self, params):
        if self.bootstrap is None or params["p_candidate_sha"] != self.bootstrap["p_candidate_sha"]:
            return []
        return self._recovery_row()

    def _rpc_preflight_connect_onboarding_bootstrap_resume(self, params):
        if self.force_support_required:
            return [{
                "eligible": False,
                "studio_id": params["p_studio_id"],
                "connect_account_generation": 1,
                "phase": "support_required",
            }]
        if self.bootstrap is None:
            return [{
                "eligible": False,
                "studio_id": params["p_studio_id"],
                "connect_account_generation": 1,
                "phase": "none",
            }]
        if self.bootstrap_delivered:
            return [{
                "eligible": False,
                "studio_id": params["p_studio_id"],
                "connect_account_generation": self.bootstrap["p_connect_account_generation"],
                "phase": "completed",
            }]
        return [{
            "eligible": params["p_candidate_sha"] == self.bootstrap["p_candidate_sha"],
            "studio_id": params["p_studio_id"],
            "connect_account_generation": self.bootstrap["p_connect_account_generation"],
            "phase": (
                "initial_link_delivery_pending" if self.bootstrap_response
                else "initial_link_retry" if self.bootstrap.get("stripe_connected_account_id")
                else "account_create"
            ),
        }]

    def _rpc_prepare_connect_onboarding_bootstrap_atomic(self, params):
        if self.bootstrap is None:
            self.bootstrap = dict(params)
        elif any(self.bootstrap.get(key) != value for key, value in params.items()):
            return []
        return self._recovery_row()

    def _rpc_authorize_connect_onboarding_bootstrap_account_create_v2(self, params):
        if self.bootstrap is None or params != {
            "p_bootstrap_id": self.bootstrap_id,
            "p_studio_id": self.bootstrap["p_studio_id"],
            "p_candidate_sha": self.bootstrap["p_candidate_sha"],
            "p_connect_account_generation": self.bootstrap["p_connect_account_generation"],
            "p_account_create_payload_sha256": self.bootstrap["p_account_create_payload_sha256"],
            "p_account_create_idempotency_key": self.bootstrap["p_account_create_idempotency_key"],
        }:
            return []
        if self.bootstrap_create is None:
            self.bootstrap_create = dict(params)
        elif self.bootstrap_create != params:
            return []
        return [{
            "authorized": True,
            "studio_id": params["p_studio_id"],
            "checkpoint_id": "checkpoint_1",
            "bootstrap_id": self.bootstrap_id,
        }]

    def _rpc_bind_connect_onboarding_bootstrap_account_v2(self, params):
        if self.fail_bind_once:
            self.fail_bind_once = False
            raise RuntimeError("simulated bind interruption")
        if (
            not self.bootstrap_create
            or params["p_bootstrap_id"] != self.bootstrap_id
            or params["p_studio_id"] != self.bootstrap["p_studio_id"]
            or params["p_candidate_sha"] != self.bootstrap["p_candidate_sha"]
            or params["p_connect_account_generation"] != self.bootstrap["p_connect_account_generation"]
        ):
            return []
        row = next(
            row for row in self.tables["studio_payment_accounts"]
            if row["studio_id"] == params["p_studio_id"]
        )
        row.update({
            "stripe_connected_account_id": params["p_stripe_connected_account_id"],
            "status": "onboarding_incomplete",
            "metadata": {
                **(row.get("metadata") or {}),
                "business_entity_type": params["p_business_entity_type"],
                "connect_account_generation": params["p_connect_account_generation"],
            },
        })
        self.bootstrap["stripe_connected_account_id"] = params["p_stripe_connected_account_id"]
        return [dict(row)]

    def _rpc_authorize_connect_onboarding_bootstrap_initial_link_v2(self, params):
        if (
            not self.bootstrap_create
            or params["p_bootstrap_id"] != self.bootstrap_id
            or params["p_stripe_connected_account_id"] != self.bootstrap.get("stripe_connected_account_id")
            or params["p_initial_link_context_sha256"] != self.bootstrap["p_initial_link_context_sha256"]
            or params["p_initial_link_idempotency_key"] != self.bootstrap["p_initial_link_idempotency_key"]
        ):
            return []
        if self.bootstrap_link is None:
            self.bootstrap_link = dict(params)
        elif self.bootstrap_link != params:
            return []
        return [{
            "authorized": True,
            "studio_id": params["p_studio_id"],
            "checkpoint_id": "checkpoint_1",
            "bootstrap_id": self.bootstrap_id,
        }]

    def _rpc_record_connect_onboarding_bootstrap_initial_link_response(self, params):
        if (
            self.bootstrap_delivered
            or self.bootstrap_link is None
            or params["p_bootstrap_id"] != self.bootstrap_id
            or params["p_studio_id"] != self.bootstrap["p_studio_id"]
            or params["p_candidate_sha"] != self.bootstrap["p_candidate_sha"]
            or params["p_connect_account_generation"] != self.bootstrap["p_connect_account_generation"]
            or params["p_stripe_connected_account_id"] != self.bootstrap.get("stripe_connected_account_id")
            or params["p_initial_link_context_sha256"] != self.bootstrap["p_initial_link_context_sha256"]
            or params["p_initial_link_payload_sha256"] != self.bootstrap_link["p_initial_link_payload_sha256"]
            or params["p_initial_link_idempotency_key"] != self.bootstrap["p_initial_link_idempotency_key"]
        ):
            return []
        if self.bootstrap_response not in (None, params["p_initial_link_response_sha256"]):
            self.force_support_required = True
            return []
        self.bootstrap_response = params["p_initial_link_response_sha256"]
        self.delivery_receipt_sha256 = params["p_delivery_receipt_sha256"]
        return [{
            "recorded": True,
            "studio_id": params["p_studio_id"],
            "bootstrap_id": self.bootstrap_id,
        }]

    def _rpc_acknowledge_connect_onboarding_bootstrap_initial_link_delivery(self, params):
        if (
            self.force_support_required
            or params["p_studio_id"] != self.bootstrap["p_studio_id"]
            or params["p_candidate_sha"] != self.bootstrap["p_candidate_sha"]
            or params["p_delivery_receipt_sha256"] != self.delivery_receipt_sha256
        ):
            return []
        self.bootstrap_delivered = True
        return [{
            "acknowledged": True,
            "studio_id": params["p_studio_id"],
            "bootstrap_id": self.bootstrap_id,
        }]

    def _rpc_authorize_studio_live_billing_mutation_atomic(self, params):
        bootstrap_operation = params["p_operation"] in {
            "connect_account.create",
            "connect_onboarding_link.create",
        }
        if not self.ordinary_authorized and not (
            bootstrap_operation
            and self.bootstrap is not None
            and params["p_studio_id"] == self.bootstrap["p_studio_id"]
            and params["p_candidate_sha"] == self.bootstrap["p_candidate_sha"]
        ):
            return []
        return [{
            "authorized": True,
            "studio_id": params["p_studio_id"],
            "checkpoint_id": "checkpoint_2",
        }]


class BillingConnectLifecycleTest(BillingPaymentsLifecycleTestBase):
    def test_live_first_onboarding_runs_real_policy_rpc_chain_and_only_mocks_provider_transport(self):
        studio_id = "11111111-1111-4111-8111-111111111111"
        settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
            "STRIPE_MODE": "live",
            "STRIPE_SECRET_KEY": "sk_live_contract",
            "LIVE_BILLING_ENABLED": True,
        })()
        supabase = _BootstrapLifecycleSupabase({
            "studio_payment_accounts": [{
                "studio_id": studio_id,
                "stripe_connected_account_id": None,
                "status": "not_connected",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 1},
            }],
            "studios": [{"id": studio_id, "name": "Policy Chain Studio", "owner_id": "owner_1"}],
        })
        provider_calls = []

        def provider_transport(_settings, method, path, payload, *, idempotency_key=None):
            provider_calls.append((method, path, payload, idempotency_key))
            if path == "/v2/core/accounts":
                return {"id": "acct_BootstrapPolicy1"}
            return {"url": "https://connect.stripe.test/bootstrap"}

        with patch("app.services.billing_service.get_settings", return_value=settings), patch(
            "app.services.stripe_service.get_settings", return_value=settings
        ), patch("app.services.stripe_service.stripe_v2_request", side_effect=provider_transport), patch.dict(
            "os.environ", {"RENDER_GIT_COMMIT": "a" * 40}, clear=False
        ):
            service = BillingService(supabase)
            link = asyncio.run(service.create_connect_onboarding_link(
                studio_id,
                "actor_1",
                business_entity_type="individual",
            ))
            acknowledgement = asyncio.run(
                service.acknowledge_connect_onboarding_link_delivery(
                    studio_id,
                    link.delivery_receipt,
                )
            )

        self.assertEqual(link.pending_url, "https://connect.stripe.test/bootstrap")
        self.assertRegex(link.delivery_receipt, r"^[A-Za-z0-9_-]{43,128}$")
        self.assertTrue(acknowledgement.acknowledged)
        self.assertEqual([name for name, _params in supabase.rpc_calls], [
            "preflight_connect_onboarding_bootstrap_resume",
            "prepare_connect_onboarding_bootstrap_atomic",
            "authorize_studio_live_billing_mutation_atomic",
            "authorize_connect_onboarding_bootstrap_account_create_v2",
            "bind_connect_onboarding_bootstrap_account_v2",
            "authorize_studio_live_billing_mutation_atomic",
            "authorize_connect_onboarding_bootstrap_initial_link_v2",
            "record_connect_onboarding_bootstrap_initial_link_response",
            "acknowledge_connect_onboarding_bootstrap_initial_link_delivery",
        ])
        self.assertTrue(supabase.bootstrap_delivered)
        self.assertEqual(supabase.tables["studio_payment_accounts"][0]["stripe_connected_account_id"], "acct_BootstrapPolicy1")
        self.assertEqual(len(provider_calls), 2)
        self.assertEqual(provider_calls[0][3], supabase.bootstrap_create["p_account_create_idempotency_key"])
        self.assertEqual(provider_calls[1][3], supabase.bootstrap_link["p_initial_link_idempotency_key"])
        self.assertEqual(
            supabase.bootstrap["p_initial_link_idempotency_key"],
            supabase.bootstrap_link["p_initial_link_idempotency_key"],
        )

    def test_live_onboarding_recovers_each_interrupted_phase_with_one_row_and_same_keys(self):
        studio_id = "11111111-1111-4111-8111-111111111111"
        settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
            "STRIPE_MODE": "live",
            "STRIPE_SECRET_KEY": "sk_live_contract",
            "LIVE_BILLING_ENABLED": True,
        })()

        for interrupted_phase in ("account_create", "bind", "initial_link"):
            with self.subTest(interrupted_phase=interrupted_phase):
                supabase = _BootstrapLifecycleSupabase({
                    "studio_payment_accounts": [{
                        "studio_id": studio_id,
                        "stripe_connected_account_id": None,
                        "status": "not_connected",
                        "charges_enabled": False,
                        "payouts_enabled": False,
                        "details_submitted": False,
                        "requirements_due": [],
                        "platform_fee_bps": 50,
                        "metadata": {"connect_account_generation": 1},
                    }],
                    "studios": [{"id": studio_id, "name": "Recovery Studio", "owner_id": "owner_1"}],
                })
                provider_calls = []
                failed_once = False
                supabase.fail_bind_once = interrupted_phase == "bind"

                def provider_transport(_settings, method, path, payload, *, idempotency_key=None):
                    nonlocal failed_once
                    provider_calls.append((method, path, payload, idempotency_key))
                    path_should_fail = (
                        (interrupted_phase == "account_create" and path == "/v2/core/accounts")
                        or (interrupted_phase == "initial_link" and path == "/v2/core/account_links")
                    )
                    if path_should_fail and not failed_once:
                        failed_once = True
                        raise _StripeV2RequestError(code=None, message="response outcome unknown")
                    if path == "/v2/core/accounts":
                        return {"id": "acct_Recovered1"}
                    return {"url": "https://connect.stripe.test/recovered"}

                with patch("app.services.billing_service.get_settings", return_value=settings), patch(
                    "app.services.stripe_service.get_settings", return_value=settings
                ), patch("app.services.stripe_service.stripe_v2_request", side_effect=provider_transport), patch.dict(
                    "os.environ", {"RENDER_GIT_COMMIT": "a" * 40}, clear=False
                ):
                    service = BillingService(supabase)
                    with self.assertRaises(HTTPException):
                        asyncio.run(service.create_connect_onboarding_link(
                            studio_id,
                            "actor_1",
                            business_entity_type="individual",
                        ))
                    link = asyncio.run(service.create_connect_onboarding_link(
                        studio_id,
                        "actor_1",
                        business_entity_type="individual",
                    ))

                self.assertEqual(link.pending_url, "https://connect.stripe.test/recovered")
                self.assertRegex(link.delivery_receipt, r"^[A-Za-z0-9_-]{43,128}$")
                prepare_calls = [params for name, params in supabase.rpc_calls if name == "prepare_connect_onboarding_bootstrap_atomic"]
                self.assertEqual(len(prepare_calls), 1)
                account_calls = [call for call in provider_calls if call[1] == "/v2/core/accounts"]
                link_calls = [call for call in provider_calls if call[1] == "/v2/core/account_links"]
                self.assertTrue(account_calls)
                self.assertTrue(link_calls)
                self.assertEqual({call[3] for call in account_calls}, {supabase.bootstrap["p_account_create_idempotency_key"]})
                self.assertEqual({call[3] for call in link_calls}, {supabase.bootstrap["p_initial_link_idempotency_key"]})
                self.assertEqual(len(account_calls), 2 if interrupted_phase in {"account_create", "bind"} else 1)
                self.assertEqual(len(link_calls), 2 if interrupted_phase == "initial_link" else 1)
                self.assertEqual(supabase.bootstrap["stripe_connected_account_id"], "acct_Recovered1")

    def test_live_onboarding_recovery_rejects_cross_context_without_provider_call(self):
        studio_id = "11111111-1111-4111-8111-111111111111"
        settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
            "STRIPE_MODE": "live",
            "STRIPE_SECRET_KEY": "sk_live_contract",
            "LIVE_BILLING_ENABLED": True,
        })()
        supabase = _BootstrapLifecycleSupabase({
            "studio_payment_accounts": [{
                "studio_id": studio_id,
                "stripe_connected_account_id": None,
                "status": "not_connected",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 1},
            }],
            "studios": [{"id": studio_id, "name": "Recovery Studio", "owner_id": "owner_1"}],
        })
        provider_calls = []

        def provider_transport(_settings, method, path, payload, *, idempotency_key=None):
            provider_calls.append((method, path, payload, idempotency_key))
            raise _StripeV2RequestError(code=None, message="response outcome unknown")

        with patch("app.services.billing_service.get_settings", return_value=settings), patch(
            "app.services.stripe_service.get_settings", return_value=settings
        ), patch("app.services.stripe_service.stripe_v2_request", side_effect=provider_transport), patch.dict(
            "os.environ", {"RENDER_GIT_COMMIT": "a" * 40}, clear=False
        ):
            service = BillingService(supabase)
            with self.assertRaises(HTTPException):
                asyncio.run(service.create_connect_onboarding_link(
                    studio_id,
                    "actor_1",
                    business_entity_type="individual",
                ))
            calls_before = len(provider_calls)
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(service.create_connect_onboarding_link(
                    studio_id,
                    "actor_1",
                    return_url="https://app.koaryu.test/billing?connect=different",
                    business_entity_type="individual",
                ))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(len(provider_calls), calls_before)

    def test_lost_initial_link_response_rotates_receipt_then_retires_to_ordinary_authorization(self):
        studio_id = "11111111-1111-4111-8111-111111111111"
        settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
            "STRIPE_MODE": "live",
            "STRIPE_SECRET_KEY": "sk_live_contract",
            "LIVE_BILLING_ENABLED": True,
        })()
        supabase = _BootstrapLifecycleSupabase({
            "studio_payment_accounts": [{
                "studio_id": studio_id,
                "stripe_connected_account_id": None,
                "status": "not_connected",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 1},
            }],
            "studios": [{"id": studio_id, "name": "Recovery Studio", "owner_id": "owner_1"}],
        })
        provider_calls = []

        def provider_transport(_settings, method, path, payload, *, idempotency_key=None):
            provider_calls.append((method, path, payload, idempotency_key))
            if path == "/v2/core/accounts":
                return {"id": "acct_Recovered1"}
            return {"url": "https://connect.stripe.test/recovered"}

        with patch("app.services.billing_service.get_settings", return_value=settings), patch(
            "app.services.stripe_service.get_settings", return_value=settings
        ), patch("app.services.stripe_service.stripe_v2_request", side_effect=provider_transport), patch.dict(
            "os.environ", {"RENDER_GIT_COMMIT": "a" * 40}, clear=False
        ):
            service = BillingService(supabase)
            first = asyncio.run(service.create_connect_onboarding_link(
                studio_id,
                "actor_1",
                business_entity_type="individual",
            ))
            second = asyncio.run(service.create_connect_onboarding_link(
                studio_id,
                "actor_1",
                business_entity_type="individual",
            ))
            self.assertNotEqual(first.delivery_receipt, second.delivery_receipt)
            with self.assertRaises(HTTPException) as stale:
                asyncio.run(service.acknowledge_connect_onboarding_link_delivery(
                    studio_id,
                    first.delivery_receipt,
                ))
            self.assertEqual(stale.exception.status_code, 409)
            acknowledged = asyncio.run(service.acknowledge_connect_onboarding_link_delivery(
                studio_id,
                second.delivery_receipt,
            ))
            self.assertTrue(acknowledged.acknowledged)

            supabase.ordinary_authorized = True
            later = asyncio.run(service.create_connect_onboarding_link(
                studio_id,
                "actor_1",
                request_idempotency_key="fresh-later-request",
            ))

        self.assertIsNone(later.delivery_receipt)
        link_keys = [call[3] for call in provider_calls if call[1] == "/v2/core/account_links"]
        self.assertEqual(link_keys[:2], [supabase.bootstrap["p_initial_link_idempotency_key"]] * 2)
        self.assertNotEqual(link_keys[2], supabase.bootstrap["p_initial_link_idempotency_key"])
        self.assertIn("fresh-later-request", link_keys[2])
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls].count(
                "prepare_connect_onboarding_bootstrap_atomic"
            ),
            1,
        )

    def test_live_onboarding_expired_recovery_is_support_required_without_second_provider_call(self):
        studio_id = "11111111-1111-4111-8111-111111111111"
        settings = type("Settings", (), {
            "BILLING_PLATFORM_FEE_BPS": 50,
            "FRONTEND_URL": "https://app.koaryu.test",
            "STRIPE_MODE": "live",
            "STRIPE_SECRET_KEY": "sk_live_contract",
            "LIVE_BILLING_ENABLED": True,
        })()
        supabase = _BootstrapLifecycleSupabase({
            "studio_payment_accounts": [{
                "studio_id": studio_id,
                "stripe_connected_account_id": None,
                "status": "not_connected",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
                "requirements_due": [],
                "platform_fee_bps": 50,
                "metadata": {"connect_account_generation": 1},
            }],
            "studios": [{"id": studio_id, "name": "Recovery Studio", "owner_id": "owner_1"}],
        })
        provider_calls = []

        def provider_transport(_settings, method, path, payload, *, idempotency_key=None):
            provider_calls.append((method, path, payload, idempotency_key))
            raise _StripeV2RequestError(code=None, message="response outcome unknown")

        with patch("app.services.billing_service.get_settings", return_value=settings), patch(
            "app.services.stripe_service.get_settings", return_value=settings
        ), patch("app.services.stripe_service.stripe_v2_request", side_effect=provider_transport), patch.dict(
            "os.environ", {"RENDER_GIT_COMMIT": "a" * 40}, clear=False
        ):
            service = BillingService(supabase)
            with self.assertRaises(HTTPException):
                asyncio.run(service.create_connect_onboarding_link(
                    studio_id,
                    "actor_1",
                    business_entity_type="individual",
                ))
            supabase.force_support_required = True
            calls_before = len(provider_calls)
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(service.create_connect_onboarding_link(
                    studio_id,
                    "actor_1",
                    business_entity_type="individual",
                ))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(len(provider_calls), calls_before)

    def test_standard_connect_account_uses_account_holder_dashboard_url(self):
        _FakeStripe.reset()
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        service._stripe = lambda: _FakeStripe

        url = service.create_connect_dashboard_url(account_id="acct_connected", studio_id="studio_1")

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

        link = service.create_connect_dashboard_link(account_id="acct_connected", studio_id="studio_1")

        self.assertEqual(link, {
            "url": "https://dashboard.stripe.com/test",
        })
        self.assertNotIn(("create_login_link", "acct_connected"), _FakeStripe.Account.calls)
        self.assertNotIn(("retrieve", None), _FakeStripe.Account.calls)

    def test_connect_account_creation_uses_accounts_v2_full_dashboard(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None, **_context):
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
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None, **_context):
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

    def test_bootstrap_connect_account_falls_back_to_accounts_v1_when_accounts_v2_blocked(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        calls = []

        class _LegacyAccount:
            @staticmethod
            def create(**payload):
                calls.append(payload)
                return {"id": "acct_v1"}

        class _LegacyStripe:
            Account = _LegacyAccount()

        def fake_v2_post(*_args, **_kwargs):
            raise _StripeV2RequestError(code="accounts_v2_access_blocked", message="blocked")

        bootstrap_context = ConnectOnboardingBootstrapContext(
            bootstrap_id="11111111-1111-4111-8111-111111111111",
            account_generation=2,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g2",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g2-" + "c" * 24,
        )
        service._stripe_v2_post = fake_v2_post
        service._stripe = lambda: _LegacyStripe

        account = service.create_connect_account(
            studio_id="studio_1",
            business_name="River City Martial Arts",
            contact_email="owner@example.com",
            business_entity_type="company",
            account_generation=2,
            bootstrap_context=bootstrap_context,
        )

        self.assertEqual(account["id"], "acct_v1")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["idempotency_key"], bootstrap_context.account_create_idempotency_key)
        self.assertEqual(calls[0]["metadata"]["studio_id"], "studio_1")

    def test_connect_onboarding_link_uses_accounts_v2_account_links(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        calls = []

        def fake_v2_post(path, payload, *, idempotency_key=None, **_context):
            calls.append((path, payload, idempotency_key))
            return {"url": "https://connect.stripe.test/v2/acct_v2", "object": "v2.core.account_link"}

        service._stripe_v2_post = fake_v2_post
        service._stripe = lambda: self.fail("Accounts v2 onboarding must not call Stripe v1 AccountLink APIs.")

        link = service.create_connect_onboarding_link(
            account_id="acct_v2",
            studio_id="studio_1",
            refresh_url="https://app.koaryu.test/billing/connect/refresh",
            return_url="https://app.koaryu.test/billing?connect=return",
            idempotency_key="ordinary-link-key",
        )

        self.assertEqual(link["url"], "https://connect.stripe.test/v2/acct_v2")
        path, payload, idempotency_key = calls[0]
        self.assertEqual(path, "/v2/core/account_links")
        self.assertEqual(idempotency_key, "ordinary-link-key")
        self.assertEqual(payload["account"], "acct_v2")
        self.assertEqual(payload["use_case"]["type"], "account_onboarding")
        onboarding = payload["use_case"]["account_onboarding"]
        self.assertEqual(onboarding["configurations"], ["merchant"])
        self.assertEqual(onboarding["collection_options"], {"fields": "eventually_due"})
        self.assertEqual(onboarding["refresh_url"], "https://app.koaryu.test/billing/connect/refresh")
        self.assertEqual(onboarding["return_url"], "https://app.koaryu.test/billing?connect=return")

    def test_connect_onboarding_link_falls_back_to_accounts_v1_when_accounts_v2_blocked(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
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
            studio_id="studio_1",
            refresh_url="https://app.koaryu.test/billing/connect/refresh",
            return_url="https://app.koaryu.test/billing?connect=return",
            idempotency_key="ordinary-link-key",
        )

        self.assertEqual(link["url"], "https://connect.stripe.test/setup/acct_v1")
        self.assertEqual(calls[0], {
            "account": "acct_v1",
            "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
            "return_url": "https://app.koaryu.test/billing?connect=return",
            "type": "account_onboarding",
            "idempotency_key": "ordinary-link-key",
        })

    def test_bootstrap_onboarding_link_falls_back_to_accounts_v1_with_stored_idempotency(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
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

        bootstrap_context = ConnectOnboardingBootstrapContext(
            bootstrap_id="11111111-1111-4111-8111-111111111111",
            account_generation=2,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g2",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g2-" + "c" * 24,
        )
        service._stripe_v2_post = fake_v2_post
        service._stripe = lambda: _LegacyStripe

        link = service.create_connect_onboarding_link(
            account_id="acct_v1",
            studio_id="studio_1",
            refresh_url="https://app.koaryu.test/billing/connect/refresh",
            return_url="https://app.koaryu.test/billing?connect=return",
            bootstrap_context=bootstrap_context,
        )

        self.assertEqual(link["url"], "https://connect.stripe.test/setup/acct_v1")
        self.assertEqual(calls[0]["idempotency_key"], bootstrap_context.initial_link_idempotency_key)

    def test_connected_account_branding_update_uses_accounts_v2(self):
        service = StripeService()
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
        calls = []

        def fake_v2_patch(path, payload, *, idempotency_key=None, **_context):
            calls.append((path, payload, idempotency_key))
            return {"id": "acct_v2"}

        service._stripe_v2_patch = fake_v2_patch

        service.update_connect_account_branding(
            account_id="acct_v2",
            studio_id="studio_1",
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
        service.settings = type("Settings", (), {"STRIPE_SECRET_KEY": "sk_test_123"})()
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
            studio_id="studio_1",
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
            link = asyncio.run(service.create_connect_onboarding_link(
                "studio_1",
                "user_1",
                business_entity_type="individual",
                request_idempotency_key="ordinary-request-1",
            ))

        self.assertEqual(link.pending_url, "https://connect.stripe.test/setup/acct_existing")
        self.assertIsNone(link.delivery_receipt)
        self.assertEqual(_FakeStripeService.onboarding_calls[0]["refresh_url"], "https://app.koaryu.test/billing/connect/refresh")
        self.assertEqual(_FakeStripeService.onboarding_calls[0]["return_url"], "https://app.koaryu.test/billing?connect=return")
        self.assertIn("ordinary-request-1", _FakeStripeService.onboarding_calls[0]["idempotency_key"])

    def test_existing_connect_account_requires_caller_key_before_provider_call(self):
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
                "metadata": {"connect_account_generation": 2},
            }],
        })
        _FakeStripeService.onboarding_calls = []

        with patch("app.services.billing_service.StripeService", _FakeStripeService):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(service.create_connect_onboarding_link("studio_1", "user_1"))

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("Idempotency-Key", raised.exception.detail)
        self.assertEqual(_FakeStripeService.onboarding_calls, [])

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

    def test_billing_system_status_reports_live_mode_closed_and_webhook_health(self):
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
                    "livemode": True,
                    "processing_status": "processed",
                    "processed_at": now.isoformat(),
                    "created_at": now.isoformat(),
                },
                {
                    "stripe_account_id": "acct_existing",
                    "type": "invoice.paid",
                    "livemode": True,
                    "processing_status": "processed",
                    "processed_at": now.isoformat(),
                    "created_at": now.isoformat(),
                },
            ],
        })

        response = asyncio.run(service.get_system_status("studio_1"))

        self.assertEqual(response.configured_stripe_mode, "live")
        self.assertFalse(response.ready_for_configured_mode)
        self.assertFalse(response.live_payments_authorized)
        self.assertFalse(response.ready_for_live_payments)
        self.assertEqual(response.payment_account.status, "charges_enabled")
        self.assertEqual(response.connect_webhooks.latest_event_type, "invoice.paid")
        self.assertIn("Supabase billing read", {check.name for check in response.checks})
        self.assertNotIn("Supabase write path", {check.name for check in response.checks})
        outbound_check = next(
            check for check in response.checks if check.name == "Stripe outbound mutations"
        )
        self.assertEqual(outbound_check.status, "fail")

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
                "livemode": True,
                "processing_status": "processing",
                "processing_started_at": old.isoformat(),
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
            service.create_connect_dashboard_url(account_id="acct_from_other_platform", studio_id="studio_1")

        self.assertEqual(context.exception.status_code, 409)
        self.assertIn("Reconnect Stripe Payments in live mode", context.exception.detail)
