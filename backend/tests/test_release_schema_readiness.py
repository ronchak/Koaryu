import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.release_schema_readiness import (
    EXPECTED_RELEASE_MIGRATION_COUNT,
    EXPECTED_RELEASE_MIGRATION_HEAD,
    EXPECTED_RELEASE_MANIFEST_VERSION,
    EXPECTED_RELEASE_PENDING_VERSIONS,
    HostedReleaseReadinessCache,
    ReleaseSchemaNotReadyError,
    assert_hosted_release_schema_ready,
    validate_release_schema_preflight,
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
    def test_v36_candidate_constants_are_exact(self):
        self.assertEqual(EXPECTED_RELEASE_MIGRATION_COUNT, 131)
        self.assertEqual(EXPECTED_RELEASE_MIGRATION_HEAD, "20260831054918")
        self.assertEqual(
            EXPECTED_RELEASE_MANIFEST_VERSION,
            "release-db-attestation-v36",
        )
        self.assertEqual(EXPECTED_RELEASE_PENDING_VERSIONS[-1], "20260831054918")
        self.assertEqual(len(EXPECTED_RELEASE_PENDING_VERSIONS), 47)

    def test_exact_preflight_is_ready(self):
        validate_release_schema_preflight(exact_preflight_row())

    def test_incomplete_or_malformed_v17_shape_fails_closed(self):
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

    def test_v12_compatibility_shape_cannot_satisfy_candidate_readiness(self):
        compatibility_row = {
            "ready": True,
            "migration_count": 126,
            "migration_head": "20260826185651",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
            "security_failures": [],
            "manifest_version": "release-db-attestation-v31",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(compatibility_row)

    def test_v13_v32_response_cannot_satisfy_candidate_readiness(self):
        stale_v13_row = {
            **exact_preflight_row(),
            "migration_count": 127,
            "migration_head": "20260830065627",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
            "manifest_version": "release-db-attestation-v32",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(stale_v13_row)

    def test_v14_v33_response_cannot_satisfy_candidate_readiness(self):
        stale_v14_row = {
            **exact_preflight_row(),
            "migration_count": 128,
            "migration_head": "20260830082610",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
            "manifest_version": "release-db-attestation-v33",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(stale_v14_row)

    def test_v15_v34_response_cannot_satisfy_candidate_readiness(self):
        stale_v15_row = {
            **exact_preflight_row(),
            "migration_count": 129,
            "migration_head": "20260830151714",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
            "manifest_version": "release-db-attestation-v34",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(stale_v15_row)

    def test_v16_v35_response_cannot_satisfy_candidate_readiness(self):
        stale = {
            **exact_preflight_row(),
            "migration_count": 130,
            "migration_head": "20260831022021",
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
            "manifest_version": "release-db-attestation-v35",
        }
        with self.assertRaises(ReleaseSchemaNotReadyError):
            validate_release_schema_preflight(stale)

    def test_v17_requires_exact_v36_pending_list_and_empty_failures(self):
        wrong_pending = {
            **exact_preflight_row(),
            "pending_versions": [
                *EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
                "20260830080000",
            ],
        }
        missing_v35 = {
            **exact_preflight_row(),
            "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
        }
        failed_security = {
            **exact_preflight_row(),
            "security_failures": ["function:v35_acl"],
        }
        for row in (wrong_pending, missing_v35, failed_security):
            with self.subTest(row=row), self.assertRaises(
                ReleaseSchemaNotReadyError
            ):
                validate_release_schema_preflight(row)

    def test_every_preflight_mismatch_fails_closed(self):
        mismatches = [
            None,
            {**exact_preflight_row(), "ready": False},
            {**exact_preflight_row(), "migration_count": 84},
            {**exact_preflight_row(), "migration_count": 98},
            {**exact_preflight_row(), "migration_count": 99},
            {**exact_preflight_row(), "migration_count": 101},
            {**exact_preflight_row(), "migration_count": 102},
            {**exact_preflight_row(), "migration_count": 103},
            {**exact_preflight_row(), "migration_count": 104},
            {**exact_preflight_row(), "migration_count": 105},
            {**exact_preflight_row(), "migration_count": 109},
            {**exact_preflight_row(), "migration_count": 110},
            {**exact_preflight_row(), "migration_count": 115},
            {**exact_preflight_row(), "migration_count": 116},
            {**exact_preflight_row(), "migration_count": 117},
            {**exact_preflight_row(), "migration_count": 119},
            {**exact_preflight_row(), "migration_count": 124},
            {**exact_preflight_row(), "migration_count": 126},
            {**exact_preflight_row(), "migration_count": 128},
            {**exact_preflight_row(), "migration_count": 129},
            {**exact_preflight_row(), "migration_head": "20260801080000"},
            {**exact_preflight_row(), "migration_head": "20260801105313"},
            {**exact_preflight_row(), "migration_head": "20260801112153"},
            {**exact_preflight_row(), "migration_head": "20260801115044"},
            {**exact_preflight_row(), "migration_head": "20260801123112"},
            {**exact_preflight_row(), "migration_head": "20260814043325"},
            {**exact_preflight_row(), "migration_head": "20260814103046"},
            {**exact_preflight_row(), "migration_head": "20260814105424"},
            {**exact_preflight_row(), "migration_head": "20260814114500"},
            {**exact_preflight_row(), "migration_head": "20260814152000"},
            {**exact_preflight_row(), "migration_head": "20260814213000"},
            {**exact_preflight_row(), "migration_head": "20260815220402"},
            {**exact_preflight_row(), "migration_head": "20260822193000"},
            {**exact_preflight_row(), "migration_head": "20260823193155"},
            {**exact_preflight_row(), "migration_head": "20260824190500"},
            {**exact_preflight_row(), "migration_head": "20260825043911"},
            {**exact_preflight_row(), "migration_head": "20260826185651"},
            {**exact_preflight_row(), "migration_head": "20260830082610"},
            {**exact_preflight_row(), "migration_head": "20260830151714"},
            {**exact_preflight_row(), "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1]},
            {**exact_preflight_row(), "security_failures": ["table:missing"]},
            {**exact_preflight_row(), "manifest_version": "stale-manifest"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v3"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v4"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v5"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v6"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v7"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v8"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v9"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v10"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v11"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v12"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v16"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v17"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v22"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v23"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v24"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v25"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v31"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v33"},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v34"},
        ]
        for row in mismatches:
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
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v17", {})])

    def test_hosted_check_does_not_fallback_on_v17_provider_failure(self):
        calls = []

        def rpc(name, params):
            calls.append((name, params))
            error = PostgrestAPIError({
                "code": "PGRST000",
                "message": "Database unavailable",
            })
            return SimpleNamespace(execute=lambda: (_ for _ in ()).throw(error))

        client = SimpleNamespace(rpc=rpc)
        with patch(
            "app.services.release_schema_readiness.get_supabase_client",
            return_value=client,
        ), self.assertRaises(PostgrestAPIError):
            assert_hosted_release_schema_ready()
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v17", {})])

    def test_hosted_check_fails_closed_when_v17_is_missing(self):
        calls = []

        def rpc(name, params):
            calls.append((name, params))
            error = PostgrestAPIError({
                "code": "PGRST202",
                "message": (
                    "Could not find the function "
                    "public.koaryu_release_schema_preflight_v17 in the schema cache"
                ),
            })
            return SimpleNamespace(execute=lambda: (_ for _ in ()).throw(error))

        client = SimpleNamespace(rpc=rpc)
        with patch(
            "app.services.release_schema_readiness.get_supabase_client",
            return_value=client,
        ), self.assertRaisesRegex(RuntimeError, "Apply the database migrations"):
            assert_hosted_release_schema_ready()
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v17", {})])

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
                    isinstance(result, RuntimeError)
                    and str(result) == "database unavailable"
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
            loop.set_exception_handler(
                lambda _loop, context: loop_errors.append(context)
            )

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


if __name__ == "__main__":
    unittest.main()
