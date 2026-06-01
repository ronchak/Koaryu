from __future__ import annotations

import unittest
from datetime import datetime, timezone

from app.services.student_program_memberships import StudentProgramMembershipStore
from tests.fakes.supabase import TableBackedSupabase


class StudentProgramMembershipStoreTest(unittest.TestCase):
    def test_normalize_program_ids_dedupes_active_programs_and_falls_back_to_unassigned(self):
        supabase = TableBackedSupabase({
            "programs": [
                {
                    "id": "program-a",
                    "studio_id": "studio-1",
                    "name": "Kids",
                    "archived_at": None,
                    "created_at": "2026-05-01T00:00:00Z",
                },
                {
                    "id": "unassigned",
                    "studio_id": "studio-1",
                    "name": "Unassigned",
                    "archived_at": None,
                    "created_at": "2026-05-01T00:00:00Z",
                },
            ],
        })
        store = StudentProgramMembershipStore(supabase)

        self.assertEqual(
            store.normalize_program_ids_for_write("studio-1", None, ["program-a", "program-a"]),
            ["program-a"],
        )
        self.assertEqual(
            store.normalize_program_ids_for_write("studio-1", None, []),
            ["unassigned"],
        )

    def test_replace_active_memberships_updates_memberships_and_legacy_student_fields(self):
        supabase = TableBackedSupabase({
            "students": [{
                "id": "student-1",
                "studio_id": "studio-1",
                "program_id": "old-program",
                "current_belt_rank_id": None,
            }],
            "student_program_memberships": [
                {
                    "id": "membership-old",
                    "studio_id": "studio-1",
                    "student_id": "student-1",
                    "program_id": "old-program",
                    "status": "active",
                    "ended_at": None,
                    "current_belt_rank_id": "old-rank",
                },
                {
                    "id": "membership-a",
                    "studio_id": "studio-1",
                    "student_id": "student-1",
                    "program_id": "program-a",
                    "status": "ended",
                    "ended_at": None,
                    "current_belt_rank_id": None,
                },
            ],
            "belt_ranks": [{
                "id": "rank-a",
                "studio_id": "studio-1",
                "belt_ladders": {"program_id": "program-a", "studio_id": "studio-1"},
            }],
        })
        store = StudentProgramMembershipStore(supabase)

        store.replace_active_memberships(
            "student-1",
            "studio-1",
            ["program-a", "program-b"],
            current_belt_rank_id="rank-a",
            started_at="2026-05-01",
        )

        ended_at = datetime.now(timezone.utc).date().isoformat()
        memberships = {
            row["program_id"]: row
            for row in supabase.tables["student_program_memberships"]
        }
        self.assertEqual(memberships["old-program"]["status"], "ended")
        self.assertEqual(memberships["old-program"]["ended_at"], ended_at)
        self.assertIsNone(memberships["old-program"]["current_belt_rank_id"])
        self.assertEqual(memberships["program-a"]["status"], "active")
        self.assertEqual(memberships["program-a"]["started_at"], "2026-05-01")
        self.assertEqual(memberships["program-a"]["current_belt_rank_id"], "rank-a")
        self.assertEqual(memberships["program-b"]["status"], "active")
        self.assertIsNone(memberships["program-b"]["current_belt_rank_id"])

        student = supabase.tables["students"][0]
        self.assertEqual(student["program_id"], "program-a")
        self.assertEqual(student["current_belt_rank_id"], "rank-a")


if __name__ == "__main__":
    unittest.main()
