import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from postgrest.exceptions import APIError

from app.schemas.student import CsvImportDuplicateDecision, CsvImportOptions, CsvImportResult
from app.services.student_import_ids import deterministic_import_uuid
from app.services.student_import_executor import StudentImportExecutor
from app.services.student_service import StudentService
from tests.fakes.supabase import TableBackedSupabase

RUN = "44444444-4444-4444-8444-444444444444"
STUDIO = "22222222-2222-4222-8222-222222222222"
PROGRAM = "33333333-3333-4333-8333-333333333333"
OTHER = "33333333-3333-4333-8333-333333333334"
MAPPING = {
    "First": "legal_first_name",
    "Last": "legal_last_name",
    "DOB": "date_of_birth",
    "Email": "email",
    "Program": "program_id",
    "Status": "status",
    "Belt": "current_belt_rank_id",
}
EXISTING = "77777777-7777-4777-8777-777777777777"


class ScriptedImportDb(TableBackedSupabase):
    """Canned server boundaries; no duplicate claim or persistence algorithm."""

    def __init__(self):
        super().__init__(
            {
                "programs": [
                    {"id": PROGRAM, "studio_id": STUDIO, "name": "Karate"},
                    {"id": OTHER, "studio_id": STUDIO, "name": "BJJ"},
                ],
                "belt_ladders": [],
                "belt_ranks": [],
                "students": [],
                "student_guardians": [],
                "guardians": [],
                "studios": [{"id": STUDIO, "timezone": "America/New_York"}],
            }
        )
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

    def execute_import(self, rows, decisions=None, **options):
        return asyncio.run(
            StudentImportExecutor(self).execute_import(
                rows,
                MAPPING,
                CsvImportOptions(**options),
                STUDIO,
                "actor",
                "same-key",
                duplicate_decisions=decisions,
            )
        )


def claim(receipts=()):
    return [{"claim_status": "claimed", "run_row": {"id": RUN, "receipts": list(receipts)}}]


def row_success(params):
    return [{"student_id": params["p_student"]["id"], "guardian_imported": False}]


def selected_program(program_id, name):
    return {
        "program_id": program_id,
        "name": name,
        "created": False,
        "ladder_id": None,
        "warning": None,
    }


def finish(params):
    saved = {
        **params["p_result_json"],
        "non_critical_errors": ["Frozen audit warning"],
        "execution_status": "completed_with_warnings",
    }
    return [{"updated": True, "run_row": {"result_json": saved}}]


@pytest.mark.parametrize("belt_value", ["Green", "66666666-6666-4666-8666-666666666666"])
def test_scoped_belt_without_program_preview_and_execution_write_no_student(belt_value):
    db = ScriptedImportDb()
    db.tables["belt_ladders"] = [
        {"id": "ladder_bjj", "studio_id": STUDIO, "program_id": OTHER, "name": "BJJ"}
    ]
    db.tables["belt_ranks"] = [
        {
            "id": "66666666-6666-4666-8666-666666666666",
            "studio_id": STUDIO,
            "ladder_id": "ladder_bjj",
            "name": "Green",
        }
    ]
    row = {"First": "Ava", "Last": "Nguyen", "Belt": belt_value}
    before = deepcopy(db.tables)

    preview = StudentService(db).validate_import_rows([row], MAPPING, CsvImportOptions(), STUDIO)
    assert preview.error_rows == 1 and preview.valid_rows == 0
    assert any(
        issue.code == "program_required_for_belt" and issue.field == "program_id"
        for issue in preview.errors[0].issues
    )
    assert not db.calls
    assert db.tables == before
    assert all(
        not query["insert"] and not query["update"] and not query["upsert"]
        for query in db.query_log
    )

    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import([row])
    assert result.error_rows == 1 and result.imported_count == 0
    assert [name for name, _ in db.calls] == [
        "claim_student_import_run_v2",
        "finish_student_import_run",
    ]
    assert db.tables == before
    assert not db.responses


def test_unknown_row_failure_retries_same_key_and_preloads_original_outcomes():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    ladder, rank = "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
    db.tables["belt_ladders"] = [
        {"id": ladder, "studio_id": STUDIO, "program_id": OTHER, "name": "BJJ"}
    ]
    db.tables["belt_ranks"] = [
        {"id": rank, "studio_id": STUDIO, "ladder_id": ladder, "name": "Green"}
    ]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "Status": "current", "Belt": "Azure"},
        {"First": "Mina", "Last": "Nguyen", "Program": "BJJ", "Belt": "Green"},
        {"First": "Sam", "Last": "Nguyen", "Program": "BJJ", "Belt": "Green"},
        {"Last": "Invalid", "Program": "Do not create"},
    ]
    unassigned, bjj = selected_program(PROGRAM, "Unassigned"), selected_program(OTHER, "BJJ")
    rank_binding = {
        "rank_id": rank,
        "name": "Green",
        "ladder_id": ladder,
        "ladder_name": "BJJ",
        "program_id": OTHER,
        "context_program_id": OTHER,
        "created": False,
        "warning": None,
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", unassigned),
        ("prepare_student_import_program_v1", bjj),
        ("bind_student_import_rank_v1", rank_binding),
        ("import_student_row_atomic", row_success),
        ("import_student_row_atomic", row_success),
        ("import_student_row_atomic", RuntimeError("private_database_failure")),
        ("finish_student_import_run", [{"updated": True}]),
    ]
    with pytest.raises(HTTPException) as error:
        db.execute_import(rows, create_missing_programs=True, create_missing_belts=True)
    assert error.value.status_code == 500 and error.value.detail["code"] == "STUDENT_IMPORT_FAILED"
    assert "private_database_failure" not in str(error.value.detail)
    assert db.calls[-1][1]["p_status"] == "failed" and db.calls[-1][1]["p_result_json"] is None
    bindings = [params for name, params in db.calls if name == "prepare_student_import_program_v1"]
    assert [(p["p_key"], p["p_create_program"], p["p_unassigned"]) for p in bindings] == [
        ("__unassigned__", True, True),
        ("bjj", False, False),
    ]
    assert bindings[1]["p_program_id"] == OTHER and bindings[1]["p_ladder_id"] is None
    first_writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert first_writes[0]["p_row_number"] == 2 and first_writes[0]["p_program_ids"] == [PROGRAM]
    assert first_writes[0]["p_student"]["notes"] == "Imported current belt (unresolved): Azure"
    receipts = [
        {
            "kind": "student",
            "key": str(row["p_row_number"]),
            "result": {
                "student_id": row["p_student"]["id"],
                "guardian_imported": False,
                "outcome": row["p_student"]["_import_outcome"],
            },
        }
        for row in first_writes[:2]
    ]
    receipts.extend(
        [
            {"kind": "program", "key": "__unassigned__", "result": unassigned},
            {"kind": "program", "key": "bjj", "result": bjj},
            {"kind": "rank", "key": f"{OTHER}:green", "result": rank_binding},
        ]
    )
    # Completed rows and selected identities survive later configuration edits.
    db.tables["programs"][0].update(name="Renamed", archived_at="2026-09-10")
    db.tables["programs"][1]["name"] = "Renamed BJJ"
    db.tables["belt_ranks"][0]["name"] = "Jade"
    db.responses = [
        ("claim_student_import_run_v2", claim(receipts)),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, create_missing_programs=True, create_missing_belts=True)
    assert result.imported_count == 3 and result.error_rows == 1
    assert result.normalized_status_count == 1 and result.imported_without_belt_count == 1
    assert result.execution_status == "completed_with_warnings" and result.non_critical_errors == [
        "Frozen audit warning"
    ]
    writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert [params["p_row_number"] for params in writes] == [2, 3, 4, 4]
    assert writes[2]["p_student"]["id"] == writes[3]["p_student"]["id"]
    assert (
        writes[3]["p_program_ids"] == [OTHER]
        and writes[3]["p_student"]["current_belt_rank_id"] == rank
    )
    assert result.created_programs == [] and result.created_belts == []
    claims = [params for name, params in db.calls if name == "claim_student_import_run_v2"]
    assert claims[0]["p_request_hash"] == claims[1]["p_request_hash"]
    assert all(params["p_idempotency_key"] == "same-key" for params in claims)
    assert writes[3]["p_processing_token"] == claims[1]["p_processing_token"]
    assert sum(query["table"] == "programs" for query in db.query_log) == 2
    assert all(
        not query["insert"] and not query["update"] and not query["upsert"]
        for query in db.query_log
    )
    assert not db.responses


