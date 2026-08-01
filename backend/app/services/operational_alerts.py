from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol
from uuid import UUID, uuid4

from supabase import Client

from app.services.supabase_rpc import execute_required_rpc, first_rpc_row, rpc_rows


COUNTS_ONLY_REDACTION_POLICY = "counts-only-v1"
MAX_DELIVERIES_PER_EVALUATION = 32


class OperationalAlertError(RuntimeError):
    pass


@dataclass(frozen=True)
class AlertRule:
    rule_id: str
    metric: str
    severity: str
    threshold: int
    window_minutes: int
    primary_destination_id: str
    runbook: str
    redaction_policy: str = COUNTS_ONLY_REDACTION_POLICY
    activation_state: str = "phase-a-recording-only"


APPLICATION_ALERT_RULES = (
    AlertRule(
        rule_id="stripe-live-webhook-failure",
        metric="stripe-live-webhook-failure",
        severity="critical",
        threshold=1,
        window_minutes=10,
        primary_destination_id="primary-owner",
        runbook="/docs/operational-alerts.md#stripe-live-webhook-failure",
    ),
    AlertRule(
        rule_id="account-deletion-worker-overdue",
        metric="account-deletion-worker-overdue",
        severity="high",
        threshold=1,
        window_minutes=24 * 60,
        primary_destination_id="primary-owner",
        runbook="/docs/operational-alerts.md#account-deletion-worker-overdue",
    ),
    AlertRule(
        rule_id="support-urgent-untriaged",
        metric="support-urgent-untriaged",
        severity="high",
        threshold=1,
        window_minutes=30,
        primary_destination_id="primary-owner",
        runbook="/docs/operational-alerts.md#support-urgent-untriaged",
    ),
    AlertRule(
        rule_id="billing-reconciliation-stale",
        metric="billing-reconciliation-stale",
        severity="high",
        threshold=1,
        window_minutes=60,
        primary_destination_id="primary-owner",
        runbook="/docs/operational-alerts.md#billing-reconciliation-stale",
    ),
)

RULES_BY_ID = {rule.rule_id: rule for rule in APPLICATION_ALERT_RULES}


class AlertDestination(Protocol):
    def deliver(self, envelope: Mapping[str, Any]) -> str: ...


class RecordingAlertDestination:
    """Record-only Phase A adapter. It performs no network I/O."""

    def __init__(self) -> None:
        self.deliveries: list[dict[str, Any]] = []
        self._receipts_by_attempt: dict[str, str] = {}

    def deliver(self, envelope: Mapping[str, Any]) -> str:
        if envelope.get("mode") != "recording-only":
            raise OperationalAlertError("recording adapter requires recording-only mode")
        attempt_key = str(envelope.get("attempt_key") or "")
        try:
            UUID(attempt_key)
        except (TypeError, ValueError):
            raise OperationalAlertError("recording delivery is missing its idempotency key") from None
        receipt = self._receipts_by_attempt.get(attempt_key)
        if receipt is not None:
            return receipt
        receipt = f"recorded:{attempt_key}"
        self.deliveries.append(dict(envelope))
        self._receipts_by_attempt[attempt_key] = receipt
        return receipt


