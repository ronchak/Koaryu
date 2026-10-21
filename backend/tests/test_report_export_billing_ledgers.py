import asyncio
import csv
import unittest
from datetime import date
from io import StringIO
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.endpoints import reports
from app.api.v1.endpoints.reports import export_report_csv
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.report_export_billing_ledgers import (
    ENROLLMENT_LEDGER_COLUMNS,
    INVOICE_LEDGER_COLUMNS,
    PAYMENT_LEDGER_COLUMNS,
    ReportDateRange,
    StudioClock,
    studio_zone,
)
from app.services.report_export_catalog import build_complete_report_catalog
from app.services.report_export_catalog_billing_tables import build_billing_table_report_catalog
from app.services.report_export_service import ReportExportService
from tests.fakes.supabase import TableBackedSupabase


LEDGER_IDS = ("billing_invoice_ledger", "billing_payment_ledger", "billing_enrollment_ledger")
BILLING_TABLES = {
    "billing_invoices",
    "billing_payments",
    "billing_refunds",
    "billing_disputes",
    "billing_payers",
    "billing_plans",
    "student_billing_enrollments",
    "students",
}
EXCLUDED_FIELDS = (
    "default_payment_method_brand",
    "default_payment_method_last4",
    "hosted_invoice_url",
    "invoice_pdf",
    "receipt_url",
    "metadata",
    "idempotency_key",
    "request_hash",
    "last_payment_error",
    "balance_cents",
    "stripe_customer_id",
    "stripe_account_id",
    "stripe_payment_method_id",
)
EXCLUDED_VALUES = (
    "visa-brand-secret",
    "4242",
    "https://invoice.example/hosted",
    "https://invoice.example/pdf",
    "https://receipt.example/r",
    "metadata-secret",
    "idem-secret",
    "hash-secret",
    "card declined secret",
    "987654",
    "cus_secret",
    "acct_secret",
    "pm_secret",
)


def _secrets() -> dict:
    return {
        "metadata": {"note": "metadata-secret"},
        "idempotency_key": "idem-secret",
        "request_hash": "hash-secret",
        "stripe_customer_id": "cus_secret",
        "stripe_account_id": "acct_secret",
    }


