from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from fastapi import HTTPException

from app.services.studio_live_billing_authorizations import (
    LIVE_CONNECT_ACCOUNT_NOT_READY_DETAIL,
    LIVE_SCOPE_EXPIRED_DETAIL,
    LIVE_SCOPE_DENIED_DETAIL,
    StudioLiveBillingAuthorizationStore,
)
from tests.fakes.supabase import TableBackedSupabase


CANDIDATE_SHA = "a" * 40


class _Store(StudioLiveBillingAuthorizationStore):
    def __init__(self, authorization, account, *, reconciliation_ready=True):
        self.authorization = authorization
        self.account = account
        self.reconciliation_ready = reconciliation_ready

    def _authorization(self, _studio_id, _scope):
        return self.authorization

    def _payment_account(self, *, studio_id, account_id):
        return self.account

    def _reconciliation_checkpoint_ready(self):
        return self.reconciliation_ready


def _account(*, account_id="acct_1", generation=1, ready=True):
    return {
        "studio_id": "studio_1",
        "stripe_connected_account_id": account_id,
        "status": "charges_enabled" if ready else "onboarding_incomplete",
        "charges_enabled": ready,
        "payouts_enabled": ready,
        "details_submitted": ready,
        "requirements_due": [],
        "metadata": {"connect_account_generation": generation},
    }


def _authorization(*, account_id="acct_1", generation=1):
    return {
        "enabled": True,
        "stripe_connected_account_id": account_id,
        "connect_account_generation": generation,
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }


class StudioLiveBillingAuthorizationStoreTest(unittest.TestCase):
    def test_connect_payment_scope_requires_current_exact_mapping_and_generation(self):
        store = _Store(
            _authorization(),
            _account(),
        )

        studio_id = store.authorize(
            operation="connected_invoice.pay",
            scope="connect_payments",
            studio_id="studio_1",
            account_id="acct_1",
            expected_livemode=True,
        )

        self.assertEqual(studio_id, "studio_1")
        stale_generation = _Store(
            _authorization(),
            _account(generation=2),
        )
        with self.assertRaises(HTTPException) as raised:
            stale_generation.authorize(
                operation="connected_invoice.pay", scope="connect_payments", studio_id="studio_1", account_id="acct_1", expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)

    def test_connect_payment_scope_rechecks_current_account_readiness(self):
        authorization = _authorization()
        unready = _Store(authorization, _account(ready=False))
        with self.assertRaises(HTTPException) as raised:
            unready.authorize(
                operation="connected_invoice.pay", scope="connect_payments", studio_id="studio_1", account_id="acct_1", expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_CONNECT_ACCOUNT_NOT_READY_DETAIL)

    def test_grant_and_mapping_for_one_studio_cannot_authorize_another(self):
        store = _Store(_authorization(), _account())

        with self.assertRaises(HTTPException) as raised:
            store.authorize(
                operation="connected_invoice.pay",
                scope="connect_payments",
                studio_id="studio_2",
                account_id="acct_1",
                expected_livemode=True,
            )

        self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)

    def test_reconnect_invalidates_unbound_onboarding_grant_by_generation(self):
        store = _Store(
            _authorization(account_id=None),
            _account(account_id="acct_new", generation=2),
        )

        with self.assertRaises(HTTPException) as raised:
            store.authorize(
                operation="connect_onboarding_link.create", scope="connect_onboarding", studio_id="studio_1", account_id="acct_new", expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)

    def test_connect_account_creation_requires_an_unbound_empty_mapping(self):
        mapped = _Store(_authorization(), _account())
        with self.assertRaises(HTTPException) as raised:
            mapped.authorize(
                operation="connect_account.create",
                scope="connect_onboarding",
                studio_id="studio_1",
                account_id=None,
                expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)

        unbound = _Store(
            _authorization(account_id=None),
            _account(account_id=None, ready=False),
        )
        self.assertEqual(
            unbound.authorize(
                operation="connect_account.create",
                scope="connect_onboarding",
                studio_id="studio_1",
                account_id=None,
                expected_livemode=True,
            ),
            "studio_1",
        )

    def test_checkpoint_accepts_exact_zero_counts_and_exact_candidate(self):
        now = datetime.now(timezone.utc)
        supabase = TableBackedSupabase({
            "stripe_live_billing_reconciliation_checkpoints": [{
                "stripe_livemode": True,
                "candidate_sha": CANDIDATE_SHA,
                "unresolved_account_count": 0,
                "failed_event_count": 0,
                "webhook_delivery_verified_at": now.isoformat(),
                "enabled_platform_endpoint_count": 1,
                "enabled_connect_endpoint_count": 1,
                "platform_endpoint_contract_matched": True,
                "connect_endpoint_contract_matched": True,
                "verified_at": now.isoformat(),
                "created_at": now.isoformat(),
                "expires_at": (now + timedelta(hours=1)).isoformat(),
            }],
        })
        store = StudioLiveBillingAuthorizationStore(
            supabase,
            expected_candidate_sha=CANDIDATE_SHA,
        )

        self.assertTrue(store._reconciliation_checkpoint_ready())

    def test_checkpoint_rejects_mismatched_or_missing_deployment_candidate(self):
        now = datetime.now(timezone.utc)
        row = {
            "stripe_livemode": True,
            "candidate_sha": "b" * 40,
            "unresolved_account_count": 0,
            "failed_event_count": 0,
            "webhook_delivery_verified_at": now.isoformat(),
            "enabled_platform_endpoint_count": 1,
            "enabled_connect_endpoint_count": 1,
            "platform_endpoint_contract_matched": True,
            "connect_endpoint_contract_matched": True,
            "verified_at": now.isoformat(),
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(hours=1)).isoformat(),
        }
        supabase = TableBackedSupabase({
            "stripe_live_billing_reconciliation_checkpoints": [row],
        })

        self.assertFalse(StudioLiveBillingAuthorizationStore(
            supabase,
            expected_candidate_sha=CANDIDATE_SHA,
        )._reconciliation_checkpoint_ready())
        self.assertFalse(StudioLiveBillingAuthorizationStore(
            supabase,
            expected_candidate_sha="",
        )._reconciliation_checkpoint_ready())

    def test_core_scope_cannot_be_bound_to_connect_account(self):
        store = _Store(
            _authorization(account_id="acct_1", generation=None),
            None,
        )
        with self.assertRaises(HTTPException) as raised:
            store.authorize(
                operation="customer.create", scope="core_subscription", studio_id="studio_1", account_id=None, expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)

    def test_expired_or_unreconciled_grant_is_never_effective(self):
        expired = _authorization()
        expired["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        store = _Store(expired, _account())
        with self.assertRaises(HTTPException) as raised:
            store.authorize(
                operation="connected_invoice.pay", scope="connect_payments", studio_id="studio_1", account_id="acct_1", expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_EXPIRED_DETAIL)

        store = _Store(_authorization(), _account(), reconciliation_ready=False)
        with self.assertRaises(HTTPException) as raised:
            store.authorize(
                operation="connected_invoice.pay", scope="connect_payments", studio_id="studio_1", account_id="acct_1", expected_livemode=True,
            )
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_DENIED_DETAIL)


if __name__ == "__main__":
    unittest.main()
