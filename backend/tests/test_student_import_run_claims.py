from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException

from app.schemas.student import CsvImportDuplicateDecision, CsvImportOptions, CsvImportResult
from app.services.student_import_runs import StudentImportRunStore


class Responses:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def rpc(self, name, params):
        self.calls.append((name, params))
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=next(self.responses)))


def test_request_identity_preserves_keys_and_distinguishes_changed_inputs():
    store = StudentImportRunStore
    assert store.normalize_idempotency_key(None) is None
    assert store.normalize_idempotency_key("  ") is None
    assert store.normalize_idempotency_key(" import-key ") == "import-key"
    for key in ("x" * 256, "import\nkey"):
        with pytest.raises(HTTPException) as error:
            store.normalize_idempotency_key(key)
        assert error.value.status_code == 400
    rows, mapping = (
        [{"First": "Ava", "Last": "Nguyen"}],
        {"First": "legal_first_name", "Last": "legal_last_name"},
    )
    options = CsvImportOptions()
    original = store.compute_request_hash(rows, mapping, options)
    assert (
        store.compute_request_hash(rows, dict(reversed(list(mapping.items()))), options) == original
    )
    for changed in [
        ([{**rows[0], "First": "Mina"}], mapping, options),
        (rows, {**mapping, "First": "preferred_name"}, options),
        (rows, mapping, CsvImportOptions(create_missing_programs=True)),
    ]:
        assert store.compute_request_hash(*changed) != original
    # Absent or empty decisions keep the historical identity; any decision changes it.
    assert store.compute_request_hash(rows, mapping, options, {}) == original
    skip = {"2": CsvImportDuplicateDecision(action="skip", matched_student_id="s1")}
    create = {"2": CsvImportDuplicateDecision(action="create", matched_student_id="s1")}
    assert store.compute_request_hash(rows, mapping, options, skip) != original
    assert store.compute_request_hash(rows, mapping, options, skip) != store.compute_request_hash(
        rows, mapping, options, create
    )
    assert store.compute_request_hash(rows, mapping, options, skip) == store.compute_request_hash(
        rows, mapping, options, dict(skip)
    )


