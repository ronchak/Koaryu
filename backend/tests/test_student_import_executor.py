import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.schemas.student import CsvImportOptions, CsvImportResult
from app.services.student_import_executor import StudentImportExecutor
from tests.fakes.supabase import TableBackedSupabase

RUN = "44444444-4444-4444-8444-444444444444"
STUDIO = "22222222-2222-4222-8222-222222222222"
PROGRAM = "33333333-3333-4333-8333-333333333333"
OTHER = "33333333-3333-4333-8333-333333333334"
MAPPING = {"First": "legal_first_name", "Last": "legal_last_name", "Program": "program_id", "Status": "status", "Belt": "current_belt_rank_id"}


class ScriptedImportDb(TableBackedSupabase):
    """Canned server boundaries; no duplicate claim or persistence algorithm."""
    def __init__(self):
        super().__init__({"programs": [
            {"id": PROGRAM, "studio_id": STUDIO, "name": "Karate"},
            {"id": OTHER, "studio_id": STUDIO, "name": "BJJ"},
        ], "belt_ladders": [], "belt_ranks": []})
        self.responses = []
        self.calls = []

    def rpc(self, name, params):
        def execute():
            expected_name, response = self.responses.pop(0)
            assert name == expected_name
            self.calls.append((name, deepcopy(params)))
            if isinstance(response, Exception):
                raise response
            return SimpleNamespace(data=response(params) if callable(response) else response)
        return SimpleNamespace(execute=execute)

    def execute_import(self, rows, **options):
        return asyncio.run(StudentImportExecutor(self).execute_import(
            rows, MAPPING, CsvImportOptions(**options), STUDIO, "actor", "same-key"))


def claim(receipts=()):
    return [{"claim_status": "claimed", "run_row": {"id": RUN, "receipts": list(receipts)}}]


def row_success(params):
    return [{"student_id": params["p_student"]["id"], "guardian_imported": False}]


def selected_program(program_id, name):
    return {"program_id": program_id, "name": name, "created": False, "ladder_id": None, "warning": None}


def finish(params):
    saved = {**params["p_result_json"], "non_critical_errors": ["Frozen audit warning"], "execution_status": "completed_with_warnings"}
    return [{"updated": True, "run_row": {"result_json": saved}}]


def test_unknown_row_failure_retries_same_key_and_preloads_original_outcomes():
    db = ScriptedImportDb()
    rows = [
        {"First": "Ava", "Last": "Nguyen", "Program": "Karate", "Status": "current", "Belt": "Azure"},
        {"First": "Mina", "Last": "Nguyen", "Program": "BJJ"},
        {"Last": "Invalid", "Program": "Do not create"},
    ]
    karate, bjj = selected_program(PROGRAM, "Karate"), selected_program(OTHER, "BJJ")
    db.responses = [("claim_student_import_run_v2", claim()),
                    ("prepare_student_import_program_v1", karate), ("prepare_student_import_program_v1", bjj),
                    ("import_student_row_atomic", row_success),
                    ("import_student_row_atomic", RuntimeError("private_database_failure")),
                    ("finish_student_import_run", [{"updated": True}])]
    with pytest.raises(HTTPException) as error:
        db.execute_import(rows, create_missing_programs=True)
    assert error.value.status_code == 500 and error.value.detail["code"] == "STUDENT_IMPORT_FAILED"
    assert "private_database_failure" not in str(error.value.detail)
    assert db.calls[-1][1]["p_status"] == "failed" and db.calls[-1][1]["p_result_json"] is None
    bindings = [params for name, params in db.calls if name == "prepare_student_import_program_v1"]
    assert [(p["p_key"], p["p_program_id"], p["p_create_program"], p["p_ladder_id"]) for p in bindings] == [
        ("karate", PROGRAM, False, None), ("bjj", OTHER, False, None),
    ]
    first_row = next(params for name, params in db.calls if name == "import_student_row_atomic")
    assert first_row["p_row_number"] == 2 and first_row["p_program_ids"] == [PROGRAM]
    assert first_row["p_student"]["notes"] == "Imported current belt (unresolved): Azure"
    receipt = {"kind": "student", "key": "2", "result": {
        "student_id": first_row["p_student"]["id"], "guardian_imported": False,
        "outcome": first_row["p_student"]["_import_outcome"],
    }}
    # Changed reference data must not revalidate or rewrite the already committed row.
    db.tables["programs"][0].update(name="Renamed", archived_at="2026-09-10")
    db.tables["programs"][1]["name"] = "Renamed BJJ"
    db.responses = [("claim_student_import_run_v2", claim([
                        receipt, {"kind": "program", "key": "karate", "result": karate},
                        {"kind": "program", "key": "bjj", "result": bjj},
                    ])),
                    ("import_student_row_atomic", row_success), ("finish_student_import_run", finish)]
    result = db.execute_import(rows, create_missing_programs=True)
    assert result.imported_count == 2 and result.error_rows == 1
    assert result.normalized_status_count == 1 and result.imported_without_belt_count == 1
    assert result.execution_status == "completed_with_warnings" and result.non_critical_errors == ["Frozen audit warning"]
    writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert [params["p_row_number"] for params in writes] == [2, 3, 3]
    assert writes[1]["p_student"]["id"] == writes[2]["p_student"]["id"]
    assert writes[2]["p_program_ids"] == [OTHER] and result.created_programs == []
    claims = [params for name, params in db.calls if name == "claim_student_import_run_v2"]
    assert claims[0]["p_request_hash"] == claims[1]["p_request_hash"]
    assert all(params["p_idempotency_key"] == "same-key" for params in claims)
    assert writes[2]["p_processing_token"] == claims[1]["p_processing_token"]
    assert sum(query["table"] == "programs" for query in db.query_log) == 2
    assert all(not query["insert"] and not query["update"] and not query["upsert"] for query in db.query_log)
    assert not db.responses


