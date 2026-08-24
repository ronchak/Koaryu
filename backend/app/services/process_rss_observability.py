"""Private, bounded current-RSS observation for the running backend process."""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Callable


# Uvicorn 0.30 configures ``uvicorn.error`` at INFO with its default handler;
# using this child hierarchy keeps normal samples visible without adding app
# handlers or changing global logging configuration.
logger = logging.getLogger("uvicorn.error.process_rss_observability")

EVENT_NAME = "process_rss_observation"
SAMPLE_INTERVAL_SECONDS = 300.0
ALERT_COOLDOWN_SECONDS = 1800.0
WARNING_THRESHOLD_BYTES = 400 * 1024 * 1024
CRITICAL_THRESHOLD_BYTES = 440 * 1024 * 1024
MAX_RSS_BYTES = (1 << 63) - 1

_DECIMAL_INTEGER_PATTERN = re.compile(r"^[0-9]+$")
_RENDER_INSTANCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_RENDER_INSTANCE_SECRET_PATTERN = re.compile(
    r"(?i)(?:^|[_\-.])(?:sk|rk|pk|whsec|bearer|secret|token|password|api_key)"
)
_RENDER_GIT_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def _read_proc_statm() -> str:
    with open("/proc/self/statm", "r", encoding="ascii") as statm:
        return statm.read(256)


def _read_page_size() -> int:
    return os.sysconf("SC_PAGE_SIZE")


def _read_environment(name: str) -> str | None:
    return os.environ.get(name)


def _utc_timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_rss_bytes(statm_contents: str, page_size: int) -> int:
    if not isinstance(statm_contents, str):
        raise ValueError("invalid statm contents")
    if isinstance(page_size, bool) or not isinstance(page_size, int):
        raise ValueError("invalid page size")
    if page_size <= 0 or page_size > MAX_RSS_BYTES:
        raise ValueError("invalid page size")

    fields = statm_contents.split()
    if len(fields) < 2:
        raise ValueError("missing resident pages")
    resident_pages_text = fields[1]
    if not _DECIMAL_INTEGER_PATTERN.fullmatch(resident_pages_text):
        raise ValueError("invalid resident pages")

    resident_pages = int(resident_pages_text, 10)
    if resident_pages <= 0 or resident_pages > MAX_RSS_BYTES // page_size:
        raise ValueError("resident pages out of range")
    return resident_pages * page_size


def _threshold_state(rss_bytes: int) -> str:
    if rss_bytes >= CRITICAL_THRESHOLD_BYTES:
        return "critical"
    if rss_bytes >= WARNING_THRESHOLD_BYTES:
        return "warning"
    return "normal"


def _safe_metadata(
    environment: Callable[[str], str | None],
) -> tuple[str | None, str | None]:
    try:
        raw_instance = environment("RENDER_INSTANCE_ID")
    except Exception:
        raw_instance = None
    instance = raw_instance.strip() if isinstance(raw_instance, str) else None
    if (
        not instance
        or not _RENDER_INSTANCE_PATTERN.fullmatch(instance)
        or _RENDER_INSTANCE_SECRET_PATTERN.search(instance)
    ):
        instance = None

    try:
        raw_commit = environment("RENDER_GIT_COMMIT")
    except Exception:
        raw_commit = None
    commit = raw_commit.strip() if isinstance(raw_commit, str) else None
    if not commit or not _RENDER_GIT_COMMIT_PATTERN.fullmatch(commit):
        commit = None
    return instance, commit


@dataclass
class _ObserverState:
    last_sample_monotonic: float | None = None
    last_threshold_state: str | None = None
    last_alert_state: str | None = None
    last_alert_monotonic: float | None = None


