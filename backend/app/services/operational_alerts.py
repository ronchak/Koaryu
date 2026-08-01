from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any, Mapping, Protocol
from uuid import UUID, uuid4

from supabase import Client

from app.core.config import (
    Settings,
    validate_operational_alert_destination,
    validate_raw_header_value,
)
from app.services.pinned_https import PinnedHttpsError, PinnedHttpsTransport
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row, rpc_rows


COUNTS_ONLY_REDACTION_POLICY = "counts-only-v1"
MAX_DELIVERIES_PER_EVALUATION = 32


class OperationalAlertError(RuntimeError):
    pass


class AlertDeliveryError(OperationalAlertError):
    def __init__(self, error_code: str):
        super().__init__(error_code)
        self.error_code = error_code


@dataclass(frozen=True)
class AlertRule:
    rule_id: str
    metric: str
    severity: str
    threshold: int
    window_minutes: int
    primary_destination_id: str
    backup_destination_id: str
    escalation_after_minutes: int
    runbook: str
    redaction_policy: str = COUNTS_ONLY_REDACTION_POLICY
    activation_state: str = "disabled-until-configured"


APPLICATION_ALERT_RULES = (
    AlertRule(
        rule_id="stripe-live-webhook-failure",
        metric="stripe-live-webhook-failure",
        severity="critical",
        threshold=1,
        window_minutes=10,
        primary_destination_id="primary-owner",
        backup_destination_id="backup-owner",
        escalation_after_minutes=15,
        runbook="/docs/operational-alerts.md#stripe-live-webhook-failure",
    ),
    AlertRule(
        rule_id="account-deletion-worker-overdue",
        metric="account-deletion-worker-overdue",
        severity="high",
        threshold=1,
        window_minutes=24 * 60,
        primary_destination_id="primary-owner",
        backup_destination_id="backup-owner",
        escalation_after_minutes=120,
        runbook="/docs/operational-alerts.md#account-deletion-worker-overdue",
    ),
    AlertRule(
        rule_id="support-urgent-untriaged",
        metric="support-urgent-untriaged",
        severity="high",
        threshold=1,
        window_minutes=30,
        primary_destination_id="primary-owner",
        backup_destination_id="backup-owner",
        escalation_after_minutes=60,
        runbook="/docs/operational-alerts.md#support-urgent-untriaged",
    ),
    AlertRule(
        rule_id="billing-reconciliation-stale",
        metric="billing-reconciliation-stale",
        severity="high",
        threshold=1,
        window_minutes=60,
        primary_destination_id="primary-owner",
        backup_destination_id="backup-owner",
        escalation_after_minutes=120,
        runbook="/docs/operational-alerts.md#billing-reconciliation-stale",
    ),
)

RULES_BY_ID = {rule.rule_id: rule for rule in APPLICATION_ALERT_RULES}


class AlertDestination(Protocol):
    mode: str

    def deliver(self, envelope: Mapping[str, Any]) -> str: ...


class RecordingAlertDestination:
    """Non-network test adapter; never selected by an enabled API endpoint."""

    mode = "recording-only"

    def __init__(self) -> None:
        self.deliveries: list[dict[str, Any]] = []
        self._receipts_by_attempt: dict[str, str] = {}

    def deliver(self, envelope: Mapping[str, Any]) -> str:
        if envelope.get("mode") != self.mode:
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


@dataclass(frozen=True)
class HttpsDestinationConfig:
    destination_id: str
    url: str
    hostname: str
    url_fingerprint: str
    bearer_secret: str