def test_completed_claim_and_all_receipted_recovery_need_no_reference_reads():
    expected = CsvImportResult(
        total_rows=1,
        valid_rows=1,
        error_rows=0,
        imported_count=1,
        non_critical_errors=["Original warning"],
    )
    db = ScriptedImportDb()
    db.responses = [
        (
            "claim_student_import_run_v2",
            [
                {
                    "claim_status": "completed",
                    "run_row": {"result_json": expected.model_dump(mode="json")},
                }
            ],
        )
    ]
    result = db.execute_import([{"First": "Ava", "Last": "Nguyen"}])
    assert result == expected.model_copy(
        update={"idempotency_key": "same-key", "reused_result": True, "execution_status": "reused"}
    )
    assert not db.query_log and len(db.calls) == 1
    receipt = {
        "kind": "student",
        "key": "2",
        "result": {
            "outcome": {
                "row_number": 2,
                "is_valid": True,
                "issues": [],
                "data": {},
                "imported_without_belt": False,
            }
        },
    }
    db.responses = [
        ("claim_student_import_run_v2", claim([receipt])),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import([{"First": "Ava", "Last": "Nguyen"}])
    assert result.imported_count == 1 and result.non_critical_errors == ["Frozen audit warning"]
    assert not db.query_log and not db.responses


def test_setup_batches_requested_belts_and_excludes_rejected_rows():
    db = ScriptedImportDb()

    def setup(params):
        assert params["p_program_id"] == OTHER and params["p_create_ladder"] is True
        assert [rank["key"] for rank in params["p_ranks"]] == ["white", "blue"]
        assert all(rank["existing_id"] is None for rank in params["p_ranks"])
        return {
            "ladder": {"ladder_id": params["p_ladder_id"], "name": "BJJ", "created": True},
            "ranks": [
                {
                    "rank_id": rank["id"],
                    "name": rank["name"],
                    "ladder_id": params["p_ladder_id"],
                    "ladder_name": "BJJ",
                    "program_id": OTHER,
                    "context_program_id": OTHER,
                    "created": True,
                }
                for rank in params["p_ranks"]
            ],
        }

    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(OTHER, "BJJ")),
        ("prepare_student_import_belts_v1", setup),
        ("import_student_row_atomic", row_success),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(
        [
            {"First": "Ava", "Last": "Nguyen", "Program": "BJJ", "Belt": "Blue"},
            {"First": "Mina", "Last": "Nguyen", "Program": "BJJ", "Belt": "White"},
            {"Last": "Invalid", "Program": "Do not create", "Belt": "Red"},
        ],
        create_missing_programs=True,
        create_missing_belts=True,
    )
    assert result.created_programs == [] and result.created_ladders == ["BJJ"]
    assert result.created_belts == ["White (BJJ)", "Blue (BJJ)"]
    assert result.imported_count == 2 and result.error_rows == 1 and not db.responses
    assert sum(query["table"] == "programs" for query in db.query_log) == 1


def existing_student(student_id=EXISTING, first="Ava", last="Nguyen", dob="2014-06-03", **extra):
    return {
        "id": student_id,
        "studio_id": STUDIO,
        "legal_first_name": first,
        "legal_last_name": last,
        "preferred_name": None,
        "date_of_birth": dob,
        "email": None,
        "phone": None,
        "deleted_at": None,
        **extra,
    }


def test_preview_flags_existing_and_in_file_duplicates_with_plain_reasons_only():
    db = ScriptedImportDb()
    db.tables["students"] = [
        existing_student(email="family@example.net", phone="415-555-0100"),
        existing_student(
            "88888888-8888-4888-8888-888888888888",
            "Mina",
            "Nguyen",
            "2016-01-02",
            deleted_at="2026-01-01T00:00:00Z",
        ),
        {
            **existing_student(
                "99999999-9999-4999-8999-999999999999", "Other", "Studio", "2014-06-03"
            ),
            "studio_id": "another-studio",
        },
    ]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Mina", "Last": "Nguyen", "DOB": "2016-01-02"},
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Other", "Last": "Studio", "DOB": "2014-06-03"},
        {"First": "Sam", "Last": "Nguyen"},
    ]
    preview = StudentService(db).validate_import_rows(rows, MAPPING, CsvImportOptions(), STUDIO)
    assert preview.valid_rows == 5 and preview.error_rows == 0
    assert preview.duplicate_flagged_rows == 3 and preview.skipped_rows == 0
    reviews = {row.row_number: row.duplicate_review for row in preview.rows}
    assert reviews[2].suggested_action == "skip"
    assert reviews[2].candidates[0].model_dump() == {
        "source_id": None,
        "student_id": EXISTING,
        "of_row": None,
        "display_name": "Ava Nguyen",
        "archived": False,
        "confidence": "strong",
        "reasons": ["same name", "same birth date"],
    }
    assert reviews[3].suggested_action == "decide" and reviews[3].candidates[0].archived is True
    assert reviews[4].suggested_action == "skip"
    assert [(c.of_row, c.student_id) for c in reviews[4].candidates] == [
        (2, None),
        (None, EXISTING),
    ]
    assert 5 not in reviews and 6 not in reviews
    serialized = preview.model_dump_json()
    assert "family@example.net" not in serialized and "415-555-0100" not in serialized
    roster_queries = [q for q in db.query_log if q["table"] == "students"]
    assert roster_queries and all(
        ("eq", "studio_id", STUDIO) in q["filters"] for q in roster_queries
    )
    assert not db.calls


