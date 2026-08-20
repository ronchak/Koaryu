from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from fastapi import HTTPException


EXPORT_MAX_ROWS = 50_000
EXPORT_MAX_PROVIDER_CALLS = 320
EXPORT_MAX_OUTPUT_ROWS = 50_000
EXPORT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024
EXPORT_MAX_ELAPSED_SECONDS = 15.0
EXPORT_TOO_LARGE_DETAIL = "Export is too large. Apply filters or request an async export."


@dataclass(frozen=True)
class ReportExportBudgetSnapshot:
    max_rows: int
    max_provider_calls: int
    max_output_rows: int
    max_output_bytes: int
    max_elapsed_seconds: float
    fetched_rows: int
    provider_calls: int
    emitted_rows: int
    output_bytes: int
    elapsed_seconds: float


class ReportExportBudget:
    def __init__(
        self,
        *,
        max_rows: int = EXPORT_MAX_ROWS,
        max_provider_calls: int = EXPORT_MAX_PROVIDER_CALLS,
        max_output_rows: int = EXPORT_MAX_OUTPUT_ROWS,
        max_output_bytes: int = EXPORT_MAX_OUTPUT_BYTES,
        max_elapsed_seconds: float = EXPORT_MAX_ELAPSED_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_rows = max_rows
        self.max_provider_calls = max_provider_calls
        self.max_output_rows = max_output_rows
        self.max_output_bytes = max_output_bytes
        self.max_elapsed_seconds = max_elapsed_seconds
        self._clock = clock
        self._started_at = clock()
        self._fetched_rows = 0
        self._provider_calls = 0
        self._emitted_rows = 0
        self._output_bytes = 0

    @property
    def elapsed_seconds(self) -> float:
        return max(0.0, self._clock() - self._started_at)

    def check_elapsed(self) -> None:
        if self.elapsed_seconds > self.max_elapsed_seconds:
            raise_export_too_large()

    def admit_provider_call(self) -> None:
        self.check_elapsed()
        if self._provider_calls >= self.max_provider_calls:
            raise_export_too_large()
        self._provider_calls += 1

    def consume_rows(self, count: int) -> None:
        for _ in range(count):
            self.check_elapsed()
            self._fetched_rows += 1
            if self._fetched_rows > self.max_rows:
                raise_export_too_large()

    def check_output_row(self) -> None:
        self.check_elapsed()
        if self._emitted_rows >= self.max_output_rows:
            raise_export_too_large()

    def consume_output_row(self) -> None:
        self.check_elapsed()
        self._emitted_rows += 1
        if self._emitted_rows > self.max_output_rows:
            raise_export_too_large()

    def consume_output_bytes(self, count: int) -> None:
        self.check_elapsed()
        if self._output_bytes + count > self.max_output_bytes:
            raise_export_too_large()
        self._output_bytes += count

    def snapshot(self) -> ReportExportBudgetSnapshot:
        return ReportExportBudgetSnapshot(
            max_rows=self.max_rows,
            max_provider_calls=self.max_provider_calls,
            max_output_rows=self.max_output_rows,
            max_output_bytes=self.max_output_bytes,
            max_elapsed_seconds=self.max_elapsed_seconds,
            fetched_rows=self._fetched_rows,
            provider_calls=self._provider_calls,
            emitted_rows=self._emitted_rows,
            output_bytes=self._output_bytes,
            elapsed_seconds=self.elapsed_seconds,
        )


def raise_export_too_large() -> None:
    raise HTTPException(status_code=413, detail=EXPORT_TOO_LARGE_DETAIL)