class HttpsAlertDestination:
    """Bounded counts-only HTTPS transport with strict durable receipts."""

    mode = "https"
    _receipt_pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", re.ASCII)

    def __init__(
        self,
        destinations: Mapping[str, HttpsDestinationConfig],
        *,
        transport: PinnedHttpsTransport | None = None,
    ) -> None:
        if set(destinations) != {"primary", "backup"}:
            raise OperationalAlertError("exactly primary and backup destinations are required")
        self.destinations = dict(destinations)
        for role, destination in self.destinations.items():
            if destination.destination_id != f"{role}-owner":
                raise OperationalAlertError("logical alert destination is not allowlisted")
            try:
                validate_operational_alert_destination(
                    destination.url,
                    destination.url_fingerprint,
                    destination.hostname,
                )
            except ValueError:
                raise OperationalAlertError("alert destination fingerprint is invalid") from None
            try:
                validate_raw_header_value(
                    f"OPERATIONAL_ALERT_{role.upper()}_BEARER_SECRET",
                    destination.bearer_secret,
                )
            except RuntimeError:
                raise OperationalAlertError("alert destination credential is invalid") from None
            if len(destination.bearer_secret) < 32:
                raise OperationalAlertError("alert destination credential is invalid")
        if (
            self.destinations["primary"].url == self.destinations["backup"].url
            or self.destinations["primary"].url_fingerprint
            == self.destinations["backup"].url_fingerprint
            or self.destinations["primary"].bearer_secret
            == self.destinations["backup"].bearer_secret
        ):
            raise OperationalAlertError("primary and backup destinations must be distinct")
        self.transport = transport or PinnedHttpsTransport()

    @classmethod
    def from_settings(cls, settings: Settings) -> "HttpsAlertDestination":
        primary_url = validate_operational_alert_destination(
            settings.OPERATIONAL_ALERT_PRIMARY_URL,
            settings.OPERATIONAL_ALERT_PRIMARY_URL_SHA256,
            settings.OPERATIONAL_ALERT_PRIMARY_HOST,
        )
        backup_url = validate_operational_alert_destination(
            settings.OPERATIONAL_ALERT_BACKUP_URL,
            settings.OPERATIONAL_ALERT_BACKUP_URL_SHA256,
            settings.OPERATIONAL_ALERT_BACKUP_HOST,
        )
        return cls({
            "primary": HttpsDestinationConfig(
                destination_id="primary-owner",
                url=primary_url,
                hostname=settings.OPERATIONAL_ALERT_PRIMARY_HOST,
                url_fingerprint=settings.OPERATIONAL_ALERT_PRIMARY_URL_SHA256,
                bearer_secret=settings.OPERATIONAL_ALERT_PRIMARY_BEARER_SECRET,
            ),
            "backup": HttpsDestinationConfig(
                destination_id="backup-owner",
                url=backup_url,
                hostname=settings.OPERATIONAL_ALERT_BACKUP_HOST,
                url_fingerprint=settings.OPERATIONAL_ALERT_BACKUP_URL_SHA256,
                bearer_secret=settings.OPERATIONAL_ALERT_BACKUP_BEARER_SECRET,
            ),
        })

    def deliver(self, envelope: Mapping[str, Any]) -> str:
        if envelope.get("mode") != self.mode:
            raise AlertDeliveryError("invalid_envelope_mode")
        role = str(envelope.get("destination_role") or "")
        destination = self.destinations.get(role)
        if destination is None or envelope.get("destination_id") != destination.destination_id:
            raise AlertDeliveryError("destination_not_allowlisted")
        attempt_key = str(envelope.get("attempt_key") or "")
        try:
            UUID(attempt_key)
        except (TypeError, ValueError):
            raise AlertDeliveryError("invalid_idempotency_key") from None

        body = json.dumps(dict(envelope), separators=(",", ":"), sort_keys=True).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {destination.bearer_secret}",
            "Content-Type": "application/json",
            "Idempotency-Key": attempt_key,
            "X-Koaryu-Destination-Fingerprint": destination.url_fingerprint,
        }
        try:
            target = self.transport.pin(destination.url, destination.hostname)
        except PinnedHttpsError as exc:
            raise AlertDeliveryError(str(exc)) from None

        for send_number in range(2):
            try:
                response = self.transport.request(
                    target,
                    address_index=send_number,
                    method="POST",
                    headers=headers,
                    body=body,
                )
                if 300 <= response.status_code < 400:
                    raise AlertDeliveryError("redirect_refused")
                if response.status_code < 200 or response.status_code >= 300:
                    if send_number == 0 and (
                        response.status_code in {408, 425, 429}
                        or 500 <= response.status_code < 600
                    ):
                        continue
                    raise AlertDeliveryError("destination_http_failure")
                return _strict_receipt(
                    response.headers.get("content-type"),
                    response.body,
                )
            except PinnedHttpsError:
                if send_number == 0:
                    continue
                raise AlertDeliveryError("destination_transport_failure") from None
        raise AlertDeliveryError("destination_delivery_failed")