def test_decisions_recorded_before_acknowledgements_existed_hash_identically():
    import hashlib
    import json

    rows, mapping = (
        [{"First": "Ava", "Last": "Nguyen"}],
        {"First": "legal_first_name", "Last": "legal_last_name"},
    )
    options = CsvImportOptions()
    legacy_shape = {"2": {"action": "skip", "matched_student_id": "s1", "of_row": None}}
    expected = hashlib.sha256(
        json.dumps(
            {
                "operation": "students_csv_execute",
                "rows": rows,
                "mapping": mapping,
                "options": options.model_dump(mode="json", exclude={"source_system"}),
                "duplicate_decisions": legacy_shape,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
    ).hexdigest()
    from_legacy = {"2": CsvImportDuplicateDecision.model_validate(legacy_shape["2"])}
    with_defaults = {
        "2": CsvImportDuplicateDecision(
            action="skip",
            matched_student_id="s1",
            of_row=None,
            acknowledged_student_ids=[],
            acknowledged_rows=[],
        )
    }
    assert (
        StudentImportRunStore.compute_request_hash(rows, mapping, options, from_legacy) == expected
    )
    assert (
        StudentImportRunStore.compute_request_hash(rows, mapping, options, with_defaults)
        == expected
    )
    acknowledged = {
        "2": CsvImportDuplicateDecision(
            action="skip", matched_student_id="s1", acknowledged_student_ids=["s1"]
        )
    }
    assert (
        StudentImportRunStore.compute_request_hash(rows, mapping, options, acknowledged) != expected
    )


def test_claim_translates_v2_envelopes_without_reimplementing_database_claims():
    payload = dict(
        studio_id="studio",
        actor_id="actor",
        rows=[],
        mapping={},
        options=CsvImportOptions(),
        idempotency_key=None,
    )
    db = Responses([{"claim_status": "claimed", "run_row": {"id": "run", "receipts": []}}])
    run, cached, key, token = StudentImportRunStore(db).claim(**payload)
    assert run == {"id": "run", "receipts": []} and cached is None
    name, params = db.calls[0]
    assert name == "claim_student_import_run_v2"
    assert params == {
        "p_studio_id": "studio",
        "p_actor_id": "actor",
        "p_operation": "students_csv_execute",
        "p_idempotency_key": key,
        "p_request_hash": key.removeprefix("auto:"),
        "p_processing_token": token,
        "p_stale_after_seconds": 45,
    }
    assert key.startswith("auto:") and len(key) == 69 and uuid.UUID(token).version == 4
    expected = CsvImportResult(
        total_rows=1,
        valid_rows=1,
        error_rows=0,
        imported_count=1,
        non_critical_errors=["Saved warning"],
    )
    db = Responses(
        [
            {
                "claim_status": "completed",
                "run_row": {"result_json": expected.model_dump(mode="json")},
            }
        ]
    )
    _, cached, key, token = StudentImportRunStore(db).claim(
        **{**payload, "idempotency_key": " explicit "}
    )
    assert key == "explicit" and token is None
    assert cached == expected.model_copy(
        update={"idempotency_key": "explicit", "reused_result": True, "execution_status": "reused"}
    )
    for claim_status, status_code in [
        ("hash_mismatch", 409),
        ("already_processing", 409),
        ("unsupported_run", 409),
        ("unknown", 500),
    ]:
        db = Responses([{"claim_status": claim_status, "run_row": None}])
        with pytest.raises(HTTPException) as error:
            StudentImportRunStore(db).claim(**payload)
        assert error.value.status_code == status_code


def test_finish_returns_authoritative_result_and_preserves_failure_boundary():
    proposed = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1)
    saved = proposed.model_copy(
        update={
            "execution_status": "completed_with_warnings",
            "non_critical_errors": ["Frozen audit warning"],
        }
    )
    db = Responses(
        [{"updated": True, "run_row": {"result_json": saved.model_dump(mode="json")}}],
        [{"updated": False, "run_row": None}],
        [{"updated": True}],
        [{"updated": False}],
    )
    store = StudentImportRunStore(db)
    assert store.save_result("run", "token", proposed) == saved
    assert db.calls[0] == (
        "finish_student_import_run",
        {
            "p_import_run_id": "run",
            "p_processing_token": "token",
            "p_status": "completed",
            "p_result_json": proposed.model_dump(mode="json"),
            "p_error_message": None,
        },
    )
    with pytest.raises(HTTPException) as error:
        store.save_result("run", "stale", proposed)
    assert error.value.status_code == 409
    assert store.mark_failed("run", "token", "x" * 1200)
    assert db.calls[-1][1] == {
        "p_import_run_id": "run",
        "p_processing_token": "token",
        "p_status": "failed",
        "p_result_json": None,
        "p_error_message": "x" * 1000,
    }
    assert not store.mark_failed("run", "stale", "failed")


def test_source_system_changes_request_hash():
    from app.services.student_import_runs import StudentImportRunStore

    rows = [{"First": "Testava", "ID": "00042"}]
    mapping = {"First": "legal_first_name", "ID": "source_id"}
    first = StudentImportRunStore.compute_request_hash(rows, mapping, CsvImportOptions())
    assert first != StudentImportRunStore.compute_request_hash(
        rows, mapping, CsvImportOptions(source_system="old-roster")
    )


def test_source_system_is_trimmed_before_matching_hashing_and_storage():
    from pydantic import ValidationError

    from app.services.student_import_runs import StudentImportRunStore

    assert CsvImportOptions(source_system="  csv ").source_system == "csv"
    rows = [{"First": "Testava", "ID": "00042"}]
    mapping = {"First": "legal_first_name", "ID": "source_id"}
    assert StudentImportRunStore.compute_request_hash(
        rows, mapping, CsvImportOptions(source_system=" old-roster ")
    ) == StudentImportRunStore.compute_request_hash(
        rows, mapping, CsvImportOptions(source_system="old-roster")
    )
    with pytest.raises(ValidationError):
        CsvImportOptions(source_system="   ")


@pytest.mark.parametrize(
    "decisions,expected",
    [
        (None, "60b32df1b2b9c957b81a2d2ac5618d3bd6352158c2eec4868fd44d8c75bcf1a8"),
        (
            {"2": CsvImportDuplicateDecision(action="skip", matched_student_id="s1")},
            "63b06b56cd7aa61a5a43d4d58efbcad5e3280609e80b2389eb7e16238ddba8a6",
        ),
    ],
)
def test_unset_source_system_preserves_pre_a2b_request_hash(decisions, expected):
    # Pins obtained from git archive b72536930c1aaf7e6380e60c8abbb757ff2445a2
    # backend/app into a temporary checkout, running its CsvImportOptions() and
    # StudentImportRunStore.compute_request_hash with these exact inputs.
    rows = [{"First": "Ava", "Last": "Nguyen"}]
    mapping = {"First": "legal_first_name", "Last": "legal_last_name"}
    assert CsvImportOptions().source_system is None
    for options in (CsvImportOptions(), CsvImportOptions(source_system=None)):
        assert (
            StudentImportRunStore.compute_request_hash(rows, mapping, options, decisions)
            == expected
        )
        assert (
            StudentImportRunStore.compute_request_hash(
                rows, mapping, CsvImportOptions(source_system="csv"), decisions
            )
            != expected
        )


def test_mapped_id_changes_request_identity_even_with_unset_source_system():
    rows = [{"First": "Ava", "Last": "Nguyen", "ID": "00042"}]
    names = {"First": "legal_first_name", "Last": "legal_last_name"}
    assert StudentImportRunStore.compute_request_hash(
        rows, {**names, "ID": ""}, CsvImportOptions()
    ) != StudentImportRunStore.compute_request_hash(
        rows, {**names, "ID": "source_id"}, CsvImportOptions()
    )
