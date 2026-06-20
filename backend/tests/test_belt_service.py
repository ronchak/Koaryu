import asyncio
import unittest
from unittest.mock import patch

from app.schemas.belt import PromoteStudent
from app.services.belt_eligibility import BeltEligibilityCalculator
from app.services.belt_service import BeltService
from tests.fakes.supabase import RpcBackedSupabase


STUDIO_ID = "11111111-1111-1111-1111-111111111111"
STUDENT_ID = "22222222-2222-2222-2222-222222222222"
PROGRAM_ID = "33333333-3333-3333-3333-333333333333"
MEMBERSHIP_ID = "44444444-4444-4444-4444-444444444444"
LADDER_ID = "55555555-5555-5555-5555-555555555555"
FROM_RANK_ID = "66666666-6666-6666-6666-666666666666"
TO_RANK_ID = "77777777-7777-7777-7777-777777777777"
ACTOR_ID = "88888888-8888-8888-8888-888888888888"


class FakeSupabase(RpcBackedSupabase):
    def _rpc_record_student_promotion(self, params: dict):
        promotion = {
            "id": "99999999-9999-9999-9999-999999999999",
            "studio_id": params["p_studio_id"],
            "student_id": params["p_student_id"],
            "student_program_membership_id": params["p_student_program_membership_id"],
            "program_id": params["p_program_id"],
            "from_rank_id": params["p_from_rank_id"],
            "to_rank_id": params["p_to_rank_id"],
            "promoted_by": params["p_promoted_by"],
            "notes": params["p_notes"],
            "promoted_at": "2026-05-24T12:00:00Z",
        }
        self.tables["promotions"].append(dict(promotion))
        for row in self.tables["student_program_memberships"]:
            if row["id"] == params["p_student_program_membership_id"]:
                row["current_belt_rank_id"] = params["p_to_rank_id"]
        for row in self.tables["students"]:
            if row["id"] == params["p_student_id"]:
                row["current_belt_rank_id"] = params["p_to_rank_id"]
                row["program_id"] = params["p_program_id"]
        self.tables["audit_logs"].append({
            "studio_id": params["p_studio_id"],
            "actor_id": params["p_promoted_by"],
            "entity_id": promotion["id"],
        })
        return promotion


