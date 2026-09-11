import logging
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.student import CsvImportOptions, CsvImportResult
from app.services.student_import_ids import deterministic_import_uuid
from app.services.student_import_planner import StudentImportPlanner
from app.services.student_import_plan_rows import append_import_note
from app.services.student_import_runs import StudentImportRunStore
from app.services.student_import_setup_writer import StudentImportSetupWriter
from app.services.student_write_payload import prepare_student_write_payload
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row

STUDENT_IMPORT_FAILED_DETAIL = {
    "code": "STUDENT_IMPORT_FAILED",
    "message": "Student import failed unexpectedly. Retry or contact support.",
}
STUDENT_IMPORT_FAILED_MESSAGE = STUDENT_IMPORT_FAILED_DETAIL["message"]
logger = logging.getLogger(__name__)


class StudentImportExecutor:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.planner = StudentImportPlanner(supabase)
        self.setup_writer = StudentImportSetupWriter(supabase)

    async def execute_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        options: Optional[CsvImportOptions],
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> CsvImportResult:
        effective_options = options or CsvImportOptions()
        import_runs = StudentImportRunStore(self.supabase)
        import_run, cached_result, effective_idempotency_key, processing_token = import_runs.claim(
            studio_id=studio_id,
            actor_id=actor_id,
            rows=rows,
            mapping=mapping,
            options=effective_options,
            idempotency_key=idempotency_key,
        )

        if cached_result is not None:
            return cached_result
        if not processing_token:
            raise HTTPException(status_code=500, detail="Failed to claim the student import run.")

        try:
            receipts: dict[str, dict[str, Any]] = {}
            for receipt in import_run["receipts"]:
                receipts.setdefault(receipt["kind"], {})[receipt["key"]] = receipt["result"]
            _, planned_rows = self.planner.prepare_import(rows, mapping, studio_id, effective_options, receipts)
            self.setup_writer.prepare(
                planned_rows,
                studio_id=studio_id,
                import_run_id=import_run["id"],
                processing_token=processing_token,
                receipts=receipts,
            )
            created_programs = [value["name"] for value in receipts.get("program", {}).values() if value["created"]]
            created_ladders = [value["name"] for value in receipts.get("ladder", {}).values() if value["created"]]
            created_belts = [
                f"{value['name']} ({value['ladder_name']})"
                for value in receipts.get("rank", {}).values() if value["created"]
            ]
            non_critical_errors = list(dict.fromkeys(
                value["warning"]
                for kind in ("program", "ladder", "rank")
                for value in receipts.get(kind, {}).values() if value.get("warning")
            ))

            imported, imported_without_belt = self._import_valid_rows(
                planned_rows=planned_rows,
                studio_id=studio_id,
                import_run_id=import_run["id"],
                processing_token=processing_token,
            )

            result = self.planner.hydrate_import_result(
                planned_rows,
                total_rows=len(rows),
                created_programs=created_programs,
                created_ladders=created_ladders,
                created_belts=created_belts,
                imported_without_belt_count=imported_without_belt,
                imported_count=imported,
                idempotency_key=effective_idempotency_key,
            )
            result = import_runs.apply_result_execution_metadata(
                result,
                idempotency_key=effective_idempotency_key,
                non_critical_errors=non_critical_errors,
            )

            return import_runs.save_result(import_run["id"], processing_token, result)
        except HTTPException as exc:
            if exc.status_code >= status.HTTP_500_INTERNAL_SERVER_ERROR:
                logger.exception(
                    "Student import failed with an internal HTTP exception",
                    extra={"studio_id": studio_id, "import_run_id": import_run["id"]},
                )
                self._mark_failed_safely(
                    import_runs,
                    import_run["id"],
                    processing_token,
                    STUDENT_IMPORT_FAILED_MESSAGE,
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=STUDENT_IMPORT_FAILED_DETAIL,
                ) from exc
            self._mark_failed_safely(import_runs, import_run["id"], processing_token, str(exc.detail))
            raise
        except Exception as exc:
            logger.exception(
                "Student import failed unexpectedly",
                extra={"studio_id": studio_id, "import_run_id": import_run["id"]},
            )
            self._mark_failed_safely(
                import_runs,
                import_run["id"],
                processing_token,
                STUDENT_IMPORT_FAILED_MESSAGE,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=STUDENT_IMPORT_FAILED_DETAIL,
            ) from exc

    def _import_valid_rows(
        self,
        *,
        planned_rows: list[dict[str, Any]],
        studio_id: str,
        import_run_id: str,
        processing_token: str,
    ) -> tuple[int, int]:
        imported = 0
        imported_without_belt = 0

        for row in planned_rows:
            if not row["is_valid"]:
                continue
            if row.get("completed"):
                imported += 1
                imported_without_belt += int(row["imported_without_belt"])
                continue

            mapped = dict(row["data"])
            guardian_fields = self._pop_guardian_fields(mapped)
            program_ids = [row["resolved_program_id"]]
            mapped["program_id"] = program_ids[0]

            unresolved_belt_value = row.get("unresolved_belt_value")
            resolved_belt_rank_id = row.get("resolved_belt_rank_id")
            row_imported_without_belt = False
            if resolved_belt_rank_id:
                mapped["current_belt_rank_id"] = resolved_belt_rank_id
            else:
                mapped.pop("current_belt_rank_id", None)
                if unresolved_belt_value:
                    row_imported_without_belt = True
                    mapped["notes"] = append_import_note(
                        mapped.get("notes"),
                        f"Imported current belt (unresolved): {unresolved_belt_value}",
                    )

            mapped["id"] = deterministic_import_uuid(
                import_run_id,
                "student-row",
                str(row["row_number"]),
            )
            mapped["studio_id"] = studio_id
            mapped = prepare_student_write_payload(mapped, for_creation=True)

            # Keep original diagnostics with the committed row. Rows without
            # diagnostics need no duplicate profile data in their receipt.
            mapped["_import_outcome"] = {
                "row_number": row["row_number"],
                "is_valid": True,
                "issues": [issue.model_dump(mode="json") for issue in row["issues"]],
                "data": row["data"] if row["issues"] else {},
                "pending_belt_name": row.get("pending_belt_name"),
                "unresolved_belt_value": row.get("unresolved_belt_value"),
                "belt_creation_target_ladder_id": row.get("belt_creation_target_ladder_id"),
                "belt_creation_requires_new_ladder": row.get("belt_creation_requires_new_ladder", False),
                "imported_without_belt": row_imported_without_belt,
            }
            # Unknown failures abort this attempt. The same key recovers any
            # committed receipt instead of caching the failure as bad input.
            self._import_student_row_atomic(
                mapped=mapped,
                studio_id=studio_id,
                import_run_id=import_run_id,
                processing_token=processing_token,
                row_number=row["row_number"],
                guardian_fields=guardian_fields,
                program_ids=program_ids,
            )

            imported += 1
            if row_imported_without_belt:
                imported_without_belt += 1

        return imported, imported_without_belt

    def _import_student_row_atomic(
        self,
        *,
        mapped: dict[str, Any],
        studio_id: str,
        import_run_id: str,
        processing_token: str,
        row_number: int,
        guardian_fields: dict[str, Any],
        program_ids: list[str],
    ) -> str:
        result = execute_required_rpc(self.supabase, "import_student_row_atomic", {
            "p_student": mapped,
            "p_studio_id": studio_id,
            "p_import_run_id": import_run_id,
            "p_processing_token": processing_token,
            "p_row_number": row_number,
            "p_guardian_name": guardian_fields["guardian_name"],
            "p_guardian_email": guardian_fields["guardian_email"],
            "p_guardian_phone": guardian_fields["guardian_phone"],
            "p_guardian_relation": guardian_fields["guardian_relation"],
            "p_program_ids": program_ids,
        })
        row = first_rpc_row(result) or {}
        student_id = row.get("student_id")
        if not student_id:
            raise RuntimeError("Atomic student import did not return a student id")
        return str(student_id)

    @staticmethod
    def _pop_guardian_fields(mapped: dict[str, Any]) -> dict[str, Any]:
        return {
            "guardian_name": mapped.pop("guardian_name", None),
            "guardian_email": mapped.pop("guardian_email", None),
            "guardian_phone": mapped.pop("guardian_phone", None),
            "guardian_relation": mapped.pop("guardian_relation", None),
        }

    @staticmethod
    def _mark_failed_safely(
        import_runs: StudentImportRunStore,
        import_run_id: str,
        processing_token: str,
        detail: str,
    ) -> None:
        try:
            import_runs.mark_failed(import_run_id, processing_token, detail)
        except Exception:
            pass