def test_execution_honours_skip_refuses_unreviewed_strong_matches_and_counts_outcomes():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [
        existing_student(),
        existing_student("88888888-8888-4888-8888-888888888888", "Mina", "Nguyen", "2016-01-02"),
        existing_student("66666666-6666-4666-8666-666666666666", "Leo", "Nguyen", None),
    ]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},  # skip, named correctly
        {"First": "Mina", "Last": "Nguyen", "DOB": "2016-01-02"},  # strong, no decision -> refused
        {"First": "Leo", "Last": "Nguyen"},  # possible, skip naming the wrong student -> refused
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},  # in-file repeat of row 2 -> skip
        {"First": "Sam", "Last": "Nguyen"},  # plain create
    ]
    decisions = {
        "2": CsvImportDuplicateDecision(
            action="skip", matched_student_id=EXISTING, acknowledged_student_ids=[EXISTING]
        ),
        "4": CsvImportDuplicateDecision(action="skip", matched_student_id="not-the-one"),
        "5": CsvImportDuplicateDecision(
            action="skip",
            of_row=2,
            acknowledged_rows=[2],
            acknowledged_student_ids=[EXISTING],
        ),
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions=decisions)
    writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert [params["p_row_number"] for params in writes] == [6]
    assert result.imported_count == 1 and result.skipped_rows == 2 and result.error_rows == 2
    assert result.valid_rows == 3 and result.total_rows == 5
    by_row = {row.row_number: row for row in result.rows}
    assert [issue.code for issue in by_row[2].issues] == ["duplicate_skipped"]
    assert by_row[2].warnings == ["Skipped: already in Koaryu as Ava Nguyen."]
    assert [issue.code for issue in by_row[3].issues] == ["duplicate_review_required"]
    assert by_row[3].is_valid is False
    # A skip must name what execution found; naming someone else is not a create.
    assert [issue.code for issue in by_row[4].issues] == ["duplicate_review_required"]
    assert "was not found again" in by_row[4].errors[0]
    assert [issue.code for issue in by_row[5].issues] == ["duplicate_skipped"]
    claims = [params for name, params in db.calls if name == "claim_student_import_run_v2"]
    assert claims[0]["p_request_hash"] != __import__(
        "app.services.student_import_runs", fromlist=["StudentImportRunStore"]
    ).StudentImportRunStore.compute_request_hash(rows, MAPPING, CsvImportOptions())
    assert not db.responses


def test_in_file_skip_is_refused_when_its_original_row_was_blocked():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [existing_student()]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},  # strong, no decision -> refused
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},  # skip of row 2 -> refused too
    ]
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(
        rows, decisions={"3": CsvImportDuplicateDecision(action="skip", of_row=2)}
    )
    assert result.imported_count == 0 and result.skipped_rows == 0 and result.error_rows == 2
    assert all(
        [issue.code for issue in row.issues] == ["duplicate_review_required"] for row in result.rows
    )
    assert [name for name, _ in db.calls] == [
        "claim_student_import_run_v2",
        "finish_student_import_run",
    ]


def test_retry_keeps_completed_receipts_and_treats_their_students_as_in_file_rows():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    first_id = deterministic_import_uuid(RUN, "student-row", "2")
    # The first attempt committed row 2; its student is now in the roster.
    db.tables["students"] = [existing_student(first_id)]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Sam", "Last": "Nguyen"},
    ]
    receipt = {
        "kind": "student",
        "key": "2",
        "result": {
            "student_id": first_id,
            "guardian_imported": False,
            "outcome": {
                "row_number": 2,
                "is_valid": True,
                "issues": [],
                "data": {},
                "imported_without_belt": False,
            },
        },
    }
    db.responses = [
        (
            "claim_student_import_run_v2",
            claim(
                [
                    receipt,
                    {
                        "kind": "program",
                        "key": "__unassigned__",
                        "result": selected_program(PROGRAM, "Unassigned"),
                    },
                ]
            ),
        ),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(
        rows, decisions={"3": CsvImportDuplicateDecision(action="skip", of_row=2)}
    )
    writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert [params["p_row_number"] for params in writes] == [4]
    assert result.imported_count == 2 and result.skipped_rows == 1 and result.error_rows == 0
    assert not db.responses


def test_newly_found_roster_match_refuses_rows_even_when_an_in_file_match_is_named():
    """At preview the roster was empty; the owner chose Create for row 3 naming row 2.
    A matching student appears before execution: both rows must be refused."""
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [existing_student()]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
    ]
    decisions = {"3": CsvImportDuplicateDecision(action="create", of_row=2, acknowledged_rows=[2])}
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions=decisions)
    assert result.imported_count == 0 and result.skipped_rows == 0 and result.error_rows == 2
    by_row = {row.row_number: row for row in result.rows}
    assert [issue.code for issue in by_row[2].issues] == ["duplicate_review_required"]
    assert [issue.code for issue in by_row[3].issues] == ["duplicate_review_required"]
    assert "Ava Nguyen" in by_row[3].errors[0]
    assert [name for name, _ in db.calls] == [
        "claim_student_import_run_v2",
        "finish_student_import_run",
    ]


def test_acknowledged_roster_matches_allow_create_and_skip_names_the_retained_student():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [existing_student()]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
    ]
    decisions = {
        "2": CsvImportDuplicateDecision(
            action="create", matched_student_id=EXISTING, acknowledged_student_ids=[EXISTING]
        ),
        "3": CsvImportDuplicateDecision(
            action="skip",
            of_row=2,
            matched_student_id=EXISTING,
            acknowledged_rows=[2],
            acknowledged_student_ids=[EXISTING],
        ),
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions=decisions)
    assert result.imported_count == 1 and result.skipped_rows == 1 and result.error_rows == 0
    by_row = {row.row_number: row for row in result.rows}
    assert by_row[3].warnings == ["Skipped: already in Koaryu as Ava Nguyen."]


def test_skip_chain_resolves_to_the_retained_student_and_refuses_a_mismatch():
    """Row 2 (possible vs existing Ava) is skipped as Ava; row 3 strongly repeats row 2
    but is a different person from Ava, so skipping row 3 "as row 2" would drop a child."""
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [existing_student(dob="1980-02-02", email="ava@example.com")]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "Email": "b@example.net"},
        {"First": "Ava", "Last": "Nguyen", "Email": "b@example.net", "DOB": "2014-06-03"},
    ]
    decisions = {
        "2": CsvImportDuplicateDecision(
            action="skip", matched_student_id=EXISTING, acknowledged_student_ids=[EXISTING]
        ),
        "3": CsvImportDuplicateDecision(action="skip", of_row=2, acknowledged_rows=[2]),
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions=decisions)
    assert result.imported_count == 0 and result.skipped_rows == 1 and result.error_rows == 1
    by_row = {row.row_number: row for row in result.rows}
    assert [issue.code for issue in by_row[2].issues] == ["duplicate_skipped"]
    assert [issue.code for issue in by_row[3].issues] == ["duplicate_review_required"]
    assert "row 2 was itself skipped" in by_row[3].errors[0]
    assert [name for name, _ in db.calls] == [
        "claim_student_import_run_v2",
        "record_student_import_skip_v1",
        "finish_student_import_run",
    ]


def test_skip_chain_is_honoured_when_the_row_matches_the_retained_student():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [existing_student(email="ava@example.com")]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "Email": "ava@example.com"},  # strong vs existing
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},  # strong vs existing and row 2
    ]
    decisions = {
        "2": CsvImportDuplicateDecision(
            action="skip", matched_student_id=EXISTING, acknowledged_student_ids=[EXISTING]
        ),
        "3": CsvImportDuplicateDecision(
            action="skip",
            of_row=2,
            acknowledged_rows=[2],
            acknowledged_student_ids=[EXISTING],
        ),
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions=decisions)
    assert result.imported_count == 0 and result.skipped_rows == 2 and result.error_rows == 0


