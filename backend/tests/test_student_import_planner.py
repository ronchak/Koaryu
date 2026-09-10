from __future__ import annotations

from app.schemas.student import CsvImportOptions
from app.services.student_import_planner import StudentImportPlanner
from tests.fakes.supabase import TableBackedSupabase


def test_planner_reports_ambiguous_program_names():
    planner = StudentImportPlanner(TableBackedSupabase({
        "programs": [
            {"id": "program_a", "studio_id": "studio_1", "name": "Kids BJJ"},
            {"id": "program_b", "studio_id": "studio_1", "name": "Kids BJJ"},
        ],
        "belt_ladders": [],
        "belt_ranks": [],
    }))

    result, planned_rows = planner.prepare_import(
        [{"First": "Aiko", "Last": "Tanaka", "Program": "Kids BJJ"}],
        {"First": "legal_first_name", "Last": "legal_last_name", "Program": "program_id"},
        "studio_1",
        CsvImportOptions(),
    )

    assert not planned_rows[0]["is_valid"]
    assert any(issue.code == "ambiguous_program" for issue in planned_rows[0]["issues"])
    assert any(issue.code == "ambiguous_program" for issue in result.setup_issues)


def test_planner_resolves_belt_name_inside_selected_program_ladder():
    planner = StudentImportPlanner(TableBackedSupabase({
        "programs": [
            {"id": "program_bjj", "studio_id": "studio_1", "name": "BJJ"},
            {"id": "program_tkd", "studio_id": "studio_1", "name": "TKD"},
        ],
        "belt_ladders": [
            {"id": "ladder_bjj", "studio_id": "studio_1", "name": "BJJ Ladder", "program_id": "program_bjj"},
            {"id": "ladder_tkd", "studio_id": "studio_1", "name": "TKD Ladder", "program_id": "program_tkd"},
        ],
        "belt_ranks": [
            {"id": "rank_bjj_white", "studio_id": "studio_1", "name": "White", "ladder_id": "ladder_bjj"},
            {"id": "rank_tkd_white", "studio_id": "studio_1", "name": "White", "ladder_id": "ladder_tkd"},
        ],
    }))

    _result, planned_rows = planner.prepare_import(
        [{"First": "Aiko", "Last": "Tanaka", "Program": "BJJ", "Belt": "White"}],
        {
            "First": "legal_first_name",
            "Last": "legal_last_name",
            "Program": "program_id",
            "Belt": "current_belt_rank_id",
        },
        "studio_1",
        CsvImportOptions(),
    )

    assert planned_rows[0]["is_valid"]
    assert planned_rows[0]["resolved_program_id"] == "program_bjj"
    assert planned_rows[0]["resolved_belt_rank_id"] == "rank_bjj_white"


def test_planner_truthfully_describes_unresolved_belt_starting_rank_behavior():
    planner = StudentImportPlanner(TableBackedSupabase({
        "programs": [{"id": "program_bjj", "studio_id": "studio_1", "name": "BJJ"}],
        "belt_ladders": [
            {"id": "ladder_bjj", "studio_id": "studio_1", "name": "BJJ Ladder", "program_id": "program_bjj"},
        ],
        "belt_ranks": [
            {"id": "rank_bjj_white", "studio_id": "studio_1", "name": "White", "ladder_id": "ladder_bjj", "is_tip": False, "display_order": 0},
        ],
    }))

    result, planned_rows = planner.prepare_import(
        [{"First": "Aiko", "Last": "Tanaka", "Program": "BJJ", "Belt": "Cerulean"}],
        {
            "First": "legal_first_name",
            "Last": "legal_last_name",
            "Program": "program_id",
            "Belt": "current_belt_rank_id",
        },
        "studio_1",
        CsvImportOptions(import_without_unresolved_belt=True),
    )

    assert planned_rows[0]["is_valid"]
    assert "configured program starts them at its first full belt" in planned_rows[0]["issues"][0].message
    assert "original text to notes" in result.warnings[0].message
    assert "first full belt" in result.warnings[0].message


