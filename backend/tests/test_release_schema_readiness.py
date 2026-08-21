import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services.release_schema_readiness import (
    EXPECTED_RELEASE_MIGRATION_COUNT,
    EXPECTED_RELEASE_MIGRATION_HEAD,
    EXPECTED_RELEASE_MANIFEST_VERSION,
    EXPECTED_RELEASE_PENDING_VERSIONS,
    LEGACY_RELEASE_MANIFEST_VERSION,
    LEGACY_RELEASE_MIGRATION_COUNT,
    LEGACY_RELEASE_MIGRATION_HEAD,
    LEGACY_RELEASE_PENDING_VERSIONS,
    ReleaseSchemaNotReadyError,
    assert_hosted_release_schema_ready,
    validate_legacy_release_schema_preflight,
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


def legacy_preflight_row():
    return {
        "ready": True,
        "migration_count": LEGACY_RELEASE_MIGRATION_COUNT,
        "migration_head": LEGACY_RELEASE_MIGRATION_HEAD,
        "pending_versions": LEGACY_RELEASE_PENDING_VERSIONS,
        "security_failures": [],
        "manifest_version": LEGACY_RELEASE_MANIFEST_VERSION,
    }


class ReleaseSchemaReadinessTest(unittest.TestCase):
    def test_exact_preflight_is_ready(self):
        validate_release_schema_preflight(exact_preflight_row())
        validate_legacy_release_schema_preflight(legacy_preflight_row())

    def test_every_v19_preflight_mismatch_fails_closed(self):
        mismatches = [
            None,
            {**exact_preflight_row(), "ready": False},
            {**exact_preflight_row(), "migration_count": 111},
            {**exact_preflight_row(), "migration_head": "20260816012723"},
            {
                **exact_preflight_row(),
                "pending_versions": EXPECTED_RELEASE_PENDING_VERSIONS[:-1],
            },
            {**exact_preflight_row(), "security_failures": ["table:missing"]},
            {**exact_preflight_row(), "manifest_version": "release-db-attestation-v18"},
        ]
        for row in mismatches:
            with self.subTest(row=row), self.assertRaises(ReleaseSchemaNotReadyError):
                validate_release_schema_preflight(row)

    def test_hosted_check_prefers_v4(self):
        response = SimpleNamespace(data=[exact_preflight_row()])
        calls = []

        class Client:
            def rpc(self, name, params):
                calls.append((name, params))
                return SimpleNamespace(execute=lambda: response)

        with patch(
            "app.services.release_schema_readiness.get_supabase_client",
            return_value=Client(),
        ):
            assert_hosted_release_schema_ready()

        self.assertEqual(calls, [("koaryu_release_schema_preflight_v4", {})])

    def test_hosted_check_accepts_exact_v18_only_when_v4_is_absent(self):
        legacy_response = SimpleNamespace(data=[legacy_preflight_row()])
        calls = []

        class Client:
            def rpc(self, name, params):
                calls.append((name, params))
                if name == "koaryu_release_schema_preflight_v4":
                    return SimpleNamespace(
                        execute=lambda: (_ for _ in ()).throw(
                            RuntimeError("function does not exist")
                        )
                    )
                return SimpleNamespace(execute=lambda: legacy_response)

        with patch(
            "app.services.release_schema_readiness.get_supabase_client",
            return_value=Client(),
        ):
            assert_hosted_release_schema_ready()

        self.assertEqual(calls, [
            ("koaryu_release_schema_preflight_v4", {}),
            ("koaryu_release_schema_preflight_v3", {}),
        ])

    def test_fallback_still_fails_closed_on_nonexact_v18(self):
        bad = {**legacy_preflight_row(), "ready": False}

        class Client:
            def rpc(self, name, _params):
                if name == "koaryu_release_schema_preflight_v4":
                    return SimpleNamespace(
                        execute=lambda: (_ for _ in ()).throw(RuntimeError("missing"))
                    )
                return SimpleNamespace(
                    execute=lambda: SimpleNamespace(data=[bad])
                )

        with (
            patch(
                "app.services.release_schema_readiness.get_supabase_client",
                return_value=Client(),
            ),
            self.assertRaises(ReleaseSchemaNotReadyError),
        ):
            assert_hosted_release_schema_ready()


if __name__ == "__main__":
    unittest.main()
