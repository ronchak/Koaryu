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


PROVIDER_EVENT_RETENTION = timedelta(days=30)
PROVIDER_WINDOW_SAFETY_MARGIN = timedelta(days=1)
ROLLING_EVENT_WINDOW = PROVIDER_EVENT_RETENTION - PROVIDER_WINDOW_SAFETY_MARGIN
MINIMUM_CONTINUITY_OVERLAP = timedelta(hours=24)
FRESH_DELIVERY_WINDOW = timedelta(hours=24)
READINESS_FRESHNESS = timedelta(minutes=15)
MAX_FUTURE_SKEW = timedelta(minutes=5)
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


def _positive_sequence(row: dict[str, Any]) -> Optional[int]:
    value = row.get("live_billing_ingest_sequence")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


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


def _expected_window_start(window_end: datetime) -> datetime:
    return window_end - ROLLING_EVENT_WINDOW


def _resolve_collection_window(
    *,
    now: datetime,
    requested_start: Optional[datetime] = None,
) -> tuple[datetime, datetime]:
    window_end = now.astimezone(timezone.utc)
    oldest_supported = _expected_window_start(window_end)
    if requested_start is None:
        return oldest_supported, window_end
    normalized = requested_start.astimezone(timezone.utc)
    if normalized < oldest_supported:
        raise ReconciliationReportError(
            "Requested event window starts outside the provider-supported retention safety boundary."
        )
    if normalized >= window_end:
        raise ReconciliationReportError("Requested event window start must be earlier than its end.")
    return normalized, window_end


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


def _latest_v3_checkpoints(supabase: Any) -> list[dict[str, Any]]:
    return _paginate_supabase(lambda: (
        supabase.table("stripe_live_billing_reconciliation_checkpoints_v3")
        .select(
            "checkpoint_id,checkpoint_sequence,candidate_sha,verified_at,expires_at,"
            "source_report_sha256,continuity_mode,previous_checkpoint_id,"
            "previous_checkpoint_sequence,event_window_started_at,event_window_ended_at,"
            "continuity_overlap_started_at,continuity_overlap_ended_at,"
            "previous_local_event_ingest_watermark,local_event_ingest_watermark,"
            "bootstrap_historical_provider_completeness_claimed,"
            "bootstrap_local_history_checked,created_at"
        )
        .order("checkpoint_sequence", desc=True)
    ))


