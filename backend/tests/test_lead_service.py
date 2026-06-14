import asyncio
import unittest
import uuid
from typing import Optional
from unittest.mock import patch

from app.schemas.lead import LeadConvert
from app.services.lead_service import CONVERSION_NAMESPACE, LeadService
from tests.fakes.supabase import RpcBackedSupabase


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


class FakeLeadConversionSupabase(RpcBackedSupabase):
    def _rpc_convert_lead_to_student_atomic(self, params):
        lead = next(
            row
            for row in self.tables["leads"]
            if row["id"] == params["p_lead_id"] and row["studio_id"] == params["p_studio_id"]
        )
        if lead.get("converted_student_id"):
            return [dict(lead)]

        student_id = params["p_student_id"]
        if not any(row.get("id") == student_id and row.get("studio_id") == params["p_studio_id"] for row in self.tables["students"]):
            self.tables["students"].append({
                "id": student_id,
                "studio_id": params["p_studio_id"],
                "legal_first_name": lead["first_name"],
                "legal_last_name": lead["last_name"],
                "email": lead.get("email"),
                "phone": lead.get("phone"),
                "status": params["p_status"],
                "membership_start_date": params["p_membership_start_date"],
                "program_id": params["p_program_id"],
                "notes": lead.get("notes"),
                "tags": ["converted-lead"],
            })

        membership = next(
            (
                row
                for row in self.tables["student_program_memberships"]
                if row.get("studio_id") == params["p_studio_id"]
                and row.get("student_id") == student_id
                and row.get("program_id") == params["p_program_id"]
                and row.get("ended_at") is None
            ),
            None,
        )
        if membership:
            membership.update({"status": "active", "started_at": params["p_membership_start_date"], "ended_at": None})
        else:
            self.tables["student_program_memberships"].append({
                "id": f"membership-{len(self.tables['student_program_memberships']) + 1}",
                "studio_id": params["p_studio_id"],
                "student_id": student_id,
                "program_id": params["p_program_id"],
                "status": "active",
                "started_at": params["p_membership_start_date"],
                "ended_at": None,
            })

        guardian_id = params.get("p_guardian_id")
        link_id = params.get("p_student_guardian_id")
        if guardian_id and link_id:
            if not any(row.get("id") == guardian_id for row in self.tables["guardians"]):
                first, _, last = (lead.get("guardian_name") or "").partition(" ")
                self.tables["guardians"].append({
                    "id": guardian_id,
                    "studio_id": params["p_studio_id"],
                    "first_name": first,
                    "last_name": last,
                    "email": lead.get("guardian_email"),
                    "phone": lead.get("guardian_phone"),
                    "is_primary_contact": True,
                })
            if not any(row.get("id") == link_id for row in self.tables["student_guardians"]):
                self.tables["student_guardians"].append({
                    "id": link_id,
                    "student_id": student_id,
                    "guardian_id": guardian_id,
                })

        lead.update({
            "stage": "enrolled",
            "converted_student_id": student_id,
            "follow_up_date": None,
        })
        self.tables["lead_activities"].append({
            "studio_id": params["p_studio_id"],
            "lead_id": params["p_lead_id"],
            "activity_type": "stage_change",
            "description": f"Converted to student (ID: {student_id})",
            "created_by": params["p_actor_id"],
        })
        self.tables["audit_logs"].append({
            "studio_id": params["p_studio_id"],
            "actor_id": params["p_actor_id"],
            "action": "lead.converted",
            "entity_type": "lead",
            "entity_id": params["p_lead_id"],
            "metadata": {"student_id": student_id},
        })
        return [dict(lead)]


class LeadServiceTest(unittest.TestCase):
    def test_convert_existing_deterministic_student_repairs_missing_membership(self):
        student_id = str(uuid.uuid5(CONVERSION_NAMESPACE, "studio-1:lead-1:student"))
        supabase = FakeLeadConversionSupabase({
            "leads": [lead_row()],
            "students": [{"id": student_id, "studio_id": "studio-1"}],
            "student_program_memberships": [],
            "guardians": [],
            "student_guardians": [],
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
        self.assertEqual([name for name, _params in supabase.rpc_calls], ["convert_lead_to_student_atomic"])
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
        mutating_tables = {
            entry["table"]
            for entry in supabase.query_log
            if entry["insert"] is not None or entry["update"] is not None or entry["delete"]
        }
        self.assertEqual(mutating_tables, set())

    def test_convert_minor_lead_passes_guardian_ids_to_atomic_rpc(self):
        supabase = FakeLeadConversionSupabase({
            "leads": [lead_row(is_minor=True, guardian_name="Mina Nguyen", guardian_email="mina@example.test")],
            "students": [],
            "student_program_memberships": [],
            "guardians": [],
            "student_guardians": [],
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

        student_id = str(uuid.uuid5(CONVERSION_NAMESPACE, "studio-1:lead-1:student"))
        guardian_id = str(uuid.uuid5(CONVERSION_NAMESPACE, "studio-1:lead-1:guardian"))
        link_id = str(uuid.uuid5(CONVERSION_NAMESPACE, f"{student_id}:{guardian_id}:link"))
        self.assertEqual(converted.converted_student_id, student_id)
        params = supabase.rpc_calls[0][1]
        self.assertEqual(params["p_guardian_id"], guardian_id)
        self.assertEqual(params["p_student_guardian_id"], link_id)
        self.assertEqual(supabase.tables["guardians"][0]["id"], guardian_id)
        self.assertEqual(supabase.tables["student_guardians"][0]["id"], link_id)


if __name__ == "__main__":
    unittest.main()
