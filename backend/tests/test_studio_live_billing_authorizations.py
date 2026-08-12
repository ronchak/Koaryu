from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from app.services.studio_live_billing_authorizations import (
    ConnectOnboardingBootstrapContext,
    LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL,
    LIVE_SCOPE_DENIED_DETAIL,
    StudioLiveBillingAuthorizationStore,
    new_connect_onboarding_bootstrap_context,
)
from tests.fakes.supabase import RpcBackedSupabase


CANDIDATE_SHA = "a" * 40


class _AuthorizationSupabase(RpcBackedSupabase):
    def __init__(self, response=None, *, responses=None, failure: Exception | None = None):
        super().__init__()
        self.response = response
        self.responses = responses or {}
        self.failure = failure

    def _response(self, rpc_name):
        return self.responses.get(rpc_name, self.response)

    def _rpc_authorize_studio_live_billing_mutation_atomic(self, _params):
        if self.failure:
            raise self.failure
        return self._response("authorize_studio_live_billing_mutation_atomic")

    def _rpc_authorize_connect_onboarding_bootstrap_account_create_v2(self, _params):
        if self.failure:
            raise self.failure
        return self._response("authorize_connect_onboarding_bootstrap_account_create_v2")

    def _rpc_authorize_connect_onboarding_bootstrap_initial_link_v2(self, _params):
        if self.failure:
            raise self.failure
        return self._response("authorize_connect_onboarding_bootstrap_initial_link_v2")

    def _rpc_bind_connect_onboarding_bootstrap_account_v2(self, _params):
        if self.failure:
            raise self.failure
        return self._response("bind_connect_onboarding_bootstrap_account_v2")

    def _rpc_prepare_connect_onboarding_bootstrap_atomic(self, _params):
        if self.failure:
            raise self.failure
        return self._response("prepare_connect_onboarding_bootstrap_atomic")

    def _rpc_load_connect_onboarding_bootstrap_recovery_context(self, _params):
        if self.failure:
            raise self.failure
        return self._response("load_connect_onboarding_bootstrap_recovery_context")

    def _rpc_preflight_connect_onboarding_bootstrap_begin(self, _params):
        if self.failure:
            raise self.failure
        return self._response("preflight_connect_onboarding_bootstrap_begin")

    def _rpc_preflight_connect_onboarding_bootstrap_resume(self, _params):
        if self.failure:
            raise self.failure
        return self._response("preflight_connect_onboarding_bootstrap_resume")

    def _rpc_record_connect_onboarding_bootstrap_initial_link_response(self, _params):
        if self.failure:
            raise self.failure
        return self._response("record_connect_onboarding_bootstrap_initial_link_response")

    def _rpc_acknowledge_connect_onboarding_bootstrap_initial_link_delivery(self, _params):
        if self.failure:
            raise self.failure
        return self._response("acknowledge_connect_onboarding_bootstrap_initial_link_delivery")