def test_planner_exposes_missing_ladder_creation_actions():
    planner = StudentImportPlanner(TableBackedSupabase({
        "programs": [{"id": "program_bjj", "studio_id": "studio_1", "name": "BJJ"}],
        "belt_ladders": [],
        "belt_ranks": [],
    }))

    result, planned_rows = planner.prepare_import(
        [{"First": "Aiko", "Last": "Tanaka", "Program": "BJJ", "Belt": "Green"}],
        {
            "First": "legal_first_name",
            "Last": "legal_last_name",
            "Program": "program_id",
            "Belt": "current_belt_rank_id",
        },
        "studio_1",
        CsvImportOptions(create_missing_belts=True),
    )

    assert planned_rows[0]["is_valid"]
    assert planned_rows[0]["pending_belt_name"] == "Green"
    assert planned_rows[0]["belt_creation_requires_new_ladder"]
    assert result.actions_available.can_create_missing_belts
    assert any(issue.code == "missing_belt_ladder" for issue in result.setup_issues)


def test_planner_preserves_missing_program_creation_intent():
    planner = StudentImportPlanner(TableBackedSupabase({
        "programs": [],
        "belt_ladders": [],
        "belt_ranks": [],
    }))

    _result, planned_rows = planner.prepare_import(
        [{"First": "Aiko", "Last": "Tanaka", "Program": "Kids BJJ"}],
        {"First": "legal_first_name", "Last": "legal_last_name", "Program": "program_id"},
        "studio_1",
        CsvImportOptions(create_missing_programs=True),
    )

    assert planned_rows[0]["is_valid"]
    assert planned_rows[0]["pending_program_name"] == "Kids BJJ"
    assert planned_rows[0]["resolved_program_id"] is None
    assert any(issue.code == "missing_program" and issue.severity == "warning" for issue in planned_rows[0]["issues"])



def test_archived_and_confirmed_setup_targets_are_not_recreated():
    program_id = "33333333-3333-4333-8333-333333333333"
    ladder_id = "55555555-5555-4555-8555-555555555555"
    rank_id = "66666666-6666-4666-8666-666666666666"
    db = TableBackedSupabase({
        "programs": [{"id": program_id, "studio_id": "studio", "name": "Renamed program"}],
        "belt_ladders": [{"id": ladder_id, "studio_id": "studio", "name": "Renamed ladder", "program_id": program_id}],
        "belt_ranks": [{"id": rank_id, "studio_id": "studio", "name": "Renamed rank", "ladder_id": ladder_id}],
    })
    receipts = {
        "program": {"bjj": {"program_id": program_id}},
        "ladder": {program_id: {"ladder_id": ladder_id}},
        "rank": {f"{ladder_id}:green": {"rank_id": rank_id, "ladder_id": ladder_id}},
    }
    mapping = {"First": "legal_first_name", "Last": "legal_last_name", "Program": "program_id", "Belt": "current_belt_rank_id"}
    raw = {"First": "Ava", "Last": "Nguyen", "Program": "BJJ", "Belt": "Green"}
    planner = StudentImportPlanner(db)
    options = CsvImportOptions(create_missing_programs=True, create_missing_belts=True)
    _, rows = planner.prepare_import([raw], mapping, "studio", options, receipts)
    assert rows[0]["is_valid"] and rows[0]["resolved_program_id"] == program_id
    assert rows[0]["resolved_belt_rank_id"] == rank_id and not rows[0]["pending_belt_name"]
    db.tables["programs"][0]["archived_at"] = "2026-09-10"
    # Names and IDs both reject archived records even when creation is enabled.
    result, rows = planner.prepare_import([
        {**raw, "Program": "Renamed program"}, {**raw, "Program": program_id},
    ], mapping, "studio", options)
    assert result.error_rows == 2
    assert all(any(issue.code == "unavailable_program" for issue in row["issues"]) and not row["pending_program_name"] for row in rows)
    db.tables["programs"][0]["archived_at"] = None
    db.tables["belt_ranks"] = []
    _, rows = planner.prepare_import([raw], mapping, "studio", options, receipts)
    assert not rows[0]["is_valid"] and not rows[0]["pending_belt_name"]
    assert any(issue.code == "unavailable_belt" for issue in rows[0]["issues"])
    db.tables["programs"] = []
    _, rows = planner.prepare_import([raw], mapping, "studio", options, receipts)
    assert not rows[0]["is_valid"] and not rows[0]["pending_program_name"]
