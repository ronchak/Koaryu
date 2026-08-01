from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.stripe_reconciliation_report import (
    CONNECT_EVENTS,
    PLATFORM_EVENTS,
    PRODUCTION_CONNECT_WEBHOOK_URL,
    PRODUCTION_PLATFORM_WEBHOOK_URL,
    PRODUCTION_READY_URL,
    STAGING_CONNECT_WEBHOOK_URL,
    STAGING_PLATFORM_WEBHOOK_URL,
    STAGING_READY_URL,
    build_report,
    collect_read_only_snapshot,
)
from tests.fakes.supabase import TableBackedSupabase


SHA = "a" * 40


def _event(event_id: str, event_type: str, created: datetime, account_id: str | None = None) -> dict:
    row = {"id": event_id, "type": event_type, "livemode": True, "created": int(created.timestamp())}
    if account_id:
        row["account"] = account_id
    return row


def _local_event(
    event_id: str,
    event_type: str,
    created: datetime,
    sequence: int,
    account_id: str | None = None,
) -> dict:
    return {
        "stripe_event_id": event_id,
        "stripe_account_id": account_id,
        "livemode": True,
        "type": event_type,
        "processing_status": "processed",
        "processed_at": created.isoformat(),
        "created_at": created.isoformat(),
        "live_billing_ingest_sequence": sequence,
    }


def _snapshot(now: datetime) -> dict:
    created = now - timedelta(minutes=5)
    return {
        "candidate_sha": SHA,
        "collected_at": now.isoformat(),
        "event_window": {
            "started_at": "2026-07-13T00:00:00+00:00",
            "ended_at": now.isoformat(),
        },
        "evidence_source": "provider_read",
        "probe": "production",
        "deployment_readiness": {
            "verified": True,
            "url": PRODUCTION_READY_URL,
            "environment": "production",
            "candidate_sha": SHA,
            "verified_at": now.isoformat(),
        },
        "provider_mode": "live",
        "provider_accounts": [{"id": "acct_mapped"}, {"id": "acct_excluded"}],
        "local_mappings": [{
            "studio_id": "00000000-0000-0000-0000-000000000001",
            "stripe_connected_account_id": "acct_mapped",
            "metadata": {"connect_account_generation": 3},
        }],
        "account_dispositions": [{"stripe_connected_account_id": "acct_excluded", "excluded": True}],
        "provider_events": [
            _event("evt_platform", "invoice.paid", created),
            _event("evt_connect", "account.updated", created, "acct_mapped"),
        ],
        "local_events": [
            _local_event("evt_platform", "invoice.paid", created, 1),
            _local_event("evt_connect", "account.updated", created, 2, "acct_mapped"),
        ],
        "webhook_endpoints": [
            {"id": "we_platform", "status": "enabled", "connect": False,
             "url": PRODUCTION_PLATFORM_WEBHOOK_URL, "enabled_events": sorted(PLATFORM_EVENTS)},
            {"id": "we_connect", "status": "enabled", "connect": True,
             "url": PRODUCTION_CONNECT_WEBHOOK_URL, "enabled_events": sorted(CONNECT_EVENTS)},
        ],
    }


class _ReadyResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "status": "ready",
            "service": "koaryu-api",
            "environment": "production",
            "commit_sha": SHA,
        }


