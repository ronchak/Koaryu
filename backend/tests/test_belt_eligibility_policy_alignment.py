"""Rank suggestions use the authoritative rank owner's deterministic ordering."""

import asyncio
from itertools import permutations

import pytest

from app.services.belt_eligibility import BeltEligibilityCalculator
from tests.fakes.supabase import TableBackedSupabase


@pytest.mark.parametrize("order", list(permutations(range(3))))
@pytest.mark.parametrize("current_index,expected_index", [(None, 0), (0, 1), (1, 2), (2, None)])
def test_tied_rank_order_is_created_at_then_id_for_first_next_and_highest(
    order, current_index, expected_index
):
    # The oldest row deliberately has the largest ID; then equal timestamps use ID.
    ranks = [
        {"id": "rank-z", "created_at": "2026-01-01T00:00:00Z"},
        {"id": "rank-a", "created_at": "2026-01-02T00:00:00Z"},
        {"id": "rank-b", "created_at": "2026-01-02T00:00:00Z"},
    ]
    ranks = [
        {
            **rank,
            "studio_id": "studio",
            "ladder_id": "ladder",
            "display_order": 1,
            "name": rank["id"],
            "color_hex": "#FFFFFF",
            "min_classes": 0,
            "min_months": 0,
            "requires_approval": False,
        }
        for rank in ranks
    ]
    database = TableBackedSupabase(
        {
            "belt_ladders": [
                {"id": "ladder", "studio_id": "studio", "name": "Belts", "program_id": None}
            ],
            "belt_ranks": [ranks[index] for index in order],
            "students": [
                {
                    "id": "student",
                    "studio_id": "studio",
                    "legal_first_name": "Sam",
                    "legal_last_name": "Lee",
                    "program_id": None,
                    "current_belt_rank_id": ranks[current_index]["id"]
                    if current_index is not None
                    else None,
                    "status": "active",
                    "deleted_at": None,
                }
            ],
        }
    )
    entries = asyncio.run(BeltEligibilityCalculator(database).get_eligibility("studio", "ladder"))
    assert [entry.next_rank_id for entry in entries] == (
        [] if expected_index is None else [ranks[expected_index]["id"]]
    )
    query = next(item for item in database.query_log if item["table"] == "belt_ranks")
    assert query["orders"] == (
        ("ladder_id", False),
        ("display_order", False),
        ("created_at", False),
        ("id", False),
    )