class StudioLiveBillingAuthorizationStoreTest(unittest.TestCase):
    def test_new_bootstrap_context_has_reproducible_provider_keys(self):
        values = {
            "studio_id": "studio_1",
            "account_generation": 2,
            "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
            "return_url": "https://app.koaryu.test/billing?connect=return",
        }

        first = new_connect_onboarding_bootstrap_context(**values)
        repeated = new_connect_onboarding_bootstrap_context(**values)

        self.assertEqual(first, repeated)
        self.assertEqual(first.account_create_idempotency_key, "koaryu-connect-account-studio_1-g2")
        self.assertEqual(
            first.initial_link_idempotency_key,
            f"koaryu-connect-onboarding-studio_1-g2-{first.initial_link_context_sha256[:24]}",
        )

    def test_new_bootstrap_context_changes_link_key_with_generation_or_route_context(self):
        common = {
            "studio_id": "studio_1",
            "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
            "return_url": "https://app.koaryu.test/billing?connect=return",
        }
        first = new_connect_onboarding_bootstrap_context(account_generation=1, **common)
        next_generation = new_connect_onboarding_bootstrap_context(account_generation=2, **common)
        changed_return = new_connect_onboarding_bootstrap_context(
            account_generation=1,
            **{**common, "return_url": "https://app.koaryu.test/billing?connect=other"},
        )

        self.assertNotEqual(first.initial_link_idempotency_key, next_generation.initial_link_idempotency_key)
        self.assertNotEqual(first.initial_link_idempotency_key, changed_return.initial_link_idempotency_key)

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
            bootstrap_id="11111111-1111-4111-8111-111111111111",
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
        self.assertEqual(supabase.rpc_calls[0][0], "authorize_connect_onboarding_bootstrap_account_create_v2")
        self.assertEqual(supabase.rpc_calls[0][1]["p_bootstrap_id"], context.bootstrap_id)
        self.assertNotIn("p_bootstrap_token", supabase.rpc_calls[0][1])
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
            bootstrap_id="11111111-1111-4111-8111-111111111111",
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
            "authorize_connect_onboarding_bootstrap_initial_link_v2",
            {
                "p_bootstrap_id": context.bootstrap_id,
                "p_studio_id": "studio_1",
                "p_candidate_sha": CANDIDATE_SHA,
                "p_connect_account_generation": 2,
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
        self.assertEqual(supabase.rpc_calls[-1][0], "bind_connect_onboarding_bootstrap_account_v2")

    def test_prepare_and_load_recovery_keep_stable_context_service_side(self):
        row = {
            "bootstrap_id": "11111111-1111-4111-8111-111111111111",
            "studio_id": "studio_1",
            "connect_account_generation": 3,
            "recovery_context": {
                "business_name": "Recovery Studio",
                "contact_email": "owner@example.test",
                "business_entity_type": "company",
                "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
                "return_url": "https://app.koaryu.test/billing?connect=return",
            },
            "account_create_idempotency_key": "koaryu-connect-account-studio_1-g3",
            "initial_link_idempotency_key": "koaryu-connect-onboarding-studio_1-g3-" + "c" * 24,
            "stripe_connected_account_id": None,
            "phase": "account_create",
        }
        supabase = _AuthorizationSupabase(responses={
            "prepare_connect_onboarding_bootstrap_atomic": [row],
            "preflight_connect_onboarding_bootstrap_resume": [{
                "eligible": True,
                "studio_id": "studio_1",
                "phase": "account_create",
            }],
            "load_connect_onboarding_bootstrap_recovery_context": [row],
        })
        store = StudioLiveBillingAuthorizationStore(supabase, expected_candidate_sha=CANDIDATE_SHA)
        provisional = ConnectOnboardingBootstrapContext(
            account_generation=3,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key=row["account_create_idempotency_key"],
            initial_link_idempotency_key=row["initial_link_idempotency_key"],
            recovery_context=row["recovery_context"],
        )

        prepared = store.prepare_connect_onboarding_bootstrap(
            studio_id="studio_1",
            recovery_context=row["recovery_context"],
            account_create_payload_sha256="d" * 64,
            bootstrap_context=provisional,
        )
        loaded = store.load_connect_onboarding_bootstrap_recovery(studio_id="studio_1")

        self.assertEqual(prepared.bootstrap_id, row["bootstrap_id"])
        self.assertEqual(loaded, prepared)
        self.assertEqual([name for name, _params in supabase.rpc_calls], [
            "prepare_connect_onboarding_bootstrap_atomic",
            "preflight_connect_onboarding_bootstrap_resume",
            "load_connect_onboarding_bootstrap_recovery_context",
        ])
        self.assertNotIn("token", supabase.rpc_calls[0][1])

    def test_initial_link_response_records_only_hashes_and_ack_is_exact_receipt_idempotent(self):
        context = ConnectOnboardingBootstrapContext(
            bootstrap_id="11111111-1111-4111-8111-111111111111",
            account_generation=2,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g2",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g2-" + "c" * 24,
        )
        supabase = _AuthorizationSupabase(responses={
            "record_connect_onboarding_bootstrap_initial_link_response": [{
                "recorded": True,
                "studio_id": "studio_1",
                "bootstrap_id": context.bootstrap_id,
            }],
            "acknowledge_connect_onboarding_bootstrap_initial_link_delivery": [{
                "acknowledged": True,
                "studio_id": "studio_1",
                "bootstrap_id": context.bootstrap_id,
            }],
        })
        store = StudioLiveBillingAuthorizationStore(supabase, expected_candidate_sha=CANDIDATE_SHA)

        with patch(
            "app.services.studio_live_billing_authorizations.secrets.token_urlsafe",
            return_value="r" * 64,
        ):
            receipt = store.record_connect_onboarding_initial_link_response(
                studio_id="studio_1",
                account_id="acct_1",
                link_url="https://connect.stripe.test/secret-link",
                payload_sha256="d" * 64,
                bootstrap_context=context,
            )
        self.assertEqual(receipt, "r" * 64)
        record_params = supabase.rpc_calls[-1][1]
        self.assertNotIn(receipt, record_params.values())
        self.assertNotIn("https://connect.stripe.test/secret-link", record_params.values())
        self.assertRegex(record_params["p_delivery_receipt_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(record_params["p_initial_link_response_sha256"], r"^[0-9a-f]{64}$")

        self.assertTrue(store.acknowledge_connect_onboarding_initial_link_delivery(
            studio_id="studio_1",
            delivery_receipt=receipt,
        ))
        ack_params = supabase.rpc_calls[-1][1]
        self.assertNotIn(receipt, ack_params.values())
        self.assertEqual(ack_params["p_studio_id"], "studio_1")
        self.assertEqual(ack_params["p_candidate_sha"], CANDIDATE_SHA)

    def test_delivery_ack_rejects_wrong_expired_or_cross_context_receipt(self):
        store = StudioLiveBillingAuthorizationStore(
            _AuthorizationSupabase(responses={
                "acknowledge_connect_onboarding_bootstrap_initial_link_delivery": [],
            }),
            expected_candidate_sha=CANDIDATE_SHA,
        )
        with self.assertRaises(HTTPException) as raised:
            store.acknowledge_connect_onboarding_initial_link_delivery(
                studio_id="studio_1",
                delivery_receipt="r" * 64,
            )
        self.assertEqual(raised.exception.status_code, 409)

    def test_completed_bootstrap_preflight_falls_through_to_ordinary_authorization(self):
        supabase = _AuthorizationSupabase(responses={
            "preflight_connect_onboarding_bootstrap_begin": [{
                "eligible": False,
                "studio_id": "studio_1",
            }],
            "preflight_connect_onboarding_bootstrap_resume": [{
                "eligible": False,
                "studio_id": "studio_1",
                "phase": "completed",
            }],
        })
        state = StudioLiveBillingAuthorizationStore(
            supabase,
            expected_candidate_sha=CANDIDATE_SHA,
        ).connect_onboarding_preflight_state(studio_id="studio_1")
        self.assertEqual(state, "none")

    def test_read_only_preflight_is_fail_closed_and_never_queries_or_mutates_tables(self):
        for response, expected, expected_calls in (
            ([{"eligible": True, "studio_id": "studio_1"}], True, 1),
            ([{"eligible": False, "studio_id": "studio_1"}], False, 2),
            ([{"eligible": True, "studio_id": "studio_2"}], False, 1),
            ([], False, 1),
        ):
            with self.subTest(response=response):
                supabase = _AuthorizationSupabase(response)
                allowed = StudioLiveBillingAuthorizationStore(
                    supabase,
                    expected_candidate_sha=CANDIDATE_SHA,
                ).can_begin_or_resume_connect_onboarding(studio_id="studio_1")
                self.assertEqual(allowed, expected)
                self.assertEqual(len(supabase.rpc_calls), expected_calls)
                self.assertEqual(supabase.query_log, [])

    def test_support_required_recovery_never_loads_context_or_falls_back(self):
        supabase = _AuthorizationSupabase(responses={
            "preflight_connect_onboarding_bootstrap_resume": [{
                "eligible": False,
                "studio_id": "studio_1",
                "phase": "support_required",
            }],
        })
        store = StudioLiveBillingAuthorizationStore(supabase, expected_candidate_sha=CANDIDATE_SHA)

        with self.assertRaises(HTTPException) as raised:
            store.load_connect_onboarding_bootstrap_recovery(studio_id="studio_1")

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls],
            ["preflight_connect_onboarding_bootstrap_resume"],
        )

    def test_recovery_preflight_unavailability_fails_closed_before_load(self):
        store = StudioLiveBillingAuthorizationStore(
            _AuthorizationSupabase(failure=RuntimeError("database unavailable")),
            expected_candidate_sha=CANDIDATE_SHA,
        )

        with self.assertRaises(HTTPException) as raised:
            store.load_connect_onboarding_bootstrap_recovery(studio_id="studio_1")

        self.assertEqual(raised.exception.detail, LIVE_AUTHORIZATION_UNAVAILABLE_DETAIL)

    def test_preflight_distinguishes_no_bootstrap_from_support_required(self):
        for phase, expected in (("none", "none"), ("support_required", "support_required")):
            with self.subTest(phase=phase):
                supabase = _AuthorizationSupabase(responses={
                    "preflight_connect_onboarding_bootstrap_begin": [{
                        "eligible": False,
                        "studio_id": "studio_1",
                    }],
                    "preflight_connect_onboarding_bootstrap_resume": [{
                        "eligible": False,
                        "studio_id": "studio_1",
                        "phase": phase,
                    }],
                })
                state = StudioLiveBillingAuthorizationStore(
                    supabase,
                    expected_candidate_sha=CANDIDATE_SHA,
                ).connect_onboarding_preflight_state(studio_id="studio_1")
                self.assertEqual(state, expected)

    def test_missing_bootstrap_handle_denies_before_rpc(self):
        context = ConnectOnboardingBootstrapContext(
            account_generation=1,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g1",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g1-" + "c" * 24,
        )
        supabase = _AuthorizationSupabase([])
        with self.assertRaises(HTTPException):
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
            )
        self.assertEqual(supabase.rpc_calls, [])

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