def test_skip_of_a_row_refused_by_setup_becomes_a_review():
    """Setup refuses row 2 after decisions marked it imported (its confirmed ladder is
    gone); the skip of row 3 must not claim the student exists."""
    db = ScriptedImportDb()
    ladder = "55555555-5555-4555-8555-555555555555"
    db.tables["belt_ladders"] = [
        {"id": ladder, "studio_id": STUDIO, "program_id": OTHER, "name": "BJJ"}
    ]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "Program": "BJJ", "Belt": "Blue"},
        {"First": "Ava", "Last": "Nguyen", "Program": "BJJ", "Belt": "Blue"},
    ]
    receipts = [
        {"kind": "program", "key": "bjj", "result": selected_program(OTHER, "BJJ")},
        {
            "kind": "ladder",
            "key": OTHER,
            "result": {"ladder_id": "deleted-ladder", "name": "Gone", "created": True},
        },
    ]
    db.responses = [
        ("claim_student_import_run_v2", claim(receipts)),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(
        rows,
        decisions={"3": CsvImportDuplicateDecision(action="skip", of_row=2, acknowledged_rows=[2])},
        create_missing_belts=True,
    )
    assert result.imported_count == 0 and result.skipped_rows == 0 and result.error_rows == 2
    by_row = {row.row_number: row for row in result.rows}
    assert [issue.code for issue in by_row[2].issues][-1] == "unavailable_belt_ladder"
    assert "duplicate_skipped" not in [issue.code for issue in by_row[3].issues]
    assert [issue.code for issue in by_row[3].issues][-1] == "duplicate_review_required"
    assert [name for name, _ in db.calls] == [
        "claim_student_import_run_v2",
        "finish_student_import_run",
    ]


def browser_default_decisions(preview):
    """Mirror of the browser's default decisions built from the preview payload."""
    decisions = {}
    for row in preview.rows:
        review = row.duplicate_review
        if review is None or not row.is_valid or review.suggested_action == "decide":
            continue
        choice = [c for c in review.candidates if c.confidence != "different_person"]
        if not choice:
            continue
        existing = next((c for c in choice if c.student_id), None)
        in_file = next((c for c in choice if c.of_row is not None), None)
        decisions[str(row.row_number)] = CsvImportDuplicateDecision(
            action="skip" if review.suggested_action == "skip" else "create",
            matched_student_id=existing.student_id if existing else None,
            of_row=in_file.of_row if in_file else None,
            acknowledged_student_ids=list(review.acknowledge_student_ids),
            acknowledged_rows=list(review.acknowledge_rows),
        )
    return decisions


def test_repeat_of_a_blocked_child_row_imports_and_is_never_skipped_against_the_adult():
    """Astra's scenario: the child's first row is blocked and an adult shares the
    family email. The blocked row is never a target, so the repeat is not
    refused for pointing at it; its best match is the adult at possible
    confidence, so the default is Create and the child is imported, never
    skipped against the adult."""
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [existing_student(dob="1980-02-02", email="family@example.net")]
    rows = [
        {
            "First": "Ava",
            "Last": "Nguyen",
            "DOB": "2014-06-03",
            "Email": "family@example.net",
            "Program": "Unknown",
        },
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03", "Email": "family@example.net"},
    ]
    preview = StudentService(db).validate_import_rows(rows, MAPPING, CsvImportOptions(), STUDIO)
    assert preview.error_rows == 1
    review = {row.row_number: row.duplicate_review for row in preview.rows}[3]
    assert review.suggested_action == "create" and review.acknowledge_rows == []
    assert [(c.of_row, c.student_id, c.confidence) for c in review.candidates] == [
        (None, EXISTING, "possible"),
    ]
    default = browser_default_decisions(preview)["3"]
    assert default.action == "create"

    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions={"3": default})
    assert result.imported_count == 1 and result.skipped_rows == 0 and result.error_rows == 1
    writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert [params["p_row_number"] for params in writes] == [3]


def test_eight_identical_rows_with_browser_defaults_import_once_and_skip_the_rest():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    rows = [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"} for _ in range(8)]
    preview = StudentService(db).validate_import_rows(rows, MAPPING, CsvImportOptions(), STUDIO)
    assert preview.duplicate_flagged_rows == 7
    reviews = {row.row_number: row.duplicate_review for row in preview.rows}
    # Earlier copies are bounded to the earliest five, all shown and all named.
    assert [c.of_row for c in reviews[9].candidates] == [2, 3, 4, 5, 6]
    assert reviews[9].acknowledge_rows == [2, 3, 4, 5, 6]
    decisions = browser_default_decisions(preview)
    assert sorted(decisions) == [str(n) for n in range(3, 10)]
    assert all(d.action == "skip" and d.of_row == 2 for d in decisions.values())
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions=decisions)
    assert result.imported_count == 1 and result.skipped_rows == 7 and result.error_rows == 0
    writes = [params for name, params in db.calls if name == "import_student_row_atomic"]
    assert [params["p_row_number"] for params in writes] == [2]


