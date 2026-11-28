import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.release_schema_readiness import (
    EXPECTED_RELEASE_MIGRATION_COUNT,
    EXPECTED_RELEASE_MIGRATION_HEAD,
    EXPECTED_RELEASE_MANIFEST_VERSION,
    EXPECTED_RELEASE_PENDING_VERSIONS,
    HostedReleaseReadinessCache,
    ReleaseSchemaNotReadyError,
    assert_hosted_release_schema_ready,
    is_transient_readiness_error,
    validate_release_schema_preflight,
)

READINESS_LOGGER = "app.services.release_schema_readiness"


def statement_timeout():
    return PostgrestAPIError(
        {
            "code": "57014",
            "message": "canceling statement due to statement timeout",
        }
    )


def exact_preflight_row():
    return {
        "ready": True,
        "migration_count": EXPECTED_RELEASE_MIGRATION_COUNT,
        "migration_head": EXPECTED_RELEASE_MIGRATION_HEAD,
        "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS,
        "security_failures": [],
        "manifest_version": EXPECTED_RELEASE_MANIFEST_VERSION,
    }


class ReleaseSchemaReadinessTest(unittest.TestCase):
    def test_exact_preflight_is_ready(self):
        validate_release_schema_preflight(exact_preflight_row())

    def test_incomplete_or_malformed_preflight_shape_fails_closed(self):
        rows = (
            {
                key: value
                for key, value in exact_preflight_row().items()
                if key != "manifest_version"
            },
            {
                **exact_preflight_row(),
                "pending_versions": tuple(EXPECTED_RELEASE_PENDING_VERSIONS),
            },
            {**exact_preflight_row(), "security_failures": None},
        )
        for row in rows:
            with self.subTest(row=row), self.assertRaises(ReleaseSchemaNotReadyError):
                validate_release_schema_preflight(row)

    def test_coherent_v48_predecessor_cannot_satisfy_v57_readiness(self):
        previous = {
            "ready": True,
            "migration_count": 143,
            "migration_head": "20260920035023",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:59],
            "security_failures": [],
            "manifest_version": "release-db-attestation-v48",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(previous)

    def test_exact_v53_predecessor_cannot_satisfy_v57_readiness(self):
        previous = {
            "ready": True,
            "migration_count": 148,
            "migration_head": "20260929152445",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:64],
            "security_failures": [],
            "manifest_version": "release-db-attestation-v53",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(previous)

    def test_exact_v54_predecessor_cannot_satisfy_v57_readiness(self):
        previous = {
            "ready": True,
            "migration_count": 149,
            "migration_head": "20260930024404",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:65],
            "security_failures": [],
            "manifest_version": "release-db-attestation-v54",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(previous)

    def test_exact_v56_predecessor_cannot_satisfy_v57_readiness(self):
        previous = {
            "ready": True,
            "migration_count": 151,
            "migration_head": "20261004220435",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:67],
            "security_failures": [],
            "manifest_version": "release-db-attestation-v56",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(previous)

    def test_exact_v55_predecessor_cannot_satisfy_v57_readiness(self):
        previous = {
            "ready": True,
            "migration_count": 150,
            "migration_head": "20260930192626",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:66],
            "security_failures": [],
            "manifest_version": "release-db-attestation-v55",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(previous)

    def test_each_independent_preflight_mismatch_fails_closed(self):
        valid = exact_preflight_row()
        rows = [None]
        # Each row changes one field so another mismatch cannot mask a missing check.
        for field, values in {
            "ready": [False, "true", None],
            "migration_count": [
                EXPECTED_RELEASE_MIGRATION_COUNT - 1,
                EXPECTED_RELEASE_MIGRATION_COUNT + 1,
            ],
            "migration_head": ["20260908133504", "20990101000000"],
            "pending_versions": [
                EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
                list(reversed(EXPECTED_RELEASE_PENDING_VERSIONS)),
                [*EXPECTED_RELEASE_PENDING_VERSIONS, "20990101000000"],
            ],
            "security_failures": [["table:missing"]],
            "manifest_version": ["release-db-attestation-v40"],
        }.items():
            rows.extend({**valid, field: value} for value in values)
        for row in rows:
            with self.subTest(row=row), self.assertRaises(ReleaseSchemaNotReadyError):
                validate_release_schema_preflight(row)

    def test_hosted_check_uses_required_rpc(self):
        response = SimpleNamespace(data=[exact_preflight_row()])
        rpc_result = SimpleNamespace(execute=lambda: response)
        calls = []

        def rpc(name, params):
            calls.append((name, params))
            return rpc_result

        client = SimpleNamespace(rpc=rpc)
        with patch(
            "app.services.release_schema_readiness.get_supabase_client",
            return_value=client,
        ):
            assert_hosted_release_schema_ready()
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v42", {})])

    def test_hosted_check_does_not_fallback_on_provider_failure(self):
        calls = []

        def rpc(name, params):
            calls.append((name, params))
            error = PostgrestAPIError(
                {
                    "code": "PGRST000",
                    "message": "Database unavailable",
                }
            )
            return SimpleNamespace(execute=lambda: (_ for _ in ()).throw(error))

        client = SimpleNamespace(rpc=rpc)
        with (
            patch(
                "app.services.release_schema_readiness.get_supabase_client",
                return_value=client,
            ),
            self.assertRaises(PostgrestAPIError),
        ):
            assert_hosted_release_schema_ready()
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v42", {})])

    def test_hosted_check_fails_closed_when_current_rpc_is_missing(self):
        calls = []

        def rpc(name, params):
            calls.append((name, params))
            error = PostgrestAPIError(
                {
                    "code": "PGRST202",
                    "message": (
                        "Could not find the function "
                        "public.koaryu_release_schema_preflight_v36 in the schema cache"
                    ),
                }
            )
            return SimpleNamespace(execute=lambda: (_ for _ in ()).throw(error))

        client = SimpleNamespace(rpc=rpc)
        with (
            patch(
                "app.services.release_schema_readiness.get_supabase_client",
                return_value=client,
            ),
            self.assertRaisesRegex(RuntimeError, "Apply the database migrations"),
        ):
            assert_hosted_release_schema_ready()
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v42", {})])

    def test_success_cache_rechecks_only_after_ttl(self):
        now = [10.0]
        calls = []

        async def run_check(check):
            check()

        cache = HostedReleaseReadinessCache(
            check=lambda: calls.append(now[0]),
            monotonic=lambda: now[0],
            run_check=run_check,
            success_ttl_seconds=30.0,
        )

        asyncio.run(cache.assert_ready())
        now[0] = 39.999
        asyncio.run(cache.assert_ready())
        self.assertEqual(calls, [10.0])

        now[0] = 40.0
        asyncio.run(cache.assert_ready())
        self.assertEqual(calls, [10.0, 40.0])

    def test_failures_are_not_cached(self):
        calls = []

        def fail():
            calls.append("check")
            raise RuntimeError("database unavailable")

        async def run_check(check):
            check()

        cache = HostedReleaseReadinessCache(check=fail, run_check=run_check)
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                asyncio.run(cache.assert_ready())

        self.assertEqual(calls, ["check", "check"])

    def test_concurrent_probes_share_one_successful_preflight(self):
        calls = []

        def check():
            calls.append("check")

        async def exercise_concurrency():
            check_started = asyncio.Event()
            release_check = asyncio.Event()
            runner_calls = []

            async def run_check(blocking_check):
                runner_calls.append("runner")
                check_started.set()
                await release_check.wait()
                blocking_check()

            cache = HostedReleaseReadinessCache(
                check=check,
                run_check=run_check,
            )
            tasks = [asyncio.create_task(cache.assert_ready()) for _ in range(8)]
            await asyncio.wait_for(check_started.wait(), timeout=2)
            await asyncio.sleep(0)
            self.assertEqual(runner_calls, ["runner"])
            release_check.set()
            await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)

        asyncio.run(exercise_concurrency())

        self.assertEqual(calls, ["check"])

    def test_concurrent_probes_share_one_failure_then_a_later_probe_retries(self):
        async def exercise_failure():
            check_started = asyncio.Event()
            release_check = asyncio.Event()
            runner_calls = []

            async def run_check(_blocking_check):
                runner_calls.append("runner")
                check_started.set()
                await release_check.wait()
                raise RuntimeError("database unavailable")

            cache = HostedReleaseReadinessCache(
                check=lambda: None,
                run_check=run_check,
            )
            tasks = [asyncio.create_task(cache.assert_ready()) for _ in range(8)]
            await asyncio.wait_for(check_started.wait(), timeout=2)
            await asyncio.sleep(0)
            self.assertEqual(runner_calls, ["runner"])
            release_check.set()
            results = await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True),
                timeout=2,
            )
            self.assertEqual(len(runner_calls), 1)
            self.assertTrue(
                all(
                    isinstance(result, RuntimeError) and str(result) == "database unavailable"
                    for result in results
                )
            )

            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                await cache.assert_ready()
            self.assertEqual(runner_calls, ["runner", "runner"])

        asyncio.run(exercise_failure())

    def test_cancelled_waiter_does_not_cancel_the_shared_check(self):
        async def exercise_cancellation():
            check_started = asyncio.Event()
            release_check = asyncio.Event()
            runner_calls = []

            async def run_check(blocking_check):
                runner_calls.append("runner")
                check_started.set()
                await release_check.wait()
                blocking_check()

            cache = HostedReleaseReadinessCache(
                check=lambda: None,
                run_check=run_check,
            )
            cancelled_waiter = asyncio.create_task(cache.assert_ready())
            await asyncio.wait_for(check_started.wait(), timeout=2)
            surviving_waiter = asyncio.create_task(cache.assert_ready())
            await asyncio.sleep(0)

            cancelled_waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled_waiter

            release_check.set()
            await asyncio.wait_for(surviving_waiter, timeout=2)
            self.assertEqual(runner_calls, ["runner"])

        asyncio.run(exercise_cancellation())

    def test_all_cancelled_waiters_consume_a_later_provider_failure(self):
        async def exercise_cancelled_failure():
            check_started = asyncio.Event()
            release_check = asyncio.Event()
            check_finished = asyncio.Event()
            loop_errors = []
            loop = asyncio.get_running_loop()
            previous_handler = loop.get_exception_handler()
            loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))

            async def run_check(_blocking_check):
                check_started.set()
                await release_check.wait()
                check_finished.set()
                raise RuntimeError("database unavailable after disconnect")

            try:
                cache = HostedReleaseReadinessCache(
                    check=lambda: None,
                    run_check=run_check,
                )
                waiter = asyncio.create_task(cache.assert_ready())
                await asyncio.wait_for(check_started.wait(), timeout=2)
                waiter.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await waiter

                release_check.set()
                await asyncio.wait_for(check_finished.wait(), timeout=2)
                for _ in range(3):
                    await asyncio.sleep(0)

                self.assertIsNone(cache._inflight)
                self.assertEqual(loop_errors, [])
            finally:
                loop.set_exception_handler(previous_handler)

        asyncio.run(exercise_cancelled_failure())


