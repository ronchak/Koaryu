import asyncio
import csv
import unittest
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.api.v1.endpoints.reports import export_report_csv
from app.services.report_export_catalog_billing_tables import build_billing_table_report_catalog
from app.services.report_export_catalog_operations import build_operations_report_catalog
from app.services.report_export_data import ReportExportDataFetcher
from app.services.report_export_service import ReportExportService, require_report_export_access
from tests.fakes.supabase import TableBackedSupabase


def student_row(index: int, *, studio_id: str = "studio-1") -> dict:
    return {
        "id": f"s-{index:04d}",
        "studio_id": studio_id,
        "legal_first_name": f"First {index:04d}",
        "legal_last_name": "Student",
        "preferred_name": None,
        "date_of_birth": None,
        "is_minor": False,
        "email": None,
        "phone": None,
        "emergency_contact_name": None,
        "emergency_contact_phone": None,
        "emergency_contact_relation": None,
        "status": "active",
        "membership_start_date": "2026-01-01",
        "program_id": None,
        "current_belt_rank_id": None,
        "tags": [],
        "deleted_at": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


def staff_role_row(
    role_id: str,
    *,
    studio_id: str = "studio-1",
    user_id: str | None,
    created_at: str,
) -> dict:
    return {
        "id": role_id,
        "studio_id": studio_id,
        "user_id": user_id,
        "role": "instructor",
        "invited_by": "admin-1",
        "invited_email": f"{role_id}@invite.example",
        "created_at": created_at,
        "updated_at": created_at,
    }


def auth_user(user_id: str, *, email: str, display_name: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=user_id,
        email=email,
        user_metadata={"full_name": display_name},
        confirmed_at="2026-01-02T00:00:00Z",
        email_confirmed_at="2026-01-02T00:00:00Z",
        last_sign_in_at="2026-01-03T00:00:00Z",
    )


def postgrest_error(code: str) -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": code,
        "message": "postgrest failure",
        "details": "",
        "hint": "",
    })


class StaffExportAuthAdmin:
    def __init__(self, supabase: "StaffExportSupabase"):
        self.supabase = supabase

    def get_user_by_id(self, user_id: str):
        self.supabase.auth_get_calls.append(user_id)
        return SimpleNamespace(user=self.supabase.auth_users.get(user_id))


class StaffExportSupabase(TableBackedSupabase):
    def __init__(
        self,
        tables: dict[str, list[dict]] | None = None,
        *,
        auth_users: dict[str, SimpleNamespace] | None = None,
    ):
        super().__init__(tables)
        self.auth_users = auth_users or {}
        self.auth_get_calls: list[str] = []
        self.auth = SimpleNamespace(admin=StaffExportAuthAdmin(self))


