from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import importlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Optional

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import get_settings
from app.db.supabase import create_supabase_client


CUTOFF = datetime(2026, 7, 13, tzinfo=timezone.utc)
KNOWN_SILENCE_START = datetime(2026, 7, 20, tzinfo=timezone.utc)
FRESH_DELIVERY_WINDOW = timedelta(hours=24)
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SANITIZED_ERROR_CODE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,79}$")
PRODUCTION_READY_URL = "https://koaryu.onrender.com/health/ready"
STAGING_READY_URL = "https://koaryu-staging.onrender.com/health/ready"
PRODUCTION_PLATFORM_WEBHOOK_URL = "https://koaryu.onrender.com/api/v1/webhooks/stripe/platform"
PRODUCTION_CONNECT_WEBHOOK_URL = "https://koaryu.onrender.com/api/v1/webhooks/stripe/connect"
STAGING_PLATFORM_WEBHOOK_URL = "https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/platform"
STAGING_CONNECT_WEBHOOK_URL = "https://koaryu-staging.onrender.com/api/v1/webhooks/stripe/connect"
PLATFORM_EVENTS = {
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
}
CONNECT_EVENTS = {
    "account.updated",
    "account.application.deauthorized",
    "checkout.session.completed",
    "invoice.created",
    "invoice.finalized",
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.voided",
    "invoice.marked_uncollectible",
    "payment_intent.processing",
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "charge.refunded",
    "charge.refund.updated",
    "refund.created",
    "refund.failed",
    "refund.updated",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
}


class ReconciliationReportError(RuntimeError):
    pass


def _timestamp(value: Any) -> Optional[datetime]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value, timezone.utc)
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return None


def _iso(value: Any) -> Optional[str]:
    parsed = _timestamp(value)
    return parsed.isoformat() if parsed else None


