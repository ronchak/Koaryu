from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier, Event, Lock
from unittest import TestCase
from unittest.mock import patch

from fastapi import HTTPException

from app.services import platform_billing_service, studio_scope
from app.services.platform_billing_service import (
    ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
    AccessRepairInFlight,
    PlatformBillingService,
)
from app.core.deps import run_supabase_operation
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime


def _always_pending(_service, _row):
    return True


def _provider_repair(service, row, *, strict_repairs=False):
    del strict_repairs
    service._provider_call(
        platform_billing_service.StripeService().retrieve_subscription,
        row["stripe_subscription_id"],
    )
    return row


SINGLE_REPAIR_STEP = ((_always_pending, _provider_repair),)


def _retry_after_in_flight(operation):
    while True:
        try:
            return operation()
        except AccessRepairInFlight as pending:
            pending.completion.result(timeout=5)


class ThreadSafeAccessRepairService(PlatformBillingService):
    def __init__(self, rows):
        self._rows = {row["studio_id"]: deepcopy(row) for row in rows}
        self._row_lock = Lock()
        self.reads = 0
        self.settings = type("Settings", (), {"ENVIRONMENT": "production"})()

    def _ensure_subscription_row(self, studio_id):
        with self._row_lock:
            self.reads += 1
            return deepcopy(self._rows[studio_id])


class BlockingStripe:
    calls = 0
    calls_lock = Lock()
    started = Event()
    release = Event()

    @classmethod
    def reset(cls):
        cls.calls = 0
        cls.started = Event()
        cls.release = Event()

    def retrieve_subscription(self, subscription_id):
        with type(self).calls_lock:
            type(self).calls += 1
        type(self).started.set()
        if subscription_id != "sub_B":
            if not type(self).release.wait(5):
                raise AssertionError("blocked Stripe fake was not released")
        return {"id": subscription_id}


class FailingStripe:
    calls = 0
    calls_lock = Lock()
    started = Event()
    release = Event()

    @classmethod
    def reset(cls):
        cls.calls = 0
        cls.started = Event()
        cls.release = Event()

    def retrieve_subscription(self, _subscription_id):
        with type(self).calls_lock:
            type(self).calls += 1
        type(self).started.set()
        if not type(self).release.wait(5):
            raise AssertionError("failing Stripe fake was not released")
        raise TimeoutError("Stripe is unavailable")