def test_archived_possible_match_beside_an_active_one_requires_a_decision():
    db = ScriptedImportDb()
    db.tables["students"] = [
        existing_student("88888888-8888-4888-8888-888888888888", "Ava", "Nguyen", None),
        existing_student(
            "66666666-6666-4666-8666-666666666666",
            "Ava",
            "Nguyen",
            None,
            deleted_at="2026-01-01T00:00:00Z",
        ),
    ]
    preview = StudentService(db).validate_import_rows(
        [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"}],
        MAPPING,
        CsvImportOptions(),
        STUDIO,
    )
    review = preview.rows[0].duplicate_review
    assert review.suggested_action == "decide"
    assert [(c.student_id, c.archived) for c in review.candidates] == [
        ("88888888-8888-4888-8888-888888888888", False),
        ("66666666-6666-4666-8666-666666666666", True),
    ]
    assert review.acknowledge_student_ids == ["66666666-6666-4666-8666-666666666666"]
    assert browser_default_decisions(preview) == {}


def test_create_must_acknowledge_every_archived_same_name_student():
    """S2 was archived after preview; a Create that names only S1 is refused."""
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    s1, s2 = "88888888-8888-4888-8888-888888888888", "66666666-6666-4666-8666-666666666666"
    db.tables["students"] = [
        existing_student(s1, "Ava", "Nguyen", None, deleted_at="2026-01-01T00:00:00Z"),
        existing_student(s2, "Ava", "Nguyen", None, deleted_at="2026-02-01T00:00:00Z"),
    ]
    rows = [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"}]
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(
        rows,
        decisions={
            "2": CsvImportDuplicateDecision(
                action="create", matched_student_id=s1, acknowledged_student_ids=[s1]
            )
        },
    )
    assert result.imported_count == 0 and result.error_rows == 1
    assert [issue.code for issue in result.rows[0].issues] == ["duplicate_review_required"]
    assert [name for name, _ in db.calls] == [
        "claim_student_import_run_v2",
        "finish_student_import_run",
    ]

    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(
        rows,
        decisions={
            "2": CsvImportDuplicateDecision(
                action="create", matched_student_id=s1, acknowledged_student_ids=[s1, s2]
            )
        },
    )
    assert result.imported_count == 1 and result.error_rows == 0 and result.skipped_rows == 0


def test_skipped_rows_add_nothing_to_status_belt_or_setup_totals():
    from app.schemas.student import CsvImportIssue
    from app.services.student_import_plan_result import build_import_result

    def plan(row_number, *, skipped):
        return {
            "row_number": row_number,
            "data": {"legal_first_name": "Ava", "legal_last_name": f"Row{row_number}"},
            "is_valid": True,
            "skipped": skipped,
            "unresolved_belt_value": "Purple",
            "belt_creation_requires_new_ladder": True,
            "issues": [
                CsvImportIssue(
                    code="normalized_status",
                    severity="warning",
                    field="status",
                    value="Current",
                    message="Status will be normalized.",
                ),
                CsvImportIssue(
                    code="missing_program",
                    severity="warning",
                    field="program",
                    value="Kids BJJ",
                    message="Program does not exist yet.",
                ),
                CsvImportIssue(
                    code="missing_belt",
                    severity="warning",
                    field="current_belt_rank_id",
                    value="Purple",
                    message="Belt does not exist yet.",
                ),
            ],
        }

    only_skipped = build_import_result([plan(2, skipped=True)], total_rows=1)
    assert only_skipped.skipped_rows == 1
    assert only_skipped.normalized_status_count == 0
    assert only_skipped.warnings == [] and only_skipped.setup_issues == []
    # The skipped row keeps its own diagnostics for the review screen.
    assert [row.row_number for row in only_skipped.rows] == [2]

    mixed = build_import_result([plan(2, skipped=True), plan(3, skipped=False)], total_rows=2)
    assert mixed.normalized_status_count == 1
    assert all(warning.row_numbers == [3] for warning in mixed.warnings)
    assert {issue.code for issue in mixed.setup_issues} >= {"missing_program"}
    assert all(
        3 in issue.row_numbers and 2 not in issue.row_numbers for issue in mixed.setup_issues
    )


def _decide_with_browser_defaults(rows, roster, invalid_rows=()):
    """Match rows, build the browser's default decisions from the review
    payloads and apply them, as preview and execution do with no changes."""
    from app.services.student_import_matching import build_duplicate_review, match_rows

    planned_rows = [
        {"row_number": number, "data": data, "is_valid": number not in invalid_rows, "issues": []}
        for number, data in rows
    ]
    decisions = {}
    for row, match in zip(planned_rows, match_rows(planned_rows, roster)):
        row["match"] = match
        review = build_duplicate_review(match)
        if review is None or review["suggested_action"] == "decide":
            continue
        choice = [c for c in review["candidates"] if c["confidence"] != "different_person"]
        if not choice:
            continue
        existing = next((c for c in choice if c["student_id"]), None)
        in_file = next((c for c in choice if c["of_row"] is not None), None)
        decisions[str(row["row_number"])] = CsvImportDuplicateDecision(
            action="skip" if review["suggested_action"] == "skip" else "create",
            matched_student_id=existing["student_id"] if existing else None,
            of_row=in_file["of_row"] if in_file else None,
            acknowledged_student_ids=review["acknowledge_student_ids"],
            acknowledged_rows=review["acknowledge_rows"],
        )
    StudentImportExecutor._apply_duplicate_decisions(planned_rows, decisions)
    return {row["row_number"]: row for row in planned_rows}


def test_skip_chain_keeps_its_retained_row_when_the_bounded_list_drops_it():
    """Astra's reproduction: row 10 skips to row 9, which skipped to row 8.
    Rows 3-7 fill row 10's phone bucket, so row 8 is not a listed candidate;
    row 10 still matches row 8 (same name and phone) and the skip holds."""
    ava = {"legal_first_name": "Ava", "legal_last_name": "Nguyen"}
    rows = [(2, {**ava, "email": "z@x.test"})]
    rows += [
        (n, {**ava, "date_of_birth": "2010-01-01", "email": "x@x.test", "phone": "4155550101"})
        for n in range(3, 8)
    ]
    rows += [
        (8, {**ava, "email": "y@x.test", "phone": "4155550101"}),
        (9, {**ava, "date_of_birth": "2014-01-01", "email": "y@x.test"}),
        (10, {**ava, "date_of_birth": "2014-01-01", "email": "w@x.test", "phone": "4155550101"}),
    ]
    by_row = _decide_with_browser_defaults(rows, [])
    assert 8 not in {c.row_number for c in by_row[10]["match"].candidates}
    assert not by_row[8].get("skipped") and by_row[8]["is_valid"]
    assert by_row[9]["skipped"] and by_row[9]["skip_retained"] == ("row", 8)
    assert by_row[10]["is_valid"] and by_row[10]["skipped"]
    assert by_row[10]["skip_retained"] == ("row", 8)


def test_skip_chain_reaches_a_roster_student_behind_the_plain_name_representative():
    """Row 3 strongly repeats row 2, which skipped against roster student X.
    Row 3 matches X by name only and X is not the plain-name representative
    (an earlier same-name student is), so X was never a listed candidate."""
    from tests.test_student_import_matching import existing

    roster = [
        existing("other", "Ava", "Nguyen"),
        existing("x", "Ava", "Nguyen", date_of_birth="2014-06-03"),
    ]
    ava = {"legal_first_name": "Ava", "legal_last_name": "Nguyen"}
    rows = [
        (2, {**ava, "date_of_birth": "2014-06-03", "email": "ava@example.test"}),
        (3, {**ava, "email": "ava@example.test"}),
    ]
    by_row = _decide_with_browser_defaults(rows, roster)
    assert by_row[2]["skipped"] and by_row[2]["skip_retained"] == ("existing", "x")
    assert "x" not in {c.existing_key for c in by_row[3]["match"].candidates}
    assert by_row[3]["is_valid"] and by_row[3]["skipped"]
    assert by_row[3]["skip_retained"] == ("existing", "x")


def test_direct_reference_check_ignores_later_rows_and_different_people():
    from app.services.student_import_matching import candidate_for_reference, match_rows

    ava = {"legal_first_name": "Ava", "legal_last_name": "Nguyen"}
    planned_rows = [
        {"row_number": 2, "data": {**ava, "date_of_birth": "2010-01-01"}, "is_valid": True},
        {"row_number": 3, "data": {**ava, "date_of_birth": "2014-06-03"}, "is_valid": True},
        {"row_number": 4, "data": {**ava, "date_of_birth": "2014-06-03"}, "is_valid": True},
    ]
    second, third = match_rows(planned_rows, [])[1:]
    assert candidate_for_reference(second, ("row", 4)) is None  # later row
    assert candidate_for_reference(second, ("row", 2)) is None  # different person
    assert candidate_for_reference(third, ("row", 3)).confidence == "strong"
    assert candidate_for_reference(third, ("existing", "missing")) is None


def test_valid_copy_of_a_blocked_row_imports_instead_of_being_refused():
    ava = {"legal_first_name": "Ava", "legal_last_name": "Nguyen", "date_of_birth": "2014-06-03"}
    by_row = _decide_with_browser_defaults([(2, ava), (3, ava)], [], invalid_rows={2})
    assert not by_row[2]["is_valid"]
    assert by_row[3]["is_valid"] and not by_row[3].get("skipped")


def test_preview_and_execution_block_a_row_with_too_many_roster_copies():
    from app.services.student_import_matching import ROSTER_MATCH_LIMIT

    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    db.tables["students"] = [
        existing_student(f"99999999-9999-4999-8999-{n:012d}") for n in range(ROSTER_MATCH_LIMIT + 1)
    ]
    rows = [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"}]
    preview = StudentService(db).validate_import_rows(rows, MAPPING, CsvImportOptions(), STUDIO)
    assert preview.error_rows == 1 and preview.valid_rows == 0
    (row,) = preview.rows
    assert [issue.code for issue in row.issues] == ["too_many_existing_matches"]
    assert "Add this student by hand" in row.errors[0]

    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions={})
    assert result.imported_count == 0 and result.error_rows == 1
    assert not [name for name, _ in db.calls if name == "import_student_row_atomic"]


def test_database_race_refusal_continues_and_only_acknowledges_successful_rows():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    rows = [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"} for _ in range(3)]
    decisions = {
        "3": CsvImportDuplicateDecision(action="create", of_row=2, acknowledged_rows=[2]),
        "4": CsvImportDuplicateDecision(action="create", acknowledged_rows=[2, 3]),
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        (
            "import_student_row_atomic",
            APIError(
                {
                    "code": "P0409",
                    "message": "student_import_duplicate_review_required",
                    "details": None,
                    "hint": None,
                }
            ),
        ),
        ("import_student_row_atomic", row_success),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions)
    assert result.imported_count == 2 and result.error_rows == 1
    assert result.errors[0].errors == [
        "A matching student was added while this import was running. Review the duplicate and choose again."
    ]
    writes = [p for n, p in db.calls if n == "import_student_row_atomic"]
    assert [p["p_acknowledged_student_ids"] for p in writes] == [
        [],
        [],
        [deterministic_import_uuid(RUN, "student-row", "3")],
    ]


def test_acknowledgements_include_roster_ids_and_completed_row_receipts():
    db = ScriptedImportDb()
    completed_id = deterministic_import_uuid(RUN, "student-row", "2")
    receipt = {
        "kind": "student",
        "key": "2",
        "result": {
            "student_id": completed_id,
            "guardian_imported": False,
            "outcome": {
                "row_number": 2,
                "is_valid": True,
                "issues": [],
                "data": {},
                "imported_without_belt": False,
            },
        },
    }
    db.responses = [
        ("claim_student_import_run_v2", claim([receipt])),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    db.execute_import(
        [{"First": "Ava", "Last": "Nguyen"}, {"First": "Mina", "Last": "Nguyen"}],
        {
            "3": CsvImportDuplicateDecision(
                action="create",
                matched_student_id=EXISTING,
                acknowledged_student_ids=[EXISTING, OTHER],
                of_row=2,
                acknowledged_rows=[2, 999],
            )
        },
    )
    write = next(p for n, p in db.calls if n == "import_student_row_atomic")
    assert write["p_acknowledged_student_ids"] == sorted([EXISTING, OTHER, completed_id])


@pytest.mark.parametrize("code", ["23505", "22023", "P0001"])
def test_other_database_errors_abort_the_attempt(code):
    db = ScriptedImportDb()
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        (
            "import_student_row_atomic",
            APIError(
                {"code": code, "message": "private database error", "details": None, "hint": None}
            ),
        ),
        ("finish_student_import_run", [{"updated": True}]),
    ]
    with pytest.raises(HTTPException) as error:
        db.execute_import([{"First": "Ava", "Last": "Nguyen"}])
    assert error.value.status_code == 500
    assert db.calls[-1][1]["p_status"] == "failed"


def test_skipped_receipt_survives_unknown_failure_and_retry_without_rematching():
    db = ScriptedImportDb()
    db.tables["students"] = [existing_student()]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"},
        {"First": "Mina", "Last": "Nguyen"},
    ]
    decisions = {"2": CsvImportDuplicateDecision(action="skip", matched_student_id=EXISTING)}
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("import_student_row_atomic", RuntimeError("lost response")),
        ("finish_student_import_run", [{"updated": True}]),
    ]
    with pytest.raises(HTTPException):
        db.execute_import(rows, decisions)
    skip = next(p for n, p in db.calls if n == "record_student_import_skip_v1")
    assert (
        skip["p_result"]["retained_kind"] == "existing"
        and skip["p_result"]["retained_id_or_row"] == EXISTING
    )
    db.tables["students"] = []
    db.calls.clear()
    db.responses = [
        (
            "claim_student_import_run_v2",
            claim([{"kind": "skipped", "key": "2", "result": skip["p_result"]}]),
        ),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions)
    assert result.skipped_rows == 1 and result.imported_count == 1 and result.error_rows == 0
    assert result.rows[0].warnings == ["Skipped: already in Koaryu as Ava Nguyen."]
    assert not any(n == "record_student_import_skip_v1" for n, _ in db.calls)


def test_skip_of_row_refused_by_database_is_not_receipted():
    db = ScriptedImportDb()
    rows = [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"}] * 2
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        (
            "import_student_row_atomic",
            APIError(
                {
                    "code": "P0409",
                    "message": "student_import_duplicate_review_required",
                    "details": None,
                    "hint": None,
                }
            ),
        ),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, {"3": CsvImportDuplicateDecision(action="skip", of_row=2)})
    assert result.error_rows == 2 and result.skipped_rows == 0 and result.imported_count == 0


@pytest.mark.parametrize(
    "first_outcome",
    ["created", "linked", "separate_contact", "refused", "no_guardian", "completed_linked"],
)
def test_guardian_choice_tracks_actual_earlier_import_outcome(first_outcome):
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    gid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    rows = [
        {
            "First": "Mina",
            "Last": "Nguyen",
            "Guardian": "Jordan Smith",
            "GuardianEmail": "private@example.invalid",
        },
        {
            "First": "Sam",
            "Last": "Nguyen",
            "Guardian": "Jordan Smith",
            "GuardianEmail": "private@example.invalid",
        },
    ]
    MAPPING.update({"Guardian": "guardian_name", "GuardianEmail": "guardian_email"})
    if first_outcome == "no_guardian":
        rows[0].pop("Guardian")
        rows[0].pop("GuardianEmail")
    if first_outcome in {"linked", "separate_contact"}:
        db.tables["students"] = [existing_student()]
        db.tables["guardians"] = [
            {
                "id": gid,
                "studio_id": STUDIO,
                "first_name": "Jordan",
                "last_name": "Smith",
                "email": "private@example.invalid",
                "phone": "secret",
            }
        ]
        db.tables["student_guardians"] = [{"student_id": EXISTING, "guardian_id": gid}]
    if first_outcome == "separate_contact":
        db.tables["guardians"][0]["email"] = "different@example.invalid"
    receipts = []
    if first_outcome == "completed_linked":
        sid = deterministic_import_uuid(RUN, "student-row", "2")
        db.tables["students"] = [existing_student(sid, "Mina", "Nguyen", None)]
        db.tables["guardians"] = [
            {
                "id": gid,
                "studio_id": STUDIO,
                "first_name": "Jordan",
                "last_name": "Smith",
                "email": "private@example.invalid",
            }
        ]
        db.tables["student_guardians"] = [{"student_id": sid, "guardian_id": gid}]
        receipts = [
            {
                "kind": "student",
                "key": "2",
                "result": {
                    "student_id": sid,
                    "guardian_imported": True,
                    "outcome": {
                        "row_number": 2,
                        "is_valid": True,
                        "issues": [],
                        "data": {},
                        "imported_without_belt": False,
                        "guardian_id": gid,
                    },
                },
            }
        ]
    db.responses = [
        ("claim_student_import_run_v2", claim(receipts)),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
    ]
    if not receipts:
        response = (
            APIError(
                {
                    "code": "P0409",
                    "message": "student_import_duplicate_review_required",
                    "details": None,
                    "hint": None,
                }
            )
            if first_outcome == "refused"
            else row_success
        )
        db.responses.append(("import_student_row_atomic", response))
    db.responses.extend(
        [("import_student_row_atomic", row_success), ("finish_student_import_run", finish)]
    )
    try:
        result = db.execute_import(rows)
    finally:
        MAPPING.pop("Guardian", None)
        MAPPING.pop("GuardianEmail", None)
    writes = [p for n, p in db.calls if n == "import_student_row_atomic"]
    expected = {
        "created": deterministic_import_uuid(RUN, "guardian-row", "2"),
        "separate_contact": deterministic_import_uuid(RUN, "guardian-row", "2"),
        "linked": gid,
        "completed_linked": gid,
    }.get(first_outcome)
    assert writes[-1]["p_guardian_id"] == expected
    assert result.imported_count == (1 if first_outcome == "refused" else 2)
    if first_outcome == "linked":
        assert writes[0]["p_guardian_id"] == gid


def test_family_only_preview_displays_contact_without_exposing_guardian_identity():
    db = ScriptedImportDb()
    db.tables["students"] = [existing_student()]
    gid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    db.tables["guardians"] = [
        {
            "id": gid,
            "studio_id": STUDIO,
            "first_name": "Jordan",
            "last_name": "Smith",
            "email": "private@example.invalid",
            "phone": "secret",
        }
    ]
    db.tables["student_guardians"] = [{"student_id": EXISTING, "guardian_id": gid}]
    mapping = {**MAPPING, "Guardian": "guardian_name", "GuardianEmail": "guardian_email"}
    rows = [
        {
            "First": "Mina",
            "Last": "Nguyen",
            "Guardian": "Jordan Smith",
            "GuardianEmail": "PRIVATE@example.invalid",
        },
        {
            "First": "Sam",
            "Last": "Nguyen",
            "Guardian": "Jordan Smith",
            "GuardianEmail": "PRIVATE@example.invalid",
        },
    ]
    preview = StudentService(db).validate_import_rows(rows, mapping, CsvImportOptions(), STUDIO)
    assert preview.duplicate_flagged_rows == 0
    first, second = preview.rows
    assert first.duplicate_review.candidates == [] and first.duplicate_review.family_context
    assert first.duplicate_review.guardian_outcome.model_dump() == {
        "kind": "link_existing",
        "display_name": "Jordan Smith",
        "of_row": None,
    }
    assert second.duplicate_review.guardian_outcome.model_dump() == {
        "kind": "in_file_shared",
        "display_name": "Jordan Smith",
        "of_row": 2,
    }
    payload = first.duplicate_review.model_dump_json()
    assert (
        gid not in payload and "private@example.invalid" not in payload and "secret" not in payload
    )


@pytest.mark.parametrize("contact", ["Jordan", "Taylor"])
def test_completed_guardian_matching_uses_the_receipted_contact_not_link_order(contact):
    db = ScriptedImportDb()
    sid = deterministic_import_uuid(RUN, "student-row", "2")
    stored_gid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    added_gid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    db.tables["students"] = [existing_student(sid, "Mina", "Nguyen", None)]
    db.tables["guardians"] = [
        {
            "id": added_gid,
            "studio_id": STUDIO,
            "first_name": "Taylor",
            "last_name": "Jones",
            "email": "taylor@example.invalid",
        },
        {
            "id": stored_gid,
            "studio_id": STUDIO,
            "first_name": "Jordan",
            "last_name": "Smith",
            "email": "jordan@example.invalid",
        },
    ]
    db.tables["student_guardians"] = [
        {"student_id": sid, "guardian_id": gid} for gid in (added_gid, stored_gid)
    ]
    receipt = {
        "kind": "student",
        "key": "2",
        "result": {
            "student_id": sid,
            "guardian_imported": True,
            "outcome": {
                "row_number": 2,
                "is_valid": True,
                "issues": [],
                "data": {},
                "imported_without_belt": False,
                "guardian_id": stored_gid,
            },
        },
    }
    db.responses = [
        ("claim_student_import_run_v2", claim([receipt])),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    mapping = {**MAPPING, "Guardian": "guardian_name", "GuardianEmail": "guardian_email"}
    result = asyncio.run(
        StudentImportExecutor(db).execute_import(
            [
                {"First": "Mina", "Last": "Nguyen"},
                {
                    "First": "Sam",
                    "Last": "Nguyen",
                    "Guardian": "Jordan Smith" if contact == "Jordan" else "Taylor Jones",
                    "GuardianEmail": f"{contact.lower()}@example.invalid",
                },
            ],
            mapping,
            CsvImportOptions(),
            STUDIO,
            "actor",
            "same-key",
        )
    )
    write = next(p for n, p in db.calls if n == "import_student_row_atomic")
    assert write["p_guardian_id"] == (stored_gid if contact == "Jordan" else added_gid)
    assert result.imported_count == 2


def test_shared_csv_guardian_must_match_the_actual_contact_on_first_run_and_retry():
    """John Smith links Jane Smith; John Jones must not inherit Jane through John."""
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    gid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    db.tables["students"] = [existing_student()]
    db.tables["guardians"] = [
        {
            "id": gid,
            "studio_id": STUDIO,
            "first_name": "Jane",
            "last_name": "Smith",
            "email": "shared@example.invalid",
        }
    ]
    db.tables["student_guardians"] = [{"student_id": EXISTING, "guardian_id": gid}]
    mapping = {**MAPPING, "Guardian": "guardian_name", "GuardianEmail": "guardian_email"}
    rows = [
        {
            "First": "Mina",
            "Last": "Nguyen",
            "Guardian": "John Smith",
            "GuardianEmail": "shared@example.invalid",
        },
        {
            "First": "Sam",
            "Last": "Nguyen",
            "Guardian": "John Jones",
            "GuardianEmail": "shared@example.invalid",
        },
    ]
    preview = StudentService(db).validate_import_rows(rows, mapping, CsvImportOptions(), STUDIO)
    by_row = {row.row_number: row.duplicate_review for row in preview.rows}
    assert by_row[2].guardian_outcome.kind == "link_existing"
    assert by_row[2].guardian_outcome.display_name == "Jane Smith"
    assert by_row[3].guardian_outcome is None
    assert any("separate contact" in note for note in by_row[3].family_context)
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("import_student_row_atomic", RuntimeError("interrupt after first row")),
        ("finish_student_import_run", [{"updated": True}]),
    ]

    def execute():
        return asyncio.run(
            StudentImportExecutor(db).execute_import(
                rows, mapping, CsvImportOptions(), STUDIO, "actor", "same-key"
            )
        )

    with pytest.raises(HTTPException):
        execute()
    writes = [p for n, p in db.calls if n == "import_student_row_atomic"]
    assert writes[0]["p_guardian_id"] == gid
    assert writes[1]["p_guardian_id"] is None
    first = writes[0]
    receipt = {
        "kind": "student",
        "key": "2",
        "result": {
            "student_id": first["p_student"]["id"],
            "guardian_imported": True,
            "outcome": first["p_student"]["_import_outcome"],
        },
    }
    db.tables["students"].append(existing_student(first["p_student"]["id"], "Mina", "Nguyen", None))
    db.tables["student_guardians"].append(
        {"student_id": first["p_student"]["id"], "guardian_id": gid}
    )
    db.calls.clear()
    db.responses = [
        ("claim_student_import_run_v2", claim([receipt])),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = execute()
    retried = next(p for n, p in db.calls if n == "import_student_row_atomic")
    assert retried["p_guardian_id"] is None and result.imported_count == 2


def test_seven_identical_rows_all_decided_create_reach_the_row_rpc():
    db = ScriptedImportDb()
    db.tables["programs"][0]["name"] = "Unassigned"
    rows = [{"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03"} for _ in range(7)]
    preview = StudentService(db).validate_import_rows(rows, MAPPING, CsvImportOptions(), STUDIO)
    decisions = {
        n: decision.model_copy(update={"action": "create"})
        for n, decision in browser_default_decisions(preview).items()
    }
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", selected_program(PROGRAM, "Unassigned")),
        *[("import_student_row_atomic", row_success) for _ in rows],
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions)
    writes = [p for n, p in db.calls if n == "import_student_row_atomic"]
    assert len(writes) == 7 and result.imported_count == 7 and result.error_rows == 0
    assert writes[-1]["p_acknowledged_student_ids"] == sorted(
        deterministic_import_uuid(RUN, "student-row", str(n)) for n in range(2, 7)
    )
    assert all(p["p_import_run_id"] == RUN for p in writes)


def test_completed_skip_stays_an_in_file_target_and_retains_x_on_retry():
    db = ScriptedImportDb()
    x = EXISTING
    y = "66666666-6666-4666-8666-666666666666"
    db.tables["students"] = [existing_student(y, dob="2015-01-01"), existing_student(x)]
    rows = [
        {"First": "Ava", "Last": "Nguyen", "DOB": "2014-06-03", "Email": "shared@example.invalid"},
        {"First": "Ava", "Last": "Nguyen", "Email": "shared@example.invalid"},
    ]
    preview = StudentService(db).validate_import_rows(rows, MAPPING, CsvImportOptions(), STUDIO)
    decisions = browser_default_decisions(preview)
    assert decisions["2"].matched_student_id == x and decisions["3"].of_row == 2
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("record_student_import_skip_v1", RuntimeError("interrupt before row 3 receipt")),
        ("finish_student_import_run", [{"updated": True}]),
    ]
    with pytest.raises(HTTPException):
        db.execute_import(rows, decisions)
    first_skips = [p for n, p in db.calls if n == "record_student_import_skip_v1"]
    assert [p["p_result"]["retained_id_or_row"] for p in first_skips] == [x, x]
    receipt = {"kind": "skipped", "key": "2", "result": first_skips[0]["p_result"]}
    # The authoritative diagnostic may omit matching facts. Use resent file data.
    receipt["result"]["outcome"]["data"] = {}
    db.calls.clear()
    db.responses = [
        ("claim_student_import_run_v2", claim([receipt])),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("finish_student_import_run", finish),
    ]
    result = db.execute_import(rows, decisions)
    skip = next(p for n, p in db.calls if n == "record_student_import_skip_v1")
    assert skip["p_row_number"] == 3
    assert skip["p_result"]["retained_id_or_row"] == x
    assert result.skipped_rows == 2 and result.error_rows == 0