class OperationalAlertService:
    def __init__(self, supabase: Client, *, destination: AlertDestination | None = None):
        self.supabase = supabase
        self.destination = destination or RecordingAlertDestination()

    def evaluate(self, *, environment: str, commit_sha: str | None) -> dict[str, Any]:
        normalized_environment = _safe_nonproduction_environment(environment)
        normalized_commit = _safe_commit_sha(commit_sha)
        metrics = self._metric_counts()
        lifecycle_events: dict[str, str] = {}

        for rule in APPLICATION_ALERT_RULES:
            observed_count = metrics.get(rule.metric)
            if observed_count is None:
                raise OperationalAlertError(f"missing aggregate metric: {rule.metric}")
            result = execute_required_rpc(self.supabase, "evaluate_operational_alert", {
                "p_environment": normalized_environment,
                "p_rule_id": rule.rule_id,
                "p_observed_count": observed_count,
                "p_threshold": rule.threshold,
                "p_window_minutes": rule.window_minutes,
                "p_primary_destination_id": rule.primary_destination_id,
                "p_severity": rule.severity,
                "p_commit_sha": normalized_commit,
                "p_actor_ref": "scheduled-evaluator",
            })
            row = first_rpc_row(result)
            if not row or not isinstance(row.get("lifecycle_event"), str):
                raise OperationalAlertError(f"evaluation result unavailable for {rule.rule_id}")
            lifecycle_events[rule.rule_id] = row["lifecycle_event"]

        delivery_summary = self._drain_recording_outbox(normalized_environment)
        heartbeat_recorded = self.record_heartbeat(
            environment=normalized_environment,
            worker_id="evaluator",
            commit_sha=normalized_commit,
        )
        return {
            "environment": normalized_environment,
            "mode": "recording-only",
            "metrics": metrics,
            "lifecycle_events": lifecycle_events,
            **delivery_summary,
            "heartbeat_recorded": heartbeat_recorded,
        }

    def record_heartbeat(
        self,
        *,
        environment: str,
        worker_id: str,
        commit_sha: str | None,
    ) -> bool:
        result = execute_required_rpc(self.supabase, "record_operational_alert_heartbeat", {
            "p_environment": _safe_nonproduction_environment(environment),
            "p_worker_id": worker_id,
            "p_commit_sha": _safe_commit_sha(commit_sha),
        })
        return first_rpc_row(result) is not None

    def _metric_counts(self) -> dict[str, int]:
        rows = rpc_rows(execute_required_rpc(
            self.supabase,
            "operational_alert_metric_counts",
            {},
        ))
        metrics: dict[str, int] = {}
        for row in rows:
            rule_id = row.get("rule_id")
            count = row.get("observed_count")
            if (
                not isinstance(rule_id, str)
                or rule_id not in RULES_BY_ID
                or not isinstance(count, int)
                or isinstance(count, bool)
                or count < 0
                or rule_id in metrics
            ):
                raise OperationalAlertError("aggregate snapshot does not match the alert catalog")
            metrics[rule_id] = count
        if set(metrics) != set(RULES_BY_ID):
            raise OperationalAlertError("aggregate snapshot is incomplete")
        return metrics

    def _drain_recording_outbox(self, environment: str) -> dict[str, int]:
        claimed = 0
        recorded = 0
        failed = 0
        lease_token = _new_lease_token()
        for _ in range(MAX_DELIVERIES_PER_EVALUATION):
            attempt_key = _new_attempt_key()
            row = first_rpc_row(self._execute_delivery_rpc(
                "claim_operational_alert_delivery",
                {
                    "p_environment": environment,
                    "p_lease_token": lease_token,
                    "p_attempt_key": attempt_key,
                    "p_lease_seconds": 300,
                },
            ))
            if not row:
                break
            claimed += 1
            attempt_id = str(row.get("attempt_id") or "")
            try:
                envelope = _safe_recording_envelope(row, environment=environment)
                receipt = self.destination.deliver(envelope)
                completed = self._execute_delivery_rpc(
                    "complete_operational_alert_delivery",
                    {
                        "p_attempt_id": attempt_id,
                        "p_lease_token": lease_token,
                        "p_receipt": receipt,
                    },
                )
                if getattr(completed, "data", None) is not True:
                    raise OperationalAlertError("delivery receipt was not durably accepted")
                recorded += 1
            except Exception:
                failed += 1
                if attempt_id:
                    self._execute_delivery_rpc("fail_operational_alert_delivery", {
                        "p_attempt_id": attempt_id,
                        "p_lease_token": lease_token,
                        "p_error_code": "recording_delivery_failed",
                        "p_retry_after_seconds": 60,
                    })
        return {
            "deliveries_claimed": claimed,
            "deliveries_recorded": recorded,
            "deliveries_failed": failed,
        }

    def _execute_delivery_rpc(self, name: str, params: dict[str, Any]) -> Any:
        """Retry once with the same lease/attempt identity after an ambiguous transport error."""
        first_error: Exception | None = None
        for _ in range(2):
            try:
                return execute_required_rpc(self.supabase, name, params)
            except Exception as exc:
                if first_error is not None:
                    raise exc from first_error
                first_error = exc
        raise OperationalAlertError(f"delivery RPC {name} did not return")


def _safe_recording_envelope(row: Mapping[str, Any], *, environment: str) -> dict[str, Any]:
    rule_id = str(row.get("rule_id") or "")
    rule = RULES_BY_ID.get(rule_id)
    if not rule:
        raise OperationalAlertError("claimed delivery has an unknown rule")
    destination_id = str(row.get("destination_id") or "")
    if destination_id != rule.primary_destination_id:
        raise OperationalAlertError("claimed delivery has an unknown logical destination")
    observed_count = row.get("observed_count")
    if not isinstance(observed_count, int) or isinstance(observed_count, bool) or observed_count < 0:
        raise OperationalAlertError("claimed delivery has an invalid aggregate count")
    delivery_id = str(row.get("delivery_id") or "")
    episode_id = str(row.get("episode_id") or "")
    attempt_id = str(row.get("attempt_id") or "")
    attempt_key = str(row.get("attempt_key") or "")
    event_kind = str(row.get("event_kind") or "")
    destination_role = str(row.get("destination_role") or "")
    if not delivery_id or not episode_id or not attempt_id or not attempt_key:
        raise OperationalAlertError("claimed delivery is missing its durable identity")
    try:
        UUID(attempt_key)
    except (TypeError, ValueError):
        raise OperationalAlertError("claimed delivery has an invalid idempotency key") from None
    if event_kind != "triggered":
        raise OperationalAlertError("claimed delivery has an invalid event kind")
    if destination_role != "primary":
        raise OperationalAlertError("claimed delivery has an invalid destination role")
    return {
        "schema_version": 1,
        "mode": "recording-only",
        "delivery_id": delivery_id,
        "episode_id": episode_id,
        "attempt_id": attempt_id,
        "attempt_key": attempt_key,
        "rule_id": rule_id,
        "event_kind": event_kind,
        "destination_role": destination_role,
        "destination_id": destination_id,
        "severity": rule.severity,
        "environment": environment,
        "commit_sha": _safe_commit_sha(_optional_text(row.get("commit_sha"))),
        "observed_count": observed_count,
        "threshold": rule.threshold,
        "window_minutes": rule.window_minutes,
        "observed_at": _optional_text(row.get("observed_at")),
        "runbook": rule.runbook,
        "redaction_policy": rule.redaction_policy,
    }


def _safe_nonproduction_environment(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in {"development", "test", "staging"}:
        raise OperationalAlertError("Phase A recording alerts require a non-production environment")
    return normalized


def _safe_commit_sha(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if len(normalized) != 40 or any(character not in "0123456789abcdef" for character in normalized):
        raise OperationalAlertError("commit SHA must be a full lowercase hexadecimal value")
    return normalized


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


def _new_lease_token() -> str:
    import secrets

    return secrets.token_hex(24)


def _new_attempt_key() -> str:
    return str(uuid4())
