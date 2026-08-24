import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

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
    def test_exact_preflight_is_ready(self):
        validate_release_schema_preflight(exact_preflight_row())

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
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v4", {})])

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


if __name__ == "__main__":
    unittest.main()
