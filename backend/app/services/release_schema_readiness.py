from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from postgrest.exceptions import APIError as PostgrestAPIError

from app.db.supabase import close_supabase_client, create_supabase_client
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row
from app.services.generated_release_readiness import (
    EXPECTED_RELEASE_MANIFEST_VERSION,
    EXPECTED_RELEASE_MIGRATION_COUNT,
    EXPECTED_RELEASE_MIGRATION_HEAD,
    EXPECTED_RELEASE_PENDING_VERSIONS,
    RELEASE_PREFLIGHT_RPC,
)


HOSTED_READINESS_SUCCESS_TTL_SECONDS = 30.0
# Render probes every 5 seconds, gives each probe 5 seconds, and stops routing
# to an instance after about 15 seconds of failures. A readiness answer must
# therefore arrive inside one probe, and a lock held for longer than 15 seconds
# by a guarded migration must not read as "not ready" on an instance that was
# just proven ready. The grace is measured from the last successful preflight,
# not from the first failure, so it covers about five success TTLs and the
# two-minute lock window seen during the V61 rollout. Beyond it the instance
# fails closed again.
HOSTED_READINESS_TRANSIENT_GRACE_SECONDS = 180.0
HOSTED_READINESS_PROBE_BUDGET_SECONDS = 4.0

logger = logging.getLogger(__name__)

# Only failures that mean "no answer was obtained" qualify for the grace:
# statement or lock timeouts, PostgREST connection/pool availability, and a
# gateway that returned a non-JSON 502/503/504. Every other error, including a
# missing preflight RPC and any returned mismatch, is a definite answer.
_TRANSIENT_POSTGREST_CODES = frozenset(
    {
        "57014",  # query_canceled: statement_timeout
        "55P03",  # lock_not_available: lock_timeout
        "PGRST000",
        "PGRST001",
        "PGRST002",
        "PGRST003",
        "502",
        "503",
        "504",
    }
)
_TRANSIENT_TRANSPORT_ERRORS = (
    TimeoutError,
    httpx.TimeoutException,
    httpx.NetworkError,
    httpx.RemoteProtocolError,
)

# Kept as a patchable factory symbol for existing readiness tests. It is an
# isolated factory alias, not the removed process-global accessor.
get_supabase_client = create_supabase_client


class ReleaseSchemaNotReadyError(RuntimeError):
    pass


def _describe_pending_drift(actual: Any, expected_versions: list[str]) -> str:
    """Summarise pending-version drift without dumping both full lists."""
    if not isinstance(actual, list):
        return f"expected {len(expected_versions)} versions, got {actual!r}"
    expected = set(expected_versions)
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
    mismatches: list[str] = []
    if row.get("ready") is not True:
        mismatches.append(f"ready={row.get('ready')!r} (expected True)")
    for field, expected in (
        ("migration_count", migration_count),
        ("migration_head", migration_head),
        ("manifest_version", manifest_version),
        ("security_failures", []),
    ):
        actual = row.get(field)
        if actual != expected:
            mismatches.append(f"{field}={actual!r} (expected {expected!r})")
    if row.get("pending_versions") != pending_versions:
        mismatches.append(
            "pending_versions: "
            + _describe_pending_drift(row.get("pending_versions"), pending_versions)
        )
    if mismatches:
        raise ReleaseSchemaNotReadyError(
            "Release schema preflight did not match exact head. " + "; ".join(mismatches)
        )


def validate_release_schema_preflight(row: Any) -> None:
    _validate_preflight(
        row,
        migration_count=EXPECTED_RELEASE_MIGRATION_COUNT,
        migration_head=EXPECTED_RELEASE_MIGRATION_HEAD,
        pending_versions=EXPECTED_RELEASE_PENDING_VERSIONS,
        manifest_version=EXPECTED_RELEASE_MANIFEST_VERSION,
    )


def assert_hosted_release_schema_ready() -> None:
    client = get_supabase_client()
    try:
        result = execute_required_rpc(
            client,
            RELEASE_PREFLIGHT_RPC,
            {},
        )
        validate_release_schema_preflight(first_rpc_row(result))
    finally:
        if hasattr(getattr(client, "auth", None), "close"):
            close_supabase_client(client)


