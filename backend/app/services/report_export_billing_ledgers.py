"""Curated billing ledgers for studio owners.

Each ledger reads an explicit column list from the studio's own billing tables
and joins names in batches. Every read is filtered by studio. Amounts are the
stored integer cents plus a two-decimal display copy; nothing is netted,
recognised or recalculated here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from decimal import Decimal
from typing import Any, Callable, Iterable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services.report_export_data import ReportExportDataFetcher

INVOICE_LEDGER_COLUMNS = (
    "invoice_id",
    "invoice_number",
    "invoice_type",
    "status",
    "external",
    "payer_id",
    "payer_display_name",
    "student_id",
    "student_name",
    "enrollment_id",
    "plan_name",
    "currency",
    "amount_due_cents",
    "amount_due",
    "amount_paid_cents",
    "amount_paid",
    "amount_remaining_cents",
    "amount_remaining",
    "due_date",
    "finalized_at",
    "paid_at",
    "voided_at",
    "created_at",
    "created_date_local",
    "stripe_invoice_id",
)

PAYMENT_LEDGER_COLUMNS = (
    "record_type",
    "record_id",
    "payment_id",
    "invoice_id",
    "payer_id",
    "payer_display_name",
    "status",
    "state_category",
    "payment_method_type",
    "external_method",
    "reason",
    "currency",
    "amount_cents",
    "amount",
    "refunded_amount_cents",
    "disputed_amount_cents",
    "net_collected_amount_cents",
    "processed_at",
    "created_at",
    "event_date_local",
    "stripe_payment_intent_id",
    "stripe_charge_id",
    "stripe_refund_id",
    "stripe_dispute_id",
)

ENROLLMENT_LEDGER_COLUMNS = (
    "enrollment_id",
    "student_id",
    "student_name",
    "payer_id",
    "payer_display_name",
    "billing_plan_id",
    "plan_name",
    "plan_amount_cents",
    "plan_amount",
    "plan_billing_interval",
    "status",
    "billing_status",
    "collection_mode",
    "start_date",
    "end_date",
    "next_bill_on",
    "created_at",
    "updated_at",
)

# The exact columns read from each table. Payment-method details, hosted and PDF
# URLs, metadata, idempotency keys, last_payment_error, payer balances and Stripe
# customer/account ids are never requested.
INVOICE_SOURCE_COLUMNS = (
    "id",
    "invoice_number",
    "invoice_type",
    "status",
    "external",
    "payer_id",
    "student_id",
    "enrollment_id",
    "currency",
    "amount_due_cents",
    "amount_paid_cents",
    "amount_remaining_cents",
    "due_date",
    "finalized_at",
    "paid_at",
    "voided_at",
    "created_at",
    "stripe_invoice_id",
)
PAYMENT_SOURCE_COLUMNS = (
    "id",
    "invoice_id",
    "payer_id",
    "status",
    "payment_method_type",
    "external_method",
    "currency",
    "amount_cents",
    "refunded_amount_cents",
    "disputed_amount_cents",
    "net_collected_amount_cents",
    "processed_at",
    "created_at",
    "stripe_payment_intent_id",
    "stripe_charge_id",
)
PARENT_PAYMENT_COLUMNS = ("id", "invoice_id", "payer_id", "currency")
REFUND_SOURCE_COLUMNS = (
    "id",
    "payment_id",
    "status",
    "reason",
    "amount_cents",
    "created_at",
    "stripe_refund_id",
)
DISPUTE_SOURCE_COLUMNS = (
    "id",
    "payment_id",
    "status",
    "state_category",
    "reason",
    "amount_cents",
    "created_at",
    "stripe_dispute_id",
)
ENROLLMENT_SOURCE_COLUMNS = (
    "id",
    "student_id",
    "payer_id",
    "billing_plan_id",
    "status",
    "billing_status",
    "collection_mode",
    "start_date",
    "end_date",
    "next_bill_on",
    "created_at",
    "updated_at",
)
INVOICE_ENROLLMENT_COLUMNS = ("id", "billing_plan_id")
PAYER_COLUMNS = ("id", "display_name")
STUDENT_COLUMNS = ("id", "legal_first_name", "legal_last_name", "preferred_name")
PLAN_COLUMNS = ("id", "name", "amount_cents", "billing_interval")

_NEWEST_FIRST = (("created_at", True),)
_OLDEST_INSTANT = datetime.min.replace(tzinfo=timezone.utc)
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class ReportDateRange:
    """Inclusive studio-local calendar dates; at least one bound is set."""

    start: Optional[date] = None
    end: Optional[date] = None

    def contains(self, day: Optional[date]) -> bool:
        if day is None:
            return False
        if self.start is not None and day < self.start:
            return False
        if self.end is not None and day > self.end:
            return False
        return True

    def as_metadata(self) -> dict[str, Optional[str]]:
        return {
            "from": self.start.isoformat() if self.start else None,
            "to": self.end.isoformat() if self.end else None,
        }


@dataclass(frozen=True)
class StudioClock:
    zone: tzinfo

    def local_date(self, value: Any) -> Optional[date]:
        instant = parse_instant(value)
        return instant.astimezone(self.zone).date() if instant else None

    def range_filters(
        self,
        column: str,
        date_range: Optional[ReportDateRange],
    ) -> tuple[tuple[str, str, Any], ...]:
        """Query bounds that cover every instant on the local dates in range.

        Around a daylight-saving change at midnight the bounds may admit an
        extra hour; callers re-check the local date of each row.
        """
        if date_range is None:
            return ()
        filters: list[tuple[str, str, Any]] = []
        if date_range.start is not None:
            lower = min(self._midnight_candidates(date_range.start))
            filters.append(("gte", column, lower.isoformat()))
        if date_range.end is not None:
            upper = max(self._midnight_candidates(date_range.end + timedelta(days=1)))
            filters.append(("lt", column, upper.isoformat()))
        return tuple(filters)

    def _midnight_candidates(self, day: date) -> list[datetime]:
        midnight = datetime.combine(day, time.min, tzinfo=self.zone)
        return [midnight.replace(fold=fold).astimezone(timezone.utc) for fold in (0, 1)]


def studio_zone(name: Optional[str]) -> tzinfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def parse_instant(value: Any) -> Optional[datetime]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        instant = value
    else:
        text = str(value).strip()
        if text.endswith(("Z", "z")):
            text = f"{text[:-1]}+00:00"
        try:
            instant = datetime.fromisoformat(text)
        except ValueError:
            return None
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant


def cents_to_amount(value: Any) -> Optional[Decimal]:
    # A Decimal, not text, so the CSV formula guard leaves "-12.00" as a number.
    if value is None or isinstance(value, bool):
        return None
    try:
        cents = Decimal(int(value))
    except (TypeError, ValueError):
        return None
    return (cents / 100).quantize(_CENT)


def student_name(student: Optional[dict[str, Any]]) -> Optional[str]:
    if not student:
        return None
    legal = " ".join(
        part
        for part in (
            str(student.get("legal_first_name") or "").strip(),
            str(student.get("legal_last_name") or "").strip(),
        )
        if part
    )
    if legal:
        return legal
    return str(student.get("preferred_name") or "").strip() or None


def _studio_clock(data: ReportExportDataFetcher, studio_id: str) -> StudioClock:
    studio = data._single_row("studios", "timezone", studio_id)
    if not studio:
        raise RuntimeError("Studio timezone could not be loaded.")
    return StudioClock(studio_zone(studio.get("timezone")))


def _lookup(
    data: ReportExportDataFetcher,
    table: str,
    columns: tuple[str, ...],
    studio_id: str,
    ids: Iterable[Any],
) -> dict[str, dict[str, Any]]:
    unique_ids = sorted({value for value in ids if isinstance(value, str) and value})
    if not unique_ids:
        return {}
    rows = data._fetch_rows_by_values(table, columns, "id", unique_ids, studio_id=studio_id)
    return {row["id"]: row for row in rows if row.get("id")}


def _newest_first(
    rows: list[Any],
    timestamp_of: Callable[[Any], Any],
    id_of: Callable[[Any], Any],
) -> list[Any]:
    by_id = sorted(rows, key=lambda row: str(id_of(row) or ""))
    return sorted(
        by_id,
        key=lambda row: parse_instant(timestamp_of(row)) or _OLDEST_INSTANT,
        reverse=True,
    )


def _within(
    clock: StudioClock,
    date_range: Optional[ReportDateRange],
    rows: list[dict[str, Any]],
    timestamp_of: Callable[[dict[str, Any]], Any],
) -> list[dict[str, Any]]:
    if date_range is None:
        return rows
    return [row for row in rows if date_range.contains(clock.local_date(timestamp_of(row)))]


def _payer_name(payers: dict[str, dict[str, Any]], payer_id: Any) -> Optional[str]:
    payer = payers.get(payer_id) if isinstance(payer_id, str) else None
    return payer.get("display_name") if payer else None


def _created_at(row: dict[str, Any]) -> Any:
    return row.get("created_at")


def _payment_timestamp(row: dict[str, Any]) -> Any:
    return row.get("processed_at") or row.get("created_at")


def _row_id(row: dict[str, Any]) -> Any:
    return row.get("id")


def build_invoice_ledger_rows(
    data: ReportExportDataFetcher,
    studio_id: str,
    date_range: Optional[ReportDateRange],
) -> list[dict[str, Any]]:
    clock = _studio_clock(data, studio_id)
    invoices = data._fetch_rows(
        "billing_invoices",
        INVOICE_SOURCE_COLUMNS,
        studio_id,
        order_by=_NEWEST_FIRST,
        filters=clock.range_filters("created_at", date_range),
    )
    invoices = _within(clock, date_range, invoices, _created_at)
    payers = _lookup(
        data, "billing_payers", PAYER_COLUMNS, studio_id, (row.get("payer_id") for row in invoices)
    )
    students = _lookup(
        data, "students", STUDENT_COLUMNS, studio_id, (row.get("student_id") for row in invoices)
    )
    enrollments = _lookup(
        data,
        "student_billing_enrollments",
        INVOICE_ENROLLMENT_COLUMNS,
        studio_id,
        (row.get("enrollment_id") for row in invoices),
    )
    plans = _lookup(
        data,
        "billing_plans",
        ("id", "name"),
        studio_id,
        (row.get("billing_plan_id") for row in enrollments.values()),
    )

    rows: list[dict[str, Any]] = []
    for invoice in _newest_first(invoices, _created_at, _row_id):
        enrollment = enrollments.get(invoice.get("enrollment_id")) or {}
        plan = plans.get(enrollment.get("billing_plan_id")) or {}
        rows.append(
            {
                "invoice_id": invoice.get("id"),
                "invoice_number": invoice.get("invoice_number"),
                "invoice_type": invoice.get("invoice_type"),
                "status": invoice.get("status"),
                "external": invoice.get("external"),
                "payer_id": invoice.get("payer_id"),
                "payer_display_name": _payer_name(payers, invoice.get("payer_id")),
                "student_id": invoice.get("student_id"),
                "student_name": student_name(students.get(invoice.get("student_id"))),
                "enrollment_id": invoice.get("enrollment_id"),
                "plan_name": plan.get("name"),
                "currency": invoice.get("currency"),
                "amount_due_cents": invoice.get("amount_due_cents"),
                "amount_due": cents_to_amount(invoice.get("amount_due_cents")),
                "amount_paid_cents": invoice.get("amount_paid_cents"),
                "amount_paid": cents_to_amount(invoice.get("amount_paid_cents")),
                "amount_remaining_cents": invoice.get("amount_remaining_cents"),
                "amount_remaining": cents_to_amount(invoice.get("amount_remaining_cents")),
                "due_date": invoice.get("due_date"),
                "finalized_at": invoice.get("finalized_at"),
                "paid_at": invoice.get("paid_at"),
                "voided_at": invoice.get("voided_at"),
                "created_at": invoice.get("created_at"),
                "created_date_local": _date_text(clock.local_date(invoice.get("created_at"))),
                "stripe_invoice_id": invoice.get("stripe_invoice_id"),
            }
        )
    return rows


def build_payment_ledger_rows(
    data: ReportExportDataFetcher,
    studio_id: str,
    date_range: Optional[ReportDateRange],
) -> list[dict[str, Any]]:
    clock = _studio_clock(data, studio_id)
    if date_range is None:
        payments = data._fetch_rows(
            "billing_payments", PAYMENT_SOURCE_COLUMNS, studio_id, order_by=_NEWEST_FIRST
        )
    else:
        # A payment's ledger date is processed_at, or created_at until it is
        # processed. PostgREST cannot filter on that fallback, so read the two
        # cases separately.
        processed = data._fetch_rows(
            "billing_payments",
            PAYMENT_SOURCE_COLUMNS,
            studio_id,
            order_by=_NEWEST_FIRST,
            filters=clock.range_filters("processed_at", date_range),
        )
        unprocessed = data._fetch_rows(
            "billing_payments",
            PAYMENT_SOURCE_COLUMNS,
            studio_id,
            order_by=_NEWEST_FIRST,
            filters=(
                ("is_", "processed_at", "null"),
                *clock.range_filters("created_at", date_range),
            ),
        )
        payments = list({row["id"]: row for row in processed + unprocessed}.values())
    payments = _within(clock, date_range, payments, _payment_timestamp)
    refunds = _within(
        clock,
        date_range,
        data._fetch_rows(
            "billing_refunds",
            REFUND_SOURCE_COLUMNS,
            studio_id,
            order_by=_NEWEST_FIRST,
            filters=clock.range_filters("created_at", date_range),
        ),
        _created_at,
    )
    disputes = _within(
        clock,
        date_range,
        data._fetch_rows(
            "billing_disputes",
            DISPUTE_SOURCE_COLUMNS,
            studio_id,
            order_by=_NEWEST_FIRST,
            filters=clock.range_filters("created_at", date_range),
        ),
        _created_at,
    )

    # Refunds and disputes carry their parent payment's payer, invoice and
    # currency. A parent outside the date range is read for linkage only.
    parents: dict[str, dict[str, Any]] = {row["id"]: row for row in payments if row.get("id")}
    parents.update(
        _lookup(
            data,
            "billing_payments",
            PARENT_PAYMENT_COLUMNS,
            studio_id,
            (
                row.get("payment_id")
                for row in (*refunds, *disputes)
                if row.get("payment_id") not in parents
            ),
        )
    )
    payers = _lookup(
        data,
        "billing_payers",
        PAYER_COLUMNS,
        studio_id,
        (row.get("payer_id") for row in parents.values()),
    )

    entries: list[tuple[Any, dict[str, Any]]] = []
    for payment in payments:
        entries.append(
            (
                _payment_timestamp(payment),
                {
                    **_ledger_link(payment.get("id"), payment, payers),
                    "record_type": "payment",
                    "record_id": payment.get("id"),
                    "status": payment.get("status"),
                    "payment_method_type": payment.get("payment_method_type"),
                    "external_method": payment.get("external_method"),
                    "amount_cents": payment.get("amount_cents"),
                    "amount": cents_to_amount(payment.get("amount_cents")),
                    "refunded_amount_cents": payment.get("refunded_amount_cents"),
                    "disputed_amount_cents": payment.get("disputed_amount_cents"),
                    "net_collected_amount_cents": payment.get("net_collected_amount_cents"),
                    "processed_at": payment.get("processed_at"),
                    "created_at": payment.get("created_at"),
                    "event_date_local": _date_text(clock.local_date(_payment_timestamp(payment))),
                    "stripe_payment_intent_id": payment.get("stripe_payment_intent_id"),
                    "stripe_charge_id": payment.get("stripe_charge_id"),
                },
            )
        )
    for record_type, records in (("refund", refunds), ("dispute", disputes)):
        for record in records:
            parent = parents.get(record.get("payment_id")) or {}
            entries.append(
                (
                    record.get("created_at"),
                    {
                        **_ledger_link(record.get("payment_id"), parent, payers),
                        "record_type": record_type,
                        "record_id": record.get("id"),
                        "status": record.get("status"),
                        "state_category": record.get("state_category"),
                        "reason": record.get("reason"),
                        "amount_cents": record.get("amount_cents"),
                        "amount": cents_to_amount(record.get("amount_cents")),
                        "created_at": record.get("created_at"),
                        "event_date_local": _date_text(clock.local_date(record.get("created_at"))),
                        "stripe_refund_id": record.get("stripe_refund_id"),
                        "stripe_dispute_id": record.get("stripe_dispute_id"),
                    },
                )
            )
    ordered = _newest_first(entries, lambda entry: entry[0], lambda entry: entry[1]["record_id"])
    return [row for _event_at, row in ordered]


def _ledger_link(
    payment_id: Any,
    payment: dict[str, Any],
    payers: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    return {
        "payment_id": payment_id,
        "invoice_id": payment.get("invoice_id"),
        "payer_id": payment.get("payer_id"),
        "payer_display_name": _payer_name(payers, payment.get("payer_id")),
        "currency": payment.get("currency"),
    }


def build_enrollment_ledger_rows(
    data: ReportExportDataFetcher,
    studio_id: str,
) -> list[dict[str, Any]]:
    enrollments = data._fetch_rows(
        "student_billing_enrollments",
        ENROLLMENT_SOURCE_COLUMNS,
        studio_id,
        order_by=_NEWEST_FIRST,
    )
    students = _lookup(
        data,
        "students",
        STUDENT_COLUMNS,
        studio_id,
        (row.get("student_id") for row in enrollments),
    )
    payers = _lookup(
        data,
        "billing_payers",
        PAYER_COLUMNS,
        studio_id,
        (row.get("payer_id") for row in enrollments),
    )
    plans = _lookup(
        data,
        "billing_plans",
        PLAN_COLUMNS,
        studio_id,
        (row.get("billing_plan_id") for row in enrollments),
    )

    rows: list[dict[str, Any]] = []
    for enrollment in _newest_first(enrollments, _created_at, _row_id):
        plan = plans.get(enrollment.get("billing_plan_id")) or {}
        rows.append(
            {
                "enrollment_id": enrollment.get("id"),
                "student_id": enrollment.get("student_id"),
                "student_name": student_name(students.get(enrollment.get("student_id"))),
                "payer_id": enrollment.get("payer_id"),
                "payer_display_name": _payer_name(payers, enrollment.get("payer_id")),
                "billing_plan_id": enrollment.get("billing_plan_id"),
                "plan_name": plan.get("name"),
                "plan_amount_cents": plan.get("amount_cents"),
                "plan_amount": cents_to_amount(plan.get("amount_cents")),
                "plan_billing_interval": plan.get("billing_interval"),
                "status": enrollment.get("status"),
                "billing_status": enrollment.get("billing_status"),
                "collection_mode": enrollment.get("collection_mode"),
                "start_date": enrollment.get("start_date"),
                "end_date": enrollment.get("end_date"),
                "next_bill_on": enrollment.get("next_bill_on"),
                "created_at": enrollment.get("created_at"),
                "updated_at": enrollment.get("updated_at"),
            }
        )
    return rows


def _date_text(value: Optional[date]) -> Optional[str]:
    return value.isoformat() if value else None
