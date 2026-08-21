from __future__ import annotations

from typing import Any

from app.db.supabase import close_supabase_client, create_supabase_client
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


EXPECTED_RELEASE_MIGRATION_COUNT = 112
EXPECTED_RELEASE_MIGRATION_HEAD = "20260820170000"
EXPECTED_RELEASE_MANIFEST_VERSION = "release-db-attestation-v19"
EXPECTED_RELEASE_PENDING_VERSIONS = [
    "20260727100000",
    "20260727110000",
    "20260801050957",
    "20260801060000",
    "20260801070000",
    "20260801080000",
    "20260801090000",
    "20260801091000",
    "20260801092000",
    "20260801093000",
    "20260801094000",
    "20260801105313",
    "20260801112153",
    "20260801115044",
    "20260801123112",
    "20260801131844",
    "20260814043325",
    "20260814103046",
    "20260814105424",
    "20260814114500",
    "20260814152000",
    "20260814170000",
    "20260814183000",
    "20260814200000",
    "20260814213000",
    "20260815220402",
    "20260816012723",
    "20260820170000",
]
LEGACY_RELEASE_MIGRATION_COUNT = 111
LEGACY_RELEASE_MIGRATION_HEAD = "20260816012723"
LEGACY_RELEASE_MANIFEST_VERSION = "release-db-attestation-v18"
LEGACY_RELEASE_PENDING_VERSIONS = EXPECTED_RELEASE_PENDING_VERSIONS[:-1]

# Kept as a patchable factory symbol for existing readiness tests. It is an
# isolated factory alias, not the removed process-global accessor.
get_supabase_client = create_supabase_client


class ReleaseSchemaNotReadyError(RuntimeError):
    pass


def _validate_preflight(
    row: Any,
    *,
    migration_count: int,
    migration_head: str,
    pending_versions: list[str],
    manifest_version: str,
) -> None:
    if not isinstance(row, dict):
        raise ReleaseSchemaNotReadyError("Release schema preflight returned no result.")
    if (
        row.get("ready") is not True
        or row.get("migration_count") != migration_count
        or row.get("migration_head") != migration_head
        or row.get("pending_versions") != pending_versions
        or row.get("security_failures") != []
        or row.get("manifest_version") != manifest_version
    ):
        raise ReleaseSchemaNotReadyError("Release schema preflight did not match exact head.")


def validate_release_schema_preflight(row: Any) -> None:
    _validate_preflight(
        row,
        migration_count=EXPECTED_RELEASE_MIGRATION_COUNT,
        migration_head=EXPECTED_RELEASE_MIGRATION_HEAD,
        pending_versions=EXPECTED_RELEASE_PENDING_VERSIONS,
        manifest_version=EXPECTED_RELEASE_MANIFEST_VERSION,
    )


def validate_legacy_release_schema_preflight(row: Any) -> None:
    _validate_preflight(
        row,
        migration_count=LEGACY_RELEASE_MIGRATION_COUNT,
        migration_head=LEGACY_RELEASE_MIGRATION_HEAD,
        pending_versions=LEGACY_RELEASE_PENDING_VERSIONS,
        manifest_version=LEGACY_RELEASE_MANIFEST_VERSION,
    )


def assert_hosted_release_schema_ready() -> None:
    client = get_supabase_client()
    try:
        try:
            result = execute_required_rpc(
                client,
                "koaryu_release_schema_preflight_v4",
                {},
            )
        except Exception:
            # Database-first and backend-first cutovers are both supported.
            # On the predecessor schema v4 is absent, so the candidate may use
            # the exact v18 result. Once v4 exists, the v3 compatibility RPC
            # itself delegates to v4 and fails closed if v19 is not healthy.
            result = execute_required_rpc(
                client,
                "koaryu_release_schema_preflight_v3",
                {},
            )
            validate_legacy_release_schema_preflight(first_rpc_row(result))
        else:
            validate_release_schema_preflight(first_rpc_row(result))
    finally:
        if hasattr(getattr(client, "auth", None), "close"):
            close_supabase_client(client)
