import asyncio
import unittest
import uuid
from typing import Optional
from unittest.mock import patch

from app.schemas.lead import LeadConvert
from app.services.lead_service import CONVERSION_NAMESPACE, LeadService
from tests.fakes.supabase import TableBackedSupabase


class FakeProgramService:
    def __init__(self, _supabase):
        pass

    def get_unassigned_program_id(self, _studio_id: str) -> str:
        return "program-1"

    def ensure_program_active(self, _studio_id: str, _program_id: Optional[str]) -> None:
        return None


def lead_row(**overrides):
    row = {
        "id": "lead-1",
        "studio_id": "studio-1",
        "first_name": "Ava",
        "last_name": "Nguyen",
        "email": "ava@example.test",
        "phone": "555-0100",
        "source": "walk_in",
        "stage": "inquiry",
        "program_interest": None,
        "program_id": "program-1",
        "is_minor": False,
        "guardian_name": None,
        "guardian_email": None,
        "guardian_phone": None,
        "assigned_staff_id": None,
        "follow_up_date": "2026-05-30",
        "lost_reason": None,
        "notes": "Trial class",
        "converted_student_id": None,
        "created_at": "2026-05-01T00:00:00Z",
        "updated_at": "2026-05-01T00:00:00Z",
    }
    row.update(overrides)
    return row


class LeadServiceTest(unittest.TestCase):
    def test_convert_existing_deterministic_student_repairs_missing_membership(self):
        student_id = str(uuid.uuid5(CONVERSION_NAMESPACE, "studio-1:lead-1:student"))
        supabase = TableBackedSupabase({
            "leads": [lead_row()],
            "students": [{"id": student_id, "studio_id": "studio-1"}],
            "student_program_memberships": [],
            "lead_activities": [],
            "audit_logs": [],
        })
        service = LeadService(supabase)

        with patch("app.services.lead_service.ProgramService", FakeProgramService):
            converted = asyncio.run(service.convert_to_student(
                "lead-1",
                LeadConvert(program_id="program-1", membership_start_date="2026-05-20"),
                "studio-1",
                "actor-1",
            ))

        self.assertEqual(converted.stage, "enrolled")
        self.assertEqual(converted.converted_student_id, student_id)
        self.assertEqual(len(supabase.tables["students"]), 1)
        self.assertEqual(len(supabase.tables["student_program_memberships"]), 1)
        membership = supabase.tables["student_program_memberships"][0]
        self.assertIn("id", membership)
        self.assertEqual(
            {key: membership[key] for key in ("studio_id", "student_id", "program_id", "status", "started_at")},
            {
                "studio_id": "studio-1",
                "student_id": student_id,
                "program_id": "program-1",
                "status": "active",
                "started_at": "2026-05-20",
            },
        )
        self.assertIsNone(supabase.tables["leads"][0]["follow_up_date"])


if __name__ == "__main__":
    unittest.main()