def billing_fixture(timezone_name: str = "America/Los_Angeles") -> dict[str, list[dict]]:
    return {
        "studios": [
            {"id": "studio-1", "timezone": timezone_name},
            {"id": "studio-2", "timezone": "Asia/Tokyo"},
        ],
        "students": [
            {
                "id": "student-ada",
                "studio_id": "studio-1",
                "legal_first_name": "Ada",
                "legal_last_name": "Lovelace",
                "preferred_name": "Countess",
                "deleted_at": None,
            },
            {
                "id": "student-archived",
                "studio_id": "studio-1",
                "legal_first_name": "Grace",
                "legal_last_name": "Hopper",
                "preferred_name": None,
                "deleted_at": "2026-02-01T00:00:00+00:00",
            },
            {
                "id": "student-blank",
                "studio_id": "studio-1",
                "legal_first_name": " ",
                "legal_last_name": "",
                "preferred_name": "Kiddo",
                "deleted_at": None,
            },
            {
                "id": "student-other",
                "studio_id": "studio-2",
                "legal_first_name": "Other",
                "legal_last_name": "Studio",
                "preferred_name": None,
                "deleted_at": None,
            },
        ],
        "billing_payers": [
            {
                **_secrets(),
                "id": "payer-1",
                "studio_id": "studio-1",
                "display_name": "Lovelace Family",
                "email": "family@example.com",
                "default_payment_method_brand": "visa-brand-secret",
                "default_payment_method_last4": "4242",
                "balance_cents": 987654,
            },
            {
                "id": "payer-formula",
                "studio_id": "studio-1",
                "display_name": '=HYPERLINK("x")',
            },
            {"id": "payer-other", "studio_id": "studio-2", "display_name": "Other Payer"},
        ],
        "billing_plans": [
            {
                **_secrets(),
                "id": "plan-1",
                "studio_id": "studio-1",
                "name": "Little Dragons",
                "amount_cents": 12950,
                "billing_interval": "monthly",
                "currency": "usd",
            },
            {
                "id": "plan-other",
                "studio_id": "studio-2",
                "name": "Other Plan",
                "amount_cents": 1,
                "billing_interval": "monthly",
            },
        ],
        "student_billing_enrollments": [
            {
                **_secrets(),
                "id": "enr-1",
                "studio_id": "studio-1",
                "student_id": "student-ada",
                "payer_id": "payer-1",
                "billing_plan_id": "plan-1",
                "status": "active",
                "billing_status": "current",
                "collection_mode": "autopay",
                "start_date": "2026-01-01",
                "end_date": None,
                "next_bill_on": "2026-04-01",
                "stripe_subscription_id": "sub_1",
                "created_at": "2026-01-01T17:00:00+00:00",
                "updated_at": "2026-03-01T17:00:00+00:00",
            },
            {
                "id": "enr-archived",
                "studio_id": "studio-1",
                "student_id": "student-archived",
                "payer_id": None,
                "billing_plan_id": "plan-1",
                "status": "ended",
                "billing_status": "externally_paid",
                "collection_mode": "external",
                "start_date": "2025-01-01",
                "end_date": "2026-01-31",
                "next_bill_on": None,
                "created_at": "2025-01-01T17:00:00+00:00",
                "updated_at": "2026-02-01T00:00:00+00:00",
            },
            {
                "id": "enr-other",
                "studio_id": "studio-2",
                "student_id": "student-other",
                "payer_id": "payer-other",
                "billing_plan_id": "plan-other",
                "status": "active",
                "billing_status": "current",
                "collection_mode": "autopay",
                "start_date": "2026-01-01",
                "created_at": "2026-02-01T00:00:00+00:00",
                "updated_at": "2026-02-01T00:00:00+00:00",
            },
        ],
        "billing_invoices": [
            invoice("inv-before", "2026-03-01T07:59:59+00:00"),
            invoice(
                "inv-first-midnight",
                "2026-03-01T08:00:00+00:00",
                invoice_number="=1+1",
                amount_due_cents=12950,
                amount_paid_cents=12950,
                amount_remaining_cents=0,
                status="paid",
                paid_at="2026-03-02T18:00:00+00:00",
            ),
            invoice(
                "inv-archived",
                "2026-03-05T12:00:00+00:00",
                student_id="student-archived",
                enrollment_id="enr-archived",
                payer_id=None,
                external=True,
            ),
            invoice(
                "inv-blank-name",
                "2026-03-05T12:00:00+00:00",
                student_id="student-blank",
                enrollment_id=None,
                payer_id="payer-formula",
            ),
            invoice("inv-last-instant", "2026-03-09T06:59:59+00:00"),
            invoice("inv-after", "2026-03-09T07:00:00+00:00"),
            invoice(
                "inv-other-studio",
                "2026-03-05T12:00:00+00:00",
                studio_id="studio-2",
                student_id="student-other",
                payer_id="payer-other",
                enrollment_id="enr-other",
            ),
        ],
        "billing_payments": [
            payment(
                "pay-card",
                processed_at="2026-03-02T18:00:00+00:00",
                created_at="2026-02-27T18:00:00+00:00",
            ),
            payment(
                "pay-cash",
                processed_at=None,
                created_at="2026-03-08T07:30:00+00:00",
                status="externally_recorded",
                payment_method_type=None,
                external_method="cash",
                amount_cents=5000,
                refunded_amount_cents=0,
                disputed_amount_cents=0,
                net_collected_amount_cents=5000,
                stripe_payment_intent_id=None,
                stripe_charge_id=None,
            ),
            payment(
                "pay-pending-late",
                processed_at=None,
                created_at="2026-03-09T07:00:00+00:00",
                status="pending",
            ),
            payment(
                "pay-old",
                processed_at="2026-02-15T18:00:00+00:00",
                created_at="2026-02-15T18:00:00+00:00",
                invoice_id="inv-before",
            ),
            payment(
                "pay-processed-late",
                processed_at="2026-03-09T07:00:00+00:00",
                created_at="2026-03-02T18:00:00+00:00",
            ),
            payment(
                "pay-other-studio",
                studio_id="studio-2",
                payer_id="payer-other",
                invoice_id="inv-other-studio",
                processed_at="2026-03-03T00:00:00+00:00",
                created_at="2026-03-03T00:00:00+00:00",
            ),
        ],
        "billing_refunds": [
            {
                **_secrets(),
                "id": "ref-card",
                "studio_id": "studio-1",
                "payment_id": "pay-card",
                "status": "succeeded",
                "reason": "requested_by_customer",
                "amount_cents": 2000,
                "created_at": "2026-03-03T18:00:00+00:00",
                "stripe_refund_id": "re_card",
                "stripe_charge_id": "ch_refund_copy",
                "stripe_payment_intent_id": "pi_refund_copy",
            },
            {
                "id": "ref-old",
                "studio_id": "studio-1",
                "payment_id": "pay-old",
                "status": "succeeded",
                "reason": None,
                "amount_cents": 500,
                "created_at": "2026-03-04T18:00:00+00:00",
                "stripe_refund_id": "re_old",
            },
            {
                "id": "ref-other",
                "studio_id": "studio-2",
                "payment_id": "pay-other-studio",
                "status": "succeeded",
                "amount_cents": 1,
                "created_at": "2026-03-04T18:00:00+00:00",
            },
        ],
        "billing_disputes": [
            {
                **_secrets(),
                "id": "dis-card",
                "studio_id": "studio-1",
                "payment_id": "pay-card",
                "status": "needs_response",
                "state_category": "active",
                "reason": "fraudulent",
                "amount_cents": 3000,
                "liability_owner": "studio",
                "created_at": "2026-03-06T18:00:00+00:00",
                "stripe_dispute_id": "dp_card",
            },
            {
                "id": "dis-other",
                "studio_id": "studio-2",
                "payment_id": "pay-other-studio",
                "status": "won",
                "state_category": "won",
                "amount_cents": 1,
                "created_at": "2026-03-04T18:00:00+00:00",
            },
        ],
        "audit_logs": [],
    }


