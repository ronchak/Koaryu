from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException


EXPORT_MAX_ROWS = 50_000
EXPORT_MAX_PROVIDER_CALLS = 320
EXPORT_TOO_LARGE_DETAIL = "Export is too large. Apply filters or request an async export."


@dataclass(frozen=True)
class ReportExportBudgetSnapshot:
    max_rows: int
    max_provider_calls: int
    fetched_rows: int
    provider_calls: int


class ReportExportBudget:
    def __init__(
        self,
        *,
        max_rows: int = EXPORT_MAX_ROWS,
        max_provider_calls: int = EXPORT_MAX_PROVIDER_CALLS,
    ) -> None:
        self.max_rows = max_rows
        self.max_provider_calls = max_provider_calls
        self._fetched_rows = 0
        self._provider_calls = 0

    def admit_provider_call(self) -> None:
        if self._provider_calls >= self.max_provider_calls:
            raise_export_too_large()
        self._provider_calls += 1

    def consume_rows(self, count: int) -> None:
        for _ in range(count):
            self._fetched_rows += 1
            if self._fetched_rows > self.max_rows:
                raise_export_too_large()

    def snapshot(self) -> ReportExportBudgetSnapshot:
        return ReportExportBudgetSnapshot(
            max_rows=self.max_rows,
            max_provider_calls=self.max_provider_calls,
            fetched_rows=self._fetched_rows,
            provider_calls=self._provider_calls,
        )


def raise_export_too_large() -> None:
    raise HTTPException(status_code=413, detail=EXPORT_TOO_LARGE_DETAIL)
