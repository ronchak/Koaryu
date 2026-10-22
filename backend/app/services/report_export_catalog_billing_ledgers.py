from __future__ import annotations

from typing import Any

from app.services.report_export_billing_ledgers import (
    ENROLLMENT_LEDGER_COLUMNS,
    INVOICE_LEDGER_COLUMNS,
    PAYMENT_LEDGER_COLUMNS,
)
from app.services.report_export_catalog_types import CsvReport, _report


# Curated, owner-facing billing ledgers. Unlike the raw billing tables in
# report_export_catalog_billing_tables.py, these select an explicit column set
# that leaves out payment-method details, hosted URLs, metadata, provider
# customer/account ids and stored payer balances.
def build_billing_ledger_report_catalog(report_service_cls: Any) -> dict[str, CsvReport]:
    return {
        "billing_invoice_ledger": _report(
            "billing_invoice_ledger",
            "Billing invoice ledger",
            "billing-invoice-ledger.csv",
            INVOICE_LEDGER_COLUMNS,
            source_keys=(
                "studios",
                "billing_invoices",
                "billing_payers",
                "students",
                "student_billing_enrollments",
                "billing_plans",
            ),
            custom_builder=report_service_cls._build_billing_invoice_ledger_rows,
            supports_date_range=True,
        ),
        "billing_payment_ledger": _report(
            "billing_payment_ledger",
            "Billing payment ledger",
            "billing-payment-ledger.csv",
            PAYMENT_LEDGER_COLUMNS,
            source_keys=(
                "studios",
                "billing_payments",
                "billing_refunds",
                "billing_disputes",
                "billing_payers",
            ),
            custom_builder=report_service_cls._build_billing_payment_ledger_rows,
            supports_date_range=True,
        ),
        "billing_enrollment_ledger": _report(
            "billing_enrollment_ledger",
            "Billing enrollment ledger",
            "billing-enrollment-ledger.csv",
            ENROLLMENT_LEDGER_COLUMNS,
            source_keys=(
                "student_billing_enrollments",
                "students",
                "billing_payers",
                "billing_plans",
            ),
            custom_builder=report_service_cls._build_billing_enrollment_ledger_rows,
        ),
    }