class TransientReadinessGraceTest(unittest.TestCase):
    """A proven-ready process survives a short window with no readiness answer."""

    def make_cache(self, outcomes, now, **kwargs):
        calls = []

        def check():
            calls.append(now[0])
            outcome = outcomes.pop(0)
            if outcome is not None:
                raise outcome

        async def run_check(blocking_check):
            blocking_check()

        cache = HostedReleaseReadinessCache(
            check=check,
            monotonic=lambda: now[0],
            run_check=run_check,
            success_ttl_seconds=30.0,
            transient_grace_seconds=180.0,
            **kwargs,
        )
        return cache, calls

    def test_classification_admits_only_failures_without_an_answer(self):
        request = httpx.Request("POST", "https://example.invalid/rest/v1/rpc/x")
        transient = [
            statement_timeout(),
            PostgrestAPIError({"code": "55P03", "message": "lock timeout"}),
            PostgrestAPIError({"code": "PGRST000", "message": "could not connect"}),
            PostgrestAPIError({"code": "PGRST002", "message": "schema cache"}),
            PostgrestAPIError({"code": "PGRST003", "message": "pool timeout"}),
            # A non-JSON gateway response carries the integer HTTP status.
            PostgrestAPIError({"code": 504, "message": "JSON could not be generated"}),
            TimeoutError(),
            httpx.ReadTimeout("read timed out", request=request),
            httpx.ConnectError("connection refused", request=request),
            httpx.RemoteProtocolError("server disconnected", request=request),
        ]
        definite = [
            ReleaseSchemaNotReadyError("Release schema preflight did not match exact head."),
            RuntimeError("Supabase RPC x is required. Apply the database migrations"),
            PostgrestAPIError({"code": "PGRST202", "message": "Could not find the function"}),
            PostgrestAPIError({"code": "42501", "message": "permission denied"}),
            PostgrestAPIError({"code": "PGRST301", "message": "JWT expired"}),
            PostgrestAPIError({"code": 500, "message": "JSON could not be generated"}),
            PostgrestAPIError({"message": "no code"}),
            httpx.UnsupportedProtocol("bad scheme", request=request),
            ValueError("unexpected"),
        ]
        for exc in transient:
            with self.subTest(exc=repr(exc)):
                self.assertTrue(is_transient_readiness_error(exc))
        for exc in definite:
            with self.subTest(exc=repr(exc)):
                self.assertFalse(is_transient_readiness_error(exc))

    def test_timeout_after_recent_success_serves_ready_and_logs(self):
        now = [10.0]
        cache, calls = self.make_cache([None, statement_timeout()], now)
        asyncio.run(cache.assert_ready())

        now[0] = 55.0
        with self.assertLogs(READINESS_LOGGER, level="WARNING") as logs:
            asyncio.run(cache.assert_ready())

        self.assertEqual(calls, [10.0, 55.0])
        self.assertEqual(len(logs.records), 1)
        message = logs.records[0].getMessage()
        self.assertIn("APIError 57014", message)
        self.assertIn("last success 45.0s ago", message)
        self.assertIn("180s allowed", message)

    def test_timeout_without_any_prior_success_fails_closed(self):
        now = [10.0]
        cache, _calls = self.make_cache([statement_timeout()], now)
        with self.assertRaises(PostgrestAPIError):
            asyncio.run(cache.assert_ready())

    def test_timeout_after_the_grace_window_fails_closed(self):
        now = [10.0]
        cache, _calls = self.make_cache(
            [None, statement_timeout(), statement_timeout()],
            now,
        )
        asyncio.run(cache.assert_ready())

        now[0] = 189.9
        asyncio.run(cache.assert_ready())

        now[0] = 190.0
        with self.assertRaises(PostgrestAPIError):
            asyncio.run(cache.assert_ready())

    def test_definite_not_ready_during_grace_wins_and_is_not_masked_later(self):
        now = [10.0]
        cache, _calls = self.make_cache(
            [
                None,
                statement_timeout(),
                ReleaseSchemaNotReadyError("wrong head"),
                statement_timeout(),
            ],
            now,
        )
        asyncio.run(cache.assert_ready())
        now[0] = 45.0
        asyncio.run(cache.assert_ready())

        now[0] = 50.0
        with self.assertRaisesRegex(ReleaseSchemaNotReadyError, "wrong head"):
            asyncio.run(cache.assert_ready())

        now[0] = 55.0
        with self.assertRaises(PostgrestAPIError):
            asyncio.run(cache.assert_ready())

    def test_unrecognized_failure_fails_closed_and_clears_grace(self):
        now = [10.0]
        cache, _calls = self.make_cache(
            [None, ValueError("unexpected"), statement_timeout()],
            now,
        )
        asyncio.run(cache.assert_ready())
        now[0] = 45.0
        with self.assertRaises(ValueError):
            asyncio.run(cache.assert_ready())
        now[0] = 50.0
        with self.assertRaises(PostgrestAPIError):
            asyncio.run(cache.assert_ready())

    def test_success_after_grace_expiry_restarts_the_grace(self):
        now = [10.0]
        cache, _calls = self.make_cache(
            [None, statement_timeout(), None, statement_timeout()],
            now,
        )
        asyncio.run(cache.assert_ready())

        now[0] = 200.0
        with self.assertRaises(PostgrestAPIError):
            asyncio.run(cache.assert_ready())

        now[0] = 201.0
        asyncio.run(cache.assert_ready())

        now[0] = 240.0
        asyncio.run(cache.assert_ready())

    def test_concurrent_probes_during_grace_share_one_check(self):
        async def exercise():
            now = [10.0]
            check_started = asyncio.Event()
            release_check = asyncio.Event()
            runner_calls = []
            outcomes = [None, statement_timeout()]

            async def run_check(_blocking_check):
                runner_calls.append(now[0])
                outcome = outcomes.pop(0)
                if outcome is None:
                    return
                check_started.set()
                await release_check.wait()
                raise outcome

            cache = HostedReleaseReadinessCache(
                check=lambda: None,
                monotonic=lambda: now[0],
                run_check=run_check,
            )
            await cache.assert_ready()

            now[0] = 60.0
            with self.assertLogs(READINESS_LOGGER, level="WARNING") as logs:
                tasks = [asyncio.create_task(cache.assert_ready()) for _ in range(8)]
                await asyncio.wait_for(check_started.wait(), timeout=2)
                await asyncio.sleep(0)
                release_check.set()
                await asyncio.wait_for(asyncio.gather(*tasks), timeout=2)

            self.assertEqual(runner_calls, [10.0, 60.0])
            self.assertEqual(len(logs.records), 8)

        asyncio.run(exercise())

    def test_hung_preflight_answers_within_the_probe_budget(self):
        async def exercise():
            now = [10.0]
            release_check = asyncio.Event()
            runner_calls = []
            late_outcome = []

            async def run_check(_blocking_check):
                runner_calls.append(now[0])
                if len(runner_calls) == 1:
                    return
                await release_check.wait()
                if late_outcome:
                    raise late_outcome[0]

            cache = HostedReleaseReadinessCache(
                check=lambda: None,
                monotonic=lambda: now[0],
                run_check=run_check,
                probe_budget_seconds=0.05,
            )
            await cache.assert_ready()

            # Within grace the probe returns ready on its budget, not the RPC's.
            now[0] = 60.0
            started = time.monotonic()
            with self.assertLogs(READINESS_LOGGER, level="WARNING") as logs:
                await asyncio.wait_for(cache.assert_ready(), timeout=2)
                await asyncio.wait_for(cache.assert_ready(), timeout=2)
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertIn("TimeoutError", logs.records[0].getMessage())
            # Both probes joined the one hung check instead of starting more.
            self.assertEqual(runner_calls, [10.0, 60.0])

            # The hung check finally returns a definite not-ready after every
            # waiter gave up. The shared task still records it.
            late_outcome.append(ReleaseSchemaNotReadyError("wrong head"))
            release_check.set()
            for _ in range(5):
                await asyncio.sleep(0)
            self.assertIsNone(cache._inflight)

            # A new hung check now has no grace and fails closed on budget.
            release_check.clear()
            late_outcome.clear()
            now[0] = 70.0
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(cache.assert_ready(), timeout=2)
            self.assertLess(time.monotonic() - started, 1.0)
            release_check.set()

        asyncio.run(exercise())

    def test_hung_preflight_on_a_fresh_process_fails_closed_within_budget(self):
        async def exercise():
            never = asyncio.Event()

            async def run_check(_blocking_check):
                await never.wait()

            cache = HostedReleaseReadinessCache(
                check=lambda: None,
                run_check=run_check,
                probe_budget_seconds=0.05,
            )
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(cache.assert_ready(), timeout=2)
            self.assertLess(time.monotonic() - started, 1.0)
            never.set()

        asyncio.run(exercise())

    def test_late_success_after_budget_is_recorded_for_the_next_probe(self):
        async def exercise():
            release_check = asyncio.Event()
            runner_calls = []

            async def run_check(_blocking_check):
                runner_calls.append("runner")
                await release_check.wait()

            cache = HostedReleaseReadinessCache(
                check=lambda: None,
                run_check=run_check,
                probe_budget_seconds=0.05,
            )
            with self.assertRaises(TimeoutError):
                await cache.assert_ready()
            release_check.set()
            for _ in range(5):
                await asyncio.sleep(0)
            await cache.assert_ready()
            self.assertEqual(runner_calls, ["runner"])

        asyncio.run(exercise())

    def test_grace_cannot_be_configured_shorter_than_the_success_ttl(self):
        with self.assertRaises(ValueError):
            HostedReleaseReadinessCache(success_ttl_seconds=30.0, transient_grace_seconds=10.0)
        with self.assertRaises(ValueError):
            HostedReleaseReadinessCache(probe_budget_seconds=0)


if __name__ == "__main__":
    unittest.main()
