from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.stripe_reconciliation_report import (
    CUTOFF,
    CONNECT_EVENTS,
    PLATFORM_EVENTS,
    PRODUCTION_CONNECT_WEBHOOK_URL,
    PRODUCTION_PLATFORM_WEBHOOK_URL,
    build_report,
    collect_read_only_snapshot,
)
from tests.fakes.supabase import TableBackedSupabase


SHA = "a" * 40


def _snapshot(now: datetime) -> dict:
    created = int((now - timedelta(minutes=5)).timestamp())
    received = (now - timedelta(minutes=4)).isoformat()
    return {
        "candidate_sha": SHA,
        "provider_mode": "live",
        "provider_accounts": [{"id": "acct_mapped"}, {"id": "acct_excluded"}],
        "local_mappings": [{"studio_id": "studio_1", "stripe_connected_account_id": "acct_mapped"}],
        "account_dispositions": [{"stripe_connected_account_id": "acct_excluded", "excluded": True}],
        "provider_events": [{"id": "evt_recent", "account": "acct_mapped", "livemode": True, "created": created}],
        "local_events": [{
            "stripe_event_id": "evt_recent", "stripe_account_id": "acct_mapped",
            "livemode": True, "type": "account.updated", "processing_status": "processed",
            "processed_at": received, "created_at": received,
        }],
        "webhook_endpoints": [
            {"id": "we_platform", "status": "enabled", "connect": False,
             "url": PRODUCTION_PLATFORM_WEBHOOK_URL, "enabled_events": sorted(PLATFORM_EVENTS)},
            {"id": "we_connect", "status": "enabled", "connect": True,
             "url": PRODUCTION_CONNECT_WEBHOOK_URL, "enabled_events": sorted(CONNECT_EVENTS)},
        ],
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
                return {
                    "data": [{"id": f"evt_{suffix}", "livemode": True, "created": int(CUTOFF.timestamp())}],
                    "has_more": False,
                }

        class Endpoints:
            @staticmethod
            def list(**_params):
                return {"data": [], "has_more": False}

        stripe_module = SimpleNamespace(Account=Accounts, Event=Events, WebhookEndpoint=Endpoints)
        supabase = TableBackedSupabase({
            "studio_payment_accounts": [],
            "stripe_connect_account_dispositions": [],
            "stripe_events": [],
        })
        with (
            patch("scripts.stripe_reconciliation_report.get_settings", return_value=SimpleNamespace(
                STRIPE_RESTRICTED_KEY="rk_live_fixture",
                STRIPE_SECRET_KEY="",
            )),
            patch("scripts.stripe_reconciliation_report.create_supabase_client", return_value=supabase),
            patch("scripts.stripe_reconciliation_report.importlib.import_module", return_value=stripe_module),
        ):
            snapshot = collect_read_only_snapshot(SHA)

        self.assertEqual(event_calls, [None, "acct_1", "acct_2"])
        connected_observations = {
            row.get("_koaryu_observed_account_id")
            for row in snapshot["provider_events"]
            if row.get("_koaryu_observed_account_id")
        }
        self.assertEqual(connected_observations, {"acct_1", "acct_2"})

    def test_all_clear_requires_exact_account_dispositions_and_fresh_matched_delivery(self):
        now = datetime.now(timezone.utc)
        report = build_report(_snapshot(now), now=now)

        self.assertTrue(report["checkpoint_eligible"])
        self.assertEqual(report["counts"]["unresolved_accounts"], 0)
        self.assertEqual(report["counts"]["unresolved_event_accounts"], 0)
        self.assertTrue(report["webhook_delivery"]["authoritative_for_checkpoint"])
        self.assertFalse(report["event_idempotency_gate"]["replay_or_backfill_allowed"])

    def test_unmapped_event_account_and_failed_event_block_checkpoint(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["local_events"].append({
            "stripe_event_id": "evt_failed", "stripe_account_id": "acct_unmapped",
            "livemode": True, "type": "customer.subscription.updated",
            "processing_status": "failed", "error": "unexpected_processing_error",
            "error_reference": "f" * 32, "created_at": now.isoformat(),
        })

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["counts"]["unresolved_event_accounts"], 1)
        self.assertEqual(report["events_since_2026_07_13"]["failed"], 1)
        self.assertEqual(report["events_since_2026_07_13"]["failures"][0]["error_reference"], "f" * 32)
        self.assertNotIn("payload", report["events_since_2026_07_13"]["failures"][0])

    def test_provider_only_event_account_blocks_checkpoint(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_events"].append({
            "id": "evt_provider_only",
            "account": "acct_provider_only",
            "livemode": True,
            "created": int(now.timestamp()),
        })

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["counts"]["unresolved_accounts"], 1)
        self.assertEqual(report["counts"]["unresolved_event_accounts"], 1)
        disposition = next(
            row for row in report["event_account_reconciliation"]
            if row["stripe_connected_account_id"] == "acct_provider_only"
        )
        self.assertEqual(disposition["disposition"], "unresolved")

    def test_local_mapping_absent_from_provider_inventory_blocks_checkpoint(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["local_mappings"].append({
            "studio_id": "studio_stale",
            "stripe_connected_account_id": "acct_stale_mapping",
        })

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["counts"]["unresolved_accounts"], 1)
        self.assertEqual(
            report["mapping_drift"]["local_mappings_absent_from_provider_count"],
            1,
        )
        self.assertFalse(report["mapping_drift"]["all_local_mappings_provider_proven"])

    def test_connected_context_observation_backfills_missing_event_account_field(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_events"][0].pop("account")
        snapshot["provider_events"][0]["_koaryu_observed_account_id"] = "acct_mapped"

        report = build_report(snapshot, now=now)

        self.assertTrue(report["checkpoint_eligible"])
        self.assertEqual(report["events_since_2026_07_13"]["matched_provider_delivery_count"], 1)

    def test_wrong_mode_events_are_diagnostic_noise_not_checkpoint_evidence(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_events"][0]["livemode"] = False

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["events_since_2026_07_13"]["provider_total"], 0)
        self.assertEqual(report["events_since_2026_07_13"]["matched_provider_delivery_count"], 0)

    def test_unstructured_failure_text_is_redacted(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["local_events"].append({
            "stripe_event_id": "evt_failed", "stripe_account_id": "acct_mapped",
            "livemode": True, "type": "customer.subscription.updated",
            "processing_status": "failed", "error": "secret detail with customer@example.com",
            "created_at": now.isoformat(),
        })

        report = build_report(snapshot, now=now)

        failure = report["events_since_2026_07_13"]["failures"][0]
        self.assertEqual(failure["error_code"], "redacted_unstructured_error")
        self.assertNotIn("customer@example.com", str(report))

    def test_both_current_endpoint_topologies_are_required_after_matched_delivery(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["webhook_endpoints"] = [
            {"id": "we_platform", "status": "enabled", "connect": False,
             "url": PRODUCTION_PLATFORM_WEBHOOK_URL, "enabled_events": sorted(PLATFORM_EVENTS)},
            {"id": "we_connect", "status": "disabled", "connect": True,
             "url": PRODUCTION_CONNECT_WEBHOOK_URL, "enabled_events": sorted(CONNECT_EVENTS)},
        ]

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["webhook_delivery"]["enabled_platform_endpoint_count"], 1)
        self.assertEqual(report["webhook_delivery"]["enabled_connect_endpoint_count"], 0)

    def test_wrong_url_or_event_set_cannot_satisfy_topology(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["webhook_endpoints"][0]["url"] = "https://wrong.example/api/v1/webhooks/stripe/platform"
        snapshot["webhook_endpoints"][1]["enabled_events"] = sorted(CONNECT_EVENTS - {"charge.refunded"})

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(report["webhook_delivery"]["platform_endpoint_contract_matched"])
        self.assertFalse(report["webhook_delivery"]["connect_endpoint_contract_matched"])
        self.assertNotIn("url", report["webhook_delivery"])
        self.assertNotIn("enabled_events", report["webhook_delivery"])

    def test_wildcard_endpoint_is_rejected_even_at_the_exact_url(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["webhook_endpoints"][1]["enabled_events"] = ["*"]

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(report["webhook_delivery"]["connect_endpoint_contract_matched"])
        self.assertFalse(report["webhook_delivery"]["wildcard_accepted"])

    def test_invalid_timestamps_are_filtered_before_latest_ordering(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_events"].append({"id": "evt_bad_provider", "created": "not-a-time"})
        snapshot["local_events"].append({
            "stripe_event_id": "evt_bad_local", "stripe_account_id": "acct_mapped",
            "processing_status": "processed", "created_at": "not-a-time",
        })

        report = build_report(snapshot, now=now)

        self.assertTrue(report["checkpoint_eligible"])
        self.assertIsNotNone(report["events_since_2026_07_13"]["latest_created_at"])

    def test_duplicate_event_id_account_key_blocks_idempotency_gate(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["local_events"].append(dict(snapshot["local_events"][0]))

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(report["event_idempotency_gate"]["unique_local_event_account_keys"])
        self.assertEqual(report["event_idempotency_gate"]["duplicate_keys"][0]["count"], 2)

    def test_missing_provider_event_id_blocks_checkpoint_evidence(self):
        now = datetime.now(timezone.utc)
        snapshot = _snapshot(now)
        snapshot["provider_events"].append({
            "account": "acct_mapped",
            "livemode": True,
            "created": int(now.timestamp()),
        })

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(
            report["event_idempotency_gate"]["invalid_provider_event_id_count"],
            1,
        )

    def test_july_20_silence_is_reported_as_hypotheses_not_conclusion(self):
        now = datetime(2026, 7, 31, tzinfo=timezone.utc)
        snapshot = _snapshot(datetime(2026, 7, 20, tzinfo=timezone.utc))
        snapshot["provider_events"] = []

        report = build_report(snapshot, now=now)

        self.assertFalse(report["checkpoint_eligible"])
        self.assertTrue(report["july_20_silence"]["hypotheses_not_findings"])


if __name__ == "__main__":
    unittest.main()
