from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from typing import Any, Optional, TextIO

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import get_settings
from app.db.supabase import create_supabase_client
from scripts.stripe_reconciliation_report import (
    PRODUCTION_READY_URL,
    ReconciliationReportError,
    _verify_deployed_readiness,
)
from scripts.comp_studio import (
    CompStudioError,
    _add_selector,
    _confirm_execute,
    _paginate,
    _print_json,
    _reason,
    _resolve_actor,
    _resolve_studio,
)


SCOPES = ("core_subscription", "connect_onboarding", "connect_payments")
AUTH_COLUMNS = (
    "studio_id,scope,enabled,stripe_connected_account_id,connect_account_generation,"
    "expires_at,revision,granted_at,granted_by,granted_by_email,grant_reason,"
    "revoked_at,revoked_by,revoked_by_email,revoke_reason,updated_at,"
    "reconciliation_checkpoint_id,local_event_ingest_watermark"
)
ACCOUNT_COLUMNS = (
    "studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,"
    "details_submitted,requirements_due,metadata,updated_at"
)
V3_CHECKPOINT_COLUMNS = (
    "checkpoint_id,checkpoint_sequence,candidate_sha,verified_at,expires_at,"
    "source_report_sha256,continuity_mode,previous_checkpoint_id,"
    "previous_checkpoint_sequence,event_window_started_at,event_window_ended_at,"
    "continuity_overlap_started_at,continuity_overlap_ended_at,"
    "previous_local_event_ingest_watermark,local_event_ingest_watermark,"
    "bootstrap_historical_provider_completeness_claimed,"
    "bootstrap_local_history_checked,provider_retention_seconds,"
    "safety_margin_seconds,minimum_overlap_seconds,platform_endpoint_url,"
    "connect_endpoint_url,platform_endpoint_livemode,connect_endpoint_livemode,"
    "connected_event_context_verified,created_at"
)
LEGACY_CHECKPOINT_COLUMNS = (
    "id,stripe_livemode,candidate_sha,provider_account_count,mapped_account_count,"
    "excluded_account_count,unresolved_account_count,event_count_since_cutoff,"
    "failed_event_count,latest_event_created_at,webhook_delivery_verified_at,"
    "enabled_platform_endpoint_count,enabled_connect_endpoint_count,"
    "platform_endpoint_contract_matched,connect_endpoint_contract_matched,"
    "verified_at,checkpoint_sequence,expires_at,source_report_sha256,reason,"
    "verified_by,verified_by_email,evidence_source,deployment_ready_url,"
    "deployment_ready_sha,deployment_ready_verified_at,local_event_ingest_watermark,"
    "provider_only_event_count,local_only_event_count,platform_delivery_verified_at,"
    "unexpected_enabled_endpoint_count,account_evidence_count"
)


class LiveBillingOperatorError(CompStudioError):
    pass


def _add_actor_write_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--reason", required=True, type=_reason)
    parser.add_argument("--actor", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--expect-project")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspect and manage durable studio live-billing authorization.")
    commands = parser.add_subparsers(dest="command", required=True)

    status_parser = commands.add_parser("status")
    _add_selector(status_parser)
    commands.add_parser("drift")

    grant = commands.add_parser("grant")
    _add_selector(grant)
    _add_actor_write_arguments(grant)
    grant.add_argument("--scope", choices=SCOPES, required=True)
    grant.add_argument("--expires-at", required=True, help="Future ISO-8601 timestamp, at most 30 days away.")
    grant.add_argument("--stripe-account-id")

    revoke = commands.add_parser("revoke")
    _add_selector(revoke)
    _add_actor_write_arguments(revoke)
    revoke.add_argument("--scope", choices=SCOPES, required=True)

    disposition = commands.add_parser("account-disposition")
    _add_actor_write_arguments(disposition)
    disposition.add_argument("--stripe-account-id", required=True)
    disposition.add_argument("--state", choices=("excluded", "unresolved"), required=True)

    checkpoint = commands.add_parser("record-checkpoint")
    _add_actor_write_arguments(checkpoint)
    checkpoint.add_argument("--report", required=True, type=Path)
    checkpoint.add_argument("--expires-at", required=True)
    return parser


