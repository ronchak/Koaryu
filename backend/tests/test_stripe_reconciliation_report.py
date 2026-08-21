from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.stripe_reconciliation_report import (
    CONNECT_EVENTS,
    MINIMUM_CONTINUITY_OVERLAP,
    PLATFORM_EVENTS,
    PRODUCTION_CONNECT_WEBHOOK_URL,
    PRODUCTION_PLATFORM_WEBHOOK_URL,
    PRODUCTION_READY_URL,
    PROVIDER_EVENT_RETENTION,
    ROLLING_EVENT_WINDOW,
    STAGING_CONNECT_WEBHOOK_URL,
    STAGING_PLATFORM_WEBHOOK_URL,
    STAGING_READY_URL,
    ReconciliationReportError,
    _resolve_collection_window,
    build_report,
    collect_read_only_snapshot,
)
from tests.fakes.supabase import TableBackedSupabase


SHA = "a" * 40
STUDIO_ID = "00000000-0000-0000-0000-000000000001"


def _event(
    event_id: str,
    event_type: str,
    created: datetime,
    account_id: str | None = None,
    *,
    livemode: bool = True,
) -> dict:
    row = {
        "id": event_id,
        "type": event_type,
        "livemode": livemode,
        "created": int(created.timestamp()),
    }
    if account_id:
        row["account"] = account_id
    return row


def _local_event(
    event_id: str,
    event_type: str,
    created: datetime,
    sequence: int,
    account_id: str | None = None,
    *,
    livemode: bool = True,
    processing_status: str = "processed",
) -> dict:
    return {
        "stripe_event_id": event_id,
        "stripe_account_id": account_id,
        "livemode": livemode,
        "type": event_type,
        "processing_status": processing_status,
        "processed_at": created.isoformat() if processing_status == "processed" else None,
        "created_at": created.isoformat(),
        "live_billing_ingest_sequence": sequence,
    }


def _endpoint(endpoint_id: str, url: str, events: set[str], *, status: str = "enabled", livemode: bool = True) -> dict:
    # This is the retrievable Stripe Webhook Endpoint shape. It intentionally
    # contains no fabricated `connect` creation parameter.
    return {
        "id": endpoint_id,
        "object": "webhook_endpoint",
        "status": status,
        "livemode": livemode,
        "url": url,
        "enabled_events": sorted(events),
        "api_version": None,
        "application": None,
        "metadata": {},
    }


def _snapshot(now: datetime) -> dict:
    created = now - timedelta(minutes=5)
    window_start = now - ROLLING_EVENT_WINDOW
    platform = _local_event("evt_platform", "invoice.paid", created, 1)
    connect = _local_event("evt_connect", "account.updated", created, 2, "acct_mapped")
    return {
        "candidate_sha": SHA,
        "collected_at": now.isoformat(),
        "event_window": {
            "started_at": window_start.isoformat(),
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
            "studio_id": STUDIO_ID,
            "stripe_connected_account_id": "acct_mapped",
            "metadata": {"connect_account_generation": 3},
        }],
        "account_dispositions": [{
            "stripe_connected_account_id": "acct_excluded",
            "excluded": True,
        }],
        "provider_events": [
            _event("evt_platform", "invoice.paid", created),
            _event("evt_connect", "account.updated", created, "acct_mapped"),
        ],
        "local_events": [platform, connect],
        "local_history_events": [platform, connect],
        "webhook_endpoints": [
            _endpoint("we_platform", PRODUCTION_PLATFORM_WEBHOOK_URL, PLATFORM_EVENTS),
            _endpoint("we_connect", PRODUCTION_CONNECT_WEBHOOK_URL, CONNECT_EVENTS),
        ],
        "v3_checkpoints": [],
        "previous_checkpoint": None,
        "previous_account_evidence": [],
        "enabled_authorizations": [],
    }


