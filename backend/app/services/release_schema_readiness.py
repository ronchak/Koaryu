from __future__ import annotations

from typing import Any

from app.db.supabase import close_supabase_client, create_supabase_client
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


EXPECTED_RELEASE_MIGRATION_COUNT = 115
EXPECTED_RELEASE_MIGRATION_HEAD = "20260822193000"
EXPECTED_RELEASE_MANIFEST_VERSION = "release-db-attestation-v22"
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
    "20260820012533",
    "20260820025759",
    "20260820060216",
    "20260822193000",
]

# Kept as a patchable factory symbol for existing readiness tests. It is an
# isolated factory alias, not the removed process-global accessor.
get_supabase_client = create_supabase_client


class ReleaseSchemaNotReadyError(RuntimeError):
    pass


def _describe_pending_drift(actual: Any) -> str:
    """Summarise pending-version drift without dumping both full lists."""
    if not isinstance(actual, list):
        return f"expected {len(EXPECTED_RELEASE_PENDING_VERSIONS)} versions, got {actual!r}"
    expected = set(EXPECTED_RELEASE_PENDING_VERSIONS)
    seen = set(actual)
    missing = sorted(expected - seen)
    unexpected = sorted(seen - expected)
    if not missing and not unexpected:
        return f"same {len(actual)} versions in a different order"
    parts = []
    if missing:
        parts.append(f"missing {missing}")
    if unexpected:
        parts.append(f"unexpected {unexpected}")
    return ", ".join(parts)


def validate_release_schema_preflight(row: Any) -> None:
    if not isinstance(row, dict):
        raise ReleaseSchemaNotReadyError("Release schema preflight returned no result.")
    mismatches: list[str] = []
    if row.get("ready") is not True:
        mismatches.append(f"ready={row.get('ready')!r} (expected True)")
    for field, expected in (
        ("migration_count", EXPECTED_RELEASE_MIGRATION_COUNT),
        ("migration_head", EXPECTED_RELEASE_MIGRATION_HEAD),
        ("manifest_version", EXPECTED_RELEASE_MANIFEST_VERSION),
        ("security_failures", []),
    ):
        actual = row.get(field)
        if actual != expected:
            mismatches.append(f"{field}={actual!r} (expected {expected!r})")
    if row.get("pending_versions") != EXPECTED_RELEASE_PENDING_VERSIONS:
        mismatches.append(
            f"pending_versions: {_describe_pending_drift(row.get('pending_versions'))}"
        )
    if mismatches:
        raise ReleaseSchemaNotReadyError(
            "Release schema preflight did not match exact head. "
            + "; ".join(mismatches)
        )


def assert_hosted_release_schema_ready() -> None:
    client = get_supabase_client()
    try:
        result = execute_required_rpc(
            client,
            "koaryu_release_schema_preflight_v4",
            {},
        )
        validate_release_schema_preflight(first_rpc_row(result))
    finally:
        if hasattr(getattr(client, "auth", None), "close"):
            close_supabase_client(client)
