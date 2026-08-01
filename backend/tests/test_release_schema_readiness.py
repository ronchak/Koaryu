import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.release_schema_readiness import (
    EXPECTED_RELEASE_MIGRATION_COUNT,
    EXPECTED_RELEASE_MIGRATION_HEAD,
    EXPECTED_RELEASE_MANIFEST_VERSION,
    EXPECTED_RELEASE_PENDING_VERSIONS,
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
            {**exact_preflight_row(), "migration_head": "20260801080000"},
            {**exact_preflight_row(), "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1]},
            {**exact_preflight_row(), "security_failures": ["table:missing"]},
            {**exact_preflight_row(), "manifest_version": "stale-manifest"},
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
        self.assertEqual(calls, [("koaryu_release_schema_preflight_v2", {})])


if __name__ == "__main__":
    unittest.main()
