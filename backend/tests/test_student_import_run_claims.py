from types import SimpleNamespace
import uuid

import pytest
from fastapi import HTTPException

from app.schemas.student import CsvImportOptions, CsvImportResult
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
    rows, mapping = [{"First": "Ava", "Last": "Nguyen"}], {"First": "legal_first_name", "Last": "legal_last_name"}
    options = CsvImportOptions()
    original = store.compute_request_hash(rows, mapping, options)
    assert store.compute_request_hash(rows, dict(reversed(list(mapping.items()))), options) == original
    for changed in [([{**rows[0], "First": "Mina"}], mapping, options),
                    (rows, {**mapping, "First": "preferred_name"}, options),
                    (rows, mapping, CsvImportOptions(create_missing_programs=True))]:
        assert store.compute_request_hash(*changed) != original


def test_claim_translates_v2_envelopes_without_reimplementing_database_claims():
    payload = dict(studio_id="studio", actor_id="actor", rows=[], mapping={}, options=CsvImportOptions(), idempotency_key=None)
    db = Responses([{"claim_status": "claimed", "run_row": {"id": "run", "receipts": []}}])
    run, cached, key, token = StudentImportRunStore(db).claim(**payload)
    assert run == {"id": "run", "receipts": []} and cached is None
    name, params = db.calls[0]
    assert name == "claim_student_import_run_v2"
    assert params == {"p_studio_id": "studio", "p_actor_id": "actor", "p_operation": "students_csv_execute",
                      "p_idempotency_key": key, "p_request_hash": key.removeprefix("auto:"),
                      "p_processing_token": token, "p_stale_after_seconds": 45}
    assert key.startswith("auto:") and len(key) == 69 and uuid.UUID(token).version == 4
    expected = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1, non_critical_errors=["Saved warning"])
    db = Responses([{"claim_status": "completed", "run_row": {"result_json": expected.model_dump(mode="json")}}])
    _, cached, key, token = StudentImportRunStore(db).claim(**{**payload, "idempotency_key": " explicit "})
    assert key == "explicit" and token is None
    assert cached == expected.model_copy(update={"idempotency_key": "explicit", "reused_result": True, "execution_status": "reused"})
    for claim_status, status_code in [("hash_mismatch", 409), ("already_processing", 409), ("unsupported_run", 409), ("unknown", 500)]:
        db = Responses([{"claim_status": claim_status, "run_row": None}])
        with pytest.raises(HTTPException) as error:
            StudentImportRunStore(db).claim(**payload)
        assert error.value.status_code == status_code


def test_finish_returns_authoritative_result_and_preserves_failure_boundary():
    proposed = CsvImportResult(total_rows=1, valid_rows=1, error_rows=0, imported_count=1)
    saved = proposed.model_copy(update={"execution_status": "completed_with_warnings", "non_critical_errors": ["Frozen audit warning"]})
    db = Responses([{"updated": True, "run_row": {"result_json": saved.model_dump(mode="json")}}],
                   [{"updated": False, "run_row": None}], [{"updated": True}], [{"updated": False}])
    store = StudentImportRunStore(db)
    assert store.save_result("run", "token", proposed) == saved
    assert db.calls[0] == ("finish_student_import_run", {"p_import_run_id": "run", "p_processing_token": "token",
        "p_status": "completed", "p_result_json": proposed.model_dump(mode="json"), "p_error_message": None})
    with pytest.raises(HTTPException) as error:
        store.save_result("run", "stale", proposed)
    assert error.value.status_code == 409
    assert store.mark_failed("run", "token", "x" * 1200)
    assert db.calls[-1][1] == {"p_import_run_id": "run", "p_processing_token": "token", "p_status": "failed",
                             "p_result_json": None, "p_error_message": "x" * 1000}
    assert not store.mark_failed("run", "stale", "failed")
