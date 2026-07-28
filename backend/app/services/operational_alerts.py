from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Mapping, Protocol

from supabase import Client


CATALOG_VERSION = "2026-07-28"
ALERT_ENVELOPE_SCHEMA_VERSION = 1
COUNTS_ONLY_REDACTION_POLICY = "counts-only-v1"
SAFE_ENVIRONMENT_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SAFE_ACTOR_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.:/-]{0,79}$")
COMMIT_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


class OperationalAlertError(RuntimeError):
    pass


@dataclass(frozen=True)
class AlertRule:
    rule_id: str
    metric: str
    source: str
    condition: str
    threshold: int
    window_minutes: int
    severity: str
    dedupe_minutes: int
    acknowledge_within_minutes: int
    escalate_after_minutes: int
    primary_destination_id: str
    backup_destination_id: str
    primary_owner: str
    backup_owner: str
    runbook: str
    redaction_policy: str
    activation_state: str


APPLICATION_ALERT_RULES = (
    AlertRule(
        rule_id="stripe-live-webhook-failure",
        metric="stripe.live_webhook_failures_over_10m",
        source="supabase-aggregate",
        condition="count_at_least",
        threshold=1,
        window_minutes=10,
        severity="critical",
        dedupe_minutes=60,
        acknowledge_within_minutes=15,
        escalate_after_minutes=15,
        primary_destination_id="owner-email-primary",
        backup_destination_id="approval-required-backup",
        primary_owner="Ronak Chakraborty",
        backup_owner="approval required",
        runbook="/docs/operational-alerts.md#stripe-live-webhook-failure",
        redaction_policy=COUNTS_ONLY_REDACTION_POLICY,
        activation_state="blocked-pending-destination-approval",
    ),
    AlertRule(
        rule_id="account-deletion-worker-overdue",
        metric="worker.account_deletions_overdue_24h",
        source="supabase-aggregate",
        condition="count_at_least",
        threshold=1,
        window_minutes=24 * 60,
        severity="high",
        dedupe_minutes=12 * 60,
        acknowledge_within_minutes=60,
        escalate_after_minutes=120,
        primary_destination_id="owner-email-primary",
        backup_destination_id="approval-required-backup",
        primary_owner="Ronak Chakraborty",
        backup_owner="approval required",
        runbook="/docs/operational-alerts.md#account-deletion-worker-overdue",
        redaction_policy=COUNTS_ONLY_REDACTION_POLICY,
        activation_state="blocked-pending-destination-approval",
    ),
    AlertRule(
        rule_id="support-urgent-untriaged",
        metric="support.urgent_untriaged_over_30m",
        source="supabase-aggregate",
        condition="count_at_least",
        threshold=1,
        window_minutes=30,
        severity="high",
        dedupe_minutes=120,
        acknowledge_within_minutes=30,
        escalate_after_minutes=60,
        primary_destination_id="owner-email-primary",
        backup_destination_id="approval-required-backup",
        primary_owner="Ronak Chakraborty",
        backup_owner="approval required",
        runbook="/docs/operational-alerts.md#support-urgent-untriaged",
        redaction_policy=COUNTS_ONLY_REDACTION_POLICY,
        activation_state="blocked-pending-destination-approval",
    ),
    AlertRule(
        rule_id="billing-reconciliation-stale",
        metric="billing.reconciliation_required_over_1h",
        source="supabase-aggregate",
        condition="count_at_least",
        threshold=1,
        window_minutes=60,
        severity="high",
        dedupe_minutes=240,
        acknowledge_within_minutes=60,
        escalate_after_minutes=120,
        primary_destination_id="owner-email-primary",
        backup_destination_id="approval-required-backup",
        primary_owner="Ronak Chakraborty",
        backup_owner="approval required",
        runbook="/docs/operational-alerts.md#billing-reconciliation-stale",
        redaction_policy=COUNTS_ONLY_REDACTION_POLICY,
        activation_state="blocked-pending-destination-approval",
    ),
)


