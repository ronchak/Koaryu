from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, Optional


ReportAvailability = Literal["friendly_pilot_core", "deferred_billing"]


@dataclass(frozen=True)
class CsvReport:
    id: str
    title: str
    filename: str
    columns: tuple[str, ...]
    table: Optional[str] = None
    order_by: tuple[tuple[str, bool], ...] = ()
    custom_builder: Optional[Callable[[Any, str], list[dict[str, Any]]]] = None
    min_role: str = "admin"
    contains_sensitive_data: bool = True
    availability: ReportAvailability = "friendly_pilot_core"


def _report(
    id: str,
    title: str,
    filename: str,
    columns: tuple[str, ...],
    *,
    table: Optional[str] = None,
    order_by: tuple[tuple[str, bool], ...] = (),
    custom_builder: Optional[Callable[[Any, str], list[dict[str, Any]]]] = None,
    min_role: str = "admin",
    contains_sensitive_data: bool = True,
    availability: ReportAvailability = "friendly_pilot_core",
) -> CsvReport:
    return CsvReport(
        id=id,
        title=title,
        filename=filename,
        table=table,
        columns=columns,
        order_by=order_by,
        custom_builder=custom_builder,
        min_role=min_role,
        contains_sensitive_data=contains_sensitive_data,
        availability=availability,
    )