class OperationalAlertService:
    def __init__(self, supabase: Client, *, destination: AlertDestination | None = None):
        self.supabase = supabase
        self.destination = destination or RecordingAlertDestination()

    def evaluate(self, *, environment: str, commit_sha: str | None) -> dict[str, Any]:
        normalized_environment = _safe_environment(environment)
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
                "p_backup_destination_id": rule.backup_destination_id,
                "p_escalation_after_minutes": rule.escalation_after_minutes,
                "p_severity": rule.severity,
                "p_commit_sha": normalized_commit,
                "p_actor_ref": "scheduled-evaluator",
            })
            row = first_rpc_row(result)
            if not row or not isinstance(row.get("lifecycle_event"), str):
                raise OperationalAlertError(f"evaluation result unavailable for {rule.rule_id}")
            lifecycle_events[rule.rule_id] = row["lifecycle_event"]

        delivery_summary = self._drain_outbox(normalized_environment)
        heartbeat_sequence = self.record_heartbeat(
            environment=normalized_environment,
            worker_id="evaluator",
            commit_sha=normalized_commit,
        )
        return {
            "environment": normalized_environment,
            "mode": self.destination.mode,
            "metrics": metrics,
            "lifecycle_events": lifecycle_events,
            **delivery_summary,
            "heartbeat_recorded": heartbeat_sequence > 0,
            "heartbeat_sequence": heartbeat_sequence,
        }

    def record_heartbeat(
        self,
        *,
        environment: str,
        worker_id: str,
        commit_sha: str | None,
    ) -> int:
        result = execute_required_rpc(self.supabase, "record_operational_alert_heartbeat", {
            "p_environment": _safe_environment(environment),
            "p_worker_id": worker_id,
            "p_commit_sha": _safe_commit_sha(commit_sha),
        })
        row = first_rpc_row(result)
        sequence = row.get("sequence") if row else None
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1:
            raise OperationalAlertError("heartbeat sequence is invalid")
        return sequence

    def acknowledge(
        self,
        *,
        environment: str,
        episode_id: UUID,
        actor_role: str,
        actor_ref: str,
    ) -> dict[str, Any] | None:
        row = first_rpc_row(execute_required_rpc(
            self.supabase,
            "acknowledge_operational_alert",
            {
                "p_environment": _safe_environment(environment),
                "p_episode_id": str(episode_id),
                "p_actor_role": actor_role,
                "p_actor_ref": actor_ref,
            },
        ))
        if not row:
            return None
        event = row.get("lifecycle_event")
        acknowledged_role = row.get("acknowledged_by_role")
        if event not in {"acknowledged", "already_acknowledged", "closed"}:
            raise OperationalAlertError("acknowledgement result is invalid")
        if acknowledged_role is not None and acknowledged_role not in {"primary", "backup"}:
            raise OperationalAlertError("acknowledgement result is invalid")
        return {
            "episode_id": str(row.get("episode_id") or ""),
            "lifecycle_event": event,
            "acknowledged": acknowledged_role is not None,
            "acknowledged_by_role": acknowledged_role,
        }

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

    def _drain_outbox(self, environment: str) -> dict[str, int]:
        claimed = 0
        delivered = 0
        failed = 0
        lease_token = _new_lease_token()
        proven_empty = False
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
                proven_empty = True
                break
            claimed += 1
            attempt_id = str(row.get("attempt_id") or "")
            try:
                envelope = _safe_delivery_envelope(
                    row,
                    environment=environment,
                    mode=self.destination.mode,
                )
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
                delivered += 1
            except Exception as exc:
                failed += 1
                if attempt_id:
                    error_code = (
                        exc.error_code
                        if isinstance(exc, AlertDeliveryError)
                        else "alert_delivery_failed"
                    )
                    self._execute_delivery_rpc("fail_operational_alert_delivery", {
                        "p_attempt_id": attempt_id,
                        "p_lease_token": lease_token,
                        "p_error_code": error_code,
                        "p_retry_after_seconds": _retry_after_seconds(row.get("attempt_number")),
                    })
        if not proven_empty or failed > 0 or claimed != delivered:
            raise OperationalAlertError("operational alert outbox did not drain safely")
        return {
            "deliveries_claimed": claimed,
            "deliveries_delivered": delivered,
            "deliveries_failed": failed,
        }

    def _execute_delivery_rpc(self, name: str, params: dict[str, Any]) -> Any:
        """Retry once with the same lease/attempt identity after an ambiguous RPC error."""
        first_error: Exception | None = None
        for _ in range(2):
            try:
                return execute_required_rpc(self.supabase, name, params)
            except Exception as exc:
                if first_error is not None:
                    raise exc from first_error
                first_error = exc
        raise OperationalAlertError(f"delivery RPC {name} did not return")


