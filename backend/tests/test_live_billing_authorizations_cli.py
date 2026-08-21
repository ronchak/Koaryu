from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.live_billing_authorizations import (
    LiveBillingOperatorError,
    _drift,
    _load_report,
    _parse_timestamp,
    _record_checkpoint,
    build_parser,
)
from tests.fakes.supabase import TableBackedSupabase


def _report(*, schema_version: int = 3) -> dict:
    return {
        "schema_version": schema_version,
        "checkpoint_eligible": True,
        "evidence_source": "provider_read",
        "probe": "production",
        "provider_mode": "live",
        "candidate_sha": "a" * 40,
        "deployment_readiness": {
            "production_exact_candidate_verified": True,
        },
        "window_policy": {
            "complete_supported_window": True,
        },
        "continuity": {
            "mode": "bootstrap",
            "eligible": True,
            "bootstrap_historical_provider_completeness_claimed": False,
        },
    }


class LiveBillingAuthorizationCliTest(unittest.TestCase):
    def test_grant_is_dry_run_by_default_and_requires_expiry(self):
        args = build_parser().parse_args([
            "grant",
            "--studio-id",
            "00000000-0000-0000-0000-000000000001",
            "--scope",
            "connect_payments",
            "--expires-at",
            "2027-02-15T13:00:00Z",
            "--reason",
            "One-studio canary",
            "--actor",
            "operator@example.invalid",
        ])

        self.assertFalse(args.execute)
        self.assertEqual(args.scope, "connect_payments")
        self.assertEqual(
            _parse_timestamp(args.expires_at, "--expires-at"),
            "2027-02-15T13:00:00+00:00",
        )

    def test_drift_reports_expiry_reconnect_staleness_and_readiness(self):
        now = datetime.now(timezone.utc)
        supabase = TableBackedSupabase({
            "studio_live_billing_authorizations": [{
                "studio_id": "studio_1",
                "scope": "connect_payments",
                "enabled": True,
                "stripe_connected_account_id": "acct_old",
                "connect_account_generation": 1,
                "expires_at": (now - timedelta(minutes=1)).isoformat(),
                "revision": 2,
            }],
            "studio_payment_accounts": [{
                "studio_id": "studio_1",
                "stripe_connected_account_id": "acct_new",
                "status": "onboarding_incomplete",
                "charges_enabled": False,
                "payouts_enabled": False,
                "details_submitted": False,
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

    def test_record_checkpoint_accepts_only_schema_v3_production_provider_report(self):
        for label, report in (
            ("v2", _report(schema_version=2)),
            ("offline", {**_report(), "evidence_source": "offline_snapshot"}),
            ("staging", {**_report(), "probe": "staging", "provider_mode": "test"}),
            (
                "claims-history",
                {
                    **_report(),
                    "continuity": {
                        **_report()["continuity"],
                        "bootstrap_historical_provider_completeness_claimed": True,
                    },
                },
            ),
        ):
            with self.subTest(label=label):
                with patch.object(Path, "read_bytes", return_value=json.dumps(report).encode()):
                    with self.assertRaises(LiveBillingOperatorError):
                        _load_report(Path("report.json"))

    def test_checkpoint_record_dry_run_reprobes_and_names_v3_rpc(self):
        report = _report()
        args = SimpleNamespace(
            report=Path("report.json"),
            actor="operator@example.invalid",
            expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            reason="Fresh exact-candidate schema-v3 checkpoint",
            execute=False,
        )
        supabase = TableBackedSupabase()
        with (
            patch.object(Path, "read_bytes", return_value=json.dumps(report).encode()),
            patch(
                "scripts.live_billing_authorizations._resolve_actor",
                return_value=("actor_1", "operator@example.invalid"),
            ),
            patch(
                "scripts.live_billing_authorizations._verify_deployed_readiness",
                return_value={
                    "verified": True,
                    "url": "https://koaryu.onrender.com/health/ready",
                    "candidate_sha": "a" * 40,
                },
            ) as readiness,
            patch("scripts.live_billing_authorizations._print_json") as print_json,
        ):
            _record_checkpoint(supabase, SimpleNamespace(), args, None, None)

        readiness.assert_called_once()
        self.assertEqual(readiness.call_args.args, ("production", "a" * 40))
        output = print_json.call_args.args[0]
        self.assertEqual(
            output["rpc"],
            "record_stripe_live_billing_reconciliation_checkpoint_v3",
        )
        self.assertEqual(output["schema_version"], 3)
        self.assertTrue(output["production_ready_url_verified"])

    def test_checkpoint_record_rejects_mismatched_independent_probe(self):
        report = _report()
        args = SimpleNamespace(
            report=Path("report.json"),
            actor="operator@example.invalid",
            expires_at=(datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
            reason="Fresh exact-candidate checkpoint",
            execute=False,
        )
        with (
            patch.object(Path, "read_bytes", return_value=json.dumps(report).encode()),
            patch(
                "scripts.live_billing_authorizations._resolve_actor",
                return_value=("actor_1", "operator@example.invalid"),
            ),
            patch(
                "scripts.live_billing_authorizations._verify_deployed_readiness",
                return_value={
                    "verified": True,
                    "url": "https://koaryu.onrender.com/health/ready",
                    "candidate_sha": "b" * 40,
                },
            ),
        ):
            with self.assertRaises(LiveBillingOperatorError):
                _record_checkpoint(
                    TableBackedSupabase(),
                    SimpleNamespace(),
                    args,
                    None,
                    None,
                )


if __name__ == "__main__":
    unittest.main()
