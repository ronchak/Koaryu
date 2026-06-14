from __future__ import annotations

import unittest

from app.services.student_response_builder import StudentResponseBuilder
from tests.fakes.supabase import TableBackedSupabase


class StudentResponseBuilderTenantScopeTest(unittest.TestCase):
    def test_guardian_hydration_filters_joined_guardian_by_student_studio(self):
        supabase = TableBackedSupabase({
            "student_guardians": [
                {
                    "student_id": "student_1",
                    "guardian_id": "guardian_1",
                    "guardians": {
                        "id": "guardian_1",
                        "studio_id": "studio_1",
                        "first_name": "Gina",
                        "last_name": "Primary",
                        "is_primary_contact": True,
                    },
                },
                {
                    "student_id": "student_1",
                    "guardian_id": "guardian_2",
                    "guardians": {
                        "id": "guardian_2",
                        "studio_id": "studio_2",
                        "first_name": "Cross",
                        "last_name": "Tenant",
                        "is_primary_contact": True,
                    },
                },
            ],
        })

        guardians = StudentResponseBuilder(supabase, photo_store=None).fetch_guardians_for_students(
            ["student_1"],
            {"student_1": "studio_1"},
        )

        self.assertEqual([guardian.id for guardian in guardians["student_1"]], ["guardian_1"])

    def test_membership_hydration_scopes_and_filters_by_student_studio(self):
        supabase = TableBackedSupabase({
            "student_program_memberships": [
                {
                    "id": "membership_1",
                    "studio_id": "studio_1",
                    "student_id": "student_1",
                    "program_id": "program_1",
                    "programs": {"name": "Karate", "color_hex": "#123456"},
                    "status": "active",
                    "created_at": "2026-05-01T00:00:00Z",
                    "updated_at": "2026-05-01T00:00:00Z",
                },
                {
                    "id": "membership_2",
                    "studio_id": "studio_2",
                    "student_id": "student_1",
                    "program_id": "program_2",
                    "programs": {"name": "Other Studio", "color_hex": "#654321"},
                    "status": "active",
                    "created_at": "2026-05-01T00:00:00Z",
                    "updated_at": "2026-05-01T00:00:00Z",
                },
            ],
        })

        memberships = StudentResponseBuilder(supabase, photo_store=None).fetch_memberships_for_students(
            ["student_1"],
            {"student_1": "studio_1"},
        )

        self.assertEqual([membership.id for membership in memberships["student_1"]], ["membership_1"])
        membership_queries = [
            entry
            for entry in supabase.query_log
            if entry["table"] == "student_program_memberships"
        ]
        self.assertIn(("eq", "studio_id", "studio_1"), membership_queries[0]["filters"])


if __name__ == "__main__":
    unittest.main()