def invoice(invoice_id: str, created_at: str, **overrides) -> dict:
    return {
        **_secrets(),
        "id": invoice_id,
        "studio_id": "studio-1",
        "invoice_number": f"KOA-{invoice_id}",
        "invoice_type": "subscription",
        "status": "open",
        "external": False,
        "payer_id": "payer-1",
        "student_id": "student-ada",
        "enrollment_id": "enr-1",
        "currency": "usd",
        "amount_due_cents": 12950,
        "amount_paid_cents": 0,
        "amount_remaining_cents": 12950,
        "due_date": "2026-03-10",
        "finalized_at": created_at,
        "paid_at": None,
        "voided_at": None,
        "created_at": created_at,
        "updated_at": created_at,
        "stripe_invoice_id": f"in_{invoice_id}",
        "stripe_subscription_id": "sub_1",
        "stripe_payment_intent_id": "pi_invoice",
        "hosted_invoice_url": "https://invoice.example/hosted",
        "invoice_pdf": "https://invoice.example/pdf",
        "last_payment_error": "card declined secret",
        "application_fee_amount_cents": 65,
        **overrides,
    }


def payment(payment_id: str, **overrides) -> dict:
    return {
        **_secrets(),
        "id": payment_id,
        "studio_id": "studio-1",
        "payer_id": "payer-1",
        "invoice_id": "inv-first-midnight",
        "status": "succeeded",
        "amount_cents": 12950,
        "gross_paid_amount_cents": 12950,
        "currency": "usd",
        "payment_method_type": "card",
        "external_method": None,
        "refunded_amount_cents": 2000,
        "disputed_amount_cents": 3000,
        "net_collected_amount_cents": 7950,
        "stripe_payment_intent_id": f"pi_{payment_id}",
        "stripe_charge_id": f"ch_{payment_id}",
        "stripe_payment_method_id": "pm_secret",
        "receipt_url": "https://receipt.example/r",
        "failure_message": None,
        "application_fee_amount_cents": 65,
        **overrides,
    }


def build(supabase, report_id: str, date_range=None) -> tuple[list[dict], str]:
    body, _filename = asyncio.run(
        ReportExportService(supabase).build_csv(report_id, "studio-1", date_range=date_range)
    )
    return list(csv.DictReader(StringIO(body))), body


def admin_export(supabase, report_id: str, *, role: str = "admin", **params):
    with patch(
        "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
        return_value={"studio_id": "studio-1", "role": role},
    ):
        return asyncio.run(
            export_report_csv(
                report_id,
                user_id="user-1",
                requested_studio_id="studio-1",
                supabase=supabase,
                **params,
            )
        )


async def consume(response) -> bytes:
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


def queries(supabase, table: str) -> list[dict]:
    return [entry for entry in supabase.log if entry["table"] == table]


class BillingLedgerCatalogTest(unittest.TestCase):
    def test_ledgers_are_live_admin_sensitive_and_raw_billing_tables_stay_deferred(self):
        complete = build_complete_report_catalog(ReportExportService)
        service = ReportExportService(TableBackedSupabase({}))

        for report_id in LEDGER_IDS:
            with self.subTest(report_id=report_id):
                report = service.get_report(report_id)
                self.assertEqual("available", report.availability)
                self.assertEqual("admin", report.min_role)
                self.assertTrue(report.contains_sensitive_data)
        self.assertEqual(
            {"billing_invoice_ledger", "billing_payment_ledger"},
            {report.id for report in complete.values() if report.supports_date_range},
        )
        self.assertTrue(set(LEDGER_IDS).isdisjoint(build_billing_table_report_catalog(None)))
        self.assertEqual(
            11,
            sum(1 for report in complete.values() if report.availability == "deferred_billing"),
        )

    def test_ledger_columns_carry_no_excluded_fields(self):
        for columns in (INVOICE_LEDGER_COLUMNS, PAYMENT_LEDGER_COLUMNS, ENROLLMENT_LEDGER_COLUMNS):
            for field in EXCLUDED_FIELDS:
                self.assertFalse(
                    any(field in column for column in columns), f"{field} in {columns}"
                )