ALERT_ENVELOPE_FIELDS = frozenset({
    "schema_version",
    "catalog_version",
    "kind",
    "rule_id",
    "fingerprint",
    "severity",
    "environment",
    "commit_sha",
    "observed_at",
    "observed_count",
    "threshold",
    "window_minutes",
    "destination_id",
    "owner_role",
    "runbook",
    "redaction_policy",
    "synthetic",
})


def validate_catalog(rules: tuple[AlertRule, ...] = APPLICATION_ALERT_RULES) -> None:
    seen_rule_ids: set[str] = set()
    seen_metrics: set[str] = set()
    for rule in rules:
        if rule.rule_id in seen_rule_ids:
            raise OperationalAlertError(f"duplicate alert rule: {rule.rule_id}")
        if rule.metric in seen_metrics:
            raise OperationalAlertError(f"duplicate alert metric: {rule.metric}")
        seen_rule_ids.add(rule.rule_id)
        seen_metrics.add(rule.metric)

        if rule.condition != "count_at_least":
            raise OperationalAlertError(f"unsupported condition for {rule.rule_id}")
        if rule.threshold < 1:
            raise OperationalAlertError(f"threshold must be positive for {rule.rule_id}")
        if min(
            rule.window_minutes,
            rule.dedupe_minutes,
            rule.acknowledge_within_minutes,
            rule.escalate_after_minutes,
        ) < 1:
            raise OperationalAlertError(f"alert timing must be positive for {rule.rule_id}")
        if rule.severity not in {"high", "critical"}:
            raise OperationalAlertError(f"unsupported severity for {rule.rule_id}")
        if rule.redaction_policy != COUNTS_ONLY_REDACTION_POLICY:
            raise OperationalAlertError(f"unsupported redaction policy for {rule.rule_id}")
        for field_name in (
            "source",
            "primary_destination_id",
            "backup_destination_id",
            "primary_owner",
            "backup_owner",
            "runbook",
            "activation_state",
        ):
            if not getattr(rule, field_name).strip():
                raise OperationalAlertError(f"{field_name} is required for {rule.rule_id}")


@dataclass
class AlertInstance:
    rule_id: str
    fingerprint: str
    opened_at: datetime
    last_primary_delivery_at: datetime
    backup_delivered_at: datetime | None = None
    acknowledged_at: datetime | None = None
    resolved_at: datetime | None = None


class AlertStateStore(Protocol):
    def get(self, rule_id: str) -> AlertInstance | None: ...

    def put(self, instance: AlertInstance) -> None: ...


class InMemoryAlertStateStore:
    def __init__(self) -> None:
        self._instances: dict[str, AlertInstance] = {}

    def get(self, rule_id: str) -> AlertInstance | None:
        return self._instances.get(rule_id)

    def put(self, instance: AlertInstance) -> None:
        self._instances[instance.rule_id] = instance


class AlertDestination(Protocol):
    def deliver(self, envelope: Mapping[str, Any]) -> str: ...


class AlertAuditTrail(Protocol):
    def record(self, event: Mapping[str, Any]) -> None: ...


class RecordingAlertDestination:
    """Synthetic destination that never performs network or provider writes."""

    def __init__(self) -> None:
        self.deliveries: list[dict[str, Any]] = []

    def deliver(self, envelope: Mapping[str, Any]) -> str:
        if set(envelope) != ALERT_ENVELOPE_FIELDS:
            raise OperationalAlertError("alert envelope does not match the safe schema")
        if envelope["synthetic"] is not True:
            raise OperationalAlertError(
                "the recording destination accepts synthetic deliveries only"
            )
        receipt = f"recorded-{len(self.deliveries) + 1}"
        self.deliveries.append(dict(envelope))
        return receipt


class ListAlertAuditTrail:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def record(self, event: Mapping[str, Any]) -> None:
        self.events.append(dict(event))


