import asyncio
import unittest

from fastapi import HTTPException

from app.services.report_export_data import ReportExportDataFetcher
from app.services.report_export_service import ReportExportService
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


class ReportExportServiceTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
