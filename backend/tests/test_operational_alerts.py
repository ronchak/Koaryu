import hashlib
from types import SimpleNamespace
import unittest

import httpx

from app.services.operational_alerts import (
    APPLICATION_ALERT_RULES,
    AlertDeliveryError,
    HttpsAlertDestination,
    HttpsDestinationConfig,
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
                "attempt_number": 1,
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
            return _Query({"worker_id": params["p_worker_id"], "sequence": 1})
        if name == "acknowledge_operational_alert":
            return _Query({
                "episode_id": params["p_episode_id"],
                "lifecycle_event": "acknowledged",
                "acknowledged_by_role": params["p_actor_role"],
            })
        raise AssertionError(f"unexpected RPC: {name}")


class OrderedDestination:
    mode = "recording-only"

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
        self.assertEqual(result["deliveries_delivered"], 1)
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
        self.assertEqual(result["deliveries_delivered"], 0)
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
        self.assertEqual(result["deliveries_delivered"], 1)

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

    def test_known_production_environment_is_supported_by_the_service(self):
        result = OperationalAlertService(FakeAlertDatabase(claim=False)).evaluate(
            environment="production",
            commit_sha=COMMIT_SHA,
        )

        self.assertEqual(result["environment"], "production")

    def test_acknowledgement_is_counts_only_and_role_bound(self):
        database = FakeAlertDatabase(claim=False)
        result = OperationalAlertService(database).acknowledge(
            environment="staging",
            episode_id=__import__("uuid").UUID("11111111-1111-4111-8111-111111111111"),
            actor_role="backup",
            actor_ref="backup-owner",
        )

        self.assertEqual(result["acknowledged_by_role"], "backup")
        rpc = next(params for name, params in database.events if name == "acknowledge_operational_alert")
        self.assertEqual(rpc["p_actor_ref"], "backup-owner")

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


class HttpsAlertDestinationTest(unittest.TestCase):
    def _destination(self, handler):
        url = "https://alerts.example.com/koaryu/primary"
        fingerprint = hashlib.sha256(url.encode()).hexdigest()
        backup_url = "https://alerts.example.com/koaryu/backup"
        client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
        return HttpsAlertDestination({
            "primary": HttpsDestinationConfig(
                "primary-owner", url, "alerts.example.com", fingerprint, "P" * 40
            ),
            "backup": HttpsDestinationConfig(
                "backup-owner",
                backup_url,
                "alerts.example.com",
                hashlib.sha256(backup_url.encode()).hexdigest(),
                "B" * 40,
            ),
        }, client=client)

    @staticmethod
    def _envelope():
        return {
            "mode": "https",
            "attempt_key": "11111111-1111-4111-8111-111111111111",
            "destination_role": "primary",
            "destination_id": "primary-owner",
            "observed_count": 1,
        }

    def test_strict_receipt_and_stable_idempotency_header(self):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"receipt_id": "receipt-1"})

        receipt = self._destination(handler).deliver(self._envelope())

        self.assertEqual(receipt, "receipt-1")
        self.assertEqual(requests[0].headers["idempotency-key"], self._envelope()["attempt_key"])
        self.assertNotIn("alerts.example.com", requests[0].content.decode())

    def test_retries_transient_failure_with_the_same_idempotency_key(self):
        keys = []

        def handler(request):
            keys.append(request.headers["idempotency-key"])
            if len(keys) == 1:
                return httpx.Response(503, json={"receipt_id": "ignored"})
            return httpx.Response(200, json={"receipt_id": "receipt-2"})

        receipt = self._destination(handler).deliver(self._envelope())

        self.assertEqual(receipt, "receipt-2")
        self.assertEqual(keys, [self._envelope()["attempt_key"]] * 2)

    def test_refuses_redirect_and_non_exact_receipt_shape(self):
        with self.assertRaisesRegex(AlertDeliveryError, "redirect_refused"):
            self._destination(
                lambda request: httpx.Response(302, headers={"location": "https://other.example/"}),
            ).deliver(self._envelope())
        with self.assertRaisesRegex(AlertDeliveryError, "receipt_shape_invalid"):
            self._destination(
                lambda request: httpx.Response(200, json={"receipt_id": "ok", "extra": True}),
            ).deliver(self._envelope())


if __name__ == "__main__":
    unittest.main()