class StripeReconciliationReportTest(unittest.TestCase):
    def test_read_only_collector_lists_platform_and_each_connected_account_events(self):
        event_calls: list[str | None] = []

        class Accounts:
            @staticmethod
            def list(**_params):
                return {"data": [{"id": "acct_1"}, {"id": "acct_2"}], "has_more": False}

        class Events:
            @staticmethod
            def list(**params):
                account_id = params.get("stripe_account")
                event_calls.append(account_id)
                suffix = account_id or "platform"
                return {"data": [{
                    "id": f"evt_{suffix}", "type": "account.updated" if account_id else "invoice.paid",
                    "livemode": True, "created": params["created"]["gte"],
                }], "has_more": False}

        class Endpoints:
            @staticmethod
            def list(**_params):
                return {"data": [], "has_more": False}

        stripe_module = SimpleNamespace(Account=Accounts, Event=Events, WebhookEndpoint=Endpoints)
        supabase = TableBackedSupabase({
            "studio_payment_accounts": [], "stripe_connect_account_dispositions": [], "stripe_events": [],
        })
        with (
            patch("scripts.stripe_reconciliation_report.get_settings", return_value=SimpleNamespace(
                STRIPE_RESTRICTED_KEY="rk_live_fixture", STRIPE_SECRET_KEY="",
            )),
            patch("scripts.stripe_reconciliation_report.create_supabase_client", return_value=supabase),
            patch("scripts.stripe_reconciliation_report.httpx.get", return_value=_ReadyResponse()) as ready,
            patch("scripts.stripe_reconciliation_report.importlib.import_module", return_value=stripe_module),
        ):
            snapshot = collect_read_only_snapshot(SHA, probe="production")

        self.assertEqual(event_calls, [None, "acct_1", "acct_2"])
        self.assertEqual(snapshot["evidence_source"], "provider_read")
        self.assertEqual(snapshot["deployment_readiness"]["url"], PRODUCTION_READY_URL)
        ready.assert_called_once()

    def test_complete_production_report_requires_separate_platform_and_generation_proof(self):
        now = datetime.now(timezone.utc)
        report = build_report(_snapshot(now), now=now)

        self.assertTrue(report["checkpoint_eligible"])
        self.assertTrue(report["platform_delivery"]["fresh"])
        self.assertEqual(report["account_evidence"][0]["connect_account_generation"], 3)
        self.assertTrue(report["account_evidence"][0]["fresh"])
        self.assertEqual(report["events_since_2026_07_13"]["provider_only_event_count"], 0)
        self.assertEqual(report["events_since_2026_07_13"]["local_only_event_count"], 0)

    def test_offline_snapshot_is_permanently_ineligible_even_with_valid_looking_fields(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["evidence_source"] = "offline_snapshot"
        snapshot["probe"] = None
        snapshot["deployment_readiness"] = None

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(report["deployment_readiness"]["production_exact_candidate_verified"])

    def test_staging_probe_is_diagnostic_only(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_mode"] = "test"
        snapshot["probe"] = "staging"
        snapshot["deployment_readiness"]["environment"] = "staging"
        snapshot["deployment_readiness"]["url"] = STAGING_READY_URL
        for event in [*snapshot["provider_events"], *snapshot["local_events"]]:
            event["livemode"] = False
        snapshot["webhook_endpoints"][0]["url"] = STAGING_PLATFORM_WEBHOOK_URL
        snapshot["webhook_endpoints"][1]["url"] = STAGING_CONNECT_WEBHOOK_URL

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertTrue(report["webhook_delivery"]["platform_endpoint_contract_matched"])
        self.assertTrue(report["webhook_delivery"]["connect_endpoint_contract_matched"])
        self.assertFalse(report["deployment_readiness"]["production_exact_candidate_verified"])

    def test_stale_or_mismatched_deployment_readiness_blocks_checkpoint(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["deployment_readiness"]["candidate_sha"] = "b" * 40
        self.assertFalse(build_report(snapshot, now=now)["checkpoint_eligible"])

        snapshot = _snapshot(now)
        snapshot["deployment_readiness"]["url"] = "https://wrong.example/health/ready"
        self.assertFalse(build_report(snapshot, now=now)["checkpoint_eligible"])

        snapshot = _snapshot(now)
        snapshot["deployment_readiness"]["verified_at"] = (now - timedelta(minutes=16)).isoformat()
        self.assertFalse(build_report(snapshot, now=now)["checkpoint_eligible"])

    def test_platform_delivery_must_be_separately_fresh(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        old = now - timedelta(days=2)
        snapshot["provider_events"][0]["created"] = int(old.timestamp())
        snapshot["local_events"][0]["created_at"] = old.isoformat()

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(report["platform_delivery"]["fresh"])

    def test_each_account_generation_needs_fresh_complete_delivery(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["local_events"] = [snapshot["local_events"][0]]

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["account_evidence"][0]["provider_only_event_count"], 1)
        self.assertFalse(report["account_evidence"][0]["fresh"])

        snapshot = _snapshot(now)
        snapshot["local_mappings"][0]["metadata"]["connect_account_generation"] = "invalid"
        self.assertFalse(build_report(snapshot, now=now)["checkpoint_eligible"])

    def test_provider_only_and_local_only_gaps_each_block(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_events"].append(_event("evt_provider_only", "invoice.paid", now - timedelta(minutes=2)))
        report = build_report(snapshot, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["events_since_2026_07_13"]["provider_only_event_count"], 1)

        snapshot = _snapshot(now)
        snapshot["local_events"].append(_local_event(
            "evt_local_only", "invoice.paid", now - timedelta(minutes=2), 3,
        ))
        report = build_report(snapshot, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["events_since_2026_07_13"]["local_only_event_count"], 1)

    def test_extra_enabled_endpoint_blocks_even_when_exact_pair_exists(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["webhook_endpoints"].append({
            "id": "we_extra", "status": "enabled", "connect": True,
            "url": "https://extra.example/connect", "enabled_events": ["account.updated"],
        })

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["webhook_delivery"]["enabled_connect_endpoint_count"], 2)
        self.assertGreater(report["webhook_delivery"]["unexpected_enabled_endpoint_count"], 0)
        self.assertNotIn("url", report["webhook_delivery"])

    def test_wrong_url_wildcard_or_refund_event_gap_blocks_topology(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["webhook_endpoints"][0]["url"] = "https://wrong.example/platform"
        snapshot["webhook_endpoints"][1]["enabled_events"] = sorted(CONNECT_EVENTS - {"refund.failed"})
        report = build_report(snapshot, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(report["webhook_delivery"]["platform_endpoint_contract_matched"])
        self.assertFalse(report["webhook_delivery"]["connect_endpoint_contract_matched"])

        snapshot = _snapshot(now)
        snapshot["webhook_endpoints"][1]["enabled_events"] = ["*"]
        self.assertFalse(build_report(snapshot, now=now)["checkpoint_eligible"])

    def test_required_connect_topology_covers_implemented_refund_lifecycle(self):
        self.assertEqual(len(CONNECT_EVENTS), 23)
        self.assertTrue({
            "charge.refunded", "charge.refund.updated", "refund.created", "refund.failed", "refund.updated",
        }.issubset(CONNECT_EVENTS))

    def test_failed_event_blocks_and_remains_sanitized(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        failed = _local_event("evt_failed", "refund.failed", now - timedelta(minutes=1), 3, "acct_mapped")
        failed.update({
            "processing_status": "failed",
            "error": "secret detail with customer@example.com",
            "error_reference": "f" * 32,
        })
        snapshot["local_events"].append(failed)
        snapshot["provider_events"].append(_event("evt_failed", "refund.failed", now - timedelta(minutes=1), "acct_mapped"))

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["events_since_2026_07_13"]["failed"], 1)
        self.assertEqual(report["events_since_2026_07_13"]["failures"][0]["error_code"], "redacted_unstructured_error")
        self.assertNotIn("customer@example.com", str(report))

    def test_failure_and_unmapped_risks_outside_reviewed_equality_types_still_block(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        risk = _local_event(
            "evt_unreviewed_risk", "provider.future_event", now - timedelta(minutes=1), 3,
            "acct_unmapped_future",
        )
        risk["processing_status"] = "failed"
        risk["error"] = "future_handler_failed"
        snapshot["local_events"].append(risk)

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["events_since_2026_07_13"]["failed"], 1)
        self.assertEqual(report["counts"]["unresolved_event_accounts"], 1)
        self.assertEqual(report["events_since_2026_07_13"]["bounded_local_total"], 2)


if __name__ == "__main__":
    unittest.main()
