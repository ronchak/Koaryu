import asyncio
import copy
import unittest
from datetime import UTC, datetime
from unittest.mock import patch

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.belt import BeltLadderSyncRequest
from app.services import belt_eligibility
from app.services.belt_eligibility import BeltEligibilityCalculator
from app.services.belt_service import BeltService
from tests.fakes.supabase import FakeTableQuery, RpcBackedSupabase


STUDIO_ID = "11111111-1111-1111-1111-111111111111"
OTHER_STUDIO_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
STUDENT_ID = "22222222-2222-2222-2222-222222222222"
PROGRAM_ID = "33333333-3333-3333-3333-333333333333"
SECOND_PROGRAM_ID = "44444444-4444-4444-8444-444444444444"
LADDER_ID = "55555555-5555-5555-5555-555555555555"
SECOND_LADDER_ID = "99999999-9999-4999-8999-999999999999"
FROM_RANK_ID = "66666666-6666-6666-6666-666666666666"
TO_RANK_ID = "77777777-7777-7777-7777-777777777777"
ACTOR_ID = "88888888-8888-8888-8888-888888888888"


class FakeSupabase(RpcBackedSupabase):
    def _rpc_sync_belt_ladder_ranks_v2(self, params: dict):
        ladder = next(
            row
            for row in self.tables["belt_ladders"]
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
        self.tables["audit_logs"].append(
            {
                "studio_id": params["p_studio_id"],
                "actor_id": params["p_actor_id"],
                "action": "belt_ladder.synced",
                "entity_id": params["p_ladder_id"],
                "metadata": {"operation_id": params["p_operation_id"]},
            }
        )
        return {**ladder, "ranks": ranks}


FROZEN_NOW = datetime(2026, 5, 20, 19, 0, tzinfo=UTC)
PROVIDER_MAX_ROWS = 1000


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return FROZEN_NOW if tz is None else FROZEN_NOW.astimezone(tz)


class CappedTableQuery(FakeTableQuery):
    def _bounded_rows(self, rows):
        return super()._bounded_rows(rows)[:PROVIDER_MAX_ROWS]


class CappedSupabase(FakeSupabase):
    """Every response stops at the provider's row cap, as PostgREST max-rows does."""

    def table(self, name: str):
        return CappedTableQuery(self, name)


def rank_row(rank_id, ladder_id, display_order, *, studio_id=STUDIO_ID, **changes):
    return {
        "id": rank_id,
        "studio_id": studio_id,
        "ladder_id": ladder_id,
        "name": rank_id,
        "color_hex": "#ffffff",
        "display_order": display_order,
        "min_classes": 0,
        "min_months": 0,
        "requires_approval": False,
        "is_tip": False,
        "created_at": "2025-01-01T00:00:00Z",
        **changes,
    }


def ladder_row(ladder_id, program_id, created_at, ranks=(), *, studio_id=STUDIO_ID):
    return {
        "id": ladder_id,
        "studio_id": studio_id,
        "name": ladder_id,
        "program_id": program_id,
        "sub_rank_term": "Stripe",
        "created_at": created_at,
        "updated_at": created_at,
        "belt_ranks": list(ranks),
    }


def program_row(program_id, *, studio_id=STUDIO_ID, is_system=False, archived_at=None):
    return {
        "id": program_id,
        "studio_id": studio_id,
        "is_system": is_system,
        "archived_at": archived_at,
    }


def student_row(student_id, program_id, rank_id, *, studio_id=STUDIO_ID):
    return {
        "id": student_id,
        "studio_id": studio_id,
        "legal_first_name": student_id,
        "legal_last_name": "Student",
        "preferred_name": None,
        "membership_start_date": "2026-01-01T00:00:00Z",
        "program_id": program_id,
        "current_belt_rank_id": rank_id,
        "status": "active",
        "deleted_at": None,
    }


def membership_row(
    membership_id, student_id, program_id, rank_id, *, status="active", ended_at=None
):
    return {
        "id": membership_id,
        "studio_id": STUDIO_ID,
        "student_id": student_id,
        "program_id": program_id,
        "status": status,
        "ended_at": ended_at,
        "started_at": "2026-01-01T00:00:00Z",
        "current_belt_rank_id": rank_id,
    }


def attendance_row(student_id, checked_in_at, program_id):
    return {
        "studio_id": STUDIO_ID,
        "student_id": student_id,
        "status": "present",
        "counts_toward_eligibility": True,
        "checked_in_at": checked_in_at,
        "class_sessions": {"program_id": program_id},
        "class_sessions.status": "completed",
        "class_sessions.deleted_at": None,
    }


def with_ranks(ladders):
    return {
        "belt_ladders": ladders,
        "belt_ranks": [rank for ladder in ladders for rank in ladder["belt_ranks"]],
    }


def primary_ladder_tables():
    """Hidden, unscoped and foreign ladders own current ranks beside the primary."""

    # Equal display order: embedded payload lists p-z first; canonical order is p-a first.
    primary_ranks = [
        rank_row("p-white", "lad-primary", 1),
        rank_row("p-z", "lad-primary", 2),
        rank_row("p-a", "lad-primary", 2),
        rank_row("p-top", "lad-primary", 3),
    ]
    ladders = [
        ladder_row(
            "lad-foreign",
            "prog-foreign",
            "2024-12-01T00:00:00Z",
            [rank_row("r-foreign", "lad-foreign", 1, studio_id=OTHER_STUDIO_ID)],
            studio_id=OTHER_STUDIO_ID,
        ),
        ladder_row(
            "lad-archived",
            "prog-archived",
            "2025-01-02T00:00:00Z",
            [rank_row("r-archived", "lad-archived", 1)],
        ),
        ladder_row(
            "lad-system",
            "prog-system",
            "2025-01-03T00:00:00Z",
            [rank_row("r-system", "lad-system", 1)],
        ),
        ladder_row(
            "lad-unscoped",
            None,
            "2025-01-04T00:00:00Z",
            [rank_row("r-unscoped", "lad-unscoped", 1)],
        ),
        ladder_row("lad-primary", "prog-visible", "2025-02-01T00:00:00Z", primary_ranks),
        # Same created_at as the primary: provider order decides.
        ladder_row(
            "lad-second",
            "prog-second",
            "2025-02-01T00:00:00Z",
            [rank_row("s-white", "lad-second", 1)],
        ),
    ]
    return {
        "programs": [
            program_row("prog-visible"),
            program_row("prog-second"),
            program_row("prog-archived", archived_at="2026-01-01T00:00:00Z"),
            program_row("prog-system", is_system=True),
            program_row("prog-foreign", studio_id=OTHER_STUDIO_ID),
        ],
        **with_ranks(ladders),
        "students": [
            student_row("st-unranked", "prog-visible", None),
            student_row("st-white", "prog-visible", "p-white"),
            student_row("st-z", "prog-visible", "p-z"),
            student_row("st-a", "prog-visible", "p-a"),
            student_row("st-top", "prog-visible", "p-top"),
            student_row("st-archived", "prog-visible", "r-archived"),
            student_row("st-system", "prog-visible", "r-system"),
            student_row("st-unscoped", "prog-visible", "r-unscoped"),
            student_row("st-foreign-rank", "prog-visible", "r-foreign"),
            student_row("st-no-program", None, None),
            student_row("st-second", "prog-second", None),
            student_row("st-members", "prog-visible", None),
            student_row("st-other-studio", "prog-foreign", None, studio_id=OTHER_STUDIO_ID),
        ],
        "student_program_memberships": [
            membership_row("m-hidden", "st-members", "prog-visible", "r-archived"),
            membership_row("m-paused", "st-members", "prog-visible", "p-white", status="paused"),
            membership_row(
                "m-ended", "st-members", "prog-visible", None, ended_at="2026-02-01T00:00:00Z"
            ),
        ],
        "promotions": [
            {
                "studio_id": STUDIO_ID,
                "student_id": "st-white",
                "student_program_membership_id": None,
                "program_id": "prog-visible",
                "promoted_at": "2026-03-01T00:00:00Z",
            }
        ],
        "attendance": [
            attendance_row("st-white", "2026-02-15T12:00:00Z", "prog-visible"),
            attendance_row("st-white", "2026-03-15T12:00:00Z", "prog-visible"),
            attendance_row("st-white", "2026-03-16T12:00:00Z", "prog-second"),
        ],
    }


def eligibility_outcome(supabase, ladder_id, **kwargs):
    try:
        entries = asyncio.run(
            BeltEligibilityCalculator(supabase).get_eligibility(STUDIO_ID, ladder_id, **kwargs)
        )
    except HTTPException as exc:
        return ("error", exc.status_code, exc.detail)
    return [entry.model_dump() for entry in entries]


def studio_ladder_snapshot(tables):
    rows = [row for row in tables["belt_ladders"] if row["studio_id"] == STUDIO_ID]
    return sorted(rows, key=lambda row: row["created_at"])


class BeltServiceTest(unittest.TestCase):
    def test_sync_ladder_uses_atomic_idempotent_audit_rpc(self):
        operation_id = "99999999-9999-4999-8999-999999999999"
        supabase = FakeSupabase(
            {
                "belt_ladders": [
                    {
                        "id": LADDER_ID,
                        "studio_id": STUDIO_ID,
                        "program_id": PROGRAM_ID,
                        "name": "Karate",
                        "sub_rank_term": "Stripe",
                        "created_at": "2026-08-14T00:00:00Z",
                        "updated_at": "2026-08-14T00:00:00Z",
                    }
                ],
                "belt_ranks": [],
                "audit_logs": [],
            }
        )

        response = asyncio.run(
            BeltService(supabase).sync_ladder(
                LADDER_ID,
                BeltLadderSyncRequest(
                    operation_id=operation_id,
                    sub_rank_term="Stripe",
                    ranks=[{"name": "White Belt", "color_hex": "#FFFFFF"}],
                ),
                STUDIO_ID,
                ACTOR_ID,
            )
        )

        self.assertEqual(response.ranks[0].name, "White Belt")
        self.assertEqual(supabase.rpc_calls[0][0], "sync_belt_ladder_ranks_v2")
        self.assertEqual(supabase.rpc_calls[0][1]["p_operation_id"], operation_id)
        self.assertEqual(supabase.tables["audit_logs"][0]["metadata"]["operation_id"], operation_id)
        direct_audit_inserts = [
            entry
            for entry in supabase.query_log
            if entry["table"] == "audit_logs" and entry["insert"] is not None
        ]
        self.assertEqual(direct_audit_inserts, [])

    def test_delete_assigned_rank_returns_conflict_with_sync_guidance(self):
        supabase = FakeSupabase({"belt_ranks": []})
        supabase.table_failures["belt_ranks"] = PostgrestAPIError(
            {
                "code": "P0001",
                "message": "Assigned belt ranks must be deleted through sync_belt_ladder_ranks.",
                "details": "",
                "hint": "",
            }
        )

        with self.assertRaises(HTTPException) as raised:
            asyncio.run(BeltService(supabase).delete_rank(FROM_RANK_ID, STUDIO_ID))

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("full belt ladder", raised.exception.detail)

    def test_delete_unassigned_rank_remains_available(self):
        supabase = FakeSupabase(
            {
                "belt_ranks": [{"id": FROM_RANK_ID, "studio_id": STUDIO_ID}],
            }
        )

        asyncio.run(BeltService(supabase).delete_rank(FROM_RANK_ID, STUDIO_ID))

        self.assertEqual(supabase.tables["belt_ranks"], [])

    def test_list_ladders_does_not_repair_program_ladders(self):
        supabase = FakeSupabase(
            {
                "programs": [
                    {
                        "id": PROGRAM_ID,
                        "studio_id": STUDIO_ID,
                        "name": "Program with no ladder",
                        "is_system": False,
                        "archived_at": None,
                    }
                ],
                "belt_ladders": [],
            }
        )
        service = BeltService(supabase)

        ladders = asyncio.run(service.list_ladders(STUDIO_ID))
        self.assertTrue(
            all(
                q["insert"] is None
                and q["upsert"] is None
                and q["update"] is None
                and not q["delete"]
                for q in supabase.query_log
            )
        )

        self.assertEqual(ladders, [])

    def test_unfiltered_eligibility_fetches_full_history_for_unpromoted_program(self):
        second_from_rank_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        second_to_rank_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        first_membership_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        second_membership_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        promotion_time = "2026-05-20T12:00:00Z"
        rank_defaults = {
            "studio_id": STUDIO_ID,
            "min_classes": 0,
            "min_months": 0,
            "requires_approval": False,
        }
        attendance_defaults = {
            "studio_id": STUDIO_ID,
            "student_id": STUDENT_ID,
            "status": "present",
            "counts_toward_eligibility": True,
            "class_sessions.status": "scheduled",
            "class_sessions.deleted_at": None,
        }
        supabase = FakeSupabase(
            {
                "belt_ladders": [
                    {
                        "id": LADDER_ID,
                        "studio_id": STUDIO_ID,
                        "name": "First program",
                        "program_id": PROGRAM_ID,
                    },
                    {
                        "id": SECOND_LADDER_ID,
                        "studio_id": STUDIO_ID,
                        "name": "Second program",
                        "program_id": SECOND_PROGRAM_ID,
                    },
                ],
                "belt_ranks": [
                    {
                        **rank_defaults,
                        "id": FROM_RANK_ID,
                        "ladder_id": LADDER_ID,
                        "name": "First current",
                        "color_hex": "#ffffff",
                        "display_order": 1,
                    },
                    {
                        **rank_defaults,
                        "id": TO_RANK_ID,
                        "ladder_id": LADDER_ID,
                        "name": "First next",
                        "color_hex": "#111111",
                        "display_order": 2,
                        "min_classes": 1,
                    },
                    {
                        **rank_defaults,
                        "id": second_from_rank_id,
                        "ladder_id": SECOND_LADDER_ID,
                        "name": "Second current",
                        "color_hex": "#eeeeee",
                        "display_order": 1,
                    },
                    {
                        **rank_defaults,
                        "id": second_to_rank_id,
                        "ladder_id": SECOND_LADDER_ID,
                        "name": "Second next",
                        "color_hex": "#222222",
                        "display_order": 2,
                        "min_classes": 1,
                    },
                ],
                "students": [
                    {
                        "id": STUDENT_ID,
                        "studio_id": STUDIO_ID,
                        "legal_first_name": "Two",
                        "legal_last_name": "Programs",
                        "preferred_name": None,
                        "membership_start_date": "2026-01-01T00:00:00Z",
                        "program_id": PROGRAM_ID,
                        "current_belt_rank_id": FROM_RANK_ID,
                        "status": "active",
                        "deleted_at": None,
                    }
                ],
                "student_program_memberships": [
                    {
                        "id": first_membership_id,
                        "student_id": STUDENT_ID,
                        "studio_id": STUDIO_ID,
                        "program_id": PROGRAM_ID,
                        "status": "active",
                        "ended_at": None,
                        "started_at": "2026-01-01T00:00:00Z",
                        "current_belt_rank_id": FROM_RANK_ID,
                    },
                    {
                        "id": second_membership_id,
                        "student_id": STUDENT_ID,
                        "studio_id": STUDIO_ID,
                        "program_id": SECOND_PROGRAM_ID,
                        "status": "active",
                        "ended_at": None,
                        "started_at": "2026-01-01T00:00:00Z",
                        "current_belt_rank_id": second_from_rank_id,
                    },
                ],
                "promotions": [
                    {
                        "student_id": STUDENT_ID,
                        "student_program_membership_id": first_membership_id,
                        "program_id": PROGRAM_ID,
                        "studio_id": STUDIO_ID,
                        "promoted_at": promotion_time,
                    }
                ],
                "attendance": [
                    {
                        **attendance_defaults,
                        "checked_in_at": promotion_time,
                        "class_sessions": {"program_id": PROGRAM_ID},
                    },
                    {
                        **attendance_defaults,
                        "checked_in_at": "2026-05-01T12:00:00Z",
                        "class_sessions": {"program_id": SECOND_PROGRAM_ID},
                    },
                    {
                        **attendance_defaults,
                        "checked_in_at": "2026-05-02T12:00:00Z",
                        "counts_toward_eligibility": False,
                        "class_sessions": {"program_id": SECOND_PROGRAM_ID},
                    },
                    {
                        **attendance_defaults,
                        "studio_id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                        "checked_in_at": "2026-05-03T12:00:00Z",
                        "class_sessions": {"program_id": SECOND_PROGRAM_ID},
                    },
                    {
                        **attendance_defaults,
                        "checked_in_at": "2026-05-21T12:00:00Z",
                        "class_sessions": {"program_id": PROGRAM_ID},
                        "class_sessions.status": "canceled",
                    },
                    {
                        **attendance_defaults,
                        "checked_in_at": "2026-05-22T12:00:00Z",
                        "class_sessions": {"program_id": PROGRAM_ID},
                        "class_sessions.deleted_at": "2026-05-22T13:00:00Z",
                    },
                ],
            }
        )
        calculator = BeltEligibilityCalculator(supabase)

        unfiltered = asyncio.run(calculator.get_eligibility(STUDIO_ID))
        first_filtered = asyncio.run(calculator.get_eligibility(STUDIO_ID, LADDER_ID))
        second_filtered = asyncio.run(calculator.get_eligibility(STUDIO_ID, SECOND_LADDER_ID))

        unfiltered_counts = {entry.program_id: entry.classes_since_promo for entry in unfiltered}
        self.assertEqual(unfiltered_counts[PROGRAM_ID], 1)
        self.assertEqual(unfiltered_counts[SECOND_PROGRAM_ID], 1)
        self.assertEqual(unfiltered_counts[PROGRAM_ID], first_filtered[0].classes_since_promo)
        self.assertEqual(
            unfiltered_counts[SECOND_PROGRAM_ID], second_filtered[0].classes_since_promo
        )

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
        supabase = FakeSupabase(
            {
                "belt_ladders": [
                    {
                        "id": LADDER_ID,
                        "studio_id": STUDIO_ID,
                        "name": "Core",
                        "program_id": PROGRAM_ID,
                    }
                ],
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
            }
        )
        calculator = BeltEligibilityCalculator(supabase)

        entries = asyncio.run(calculator.get_eligibility(STUDIO_ID, LADDER_ID))

        self.assertEqual(len(entries), 1001)
        student_ranges = [
            entry["range"]
            for entry in supabase.query_log
            if entry["table"] == "students" and entry["columns"].startswith("id, legal_first_name")
        ]
        self.assertEqual(student_ranges, [(0, 999), (1000, 1999)])
        membership_queries = [
            entry for entry in supabase.query_log if entry["table"] == "student_program_memberships"
        ]
        self.assertGreater(len(membership_queries), 1)
        self.assertTrue(
            all(
                len(
                    next(
                        value
                        for op, key, value in entry["filters"]
                        if op == "in" and key == "student_id"
                    )
                )
                <= 100
                for entry in membership_queries
            )
        )

    def test_primary_ladder_eligibility_matches_list_ladders_then_eligibility(self):
        supabase = FakeSupabase(primary_ladder_tables())
        service = BeltService(supabase)

        with patch.object(belt_eligibility, "datetime", _FrozenDatetime):
            ladders = asyncio.run(service.list_ladders(STUDIO_ID))
            previous = asyncio.run(service.get_eligibility(STUDIO_ID, ladders[0].id))
            start = len(supabase.query_log)
            primary, entries = asyncio.run(service.get_primary_ladder_eligibility(STUDIO_ID))

        self.assertEqual(primary.model_dump(), ladders[0].model_dump())
        self.assertEqual(
            [entry.model_dump() for entry in entries], [entry.model_dump() for entry in previous]
        )
        self.assertEqual(primary.id, "lad-primary")
        # Embedded order is the response's; the calculator steps in canonical order.
        self.assertEqual([rank.id for rank in primary.ranks], ["p-white", "p-z", "p-a", "p-top"])
        self.assertEqual(
            [
                (
                    entry.student_id,
                    entry.student_program_membership_id,
                    entry.current_rank_id,
                    entry.next_rank_id,
                )
                for entry in entries
            ],
            [
                ("st-unranked", None, None, "p-white"),
                ("st-white", None, "p-white", "p-a"),
                ("st-z", None, "p-z", "p-top"),
                ("st-a", None, "p-a", "p-z"),
                ("st-foreign-rank", None, None, "p-white"),
                ("st-members", "m-paused", "p-white", "p-a"),
            ],
        )
        self.assertEqual(
            next(entry for entry in entries if entry.student_id == "st-white").classes_since_promo,
            1,
        )
        reads = supabase.query_log[start:]
        self.assertEqual(
            [(read["table"], read["columns"]) for read in reads[:3]],
            [
                ("programs", "id, is_system, archived_at"),
                ("belt_ladders", "*, belt_ranks(*)"),
                ("belt_ranks", "*"),
            ],
        )
        self.assertEqual(sum(read["table"] == "belt_ladders" for read in reads), 1)
        self.assertEqual(reads[1]["filters"], (("eq", "studio_id", STUDIO_ID),))

        # Visible ladders alone would turn hidden-rank students into unranked candidates.
        visible = [row for row in supabase.tables["belt_ladders"] if row["id"] == "lad-primary"]
        with patch.object(belt_eligibility, "datetime", _FrozenDatetime):
            narrowed = asyncio.run(
                BeltEligibilityCalculator(supabase).get_eligibility(
                    STUDIO_ID, "lad-primary", ladder_rows=visible
                )
            )
        self.assertLessEqual(
            {"st-archived", "st-system", "st-unscoped"}, {entry.student_id for entry in narrowed}
        )

    def test_primary_ladder_keeps_provider_order_for_same_created_at(self):
        tables = primary_ladder_tables()
        ladders = tables["belt_ladders"]
        ladders[-2], ladders[-1] = ladders[-1], ladders[-2]
        service = BeltService(FakeSupabase(tables))

        listed = asyncio.run(service.list_ladders(STUDIO_ID))
        primary, _entries = asyncio.run(service.get_primary_ladder_eligibility(STUDIO_ID))

        self.assertEqual(primary.id, "lad-second")
        self.assertEqual(primary.model_dump(), listed[0].model_dump())

    def test_primary_ladder_eligibility_without_visible_ladder_reads_no_facts(self):
        no_visible_program = primary_ladder_tables()
        for program in no_visible_program["programs"]:
            program["archived_at"] = "2026-01-01T00:00:00Z"
        only_hidden_ladders = primary_ladder_tables()
        only_hidden_ladders["belt_ladders"] = [
            row
            for row in only_hidden_ladders["belt_ladders"]
            if row["id"] not in {"lad-primary", "lad-second"}
        ]

        for tables, reads in (
            (no_visible_program, ["programs"]),
            (only_hidden_ladders, ["programs", "belt_ladders"]),
        ):
            with self.subTest(reads=reads):
                supabase = FakeSupabase(tables)
                self.assertIsNone(
                    asyncio.run(BeltService(supabase).get_primary_ladder_eligibility(STUDIO_ID))
                )
                self.assertEqual([read["table"] for read in supabase.query_log], reads)

    def test_primary_ladder_eligibility_pages_ladders_and_ranks_past_the_provider_cap(self):
        # Each older hidden ladder owns a rank, so the primary's ranks and the
        # later hidden ladder's rank sort onto the second rank page.
        older = [
            ladder_row(
                f"lad-old-{index:04d}",
                "prog-archived",
                "2024-01-01T00:00:00Z",
                [rank_row(f"lad-old-{index:04d}-1", f"lad-old-{index:04d}", 1)],
            )
            for index in range(PROVIDER_MAX_ROWS)
        ]
        later = [
            ladder_row(
                "lad-zz-hidden",
                "prog-archived",
                "2025-01-02T00:00:00Z",
                [rank_row("r-late", "lad-zz-hidden", 1)],
            ),
            ladder_row(
                "lad-primary",
                "prog-visible",
                "2025-02-01T00:00:00Z",
                [rank_row("p-white", "lad-primary", 1), rank_row("p-top", "lad-primary", 2)],
            ),
        ]
        tables = {
            "programs": [
                program_row("prog-visible"),
                program_row("prog-archived", archived_at="2026-01-01T00:00:00Z"),
            ],
            **with_ranks([*older, *later]),
            "students": [
                student_row("st-unranked", "prog-visible", None),
                student_row("st-white", "prog-visible", "p-white"),
                student_row("st-top", "prog-visible", "p-top"),
                student_row("st-late", "prog-visible", "r-late"),
                student_row("st-old", "prog-visible", "lad-old-0000-1"),
            ],
            "student_program_memberships": [],
            "promotions": [],
            "attendance": [],
        }
        supabase = CappedSupabase(copy.deepcopy(tables))
        uncapped = BeltService(FakeSupabase(copy.deepcopy(tables)))

        with patch.object(belt_eligibility, "datetime", _FrozenDatetime):
            primary, entries = asyncio.run(
                BeltService(supabase).get_primary_ladder_eligibility(STUDIO_ID)
            )
            ladders = asyncio.run(uncapped.list_ladders(STUDIO_ID))
            complete = asyncio.run(uncapped.get_eligibility(STUDIO_ID, ladders[0].id))

        self.assertEqual(primary.model_dump(), ladders[0].model_dump())
        self.assertEqual(
            [entry.model_dump() for entry in entries], [entry.model_dump() for entry in complete]
        )
        # Hidden ladders on either page still own their ranks; p-top has no next rank.
        self.assertEqual(
            [(entry.student_id, entry.current_rank_id, entry.next_rank_id) for entry in entries],
            [("st-unranked", None, "p-white"), ("st-white", "p-white", "p-top")],
        )
        for table in ("belt_ladders", "belt_ranks"):
            self.assertEqual(
                [read["range"] for read in supabase.query_log if read["table"] == table],
                [(0, 999), (1000, 1999)],
            )
        rank_reads = [read for read in supabase.query_log if read["table"] == "belt_ranks"]
        self.assertTrue(
            all(
                read["columns"] == "*"
                and read["filters"] == (("eq", "studio_id", STUDIO_ID),)
                and read["orders"]
                == (
                    ("ladder_id", False),
                    ("display_order", False),
                    ("created_at", False),
                    ("id", False),
                )
                for read in rank_reads
            )
        )

    def test_calculator_ladder_rows_match_its_own_ladder_read(self):
        def tables(ladders, students):
            return {
                "programs": [],
                **with_ranks(ladders),
                "students": students,
                "student_program_memberships": [],
                "promotions": [],
                "attendance": [],
            }

        def unscoped(ladder_id, created_at):
            return ladder_row(
                ladder_id, None, created_at, [rank_row(f"{ladder_id}-1", ladder_id, 1)]
            )

        def scoped(ladder_id, program_id, created_at, ranks=True):
            return ladder_row(
                ladder_id,
                program_id,
                created_at,
                [rank_row(f"{ladder_id}-1", ladder_id, 1), rank_row(f"{ladder_id}-2", ladder_id, 2)]
                if ranks
                else [],
            )

        students = [
            student_row("st-no-program", None, None),
            student_row("st-program", PROGRAM_ID, None),
            student_row("st-unladdered-program", SECOND_PROGRAM_ID, None),
            student_row("st-ranked", PROGRAM_ID, "lad-p-1"),
            student_row("st-unknown-rank", None, "missing-rank"),
        ]
        scenarios = {
            "single-unscoped": tables([unscoped("lad-u", "2025-01-01T00:00:00Z")], students),
            "sole-unscoped-among-programs": tables(
                [
                    scoped("lad-p", PROGRAM_ID, "2025-01-01T00:00:00Z"),
                    unscoped("lad-u", "2025-01-02T00:00:00Z"),
                    scoped("lad-q", "33333333-0000-4000-8000-000000000000", "2025-01-03T00:00:00Z"),
                ],
                students,
            ),
            "multiple-unscoped": tables(
                [
                    unscoped("lad-u", "2025-01-01T00:00:00Z"),
                    unscoped("lad-v", "2025-01-02T00:00:00Z"),
                    scoped("lad-p", PROGRAM_ID, "2025-01-03T00:00:00Z"),
                ],
                students,
            ),
            "ladder-without-ranks": tables(
                [
                    scoped("lad-p", PROGRAM_ID, "2025-01-01T00:00:00Z"),
                    scoped("lad-empty", SECOND_PROGRAM_ID, "2025-01-02T00:00:00Z", ranks=False),
                ],
                students,
            ),
            "no-ladders": tables([], students),
        }
        outcomes = {}

        for name, scenario in scenarios.items():
            ladder_ids = [None, *(row["id"] for row in scenario["belt_ladders"]), "unknown"]
            for ladder_id in ladder_ids:
                with self.subTest(scenario=name, ladder_id=ladder_id):
                    own_supabase = FakeSupabase(copy.deepcopy(scenario))
                    supplied_supabase = FakeSupabase(copy.deepcopy(scenario))
                    with patch.object(belt_eligibility, "datetime", _FrozenDatetime):
                        own = eligibility_outcome(own_supabase, ladder_id)
                        supplied = eligibility_outcome(
                            supplied_supabase,
                            ladder_id,
                            ladder_rows=studio_ladder_snapshot(scenario),
                        )
                    self.assertEqual(supplied, own)
                    outcomes[name, ladder_id] = own
                    self.assertEqual(
                        [
                            read["columns"]
                            for read in own_supabase.query_log
                            if read["table"] == "belt_ladders"
                        ],
                        ["id, name, program_id"],
                    )
                    # Without a snapshot, ranks stay one unpaged read.
                    self.assertTrue(
                        all(
                            read["range"] is None
                            for read in own_supabase.query_log
                            if read["table"] == "belt_ranks"
                        )
                    )
                    self.assertFalse(
                        any(read["table"] == "belt_ladders" for read in supplied_supabase.query_log)
                    )

        def students_in(outcome):
            return [entry["student_id"] for entry in outcome]

        # The comparisons above cover each fallback, not only empty results.
        self.assertIn("st-no-program", students_in(outcomes["single-unscoped", None]))
        self.assertIn("st-no-program", students_in(outcomes["sole-unscoped-among-programs", None]))
        self.assertNotIn("st-no-program", students_in(outcomes["multiple-unscoped", None]))
        self.assertIn("st-ranked", students_in(outcomes["sole-unscoped-among-programs", None]))
        self.assertEqual(outcomes["ladder-without-ranks", "lad-empty"], [])
        self.assertEqual(outcomes["no-ladders", None], [])
        self.assertEqual(
            outcomes["single-unscoped", "unknown"], ("error", 404, "Belt ladder not found")
        )

    def test_calculator_ignores_ladder_rows_from_another_studio(self):
        tables = {
            **with_ranks(
                [
                    ladder_row(
                        "lad-u", None, "2025-01-01T00:00:00Z", [rank_row("lad-u-1", "lad-u", 1)]
                    )
                ]
            ),
            "students": [student_row("st-no-program", None, None)],
            "student_program_memberships": [],
            "promotions": [],
            "attendance": [],
        }
        snapshot = [
            ladder_row("lad-foreign", None, "2024-01-01T00:00:00Z", studio_id=OTHER_STUDIO_ID),
            *studio_ladder_snapshot(tables),
        ]
        supabase = FakeSupabase(tables)

        # A foreign unscoped ladder would end the studio's single-ladder fallback.
        self.assertEqual(
            [
                entry["student_id"]
                for entry in eligibility_outcome(supabase, None, ladder_rows=snapshot)
            ],
            ["st-no-program"],
        )
        self.assertEqual(
            eligibility_outcome(supabase, "lad-foreign", ladder_rows=snapshot),
            ("error", 404, "Belt ladder not found"),
        )


if __name__ == "__main__":
    unittest.main()
