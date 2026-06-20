from __future__ import annotations

from app.schemas.student import CsvImportOptions
from app.services.student_import_planner import StudentImportPlanner
from app.services.student_service import StudentService
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


def test_student_service_none_validation_still_delegates_to_planner():
    service = StudentService(None)

    result = service.validate_import_rows(
        [{"First": "Aiko", "Last": "Tanaka", "Status": "current"}],
        {"First": "legal_first_name", "Last": "legal_last_name", "Status": "status"},
        CsvImportOptions(),
        studio_id=None,
    )

    assert result.valid_rows == 1
    assert result.normalized_status_count == 1