def _safe_delivery_envelope(
    row: Mapping[str, Any],
    *,
    environment: str,
    mode: str,
) -> dict[str, Any]:
    rule_id = str(row.get("rule_id") or "")
    rule = RULES_BY_ID.get(rule_id)
    if not rule:
        raise OperationalAlertError("claimed delivery has an unknown rule")
    destination_id = str(row.get("destination_id") or "")
    event_kind = str(row.get("event_kind") or "")
    destination_role = str(row.get("destination_role") or "")
    allowed_destination = {
        "primary": rule.primary_destination_id,
        "backup": rule.backup_destination_id,
    }.get(destination_role)
    if destination_id != allowed_destination:
        raise OperationalAlertError("claimed delivery has an unknown logical destination")
    observed_count = row.get("observed_count")
    if not isinstance(observed_count, int) or isinstance(observed_count, bool) or observed_count < 0:
        raise OperationalAlertError("claimed delivery has an invalid aggregate count")
    delivery_id = str(row.get("delivery_id") or "")
    episode_id = str(row.get("episode_id") or "")
    attempt_id = str(row.get("attempt_id") or "")
    attempt_key = str(row.get("attempt_key") or "")
    if not delivery_id or not episode_id or not attempt_id or not attempt_key:
        raise OperationalAlertError("claimed delivery is missing its durable identity")
    try:
        UUID(attempt_key)
    except (TypeError, ValueError):
        raise OperationalAlertError("claimed delivery has an invalid idempotency key") from None
    if event_kind not in {"triggered", "escalated", "resolved"}:
        raise OperationalAlertError("claimed delivery has an invalid event kind")
    if (
        (event_kind == "triggered" and destination_role != "primary")
        or (event_kind == "escalated" and destination_role != "backup")
    ):
        raise OperationalAlertError("claimed delivery has an invalid destination role")
    return {
        "schema_version": 1,
        "mode": mode,
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


def _safe_environment(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in {"development", "test", "staging", "production"}:
        raise OperationalAlertError("operational alerts require a known environment")
    return normalized


def _safe_commit_sha(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if len(normalized) != 40 or any(character not in "0123456789abcdef" for character in normalized):
        raise OperationalAlertError("commit SHA must be a full lowercase hexadecimal value")
    return normalized


def _strict_receipt(content_type: str | None, payload: bytes) -> str:
    if (content_type or "").split(";", 1)[0].strip().lower() != "application/json":
        raise AlertDeliveryError("receipt_content_type_invalid")
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AlertDeliveryError("receipt_json_invalid") from None
    if not isinstance(decoded, dict) or set(decoded) != {"receipt_id"}:
        raise AlertDeliveryError("receipt_shape_invalid")
    receipt = decoded.get("receipt_id")
    if not isinstance(receipt, str) or not HttpsAlertDestination._receipt_pattern.fullmatch(receipt):
        raise AlertDeliveryError("receipt_id_invalid")
    return receipt


def _retry_after_seconds(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        return 60
    return min(3600, 60 * (2 ** min(value - 1, 6)))


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text or None


def _new_lease_token() -> str:
    return str(uuid4())


def _new_attempt_key() -> str:
    return str(uuid4())