def is_transient_readiness_error(exc: BaseException) -> bool:
    """Return True only when the preflight produced no answer at all."""
    if isinstance(exc, PostgrestAPIError):
        return str(getattr(exc, "code", None)) in _TRANSIENT_POSTGREST_CODES
    return isinstance(exc, _TRANSIENT_TRANSPORT_ERRORS)


def _describe_transient_error(exc: BaseException) -> str:
    if isinstance(exc, PostgrestAPIError):
        return f"{type(exc).__name__} {getattr(exc, 'code', None)}"
    return type(exc).__name__


async def _run_check_in_thread(check: Callable[[], None]) -> None:
    await asyncio.to_thread(check)


class HostedReleaseReadinessCache:
    """Coalesce hosted schema checks and briefly reuse successful results.

    Failures are never cached. Waiters suspend on the event-loop lock before
    the blocking check receives a worker thread, so health probes cannot occupy
    the shared request thread pool while another preflight is in flight.

    Each waiter gives up after the probe budget while the shared check keeps
    running, so its eventual answer is still recorded. When no answer could be
    obtained (see ``is_transient_readiness_error``) and the last success is
    younger than the transient grace, the waiter reports ready and logs the
    degraded state. Any definite answer that is not a success clears the last
    success, so a later timeout cannot mask it. A process that has never
    succeeded has no grace.
    """

    def __init__(
        self,
        *,
        check=assert_hosted_release_schema_ready,
        monotonic=time.monotonic,
        run_check: Callable[[Callable[[], None]], Awaitable[None]] = (_run_check_in_thread),
        success_ttl_seconds: float = HOSTED_READINESS_SUCCESS_TTL_SECONDS,
        transient_grace_seconds: float = HOSTED_READINESS_TRANSIENT_GRACE_SECONDS,
        probe_budget_seconds: float = HOSTED_READINESS_PROBE_BUDGET_SECONDS,
    ) -> None:
        if success_ttl_seconds <= 0:
            raise ValueError("success_ttl_seconds must be positive")
        if transient_grace_seconds < success_ttl_seconds:
            raise ValueError("transient_grace_seconds must be at least success_ttl_seconds")
        if probe_budget_seconds <= 0:
            raise ValueError("probe_budget_seconds must be positive")
        self._check = check
        self._monotonic = monotonic
        self._run_check = run_check
        self._success_ttl_seconds = success_ttl_seconds
        self._transient_grace_seconds = transient_grace_seconds
        self._probe_budget_seconds = probe_budget_seconds
        self._last_success_monotonic: float | None = None
        self._inflight_lock = asyncio.Lock()
        self._inflight: asyncio.Task[None] | None = None

    def _last_success_age(self) -> float | None:
        last_success = self._last_success_monotonic
        if last_success is None:
            return None
        age = self._monotonic() - last_success
        return age if age >= 0 else None

    def _success_is_fresh(self) -> bool:
        age = self._last_success_age()
        return age is not None and age < self._success_ttl_seconds

    async def _check_and_record(self) -> None:
        # The shared task, not its waiters, records the outcome so an answer
        # that arrives after every waiter's budget still takes effect.
        try:
            await self._run_check(self._check)
        except BaseException as exc:
            if not is_transient_readiness_error(exc):
                self._last_success_monotonic = None
            raise
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
                inflight = asyncio.create_task(self._check_and_record())
                self._inflight = inflight
                inflight.add_done_callback(self._clear_inflight)

        # One cancelled or timed-out HTTP request must not cancel the shared
        # provider check underneath other readiness waiters.
        try:
            await asyncio.wait_for(asyncio.shield(inflight), timeout=self._probe_budget_seconds)
        except Exception as exc:
            if not is_transient_readiness_error(exc):
                raise
            age = self._last_success_age()
            if age is None or age >= self._transient_grace_seconds:
                raise
            logger.warning(
                "Readiness preflight gave no answer (%s); serving ready within "
                "transient grace, last success %.1fs ago of %.0fs allowed",
                _describe_transient_error(exc),
                age,
                self._transient_grace_seconds,
            )


_HOSTED_READINESS_CACHE = HostedReleaseReadinessCache()


async def assert_hosted_release_schema_ready_cached() -> None:
    await _HOSTED_READINESS_CACHE.assert_ready()
