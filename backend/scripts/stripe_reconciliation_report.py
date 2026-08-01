from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import importlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable, Optional

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
PRODUCTION_PLATFORM_WEBHOOK_URL = "https://koaryu.onrender.com/api/v1/webhooks/stripe/platform"
PRODUCTION_CONNECT_WEBHOOK_URL = "https://koaryu.onrender.com/api/v1/webhooks/stripe/connect"
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
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return value.astimezone(timezone.utc) if isinstance(value, datetime) and value.tzinfo else value


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
    if SANITIZED_ERROR_CODE_PATTERN.fullmatch(normalized):
        return normalized
    return "redacted_unstructured_error"


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict_recursive"):
        return value.to_dict_recursive()
    return dict(value)


def _provider_event_account(row: dict[str, Any]) -> Optional[str]:
    return _stripe_id(row.get("account")) or _stripe_id(row.get("_koaryu_observed_account_id"))


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


def collect_read_only_snapshot(candidate_sha: str) -> dict[str, Any]:
    """Read provider and local state. This function never calls a Stripe mutation API."""
    if not SHA_PATTERN.fullmatch(candidate_sha):
        raise ReconciliationReportError("--candidate-sha must be an exact lowercase 40-character SHA.")
    settings = get_settings()
    key = str(settings.STRIPE_RESTRICTED_KEY or settings.STRIPE_SECRET_KEY).strip()
    if not key.startswith(("rk_test_", "rk_live_", "sk_test_", "sk_live_")):
        raise ReconciliationReportError("A mode-identifiable read-capable Stripe key is required.")
    stripe = importlib.import_module("stripe")
    stripe.api_key = key
    supabase = create_supabase_client()

    provider_accounts = _paginate_stripe(stripe.Account.list)
    provider_events = _paginate_stripe(stripe.Event.list, created={"gte": int(CUTOFF.timestamp())})
    for account in provider_accounts:
        account_id = _stripe_id(account)
        if not account_id:
            continue
        connected_events = _paginate_stripe(
            stripe.Event.list,
            created={"gte": int(CUTOFF.timestamp())},
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
        "stripe_event_id,stripe_account_id,livemode,type,processing_status,error,error_reference,processed_at,created_at"
    ).gte("created_at", CUTOFF.isoformat()).order("created_at"))
    return {
        "candidate_sha": candidate_sha,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "provider_mode": "live" if key.startswith(("rk_live_", "sk_live_")) else "test",
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
    provider_ids = set(provider_accounts)

    expected_livemode = mode == "live"
    local_events = [
        row for row in snapshot.get("local_events") or []
        if row.get("livemode") is expected_livemode
        and (created_at := _timestamp(row.get("created_at"))) is not None
        and created_at >= CUTOFF
    ]
    provider_events = [
        row for row in snapshot.get("provider_events") or []
        if row.get("livemode") is expected_livemode
        and (created_at := _timestamp(row.get("created"))) is not None
        and created_at >= CUTOFF
    ]
    invalid_provider_event_id_count = sum(1 for row in provider_events if not _stripe_id(row))
    invalid_local_event_id_count = sum(1 for row in local_events if not row.get("stripe_event_id"))
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
    matched_keys = provider_event_keys & local_event_keys
    matched_times = [
        _timestamp(row.get("created_at")) for row in local_events
        if (row.get("stripe_event_id"), row.get("stripe_account_id")) in matched_keys
        and row.get("processing_status") == "processed"
    ]
    latest_matched_delivery = max((value for value in matched_times if value), default=None)
    delivery_fresh = bool(latest_matched_delivery and now - latest_matched_delivery <= FRESH_DELIVERY_WINDOW)

    failed = [row for row in local_events if row.get("processing_status") == "failed"]
    observed_event_accounts = {str(row["stripe_account_id"]) for row in local_events if row.get("stripe_account_id")}
    provider_event_accounts = {
        account_id
        for row in provider_events
        if (account_id := _provider_event_account(row))
    }
    mapping_ids = set(mappings)
    account_universe = provider_ids | provider_event_accounts | observed_event_accounts | mapping_ids
    # A local mapping is proven current only when the provider account inventory
    # also contains it. A stale local-only mapping remains unresolved rather
    # than being allowed to bless itself.
    mapped_ids = mapping_ids & provider_ids
    excluded_ids = (account_universe - mapping_ids) & excluded
    unresolved_ids = account_universe - mapped_ids - excluded_ids
    unresolved_event_accounts = (
        provider_event_accounts | observed_event_accounts
    ) - mapped_ids - excluded_ids
    local_mappings_absent_from_provider = mapping_ids - provider_ids
    latest_local = max(
        (value for row in local_events if (value := _timestamp(row.get("created_at"))) is not None),
        default=None,
    )
    latest_provider = max(
        (value for row in provider_events if (value := _timestamp(row.get("created"))) is not None),
        default=None,
    )
    endpoints = [_as_dict(row) for row in snapshot.get("webhook_endpoints") or []]
    def endpoint_matches(row: dict[str, Any], *, url: str, connect: bool, events: set[str]) -> bool:
        # Wildcard delivery is deliberately rejected: it expands the ingestion
        # surface beyond the explicitly reviewed projector contract.
        enabled_events = row.get("enabled_events") or []
        return bool(
            row.get("status") == "enabled"
            and row.get("connect") is connect
            and row.get("url") == url
            and "*" not in enabled_events
            and set(enabled_events) == events
        )

    platform_endpoint_contract_matched = any(
        endpoint_matches(
            row,
            url=PRODUCTION_PLATFORM_WEBHOOK_URL,
            connect=False,
            events=PLATFORM_EVENTS,
        )
        for row in endpoints
    )
    connect_endpoint_contract_matched = any(
        endpoint_matches(
            row,
            url=PRODUCTION_CONNECT_WEBHOOK_URL,
            connect=True,
            events=CONNECT_EVENTS,
        )
        for row in endpoints
    )
    enabled_platform_endpoint_count = sum(
        1 for row in endpoints if row.get("status") == "enabled" and row.get("connect") is False
    )
    enabled_connect_endpoint_count = sum(
        1 for row in endpoints if row.get("status") == "enabled" and row.get("connect") is True
    )

    hypotheses: list[str] = []
    if latest_provider and latest_provider > KNOWN_SILENCE_START and (not latest_local or latest_local <= KNOWN_SILENCE_START):
        hypotheses.append("Provider events continued after July 20 but local receipt did not; investigate endpoint delivery, routing, and secret verification.")
    if (not latest_provider or latest_provider <= KNOWN_SILENCE_START) and (not latest_local or latest_local <= KNOWN_SILENCE_START):
        hypotheses.append("Neither snapshot shows events after July 20; provider inactivity, account-mode mismatch, or incomplete event collection remain hypotheses.")
    if not platform_endpoint_contract_matched:
        hypotheses.append("No enabled platform endpoint exactly matches the production URL and six-event contract.")
    if not connect_endpoint_contract_matched:
        hypotheses.append("No enabled Connect endpoint exactly matches the production URL and 19-event contract.")
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
    idempotency_ready = not duplicate_keys and all(row.get("stripe_event_id") for row in failed)
    checkpoint_eligible = bool(
        mode == "live"
        and not unresolved_ids
        and not unresolved_event_accounts
        and not failed
        and delivery_fresh
        and platform_endpoint_contract_matched
        and connect_endpoint_contract_matched
        and not duplicate_keys
        and invalid_provider_event_id_count == 0
        and invalid_local_event_id_count == 0
    )
    return {
        "schema_version": 1,
        "candidate_sha": candidate_sha,
        "provider_mode": mode,
        "cutoff": CUTOFF.isoformat(),
        "generated_at": now.isoformat(),
        "checkpoint_eligible": checkpoint_eligible,
        "counts": {
            "provider_accounts": len(account_universe),
            "listed_provider_accounts": len(provider_ids),
            "mapped_accounts": len(mapped_ids),
            "excluded_accounts": len(excluded_ids),
            "unresolved_accounts": len(unresolved_ids),
            "unresolved_event_accounts": len(unresolved_event_accounts),
            "local_payment_account_rows": len(snapshot.get("local_mappings") or []),
        },
        "account_reconciliation": [{
            "stripe_connected_account_id": account_id,
            "disposition": "mapped" if account_id in mapped_ids else "excluded" if account_id in excluded_ids else "unresolved",
            "studio_id": (mappings.get(account_id) or {}).get("studio_id"),
            "observed_by_provider_account_list": account_id in provider_ids,
            "observed_in_provider_events": account_id in provider_event_accounts,
            "observed_in_local_events": account_id in observed_event_accounts,
            "present_in_local_mappings": account_id in mapping_ids,
        } for account_id in sorted(account_universe)],
        "event_account_reconciliation": [{
            "stripe_connected_account_id": account_id,
            "disposition": "mapped" if account_id in mapped_ids else "excluded" if account_id in excluded_ids else "unresolved",
            "studio_id": (mappings.get(account_id) or {}).get("studio_id"),
        } for account_id in sorted(provider_event_accounts | observed_event_accounts)],
        "mapping_drift": {
            "local_mappings_absent_from_provider_count": len(local_mappings_absent_from_provider),
            "all_local_mappings_provider_proven": not local_mappings_absent_from_provider,
        },
        "events_since_2026_07_13": {
            "total": len(local_events),
            "provider_total": len(provider_event_keys),
            "matched_provider_delivery_count": len(matched_keys),
            "failed": len(failed),
            "latest_created_at": _iso(latest_local),
            "latest_provider_created_at": _iso(latest_provider),
            "failures": sanitized_failures,
        },
        "webhook_delivery": {
            "enabled_platform_endpoint_count": enabled_platform_endpoint_count,
            "enabled_connect_endpoint_count": enabled_connect_endpoint_count,
            "platform_endpoint_contract_matched": platform_endpoint_contract_matched,
            "connect_endpoint_contract_matched": connect_endpoint_contract_matched,
            "wildcard_accepted": False,
            "verified_at": _iso(latest_matched_delivery) if delivery_fresh else None,
            "fresh_within_hours": 24,
            "authoritative_for_checkpoint": delivery_fresh,
        },
        "event_idempotency_gate": {
            "unique_local_event_account_keys": not duplicate_keys,
            "duplicate_keys": duplicate_keys,
            "failed_events_have_event_ids": idempotency_ready,
            "invalid_provider_event_id_count": invalid_provider_event_id_count,
            "invalid_local_event_id_count": invalid_local_event_id_count,
            "replay_or_backfill_allowed": False,
            "reason": "Phase A is read-only; prove the exact handler path idempotent by event id before separately approving any replay.",
        },
        "july_20_silence": {
            "known_reference_date": KNOWN_SILENCE_START.isoformat(),
            "hypotheses_not_findings": hypotheses,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a sanitized, read-only Stripe reconciliation report.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, help="Offline sanitized snapshot; performs no network calls.")
    source.add_argument("--collect-read-only", action="store_true", help="Read Stripe and Supabase; never mutate either.")
    parser.add_argument("--candidate-sha", required=True)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.snapshot:
            snapshot = json.loads(args.snapshot.read_text())
            snapshot["candidate_sha"] = args.candidate_sha
        else:
            snapshot = collect_read_only_snapshot(args.candidate_sha)
        print(json.dumps(build_report(snapshot), indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, ReconciliationReportError, ModuleNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