def _prior_checkpoint(now: datetime, *, watermark: int = 2, overlap: timedelta = timedelta(days=28)) -> dict:
    previous_end = now - timedelta(hours=1)
    previous_start = previous_end - ROLLING_EVENT_WINDOW
    return {
        "checkpoint_id": "11111111-1111-4111-8111-111111111111",
        "checkpoint_sequence": 7,
        "candidate_sha": "b" * 40,
        "verified_at": (now - timedelta(hours=1)).isoformat(),
        "expires_at": (now + timedelta(hours=1)).isoformat(),
        "source_report_sha256": "c" * 64,
        "continuity_mode": "bootstrap",
        "previous_checkpoint_id": None,
        "previous_checkpoint_sequence": None,
        "event_window_started_at": previous_start.isoformat(),
        "event_window_ended_at": (now - ROLLING_EVENT_WINDOW + overlap).isoformat(),
        "continuity_overlap_started_at": None,
        "continuity_overlap_ended_at": None,
        "previous_local_event_ingest_watermark": None,
        "local_event_ingest_watermark": watermark,
        "bootstrap_historical_provider_completeness_claimed": False,
        "bootstrap_local_history_checked": True,
        "created_at": (now - timedelta(hours=1)).isoformat(),
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
    def test_read_only_collector_uses_complete_rolling_window_and_each_account_context(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)
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
                    "data": [{
                        "id": f"evt_{suffix}",
                        "type": "account.updated" if account_id else "invoice.paid",
                        "livemode": True,
                        "created": params["created"]["gte"],
                    }],
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
            "stripe_live_billing_reconciliation_checkpoints_v3": [],
            "stripe_live_billing_reconciliation_account_evidence": [],
            "studio_live_billing_authorizations": [],
        })
        with (
            patch("scripts.stripe_reconciliation_report.get_settings", return_value=SimpleNamespace(
                STRIPE_RESTRICTED_KEY="rk_live_fixture",
                STRIPE_SECRET_KEY="",
            )),
            patch("scripts.stripe_reconciliation_report.create_supabase_client", return_value=supabase),
            patch("scripts.stripe_reconciliation_report.httpx.get", return_value=_ReadyResponse()),
            patch("scripts.stripe_reconciliation_report.importlib.import_module", return_value=stripe_module),
        ):
            snapshot = collect_read_only_snapshot(SHA, probe="production", now=now)

        self.assertEqual(event_calls, [None, "acct_1", "acct_2"])
        self.assertEqual(
            datetime.fromisoformat(snapshot["event_window"]["started_at"]),
            now - ROLLING_EVENT_WINDOW,
        )
        self.assertEqual(snapshot["deployment_readiness"]["url"], PRODUCTION_READY_URL)

    def test_frozen_future_bootstrap_report_is_checkpoint_eligible(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)

        report = build_report(_snapshot(now), now=now)

        self.assertEqual(report["schema_version"], 3)
        self.assertTrue(report["checkpoint_eligible"])
        self.assertEqual(report["continuity"]["mode"], "bootstrap")
        self.assertTrue(report["continuity"]["bootstrap_local_history_checked"])
        self.assertFalse(
            report["continuity"]["bootstrap_historical_provider_completeness_claimed"]
        )
        self.assertEqual(report["event_reconciliation"]["provider_only_event_count"], 0)
        self.assertEqual(report["event_reconciliation"]["local_only_event_count"], 0)

    def test_requested_or_snapshot_window_outside_retention_fails_explicitly(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)
        with self.assertRaisesRegex(ReconciliationReportError, "retention safety boundary"):
            _resolve_collection_window(
                now=now,
                requested_start=now - PROVIDER_EVENT_RETENTION,
            )

        snapshot = _snapshot(now)
        snapshot["event_window"]["started_at"] = (
            now - PROVIDER_EVENT_RETENTION
        ).isoformat()
        with self.assertRaisesRegex(ReconciliationReportError, "retention safety boundary"):
            build_report(snapshot, now=now)

    def test_rolling_continuity_requires_valid_prior_overlap_and_watermark(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)
        snapshot = _snapshot(now)
        prior = _prior_checkpoint(now)
        snapshot["v3_checkpoints"] = [prior]
        snapshot["previous_checkpoint"] = prior
        snapshot["previous_account_evidence"] = [{
            "checkpoint_id": prior["checkpoint_id"],
            "studio_id": STUDIO_ID,
            "stripe_connected_account_id": "acct_mapped",
            "connect_account_generation": 3,
        }]
        report = build_report(snapshot, now=now)
        self.assertTrue(report["checkpoint_eligible"])
        self.assertEqual(report["continuity"]["mode"], "rolling")
        self.assertGreaterEqual(
            report["continuity"]["overlap_seconds"],
            int(MINIMUM_CONTINUITY_OVERLAP.total_seconds()),
        )

        missing = _snapshot(now)
        missing["v3_checkpoints"] = [{"checkpoint_id": prior["checkpoint_id"]}]
        missing["previous_checkpoint"] = {"checkpoint_id": prior["checkpoint_id"]}
        self.assertFalse(build_report(missing, now=now)["checkpoint_eligible"])

        broken = _snapshot(now)
        broken_prior = _prior_checkpoint(now, overlap=timedelta(hours=12))
        broken["v3_checkpoints"] = [broken_prior]
        broken["previous_checkpoint"] = broken_prior
        broken["previous_account_evidence"] = snapshot["previous_account_evidence"]
        self.assertFalse(build_report(broken, now=now)["checkpoint_eligible"])

        regressed = _snapshot(now)
        regressed_prior = _prior_checkpoint(now, watermark=99)
        regressed["v3_checkpoints"] = [regressed_prior]
        regressed["previous_checkpoint"] = regressed_prior
        regressed["previous_account_evidence"] = snapshot["previous_account_evidence"]
        report = build_report(regressed, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(
            report["continuity"]["local_event_ingest_watermark_non_regressing"]
        )

    def test_bootstrap_is_explicit_and_fails_on_existing_grant_or_dirty_history(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)
        snapshot = _snapshot(now)
        snapshot["enabled_authorizations"] = [{"enabled": True}]
        report = build_report(snapshot, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["continuity"]["bootstrap_enabled_authorization_count"], 1)

        snapshot = _snapshot(now)
        dirty = _local_event(
            "evt_historical_failed",
            "refund.failed",
            now - timedelta(days=40),
            3,
            "acct_mapped",
            processing_status="failed",
        )
        snapshot["local_history_events"].append(dirty)
        report = build_report(snapshot, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["continuity"]["bootstrap_historical_failed_count"], 1)
        self.assertFalse(
            report["continuity"]["bootstrap_historical_provider_completeness_claimed"]
        )

    def test_provider_local_processing_mapping_mode_generation_and_sha_defects_fail_closed(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)

        provider_only = _snapshot(now)
        provider_only["provider_events"].append(
            _event("evt_provider_only", "invoice.paid", now - timedelta(minutes=2))
        )
        self.assertFalse(build_report(provider_only, now=now)["checkpoint_eligible"])

        local_only = _snapshot(now)
        extra = _local_event(
            "evt_local_only", "invoice.paid", now - timedelta(minutes=2), 3
        )
        local_only["local_events"].append(extra)
        local_only["local_history_events"].append(extra)
        self.assertFalse(build_report(local_only, now=now)["checkpoint_eligible"])

        for status in ("pending", "processing", "ignored", "failed"):
            with self.subTest(status=status):
                stuck = _snapshot(now)
                event = _local_event(
                    "evt_stuck",
                    "refund.failed",
                    now - timedelta(minutes=1),
                    3,
                    "acct_mapped",
                    processing_status=status,
                )
                stuck["provider_events"].append(
                    _event(
                        "evt_stuck",
                        "refund.failed",
                        now - timedelta(minutes=1),
                        "acct_mapped",
                    )
                )
                stuck["local_events"].append(event)
                stuck["local_history_events"].append(event)
                self.assertFalse(build_report(stuck, now=now)["checkpoint_eligible"])

        unmapped = _snapshot(now)
        risk = _local_event(
            "evt_unmapped",
            "provider.future_event",
            now - timedelta(minutes=1),
            3,
            "acct_unknown",
            processing_status="failed",
        )
        unmapped["local_events"].append(risk)
        unmapped["local_history_events"].append(risk)
        self.assertFalse(build_report(unmapped, now=now)["checkpoint_eligible"])

        wrong_mode = _snapshot(now)
        wrong_mode["provider_events"][0]["livemode"] = False
        report = build_report(wrong_mode, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(
            report["event_reconciliation"]["wrong_mode_provider_event_count"], 1
        )

        stale_generation = _snapshot(now)
        prior = _prior_checkpoint(now)
        stale_generation["v3_checkpoints"] = [prior]
        stale_generation["previous_checkpoint"] = prior
        stale_generation["previous_account_evidence"] = [{
            "stripe_connected_account_id": "acct_mapped",
            "connect_account_generation": 2,
        }]
        report = build_report(stale_generation, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertFalse(
            report["continuity"]["account_generation_continuity_valid"]
        )

        stale_sha = _snapshot(now)
        stale_sha["deployment_readiness"]["candidate_sha"] = "b" * 40
        self.assertFalse(build_report(stale_sha, now=now)["checkpoint_eligible"])

    def test_realistic_endpoint_objects_pass_only_for_exact_two_surfaces(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)
        snapshot = _snapshot(now)
        self.assertTrue(all("connect" not in row for row in snapshot["webhook_endpoints"]))

        report = build_report(snapshot, now=now)

        self.assertTrue(report["webhook_delivery"]["platform_endpoint_contract_matched"])
        self.assertTrue(report["webhook_delivery"]["connect_endpoint_contract_matched"])
        self.assertTrue(report["webhook_delivery"]["connected_event_context_verified"])
        self.assertTrue(report["checkpoint_eligible"])

    def test_missing_duplicate_disabled_misrouted_and_unexpected_endpoints_fail(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)

        missing = _snapshot(now)
        missing["webhook_endpoints"] = missing["webhook_endpoints"][:1]
        self.assertFalse(build_report(missing, now=now)["checkpoint_eligible"])

        duplicate = _snapshot(now)
        duplicate["webhook_endpoints"].append(
            _endpoint("we_connect_2", PRODUCTION_CONNECT_WEBHOOK_URL, CONNECT_EVENTS)
        )
        report = build_report(duplicate, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["webhook_delivery"]["connect_endpoint_candidate_count"], 2)

        disabled = _snapshot(now)
        disabled["webhook_endpoints"][1]["status"] = "disabled"
        self.assertFalse(build_report(disabled, now=now)["checkpoint_eligible"])

        misrouted = _snapshot(now)
        misrouted["webhook_endpoints"][0]["enabled_events"] = sorted(CONNECT_EVENTS)
        misrouted["webhook_endpoints"][1]["enabled_events"] = sorted(PLATFORM_EVENTS)
        self.assertFalse(build_report(misrouted, now=now)["checkpoint_eligible"])

        unexpected = _snapshot(now)
        unexpected["webhook_endpoints"].append(
            _endpoint("we_extra", "https://extra.example/webhook", {"account.updated"})
        )
        report = build_report(unexpected, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertEqual(report["webhook_delivery"]["unexpected_enabled_endpoint_count"], 1)

    def test_offline_and_staging_remain_checkpoint_ineligible(self):
        now = datetime(2027, 2, 15, 12, 0, tzinfo=timezone.utc)
        offline = _snapshot(now)
        offline["evidence_source"] = "offline_snapshot"
        offline["probe"] = None
        offline["deployment_readiness"] = None
        self.assertFalse(build_report(offline, now=now)["checkpoint_eligible"])

        staging = _snapshot(now)
        staging["provider_mode"] = "test"
        staging["probe"] = "staging"
        staging["deployment_readiness"].update({
            "environment": "staging",
            "url": STAGING_READY_URL,
        })
        for event in [*staging["provider_events"], *staging["local_events"], *staging["local_history_events"]]:
            event["livemode"] = False
        staging["webhook_endpoints"] = [
            _endpoint(
                "we_platform",
                STAGING_PLATFORM_WEBHOOK_URL,
                PLATFORM_EVENTS,
                livemode=False,
            ),
            _endpoint(
                "we_connect",
                STAGING_CONNECT_WEBHOOK_URL,
                CONNECT_EVENTS,
                livemode=False,
            ),
        ]
        report = build_report(staging, now=now)
        self.assertFalse(report["checkpoint_eligible"])
        self.assertTrue(report["webhook_delivery"]["platform_endpoint_contract_matched"])
        self.assertTrue(report["webhook_delivery"]["connect_endpoint_contract_matched"])

    def test_active_v3_surface_has_no_legacy_fixed_date_dependency(self):
        root = Path(__file__).resolve().parents[2]
        paths = [
            root / "backend/scripts/stripe_reconciliation_report.py",
            root / "backend/scripts/live_billing_authorizations.py",
            root / "supabase/migrations/20260820170000_live_billing_reconciliation_v3.sql",
            root / "supabase/verification/studio_live_billing_authorizations_contract.sql",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertNotIn("2026-07-13", path.read_text())


if __name__ == "__main__":
    unittest.main()
