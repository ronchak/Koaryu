from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace
from typing import Any

import pytest

from app.services.operational_alerts import (
    ALERT_ENVELOPE_FIELDS,
    APPLICATION_ALERT_RULES,
    AlertEngine,
    JsonlAlertAuditTrail,
    ListAlertAuditTrail,
    OperationalSignalCollector,
    RecordingAlertDestination,
    validate_catalog,
)


NOW = datetime(2026, 7, 28, 0, 0, tzinfo=timezone.utc)


def _engine_for_first_rule() -> tuple[
    AlertEngine,
    RecordingAlertDestination,
    ListAlertAuditTrail,
]:
    destination = RecordingAlertDestination()
    audit = ListAlertAuditTrail()
    engine = AlertEngine(
        destination=destination,
        audit_trail=audit,
        rules=(APPLICATION_ALERT_RULES[0],),
    )
    return engine, destination, audit


def test_catalog_defines_complete_blocked_ownership_and_response_policy() -> None:
    validate_catalog()

    assert len(APPLICATION_ALERT_RULES) == 4
    for rule in APPLICATION_ALERT_RULES:
        assert rule.condition == "count_at_least"
        assert rule.threshold >= 1
        assert rule.window_minutes >= 1
        assert rule.dedupe_minutes >= 1
        assert rule.acknowledge_within_minutes >= 1
        assert rule.escalate_after_minutes >= rule.acknowledge_within_minutes
        assert rule.primary_destination_id == "owner-email-primary"
        assert rule.backup_destination_id == "approval-required-backup"
        assert rule.primary_owner == "Ronak Chakraborty"
        assert rule.backup_owner == "approval required"
        assert rule.runbook.startswith("/docs/operational-alerts.md#")
        assert rule.redaction_policy == "counts-only-v1"
        assert rule.activation_state == "blocked-pending-destination-approval"


def test_delivery_lifecycle_dedupes_escalates_acknowledges_and_resolves() -> None:
    engine, destination, audit = _engine_for_first_rule()
    rule = APPLICATION_ALERT_RULES[0]
    firing = {rule.metric: rule.threshold}
    clear = {rule.metric: 0}

    assert len(engine.evaluate(
        firing,
        observed_at=NOW,
        environment="production",
        commit_sha="a" * 40,
        synthetic=True,
    )) == 1
    assert engine.evaluate(
        firing,
        observed_at=NOW + timedelta(minutes=1),
        environment="production",
        commit_sha="a" * 40,
        synthetic=True,
    ) == []
    assert len(engine.evaluate(
        firing,
        observed_at=NOW + timedelta(minutes=15),
        environment="production",
        commit_sha="a" * 40,
        synthetic=True,
    )) == 1

    engine.acknowledge(
        rule.rule_id,
        actor_ref="synthetic-backup-owner",
        acknowledged_at=NOW + timedelta(minutes=16),
        synthetic=True,
    )
    assert engine.evaluate(
        firing,
        observed_at=NOW + timedelta(minutes=180),
        environment="production",
        commit_sha="a" * 40,
        synthetic=True,
    ) == []
    assert len(engine.evaluate(
        clear,
        observed_at=NOW + timedelta(minutes=181),
        environment="production",
        commit_sha="a" * 40,
        synthetic=True,
    )) == 2

    assert [delivery["kind"] for delivery in destination.deliveries] == [
        "triggered",
        "escalated",
        "resolved",
        "resolved",
    ]
    assert [delivery["owner_role"] for delivery in destination.deliveries] == [
        "primary",
        "backup",
        "primary",
        "backup",
    ]
    assert any(event["event"] == "acknowledged" for event in audit.events)


def test_primary_acknowledgment_suppresses_backup_escalation() -> None:
    engine, destination, _audit = _engine_for_first_rule()
    rule = APPLICATION_ALERT_RULES[0]
    firing = {rule.metric: 1}

    engine.evaluate(
        firing,
        observed_at=NOW,
        environment="staging",
        commit_sha=None,
        synthetic=True,
    )
    engine.acknowledge(
        rule.rule_id,
        actor_ref="synthetic-primary-owner",
        acknowledged_at=NOW + timedelta(minutes=5),
        synthetic=True,
    )
    engine.evaluate(
        firing,
        observed_at=NOW + timedelta(minutes=120),
        environment="staging",
        commit_sha=None,
        synthetic=True,
    )

    assert len(destination.deliveries) == 1
    assert destination.deliveries[0]["owner_role"] == "primary"


