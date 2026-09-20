from __future__ import annotations

import unittest
from datetime import date
from unittest.mock import patch

from app.services.student_response_builder import StudentResponseBuilder
from tests.fakes.supabase import TableBackedSupabase


class StudentResponseBuilderTenantScopeTest(unittest.TestCase):
    @staticmethod
    def student_row(**overrides):
        return {
            "id": "student_1",
            "studio_id": "studio_1",
            "legal_first_name": "Ari",
            "legal_last_name": "Stone",
            "date_of_birth": "2008-09-20",
            "is_minor": False,
            "status": "active",
            "tags": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            **overrides,
        }

    def test_batch_and_detail_responses_replace_stored_flag_from_dob(self):
        supabase = TableBackedSupabase({"student_program_memberships": []})
        builder = StudentResponseBuilder(supabase, photo_store=None)
        row = self.student_row()

        before = builder.rows_to_responses(
            [row], include_guardians=False, include_photo_urls=False, today=date(2026, 9, 19)
        )[0]
        on_birthday = builder.row_to_response(
            row,
            guardians=[],
            memberships=[],
            photo_url=None,
            today=date(2026, 9, 20),
        )

        self.assertTrue(before.is_minor)
        self.assertFalse(on_birthday.is_minor)
        self.assertFalse(row["is_minor"])

        leap_row = self.student_row(id="leap", date_of_birth="2008-02-29")
        february = builder.row_to_response(
            leap_row,
            guardians=[],
            memberships=[],
            photo_url=None,
            today=date(2026, 2, 28),
        )
        march = builder.row_to_response(
            leap_row,
            guardians=[],
            memberships=[],
            photo_url=None,
            today=date(2026, 3, 1),
        )
        self.assertTrue(february.is_minor)
        self.assertFalse(march.is_minor)

    def test_batch_looks_up_date_context_once_and_does_not_hide_failure(self):
        builder = StudentResponseBuilder(
            TableBackedSupabase({"student_program_memberships": []}), photo_store=None
        )
        rows = [self.student_row(), self.student_row(id="student_2")]
        with patch(
            "app.services.student_response_builder.studio_today_for_studio",
            return_value=date(2026, 9, 20),
        ) as studio_date:
            responses = builder.rows_to_responses(
                rows, include_guardians=False, include_photo_urls=False
            )
        studio_date.assert_called_once_with(builder.supabase, "studio_1")
        self.assertEqual([item.is_minor for item in responses], [False, False])

        with patch(
            "app.services.student_response_builder.studio_today_for_studio",
            side_effect=RuntimeError("studio read failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "studio read failed"):
                builder.rows_to_responses(rows, include_guardians=False, include_photo_urls=False)

    def test_null_dob_batch_does_not_load_date_context(self):
        builder = StudentResponseBuilder(
            TableBackedSupabase({"student_program_memberships": []}), photo_store=None
        )
        with patch("app.services.student_response_builder.studio_today_for_studio") as studio_date:
            responses = builder.rows_to_responses(
                [self.student_row(date_of_birth=None, is_minor=True)],
                include_guardians=False,
                include_photo_urls=False,
            )

        studio_date.assert_not_called()
        self.assertFalse(responses[0].is_minor)

    def test_guardian_hydration_filters_joined_guardian_by_student_studio(self):
        supabase = TableBackedSupabase(
            {
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
            }
        )

        guardians = StudentResponseBuilder(supabase, photo_store=None).fetch_guardians_for_students(
            ["student_1"],
            {"student_1": "studio_1"},
        )

        self.assertEqual([guardian.id for guardian in guardians["student_1"]], ["guardian_1"])

    def test_membership_hydration_scopes_and_filters_by_student_studio(self):
        supabase = TableBackedSupabase(
            {
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
            }
        )

        memberships = StudentResponseBuilder(
            supabase, photo_store=None
        ).fetch_memberships_for_students(
            ["student_1"],
            {"student_1": "studio_1"},
        )

        self.assertEqual(
            [membership.id for membership in memberships["student_1"]], ["membership_1"]
        )
        membership_queries = [
            entry for entry in supabase.query_log if entry["table"] == "student_program_memberships"
        ]
        self.assertIn(("eq", "studio_id", "studio_1"), membership_queries[0]["filters"])


if __name__ == "__main__":
    unittest.main()