class SingleFlightTest(TestCase):
    def setUp(self):
        self._steps_patch = patch.object(
            platform_billing_service,
            "ACCESS_REPAIR_STEPS",
            SINGLE_REPAIR_STEP,
        )
        self._steps_patch.start()
        self._clear_coordination()

    def tearDown(self):
        self._steps_patch.stop()
        self._clear_coordination()

    @staticmethod
    def _clear_coordination():
        with platform_billing_service._access_repair_metadata_lock:
            platform_billing_service._access_repair_retry_after.clear()
            platform_billing_service._access_repair_flights.clear()

    def _assert_no_completed_flights(self):
        with platform_billing_service._access_repair_metadata_lock:
            self.assertEqual(platform_billing_service._access_repair_flights, {})

    @staticmethod
    def _row(studio_id="studio_1", *, status="canceled"):
        return {
            "studio_id": studio_id,
            "stripe_subscription_id": f"sub_{studio_id.removeprefix('studio_')}",
            "stripe_customer_id": f"cus_{studio_id.removeprefix('studio_')}",
            "status": status,
            "comped": False,
            "trial_end": None,
            "current_period_start": None,
            "current_period_end": None,
        }

    def test_same_studio_burst_has_one_provider_call_and_replays_window_outcome(self):
        BlockingStripe.reset()
        service = ThreadSafeAccessRepairService([self._row()])
        start = Barrier(9)

        def call():
            start.wait(5)
            return _retry_after_in_flight(
                lambda: service.get_access_status_row(
                    "studio_1",
                    strict_repairs=True,
                )
            )

        with patch.object(platform_billing_service, "StripeService", BlockingStripe):
            executor = ThreadPoolExecutor(max_workers=8)
            futures = [executor.submit(call) for _ in range(8)]
            try:
                start.wait(5)
                self.assertTrue(BlockingStripe.started.wait(5))
                self.assertEqual(BlockingStripe.calls, 1)
                # Coordination is before the first subscription read: only the
                # leader has read while the provider call is blocked.
                self.assertEqual(service.reads, 1)
                BlockingStripe.release.set()
                results = [future.result(timeout=5) for future in futures]
            finally:
                BlockingStripe.release.set()
                executor.shutdown(wait=True)

        self.assertEqual(BlockingStripe.calls, 1)
        self.assertEqual(results, [self._row()] * 8)
        self.assertEqual(service.reads, 8)
        self._assert_no_completed_flights()
        with platform_billing_service._access_repair_metadata_lock:
            self.assertIn("studio_1", platform_billing_service._access_repair_retry_after)

    def test_provider_failure_opens_window_before_followers_resume_and_stays_503_neutral(self):
        FailingStripe.reset()
        row = self._row(status="active")
        service = ThreadSafeAccessRepairService([row])
        start = Barrier(9)

        def call():
            start.wait(5)
            return _retry_after_in_flight(
                lambda: studio_scope.get_platform_subscription_access(
                    service.supabase,
                    "studio_1",
                )
            )

        # The service only uses its own row harness, so this sentinel is never
        # dereferenced by the patched local-access fallback.
        service.supabase = object()

        class ServiceFactory(PlatformBillingService):
            def __new__(cls, _supabase):
                return service

        with (
            patch.object(platform_billing_service, "StripeService", FailingStripe),
            patch.object(
                studio_scope,
                "_get_local_platform_subscription_access",
                return_value={"subscription_required": False},
            ),
            patch.object(
                platform_billing_service,
                "PlatformBillingService",
                ServiceFactory,
            ),
        ):
            executor = ThreadPoolExecutor(max_workers=8)
            futures = [executor.submit(call) for _ in range(8)]
            try:
                start.wait(5)
                self.assertTrue(FailingStripe.started.wait(5))
                self.assertEqual(FailingStripe.calls, 1)
                FailingStripe.release.set()
                results = []
                for future in futures:
                    try:
                        results.append(future.result(timeout=5))
                    except HTTPException as exc:
                        results.append(exc)
            finally:
                FailingStripe.release.set()
                executor.shutdown(wait=True)

        self.assertEqual(FailingStripe.calls, 1)
        self.assertEqual([result.status_code for result in results], [503] * 8)
        with platform_billing_service._access_repair_metadata_lock:
            window = platform_billing_service._access_repair_retry_after.get("studio_1")
        self.assertIsNotNone(window)
        self.assertTrue(window.replay_fault)
        self.assertAlmostEqual(
            window.retry_after - platform_billing_service.monotonic(),
            ACCESS_REPAIR_FAILURE_BACKOFF_SECONDS,
            delta=0.1,
        )
        self._assert_no_completed_flights()

    def test_different_studios_overlap_in_stripe(self):
        BlockingStripe.reset()
        rows = [self._row("studio_A"), self._row("studio_B")]
        service = ThreadSafeAccessRepairService(rows)

        with patch.object(platform_billing_service, "StripeService", BlockingStripe):
            executor = ThreadPoolExecutor(max_workers=2)
            first = executor.submit(
                service.get_access_status_row, "studio_A", strict_repairs=True
            )
            try:
                self.assertTrue(BlockingStripe.started.wait(5))
                second = executor.submit(
                    service.get_access_status_row, "studio_B", strict_repairs=True
                )
                self.assertEqual(second.result(timeout=5), self._row("studio_B"))
                # B completed while A was still blocked, proving the flight key is
                # studio-specific rather than a process-wide repair mutex.
                self.assertFalse(first.done())
                self.assertEqual(BlockingStripe.calls, 2)
                BlockingStripe.release.set()
                self.assertEqual(first.result(timeout=5), self._row("studio_A"))
            finally:
                BlockingStripe.release.set()
                executor.shutdown(wait=True)

        self._assert_no_completed_flights()

    def test_internal_exception_wakes_followers_and_later_call_can_retry(self):
        attempts = 0
        attempts_lock = Lock()

        def repair(service, row, *, strict_repairs=False):
            nonlocal attempts
            del strict_repairs
            with attempts_lock:
                attempts += 1
                attempt = attempts
            if attempt == 1:
                raise RuntimeError("persistence failed")
            return row

        self._run_exception_burst(repair, RuntimeError)
        self.assertEqual(attempts, 2)
        self._clear_window("studio_1")
        service = self._last_service
        with patch.object(
            platform_billing_service,
            "ACCESS_REPAIR_STEPS",
            ((_always_pending, repair),),
        ):
            self.assertEqual(
                service.get_access_status_row("studio_1", strict_repairs=True),
                self._row(),
            )
        self.assertEqual(attempts, 3)
        self._assert_no_completed_flights()

    def test_base_exception_wakes_followers_and_does_not_strand_flight(self):
        attempts = 0
        attempts_lock = Lock()

        def repair(service, row, *, strict_repairs=False):
            nonlocal attempts
            del service, strict_repairs
            with attempts_lock:
                attempts += 1
                attempt = attempts
            if attempt == 1:
                raise KeyboardInterrupt("leader cancelled")
            return row

        self._run_exception_burst(repair, KeyboardInterrupt)
        self.assertEqual(attempts, 2)
        self._assert_no_completed_flights()

    def _run_exception_burst(self, repair, expected_exception):
        self._clear_coordination()
        service = ThreadSafeAccessRepairService([self._row()])
        self._last_service = service
        start = Barrier(9)

        def call():
            start.wait(5)
            return _retry_after_in_flight(
                lambda: service.get_access_status_row(
                    "studio_1",
                    strict_repairs=True,
                )
            )

        executor = ThreadPoolExecutor(max_workers=8)
        with patch.object(platform_billing_service, "ACCESS_REPAIR_STEPS", ((_always_pending, repair),)):
            futures = [executor.submit(call) for _ in range(8)]
            try:
                start.wait(5)
                errors = []
                results = []
                for future in futures:
                    try:
                        results.append(future.result(timeout=5))
                    except BaseException as exc:
                        errors.append(exc)
            finally:
                executor.shutdown(wait=True)

        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], expected_exception)
        self.assertEqual(results, [self._row()] * 7)
        self.assertTrue(all(future.done() for future in futures))
        with platform_billing_service._access_repair_metadata_lock:
            self.assertIn("studio_1", platform_billing_service._access_repair_retry_after)

    def _clear_window(self, studio_id):
        with platform_billing_service._access_repair_metadata_lock:
            platform_billing_service._access_repair_retry_after.pop(studio_id, None)

    def test_runtime_followers_yield_interactive_capacity_while_leader_is_blocked(self):
        BlockingStripe.reset()
        service = ThreadSafeAccessRepairService([self._row()])
        config = SupabaseLaneConfig(
            max_workers=4,
            max_queue=0,
            queue_wait_timeout=0.05,
            operation_wait_timeout=2.0,
        )
        runtime = SupabaseProviderRuntime(
            config,
            config,
            client_factory=object,
            client_closer=lambda _client: None,
            thread_name_prefix="repair-yield-test",
        )

        async def exercise():
            def repair(_client):
                return service.get_access_status_row(
                    "studio_1",
                    strict_repairs=True,
                )

            leader = asyncio.create_task(run_supabase_operation(runtime, repair))
            self.assertTrue(await asyncio.to_thread(BlockingStripe.started.wait, 1))
            followers = [
                asyncio.create_task(run_supabase_operation(runtime, repair))
                for _ in range(3)
            ]

            for _ in range(100):
                snapshot = runtime.interactive_snapshot()
                if snapshot.submitted >= 4 and snapshot.completed >= 3:
                    break
                await asyncio.sleep(0.005)
            snapshot = runtime.interactive_snapshot()
            self.assertEqual(snapshot.admitted, 1)
            self.assertEqual(snapshot.completed, 3)

            # This would saturate if the three followers still occupied the
            # other three interactive workers while waiting for the leader.
            self.assertEqual(
                await run_supabase_operation(runtime, lambda _client: "unrelated"),
                "unrelated",
            )

            BlockingStripe.release.set()
            return await asyncio.gather(leader, *followers)

        try:
            with patch.object(platform_billing_service, "StripeService", BlockingStripe):
                results = asyncio.run(exercise())
        finally:
            BlockingStripe.release.set()
            runtime.shutdown()

        self.assertEqual(results, [self._row()] * 4)
        self.assertEqual(BlockingStripe.calls, 1)
        self.assertEqual(runtime.interactive_snapshot().admitted, 0)
