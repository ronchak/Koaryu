import unittest
import uuid

from app.services.student_import_guardians import StudentImportGuardianWriter
from tests.fakes.supabase import TableBackedSupabase


IMPORT_RUN_ID = "00000000-0000-0000-0000-000000000001"


class StudentImportGuardianWriterTest(unittest.TestCase):
    def test_upsert_import_guardian_writes_guardian_and_link(self):
        supabase = TableBackedSupabase()
        writer = StudentImportGuardianWriter(supabase)

        issue = writer.upsert_import_guardian(
            studio_id="studio-1",
            student_id="student-1",
            import_run_id=IMPORT_RUN_ID,
            row_number=7,
            guardian_name="Marisol O'Neill",
            guardian_email="marisol@example.test",
            guardian_phone="555-0100",
            guardian_relation="Mother",
        )

        guardian_id = str(uuid.uuid5(uuid.UUID(IMPORT_RUN_ID), "guardian-row:7"))
        link_id = str(
            uuid.uuid5(
                uuid.UUID(IMPORT_RUN_ID),
                f"student-guardian-link:student-1:{guardian_id}",
            )
        )
        self.assertIsNone(issue)
        self.assertEqual(
            supabase.tables["guardians"],
            [{
                "id": guardian_id,
                "studio_id": "studio-1",
                "first_name": "Marisol",
                "last_name": "O'Neill",
                "email": "marisol@example.test",
                "phone": "555-0100",
                "relation": "Mother",
                "is_primary_contact": True,
            }],
        )
        self.assertEqual(
            supabase.tables["student_guardians"],
            [{
                "id": link_id,
                "student_id": "student-1",
                "guardian_id": guardian_id,
            }],
        )

    def test_upsert_import_guardian_failure_returns_nonfatal_warning(self):
        supabase = TableBackedSupabase()
        supabase.table_failures["guardians"] = RuntimeError("guardian table unavailable")
        writer = StudentImportGuardianWriter(supabase)

        issue = writer.upsert_import_guardian(
            studio_id="studio-1",
            student_id="student-1",
            import_run_id=IMPORT_RUN_ID,
            row_number=3,
            guardian_name="Avery Parent",
            guardian_email=None,
            guardian_phone=None,
            guardian_relation=None,
        )

        self.assertIsNotNone(issue)
        self.assertEqual(issue.code, "guardian_import_failed")
        self.assertEqual(issue.severity, "warning")
        self.assertEqual(issue.field, "guardian_name")
        self.assertEqual(issue.value, "Avery Parent")
        self.assertNotIn("guardian table unavailable", issue.message)
        self.assertIn("could not be linked automatically", issue.message)
        self.assertNotIn("student_guardians", supabase.tables)

    def test_upsert_import_guardian_skips_empty_guardian_name(self):
        supabase = TableBackedSupabase()
        writer = StudentImportGuardianWriter(supabase)

        issue = writer.upsert_import_guardian(
            studio_id="studio-1",
            student_id="student-1",
            import_run_id=IMPORT_RUN_ID,
            row_number=1,
            guardian_name=None,
            guardian_email="ignored@example.test",
            guardian_phone=None,
            guardian_relation=None,
        )

        self.assertIsNone(issue)
        self.assertEqual(supabase.tables, {})


if __name__ == "__main__":
    unittest.main()