class BillingLedgerRowsTest(unittest.TestCase):
    def test_invoice_ledger_joins_names_plans_and_formats_amounts(self):
        rows, body = build(TableBackedSupabase(billing_fixture()), "billing_invoice_ledger")

        self.assertEqual(
            [row["invoice_id"] for row in rows],
            [
                "inv-after",
                "inv-last-instant",
                "inv-archived",
                "inv-blank-name",
                "inv-first-midnight",
                "inv-before",
            ],
        )
        self.assertEqual(list(rows[0]), list(INVOICE_LEDGER_COLUMNS))
        first = next(row for row in rows if row["invoice_id"] == "inv-first-midnight")
        self.assertEqual(
            first,
            {
                "invoice_id": "inv-first-midnight",
                "invoice_number": "'=1+1",
                "invoice_type": "subscription",
                "status": "paid",
                "external": "false",
                "payer_id": "payer-1",
                "payer_display_name": "Lovelace Family",
                "student_id": "student-ada",
                "student_name": "Ada Lovelace",
                "enrollment_id": "enr-1",
                "plan_name": "Little Dragons",
                "currency": "usd",
                "amount_due_cents": "12950",
                "amount_due": "129.50",
                "amount_paid_cents": "12950",
                "amount_paid": "129.50",
                "amount_remaining_cents": "0",
                "amount_remaining": "0.00",
                "due_date": "2026-03-10",
                "finalized_at": "2026-03-01T08:00:00+00:00",
                "paid_at": "2026-03-02T18:00:00+00:00",
                "voided_at": "",
                "created_at": "2026-03-01T08:00:00+00:00",
                "created_date_local": "2026-03-01",
                "stripe_invoice_id": "in_inv-first-midnight",
            },
        )
        archived = next(row for row in rows if row["invoice_id"] == "inv-archived")
        self.assertEqual(archived["student_name"], "Grace Hopper")
        self.assertEqual(archived["external"], "true")
        self.assertEqual(archived["payer_display_name"], "")
        blank = next(row for row in rows if row["invoice_id"] == "inv-blank-name")
        self.assertEqual(blank["student_name"], "Kiddo")
        self.assertEqual(blank["plan_name"], "")
        self.assertEqual(blank["payer_display_name"], '\'=HYPERLINK("x")')
        self.assertEqual(
            next(row for row in rows if row["invoice_id"] == "inv-before")["created_date_local"],
            "2026-02-28",
        )
        self.assertNotIn("Countess", body)
        self.assertNotIn("inv-other-studio", body)

    def test_negative_amounts_stay_numeric_without_a_formula_apostrophe(self):
        fixture = billing_fixture()
        fixture["billing_invoices"] = [
            invoice(
                "inv-credit",
                "2026-03-02T12:00:00+00:00",
                amount_due_cents=1200,
                amount_paid_cents=0,
                amount_remaining_cents=-1200,
            )
        ]
        rows, body = build(TableBackedSupabase(fixture), "billing_invoice_ledger")

        self.assertEqual(rows[0]["amount_due"], "12.00")
        self.assertEqual(rows[0]["amount_paid"], "0.00")
        self.assertEqual(rows[0]["amount_remaining_cents"], "-1200")
        self.assertEqual(rows[0]["amount_remaining"], "-12.00")
        self.assertIn(",1200,12.00,0,0.00,-1200,-12.00,", body)
        self.assertNotIn("'-12.00", body)
        self.assertNotIn("'-1200", body)

    def test_payment_ledger_lists_refunds_and_disputes_as_their_own_rows(self):
        rows, body = build(TableBackedSupabase(billing_fixture()), "billing_payment_ledger")

        self.assertEqual(
            [(row["record_type"], row["record_id"]) for row in rows],
            [
                ("payment", "pay-pending-late"),
                ("payment", "pay-processed-late"),
                ("payment", "pay-cash"),
                ("dispute", "dis-card"),
                ("refund", "ref-old"),
                ("refund", "ref-card"),
                ("payment", "pay-card"),
                ("payment", "pay-old"),
            ],
        )
        self.assertEqual(list(rows[0]), list(PAYMENT_LEDGER_COLUMNS))
        card = next(row for row in rows if row["record_id"] == "pay-card")
        self.assertEqual(card["payment_id"], "pay-card")
        self.assertEqual(card["amount_cents"], "12950")
        self.assertEqual(card["amount"], "129.50")
        self.assertEqual(card["refunded_amount_cents"], "2000")
        self.assertEqual(card["disputed_amount_cents"], "3000")
        self.assertEqual(card["net_collected_amount_cents"], "7950")
        self.assertEqual(card["event_date_local"], "2026-03-02")
        self.assertEqual(card["stripe_charge_id"], "ch_pay-card")

        refund = next(row for row in rows if row["record_id"] == "ref-card")
        self.assertEqual(
            refund,
            {
                "record_type": "refund",
                "record_id": "ref-card",
                "payment_id": "pay-card",
                "invoice_id": "inv-first-midnight",
                "payer_id": "payer-1",
                "payer_display_name": "Lovelace Family",
                "status": "succeeded",
                "state_category": "",
                "payment_method_type": "",
                "external_method": "",
                "reason": "requested_by_customer",
                "currency": "usd",
                "amount_cents": "2000",
                "amount": "20.00",
                "refunded_amount_cents": "",
                "disputed_amount_cents": "",
                "net_collected_amount_cents": "",
                "processed_at": "",
                "created_at": "2026-03-03T18:00:00+00:00",
                "event_date_local": "2026-03-03",
                "stripe_payment_intent_id": "",
                "stripe_charge_id": "",
                "stripe_refund_id": "re_card",
                "stripe_dispute_id": "",
            },
        )
        dispute = next(row for row in rows if row["record_id"] == "dis-card")
        self.assertEqual(dispute["payment_id"], "pay-card")
        self.assertEqual(dispute["amount_cents"], "3000")
        self.assertEqual(dispute["amount"], "30.00")
        self.assertEqual(dispute["state_category"], "active")
        self.assertEqual(dispute["stripe_dispute_id"], "dp_card")
        self.assertEqual(dispute["net_collected_amount_cents"], "")
        cash = next(row for row in rows if row["record_id"] == "pay-cash")
        self.assertEqual(cash["processed_at"], "")
        self.assertEqual(cash["external_method"], "cash")
        self.assertEqual(cash["event_date_local"], "2026-03-07")
        self.assertNotIn("ch_refund_copy", body)
        self.assertNotIn("pay-other-studio", body)

    def test_enrollment_ledger_joins_student_payer_and_plan(self):
        rows, body = build(TableBackedSupabase(billing_fixture()), "billing_enrollment_ledger")

        self.assertEqual([row["enrollment_id"] for row in rows], ["enr-1", "enr-archived"])
        self.assertEqual(list(rows[0]), list(ENROLLMENT_LEDGER_COLUMNS))
        self.assertEqual(
            rows[0],
            {
                "enrollment_id": "enr-1",
                "student_id": "student-ada",
                "student_name": "Ada Lovelace",
                "payer_id": "payer-1",
                "payer_display_name": "Lovelace Family",
                "billing_plan_id": "plan-1",
                "plan_name": "Little Dragons",
                "plan_amount_cents": "12950",
                "plan_amount": "129.50",
                "plan_billing_interval": "monthly",
                "status": "active",
                "billing_status": "current",
                "collection_mode": "autopay",
                "start_date": "2026-01-01",
                "end_date": "",
                "next_bill_on": "2026-04-01",
                "created_at": "2026-01-01T17:00:00+00:00",
                "updated_at": "2026-03-01T17:00:00+00:00",
            },
        )
        self.assertEqual(rows[1]["student_name"], "Grace Hopper")
        self.assertNotIn("sub_1", body)
        self.assertNotIn("enr-other", body)

    def test_every_ledger_read_is_filtered_to_the_callers_studio(self):
        for report_id in LEDGER_IDS:
            for date_range in (None, ReportDateRange(date(2026, 3, 1), date(2026, 3, 8))):
                if date_range and report_id == "billing_enrollment_ledger":
                    continue
                with self.subTest(report_id=report_id, date_range=date_range):
                    supabase = TableBackedSupabase(billing_fixture())
                    _rows, body = build(supabase, report_id, date_range)

                    self.assertTrue(supabase.log)
                    for entry in supabase.log:
                        expected = (
                            ("eq", "id", "studio-1")
                            if entry["table"] == "studios"
                            else ("eq", "studio_id", "studio-1")
                        )
                        self.assertIn(expected, entry["filters"], entry)
                    for foreign in (
                        "studio-2",
                        "other",
                        "Other Payer",
                        "Other Plan",
                        "Other Studio",
                    ):
                        self.assertNotIn(foreign, body)

    def test_ledgers_never_request_or_emit_excluded_fields(self):
        for report_id in LEDGER_IDS:
            with self.subTest(report_id=report_id):
                supabase = TableBackedSupabase(billing_fixture())
                _rows, body = build(supabase, report_id)

                for entry in supabase.log:
                    selected = {column.strip() for column in entry["columns"].split(",")}
                    self.assertTrue(selected.isdisjoint(EXCLUDED_FIELDS), entry)
                for value in EXCLUDED_VALUES:
                    self.assertNotIn(value, body)

    def test_lookups_are_deduplicated_and_batched_by_200(self):
        fixture = billing_fixture()
        students = [
            {
                "id": f"student-{index:04d}",
                "studio_id": "studio-1",
                "legal_first_name": "Student",
                "legal_last_name": f"{index:04d}",
            }
            for index in range(450)
        ]
        fixture["students"] = students
        fixture["billing_invoices"] = [
            invoice(
                f"inv-{index:04d}",
                "2026-03-02T12:00:00+00:00",
                student_id=students[index % 450]["id"],
            )
            for index in range(900)
        ]
        supabase = TableBackedSupabase(fixture)
        service = ReportExportService(supabase)

        body, _ = asyncio.run(service.build_csv("billing_invoice_ledger", "studio-1"))

        self.assertEqual(len(list(csv.DictReader(StringIO(body)))), 900)
        student_batches = [len(entry["filters"][1][2]) for entry in queries(supabase, "students")]
        self.assertEqual(student_batches, [200, 200, 50])
        self.assertEqual(
            [entry["filters"][1][2] for entry in queries(supabase, "billing_payers")],
            [{"payer-1"}],
        )
        self.assertEqual(len(queries(supabase, "billing_invoices")), 1)
        self.assertEqual(service.budget_snapshot.provider_calls, 1 + 1 + 1 + 3 + 1 + 1)