class ProcessRSSObserver:
    """Observe current RSS without affecting the caller's request outcome.

    The lock intentionally covers the entire due-check, source read, state
    transition, and log emission sequence. Warning and critical samples are
    still read at the normal sample cadence so an escalation is visible at
    the next due sample; repeated alerts of the same state are emitted only
    after ``ALERT_COOLDOWN_SECONDS``.
    """

    def __init__(
        self,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        read_statm: Callable[[], str] = _read_proc_statm,
        page_size: Callable[[], int] = _read_page_size,
        environment: Callable[[str], str | None] = _read_environment,
        process_id: Callable[[], int] = os.getpid,
        utc_timestamp: Callable[[], str] = _utc_timestamp,
        event_logger: logging.Logger = logger,
    ) -> None:
        self._monotonic = monotonic
        self._read_statm = read_statm
        self._page_size = page_size
        self._environment = environment
        self._process_id = process_id
        self._utc_timestamp = utc_timestamp
        self._logger = event_logger
        self._lock = threading.Lock()
        self._state = _ObserverState()

    def observe(self) -> None:
        """Take one due sample, swallowing ordinary observer failures."""
        with self._lock:
            try:
                self._observe_locked()
            except Exception:
                # Sampling must never alter readiness. Keep the fallback
                # record equally sanitized if an injected/internal helper
                # unexpectedly fails.
                self._record_unavailable_locked(self._fallback_monotonic())

    def _observe_locked(self) -> None:
        now = self._safe_monotonic()
        if not self._sample_is_due(now):
            return
        self._state.last_sample_monotonic = now

        try:
            rss_bytes = _parse_rss_bytes(self._read_statm(), self._page_size())
            threshold_state = _threshold_state(rss_bytes)
        except Exception:
            self._record_unavailable_locked(now, due_already_checked=True)
            return

        if self._should_emit(threshold_state, now):
            self._emit_locked(
                rss_bytes=rss_bytes,
                threshold_state=threshold_state,
                level="warning" if threshold_state != "normal" else "info",
            )
            if threshold_state in {"warning", "critical"}:
                self._state.last_alert_state = threshold_state
                self._state.last_alert_monotonic = now
        self._state.last_threshold_state = threshold_state

    def _record_unavailable_locked(
        self, now: float, *, due_already_checked: bool = False
    ) -> None:
        if not due_already_checked and not self._sample_is_due(now):
            return
        self._state.last_sample_monotonic = now
        self._state.last_threshold_state = "unavailable"
        self._emit_locked(
            rss_bytes=None,
            threshold_state="unavailable",
            level="warning",
        )

    def _sample_is_due(self, now: float) -> bool:
        last_sample = self._state.last_sample_monotonic
        return last_sample is None or now - last_sample >= SAMPLE_INTERVAL_SECONDS

    def _should_emit(self, threshold_state: str, now: float) -> bool:
        if threshold_state == "normal":
            return True
        if threshold_state != self._state.last_threshold_state:
            return True
        if self._state.last_alert_state != threshold_state:
            return True
        last_alert = self._state.last_alert_monotonic
        return last_alert is None or now - last_alert >= ALERT_COOLDOWN_SECONDS

    def _emit_locked(
        self,
        *,
        rss_bytes: int | None,
        threshold_state: str,
        level: str,
    ) -> None:
        try:
            process_id = self._process_id()
        except Exception:
            process_id = None
        try:
            timestamp = self._utc_timestamp()
        except Exception:
            timestamp = _utc_timestamp()
        instance, commit = _safe_metadata(self._environment)
        fields = {
            "event": EVENT_NAME,
            "rss_bytes": rss_bytes,
            "threshold_state": threshold_state,
            "process_id": process_id,
            "render_instance_id": instance,
            "render_git_commit": commit,
            "timestamp_utc": timestamp,
        }
        try:
            message = json.dumps(fields, sort_keys=True, separators=(",", ":"))
            if level == "warning":
                self._logger.warning(message, extra=fields)
            else:
                self._logger.info(message, extra=fields)
        except Exception:
            # Logging is best effort and must not become a readiness failure.
            return

    def _safe_monotonic(self) -> float:
        try:
            value = self._monotonic()
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ValueError("invalid monotonic clock")
            if not math.isfinite(float(value)):
                raise ValueError("invalid monotonic clock")
            return float(value)
        except Exception:
            return self._fallback_monotonic()

    @staticmethod
    def _fallback_monotonic() -> float:
        return time.monotonic()


_DEFAULT_OBSERVER = ProcessRSSObserver()


def observe_process_rss() -> None:
    """Observe the current process RSS at the bounded private cadence."""
    _DEFAULT_OBSERVER.observe()
