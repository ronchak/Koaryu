from __future__ import annotations

import unittest

from fastapi import HTTPException

from app.services.studio_live_billing_authorizations import (
    ConnectOnboardingBootstrapContext,
    LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL,
    LIVE_SCOPE_DENIED_DETAIL,
    StudioLiveBillingAuthorizationStore,
)
from tests.fakes.supabase import RpcBackedSupabase


CANDIDATE_SHA = "a" * 40


class _AuthorizationSupabase(RpcBackedSupabase):
    def __init__(self, response=None, *, failure: Exception | None = None):
        super().__init__()
        self.response = response
        self.failure = failure

    def _rpc_authorize_studio_live_billing_mutation_atomic(self, _params):
        if self.failure:
            raise self.failure
        return self.response

    def _rpc_authorize_connect_onboarding_bootstrap_account_create(self, _params):
        if self.failure:
            raise self.failure
        return self.response

    def _rpc_authorize_connect_onboarding_bootstrap_initial_link(self, _params):
        if self.failure:
            raise self.failure
        return self.response

    def _rpc_bind_connect_onboarding_bootstrap_account(self, _params):
        if self.failure:
            raise self.failure
        return self.response


class StudioLiveBillingAuthorizationStoreTest(unittest.TestCase):
    def test_live_authorization_delegates_exact_context_to_atomic_rpc(self):
        supabase = _AuthorizationSupabase([{
            "authorized": True,
            "studio_id": "studio_1",
            "checkpoint_id": "checkpoint_1",
        }])
        store = StudioLiveBillingAuthorizationStore(
            supabase,
            expected_candidate_sha=CANDIDATE_SHA,
        )

        studio_id = store.authorize(
            operation="connected_invoice.pay",
            scope="connect_payments",
            studio_id="studio_1",
            account_id="acct_1",
            expected_livemode=True,
        )

        self.assertEqual(studio_id, "studio_1")
        self.assertEqual(supabase.rpc_calls, [(
            "authorize_studio_live_billing_mutation_atomic",
            {
                "p_studio_id": "studio_1",
                "p_operation": "connected_invoice.pay",
                "p_scope": "connect_payments",
                "p_stripe_connected_account_id": "acct_1",
                "p_candidate_sha": CANDIDATE_SHA,
            },
        )])
        self.assertEqual(supabase.query_log, [])

    def test_accountless_connect_create_uses_same_atomic_policy_chain(self):
        supabase = _AuthorizationSupabase([{
            "authorized": True,
            "studio_id": "studio_1",
            "checkpoint_id": "checkpoint_1",
        }])

        context = ConnectOnboardingBootstrapContext(
            token="t" * 43,
            account_generation=1,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g1",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g1-" + "c" * 24,
        )
        self.assertEqual(
            StudioLiveBillingAuthorizationStore(
                supabase,
                expected_candidate_sha=CANDIDATE_SHA,
            ).authorize(
                operation="connect_account.create",
                scope="connect_onboarding",
                studio_id="studio_1",
                account_id=None,
                expected_livemode=True,
                payload_sha256="d" * 64,
                bootstrap_context=context,
            ),
            "studio_1",
        )
        self.assertEqual(supabase.rpc_calls[0][0], "authorize_connect_onboarding_bootstrap_account_create")
        self.assertEqual(supabase.rpc_calls[0][1]["p_bootstrap_token"], context.token)
        self.assertEqual(supabase.rpc_calls[0][1]["p_account_create_payload_sha256"], "d" * 64)

    def test_rpc_denials_fail_closed_for_revocation_drift_or_stale_checkpoint(self):
        for response in ([], None, [{"authorized": False, "studio_id": "studio_1"}], [{
            "authorized": True,
            "studio_id": "studio_2",
        }]):
            with self.subTest(response=response):
                store = StudioLiveBillingAuthorizationStore(
                    _AuthorizationSupabase(response),
                    expected_candidate_sha=CANDIDATE_SHA,
                )
                with self.assertRaises(HTTPException) as raised:
                    store.authorize(
                        operation="connected_invoice.pay",
                        scope="connect_payments",
                        studio_id="studio_1",
                        account_id="acct_1",
                        expected_livemode=True,
                    )
                self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)

    def test_initial_link_and_mapping_bind_use_exact_bootstrap_context(self):
        context = ConnectOnboardingBootstrapContext(
            token="t" * 43,
            account_generation=2,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g2",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g2-" + "c" * 24,
        )
        supabase = _AuthorizationSupabase([{
            "authorized": True,
            "studio_id": "studio_1",
            "checkpoint_id": "checkpoint_1",
            "bootstrap_id": "bootstrap_1",
        }])
        store = StudioLiveBillingAuthorizationStore(supabase, expected_candidate_sha=CANDIDATE_SHA)

        self.assertEqual(store.authorize(
            operation="connect_onboarding_link.create",
            scope="connect_onboarding",
            studio_id="studio_1",
            account_id="acct_1",
            expected_livemode=True,
            payload_sha256="d" * 64,
            bootstrap_context=context,
        ), "studio_1")
        self.assertEqual(supabase.rpc_calls[-1], (
            "authorize_connect_onboarding_bootstrap_initial_link",
            {
                "p_studio_id": "studio_1",
                "p_candidate_sha": CANDIDATE_SHA,
                "p_connect_account_generation": 2,
                "p_bootstrap_token": context.token,
                "p_stripe_connected_account_id": "acct_1",
                "p_initial_link_context_sha256": "b" * 64,
                "p_initial_link_payload_sha256": "d" * 64,
                "p_initial_link_idempotency_key": context.initial_link_idempotency_key,
            },
        ))

        supabase.response = [{"studio_id": "studio_1", "stripe_connected_account_id": "acct_1"}]
        row = store.bind_created_connect_account(
            studio_id="studio_1",
            account_id="acct_1",
            business_entity_type="company",
            bootstrap_context=context,
        )
        self.assertEqual(row["stripe_connected_account_id"], "acct_1")
        self.assertEqual(supabase.rpc_calls[-1][0], "bind_connect_onboarding_bootstrap_account")

    def test_missing_studio_candidate_or_live_mode_never_calls_rpc(self):
        cases = (
            {"studio_id": None, "candidate": CANDIDATE_SHA, "livemode": True},
            {"studio_id": "studio_1", "candidate": "", "livemode": True},
            {"studio_id": "studio_1", "candidate": None, "livemode": True},
            {"studio_id": "studio_1", "candidate": CANDIDATE_SHA, "livemode": False},
        )
        for case in cases:
            with self.subTest(case=case):
                supabase = _AuthorizationSupabase([])
                store = StudioLiveBillingAuthorizationStore(
                    supabase,
                    expected_candidate_sha=case["candidate"],
                )
                with self.assertRaises(HTTPException) as raised:
                    store.authorize(
                        operation="connect_account.create",
                        scope="connect_onboarding",
                        studio_id=case["studio_id"],
                        account_id=None,
                        expected_livemode=case["livemode"],
                    )
                self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)
                self.assertEqual(supabase.rpc_calls, [])

    def test_rpc_failure_is_unavailable_not_an_ambient_fallback(self):
        store = StudioLiveBillingAuthorizationStore(
            _AuthorizationSupabase(failure=RuntimeError("database unavailable")),
            expected_candidate_sha=CANDIDATE_SHA,
        )

        with self.assertRaises(HTTPException) as raised:
            store.authorize(
                operation="customer.create",
                scope="core_subscription",
                studio_id="studio_1",
                account_id=None,
                expected_livemode=True,
            )

        self.assertEqual(raised.exception.detail, LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)


if __name__ == "__main__":
    unittest.main()