def _parse_timestamp(value: str, label: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise LiveBillingOperatorError(f"{label} must be an ISO-8601 timestamp.") from exc
    if parsed.tzinfo is None:
        raise LiveBillingOperatorError(f"{label} must include a timezone offset.")
    return parsed.astimezone(timezone.utc).isoformat()


def _latest_v3_checkpoint(supabase: Any) -> Optional[dict[str, Any]]:
    rows = _paginate(lambda: (
        supabase.table("stripe_live_billing_reconciliation_checkpoints_v3")
        .select(V3_CHECKPOINT_COLUMNS)
        .order("checkpoint_sequence", desc=True)
        .limit(1)
    ))
    return rows[0] if rows else None


# Backward-compatible internal alias for tests and any owner automation that imported
# the old helper. The active checkpoint contract is v3.
_latest_checkpoint = _latest_v3_checkpoint


def _latest_legacy_checkpoint(supabase: Any) -> Optional[dict[str, Any]]:
    rows = _paginate(lambda: (
        supabase.table("stripe_live_billing_reconciliation_checkpoints")
        .select(LEGACY_CHECKPOINT_COLUMNS)
        .order("verified_at", desc=True)
        .order("checkpoint_sequence", desc=True)
        .limit(1)
    ))
    return rows[0] if rows else None


def _studio_state(supabase: Any, studio: dict[str, Any]) -> dict[str, Any]:
    authorizations = _paginate(lambda: (
        supabase.table("studio_live_billing_authorizations")
        .select(AUTH_COLUMNS)
        .eq("studio_id", studio["id"])
        .order("scope")
    ))
    accounts = _paginate(lambda: (
        supabase.table("studio_payment_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("studio_id", studio["id"])
        .order("studio_id")
    ))
    return {
        "studio": studio,
        "authorizations": authorizations,
        "payment_account": accounts[0] if accounts else None,
        "latest_reconciliation_checkpoint": _latest_v3_checkpoint(supabase),
        "latest_reconciliation_checkpoint_v3": _latest_v3_checkpoint(supabase),
        "latest_legacy_reconciliation_checkpoint": _latest_legacy_checkpoint(supabase),
    }


def _generation(account: Optional[dict[str, Any]]) -> Optional[int]:
    if not account:
        return None
    value = (account.get("metadata") or {}).get("connect_account_generation", 1)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _drift(supabase: Any) -> list[dict[str, Any]]:
    authorizations = _paginate(lambda: (
        supabase.table("studio_live_billing_authorizations")
        .select(AUTH_COLUMNS)
        .eq("enabled", True)
        .order("studio_id")
        .order("scope")
    ))
    accounts = {
        row["studio_id"]: row for row in _paginate(lambda: (
            supabase.table("studio_payment_accounts").select(ACCOUNT_COLUMNS).order("studio_id")
        ))
    }
    now = datetime.now(timezone.utc)
    drift: list[dict[str, Any]] = []
    for authorization in authorizations:
        account = accounts.get(authorization["studio_id"])
        reasons: list[str] = []
        try:
            expires_at = datetime.fromisoformat(
                str(authorization.get("expires_at") or "").replace("Z", "+00:00")
            )
        except ValueError:
            expires_at = None
        if expires_at is None or expires_at <= now:
            reasons.append("authorization is expired or has an invalid expiry")
        if authorization["scope"].startswith("connect_"):
            if account is None:
                reasons.append("studio payment-account row is missing")
            elif authorization.get("connect_account_generation") != _generation(account):
                reasons.append("Connect generation is stale")
            bound = authorization.get("stripe_connected_account_id")
            mapped = (account or {}).get("stripe_connected_account_id")
            if bound and bound != mapped:
                reasons.append("bound Stripe account is not the current mapping")
        if authorization["scope"] == "connect_payments" and account and not (
            account.get("charges_enabled")
            and account.get("payouts_enabled")
            and account.get("details_submitted")
            and not (account.get("requirements_due") or [])
            and account.get("status") == "charges_enabled"
        ):
            reasons.append("Connect account is not currently payment-ready")
        if reasons:
            drift.append({
                "authorization": authorization,
                "payment_account": account,
                "drift_reasons": reasons,
            })
    return drift


def _run_write_confirmation(
    args: argparse.Namespace,
    settings: Any,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    if args.execute:
        _confirm_execute(args, settings, stdin, stdout)


def _authorization_change(
    supabase: Any,
    settings: Any,
    args: argparse.Namespace,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    studio = _resolve_studio(supabase, slug=args.slug, studio_id=args.studio_id)
    actor_id, actor_email = _resolve_actor(supabase, args.actor)
    enabled = args.command == "grant"
    expires_at = _parse_timestamp(args.expires_at, "--expires-at") if enabled else None
    account_id = args.stripe_account_id if enabled else None
    plan = {
        "operation": args.command,
        "studio": studio,
        "scope": args.scope,
        "enabled": enabled,
        "expires_at": expires_at,
        "stripe_connected_account_id": account_id,
        "actor": {"id": actor_id, "email": actor_email},
        "reason": args.reason,
        "write_boundary": "set_studio_live_billing_authorization_atomic",
        "required_checkpoint_contract": 3,
    }
    if not args.execute:
        _print_json({"dry_run": True, **plan}, stdout)
        return
    _run_write_confirmation(args, settings, stdin, stdout)
    result = supabase.rpc("set_studio_live_billing_authorization_atomic", {
        "p_studio_id": studio["id"],
        "p_scope": args.scope,
        "p_enabled": enabled,
        "p_expires_at": expires_at,
        "p_reason": args.reason,
        "p_actor_id": actor_id,
        "p_actor_email": actor_email,
        "p_stripe_connected_account_id": account_id,
    }).execute()
    _print_json({"dry_run": False, "result": result.data}, stdout)


def _account_disposition(
    supabase: Any,
    settings: Any,
    args: argparse.Namespace,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    actor_id, actor_email = _resolve_actor(supabase, args.actor)
    excluded = args.state == "excluded"
    plan = {
        "operation": "account-disposition",
        "stripe_connected_account_id": args.stripe_account_id,
        "excluded": excluded,
        "actor": {"id": actor_id, "email": actor_email},
        "reason": args.reason,
    }
    if not args.execute:
        _print_json({"dry_run": True, **plan}, stdout)
        return
    _run_write_confirmation(args, settings, stdin, stdout)
    result = supabase.rpc("set_stripe_connect_account_exclusion_atomic", {
        "p_stripe_connected_account_id": args.stripe_account_id,
        "p_excluded": excluded,
        "p_reason": args.reason,
        "p_actor_id": actor_id,
        "p_actor_email": actor_email,
    }).execute()
    _print_json({"dry_run": False, "result": result.data}, stdout)


def _load_report(path: Path) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_bytes()
        report = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise LiveBillingOperatorError(f"Could not read reconciliation report {path}.") from exc
    continuity = report.get("continuity") or {}
    window_policy = report.get("window_policy") or {}
    if (
        not isinstance(report, dict)
        or report.get("checkpoint_eligible") is not True
        or report.get("schema_version") != 3
        or report.get("evidence_source") != "provider_read"
        or report.get("probe") != "production"
        or report.get("provider_mode") != "live"
        or (report.get("deployment_readiness") or {}).get(
            "production_exact_candidate_verified"
        ) is not True
        or continuity.get("eligible") is not True
        or continuity.get("bootstrap_historical_provider_completeness_claimed") is not False
        or window_policy.get("complete_supported_window") is not True
    ):
        raise LiveBillingOperatorError("Report is not an all-clear schema-v3 checkpoint candidate.")
    return report, hashlib.sha256(raw).hexdigest()


def _record_checkpoint(
    supabase: Any,
    settings: Any,
    args: argparse.Namespace,
    stdin: TextIO,
    stdout: TextIO,
) -> None:
    report, digest = _load_report(args.report)
    actor_id, actor_email = _resolve_actor(supabase, args.actor)
    candidate_sha = str(report.get("candidate_sha") or "")
    try:
        readiness = _verify_deployed_readiness(
            "production",
            candidate_sha,
            now=datetime.now(timezone.utc),
        )
    except ReconciliationReportError as exc:
        raise LiveBillingOperatorError(
            "Independent production readiness verification failed."
        ) from exc
    if (
        readiness.get("url") != PRODUCTION_READY_URL
        or readiness.get("candidate_sha") != candidate_sha
    ):
        raise LiveBillingOperatorError("Production readiness did not match the report candidate.")
    params = {
        "p_report": report,
        "p_expires_at": _parse_timestamp(args.expires_at, "--expires-at"),
        "p_source_report_sha256": digest,
        "p_reason": args.reason,
        "p_actor_id": actor_id,
        "p_actor_email": actor_email,
    }
    if not args.execute:
        _print_json({
            "dry_run": True,
            "rpc": "record_stripe_live_billing_reconciliation_checkpoint_v3",
            "schema_version": 3,
            "continuity_mode": (report.get("continuity") or {}).get("mode"),
            "candidate_sha": candidate_sha,
            "production_ready_url_verified": True,
            "report_sha256": digest,
            "expires_at": params["p_expires_at"],
        }, stdout)
        return
    _run_write_confirmation(args, settings, stdin, stdout)
    result = supabase.rpc(
        "record_stripe_live_billing_reconciliation_checkpoint_v3",
        params,
    ).execute()
    _print_json({"dry_run": False, "result": result.data}, stdout)


def main(
    argv: Optional[list[str]] = None,
    *,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = get_settings()
        supabase = create_supabase_client()
        if args.command == "status":
            studio = _resolve_studio(supabase, slug=args.slug, studio_id=args.studio_id)
            _print_json(_studio_state(supabase, studio), stdout)
        elif args.command == "drift":
            _print_json({
                "drift": _drift(supabase),
                "latest_reconciliation_checkpoint": _latest_v3_checkpoint(supabase),
                "latest_reconciliation_checkpoint_v3": _latest_v3_checkpoint(supabase),
                "latest_legacy_reconciliation_checkpoint": _latest_legacy_checkpoint(supabase),
            }, stdout)
        elif args.command in {"grant", "revoke"}:
            _authorization_change(supabase, settings, args, stdin, stdout)
        elif args.command == "account-disposition":
            _account_disposition(supabase, settings, args, stdin, stdout)
        else:
            _record_checkpoint(supabase, settings, args, stdin, stdout)
        return 0
    except (CompStudioError, ValueError) as exc:
        print(str(exc), file=stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
