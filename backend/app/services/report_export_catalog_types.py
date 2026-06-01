from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional


@dataclass(frozen=True)
class CsvReport:
    id: str
    title: str
    filename: str
    columns: tuple[str, ...]
    table: Optional[str] = None
    order_by: tuple[tuple[str, bool], ...] = ()
    custom_builder: Optional[Callable[[Any, str], list[dict[str, Any]]]] = None


def _report(
    id: str,
    title: str,
    filename: str,
    columns: tuple[str, ...],
    *,
    table: Optional[str] = None,
    order_by: tuple[tuple[str, bool], ...] = (),
    custom_builder: Optional[Callable[[Any, str], list[dict[str, Any]]]] = None,
) -> CsvReport:
    return CsvReport(
        id=id,
        title=title,
        filename=filename,
        table=table,
        columns=columns,
        order_by=order_by,
        custom_builder=custom_builder,
    )