def test_completed_claim_and_all_receipted_recovery_need_no_reference_reads():
    expected = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1, non_critical_errors=["Original warning"])
    db = ScriptedImportDb()
    db.responses = [("claim_student_import_run_v2", [{"claim_status": "completed", "run_row": {"result_json": expected.model_dump(mode="json")}}])]
    result = db.execute_import([{"First": "Ava", "Last": "Nguyen"}])
    assert result == expected.model_copy(update={"idempotency_key": "same-key", "reused_result": True, "execution_status": "reused"})
    assert not db.query_log and len(db.calls) == 1
    receipt = {"kind": "student", "key": "2", "result": {"outcome": {
        "row_number": 2, "is_valid": True, "issues": [], "data": {}, "imported_without_belt": False,
    }}}
    db.responses = [("claim_student_import_run_v2", claim([receipt])), ("finish_student_import_run", finish)]
    result = db.execute_import([{"First": "Ava", "Last": "Nguyen"}])
    assert result.imported_count == 1 and result.non_critical_errors == ["Frozen audit warning"]
    assert not db.query_log and not db.responses


def test_setup_batches_requested_belts_and_excludes_rejected_rows():
    db = ScriptedImportDb()
    def setup(params):
        assert params["p_program_id"] == OTHER and params["p_create_ladder"] is True
        assert [rank["key"] for rank in params["p_ranks"]] == ["white", "blue"]
        assert all(rank["existing_id"] is None for rank in params["p_ranks"])
        return {"ladder": {"ladder_id": params["p_ladder_id"], "name": "BJJ", "created": True}, "ranks": [
            {"rank_id": rank["id"], "name": rank["name"], "ladder_id": params["p_ladder_id"], "ladder_name": "BJJ", "created": True}
            for rank in params["p_ranks"]
        ]}
    db.responses = [("claim_student_import_run_v2", claim()),
                    ("prepare_student_import_program_v1", selected_program(OTHER, "BJJ")),
                    ("prepare_student_import_belts_v1", setup),
                    ("import_student_row_atomic", row_success), ("import_student_row_atomic", row_success),
                    ("finish_student_import_run", finish)]
    result = db.execute_import([
        {"First": "Ava", "Last": "Nguyen", "Program": "BJJ", "Belt": "Blue"},
        {"First": "Mina", "Last": "Nguyen", "Program": "BJJ", "Belt": "White"},
        {"Last": "Invalid", "Program": "Do not create", "Belt": "Red"},
    ], create_missing_programs=True, create_missing_belts=True)
    assert result.created_programs == [] and result.created_ladders == ["BJJ"]
    assert result.created_belts == ["White (BJJ)", "Blue (BJJ)"]
    assert result.imported_count == 2 and result.error_rows == 1 and not db.responses
    assert sum(query["table"] == "programs" for query in db.query_log) == 1
