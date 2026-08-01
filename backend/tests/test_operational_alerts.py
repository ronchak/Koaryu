import hashlib
import asyncio
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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
from app.db.supabase import DeadlineBoundSupabaseClient
from app.services.pinned_https import PinnedHttpsResponse


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

    def __init__(self, *, claim=True, claim_count=None, fail_execute_once=None):
        self.remaining_claims = claim_count if claim_count is not None else int(claim)
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
            if self.remaining_claims < 1:
                return _Query([])
            claim_number = self.remaining_claims
            self.remaining_claims -= 1
            role = "backup" if claim_number % 2 == 0 else "primary"
            return _Query({
                "delivery_id": "delivery-1",
                "episode_id": "episode-1",
                "attempt_id": "attempt-1",
                "attempt_key": params["p_attempt_key"],
                "rule_id": APPLICATION_ALERT_RULES[0].rule_id,
                "event_kind": "escalated" if role == "backup" else "triggered",
                "destination_role": role,
                "destination_id": f"{role}-owner",
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

    def deliver(self, envelope, *, deadline_monotonic):
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
        claim = database.events[claim_index][1]
        self.assertEqual(claim["p_lease_seconds"], 30)

    def test_delivery_failure_is_recorded_without_sent_completion(self):
        database = FakeAlertDatabase(claim_count=2)
        destination = OrderedDestination(database.events, fail=True)

        with self.assertRaisesRegex(OperationalAlertError, "did not drain safely"):
            OperationalAlertService(database, destination=destination).evaluate(
                environment="staging",
                commit_sha=COMMIT_SHA,
            )

        names = [event[0] for event in database.events]
        self.assertNotIn("complete_operational_alert_delivery", names)
        self.assertIn("fail_operational_alert_delivery", names)
        self.assertEqual(names.count("fail_operational_alert_delivery"), 2)
        self.assertNotIn("record_operational_alert_heartbeat", names)

    def test_delivery_cap_without_proven_empty_suppresses_heartbeat(self):
        database = FakeAlertDatabase()

        with patch(
            "app.services.operational_alerts.MAX_DELIVERIES_PER_EVALUATION",
            1,
        ):
            with self.assertRaisesRegex(OperationalAlertError, "did not drain safely"):
                OperationalAlertService(database).evaluate(
                    environment="staging",
                    commit_sha=COMMIT_SHA,
                )

        names = [event[0] for event in database.events]
        self.assertIn("complete_operational_alert_delivery", names)
        self.assertNotIn("record_operational_alert_heartbeat", names)

    def test_batch_deadline_stops_backlog_without_false_heartbeat(self):
        class Clock:
            now = 100.0

            def __call__(self):
                return self.now

        class AdvancingDestination(OrderedDestination):
            def deliver(self, envelope, *, deadline_monotonic):
                receipt = super().deliver(
                    envelope,
                    deadline_monotonic=deadline_monotonic,
                )
                clock.now = 110.0
                return receipt

        class ClockDatabase(FakeAlertDatabase):
            def rpc(self, name, params):
                result = super().rpc(name, params)
                if name == "complete_operational_alert_delivery":
                    clock.now = 111.0
                return result

        clock = Clock()
        database = ClockDatabase(claim_count=2)
        destination = AdvancingDestination(database.events)

        with self.assertRaisesRegex(OperationalAlertError, "did not drain safely"):
            OperationalAlertService(
                database,
                destination=destination,
                clock=clock,
            ).evaluate(
                environment="staging",
                commit_sha=COMMIT_SHA,
                deadline_monotonic=116.0,
            )

        names = [event[0] for event in database.events]
        self.assertEqual(names.count("claim_operational_alert_delivery"), 1)
        self.assertEqual(names.count("complete_operational_alert_delivery"), 1)
        self.assertNotIn("record_operational_alert_heartbeat", names)

    def test_delivery_deadline_failure_is_persisted_before_heartbeat_is_suppressed(self):
        class Clock:
            now = 100.0

            def __call__(self):
                return self.now

        class TimingOutDestination(OrderedDestination):
            def deliver(self, envelope, *, deadline_monotonic):
                clock.now = deadline_monotonic
                raise AlertDeliveryError("destination_timeout")

        clock = Clock()
        database = FakeAlertDatabase(claim_count=1)

        with self.assertRaisesRegex(OperationalAlertError, "did not drain safely"):
            OperationalAlertService(
                database,
                destination=TimingOutDestination(database.events),
                clock=clock,
            ).evaluate(
                environment="staging",
                commit_sha=COMMIT_SHA,
                deadline_monotonic=116.0,
            )

        names = [event[0] for event in database.events]
        self.assertIn("fail_operational_alert_delivery", names)
        self.assertNotIn("complete_operational_alert_delivery", names)
        self.assertNotIn("record_operational_alert_heartbeat", names)
        failure = next(
            params for name, params in database.events
            if name == "fail_operational_alert_delivery"
        )
        self.assertEqual(failure["p_error_code"], "destination_timeout")

    def test_slow_rpc_is_aborted_at_absolute_deadline_without_heartbeat(self):
        cancelled = threading.Event()
        closed = threading.Event()
        rpc_names = []

        class BlockingQuery:
            async def execute(self):
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise

        class AsyncClient:
            def rpc(self, name, params):
                rpc_names.append(name)
                return BlockingQuery()

            @property
            def postgrest(self):
                return self

            async def aclose(self):
                closed.set()

        async def client_factory(*_args, **_kwargs):
            return AsyncClient()

        database = DeadlineBoundSupabaseClient(
            "https://example.supabase.co",
            "header.payload.signature",
            postgrest_client_timeout=120,
            async_client_factory=client_factory,
        )
        started = time.monotonic()
        with (
            patch(
                "app.services.operational_alerts.EVALUATION_CLEANUP_RESERVE_SECONDS",
                0.01,
            ),
            patch(
                "app.services.operational_alerts.EVALUATION_RPC_START_RESERVE_SECONDS",
                0.01,
            ),
            self.assertRaisesRegex(
                OperationalAlertError,
                "deadline exceeded",
            ),
        ):
            OperationalAlertService(database).evaluate(
                environment="staging",
                commit_sha=COMMIT_SHA,
                deadline_monotonic=time.monotonic() + 0.04,
            )

        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(cancelled.is_set())
        self.assertTrue(closed.is_set())
        self.assertEqual(rpc_names, ["operational_alert_metric_counts"])
        self.assertNotIn("record_operational_alert_heartbeat", rpc_names)

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

        deadline = time.monotonic() + 1
        first = adapter.deliver(envelope, deadline_monotonic=deadline)
        second = adapter.deliver(envelope, deadline_monotonic=deadline)

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
    class _Transport:
        def __init__(self, handler):
            self.handler = handler
            self.url = None

        def pin(self, url, expected_hostname, *, deadline_monotonic):
            self.url = url
            return SimpleNamespace(
                url=url,
                hostname=expected_hostname,
                addresses=("pinned",),
                deadline_monotonic=deadline_monotonic,
            )

        def request(self, target, *, address_index, method, headers, body):
            request = httpx.Request(method, self.url, headers=headers, content=body)
            response = self.handler(request)
            return PinnedHttpsResponse(
                response.status_code,
                {name.lower(): value for name, value in response.headers.items()},
                response.content,
            )

    def _destination(self, handler):
        url = "https://alerts.example.com/koaryu/primary"
        fingerprint = hashlib.sha256(url.encode()).hexdigest()
        backup_url = "https://alerts.example.com/koaryu/backup"
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
        }, transport=self._Transport(handler))

    @staticmethod
    def _envelope():
        return {
            "mode": "https",
            "attempt_key": "11111111-1111-4111-8111-111111111111",
            "destination_role": "primary",
            "destination_id": "primary-owner",
            "observed_count": 1,
        }

    def test_rejects_header_controls_before_default_transport_construction(self):
        primary_url = "https://alerts.example.com/koaryu/primary"
        backup_url = "https://alerts.example.com/koaryu/backup"
        for role, unsafe_secret in (
            ("primary", f"{'P' * 40}\t"),
            ("primary", f"{'P' * 40}\r"),
            ("backup", f"{'B' * 40}\n"),
            ("backup", f"{'B' * 40}\x7f"),
        ):
            with self.subTest(role=role, secret=repr(unsafe_secret)):
                secrets_by_role = {"primary": "P" * 40, "backup": "B" * 40}
                secrets_by_role[role] = unsafe_secret
                with patch("app.services.operational_alerts.PinnedHttpsTransport") as transport:
                    with self.assertRaisesRegex(
                        OperationalAlertError,
                        "credential is invalid",
                    ):
                        HttpsAlertDestination({
                            "primary": HttpsDestinationConfig(
                                "primary-owner",
                                primary_url,
                                "alerts.example.com",
                                hashlib.sha256(primary_url.encode()).hexdigest(),
                                secrets_by_role["primary"],
                            ),
                            "backup": HttpsDestinationConfig(
                                "backup-owner",
                                backup_url,
                                "alerts.example.com",
                                hashlib.sha256(backup_url.encode()).hexdigest(),
                                secrets_by_role["backup"],
                            ),
                        })
                    transport.assert_not_called()

    def test_strict_receipt_and_stable_idempotency_header(self):
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"receipt_id": "receipt-1"})

        receipt = self._destination(handler).deliver(
            self._envelope(),
            deadline_monotonic=time.monotonic() + 1,
        )

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

        receipt = self._destination(handler).deliver(
            self._envelope(),
            deadline_monotonic=time.monotonic() + 1,
        )

        self.assertEqual(receipt, "receipt-2")
        self.assertEqual(keys, [self._envelope()["attempt_key"]] * 2)

    def test_refuses_redirect_and_non_exact_receipt_shape(self):
        with self.assertRaisesRegex(AlertDeliveryError, "redirect_refused"):
            self._destination(
                lambda request: httpx.Response(302, headers={"location": "https://other.example/"}),
            ).deliver(
                self._envelope(),
                deadline_monotonic=time.monotonic() + 1,
            )
        with self.assertRaisesRegex(AlertDeliveryError, "receipt_shape_invalid"):
            self._destination(
                lambda request: httpx.Response(200, json={"receipt_id": "ok", "extra": True}),
            ).deliver(
                self._envelope(),
                deadline_monotonic=time.monotonic() + 1,
            )


if __name__ == "__main__":
    unittest.main()
