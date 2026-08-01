import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.release_schema_readiness import (
    EXPECTED_RELEASE_MIGRATION_COUNT,
    EXPECTED_RELEASE_MIGRATION_HEAD,
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
        ]
        for row in mismatches:
            with self.subTest(row=row), self.assertRaises(ReleaseSchemaNotReadyError):
                validate_release_schema_preflight(row)

    def test_hosted_check_uses_required_rpc(self):
        response = SimpleNamespace(data=[exact_preflight_row()])
        rpc_result = SimpleNamespace(execute=lambda: response)
        client = SimpleNamespace(rpc=lambda name, params: rpc_result)
        with patch(
            "app.services.release_schema_readiness.get_supabase_client",
            return_value=client,
        ):
            assert_hosted_release_schema_ready()


if __name__ == "__main__":
    unittest.main()
