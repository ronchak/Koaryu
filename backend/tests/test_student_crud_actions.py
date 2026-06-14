from __future__ import annotations

import asyncio
import unittest

from app.schemas.student import GuardianCreate, StudentCreate, StudentUpdate
from app.services.student_crud_actions import StudentCrudActions
from app.services.student_write_payload import prepare_student_write_payload
from tests.fakes.supabase import RpcBackedSupabase


class FakeMembershipStore:
    def normalize_program_ids_for_write(self, _studio_id, program_id, program_ids):
        values = program_ids if program_ids is not None else ([program_id] if program_id else [])
        return values or ["program-1"]


class FakeStudentWriteSupabase(RpcBackedSupabase):
    def _rpc_write_student_profile_atomic(self, params):
        student_id = params["p_student_id"]
        existing = next((row for row in self.tables["students"] if row["id"] == student_id), None)
        if existing is None:
            if params["p_audit_action"] != "student.created":
                return []
            existing = {
                "id": student_id,
                "studio_id": params["p_studio_id"],
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
                "status": "active",
                "tags": [],
            }
            self.tables["students"].append(existing)

        existing.update(params["p_student"])
        existing["id"] = student_id
        existing["studio_id"] = params["p_studio_id"]

        if params["p_replace_programs"]:
            program_ids = params["p_program_ids"] or []
            existing["program_id"] = program_ids[0] if program_ids else None
            for membership in self.tables["student_program_memberships"]:
                if (
                    membership.get("studio_id") == params["p_studio_id"]
                    and membership.get("student_id") == student_id
                    and membership.get("program_id") not in program_ids
                    and membership.get("ended_at") is None
                ):
                    membership.update({"status": "ended", "ended_at": "2026-05-20"})
            for program_id in program_ids:
                membership = next(
                    (
                        row
                        for row in self.tables["student_program_memberships"]
                        if row.get("studio_id") == params["p_studio_id"]
                        and row.get("student_id") == student_id
                        and row.get("program_id") == program_id
                        and row.get("ended_at") is None
                    ),
                    None,
                )
                if membership:
                    membership.update({"status": "active", "started_at": existing.get("membership_start_date")})
                else:
                    self.tables["student_program_memberships"].append({
                        "id": f"membership-{len(self.tables['student_program_memberships']) + 1}",
                        "studio_id": params["p_studio_id"],
                        "student_id": student_id,
                        "program_id": program_id,
                        "status": "active",
                        "started_at": existing.get("membership_start_date"),
                        "ended_at": None,
                    })

        for guardian in params.get("p_guardians") or []:
            guardian_row = {
                "id": f"guardian-{len(self.tables['guardians']) + 1}",
                "studio_id": params["p_studio_id"],
                **guardian,
            }
            self.tables["guardians"].append(guardian_row)
            self.tables["student_guardians"].append({
                "id": f"student-guardian-{len(self.tables['student_guardians']) + 1}",
                "student_id": student_id,
                "guardian_id": guardian_row["id"],
            })

        self.tables["audit_logs"].append({
            "studio_id": params["p_studio_id"],
            "actor_id": params["p_actor_id"],
            "action": params["p_audit_action"],
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": params["p_student"],
        })
        return [dict(existing)]


def build_actions(supabase, memberships=None):
    return StudentCrudActions(
        supabase=supabase,
        membership_store=FakeMembershipStore(),
        prepare_student_write=prepare_student_write_payload,
        row_to_response=lambda row, **_kwargs: row,
        fetch_memberships_for_student=lambda *_args: memberships or [],
    )


class StudentCrudActionsTest(unittest.TestCase):
    def test_create_student_uses_atomic_rpc_for_student_memberships_guardians_and_audit(self):
        supabase = FakeStudentWriteSupabase({
            "programs": [{"id": "program-1", "studio_id": "studio-1"}],
            "students": [],
            "student_program_memberships": [],
            "guardians": [],
            "student_guardians": [],
            "audit_logs": [],
        })
        actions = build_actions(supabase)

        student = asyncio.run(actions.create_student(
            StudentCreate(
                legal_first_name="Aiko",
                legal_last_name="Tanaka",
                program_id="program-1",
                membership_start_date="2026-05-20",
                guardians=[GuardianCreate(first_name="Hana", last_name="Tanaka", is_primary_contact=True)],
            ),
            "studio-1",
            "actor-1",
        ))

        self.assertEqual(student["legal_first_name"], "Aiko")
        self.assertEqual([name for name, _params in supabase.rpc_calls], ["write_student_profile_atomic"])
        params = supabase.rpc_calls[0][1]
        self.assertTrue(params["p_replace_programs"])
        self.assertEqual(params["p_audit_action"], "student.created")
        self.assertEqual(params["p_program_ids"], ["program-1"])
        self.assertEqual(params["p_guardians"][0]["first_name"], "Hana")
        self.assertEqual(len(supabase.tables["student_program_memberships"]), 1)
        self.assertEqual(len(supabase.tables["guardians"]), 1)
        self.assertEqual(len(supabase.tables["audit_logs"]), 1)
        self.assert_no_direct_operational_writes(supabase)

    def test_update_student_uses_atomic_rpc_for_profile_membership_and_audit(self):
        supabase = FakeStudentWriteSupabase({
            "programs": [{"id": "program-2", "studio_id": "studio-1"}],
            "students": [{
                "id": "student-1",
                "studio_id": "studio-1",
                "legal_first_name": "Aiko",
                "legal_last_name": "Tanaka",
                "program_id": "program-1",
                "status": "active",
                "tags": [],
                "created_at": "2026-05-20T00:00:00+00:00",
                "updated_at": "2026-05-20T00:00:00+00:00",
            }],
            "student_program_memberships": [{
                "id": "membership-1",
                "studio_id": "studio-1",
                "student_id": "student-1",
                "program_id": "program-1",
                "status": "active",
                "ended_at": None,
            }],
            "guardians": [],
            "student_guardians": [],
            "audit_logs": [],
        })
        actions = build_actions(supabase)

        student = asyncio.run(actions.update_student(
            "student-1",
            StudentUpdate(program_id="program-2", status="paused"),
            "studio-1",
            "actor-1",
        ))

        self.assertEqual(student["program_id"], "program-2")
        self.assertEqual(student["status"], "paused")
        self.assertEqual([name for name, _params in supabase.rpc_calls], ["write_student_profile_atomic"])
        params = supabase.rpc_calls[0][1]
        self.assertTrue(params["p_replace_programs"])
        self.assertEqual(params["p_audit_action"], "student.updated")
        self.assertEqual(params["p_program_ids"], ["program-2"])
        self.assertEqual(supabase.tables["student_program_memberships"][0]["status"], "ended")
        self.assertEqual(supabase.tables["student_program_memberships"][1]["program_id"], "program-2")
        self.assert_no_direct_operational_writes(supabase)

    def assert_no_direct_operational_writes(self, supabase):
        operational_tables = {
            "students",
            "student_program_memberships",
            "guardians",
            "student_guardians",
            "audit_logs",
        }
        direct_writes = [
            entry
            for entry in supabase.query_log
            if entry["table"] in operational_tables
            and (entry["insert"] is not None or entry["update"] is not None or entry["delete"])
        ]
        self.assertEqual(direct_writes, [])


if __name__ == "__main__":
    unittest.main()