@pytest.mark.parametrize("archived", [False, True])
def test_source_id_preview_scoped_skip_only_and_create_refusal(archived):
    db = ScriptedImportDb()
    db.tables["students"] = [
        existing_student(
            source_system="csv",
            source_id="00042",
            deleted_at="2026-01-01T00:00:00Z" if archived else None,
            email="private@example.invalid",
            phone="202-555-0198",
        )
    ]
    mapping = {**MAPPING, "Member ID": "source_id"}
    rows = [{"First": "Testcorrected", "Last": "Newquill", "Member ID": " 00042 "}]
    preview = StudentService(db).validate_import_rows(rows, mapping, CsvImportOptions(), STUDIO)
    review = preview.rows[0].duplicate_review
    assert review.skip_only and review.suggested_action == "skip"
    assert review.candidates[0].source_id == "00042"
    assert "private@example.invalid" not in preview.model_dump_json()
    assert "202-555-0198" not in preview.model_dump_json()
    db.responses = [("claim_student_import_run_v2", claim()), ("finish_student_import_run", finish)]
    result = asyncio.run(
        StudentImportExecutor(db).execute_import(
            rows,
            mapping,
            CsvImportOptions(),
            STUDIO,
            "actor",
            "key",
            {"2": CsvImportDuplicateDecision(action="create", matched_student_id=EXISTING)},
        )
    )
    assert result.imported_count == 0 and result.error_rows == 1
    assert result.rows[0].issues[0].code == "duplicate_review_required"
    assert (
        result.rows[0].issues[0].message
        == "This member ID already belongs to Ava Nguyen. Skip this row."
    )
    assert not db.responses