def collect_read_only_snapshot(
    candidate_sha: str,
    *,
    probe: str,
    window_start: Optional[datetime] = None,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Read provider and local state without invoking a mutation API."""
    if not SHA_PATTERN.fullmatch(candidate_sha):
        raise ReconciliationReportError("--candidate-sha must be an exact lowercase 40-character SHA.")
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    window_start, window_end = _resolve_collection_window(now=now, requested_start=window_start)
    settings = get_settings()
    key = str(settings.STRIPE_RESTRICTED_KEY or settings.STRIPE_SECRET_KEY).strip()
    key_mode = (
        "live" if key.startswith(("rk_live_", "sk_live_"))
        else "test" if key.startswith(("rk_test_", "sk_test_"))
        else None
    )
    if key_mode is None:
        raise ReconciliationReportError("A mode-identifiable read-capable Stripe key is required.")
    if (probe == "production" and key_mode != "live") or (probe == "staging" and key_mode != "test"):
        raise ReconciliationReportError("The selected diagnostic probe does not match the Stripe key mode.")

    readiness = _verify_deployed_readiness(probe, candidate_sha, now=now)
    stripe = importlib.import_module("stripe")
    stripe.api_key = key
    supabase = create_supabase_client()
    created_window = {"gte": int(window_start.timestamp()), "lte": int(window_end.timestamp())}

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
    mappings = _paginate_supabase(lambda: (
        supabase.table("studio_payment_accounts")
        .select(
            "studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,"
            "details_submitted,requirements_due,metadata"
        )
        .order("studio_id")
    ))
    dispositions = _paginate_supabase(lambda: (
        supabase.table("stripe_connect_account_dispositions")
        .select("stripe_connected_account_id,excluded,reason,revision,changed_at")
        .order("stripe_connected_account_id")
    ))
    event_columns = (
        "stripe_event_id,stripe_account_id,livemode,type,processing_status,error,error_reference,"
        "processed_at,created_at,live_billing_ingest_sequence"
    )
    local_events = _paginate_supabase(lambda: (
        supabase.table("stripe_events")
        .select(event_columns)
        .gte("created_at", window_start.isoformat())
        .lte("created_at", window_end.isoformat())
        .order("live_billing_ingest_sequence")
    ))
    expected_livemode = key_mode == "live"
    local_history_events = _paginate_supabase(lambda: (
        supabase.table("stripe_events")
        .select(event_columns)
        .eq("livemode", expected_livemode)
        .lte("created_at", window_end.isoformat())
        .order("live_billing_ingest_sequence")
    ))
    v3_checkpoints = _latest_v3_checkpoints(supabase)
    previous_checkpoint = v3_checkpoints[0] if v3_checkpoints else None
    previous_account_evidence: list[dict[str, Any]] = []
    if previous_checkpoint and previous_checkpoint.get("checkpoint_id"):
        previous_account_evidence = _paginate_supabase(lambda: (
            supabase.table("stripe_live_billing_reconciliation_account_evidence")
            .select(
                "checkpoint_id,studio_id,stripe_connected_account_id,connect_account_generation,"
                "provider_event_count,local_event_count,provider_only_event_count,"
                "local_only_event_count,delivery_verified_at"
            )
            .eq("checkpoint_id", previous_checkpoint["checkpoint_id"])
            .order("stripe_connected_account_id")
        ))
    enabled_authorizations = _paginate_supabase(lambda: (
        supabase.table("studio_live_billing_authorizations")
        .select("studio_id,scope,enabled,reconciliation_checkpoint_id,local_event_ingest_watermark")
        .eq("enabled", True)
        .order("studio_id")
        .order("scope")
    ))

    return {
        "candidate_sha": candidate_sha,
        "collected_at": now.isoformat(),
        "event_window": {
            "started_at": window_start.isoformat(),
            "ended_at": window_end.isoformat(),
        },
        "window_policy": {
            "provider_retention_seconds": int(PROVIDER_EVENT_RETENTION.total_seconds()),
            "safety_margin_seconds": int(PROVIDER_WINDOW_SAFETY_MARGIN.total_seconds()),
            "rolling_window_seconds": int(ROLLING_EVENT_WINDOW.total_seconds()),
            "minimum_continuity_overlap_seconds": int(MINIMUM_CONTINUITY_OVERLAP.total_seconds()),
        },
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
        "local_history_events": local_history_events,
        "v3_checkpoints": v3_checkpoints,
        "previous_checkpoint": previous_checkpoint,
        "previous_account_evidence": previous_account_evidence,
        "enabled_authorizations": enabled_authorizations,
    }


def _checkpoint_row(sidecar: dict[str, Any]) -> dict[str, Any]:
    return sidecar


def build_report(snapshot: dict[str, Any], *, now: Optional[datetime] = None) -> dict[str, Any]:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    candidate_sha = str(snapshot.get("candidate_sha") or "").strip().lower()
    if not SHA_PATTERN.fullmatch(candidate_sha):
        raise ReconciliationReportError("Snapshot candidate_sha is invalid.")
    mode = snapshot.get("provider_mode")
    if mode not in {"test", "live"}:
        raise ReconciliationReportError("Snapshot provider_mode must be test or live.")
    evidence_source = snapshot.get("evidence_source")
    probe = snapshot.get("probe")
    collected_at = _timestamp(snapshot.get("collected_at"))
    window = snapshot.get("event_window") or {}
    window_start = _timestamp(window.get("started_at"))
    window_end = _timestamp(window.get("ended_at"))
    if collected_at is None or window_start is None or window_end is None:
        raise ReconciliationReportError("Snapshot collection and event-window timestamps are required.")
    if window_end != collected_at or window_end < window_start or window_end > now + MAX_FUTURE_SKEW:
        raise ReconciliationReportError("Snapshot event window is invalid.")
    oldest_supported = _expected_window_start(window_end)
    if window_start < oldest_supported:
        raise ReconciliationReportError(
            "Snapshot event window exceeds the provider-supported retention safety boundary."
        )

    window_duration = window_end - window_start
    complete_rolling_window = window_duration == ROLLING_EVENT_WINDOW
    expected_livemode = mode == "live"

    provider_accounts = {
        account_id: _as_dict(row)
        for row in snapshot.get("provider_accounts") or []
        if (account_id := _stripe_id(row))
    }
    mappings = {
        str(row.get("stripe_connected_account_id")): _as_dict(row)
        for row in snapshot.get("local_mappings") or []
        if row.get("stripe_connected_account_id")
    }
    excluded = {
        str(row.get("stripe_connected_account_id"))
        for row in snapshot.get("account_dispositions") or []
        if row.get("excluded") is True and row.get("stripe_connected_account_id")
    }

    def event_time(row: dict[str, Any], *, provider: bool) -> Optional[datetime]:
        return _timestamp(row.get("created") if provider else row.get("created_at"))

    raw_provider_window = [
        _as_dict(row)
        for row in snapshot.get("provider_events") or []
        if (value := event_time(_as_dict(row), provider=True)) is not None
        and window_start <= value <= window_end
    ]
    raw_local_window = [
        _as_dict(row)
        for row in snapshot.get("local_events") or []
        if (value := event_time(_as_dict(row), provider=False)) is not None
        and window_start <= value <= window_end
    ]
    wrong_mode_provider_events = [
        row for row in raw_provider_window if row.get("livemode") is not expected_livemode
    ]
    wrong_mode_local_events = [
        row for row in raw_local_window if row.get("livemode") is not expected_livemode
    ]
    expected_provider_window = [
        row for row in raw_provider_window if row.get("livemode") is expected_livemode
    ]
    expected_local_window = [
        row for row in raw_local_window if row.get("livemode") is expected_livemode
    ]

    def in_reviewed_universe(row: dict[str, Any], *, provider: bool) -> bool:
        account_id = _provider_event_account(row) if provider else row.get("stripe_account_id")
        expected_types = CONNECT_EVENTS if account_id else PLATFORM_EVENTS
        return bool(
            not (account_id and account_id in excluded and account_id not in mappings)
            and str(row.get("type") or "") in expected_types
        )

    provider_events = [
        row for row in expected_provider_window if in_reviewed_universe(row, provider=True)
    ]
    local_events = [
        row for row in expected_local_window if in_reviewed_universe(row, provider=False)
    ]
    invalid_provider_event_id_count = sum(1 for row in provider_events if not _stripe_id(row))
    invalid_local_event_id_count = sum(1 for row in local_events if not row.get("stripe_event_id"))
    invalid_local_sequence_count = sum(
        1 for row in expected_local_window if _positive_sequence(row) is None
    )
    provider_event_keys = {
        (event_id, _provider_event_account(row))
        for row in provider_events
        if (event_id := _stripe_id(row))
    }
    local_event_key_list = [
        (row.get("stripe_event_id"), row.get("stripe_account_id")) for row in local_events
    ]
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
            value
            for row in local_events
            if row.get("stripe_account_id") == account_id
            and (row.get("stripe_event_id"), account_id) in matched_keys
            and row.get("processing_status") == "processed"
            and (value := _timestamp(row.get("created_at"))) is not None
        ]

    platform_times = local_matched_times(None)
    latest_platform_delivery = max(platform_times, default=None)
    platform_delivery_fresh = bool(
        latest_platform_delivery
        and now - FRESH_DELIVERY_WINDOW <= latest_platform_delivery <= now + MAX_FUTURE_SKEW
    )
    not_processed = [
        row for row in local_events if row.get("processing_status") != "processed"
    ]
    failed = [
        row
        for row in expected_local_window
        if row.get("processing_status") == "failed"
        and not (
            row.get("stripe_account_id") in excluded
            and row.get("stripe_account_id") not in mappings
        )
    ]
    observed_event_accounts = {
        str(row["stripe_account_id"]) for row in expected_local_window if row.get("stripe_account_id")
    }
    provider_event_accounts = {
        account_id
        for row in expected_provider_window
        if (account_id := _provider_event_account(row))
    }
    provider_ids = set(provider_accounts)
    mapping_ids = set(mappings)
    account_universe = provider_ids | provider_event_accounts | observed_event_accounts | mapping_ids
    mapped_ids = mapping_ids & provider_ids
    excluded_ids = (account_universe - mapping_ids) & excluded
    unresolved_ids = account_universe - mapped_ids - excluded_ids
    unresolved_event_accounts = (
        provider_event_accounts | observed_event_accounts
    ) - mapped_ids - excluded_ids
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
            and now - FRESH_DELIVERY_WINDOW <= latest_delivery <= now + MAX_FUTURE_SKEW
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

    account_delivery_complete = bool(
        account_evidence
        and len(account_evidence) == len(mapped_ids)
        and all(
            evidence["fresh"]
            and evidence["connect_account_generation"] is not None
            and evidence["provider_event_count"] > 0
            and evidence["provider_only_event_count"] == 0
            and evidence["local_only_event_count"] == 0
            for evidence in account_evidence
        )
    )

    endpoint_urls = {
        "production": (PRODUCTION_PLATFORM_WEBHOOK_URL, PRODUCTION_CONNECT_WEBHOOK_URL),
        "staging": (STAGING_PLATFORM_WEBHOOK_URL, STAGING_CONNECT_WEBHOOK_URL),
    }.get(probe, (None, None))
    platform_url, connect_url = endpoint_urls
    endpoints = [_as_dict(row) for row in snapshot.get("webhook_endpoints") or []]
    platform_candidates = [row for row in endpoints if row.get("url") == platform_url]
    connect_candidates = [row for row in endpoints if row.get("url") == connect_url]

    def endpoint_matches(row: dict[str, Any], *, url: Optional[str], events: set[str]) -> bool:
        enabled_events = row.get("enabled_events") or []
        return bool(
            url
            and row.get("url") == url
            and row.get("status") == "enabled"
            and row.get("livemode") is expected_livemode
            and "*" not in enabled_events
            and set(enabled_events) == events
        )

    platform_endpoint_contract_matched = (
        len(platform_candidates) == 1
        and endpoint_matches(platform_candidates[0], url=platform_url, events=PLATFORM_EVENTS)
    )
    connect_endpoint_contract_matched = (
        len(connect_candidates) == 1
        and endpoint_matches(connect_candidates[0], url=connect_url, events=CONNECT_EVENTS)
    )
    unexpected_enabled = [
        row
        for row in endpoints
        if row.get("status") == "enabled"
        and row.get("livemode") is expected_livemode
        and row.get("url") not in {platform_url, connect_url}
    ]
    enabled_platform_count = sum(
        1
        for row in platform_candidates
        if row.get("status") == "enabled" and row.get("livemode") is expected_livemode
    )
    enabled_connect_count = sum(
        1
        for row in connect_candidates
        if row.get("status") == "enabled" and row.get("livemode") is expected_livemode
    )
    connected_event_context_verified = account_delivery_complete
    webhook_topology_complete = bool(
        platform_endpoint_contract_matched
        and connect_endpoint_contract_matched
        and enabled_platform_count == 1
        and enabled_connect_count == 1
        and not unexpected_enabled
        and connected_event_context_verified
    )

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
        and now - READINESS_FRESHNESS <= deployment_verified_at <= now + MAX_FUTURE_SKEW
    )

    local_history_events = [
        _as_dict(row)
        for row in (snapshot.get("local_history_events") or snapshot.get("local_events") or [])
        if row.get("livemode") is expected_livemode
        and (value := _timestamp(row.get("created_at"))) is not None
        and value <= window_end
    ]
    invalid_history_sequence_count = sum(
        1 for row in local_history_events if _positive_sequence(row) is None
    )
    watermark = max(
        (sequence for row in local_history_events if (sequence := _positive_sequence(row)) is not None),
        default=0,
    )
    historical_failed = [
        row
        for row in local_history_events
        if row.get("processing_status") == "failed"
        and not (
            row.get("stripe_account_id") in excluded
            and row.get("stripe_account_id") not in mappings
        )
    ]
    historical_unprocessed = [
        row
        for row in local_history_events
        if in_reviewed_universe(row, provider=False)
        and row.get("processing_status") != "processed"
    ]
    historical_unmapped = [
        row
        for row in local_history_events
        if row.get("stripe_account_id")
        and row.get("stripe_account_id") not in mappings
        and row.get("stripe_account_id") not in excluded
    ]
    bootstrap_history_clean = bool(
        invalid_history_sequence_count == 0
        and not historical_failed
        and not historical_unprocessed
        and not historical_unmapped
    )

    sidecars = [
        _as_dict(row) for row in snapshot.get("v3_checkpoints") or []
    ]
    previous_sidecar = _as_dict(
        snapshot.get("previous_checkpoint") or (sidecars[0] if sidecars else {})
    )
    previous_base = _checkpoint_row(previous_sidecar) if previous_sidecar else {}
    enabled_authorizations = [
        _as_dict(row) for row in snapshot.get("enabled_authorizations") or []
        if row.get("enabled") is True
    ]

    continuity_mode = "rolling" if sidecars or previous_sidecar else "bootstrap"
    previous_checkpoint_valid = False
    overlap_start: Optional[datetime] = None
    overlap_end: Optional[datetime] = None
    overlap_seconds = 0
    watermark_non_regressing = False
    generation_continuity_valid = True
    previous_id = None
    previous_sequence = None
    previous_watermark = None
    previous_window_end = None
    previous_expires_at = None

    if continuity_mode == "rolling":
        previous_id = previous_sidecar.get("checkpoint_id")
        previous_sequence = previous_base.get("checkpoint_sequence")
        previous_watermark = previous_sidecar.get("local_event_ingest_watermark")
        previous_window_start = _timestamp(previous_sidecar.get("event_window_started_at"))
        previous_window_end = _timestamp(previous_sidecar.get("event_window_ended_at"))
        previous_expires_at = _timestamp(previous_base.get("expires_at"))
        try:
            previous_watermark_value = int(previous_watermark)
        except (TypeError, ValueError):
            previous_watermark_value = -1
        if previous_window_start and previous_window_end:
            overlap_start = max(window_start, previous_window_start)
            overlap_end = min(window_end, previous_window_end)
            if overlap_end > overlap_start:
                overlap_seconds = int((overlap_end - overlap_start).total_seconds())
        previous_checkpoint_valid = bool(
            previous_id
            and isinstance(previous_sequence, int)
            and previous_expires_at is not None
            and previous_expires_at > now
            and previous_window_end is not None
            and window_end >= previous_window_end
            and overlap_seconds >= int(MINIMUM_CONTINUITY_OVERLAP.total_seconds())
        )
        watermark_non_regressing = bool(
            previous_watermark_value >= 0 and watermark >= previous_watermark_value
        )
        continuity_delta_events = [
            row
            for row in local_history_events
            if (sequence := _positive_sequence(row)) is not None
            and sequence > previous_watermark_value
            and sequence <= watermark
        ]
        continuity_delta_failed = [
            row
            for row in continuity_delta_events
            if row.get("processing_status") == "failed"
            and not (
                row.get("stripe_account_id") in excluded
                and row.get("stripe_account_id") not in mappings
            )
        ]
        continuity_delta_unprocessed = [
            row
            for row in continuity_delta_events
            if in_reviewed_universe(row, provider=False)
            and row.get("processing_status") != "processed"
        ]
        continuity_delta_unmapped = [
            row
            for row in continuity_delta_events
            if row.get("stripe_account_id")
            and row.get("stripe_account_id") not in mappings
            and row.get("stripe_account_id") not in excluded
        ]
        previous_generations = {
            str(row.get("stripe_connected_account_id")): row.get("connect_account_generation")
            for row in snapshot.get("previous_account_evidence") or []
            if row.get("stripe_connected_account_id")
        }
        for account_id, mapping in mappings.items():
            if account_id in previous_generations:
                generation_continuity_valid = generation_continuity_valid and (
                    previous_generations[account_id] == _positive_generation(mapping)
                )
        continuity_eligible = bool(
            previous_checkpoint_valid
            and watermark_non_regressing
            and generation_continuity_valid
            and not continuity_delta_failed
            and not continuity_delta_unprocessed
            and not continuity_delta_unmapped
        )
    else:
        continuity_delta_failed = []
        continuity_delta_unprocessed = []
        continuity_delta_unmapped = []
        continuity_eligible = bool(
            not enabled_authorizations
            and bootstrap_history_clean
        )

    latest_local = max(
        (value for row in expected_local_window if (value := _timestamp(row.get("created_at"))) is not None),
        default=None,
    )
    latest_provider = max(
        (value for row in expected_provider_window if (value := _timestamp(row.get("created"))) is not None),
        default=None,
    )
    checkpoint_eligible = bool(
        production_readiness_verified
        and mode == "live"
        and complete_rolling_window
        and continuity_eligible
        and not unresolved_ids
        and not unresolved_event_accounts
        and not failed
        and not not_processed
        and not provider_only_keys
        and not local_only_keys
        and not wrong_mode_provider_events
        and not wrong_mode_local_events
        and platform_delivery_fresh
        and account_delivery_complete
        and webhook_topology_complete
        and not duplicate_keys
        and invalid_provider_event_id_count == 0
        and invalid_local_event_id_count == 0
        and invalid_local_sequence_count == 0
        and invalid_generation_count == 0
    )

    sanitized_failures = [{
        "event_id": row.get("stripe_event_id"),
        "stripe_account_id": row.get("stripe_account_id"),
        "type": row.get("type"),
        "error_code": _sanitized_error_code(row.get("error")),
        "error_reference": row.get("error_reference"),
        "created_at": _iso(row.get("created_at")),
    } for row in failed]

    return {
        "schema_version": 3,
        "candidate_sha": candidate_sha,
        "provider_mode": mode,
        "evidence_source": evidence_source,
        "probe": probe,
        "generated_at": now.isoformat(),
        "event_window": {
            "started_at": window_start.isoformat(),
            "ended_at": window_end.isoformat(),
        },
        "window_policy": {
            "provider_retention_seconds": int(PROVIDER_EVENT_RETENTION.total_seconds()),
            "safety_margin_seconds": int(PROVIDER_WINDOW_SAFETY_MARGIN.total_seconds()),
            "rolling_window_seconds": int(ROLLING_EVENT_WINDOW.total_seconds()),
            "minimum_continuity_overlap_seconds": int(MINIMUM_CONTINUITY_OVERLAP.total_seconds()),
            "complete_supported_window": complete_rolling_window,
        },
        "checkpoint_eligible": checkpoint_eligible,
        "deployment_readiness": {
            "production_exact_candidate_verified": production_readiness_verified,
            "verified_at": _iso(deployment_verified_at) if production_readiness_verified else None,
        },
        "continuity": {
            "mode": continuity_mode,
            "eligible": continuity_eligible,
            "previous_checkpoint_id": previous_id,
            "previous_checkpoint_sequence": previous_sequence,
            "previous_checkpoint_expires_at": _iso(previous_expires_at),
            "previous_window_ended_at": _iso(previous_window_end),
            "previous_local_event_ingest_watermark": previous_watermark,
            "previous_checkpoint_valid": previous_checkpoint_valid,
            "overlap_started_at": _iso(overlap_start),
            "overlap_ended_at": _iso(overlap_end),
            "overlap_seconds": overlap_seconds,
            "minimum_overlap_seconds": int(MINIMUM_CONTINUITY_OVERLAP.total_seconds()),
            "local_event_ingest_watermark_non_regressing": watermark_non_regressing,
            "account_generation_continuity_valid": generation_continuity_valid,
            "bootstrap_local_history_checked": continuity_mode == "bootstrap" and bootstrap_history_clean,
            "bootstrap_historical_provider_completeness_claimed": False,
            "bootstrap_enabled_authorization_count": len(enabled_authorizations),
            "bootstrap_historical_failed_count": len(historical_failed),
            "bootstrap_historical_not_processed_count": len(historical_unprocessed),
            "bootstrap_historical_unmapped_count": len(historical_unmapped),
            "delta_failed_count": len(continuity_delta_failed),
            "delta_not_processed_count": len(continuity_delta_unprocessed),
            "delta_unmapped_count": len(continuity_delta_unmapped),
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
        "event_reconciliation": {
            "bounded_provider_total": len(provider_event_keys),
            "bounded_local_total": len(local_event_keys),
            "matched_provider_delivery_count": len(matched_keys),
            "provider_only_event_count": len(provider_only_keys),
            "local_only_event_count": len(local_only_keys),
            "failed": len(failed),
            "not_processed": len(not_processed),
            "wrong_mode_provider_event_count": len(wrong_mode_provider_events),
            "wrong_mode_local_event_count": len(wrong_mode_local_events),
            "latest_created_at": _iso(latest_local),
            "latest_provider_created_at": _iso(latest_provider),
            "local_event_ingest_watermark": watermark,
            "invalid_history_sequence_count": invalid_history_sequence_count,
            "failures": sanitized_failures,
        },
        "platform_delivery": {
            "provider_event_count": len({key for key in provider_event_keys if key[1] is None}),
            "local_event_count": len({key for key in local_event_keys if key[1] is None}),
            "delivery_verified_at": _iso(latest_platform_delivery) if platform_delivery_fresh else None,
            "fresh": platform_delivery_fresh,
        },
        "webhook_delivery": {
            "platform_endpoint_url": platform_url,
            "connect_endpoint_url": connect_url,
            "enabled_platform_endpoint_count": enabled_platform_count,
            "enabled_connect_endpoint_count": enabled_connect_count,
            "platform_endpoint_candidate_count": len(platform_candidates),
            "connect_endpoint_candidate_count": len(connect_candidates),
            "unexpected_enabled_endpoint_count": len(unexpected_enabled),
            "platform_endpoint_contract_matched": platform_endpoint_contract_matched,
            "connect_endpoint_contract_matched": connect_endpoint_contract_matched,
            "platform_endpoint_livemode": (
                platform_candidates[0].get("livemode") if len(platform_candidates) == 1 else None
            ),
            "connect_endpoint_livemode": (
                connect_candidates[0].get("livemode") if len(connect_candidates) == 1 else None
            ),
            "connected_event_context_verified": connected_event_context_verified,
            "wildcard_accepted": False,
        },
        "event_idempotency_gate": {
            "unique_local_event_account_keys": not duplicate_keys,
            "duplicate_keys": duplicate_keys,
            "invalid_provider_event_id_count": invalid_provider_event_id_count,
            "invalid_local_event_id_count": invalid_local_event_id_count,
            "invalid_local_sequence_count": invalid_local_sequence_count,
            "replay_or_backfill_allowed": False,
            "reason": (
                "Read-only evidence never authorizes replay; prove the exact event-id handler path "
                "before separate approval."
            ),
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a sanitized, read-only Stripe reconciliation report.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--snapshot", type=Path, help="Offline sanitized snapshot; permanently checkpoint-ineligible.")
    source.add_argument("--collect-read-only", action="store_true", help="Read Stripe, Supabase, and pinned readiness only.")
    parser.add_argument("--probe", choices=("production", "staging"), help="Required for live collection; staging is diagnostic only.")
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument(
        "--window-start",
        help=(
            "Optional ISO-8601 start for a diagnostic collection. Starts older than the centralized "
            "provider-retention safety boundary fail explicitly; a checkpoint requires the complete default window."
        ),
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        requested_start = None
        if args.window_start:
            requested_start = _timestamp(args.window_start)
            if requested_start is None:
                raise ReconciliationReportError("--window-start must be an ISO-8601 timestamp.")
        if args.snapshot:
            if args.probe or args.window_start:
                raise ReconciliationReportError(
                    "Offline snapshots cannot claim a deployment probe or override their recorded event window."
                )
            snapshot = json.loads(args.snapshot.read_text())
            snapshot["candidate_sha"] = args.candidate_sha
            snapshot["evidence_source"] = "offline_snapshot"
            snapshot["probe"] = None
            snapshot["deployment_readiness"] = None
        else:
            if not args.probe:
                raise ReconciliationReportError("--collect-read-only requires --probe production or staging.")
            snapshot = collect_read_only_snapshot(
                args.candidate_sha,
                probe=args.probe,
                window_start=requested_start,
            )
        print(json.dumps(build_report(snapshot), indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, ReconciliationReportError, ModuleNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