class BillingLedgerDateRangeTest(unittest.TestCase):
    def test_invoice_range_is_inclusive_at_studio_local_midnight_across_dst(self):
        supabase = TableBackedSupabase(billing_fixture("America/Los_Angeles"))
        rows, _ = build(
            supabase,
            "billing_invoice_ledger",
            ReportDateRange(date(2026, 3, 1), date(2026, 3, 8)),
        )

        self.assertEqual(
            [row["invoice_id"] for row in rows],
            ["inv-last-instant", "inv-archived", "inv-blank-name", "inv-first-midnight"],
        )
        self.assertEqual(
            {row["created_date_local"] for row in rows},
            {"2026-03-01", "2026-03-05", "2026-03-08"},
        )
        invoice_query = queries(supabase, "billing_invoices")[0]
        # PST before the 8 March change, PDT after it.
        self.assertIn(("gte", "created_at", "2026-03-01T08:00:00+00:00"), invoice_query["filters"])
        self.assertIn(("lt", "created_at", "2026-03-09T07:00:00+00:00"), invoice_query["filters"])

    def test_open_ended_ranges_apply_one_bound(self):
        supabase = TableBackedSupabase(billing_fixture())
        since, _ = build(
            supabase, "billing_invoice_ledger", ReportDateRange(start=date(2026, 3, 9))
        )
        until, _ = build(supabase, "billing_invoice_ledger", ReportDateRange(end=date(2026, 2, 28)))

        self.assertEqual([row["invoice_id"] for row in since], ["inv-after"])
        self.assertEqual([row["invoice_id"] for row in until], ["inv-before"])

    def test_payment_range_uses_processed_at_then_created_at_and_links_old_parents(self):
        supabase = TableBackedSupabase(billing_fixture("America/Los_Angeles"))
        rows, _ = build(
            supabase,
            "billing_payment_ledger",
            ReportDateRange(date(2026, 3, 1), date(2026, 3, 8)),
        )

        self.assertEqual(
            [(row["record_type"], row["record_id"]) for row in rows],
            [
                ("payment", "pay-cash"),
                ("dispute", "dis-card"),
                ("refund", "ref-old"),
                ("refund", "ref-card"),
                ("payment", "pay-card"),
            ],
        )
        self.assertTrue(
            all("2026-03-01" <= row["event_date_local"] <= "2026-03-08" for row in rows)
        )
        old_refund = next(row for row in rows if row["record_id"] == "ref-old")
        self.assertEqual(old_refund["payment_id"], "pay-old")
        self.assertEqual(old_refund["invoice_id"], "inv-before")
        self.assertEqual(old_refund["payer_display_name"], "Lovelace Family")
        self.assertEqual(old_refund["currency"], "usd")
        self.assertEqual(old_refund["amount_cents"], "500")

        payment_queries = queries(supabase, "billing_payments")
        processed, unprocessed, parents = payment_queries
        self.assertIn(("gte", "processed_at", "2026-03-01T08:00:00+00:00"), processed["filters"])
        self.assertIn(("lt", "processed_at", "2026-03-09T07:00:00+00:00"), processed["filters"])
        self.assertIn(("is", "processed_at", "null"), unprocessed["filters"])
        self.assertIn(("gte", "created_at", "2026-03-01T08:00:00+00:00"), unprocessed["filters"])
        self.assertIn(("lt", "created_at", "2026-03-09T07:00:00+00:00"), unprocessed["filters"])
        self.assertEqual(parents["columns"], "id, invoice_id, payer_id, currency")
        self.assertIn(("in", "id", {"pay-old"}), parents["filters"])
        for table in ("billing_refunds", "billing_disputes"):
            query = queries(supabase, table)[0]
            self.assertIn(("gte", "created_at", "2026-03-01T08:00:00+00:00"), query["filters"])
            self.assertIn(("lt", "created_at", "2026-03-09T07:00:00+00:00"), query["filters"])

    def test_local_date_recheck_drops_rows_the_utc_bounds_admit_at_a_midnight_gap(self):
        # Chile springs forward at local midnight on 6 September 2026, so the
        # widened lower bound admits an instant that is still 5 September there.
        fixture = billing_fixture("America/Santiago")
        fixture["billing_invoices"] = [
            invoice("inv-previous-day", "2026-09-06T03:30:00+00:00"),
            invoice("inv-first-instant", "2026-09-06T04:00:00+00:00"),
        ]
        supabase = TableBackedSupabase(fixture)
        rows, _ = build(
            supabase,
            "billing_invoice_ledger",
            ReportDateRange(date(2026, 9, 6), date(2026, 9, 6)),
        )

        self.assertEqual([row["invoice_id"] for row in rows], ["inv-first-instant"])
        self.assertEqual(rows[0]["created_date_local"], "2026-09-06")
        lower = queries(supabase, "billing_invoices")[0]["filters"][1]
        self.assertEqual(lower, ("gte", "created_at", "2026-09-06T03:00:00+00:00"))

    def test_studio_clock_falls_back_to_utc_for_unknown_zones(self):
        clock = StudioClock(studio_zone("Not/AZone"))
        self.assertEqual(
            clock.range_filters("created_at", ReportDateRange(date(2026, 3, 1), date(2026, 3, 1))),
            (
                ("gte", "created_at", "2026-03-01T00:00:00+00:00"),
                ("lt", "created_at", "2026-03-02T00:00:00+00:00"),
            ),
        )
        self.assertEqual(clock.local_date("2026-03-01T23:59:59Z"), date(2026, 3, 1))