class BeltServiceTest(unittest.TestCase):
    def test_promote_student_records_promotion_through_atomic_rpc(self):
        supabase = FakeSupabase({
            "belt_ranks": [
                {"id": FROM_RANK_ID, "studio_id": STUDIO_ID, "ladder_id": LADDER_ID, "display_order": 1},
                {"id": TO_RANK_ID, "studio_id": STUDIO_ID, "ladder_id": LADDER_ID, "display_order": 2},
            ],
            "belt_ladders": [{"id": LADDER_ID, "studio_id": STUDIO_ID, "program_id": PROGRAM_ID}],
            "students": [{
                "id": STUDENT_ID,
                "studio_id": STUDIO_ID,
                "program_id": PROGRAM_ID,
                "current_belt_rank_id": FROM_RANK_ID,
            }],
            "student_program_memberships": [{
                "id": MEMBERSHIP_ID,
                "student_id": STUDENT_ID,
                "studio_id": STUDIO_ID,
                "program_id": PROGRAM_ID,
                "status": "active",
                "ended_at": None,
                "current_belt_rank_id": FROM_RANK_ID,
            }],
            "promotions": [],
            "audit_logs": [],
        })
        service = BeltService(supabase)

        response = asyncio.run(service.promote_student(
            PromoteStudent(
                student_id=STUDENT_ID,
                student_program_membership_id=MEMBERSHIP_ID,
                to_rank_id=TO_RANK_ID,
                notes="Ready for next rank",
            ),
            STUDIO_ID,
            ACTOR_ID,
        ))

        self.assertEqual(response.id, "99999999-9999-9999-9999-999999999999")
        self.assertEqual(response.to_rank_id, TO_RANK_ID)
        self.assertEqual(supabase.rpc_calls, [(
            "record_student_promotion",
            {
                "p_studio_id": STUDIO_ID,
                "p_student_id": STUDENT_ID,
                "p_student_program_membership_id": MEMBERSHIP_ID,
                "p_program_id": PROGRAM_ID,
                "p_from_rank_id": FROM_RANK_ID,
                "p_to_rank_id": TO_RANK_ID,
                "p_promoted_by": ACTOR_ID,
                "p_notes": "Ready for next rank",
            },
        )])
        direct_writes = [
            (entry["table"], "insert" if entry["insert"] is not None else "update")
            for entry in supabase.query_log
            if entry["insert"] is not None or entry["update"] is not None
        ]
        self.assertNotIn(("promotions", "insert"), direct_writes)
        self.assertNotIn(("students", "update"), direct_writes)
        self.assertNotIn(("student_program_memberships", "update"), direct_writes)
        self.assertEqual(supabase.tables["students"][0]["current_belt_rank_id"], TO_RANK_ID)
        self.assertEqual(supabase.tables["student_program_memberships"][0]["current_belt_rank_id"], TO_RANK_ID)
        self.assertEqual(supabase.tables["audit_logs"][0]["entity_id"], response.id)

    def test_list_ladders_does_not_repair_program_ladders(self):
        supabase = FakeSupabase({
            "programs": [{
                "id": PROGRAM_ID,
                "studio_id": STUDIO_ID,
                "is_system": False,
                "archived_at": None,
            }],
            "belt_ladders": [],
        })
        service = BeltService(supabase)

        with patch(
            "app.services.belt_service.ProgramService.ensure_program_ladders",
            side_effect=AssertionError("repair write"),
        ):
            ladders = asyncio.run(service.list_ladders(STUDIO_ID))

        self.assertEqual(ladders, [])

    def test_eligibility_attendance_excludes_deleted_and_canceled_sessions(self):
        supabase = FakeSupabase({
            "attendance": [
                {
                    "id": "attendance-valid",
                    "studio_id": STUDIO_ID,
                    "student_id": STUDENT_ID,
                    "status": "present",
                    "checked_in_at": "2026-05-24T12:00:00Z",
                    "counts_toward_eligibility": True,
                    "class_sessions": {"program_id": PROGRAM_ID},
                    "class_sessions.status": "scheduled",
                    "class_sessions.deleted_at": None,
                },
                {
                    "id": "attendance-canceled",
                    "studio_id": STUDIO_ID,
                    "student_id": STUDENT_ID,
                    "status": "present",
                    "checked_in_at": "2026-05-25T12:00:00Z",
                    "counts_toward_eligibility": True,
                    "class_sessions": {"program_id": PROGRAM_ID},
                    "class_sessions.status": "canceled",
                    "class_sessions.deleted_at": None,
                },
                {
                    "id": "attendance-deleted",
                    "studio_id": STUDIO_ID,
                    "student_id": STUDENT_ID,
                    "status": "present",
                    "checked_in_at": "2026-05-26T12:00:00Z",
                    "counts_toward_eligibility": True,
                    "class_sessions": {"program_id": PROGRAM_ID},
                    "class_sessions.status": "scheduled",
                    "class_sessions.deleted_at": "2026-05-26T13:00:00Z",
                },
            ],
        })
        calculator = BeltEligibilityCalculator(supabase)

        counts = calculator._fetch_attendance_counts_by_student(
            STUDIO_ID,
            [{
                "context_key": "membership-context",
                "student": {"id": STUDENT_ID},
                "target_ladder_id": LADDER_ID,
            }],
            {},
            {LADDER_ID: {"program_id": PROGRAM_ID}},
        )

        self.assertEqual(counts["membership-context"], 1)

    def test_eligibility_pages_students_and_chunks_membership_queries(self):
        students = [
            {
                "id": f"student_{index}",
                "studio_id": STUDIO_ID,
                "legal_first_name": f"Student{index}",
                "legal_last_name": "Paged",
                "preferred_name": None,
                "membership_start_date": "2026-01-01T00:00:00Z",
                "program_id": PROGRAM_ID,
                "current_belt_rank_id": FROM_RANK_ID,
                "status": "active",
                "deleted_at": None,
            }
            for index in range(1001)
        ]
        memberships = [
            {
                "id": f"membership_{index}",
                "student_id": f"student_{index}",
                "studio_id": STUDIO_ID,
                "program_id": PROGRAM_ID,
                "status": "active",
                "ended_at": None,
                "started_at": "2026-01-01T00:00:00Z",
                "current_belt_rank_id": FROM_RANK_ID,
            }
            for index in range(1001)
        ]
        supabase = FakeSupabase({
            "belt_ladders": [{"id": LADDER_ID, "studio_id": STUDIO_ID, "name": "Core", "program_id": PROGRAM_ID}],
            "belt_ranks": [
                {
                    "id": FROM_RANK_ID,
                    "studio_id": STUDIO_ID,
                    "ladder_id": LADDER_ID,
                    "name": "White",
                    "color_hex": "#ffffff",
                    "display_order": 1,
                    "min_classes": 0,
                    "min_months": 0,
                    "requires_approval": False,
                },
                {
                    "id": TO_RANK_ID,
                    "studio_id": STUDIO_ID,
                    "ladder_id": LADDER_ID,
                    "name": "Blue",
                    "color_hex": "#0000ff",
                    "display_order": 2,
                    "min_classes": 0,
                    "min_months": 0,
                    "requires_approval": False,
                },
            ],
            "students": students,
            "student_program_memberships": memberships,
            "promotions": [],
            "attendance": [],
        })
        calculator = BeltEligibilityCalculator(supabase)

        entries = asyncio.run(calculator.get_eligibility(STUDIO_ID, LADDER_ID))

        self.assertEqual(len(entries), 1001)
        student_ranges = [
            entry["range"]
            for entry in supabase.query_log
            if entry["table"] == "students"
            and entry["columns"].startswith("id, legal_first_name")
        ]
        self.assertEqual(student_ranges, [(0, 999), (1000, 1999)])
        membership_queries = [
            entry
            for entry in supabase.query_log
            if entry["table"] == "student_program_memberships"
        ]
        self.assertGreater(len(membership_queries), 1)
        self.assertTrue(
            all(
                len(next(value for op, key, value in entry["filters"] if op == "in" and key == "student_id")) <= 100
                for entry in membership_queries
            )
        )


if __name__ == "__main__":
    unittest.main()