def test_live_evaluation_fails_closed_while_destination_approval_is_pending() -> None:
    engine, _destination, _audit = _engine_for_first_rule()
    rule = APPLICATION_ALERT_RULES[0]

    with pytest.raises(
        RuntimeError,
        match="live alert evaluation is not activated",
    ):
        engine.evaluate(
            {rule.metric: 1},
            observed_at=NOW,
            environment="production",
            commit_sha=None,
            synthetic=False,
        )


def test_envelope_is_counts_only_and_excludes_sensitive_context() -> None:
    engine, destination, audit = _engine_for_first_rule()
    rule = APPLICATION_ALERT_RULES[0]
    engine.evaluate(
        {rule.metric: 7},
        observed_at=NOW,
        environment="production",
        commit_sha="b" * 40,
        synthetic=True,
    )

    envelope = destination.deliveries[0]
    assert set(envelope) == ALERT_ENVELOPE_FIELDS
    assert envelope["observed_count"] == 7
    serialized = json.dumps(
        {"envelope": envelope, "audit": audit.events},
        sort_keys=True,
    ).lower()
    for forbidden in (
        "requester_email",
        "customer_id",
        "invoice_id",
        "payload",
        "details",
        "query_string",
        "user_agent",
    ):
        assert forbidden not in serialized


def test_jsonl_audit_trail_appends_structured_events(tmp_path: Any) -> None:
    path = tmp_path / "alert-audit.jsonl"
    trail = JsonlAlertAuditTrail(path)

    trail.record({"event": "first", "synthetic": True})
    trail.record({"event": "second", "synthetic": True})

    assert [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
    ] == [
        {"event": "first", "synthetic": True},
        {"event": "second", "synthetic": True},
    ]


class _FakeCountQuery:
    def __init__(self, *, table: str, count: int, calls: list[dict[str, Any]]) -> None:
        self._record = {
            "table": table,
            "select": None,
            "count_mode": None,
            "head": None,
            "filters": [],
        }
        self._count = count
        calls.append(self._record)

    def select(
        self,
        columns: str,
        *,
        count: str,
        head: bool,
    ) -> "_FakeCountQuery":
        self._record["select"] = columns
        self._record["count_mode"] = count
        self._record["head"] = head
        return self

    def eq(self, column: str, value: Any) -> "_FakeCountQuery":
        self._record["filters"].append(("eq", column, value))
        return self

    def lte(self, column: str, value: Any) -> "_FakeCountQuery":
        self._record["filters"].append(("lte", column, value))
        return self

    def is_(self, column: str, value: Any) -> "_FakeCountQuery":
        self._record["filters"].append(("is_", column, value))
        return self

    def execute(self) -> SimpleNamespace:
        return SimpleNamespace(count=self._count)


class _FakeSupabase:
    def __init__(self, counts: list[int]) -> None:
        self._counts = iter(counts)
        self.calls: list[dict[str, Any]] = []

    def table(self, table: str) -> _FakeCountQuery:
        return _FakeCountQuery(
            table=table,
            count=next(self._counts),
            calls=self.calls,
        )


def test_collector_uses_exact_counts_and_never_selects_record_fields() -> None:
    supabase = _FakeSupabase([2, 3, 4, 5, 6, 7])
    metrics = OperationalSignalCollector(supabase).collect(observed_at=NOW)  # type: ignore[arg-type]

    assert metrics == {
        "stripe.live_webhook_failures_over_10m": 9,
        "worker.account_deletions_overdue_24h": 5,
        "support.urgent_untriaged_over_30m": 6,
        "billing.reconciliation_required_over_1h": 7,
    }
    assert len(supabase.calls) == 6
    assert all(call["select"] == "id" for call in supabase.calls)
    assert all(call["count_mode"] == "exact" for call in supabase.calls)
    assert all(call["head"] is True for call in supabase.calls)
    assert all(
        selected not in json.dumps(supabase.calls)
        for selected in (
            "requester_email",
            "details",
            "payload",
            "customer_id",
            "invoice_id",
        )
    )


@pytest.mark.parametrize("metric_value", [-1, True, "1"])
def test_engine_rejects_invalid_aggregate_metric_values(metric_value: Any) -> None:
    engine, _destination, _audit = _engine_for_first_rule()
    rule = APPLICATION_ALERT_RULES[0]

    with pytest.raises(RuntimeError):
        engine.evaluate(
            {rule.metric: metric_value},
            observed_at=NOW,
            environment="production",
            commit_sha=None,
            synthetic=True,
        )