class BillingLedgerEndpointTest(unittest.TestCase):
    def test_admin_downloads_a_ranged_ledger_and_the_export_is_audited(self):
        supabase = TableBackedSupabase(billing_fixture())

        response = admin_export(
            supabase, "billing_invoice_ledger", date_from="2026-03-01", date_to="2026-03-08"
        )
        body = asyncio.run(consume(response))

        self.assertTrue(body.startswith(",".join(INVOICE_LEDGER_COLUMNS).encode() + b"\r\n"))
        self.assertEqual(response.headers["Content-Length"], str(len(body)))
        self.assertIn('filename="billing-invoice-ledger-', response.headers["Content-Disposition"])
        audit = supabase.tables["audit_logs"][0]
        self.assertEqual(audit["studio_id"], "studio-1")
        self.assertEqual(audit["actor_id"], "user-1")
        self.assertEqual(audit["action"], "report.exported")
        self.assertEqual(audit["metadata"]["report_id"], "billing_invoice_ledger")
        self.assertEqual(audit["metadata"]["filename"], "billing-invoice-ledger.csv")
        self.assertTrue(audit["metadata"]["contains_sensitive_data"])
        self.assertEqual(audit["metadata"]["min_role"], "admin")
        self.assertEqual(audit["metadata"]["row_count"], 4)
        self.assertEqual(
            audit["metadata"]["date_range"], {"from": "2026-03-01", "to": "2026-03-08"}
        )

    def test_admin_downloads_unranged_ledgers_without_range_metadata(self):
        for report_id in LEDGER_IDS:
            with self.subTest(report_id=report_id):
                supabase = TableBackedSupabase(billing_fixture())
                response = admin_export(supabase, report_id)
                body = asyncio.run(consume(response))

                self.assertGreater(body.count(b"\r\n"), 1)
                metadata = supabase.tables["audit_logs"][0]["metadata"]
                self.assertEqual(metadata["report_id"], report_id)
                self.assertNotIn("date_range", metadata)

    def test_front_desk_and_instructor_are_refused_before_billing_reads_or_audit(self):
        for role in ("front_desk", "instructor"):
            for report_id in LEDGER_IDS:
                with self.subTest(role=role, report_id=report_id):
                    supabase = TableBackedSupabase(billing_fixture())
                    with self.assertRaises(HTTPException) as context:
                        admin_export(supabase, report_id, role=role, date_from="2026-03-01")

                    self.assertEqual(context.exception.status_code, 403)
                    self.assertEqual(supabase.tables["audit_logs"], [])
                    self.assertFalse(
                        any(entry["table"] in BILLING_TABLES for entry in supabase.log)
                    )

    def test_bad_ranges_are_plain_400s_before_reads_or_audit(self):
        cases = (
            (
                "billing_invoice_ledger",
                {"date_from": "2026-03-09", "date_to": "2026-03-08"},
                "The from date must be on or before the to date.",
            ),
            (
                "billing_payment_ledger",
                {"date_from": "2026-02-30"},
                "The from date must be a real date written as YYYY-MM-DD.",
            ),
            (
                "billing_payment_ledger",
                {"date_to": "03/08/2026"},
                "The to date must be a real date written as YYYY-MM-DD.",
            ),
            (
                "billing_invoice_ledger",
                {"date_to": "20260308"},
                "The to date must be a real date written as YYYY-MM-DD.",
            ),
            (
                "billing_invoice_ledger",
                {"date_from": ""},
                "The from date must be a real date written as YYYY-MM-DD.",
            ),
            (
                "billing_enrollment_ledger",
                {"date_from": "2026-03-01"},
                "This report does not take a date range.",
            ),
            (
                "students",
                {"date_to": "2026-03-01"},
                "This report does not take a date range.",
            ),
        )
        for report_id, params, detail in cases:
            with self.subTest(report_id=report_id, params=params):
                supabase = TableBackedSupabase(billing_fixture())
                with self.assertRaises(HTTPException) as context:
                    admin_export(supabase, report_id, **params)

                self.assertEqual(context.exception.status_code, 400)
                self.assertEqual(context.exception.detail, detail)
                self.assertEqual(supabase.log, [])
                self.assertEqual(supabase.tables["audit_logs"], [])

    def test_http_query_names_are_from_and_to(self):
        supabase = TableBackedSupabase(billing_fixture())
        app = FastAPI()
        app.include_router(reports.router)
        app.dependency_overrides[get_current_user_id] = lambda: "user-1"
        app.dependency_overrides[get_requested_studio_id] = lambda: "studio-1"
        app.dependency_overrides[get_supabase] = lambda: supabase

        with (
            patch(
                "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
                return_value={"studio_id": "studio-1", "role": "admin"},
            ),
            TestClient(app) as client,
        ):
            ranged = client.get(
                "/reports/exports/billing_payment_ledger",
                params={"from": "2026-03-01", "to": "2026-03-08"},
            )
            reversed_range = client.get(
                "/reports/exports/billing_payment_ledger",
                params={"from": "2026-03-09", "to": "2026-03-08"},
            )

        self.assertEqual(ranged.status_code, 200)
        self.assertEqual(len(list(csv.DictReader(StringIO(ranged.text)))), 5)
        self.assertEqual(reversed_range.status_code, 400)
        self.assertEqual(
            reversed_range.json()["detail"], "The from date must be on or before the to date."
        )
        self.assertEqual(len(supabase.tables["audit_logs"]), 1)

    def test_service_refuses_a_range_for_reports_without_one(self):
        supabase = TableBackedSupabase(billing_fixture())
        with self.assertRaises(HTTPException) as context:
            asyncio.run(
                ReportExportService(supabase).build_csv(
                    "billing_enrollment_ledger",
                    "studio-1",
                    date_range=ReportDateRange(start=date(2026, 3, 1)),
                )
            )

        self.assertEqual(context.exception.status_code, 400)
        self.assertEqual(supabase.log, [])


if __name__ == "__main__":
    unittest.main()
