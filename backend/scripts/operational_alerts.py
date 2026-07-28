from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import get_settings
from app.db.supabase import create_supabase_client
from app.services.operational_alerts import (
    APPLICATION_ALERT_RULES,
    CATALOG_VERSION,
    AlertEngine,
    ListAlertAuditTrail,
    OperationalSignalCollector,
    RecordingAlertDestination,
    firing_rule_ids,
)


PROJECT_REF_PATTERN = re.compile(r"^[a-z0-9]{20}$")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Rehearse or inspect Koaryu's privacy-safe operational alert catalog."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "synthetic",
        help="Exercise delivery, dedupe, escalation, acknowledgment, and resolution locally.",
    )
    snapshot = commands.add_parser(
        "snapshot",
        help="Read aggregate operational counts without sending or persisting an alert.",
    )
    snapshot.add_argument(
        "--environment",
        required=True,
        choices=("staging", "production"),
        help="Expected configured backend environment.",
    )
    snapshot.add_argument(
        "--expect-project",
        required=True,
        type=_project_ref,
        help="Exact 20-character Supabase project ref expected in SUPABASE_URL.",
    )
    return parser


def _project_ref(value: str) -> str:
    normalized = value.strip().lower()
    if not PROJECT_REF_PATTERN.fullmatch(normalized):
        raise argparse.ArgumentTypeError(
            "expect-project must be an exact 20-character Supabase project ref"
        )
    return normalized


def _run_synthetic() -> int:
    destination = RecordingAlertDestination()
    audit_trail = ListAlertAuditTrail()
    engine = AlertEngine(destination=destination, audit_trail=audit_trail)
    started_at = datetime(2026, 7, 28, 0, 0, tzinfo=timezone.utc)
    firing_metrics = {rule.metric: rule.threshold for rule in APPLICATION_ALERT_RULES}
    clear_metrics = {rule.metric: 0 for rule in APPLICATION_ALERT_RULES}

    initial = engine.evaluate(
        firing_metrics,
        observed_at=started_at,
        environment="synthetic",
        commit_sha=None,
        synthetic=True,
    )
    duplicate = engine.evaluate(
        firing_metrics,
        observed_at=started_at + timedelta(minutes=1),
        environment="synthetic",
        commit_sha=None,
        synthetic=True,
    )
    escalated = engine.evaluate(
        firing_metrics,
        observed_at=started_at + timedelta(minutes=121),
        environment="synthetic",
        commit_sha=None,
        synthetic=True,
    )
    for rule in APPLICATION_ALERT_RULES:
        engine.acknowledge(
            rule.rule_id,
            actor_ref="synthetic-backup-owner",
            acknowledged_at=started_at + timedelta(minutes=122),
            synthetic=True,
        )
    after_acknowledgment = engine.evaluate(
        firing_metrics,
        observed_at=started_at + timedelta(minutes=600),
        environment="synthetic",
        commit_sha=None,
        synthetic=True,
    )
    resolved = engine.evaluate(
        clear_metrics,
        observed_at=started_at + timedelta(minutes=601),
        environment="synthetic",
        commit_sha=None,
        synthetic=True,
    )

    expected_rules = len(APPLICATION_ALERT_RULES)
    expected_deliveries = expected_rules * 4
    if (
        len(initial) != expected_rules
        or duplicate
        or len(escalated) != expected_rules
        or after_acknowledgment
        or len(resolved) != expected_rules * 2
        or len(destination.deliveries) != expected_deliveries
    ):
        raise RuntimeError("synthetic delivery lifecycle did not meet its invariants")

    serialized = json.dumps(
        {"deliveries": destination.deliveries, "audit": audit_trail.events},
        sort_keys=True,
    ).lower()
    forbidden_markers = (
        "requester_email",
        "customer_id",
        "invoice_id",
        "payload",
        "details",
        "query_string",
        "user_agent",
    )
    if any(marker in serialized for marker in forbidden_markers):
        raise RuntimeError("synthetic delivery included a forbidden sensitive field")

    print(json.dumps({
        "catalog_version": CATALOG_VERSION,
        "mode": "synthetic-record-only",
        "network_delivery": False,
        "rules_rehearsed": expected_rules,
        "deliveries_recorded": len(destination.deliveries),
        "audit_events_recorded": len(audit_trail.events),
        "dedupe_verified": True,
        "escalation_verified": True,
        "acknowledgment_verified": True,
        "resolution_verified": True,
        "redaction_policy_verified": True,
    }, sort_keys=True))
    return 0


def _run_snapshot(*, environment: str, expect_project: str) -> int:
    settings = get_settings()
    configured_environment = settings.ENVIRONMENT.strip().lower()
    if configured_environment != environment:
        raise RuntimeError("configured environment does not match --environment")

    parsed_url = urlparse(settings.SUPABASE_URL)
    expected_hostname = f"{expect_project}.supabase.co"
    if (
        parsed_url.scheme != "https"
        or parsed_url.hostname != expected_hostname
        or parsed_url.path not in {"", "/"}
        or parsed_url.params
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise RuntimeError("configured Supabase URL does not match --expect-project")

    settings.validate_runtime_configuration()
    observed_at = datetime.now(timezone.utc)
    metrics = OperationalSignalCollector(create_supabase_client()).collect(
        observed_at=observed_at
    )
    firing = firing_rule_ids(metrics)
    print(json.dumps({
        "catalog_version": CATALOG_VERSION,
        "mode": "read-only-snapshot",
        "environment": environment,
        "supabase_project_ref": expect_project,
        "observed_at": observed_at.isoformat(),
        "metrics": metrics,
        "firing_rule_ids": firing,
        "delivery_attempted": False,
        "audit_write_attempted": False,
        "activation_state": "blocked-pending-destination-approval",
    }, sort_keys=True))
    return 2 if firing else 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "synthetic":
            return _run_synthetic()
        return _run_snapshot(
            environment=args.environment,
            expect_project=args.expect_project,
        )
    except Exception as exc:
        print(
            json.dumps({
                "error": exc.__class__.__name__,
                "message": "operational alert command failed without exposing provider details",
            }, sort_keys=True),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