class JsonlAlertAuditTrail:
    """Append-only local audit adapter for rehearsals and operator evidence."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def record(self, event: Mapping[str, Any]) -> None:
        with self.path.open("a", encoding="utf-8") as audit_file:
            audit_file.write(json.dumps(dict(event), sort_keys=True, separators=(",", ":")))
            audit_file.write("\n")


class AlertEngine:
    def __init__(
        self,
        *,
        destination: AlertDestination,
        audit_trail: AlertAuditTrail,
        state_store: AlertStateStore | None = None,
        rules: tuple[AlertRule, ...] = APPLICATION_ALERT_RULES,
    ) -> None:
        validate_catalog(rules)
        self.rules = rules
        self.destination = destination
        self.audit_trail = audit_trail
        self.state_store = state_store or InMemoryAlertStateStore()

    def evaluate(
        self,
        metrics: Mapping[str, int],
        *,
        observed_at: datetime,
        environment: str,
        commit_sha: str | None,
        synthetic: bool,
    ) -> list[dict[str, Any]]:
        _require_activated_or_synthetic(self.rules, synthetic=synthetic)
        observed_at = _aware_utc(observed_at)
        environment = _safe_environment(environment)
        commit_sha = _safe_commit_sha(commit_sha)
        metric_values = _validated_metric_values(metrics, self.rules)
        emitted: list[dict[str, Any]] = []

        for rule in self.rules:
            observed_count = metric_values[rule.metric]
            instance = self.state_store.get(rule.rule_id)
            firing = observed_count >= rule.threshold

            if firing and (instance is None or instance.resolved_at is not None):
                instance = AlertInstance(
                    rule_id=rule.rule_id,
                    fingerprint=_fingerprint(rule, environment),
                    opened_at=observed_at,
                    last_primary_delivery_at=observed_at,
                )
                self.state_store.put(instance)
                self._audit(
                    "triggered",
                    rule,
                    instance,
                    observed_at,
                    observed_count,
                    synthetic=synthetic,
                )
                emitted.append(
                    self._deliver(
                        "triggered",
                        "primary",
                        rule.primary_destination_id,
                        rule,
                        instance,
                        observed_at,
                        observed_count,
                        environment,
                        commit_sha,
                        synthetic=synthetic,
                    )
                )
                continue

            if firing and instance is not None:
                if instance.acknowledged_at is not None:
                    continue
                if (
                    instance.backup_delivered_at is None
                    and observed_at - instance.opened_at
                    >= timedelta(minutes=rule.escalate_after_minutes)
                ):
                    instance.backup_delivered_at = observed_at
                    self.state_store.put(instance)
                    self._audit(
                        "escalated",
                        rule,
                        instance,
                        observed_at,
                        observed_count,
                        synthetic=synthetic,
                    )
                    emitted.append(
                        self._deliver(
                            "escalated",
                            "backup",
                            rule.backup_destination_id,
                            rule,
                            instance,
                            observed_at,
                            observed_count,
                            environment,
                            commit_sha,
                            synthetic=synthetic,
                        )
                    )
                elif (
                    observed_at - instance.last_primary_delivery_at
                    >= timedelta(minutes=rule.dedupe_minutes)
                ):
                    instance.last_primary_delivery_at = observed_at
                    self.state_store.put(instance)
                    emitted.append(
                        self._deliver(
                            "repeated",
                            "primary",
                            rule.primary_destination_id,
                            rule,
                            instance,
                            observed_at,
                            observed_count,
                            environment,
                            commit_sha,
                            synthetic=synthetic,
                        )
                    )
                continue

            if not firing and instance is not None and instance.resolved_at is None:
                instance.resolved_at = observed_at
                self.state_store.put(instance)
                self._audit(
                    "resolved",
                    rule,
                    instance,
                    observed_at,
                    observed_count,
                    synthetic=synthetic,
                )
                emitted.append(
                    self._deliver(
                        "resolved",
                        "primary",
                        rule.primary_destination_id,
                        rule,
                        instance,
                        observed_at,
                        observed_count,
                        environment,
                        commit_sha,
                        synthetic=synthetic,
                    )
                )
                if instance.backup_delivered_at is not None:
                    emitted.append(
                        self._deliver(
                            "resolved",
                            "backup",
                            rule.backup_destination_id,
                            rule,
                            instance,
                            observed_at,
                            observed_count,
                            environment,
                            commit_sha,
                            synthetic=synthetic,
                        )
                    )

        return emitted

    def acknowledge(
        self,
        rule_id: str,
        *,
        actor_ref: str,
        acknowledged_at: datetime,
        synthetic: bool,
    ) -> None:
        _require_activated_or_synthetic(self.rules, synthetic=synthetic)
        if not SAFE_ACTOR_PATTERN.fullmatch(actor_ref):
            raise OperationalAlertError("actor_ref must be a non-sensitive stable reference")
        instance = self.state_store.get(rule_id)
        if instance is None or instance.resolved_at is not None:
            raise OperationalAlertError(f"no active alert to acknowledge: {rule_id}")
        rule = next((candidate for candidate in self.rules if candidate.rule_id == rule_id), None)
        if rule is None:
            raise OperationalAlertError(f"unknown alert rule: {rule_id}")
        acknowledged_at = _aware_utc(acknowledged_at)
        if acknowledged_at < instance.opened_at:
            raise OperationalAlertError("acknowledgment cannot predate the alert")
        instance.acknowledged_at = acknowledged_at
        self.state_store.put(instance)
        self.audit_trail.record({
            "event": "acknowledged",
            "catalog_version": CATALOG_VERSION,
            "rule_id": rule.rule_id,
            "fingerprint": instance.fingerprint,
            "severity": rule.severity,
            "occurred_at": acknowledged_at.isoformat(),
            "actor_ref": actor_ref,
            "synthetic": synthetic,
        })

    def _deliver(
        self,
        kind: str,
        owner_role: str,
        destination_id: str,
        rule: AlertRule,
        instance: AlertInstance,
        observed_at: datetime,
        observed_count: int,
        environment: str,
        commit_sha: str | None,
        *,
        synthetic: bool,
    ) -> dict[str, Any]:
        envelope = {
            "schema_version": ALERT_ENVELOPE_SCHEMA_VERSION,
            "catalog_version": CATALOG_VERSION,
            "kind": kind,
            "rule_id": rule.rule_id,
            "fingerprint": instance.fingerprint,
            "severity": rule.severity,
            "environment": environment,
            "commit_sha": commit_sha,
            "observed_at": observed_at.isoformat(),
            "observed_count": observed_count,
            "threshold": rule.threshold,
            "window_minutes": rule.window_minutes,
            "destination_id": destination_id,
            "owner_role": owner_role,
            "runbook": rule.runbook,
            "redaction_policy": rule.redaction_policy,
            "synthetic": synthetic,
        }
        receipt = self.destination.deliver(envelope)
        self.audit_trail.record({
            "event": "delivered",
            "catalog_version": CATALOG_VERSION,
            "rule_id": rule.rule_id,
            "fingerprint": instance.fingerprint,
            "severity": rule.severity,
            "occurred_at": observed_at.isoformat(),
            "kind": kind,
            "destination_id": destination_id,
            "owner_role": owner_role,
            "delivery_receipt": receipt,
            "synthetic": synthetic,
        })
        return envelope

    def _audit(
        self,
        event: str,
        rule: AlertRule,
        instance: AlertInstance,
        occurred_at: datetime,
        observed_count: int,
        *,
        synthetic: bool,
    ) -> None:
        self.audit_trail.record({
            "event": event,
            "catalog_version": CATALOG_VERSION,
            "rule_id": rule.rule_id,
            "fingerprint": instance.fingerprint,
            "severity": rule.severity,
            "occurred_at": occurred_at.isoformat(),
            "observed_count": observed_count,
            "synthetic": synthetic,
        })


class OperationalSignalCollector:
    """Read-only aggregate collector. Exact counts return no response rows."""

    def __init__(self, supabase: Client) -> None:
        self.supabase = supabase

    def collect(self, *, observed_at: datetime | None = None) -> dict[str, int]:
        observed_at = _aware_utc(observed_at or datetime.now(timezone.utc))
        webhook_cutoff = (observed_at - timedelta(minutes=10)).isoformat()
        deletion_cutoff = (observed_at - timedelta(hours=24)).isoformat()
        support_cutoff = (observed_at - timedelta(minutes=30)).isoformat()
        reconciliation_cutoff = (observed_at - timedelta(hours=1)).isoformat()

        failed_webhooks = self._count(
            "stripe_events",
            ("eq", "livemode", True),
            ("eq", "processing_status", "failed"),
            ("lte", "created_at", webhook_cutoff),
        )
        stuck_webhooks = self._count(
            "stripe_events",
            ("eq", "livemode", True),
            ("eq", "processing_status", "processing"),
            ("lte", "processing_started_at", webhook_cutoff),
        )
        missing_claim_time_webhooks = self._count(
            "stripe_events",
            ("eq", "livemode", True),
            ("eq", "processing_status", "processing"),
            ("is_", "processing_started_at", "null"),
            ("lte", "created_at", webhook_cutoff),
        )

        return {
            "stripe.live_webhook_failures_over_10m": (
                failed_webhooks + stuck_webhooks + missing_claim_time_webhooks
            ),
            "worker.account_deletions_overdue_24h": self._count(
                "account_deletion_requests",
                ("eq", "status", "scheduled"),
                ("lte", "scheduled_for", deletion_cutoff),
            ),
            "support.urgent_untriaged_over_30m": self._count(
                "support_tickets",
                ("eq", "status", "open"),
                ("eq", "severity", "urgent"),
                ("lte", "created_at", support_cutoff),
            ),
            "billing.reconciliation_required_over_1h": self._count(
                "billing_invoice_retry_operations",
                ("eq", "status", "reconciliation_required"),
                ("lte", "updated_at", reconciliation_cutoff),
            ),
        }

    def _count(self, table: str, *filters: tuple[str, str, Any]) -> int:
        query = self.supabase.table(table).select("id", count="exact", head=True)
        for method_name, column, value in filters:
            query = getattr(query, method_name)(column, value)
        result = query.execute()
        count = getattr(result, "count", None)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise OperationalAlertError(f"aggregate count unavailable for {table}")
        return count


def firing_rule_ids(
    metrics: Mapping[str, int],
    rules: tuple[AlertRule, ...] = APPLICATION_ALERT_RULES,
) -> list[str]:
    values = _validated_metric_values(metrics, rules)
    return [
        rule.rule_id
        for rule in rules
        if values[rule.metric] >= rule.threshold
    ]


def _validated_metric_values(
    metrics: Mapping[str, int],
    rules: tuple[AlertRule, ...],
) -> dict[str, int]:
    expected = {rule.metric for rule in rules}
    if set(metrics) != expected:
        missing = sorted(expected - set(metrics))
        unexpected = sorted(set(metrics) - expected)
        raise OperationalAlertError(
            f"metric snapshot mismatch; missing={missing}; unexpected={unexpected}"
        )
    values: dict[str, int] = {}
    for metric, value in metrics.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise OperationalAlertError(f"metric must be a non-negative integer: {metric}")
        values[metric] = value
    return values


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise OperationalAlertError("alert timestamps must be timezone-aware")
    return value.astimezone(timezone.utc)


def _require_activated_or_synthetic(
    rules: tuple[AlertRule, ...],
    *,
    synthetic: bool,
) -> None:
    if synthetic:
        return
    blocked = sorted(
        rule.rule_id
        for rule in rules
        if rule.activation_state != "active"
    )
    if blocked:
        raise OperationalAlertError(
            f"live alert evaluation is not activated for rules: {blocked}"
        )


def _safe_environment(value: str) -> str:
    normalized = value.strip().lower()
    if not SAFE_ENVIRONMENT_PATTERN.fullmatch(normalized):
        raise OperationalAlertError("environment is not a safe alert label")
    return normalized


def _safe_commit_sha(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not COMMIT_SHA_PATTERN.fullmatch(normalized):
        raise OperationalAlertError("commit_sha must be a full lowercase Git SHA")
    return normalized


def _fingerprint(rule: AlertRule, environment: str) -> str:
    raw = f"{CATALOG_VERSION}:{rule.rule_id}:{environment}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]
