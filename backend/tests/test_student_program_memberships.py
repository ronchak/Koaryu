from __future__ import annotations

import unittest

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

if __name__ == "__main__":
    unittest.main()
