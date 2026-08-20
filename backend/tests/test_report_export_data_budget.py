import asyncio
import csv
import json
import unittest
from io import StringIO
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException

from app.services.report_export_budget import (
    EXPORT_MAX_PROVIDER_CALLS,
    EXPORT_MAX_ROWS,
    ReportExportBudget,
)
from app.services.report_export_catalog import build_report_catalog
from app.services.report_export_catalog_types import REPORT_SOURCE_SPECS
from app.services.report_export_data import INTELLIGENCE_INPUT_COLUMNS, ReportExportDataFetcher
from app.services.report_export_service import ReportExportService
from tests.fakes.supabase import TableBackedSupabase


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "report_exports" / "intelligence_source_columns.json"
EXPECTED_COLUMNS = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

# Explicitly bounded to relations reachable from the Worker 2 report source
# vocabulary. This is a review contract, not a general SQL schema parser.
MIGRATION_BACKED_SOURCE_COLUMNS = {
    "attendance": {"id", "studio_id", "session_id", "student_id", "status", "checked_in_at"},
    "belt_ladders": {"id", "studio_id", "program_id"},
    "belt_ranks": {"id", "studio_id", "ladder_id", "name", "display_order", "min_classes", "min_months", "requires_approval"},
    "billing_invoices": {"id", "studio_id", "student_id", "payer_id", "status", "amount_due_cents", "amount_paid_cents"},
    "billing_payers": {"id", "studio_id", "display_name", "email", "phone", "billing_status", "balance_cents"},
    "billing_payments": {"id", "studio_id", "payer_id", "invoice_id", "status", "amount_cents", "created_at"},
    "billing_plans": {"id", "studio_id", "amount_cents", "billing_interval"},
    "class_sessions": {"id", "studio_id", "program_id", "instructor_id", "name", "start_time", "date", "deleted_at", "status", "capacity"},
    "guardians": {"id", "studio_id", "first_name", "last_name", "email", "phone"},
    "leads": {"id", "studio_id", "source", "stage", "converted_student_id", "assigned_staff_id", "follow_up_date", "created_at"},
    "programs": {"id", "studio_id", "name"},
    "promotions": {"id", "studio_id", "student_id", "student_program_membership_id", "program_id", "promoted_at"},
    "staff_profiles": {"user_id", "legal_first_name", "legal_last_name"},
    "student_billing_enrollments": {"id", "studio_id", "student_id", "payer_id", "billing_plan_id", "status", "billing_status", "next_bill_on", "created_at"},
    "student_guardians": {"id", "student_id", "guardian_id"},
    "student_program_memberships": {"id", "studio_id", "student_id", "program_id", "status", "current_belt_rank_id", "started_at"},
    "students": {"id", "studio_id", "legal_first_name", "legal_last_name", "preferred_name", "status", "membership_start_date", "deleted_at", "created_at", "is_minor", "emergency_contact_name", "program_id", "current_belt_rank_id"},
}


