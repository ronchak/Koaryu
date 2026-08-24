from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.core.config import get_settings
from app.db.supabase import close_supabase_client, create_supabase_client
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row


EXPECTED_RELEASE_MIGRATION_COUNT = 116
EXPECTED_RELEASE_MIGRATION_HEAD = "20260823193155"
EXPECTED_RELEASE_MANIFEST_VERSION = "release-db-attestation-v23"
PRODUCTION_RESTORED_V22_MIGRATION_COUNT = 115
PRODUCTION_RESTORED_V22_MIGRATION_HEAD = "20260822193000"
PRODUCTION_RESTORED_V22_MANIFEST_VERSION = "release-db-attestation-v22"
# This is the verified production V22 sequence, deliberately frozen apart from
# the current release list so a later migration cannot redefine the allowance.
PRODUCTION_RESTORED_V22_PENDING_VERSIONS = (
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
)
EXPECTED_RELEASE_PENDING_VERSIONS = [
    *PRODUCTION_RESTORED_V22_PENDING_VERSIONS,
    "20260823193155",
]
HOSTED_READINESS_SUCCESS_TTL_SECONDS = 30.0

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


def _matches_production_restored_v22(row: Any) -> bool:
    return isinstance(row, dict) and row == {
        "ready": True,
        "migration_count": PRODUCTION_RESTORED_V22_MIGRATION_COUNT,
        "migration_head": PRODUCTION_RESTORED_V22_MIGRATION_HEAD,
        "pending_versions": list(PRODUCTION_RESTORED_V22_PENDING_VERSIONS),
        "security_failures": [],
        "manifest_version": PRODUCTION_RESTORED_V22_MANIFEST_VERSION,
    }


def validate_release_schema_preflight(
    row: Any,
    *,
    allow_production_restored_v22: bool = False,
) -> None:
    if not isinstance(row, dict):
        raise ReleaseSchemaNotReadyError("Release schema preflight returned no result.")
    if allow_production_restored_v22 and _matches_production_restored_v22(row):
        return
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
    environment = get_settings().ENVIRONMENT.strip().lower()
    client = get_supabase_client()
    try:
        result = execute_required_rpc(
            client,
            "koaryu_release_schema_preflight_v4",
            {},
        )
        validate_release_schema_preflight(
            first_rpc_row(result),
            # Temporary restored-production compatibility. Remove this exact
            # V22 allowance after production reaches the reviewed converged
            # migration head and its hosted readback is recorded.
            allow_production_restored_v22=environment == "production",
        )
    finally:
        if hasattr(getattr(client, "auth", None), "close"):
            close_supabase_client(client)


async def _run_check_in_thread(check: Callable[[], None]) -> None:
    await asyncio.to_thread(check)


class HostedReleaseReadinessCache:
    """Coalesce hosted schema checks and briefly reuse successful results.

    Failures are never cached. Waiters suspend on the event-loop lock before
    the blocking check receives a worker thread, so health probes cannot occupy
    the shared request thread pool while another preflight is in flight.
    """

    def __init__(
        self,
        *,
        check=assert_hosted_release_schema_ready,
        monotonic=time.monotonic,
        run_check: Callable[[Callable[[], None]], Awaitable[None]] = (
            _run_check_in_thread
        ),
        success_ttl_seconds: float = HOSTED_READINESS_SUCCESS_TTL_SECONDS,
    ) -> None:
        if success_ttl_seconds <= 0:
            raise ValueError("success_ttl_seconds must be positive")
        self._check = check
        self._monotonic = monotonic
        self._run_check = run_check
        self._success_ttl_seconds = success_ttl_seconds
        self._last_success_monotonic: float | None = None
        self._inflight_lock = asyncio.Lock()
        self._inflight: asyncio.Task[None] | None = None

    def _success_is_fresh(self) -> bool:
        now = self._monotonic()
        last_success = self._last_success_monotonic
        return (
            last_success is not None
            and 0 <= now - last_success < self._success_ttl_seconds
        )

    async def _check_and_cache_success(self) -> None:
        await self._run_check(self._check)
        self._last_success_monotonic = self._monotonic()

    def _clear_inflight(self, completed: asyncio.Task[None]) -> None:
        # A cancelled HTTP waiter is shielded from this task. Retrieve a later
        # provider exception here so an all-waiters-cancelled outage does not
        # produce an unhandled-task error; active waiters still receive the
        # same exception when they await the completed task.
        if not completed.cancelled():
            completed.exception()
        if self._inflight is completed:
            self._inflight = None

    async def assert_ready(self) -> None:
        if self._success_is_fresh():
            return
        async with self._inflight_lock:
            if self._success_is_fresh():
                return
            inflight = self._inflight
            if inflight is None:
                inflight = asyncio.create_task(self._check_and_cache_success())
                self._inflight = inflight
                inflight.add_done_callback(self._clear_inflight)

        # One cancelled HTTP request must not cancel the shared provider check
        # underneath other readiness waiters.
        await asyncio.shield(inflight)


_HOSTED_READINESS_CACHE = HostedReleaseReadinessCache()


async def assert_hosted_release_schema_ready_cached() -> None:
    await _HOSTED_READINESS_CACHE.assert_ready()
