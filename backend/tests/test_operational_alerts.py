from types import SimpleNamespace
import unittest

from app.services.operational_alerts import (
    APPLICATION_ALERT_RULES,
    OperationalAlertError,
    OperationalAlertService,
    RecordingAlertDestination,
)


COMMIT_SHA = "a" * 40


class _Query:
    def __init__(self, data):
        self.data = data

    def execute(self):
        return SimpleNamespace(data=self.data)


class _RaisingQuery:
    def execute(self):
        raise RuntimeError("synthetic ambiguous transport failure")


class FakeAlertDatabase:
    """RPC-only fake: alert evaluation must not depend on PostgREST count/HEAD behavior."""

    def __init__(self, *, claim=True, fail_execute_once=None):
        self.claim = claim
        self.fail_execute_once = fail_execute_once
        self.events = []

    def rpc(self, name, params):
        self.events.append((name, params))
        if self.fail_execute_once == name:
            self.fail_execute_once = None
            return _RaisingQuery()
        if name == "operational_alert_metric_counts":
            return _Query([
                {"rule_id": rule.rule_id, "observed_count": 0, "checked_at": "2026-08-01T00:00:00Z"}
                for rule in APPLICATION_ALERT_RULES
            ])
        if name == "evaluate_operational_alert":
            return _Query({
                "episode_id": None,
                "lifecycle_event": "unchanged",
                "outbox_id": None,
            })
        if name == "claim_operational_alert_delivery":
            if not self.claim:
                return _Query([])
            self.claim = False
            return _Query({
                "delivery_id": "delivery-1",
                "episode_id": "episode-1",
                "attempt_id": "attempt-1",
                "attempt_key": params["p_attempt_key"],
                "rule_id": APPLICATION_ALERT_RULES[0].rule_id,
                "event_kind": "triggered",
                "destination_role": "primary",
                "destination_id": "primary-owner",
                "observed_count": 1,
                "observed_at": "2026-08-01T00:00:00Z",
                "commit_sha": COMMIT_SHA,
            })
        if name in {
            "complete_operational_alert_delivery",
            "fail_operational_alert_delivery",
        }:
            return _Query(True)
        if name == "record_operational_alert_heartbeat":
            return _Query({"worker_id": params["p_worker_id"]})
        raise AssertionError(f"unexpected RPC: {name}")


class OrderedDestination:
    def __init__(self, events, *, fail=False):
        self.events = events
        self.fail = fail

    def deliver(self, envelope):
        self.events.append(("destination.deliver", dict(envelope)))
        if self.fail:
            raise RuntimeError("synthetic recording failure")
        return f"recorded:{envelope['attempt_key']}"


class OperationalAlertServiceTest(unittest.TestCase):
    def test_claim_precedes_delivery_and_receipt_precedes_sent_completion(self):
        database = FakeAlertDatabase()
        destination = OrderedDestination(database.events)

        result = OperationalAlertService(database, destination=destination).evaluate(
            environment="staging",
            commit_sha=COMMIT_SHA,
        )

        names = [event[0] for event in database.events]
        claim_index = names.index("claim_operational_alert_delivery")
        delivery_index = names.index("destination.deliver")
        completion_index = names.index("complete_operational_alert_delivery")
        self.assertLess(claim_index, delivery_index)
        self.assertLess(delivery_index, completion_index)
        self.assertEqual(result["deliveries_claimed"], 1)
        self.assertEqual(result["deliveries_recorded"], 1)
        self.assertEqual(result["deliveries_failed"], 0)
        completion = database.events[completion_index][1]
        self.assertTrue(completion["p_receipt"].startswith("recorded:"))

    def test_delivery_failure_is_recorded_without_sent_completion(self):
        database = FakeAlertDatabase()
        destination = OrderedDestination(database.events, fail=True)

        result = OperationalAlertService(database, destination=destination).evaluate(
            environment="staging",
            commit_sha=COMMIT_SHA,
        )

        names = [event[0] for event in database.events]
        self.assertNotIn("complete_operational_alert_delivery", names)
        self.assertIn("fail_operational_alert_delivery", names)
        self.assertEqual(result["deliveries_recorded"], 0)
        self.assertEqual(result["deliveries_failed"], 1)

    def test_ambiguous_claim_retries_with_the_same_lease_and_attempt_key(self):
        database = FakeAlertDatabase(fail_execute_once="claim_operational_alert_delivery")

        result = OperationalAlertService(database).evaluate(
            environment="staging",
            commit_sha=COMMIT_SHA,
        )

        claims = [
            params for name, params in database.events
            if name == "claim_operational_alert_delivery"
        ]
        self.assertGreaterEqual(len(claims), 3)
        self.assertEqual(claims[0], claims[1])
        self.assertEqual(result["deliveries_recorded"], 1)

    def test_recording_adapter_is_idempotent_by_attempt_key(self):
        adapter = RecordingAlertDestination()
        envelope = {
            "mode": "recording-only",
            "attempt_key": "11111111-1111-4111-8111-111111111111",
        }

        first = adapter.deliver(envelope)
        second = adapter.deliver(envelope)

        self.assertEqual(first, second)
        self.assertEqual(len(adapter.deliveries), 1)

    def test_phase_a_rejects_production(self):
        with self.assertRaisesRegex(OperationalAlertError, "non-production"):
            OperationalAlertService(FakeAlertDatabase(claim=False)).evaluate(
                environment="production",
                commit_sha=COMMIT_SHA,
            )

    def test_incomplete_aggregate_snapshot_fails_closed(self):
        database = FakeAlertDatabase(claim=False)
        original_rpc = database.rpc

        def rpc(name, params):
            if name == "operational_alert_metric_counts":
                return _Query([{"rule_id": APPLICATION_ALERT_RULES[0].rule_id, "observed_count": 0}])
            return original_rpc(name, params)

        database.rpc = rpc
        with self.assertRaisesRegex(OperationalAlertError, "incomplete"):
            OperationalAlertService(database).evaluate(
                environment="staging",
                commit_sha=COMMIT_SHA,
            )


if __name__ == "__main__":
    unittest.main()