def _stripe_id(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        value = value.get("id")
    else:
        value = getattr(value, "id", value)
    normalized = str(value or "").strip()
    return normalized or None


def _sanitized_error_code(value: Any) -> Optional[str]:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    return normalized if SANITIZED_ERROR_CODE_PATTERN.fullmatch(normalized) else "redacted_unstructured_error"


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict_recursive"):
        return value.to_dict_recursive()
    return dict(value)


def _provider_event_account(row: dict[str, Any]) -> Optional[str]:
    return _stripe_id(row.get("account")) or _stripe_id(row.get("_koaryu_observed_account_id"))


def _positive_generation(row: dict[str, Any]) -> Optional[int]:
    value = (row.get("metadata") or {}).get("connect_account_generation", 1)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _paginate_stripe(list_call, **params: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    starting_after: Optional[str] = None
    while True:
        page = list_call(limit=100, starting_after=starting_after, **params)
        page_dict = _as_dict(page)
        batch = [_as_dict(row) for row in page_dict.get("data") or []]
        rows.extend(batch)
        if not page_dict.get("has_more") or not batch:
            return rows
        starting_after = _stripe_id(batch[-1])


def _paginate_supabase(query_factory) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        batch = query_factory().range(offset, offset + 199).execute().data or []
        rows.extend(batch)
        if len(batch) < 200:
            return rows
        offset += 200


def _verify_deployed_readiness(probe: str, candidate_sha: str, *, now: datetime) -> dict[str, Any]:
    expected = {
        "production": (PRODUCTION_READY_URL, "production"),
        "staging": (STAGING_READY_URL, "staging"),
    }.get(probe)
    if expected is None:
        raise ReconciliationReportError("--probe must be production or staging.")
    url, environment = expected
    try:
        response = httpx.get(url, timeout=15, follow_redirects=False, headers={"cache-control": "no-cache"})
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ReconciliationReportError("Pinned deployment readiness probe failed.") from exc
    if not isinstance(payload, dict) or (
        payload.get("status") != "ready"
        or payload.get("service") != "koaryu-api"
        or payload.get("environment") != environment
        or payload.get("commit_sha") != candidate_sha
    ):
        raise ReconciliationReportError("Pinned /health/ready did not report the exact candidate identity.")
    return {
        "verified": True,
        "url": url,
        "environment": environment,
        "candidate_sha": candidate_sha,
        "verified_at": now.isoformat(),
    }


def collect_read_only_snapshot(candidate_sha: str, *, probe: str, now: Optional[datetime] = None) -> dict[str, Any]:
    """Read provider and local state without invoking a mutation API."""
    if not SHA_PATTERN.fullmatch(candidate_sha):
        raise ReconciliationReportError("--candidate-sha must be an exact lowercase 40-character SHA.")
    now = now or datetime.now(timezone.utc)
    settings = get_settings()
    key = str(settings.STRIPE_RESTRICTED_KEY or settings.STRIPE_SECRET_KEY).strip()
    key_mode = "live" if key.startswith(("rk_live_", "sk_live_")) else "test" if key.startswith(("rk_test_", "sk_test_")) else None
    if key_mode is None:
        raise ReconciliationReportError("A mode-identifiable read-capable Stripe key is required.")
    if (probe == "production" and key_mode != "live") or (probe == "staging" and key_mode != "test"):
        raise ReconciliationReportError("The selected diagnostic probe does not match the Stripe key mode.")
    readiness = _verify_deployed_readiness(probe, candidate_sha, now=now)
    stripe = importlib.import_module("stripe")
    stripe.api_key = key
    supabase = create_supabase_client()
    created_window = {"gte": int(CUTOFF.timestamp()), "lte": int(now.timestamp())}

    provider_accounts = _paginate_stripe(stripe.Account.list)
    provider_events = _paginate_stripe(stripe.Event.list, created=created_window)
    for account in provider_accounts:
        account_id = _stripe_id(account)
        if not account_id:
            continue
        connected_events = _paginate_stripe(
            stripe.Event.list,
            created=created_window,
            stripe_account=account_id,
        )
        for event in connected_events:
            event["_koaryu_observed_account_id"] = account_id
        provider_events.extend(connected_events)
    endpoints = _paginate_stripe(stripe.WebhookEndpoint.list)
    mappings = _paginate_supabase(lambda: supabase.table("studio_payment_accounts").select(
        "studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,details_submitted,requirements_due,metadata"
    ).order("studio_id"))
    dispositions = _paginate_supabase(lambda: supabase.table("stripe_connect_account_dispositions").select(
        "stripe_connected_account_id,excluded,reason,revision,changed_at"
    ).order("stripe_connected_account_id"))
    local_events = _paginate_supabase(lambda: supabase.table("stripe_events").select(
        "stripe_event_id,stripe_account_id,livemode,type,processing_status,error,error_reference,processed_at,created_at,"
        "live_billing_ingest_sequence"
    ).gte("created_at", CUTOFF.isoformat()).lte("created_at", now.isoformat()).order("live_billing_ingest_sequence"))
    return {
        "candidate_sha": candidate_sha,
        "collected_at": now.isoformat(),
        "event_window": {"started_at": CUTOFF.isoformat(), "ended_at": now.isoformat()},
        "evidence_source": "provider_read",
        "probe": probe,
        "deployment_readiness": readiness,
        "provider_mode": key_mode,
        "provider_accounts": provider_accounts,
        "provider_events": provider_events,
        "webhook_endpoints": endpoints,
        "local_mappings": mappings,
        "account_dispositions": dispositions,
        "local_events": local_events,
    }


def build_report(snapshot: dict[str, Any], *, now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    candidate_sha = str(snapshot.get("candidate_sha") or "").strip().lower()
    if not SHA_PATTERN.fullmatch(candidate_sha):
        raise ReconciliationReportError("Snapshot candidate_sha is invalid.")
    mode = snapshot.get("provider_mode")
    if mode not in {"test", "live"}:
        raise ReconciliationReportError("Snapshot provider_mode must be test or live.")
    evidence_source = snapshot.get("evidence_source")
    probe = snapshot.get("probe")
    window = snapshot.get("event_window") or {}
    window_start = _timestamp(window.get("started_at"))
    window_end = _timestamp(window.get("ended_at"))
    if window_start != CUTOFF or window_end is None or window_end > now + timedelta(minutes=5):
        raise ReconciliationReportError("Snapshot event window is invalid.")

    provider_accounts = {_stripe_id(row): _as_dict(row) for row in snapshot.get("provider_accounts") or []}
    provider_accounts.pop(None, None)
    mappings = {
        str(row.get("stripe_connected_account_id")): row
        for row in snapshot.get("local_mappings") or []
        if row.get("stripe_connected_account_id")
    }
    excluded = {
        str(row.get("stripe_connected_account_id"))
        for row in snapshot.get("account_dispositions") or []
        if row.get("excluded") is True and row.get("stripe_connected_account_id")
    }
    expected_livemode = mode == "live"

    def in_reviewed_universe(row: dict[str, Any], *, provider: bool) -> bool:
        account_id = _provider_event_account(row) if provider else row.get("stripe_account_id")
        event_type = str(row.get("type") or "")
        event_time = _timestamp(row.get("created") if provider else row.get("created_at"))
        expected_types = CONNECT_EVENTS if account_id else PLATFORM_EVENTS
        return bool(
            row.get("livemode") is expected_livemode
            and event_type in expected_types
            and event_time is not None
            and window_start <= event_time <= window_end
        )

    raw_provider_events = [
        row for row in snapshot.get("provider_events") or []
        if row.get("livemode") is expected_livemode
        and (event_time := _timestamp(row.get("created"))) is not None
        and window_start <= event_time <= window_end
    ]
    raw_local_events = [
        row for row in snapshot.get("local_events") or []
        if row.get("livemode") is expected_livemode
        and (event_time := _timestamp(row.get("created_at"))) is not None
        and window_start <= event_time <= window_end
    ]
    provider_events = [row for row in raw_provider_events if in_reviewed_universe(row, provider=True)]
    local_events = [row for row in raw_local_events if in_reviewed_universe(row, provider=False)]
    invalid_provider_event_id_count = sum(1 for row in provider_events if not _stripe_id(row))
    invalid_local_event_id_count = sum(1 for row in local_events if not row.get("stripe_event_id"))
    invalid_local_sequence_count = sum(
        1 for row in raw_local_events
        if isinstance(row.get("live_billing_ingest_sequence"), bool)
        or not isinstance(row.get("live_billing_ingest_sequence"), int)
        or row.get("live_billing_ingest_sequence") <= 0
    )
    provider_event_keys = {
        (event_id, _provider_event_account(row))
        for row in provider_events
        if (event_id := _stripe_id(row))
    }
    local_event_key_list = [(row.get("stripe_event_id"), row.get("stripe_account_id")) for row in local_events]
    local_event_keys = set(local_event_key_list)
    duplicate_keys = [
        {"event_id": event_id, "stripe_account_id": account_id, "count": count}
        for (event_id, account_id), count in Counter(local_event_key_list).items()
        if count > 1
    ]
    provider_only_keys = provider_event_keys - local_event_keys
    local_only_keys = local_event_keys - provider_event_keys
    matched_keys = provider_event_keys & local_event_keys

    def local_matched_times(account_id: Optional[str]) -> list[datetime]:
        return [
            value for row in local_events
            if row.get("stripe_account_id") == account_id
            and (row.get("stripe_event_id"), account_id) in matched_keys
            and row.get("processing_status") == "processed"
            and (value := _timestamp(row.get("created_at"))) is not None
        ]

    platform_times = local_matched_times(None)
    latest_platform_delivery = max(platform_times, default=None)
    platform_delivery_fresh = bool(
        latest_platform_delivery
        and now - FRESH_DELIVERY_WINDOW <= latest_platform_delivery <= now + timedelta(minutes=5)
    )
    failed = [row for row in raw_local_events if row.get("processing_status") == "failed"]
    observed_event_accounts = {str(row["stripe_account_id"]) for row in raw_local_events if row.get("stripe_account_id")}
    provider_event_accounts = {
        account_id for row in raw_provider_events if (account_id := _provider_event_account(row))
    }
    provider_ids = set(provider_accounts)
    mapping_ids = set(mappings)
    account_universe = provider_ids | provider_event_accounts | observed_event_accounts | mapping_ids
    mapped_ids = mapping_ids & provider_ids
    excluded_ids = (account_universe - mapping_ids) & excluded
    unresolved_ids = account_universe - mapped_ids - excluded_ids
    unresolved_event_accounts = (provider_event_accounts | observed_event_accounts) - mapped_ids - excluded_ids
    local_mappings_absent_from_provider = mapping_ids - provider_ids

    account_evidence: list[dict[str, Any]] = []
    invalid_generation_count = 0
    for account_id in sorted(mapped_ids):
        mapping = mappings[account_id]
        generation = _positive_generation(mapping)
        if generation is None:
            invalid_generation_count += 1
        provider_keys = {key for key in provider_event_keys if key[1] == account_id}
        local_keys = {key for key in local_event_keys if key[1] == account_id}
        times = local_matched_times(account_id)
        latest_delivery = max(times, default=None)
        delivery_fresh = bool(
            latest_delivery
            and now - FRESH_DELIVERY_WINDOW <= latest_delivery <= now + timedelta(minutes=5)
        )
        account_evidence.append({
            "studio_id": mapping.get("studio_id"),
            "stripe_connected_account_id": account_id,
            "connect_account_generation": generation,
            "provider_event_count": len(provider_keys),
            "local_event_count": len(local_keys),
            "provider_only_event_count": len(provider_keys - local_keys),
            "local_only_event_count": len(local_keys - provider_keys),
            "delivery_verified_at": _iso(latest_delivery) if delivery_fresh else None,
            "fresh": delivery_fresh,
        })

    endpoint_urls = {
        "production": (PRODUCTION_PLATFORM_WEBHOOK_URL, PRODUCTION_CONNECT_WEBHOOK_URL),
        "staging": (STAGING_PLATFORM_WEBHOOK_URL, STAGING_CONNECT_WEBHOOK_URL),
    }.get(probe, (None, None))
    platform_url, connect_url = endpoint_urls
    endpoints = [_as_dict(row) for row in snapshot.get("webhook_endpoints") or []]
    enabled_endpoints = [row for row in endpoints if row.get("status") == "enabled"]

    def endpoint_matches(row: dict[str, Any], *, url: Optional[str], connect: bool, events: set[str]) -> bool:
        enabled_events = row.get("enabled_events") or []
        return bool(
            url
            and row.get("connect") is connect
            and row.get("url") == url
            and "*" not in enabled_events
            and set(enabled_events) == events
        )

    enabled_platform = [row for row in enabled_endpoints if row.get("connect") is False]
    enabled_connect = [row for row in enabled_endpoints if row.get("connect") is True]
    platform_endpoint_contract_matched = len(enabled_platform) == 1 and endpoint_matches(
        enabled_platform[0], url=platform_url, connect=False, events=PLATFORM_EVENTS
    )
    connect_endpoint_contract_matched = len(enabled_connect) == 1 and endpoint_matches(
        enabled_connect[0], url=connect_url, connect=True, events=CONNECT_EVENTS
    )
    unexpected_enabled_endpoint_count = len(enabled_endpoints) - int(platform_endpoint_contract_matched) - int(connect_endpoint_contract_matched)

    deployment = snapshot.get("deployment_readiness") or {}
    deployment_verified_at = _timestamp(deployment.get("verified_at"))
    production_readiness_verified = bool(
        evidence_source == "provider_read"
        and probe == "production"
        and deployment.get("verified") is True
        and deployment.get("url") == PRODUCTION_READY_URL
        and deployment.get("environment") == "production"
        and deployment.get("candidate_sha") == candidate_sha
        and deployment_verified_at is not None
        and now - timedelta(minutes=15) <= deployment_verified_at <= now + timedelta(minutes=5)
    )
    account_delivery_complete = bool(
        len(account_evidence) == len(mapped_ids)
        and all(
            evidence["fresh"]
            and evidence["connect_account_generation"] is not None
            and evidence["provider_event_count"] > 0
            and evidence["provider_only_event_count"] == 0
            and evidence["local_only_event_count"] == 0
            for evidence in account_evidence
        )
    )
    latest_local = max(
        (value for row in raw_local_events if (value := _timestamp(row.get("created_at"))) is not None),
        default=None,
    )
    latest_provider = max(
        (value for row in raw_provider_events if (value := _timestamp(row.get("created"))) is not None),
        default=None,
    )
    watermark = max(
        (
            row["live_billing_ingest_sequence"] for row in raw_local_events
            if isinstance(row.get("live_billing_ingest_sequence"), int)
            and not isinstance(row.get("live_billing_ingest_sequence"), bool)
        ),
        default=0,
    )
    checkpoint_eligible = bool(
        production_readiness_verified
        and mode == "live"
        and not unresolved_ids
        and not unresolved_event_accounts
        and not failed
        and not provider_only_keys
        and not local_only_keys
        and platform_delivery_fresh
        and account_delivery_complete
        and platform_endpoint_contract_matched
        and connect_endpoint_contract_matched
        and unexpected_enabled_endpoint_count == 0
        and not duplicate_keys
        and invalid_provider_event_id_count == 0
        and invalid_local_event_id_count == 0
        and invalid_local_sequence_count == 0
        and invalid_generation_count == 0
    )

    hypotheses: list[str] = []
    if latest_provider and latest_provider > KNOWN_SILENCE_START and (not latest_local or latest_local <= KNOWN_SILENCE_START):
        hypotheses.append("Provider events continued after July 20 but local receipt did not; investigate endpoint delivery, routing, and secret verification.")
    if (not latest_provider or latest_provider <= KNOWN_SILENCE_START) and (not latest_local or latest_local <= KNOWN_SILENCE_START):
        hypotheses.append("Neither bounded snapshot shows events after July 20; provider inactivity, mode mismatch, or incomplete collection remain hypotheses.")
    if failed:
        hypotheses.append("Failed local events require event-id-specific diagnosis and idempotency proof before any replay or backfill.")

    sanitized_failures = [{
        "event_id": row.get("stripe_event_id"),
        "stripe_account_id": row.get("stripe_account_id"),
        "type": row.get("type"),
        "error_code": _sanitized_error_code(row.get("error")),
        "error_reference": row.get("error_reference"),
        "created_at": _iso(row.get("created_at")),
    } for row in failed]
    return {
        "schema_version": 2,
        "candidate_sha": candidate_sha,
        "provider_mode": mode,
        "evidence_source": evidence_source,
        "probe": probe,
        "generated_at": now.isoformat(),
        "event_window": {"started_at": window_start.isoformat(), "ended_at": window_end.isoformat()},
        "checkpoint_eligible": checkpoint_eligible,
        "deployment_readiness": {
            "production_exact_candidate_verified": production_readiness_verified,
            "verified_at": _iso(deployment_verified_at) if production_readiness_verified else None,
        },
        "counts": {
            "provider_accounts": len(account_universe),
            "listed_provider_accounts": len(provider_ids),
            "mapped_accounts": len(mapped_ids),
            "excluded_accounts": len(excluded_ids),
            "unresolved_accounts": len(unresolved_ids),
            "unresolved_event_accounts": len(unresolved_event_accounts),
            "local_payment_account_rows": len(snapshot.get("local_mappings") or []),
        },
        "account_evidence": account_evidence,
        "mapping_drift": {
            "local_mappings_absent_from_provider_count": len(local_mappings_absent_from_provider),
            "all_local_mappings_provider_proven": not local_mappings_absent_from_provider,
        },
        "events_since_2026_07_13": {
            "bounded_provider_total": len(provider_event_keys),
            "bounded_local_total": len(local_event_keys),
            "matched_provider_delivery_count": len(matched_keys),
            "provider_only_event_count": len(provider_only_keys),
            "local_only_event_count": len(local_only_keys),
            "failed": len(failed),
            "latest_created_at": _iso(latest_local),
            "latest_provider_created_at": _iso(latest_provider),
            "local_event_ingest_watermark": watermark,
            "failures": sanitized_failures,
        },
        "platform_delivery": {
            "provider_event_count": len({key for key in provider_event_keys if key[1] is None}),
            "local_event_count": len({key for key in local_event_keys if key[1] is None}),
            "delivery_verified_at": _iso(latest_platform_delivery) if platform_delivery_fresh else None,
            "fresh": platform_delivery_fresh,
        },
        "webhook_delivery": {
            "enabled_platform_endpoint_count": len(enabled_platform),
            "enabled_connect_endpoint_count": len(enabled_connect),
            "unexpected_enabled_endpoint_count": unexpected_enabled_endpoint_count,
            "platform_endpoint_contract_matched": platform_endpoint_contract_matched,
            "connect_endpoint_contract_matched": connect_endpoint_contract_matched,
            "wildcard_accepted": False,
        },
        "event_idempotency_gate": {
            "unique_local_event_account_keys": not duplicate_keys,
            "duplicate_keys": duplicate_keys,
            "invalid_provider_event_id_count": invalid_provider_event_id_count,
            "invalid_local_event_id_count": invalid_local_event_id_count,
            "invalid_local_sequence_count": invalid_local_sequence_count,
            "replay_or_backfill_allowed": False,
            "reason": "Read-only evidence never authorizes replay; prove the exact event-id handler path before separate approval.",
        },
        "july_20_silence": {
            "known_reference_date": KNOWN_SILENCE_START.isoformat(),
            "hypotheses_not_findings": hypotheses,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a sanitized, read-only Stripe reconciliation report.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, help="Offline sanitized snapshot; permanently checkpoint-ineligible.")
    source.add_argument("--collect-read-only", action="store_true", help="Read Stripe, Supabase, and pinned readiness only.")
    parser.add_argument("--probe", choices=("production", "staging"), help="Required for live collection; staging is diagnostic only.")
    parser.add_argument("--candidate-sha", required=True)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.snapshot:
            if args.probe:
                raise ReconciliationReportError("Offline snapshots cannot claim a deployment probe.")
            snapshot = json.loads(args.snapshot.read_text())
            snapshot["candidate_sha"] = args.candidate_sha
            snapshot["evidence_source"] = "offline_snapshot"
            snapshot["probe"] = None
            snapshot["deployment_readiness"] = None
        else:
            if not args.probe:
                raise ReconciliationReportError("--collect-read-only requires --probe production or staging.")
            snapshot = collect_read_only_snapshot(args.candidate_sha, probe=args.probe)
        print(json.dumps(build_report(snapshot), indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, ReconciliationReportError, ModuleNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
