from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from scripts.live_billing_authorizations import _drift, _parse_timestamp, build_parser
from tests.fakes.supabase import TableBackedSupabase


class LiveBillingAuthorizationCliTest(unittest.TestCase):
    def test_grant_is_dry_run_by_default_and_requires_expiry(self):
        args = build_parser().parse_args([
            "grant", "--studio-id", "00000000-0000-0000-0000-000000000001",
            "--scope", "connect_payments", "--expires-at", "2026-08-01T00:00:00Z",
            "--reason", "One-studio canary", "--actor", "operator@example.invalid",
        ])

        self.assertFalse(args.execute)
        self.assertEqual(args.scope, "connect_payments")
        self.assertEqual(_parse_timestamp(args.expires_at, "--expires-at"), "2026-08-01T00:00:00+00:00")

    def test_drift_reports_expiry_reconnect_staleness_and_readiness(self):
        now = datetime.now(timezone.utc)
        supabase = TableBackedSupabase({
            "studio_live_billing_authorizations": [{
                "studio_id": "studio_1", "scope": "connect_payments", "enabled": True,
                "stripe_connected_account_id": "acct_old", "connect_account_generation": 1,
                "expires_at": (now - timedelta(minutes=1)).isoformat(), "revision": 2,
            }],
            "studio_payment_accounts": [{
                "studio_id": "studio_1", "stripe_connected_account_id": "acct_new",
                "status": "onboarding_incomplete", "charges_enabled": False,
                "payouts_enabled": False, "details_submitted": False,
                "requirements_due": ["company.tax_id"],
                "metadata": {"connect_account_generation": 2},
            }],
        })

        drift = _drift(supabase)

        self.assertEqual(len(drift), 1)
        reasons = drift[0]["drift_reasons"]
        self.assertTrue(any("expired" in reason for reason in reasons))
        self.assertTrue(any("generation" in reason for reason in reasons))
        self.assertTrue(any("current mapping" in reason for reason in reasons))
        self.assertTrue(any("payment-ready" in reason for reason in reasons))


if __name__ == "__main__":
    unittest.main()
