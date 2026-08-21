"""Bounded, single-flight storage for dashboard fact payloads."""

from __future__ import annotations

import asyncio
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import date
from typing import Awaitable, Callable, Generic, Literal, TypeVar


DashboardSummaryVisibility = Literal["billing_visible", "billing_hidden"]
DashboardInvalidationDomain = Literal["dashboard", "roster", "eligibility"]
DASHBOARD_INVALIDATION_DOMAINS = frozenset({"dashboard", "roster", "eligibility"})

FactT = TypeVar("FactT")


@dataclass(frozen=True, slots=True)
class DashboardSummaryCacheKey:
    """The complete non-identity key for one dashboard fact payload."""

    studio_id: str
    visibility: DashboardSummaryVisibility
    timezone: str
    local_date: date
    formula_version: str


@dataclass(frozen=True, slots=True)
class _CacheEntry(Generic[FactT]):
    value: FactT
    expires_at: float
    generation: int


@dataclass(slots=True)
class _Flight(Generic[FactT]):
    future: Future[FactT]
    generation: int


class DashboardSummaryFactInvalidated(RuntimeError):
    """The source changed while a dashboard fact was being loaded."""


class DashboardSummaryFactCache(Generic[FactT]):
    """A process-local TTL cache with bounded single-flight loading.

    The cache value contains facts only. Identity, authorization, and response
    metadata are assembled by the caller after a value is obtained.
    """

    def __init__(
        self,
        *,
        ttl_seconds: float = 15.0,
        max_entries: int = 128,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds <= 0 or ttl_seconds > 15.0:
            raise ValueError("ttl_seconds must be greater than zero and at most 15 seconds")
        if max_entries <= 0:
            raise ValueError("max_entries must be positive")
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._clock = clock
        self._lock = threading.RLock()
        self._entries: OrderedDict[DashboardSummaryCacheKey, _CacheEntry[FactT]] = OrderedDict()
        self._inflight: dict[DashboardSummaryCacheKey, _Flight[FactT]] = {}
        self._generations: dict[str, int] = {}

    async def get_or_load(
        self,
        key: DashboardSummaryCacheKey,
        loader: Callable[[], Awaitable[FactT]],
    ) -> FactT:
        """Return a fresh fact, sharing one bounded loader per exact key.

        A generation change is retried once. That is enough to let all
        followers of an invalidated flight converge on the new value while
        preventing an invalidation storm from becoming a retry loop.
        """

        for attempt in range(2):
            flight, leader, cached = self._lookup_or_start(key)
            if cached is not None:
                return cached
            if leader:
                task = asyncio.create_task(self._run_loader(key, flight, loader))
                task.add_done_callback(self._consume_task_result)
            try:
                # A disconnected follower must not cancel the shared flight.
                return await asyncio.shield(asyncio.wrap_future(flight.future))
            except DashboardSummaryFactInvalidated:
                if attempt == 1:
                    raise

        raise AssertionError("dashboard fact cache retry bound was not enforced")

    def invalidate(
        self,
        studio_id: str,
        *,
        ladder_id: str | None = None,
        domain: DashboardInvalidationDomain,
    ) -> None:
        """Invalidate dashboard facts for a studio through a typed seam.

        ``ladder_id`` is accepted now so eligibility callers can share the
        seam later. Dashboard facts are currently studio-scoped, so a
        dashboard-domain invalidation evicts every visibility/date variant.
        Other vocabulary members are intentionally reserved for their future
        owners and do not mutate this dashboard cache.
        """

        normalized_studio_id = studio_id.strip()
        if not normalized_studio_id:
            raise ValueError("studio_id is required")
        if domain not in DASHBOARD_INVALIDATION_DOMAINS:
            raise ValueError(f"unsupported dashboard invalidation domain: {domain}")
        if ladder_id is not None and not ladder_id.strip():
            raise ValueError("ladder_id must be non-empty when supplied")
        if domain != "dashboard":
            return

        with self._lock:
            self._generations[normalized_studio_id] = (
                self._generations.get(normalized_studio_id, 0) + 1
            )
            for key in tuple(self._entries):
                if key.studio_id == normalized_studio_id:
                    del self._entries[key]

    def generation(self, studio_id: str) -> int:
        """Expose the current epoch for focused invalidation tests and owners."""

        with self._lock:
            return self._generations.get(studio_id, 0)

    def _lookup_or_start(
        self,
        key: DashboardSummaryCacheKey,
    ) -> tuple[_Flight[FactT], bool, FactT | None]:
        now = self._clock()
        with self._lock:
            self._remove_expired(now)
            generation = self._generations.get(key.studio_id, 0)
            entry = self._entries.get(key)
            if entry is not None:
                if entry.generation == generation and now < entry.expires_at:
                    self._entries.move_to_end(key)
                    return _Flight(Future(), generation), False, entry.value
                del self._entries[key]

            existing = self._inflight.get(key)
            if existing is not None:
                return existing, False, None
            flight = _Flight(Future(), generation)
            self._inflight[key] = flight
            return flight, True, None

    async def _run_loader(
        self,
        key: DashboardSummaryCacheKey,
        flight: _Flight[FactT],
        loader: Callable[[], Awaitable[FactT]],
    ) -> None:
        try:
            value = await loader()
            with self._lock:
                current_generation = self._generations.get(key.studio_id, 0)
                if current_generation != flight.generation:
                    raise DashboardSummaryFactInvalidated(
                        f"dashboard fact invalidated during load for studio {key.studio_id}"
                    )
                self._remove_expired(self._clock())
                while len(self._entries) >= self._max_entries:
                    self._entries.popitem(last=False)
                self._entries[key] = _CacheEntry(
                    value=value,
                    expires_at=self._clock() + self._ttl_seconds,
                    generation=flight.generation,
                )
            flight.future.set_result(value)
        except BaseException as exc:
            # Translate cancellation into an ordinary exception for followers;
            # a waiter cancellation must never cancel the shared Future.
            if isinstance(exc, asyncio.CancelledError):
                exc = RuntimeError("dashboard fact loader was cancelled")
            flight.future.set_exception(exc)
            # concurrent.futures.Future has no warning hook, but observing the
            # exception here makes the ownership explicit for diagnostics.
            flight.future.exception()
        finally:
            with self._lock:
                if self._inflight.get(key) is flight:
                    del self._inflight[key]

    @staticmethod
    def _consume_task_result(task: asyncio.Task[None]) -> None:
        try:
            task.result()
        except BaseException:
            # _run_loader publishes every failure to the shared Future. This
            # callback prevents a detached task from retaining an exception.
            pass

    def _remove_expired(self, now: float) -> None:
        for key, entry in tuple(self._entries.items()):
            if now >= entry.expires_at:
                del self._entries[key]