def test_source_id_rpc_only_when_present_and_in_file_skip():
    db = ScriptedImportDb()
    mapping = {**MAPPING, "Member ID": "source_id"}
    rows = [
        {"First": "Testava", "Last": "Fixturequill", "Program": "Karate", "Member ID": " 00042 "},
        {"First": "Testcorrected", "Last": "Otherquill", "Member ID": "00042"},
        {"First": "Testnew", "Last": "Thirdquill", "Program": "Karate", "Member ID": " "},
    ]
    db.responses = [
        ("claim_student_import_run_v2", claim()),
        ("prepare_student_import_program_v1", [selected_program(PROGRAM, "Karate")]),
        ("import_student_row_atomic", row_success),
        ("record_student_import_skip_v1", lambda p: p["p_result"]),
        ("import_student_row_atomic", row_success),
        ("finish_student_import_run", finish),
    ]
    result = asyncio.run(
        StudentImportExecutor(db).execute_import(
            rows,
            mapping,
            CsvImportOptions(source_system="old-roster"),
            STUDIO,
            "actor",
            "key",
            {"3": CsvImportDuplicateDecision(action="skip", of_row=2)},
        )
    )
    assert result.imported_count == 2 and result.skipped_rows == 1 and result.error_rows == 0
    writes = [p for name, p in db.calls if name == "import_student_row_atomic"]
    assert writes[0]["p_source_id"] == "00042" and writes[0]["p_source_system"] == "old-roster"
    assert "p_source_id" not in writes[1] and "p_source_system" not in writes[1]
    assert not db.responses