class ReportExportServiceTest(unittest.TestCase):
    def test_deferred_billing_reports_are_not_in_available_catalog(self):
        service = ReportExportService(TableBackedSupabase({}))
        deferred_reports = build_billing_table_report_catalog(ReportExportService)

        self.assertTrue(deferred_reports)
        self.assertTrue(all(
            report.availability == "deferred_billing"
            for report in deferred_reports.values()
        ))
        self.assertTrue(set(deferred_reports).isdisjoint(
            report.id for report in service.list_reports()
        ))

        for report_id in deferred_reports:
            with self.subTest(report_id=report_id), self.assertRaises(HTTPException) as context:
                service.get_report(report_id)
            self.assertEqual(context.exception.status_code, 404)

    def test_staff_roles_catalog_uses_legal_name_columns(self):
        report = build_operations_report_catalog(ReportExportService)["staff_roles"]
        self.assertEqual(
            report.columns[3:6],
            ("email", "legal_first_name", "legal_last_name"),
        )
        self.assertNotIn("full_name", report.columns)

        csv_text, _ = asyncio.run(
            ReportExportService(StaffExportSupabase({})).build_csv(
                "staff_roles", "studio-1"
            )
        )
        self.assertEqual(
            next(csv.reader(StringIO(csv_text))),
            list(report.columns),
        )

    def test_staff_roles_export_hydrates_legal_names_in_one_studio_scoped_batch(self):
        supabase = StaffExportSupabase(
            {
                "staff_roles": [
                    staff_role_row(
                        "role-1",
                        user_id="user-1",
                        created_at="2026-01-01T00:00:00Z",
                    ),
                    staff_role_row(
                        "cross-role",
                        studio_id="studio-2",
                        user_id="user-cross",
                        created_at="2026-01-02T00:00:00Z",
                    ),
                    staff_role_row(
                        "role-2",
                        user_id="user-2",
                        created_at="2026-01-03T00:00:00Z",
                    ),
                    staff_role_row(
                        "pending-role",
                        user_id=None,
                        created_at="2026-01-04T00:00:00Z",
                    ),
                ],
                "staff_profiles": [
                    {
                        "user_id": "user-1",
                        "legal_first_name": "Legal One",
                        "legal_last_name": "Family One",
                    },
                    {
                        "user_id": "user-2",
                        "legal_first_name": "Legal Two",
                        "legal_last_name": "Family Two",
                    },
                    {
                        "user_id": "user-cross",
                        "legal_first_name": "Cross Studio",
                        "legal_last_name": "Must Not Export",
                    },
                ],
            },
            auth_users={
                "user-1": auth_user(
                    "user-1",
                    email="auth-one@example.com",
                    display_name="Cosmetic Display One",
                ),
                "user-2": auth_user(
                    "user-2",
                    email="auth-two@example.com",
                    display_name="Cosmetic Display Two",
                ),
                "user-cross": auth_user(
                    "user-cross",
                    email="cross@example.com",
                    display_name="Cross Display",
                ),
            },
        )

        csv_text, _ = asyncio.run(
            ReportExportService(supabase).build_csv("staff_roles", "studio-1")
        )
        rows = list(csv.DictReader(StringIO(csv_text)))

        self.assertEqual([row["id"] for row in rows], ["role-1", "role-2", "pending-role"])
        self.assertEqual(rows[0]["legal_first_name"], "Legal One")
        self.assertEqual(rows[0]["legal_last_name"], "Family One")
        self.assertEqual(rows[0]["email"], "auth-one@example.com")
        self.assertEqual(rows[0]["status"], "active")
        self.assertEqual(rows[2]["legal_first_name"], "")
        self.assertEqual(rows[2]["legal_last_name"], "")
        self.assertNotIn("full_name", rows[0])
        self.assertNotIn("Cosmetic Display One", csv_text)
        self.assertNotIn("Cosmetic Display Two", csv_text)
        self.assertNotIn("Cross Display", csv_text)

        role_queries = [query for query in supabase.log if query["table"] == "staff_roles"]
        self.assertEqual(len(role_queries), 1)
        self.assertIn(("eq", "studio_id", "studio-1"), role_queries[0]["filters"])

        profile_queries = [
            query for query in supabase.log if query["table"] == "staff_profiles"
        ]
        self.assertEqual(len(profile_queries), 1)
        self.assertEqual(
            profile_queries[0]["filters"],
            (("in", "user_id", {"user-1", "user-2"}),),
        )
        self.assertEqual(supabase.auth_get_calls, ["user-1", "user-2"])

    def test_staff_roles_export_leaves_missing_profiles_blank(self):
        supabase = StaffExportSupabase(
            {
                "staff_roles": [staff_role_row(
                    "role-1",
                    user_id="user-1",
                    created_at="2026-01-01T00:00:00Z",
                )],
                "staff_profiles": [],
            },
            auth_users={
                "user-1": auth_user(
                    "user-1",
                    email="auth@example.com",
                    display_name="Cosmetic Only",
                ),
            },
        )

        csv_text, _ = asyncio.run(
            ReportExportService(supabase).build_csv("staff_roles", "studio-1")
        )
        row = next(csv.DictReader(StringIO(csv_text)))

        self.assertEqual(row["legal_first_name"], "")
        self.assertEqual(row["legal_last_name"], "")
        self.assertNotIn("Cosmetic Only", csv_text)

    def test_staff_roles_export_degrades_for_missing_profile_schema(self):
        for code in ("42P01", "42703", "PGRST204", "PGRST205"):
            with self.subTest(code=code):
                supabase = StaffExportSupabase(
                    {
                        "staff_roles": [staff_role_row(
                            "role-1",
                            user_id="user-1",
                            created_at="2026-01-01T00:00:00Z",
                        )],
                    },
                    auth_users={
                        "user-1": auth_user(
                            "user-1",
                            email="auth@example.com",
                            display_name="Cosmetic Only",
                        ),
                    },
                )
                supabase.table_failures["staff_profiles"] = postgrest_error(code)

                csv_text, _ = asyncio.run(
                    ReportExportService(supabase).build_csv("staff_roles", "studio-1")
                )
                row = next(csv.DictReader(StringIO(csv_text)))

                self.assertEqual(row["legal_first_name"], "")
                self.assertEqual(row["legal_last_name"], "")

    def test_staff_roles_export_propagates_unrelated_profile_errors(self):
        supabase = StaffExportSupabase(
            {
                "staff_roles": [staff_role_row(
                    "role-1",
                    user_id="user-1",
                    created_at="2026-01-01T00:00:00Z",
                )],
            },
            auth_users={
                "user-1": auth_user(
                    "user-1",
                    email="auth@example.com",
                    display_name="Cosmetic Only",
                ),
            },
        )
        failure = postgrest_error("PGRST000")
        supabase.table_failures["staff_profiles"] = failure

        with self.assertRaises(PostgrestAPIError) as raised:
            asyncio.run(
                ReportExportService(supabase).build_csv("staff_roles", "studio-1")
            )

        self.assertIs(raised.exception, failure)

    def test_staff_roles_export_does_not_query_profiles_for_empty_roles(self):
        supabase = StaffExportSupabase({"staff_roles": []})
        supabase.table_failures["staff_profiles"] = postgrest_error("PGRST000")

        csv_text, _ = asyncio.run(
            ReportExportService(supabase).build_csv("staff_roles", "studio-1")
        )

        self.assertEqual(len(list(csv.DictReader(StringIO(csv_text)))), 0)
        self.assertFalse(any(query["table"] == "staff_profiles" for query in supabase.log))

    def test_table_report_export_pages_rows(self):
        rows = [student_row(index) for index in range(1005)]
        rows.append(student_row(9999, studio_id="studio-2"))
        supabase = TableBackedSupabase({"students": rows})
        service = ReportExportService(supabase)

        csv_text, filename = asyncio.run(service.build_csv("students", "studio-1"))

        self.assertEqual(filename, "students.csv")
        lines = csv_text.splitlines()
        self.assertEqual(len(lines), 1006)
        self.assertTrue(lines[0].startswith("id,studio_id"))
        self.assertTrue(lines[1].startswith("s-0000,studio-1"))
        student_queries = [entry for entry in supabase.log if entry["table"] == "students"]
        self.assertEqual([entry["range"] for entry in student_queries], [(0, 999), (1000, 1999)])
        self.assertEqual(
            student_queries[0]["orders"],
            (("legal_last_name", False), ("legal_first_name", False), ("id", False)),
        )

    def test_paged_rows_rejects_exports_above_cap(self):
        supabase = TableBackedSupabase({
            "students": [student_row(index) for index in range(4)],
        })
        fetcher = ReportExportDataFetcher(supabase)

        with self.assertRaises(HTTPException) as context:
            fetcher._paged_rows(
                lambda: supabase.table("students").select("*").eq("studio_id", "studio-1"),
                page_size=2,
                max_rows=3,
            )

        self.assertEqual(context.exception.status_code, 413)
        self.assertIn("Export is too large", context.exception.detail)
        student_queries = [entry for entry in supabase.log if entry["table"] == "students"]
        self.assertEqual([entry["range"] for entry in student_queries], [(0, 1), (2, 3)])

    def test_intelligence_dataset_fetch_pages_rows_and_relationships(self):
        students = [student_row(index) for index in range(1005)]
        relationships = [
            {"id": f"sg-{index:04d}", "student_id": "s-0000", "guardian_id": f"g-{index:04d}"}
            for index in range(1205)
        ]
        supabase = TableBackedSupabase({
            "students": students,
            "student_guardians": relationships,
        })
        service = ReportExportService(supabase)

        dataset = service._fetch_intelligence_dataset("studio-1")

        self.assertEqual(len(dataset["students"]), 1005)
        self.assertEqual(len(dataset["student_guardians"]), 1205)
        student_queries = [entry for entry in supabase.log if entry["table"] == "students"]
        self.assertEqual([entry["range"] for entry in student_queries], [(0, 999), (1000, 1999)])
        self.assertEqual(student_queries[0]["orders"], (("id", False),))
        guardian_queries = [entry for entry in supabase.log if entry["table"] == "student_guardians"]
        self.assertGreaterEqual(len(guardian_queries), 2)
        self.assertEqual([entry["range"] for entry in guardian_queries[:2]], [(0, 999), (1000, 1999)])

    def test_report_export_access_is_report_specific(self):
        service = ReportExportService(TableBackedSupabase({}))
        students_report = service.get_report("students")
        class_sessions_report = service.get_report("class_sessions")

        with self.assertRaises(HTTPException) as context:
            require_report_export_access(students_report, "front_desk")

        self.assertEqual(context.exception.status_code, 403)
        require_report_export_access(students_report, "admin")
        require_report_export_access(class_sessions_report, "front_desk")

    def test_export_report_csv_audits_sensitive_admin_export(self):
        supabase = TableBackedSupabase({
            "students": [student_row(1)],
            "audit_logs": [],
        })

        with patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ):
            response = asyncio.run(export_report_csv(
                "students",
                user_id="user-1",
                requested_studio_id="studio-1",
                supabase=supabase,
            ))

        self.assertIn(b"s-0001", response.body)
        self.assertEqual(response.headers["Cache-Control"], "no-store, private")
        self.assertEqual(response.headers["Vary"], "Authorization, X-Studio-Id, Cookie")
        audit = supabase.tables["audit_logs"][0]
        self.assertEqual(audit["studio_id"], "studio-1")
        self.assertEqual(audit["actor_id"], "user-1")
        self.assertEqual(audit["action"], "report.exported")
        self.assertEqual(audit["entity_type"], "report")
        self.assertIsNone(audit["entity_id"])
        self.assertEqual(audit["metadata"]["report_id"], "students")
        self.assertEqual(audit["metadata"]["filename"], "students.csv")
        self.assertTrue(audit["metadata"]["contains_sensitive_data"])
        self.assertEqual(audit["metadata"]["row_count"], 1)

    def test_export_report_csv_rejects_front_desk_sensitive_export_before_audit(self):
        supabase = TableBackedSupabase({
            "students": [student_row(1)],
            "audit_logs": [],
        })

        with patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "front_desk"},
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(export_report_csv(
                    "students",
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=supabase,
                ))

        self.assertEqual(context.exception.status_code, 403)
        self.assertEqual(supabase.tables["audit_logs"], [])
        self.assertFalse(any(query["table"] == "students" for query in supabase.log))

    def test_export_report_csv_rejects_instructor_before_data_or_audit(self):
        supabase = TableBackedSupabase({
            "students": [student_row(1)],
            "audit_logs": [],
        })

        with patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "instructor"},
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(export_report_csv(
                    "students",
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=supabase,
                ))

        self.assertEqual(context.exception.status_code, 403)
        self.assertEqual(supabase.tables["audit_logs"], [])
        self.assertFalse(any(query["table"] == "students" for query in supabase.log))

    def test_export_report_csv_rejects_deferred_billing_report_before_data_or_audit(self):
        supabase = TableBackedSupabase({
            "billing_payments": [{"id": "payment-1", "studio_id": "studio-1"}],
            "audit_logs": [],
        })

        with patch(
            "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
            return_value={"studio_id": "studio-1", "role": "admin"},
        ):
            with self.assertRaises(HTTPException) as context:
                asyncio.run(export_report_csv(
                    "billing_payments",
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=supabase,
                ))

        self.assertEqual(context.exception.status_code, 404)
        self.assertEqual(supabase.tables["audit_logs"], [])
        self.assertFalse(any(query["table"] == "billing_payments" for query in supabase.log))

    def test_export_report_csv_does_not_audit_completion_when_generation_fails(self):
        supabase = TableBackedSupabase({
            "students": [student_row(1)],
            "audit_logs": [],
        })

        with (
            patch(
                "app.api.v1.endpoints.reports.resolve_staff_role_for_user",
                return_value={"studio_id": "studio-1", "role": "admin"},
            ),
            patch.object(
                ReportExportService,
                "build_csv_for_report",
                side_effect=RuntimeError("export failed"),
            ),
        ):
            with self.assertRaises(RuntimeError):
                asyncio.run(export_report_csv(
                    "students",
                    user_id="user-1",
                    requested_studio_id="studio-1",
                    supabase=supabase,
                ))

        self.assertEqual(supabase.tables["audit_logs"], [])


if __name__ == "__main__":
    unittest.main()
