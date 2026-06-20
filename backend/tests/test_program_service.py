import unittest
from unittest.mock import patch

from app.services.program_service import ProgramService
from tests.fakes.supabase import TableBackedSupabase


class ProgramServiceTest(unittest.TestCase):
    def test_list_programs_does_not_repair_ladders(self):
        supabase = TableBackedSupabase({
            "programs": [{
                "id": "program-1",
                "studio_id": "studio-1",
                "name": "Youth Karate",
                "description": None,
                "color_hex": "#64748B",
                "sort_order": 10,
                "is_system": False,
                "archived_at": None,
                "created_at": "2026-05-01T00:00:00Z",
                "updated_at": "2026-05-01T00:00:00Z",
            }],
            "student_program_memberships": [],
            "class_sessions": [],
            "leads": [],
            "belt_ladders": [],
        })
        service = ProgramService(supabase)

        with patch.object(ProgramService, "ensure_program_ladders", side_effect=AssertionError("repair write")):
            programs = service.list_programs_sync("studio-1")

        self.assertEqual(len(programs), 1)
        self.assertEqual(programs[0].id, "program-1")
        self.assertEqual(programs[0].usage.belt_ladder_count, 0)


if __name__ == "__main__":
    unittest.main()