class ReportExportDataBudgetTest(unittest.TestCase):
    def test_manifest_covers_exactly_each_intelligence_report_source_pair(self):
        catalog = build_report_catalog(ReportExportService)
        expected_ids = set(EXPECTED_COLUMNS)
        intelligence_ids = {
            report.id
            for report in catalog.values()
            if report.custom_builder
            and report.id not in {"studio_overview", "guardian_contacts", "staff_roles"}
        }
        self.assertEqual(expected_ids, intelligence_ids)

        for report_id, expected_sources in EXPECTED_COLUMNS.items():
            with self.subTest(report_id=report_id):
                report = catalog[report_id]
                self.assertEqual(list(report.source_keys), list(expected_sources))
                self.assertEqual(
                    expected_sources,
                    {key: list(columns) for key, columns in INTELLIGENCE_INPUT_COLUMNS[report_id].items()},
                )

    def test_each_intelligence_report_queries_only_declared_relations_and_columns(self):
        catalog = build_report_catalog(ReportExportService)
        for report_id in EXPECTED_COLUMNS:
            with self.subTest(report_id=report_id):
                supabase = TableBackedSupabase({
                    "students": [{"id": "student-1", "studio_id": "studio-1"}],
                    "student_guardians": [{
                        "id": "link-1",
                        "student_id": "student-1",
                        "guardian_id": "guardian-1",
                    }],
                })
                dataset = ReportExportDataFetcher(supabase).fetch_intelligence_dataset(
                    catalog[report_id], "studio-1"
                )
                expected_tables = [
                    REPORT_SOURCE_SPECS[source_key].relation
                    for source_key in catalog[report_id].source_keys
                    if source_key != "student_guardians" or dataset.get(source_key)
                ]
                self.assertEqual(expected_tables, [entry["table"] for entry in supabase.log])
                self.assertEqual(set(dataset), set(catalog[report_id].source_keys))
                for entry in supabase.log:
                    source_key = next(
                        key for key in catalog[report_id].source_keys
                        if REPORT_SOURCE_SPECS[key].relation == entry["table"]
                    )
                    self.assertEqual(
                        tuple(part.strip() for part in entry["columns"].split(",")),
                        tuple(EXPECTED_COLUMNS[report_id][source_key]),
                    )

    def test_manifest_columns_are_migration_backed_for_report_source_vocabulary(self):
        catalog = build_report_catalog(ReportExportService)
        for report_id, source_columns in INTELLIGENCE_INPUT_COLUMNS.items():
            with self.subTest(report_id=report_id):
                report = catalog[report_id]
                for source_key, columns in source_columns.items():
                    with self.subTest(source_key=source_key):
                        relation = REPORT_SOURCE_SPECS[source_key].relation
                        self.assertIn(relation, MIGRATION_BACKED_SOURCE_COLUMNS)
                        self.assertEqual(
                            set(columns) - MIGRATION_BACKED_SOURCE_COLUMNS[relation],
                            set(),
                            f"{report.id}/{source_key} declares non-migration column(s)",
                        )

    def test_shared_row_budget_spans_tables_and_student_guardian_batches(self):
        students = [
            {"id": f"student-{index}", "studio_id": "studio-1"}
            for index in range(25_000)
        ]
        relationships = [
            {"id": f"link-{index}", "student_id": f"student-{index}", "guardian_id": "guardian-1"}
            for index in range(25_000)
        ]

        success_service = ReportExportService(TableBackedSupabase({
            "students": students,
            "student_guardians": relationships,
        }))
        asyncio.run(success_service.build_csv("family_account_health", "studio-1"))
        success_snapshot = success_service.budget_snapshot
        self.assertEqual(success_snapshot.max_rows, EXPORT_MAX_ROWS)
        self.assertEqual(success_snapshot.fetched_rows, EXPORT_MAX_ROWS)

        relationships.append({
            "id": "link-over-cap",
            "student_id": "student-0",
            "guardian_id": "guardian-1",
        })
        failure_service = ReportExportService(TableBackedSupabase({
            "students": students,
            "student_guardians": relationships,
        }))
        with self.assertRaises(HTTPException) as context:
            asyncio.run(failure_service.build_csv("family_account_health", "studio-1"))
        self.assertEqual(context.exception.status_code, 413)
        self.assertEqual(
            context.exception.detail,
            "Export is too large. Apply filters or request an async export.",
        )
        self.assertEqual(failure_service.budget_snapshot.fetched_rows, EXPORT_MAX_ROWS + 1)

    def test_provider_call_321_is_rejected_before_execution_and_budget_survives_new_fetcher(self):
        supabase = TableBackedSupabase({})
        budget = ReportExportBudget()
        first_fetcher = ReportExportDataFetcher(supabase, budget=budget)
        for _ in range(EXPORT_MAX_PROVIDER_CALLS):
            self.assertEqual(
                first_fetcher._paged_rows(
                    lambda: supabase.table("students").select("id"),
                    page_size=1,
                ),
                [],
            )

        second_fetcher = ReportExportDataFetcher(supabase, budget=budget)
        with self.assertRaises(HTTPException) as context:
            second_fetcher._paged_rows(
                lambda: supabase.table("students").select("id"),
                page_size=1,
            )
        self.assertEqual(context.exception.status_code, 413)
        self.assertEqual(len(supabase.log), EXPORT_MAX_PROVIDER_CALLS)
        snapshot = budget.snapshot()
        self.assertEqual(snapshot.provider_calls, EXPORT_MAX_PROVIDER_CALLS)
        self.assertEqual(snapshot.fetched_rows, 0)

    def test_custom_report_sources_share_one_budget(self):
        supabase = TableBackedSupabase({
            "studios": [{"id": "studio-1"}],
            "studio_subscriptions": [{"studio_id": "studio-1"}],
            "studio_payment_accounts": [{"studio_id": "studio-1"}],
        })
        service = ReportExportService(supabase)
        asyncio.run(service.build_csv("studio_overview", "studio-1"))
        snapshot = service.budget_snapshot
        self.assertEqual(snapshot.provider_calls, 3)
        self.assertEqual(snapshot.fetched_rows, 3)

    def test_staff_roles_batches_auth_users_and_treats_page_error_as_missing(self):
        class AuthAdmin:
            def __init__(self, owner):
                self.owner = owner

            def get_user_by_id(self, _user_id):
                raise AssertionError("report export must not issue per-user auth lookups")

            def list_users(self, *, page, per_page):
                self.owner.auth_pages.append((page, per_page))
                if page == 2:
                    raise RuntimeError("synthetic auth page failure")
                return self.owner.auth_users[:per_page]

        class Supabase(TableBackedSupabase):
            def __init__(self):
                super().__init__({
                    "staff_roles": [
                        {
                            "id": "role-1", "studio_id": "studio-1", "user_id": "user-1",
                            "role": "instructor", "archived_at": None, "invited_by": "admin-1",
                            "invited_email": "invite-1@example.com", "created_at": "2026-01-01",
                            "updated_at": "2026-01-01",
                        },
                        {
                            "id": "role-2", "studio_id": "studio-1", "user_id": "user-2",
                            "role": "front_desk", "archived_at": None, "invited_by": "admin-1",
                            "invited_email": "invite-2@example.com", "created_at": "2026-01-02",
                            "updated_at": "2026-01-02",
                        },
                    ],
                    "staff_profiles": [
                        {"user_id": "user-1", "legal_first_name": "Legal", "legal_last_name": "One"},
                        {"user_id": "user-2", "legal_first_name": "Legal", "legal_last_name": "Two"},
                    ],
                })
                self.auth_pages = []
                self.auth_users = [
                    SimpleNamespace(
                        id="user-1", email="one@example.com", user_metadata={},
                        confirmed_at="2026-01-01", email_confirmed_at="2026-01-01",
                        last_sign_in_at="2026-02-01",
                    )
                ] + [SimpleNamespace(id=f"unrelated-{i}") for i in range(999)]
                self.auth = SimpleNamespace(admin=AuthAdmin(self))

        supabase = Supabase()
        csv_text, _ = asyncio.run(ReportExportService(supabase).build_csv("staff_roles", "studio-1"))
        self.assertIn("one@example.com", csv_text)
        self.assertIn("invite-2@example.com", csv_text)
        self.assertIn("Legal,One", csv_text.replace(" ", ""))
        self.assertIn("Legal,Two", csv_text.replace(" ", ""))
        self.assertEqual(supabase.auth_pages, [(1, 1000), (2, 1000)])

    def test_staff_roles_excludes_archived_rows_and_filters_archived_at(self):
        class AuthAdmin:
            def get_user_by_id(self, _user_id):
                raise AssertionError("report export must not issue per-user auth lookups")

            def list_users(self, *, page, per_page):
                self.pages.append((page, per_page))
                return []

        class Supabase(TableBackedSupabase):
            def __init__(self):
                super().__init__({
                    "staff_roles": [
                        {
                            "id": "active-role", "studio_id": "studio-1", "user_id": "active-user",
                            "role": "instructor", "archived_at": None, "invited_by": "admin-1",
                            "invited_email": "active@example.com", "created_at": "2026-01-01",
                            "updated_at": "2026-01-01",
                        },
                        {
                            "id": "archived-role", "studio_id": "studio-1", "user_id": "archived-user",
                            "role": "front_desk", "archived_at": "2026-01-02T00:00:00+00:00",
                            "invited_by": "admin-1", "invited_email": "archived@example.com",
                            "created_at": "2026-01-02", "updated_at": "2026-01-02",
                        },
                    ],
                    "staff_profiles": [],
                })
                self.auth_admin = AuthAdmin()
                self.auth_admin.pages = []
                self.auth = SimpleNamespace(admin=self.auth_admin)

        supabase = Supabase()
        csv_text, _ = asyncio.run(
            ReportExportService(supabase).build_csv("staff_roles", "studio-1")
        )

        rows = list(csv.DictReader(StringIO(csv_text)))
        self.assertEqual([row["id"] for row in rows], ["active-role"])
        role_queries = [
            query for query in supabase.query_log
            if query["table"] == "staff_roles"
        ]
        self.assertTrue(role_queries)
        self.assertTrue(
            all(("is", "archived_at", None) in query["filters"] for query in role_queries)
        )


if __name__ == "__main__":
    unittest.main()
