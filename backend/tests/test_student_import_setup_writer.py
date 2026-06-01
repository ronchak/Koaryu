from __future__ import annotations

from app.services.student_import_setup_writer import StudentImportSetupWriter
from tests.fakes.supabase import TableBackedSupabase


IMPORT_RUN_ID = "00000000-0000-0000-0000-000000000001"


class FakeProgramService:
    calls: list[str] = []

    def __init__(self, _supabase):
        pass

    def ensure_program_ladders(self, studio_id: str) -> None:
        self.calls.append(studio_id)


def test_setup_writer_creates_missing_programs_and_resolves_planned_rows(monkeypatch):
    monkeypatch.setattr(
        "app.services.student_import_setup_writer.ProgramService",
        FakeProgramService,
    )
    FakeProgramService.calls = []
    supabase = TableBackedSupabase({"programs": [], "audit_logs": []})
    planned_rows = [{
        "pending_program_name": "Kids BJJ",
        "resolved_program_id": None,
    }]

    created = StudentImportSetupWriter(supabase)._create_missing_programs(
        "studio_1",
        "actor_1",
        planned_rows,
        IMPORT_RUN_ID,
    )

    assert created == ["Kids BJJ"]
    assert FakeProgramService.calls == ["studio_1"]
    assert supabase.tables["programs"][0]["name"] == "Kids BJJ"
    assert planned_rows[0]["resolved_program_id"] == supabase.tables["programs"][0]["id"]
    assert supabase.tables["audit_logs"][0]["action"] == "programs.created_from_import"


def test_setup_writer_creates_program_ladder_and_belt_rank_for_pending_rows():
    supabase = TableBackedSupabase({
        "programs": [{"id": "program_bjj", "studio_id": "studio_1", "name": "BJJ"}],
        "belt_ladders": [],
        "belt_ranks": [],
        "audit_logs": [],
    })
    planned_rows = [{
        "pending_belt_name": "Green",
        "resolved_program_id": "program_bjj",
        "belt_creation_target_ladder_id": None,
        "belt_creation_requires_new_ladder": True,
        "issues": [],
        "is_valid": True,
    }]
    belt_rank_lookup = {
        "ladders_by_program": {},
        "ladder_meta": {},
    }

    created_ladders, created_belts = StudentImportSetupWriter(supabase)._create_missing_belts(
        "studio_1",
        "actor_1",
        planned_rows,
        belt_rank_lookup,
        IMPORT_RUN_ID,
    )

    assert created_ladders == ["BJJ"]
    assert created_belts == ["Green (BJJ)"]
    assert supabase.tables["belt_ladders"][0]["program_id"] == "program_bjj"
    assert supabase.tables["belt_ranks"][0]["ladder_id"] == supabase.tables["belt_ladders"][0]["id"]
    assert planned_rows[0]["resolved_belt_rank_id"] == supabase.tables["belt_ranks"][0]["id"]
    assert [row["action"] for row in supabase.tables["audit_logs"]] == [
        "belt_ladders.created_from_import",
        "belt_ranks.created_from_import",
    ]
