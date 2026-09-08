import asyncio
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.belt import BeltLadderSyncRequest
from app.services.belt_eligibility import BeltEligibilityCalculator
from app.services.belt_service import BeltService
from tests.fakes.supabase import RpcBackedSupabase


STUDIO_ID = "11111111-1111-1111-1111-111111111111"
STUDENT_ID = "22222222-2222-2222-2222-222222222222"
PROGRAM_ID = "33333333-3333-3333-3333-333333333333"
LADDER_ID = "55555555-5555-5555-5555-555555555555"
FROM_RANK_ID = "66666666-6666-6666-6666-666666666666"
TO_RANK_ID = "77777777-7777-7777-7777-777777777777"
ACTOR_ID = "88888888-8888-8888-8888-888888888888"


class FakeSupabase(RpcBackedSupabase):
    def _rpc_sync_belt_ladder_ranks_v2(self, params: dict):
        ladder = next(
            row for row in self.tables["belt_ladders"]
            if row["id"] == params["p_ladder_id"] and row["studio_id"] == params["p_studio_id"]
        )
        ranks = [
            {
                **rank,
                "id": rank.get("id") or "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "ladder_id": ladder["id"],
                "studio_id": ladder["studio_id"],
                "created_at": "2026-08-14T00:00:00Z",
            }
            for rank in params["p_ranks"]
        ]
        self.tables["belt_ranks"] = ranks
        self.tables["audit_logs"].append({
            "studio_id": params["p_studio_id"],
            "actor_id": params["p_actor_id"],
            "action": "belt_ladder.synced",
            "entity_id": params["p_ladder_id"],
            "metadata": {"operation_id": params["p_operation_id"]},
        })
        return {**ladder, "ranks": ranks}


class BeltServiceTest(unittest.TestCase):
    def test_sync_ladder_uses_atomic_idempotent_audit_rpc(self):
        operation_id = "99999999-9999-4999-8999-999999999999"
        supabase = FakeSupabase({
            "belt_ladders": [{
                "id": LADDER_ID,
                "studio_id": STUDIO_ID,
                "program_id": PROGRAM_ID,
                "name": "Karate",
                "sub_rank_term": "Stripe",
                "created_at": "2026-08-14T00:00:00Z",
                "updated_at": "2026-08-14T00:00:00Z",
            }],
            "belt_ranks": [],
            "audit_logs": [],
        })

        response = asyncio.run(BeltService(supabase).sync_ladder(
            LADDER_ID,
            BeltLadderSyncRequest(
                operation_id=operation_id,
                sub_rank_term="Stripe",
                ranks=[{"name": "White Belt", "color_hex": "#FFFFFF"}],
            ),
            STUDIO_ID,
            ACTOR_ID,
        ))

        self.assertEqual(response.ranks[0].name, "White Belt")
        self.assertEqual(supabase.rpc_calls[0][0], "sync_belt_ladder_ranks_v2")
        self.assertEqual(supabase.rpc_calls[0][1]["p_operation_id"], operation_id)
        self.assertEqual(supabase.tables["audit_logs"][0]["metadata"]["operation_id"], operation_id)
        direct_audit_inserts = [
            entry for entry in supabase.query_log
            if entry["table"] == "audit_logs" and entry["insert"] is not None
        ]
        self.assertEqual(direct_audit_inserts, [])

    def test_delete_assigned_rank_returns_conflict_with_sync_guidance(self):
        supabase = FakeSupabase({"belt_ranks": []})
        supabase.table_failures["belt_ranks"] = PostgrestAPIError({
            "code": "P0001",
            "message": "Assigned belt ranks must be deleted through sync_belt_ladder_ranks.",
            "details": "",
            "hint": "",
        })

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(BeltService(supabase).delete_rank(FROM_RANK_ID, STUDIO_ID))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("full belt ladder", raised.exception.detail)

    def test_delete_unassigned_rank_remains_available(self):
        supabase = FakeSupabase({
            "belt_ranks": [{"id": FROM_RANK_ID, "studio_id": STUDIO_ID}],
        })

        asyncio.run(BeltService(supabase).delete_rank(FROM_RANK_ID, STUDIO_ID))

        self.assertEqual(supabase.tables["belt_ranks"], [])


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
