import hashlib
import json
import uuid
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.student import CsvImportOptions, CsvImportResult
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row

IMPORT_RUN_OPERATION = "students_csv_execute"
IMPORT_RUN_STALE_AFTER_SECONDS = 45


class StudentImportRunStore:
    """Persistence boundary for CSV import idempotency and worker claims."""

    def __init__(self, supabase: Client):
        self.supabase = supabase

    @staticmethod
    def normalize_idempotency_key(value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @staticmethod
    def compute_request_hash(
        rows: list[dict[str, Any]],
        mapping: dict[str, str],
        options: CsvImportOptions,
    ) -> str:
        payload = {
            "operation": IMPORT_RUN_OPERATION,
            "rows": rows,
            "mapping": mapping,
            "options": options.model_dump(mode="json"),
        }
        serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def apply_result_execution_metadata(
        result: CsvImportResult,
        *,
        idempotency_key: str,
        reused_result: bool = False,
        non_critical_errors: Optional[list[str]] = None,
    ) -> CsvImportResult:
        result.idempotency_key = idempotency_key
        result.reused_result = reused_result
        if non_critical_errors is not None:
            result.non_critical_errors = list(non_critical_errors)
        if reused_result:
            result.execution_status = "reused"
        elif result.non_critical_errors:
            result.execution_status = "completed_with_warnings"
        else:
            result.execution_status = "completed"
        return result

    def _load_cached_result(
        self,
        run_row: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> Optional[CsvImportResult]:
        result_payload = run_row.get("result_json")
        if not result_payload:
            return None
        result = CsvImportResult.model_validate(result_payload)
        return self.apply_result_execution_metadata(
            result,
            idempotency_key=idempotency_key,
            reused_result=True,
        )

    def claim(
        self,
        *,
        studio_id: str,
        actor_id: str,
        rows: list[dict[str, Any]],
        mapping: dict[str, str],
        options: CsvImportOptions,
        idempotency_key: Optional[str],
    ) -> tuple[dict[str, Any], Optional[CsvImportResult], str, Optional[str]]:
        request_hash = self.compute_request_hash(rows, mapping, options)
        effective_key = self.normalize_idempotency_key(idempotency_key) or f"auto:{request_hash}"
        claim_token = str(uuid.uuid4())
        return self._claim_with_rpc(
            studio_id=studio_id,
            actor_id=actor_id,
            request_hash=request_hash,
            effective_key=effective_key,
            claim_token=claim_token,
        )

    def _claim_with_rpc(
        self,
        *,
        studio_id: str,
        actor_id: str,
        request_hash: str,
        effective_key: str,
        claim_token: str,
    ) -> tuple[dict[str, Any], Optional[CsvImportResult], str, Optional[str]]:
        result = execute_required_rpc(self.supabase, "claim_student_import_run", {
            "p_studio_id": studio_id,
            "p_actor_id": actor_id,
            "p_operation": IMPORT_RUN_OPERATION,
            "p_idempotency_key": effective_key,
            "p_request_hash": request_hash,
            "p_processing_token": claim_token,
            "p_stale_after_seconds": IMPORT_RUN_STALE_AFTER_SECONDS,
        })
        claim = first_rpc_row(result) or {}
        claim_status = str(claim.get("claim_status") or "")
        run_row = claim.get("run_row")

        if claim_status == "hash_mismatch":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This idempotency key is already in use for a different student import request.",
            )
        if claim_status == "completed" and isinstance(run_row, dict):
            cached = self._load_cached_result(run_row, idempotency_key=effective_key)
            if cached is not None:
                return run_row, cached, effective_key, None
        if claim_status == "already_processing":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "This student import is still processing for the provided "
                    "idempotency key. Retry shortly with the same key."
                ),
            )
        if claim_status == "claimed" and isinstance(run_row, dict):
            return run_row, None, effective_key, claim_token

        raise HTTPException(status_code=500, detail="Failed to initialize the student import run.")

    def save_result(
        self,
        import_run_id: str,
        processing_token: str,
        result: CsvImportResult,
    ) -> bool:
        update_result = execute_required_rpc(self.supabase, "finish_student_import_run", {
            "p_import_run_id": import_run_id,
            "p_processing_token": processing_token,
            "p_status": "completed",
            "p_result_json": result.model_dump(mode="json"),
            "p_error_message": None,
        })
        row = first_rpc_row(update_result) or {}
        return bool(row.get("updated"))

    def mark_failed(
        self,
        import_run_id: str,
        processing_token: str,
        message: str,
    ) -> bool:
        update_result = execute_required_rpc(self.supabase, "finish_student_import_run", {
            "p_import_run_id": import_run_id,
            "p_processing_token": processing_token,
            "p_status": "failed",
            "p_result_json": None,
            "p_error_message": message[:1000],
        })
        row = first_rpc_row(update_result) or {}
        return bool(row.get("updated"))

    def ensure_claim_active(self, import_run_id: str, processing_token: str) -> None:
        update_result = execute_required_rpc(self.supabase, "heartbeat_student_import_run", {
            "p_import_run_id": import_run_id,
            "p_processing_token": processing_token,
        })
        row = first_rpc_row(update_result) or {}
        if row.get("updated"):
            return
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This student import was reclaimed by another request. Retry shortly with the same idempotency key.",
        )
