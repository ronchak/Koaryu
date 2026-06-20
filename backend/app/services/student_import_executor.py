import logging
from typing import Any, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.schemas.student import CsvImportOptions, CsvImportResult
from app.services.program_service import ProgramService
from app.services.student_import_csv import make_import_issue
from app.services.student_import_ids import deterministic_import_uuid
from app.services.student_import_planner import StudentImportPlanner
from app.services.student_import_runs import StudentImportRunStore
from app.services.student_import_setup_writer import StudentImportSetupWriter
from app.services.student_program_memberships import StudentProgramMembershipStore
from app.services.student_write_payload import prepare_student_write_payload
from app.services.supabase_rpc import execute_required_rpc, first_rpc_row

IMPORT_RUN_CLAIM_CHECK_ROW_INTERVAL = 100
STUDENT_IMPORT_FAILED_DETAIL = {
    "code": "STUDENT_IMPORT_FAILED",
    "message": "Student import failed unexpectedly. Retry or contact support.",
}
STUDENT_IMPORT_FAILED_MESSAGE = STUDENT_IMPORT_FAILED_DETAIL["message"]
STUDENT_IMPORT_ROW_FAILED_MESSAGE = "This row could not be imported safely. Retry or contact support."
STUDENT_IMPORT_RESULT_SAVE_WARNING = (
    "Import data was committed, but the cached import result could not be saved. "
    "Retry with the same idempotency key or contact support."
)
STUDENT_IMPORT_AUDIT_LOG_WARNING = (
    "Students were imported, but the final import audit log could not be written. "
    "Contact support if you need the audit event reconciled."
)

logger = logging.getLogger(__name__)


class StudentImportExecutor:
    def __init__(self, supabase: Client):
        self.supabase = supabase
        self.planner = StudentImportPlanner(supabase)
        self.setup_writer = StudentImportSetupWriter(supabase)
        self.memberships = StudentProgramMembershipStore(supabase)

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
        non_critical_errors: list[str] = []

        if cached_result is not None:
            return cached_result
        if not processing_token:
            raise HTTPException(status_code=500, detail="Failed to claim the student import run.")

        try:
            import_runs.ensure_claim_active(import_run["id"], processing_token)
            _, planned_rows = self.planner.prepare_import(rows, mapping, studio_id, effective_options)

            import_runs.ensure_claim_active(import_run["id"], processing_token)
            created_programs = (
                self.setup_writer._create_missing_programs(
                    studio_id,
                    actor_id,
                    planned_rows,
                    import_run["id"],
                    non_critical_errors,
                )
                if effective_options.create_missing_programs
                else []
            )
            import_runs.ensure_claim_active(import_run["id"], processing_token)
            ProgramService(self.supabase).ensure_program_ladders(studio_id)
            belt_rank_lookup = self.planner.build_belt_rank_lookup(studio_id)
            import_runs.ensure_claim_active(import_run["id"], processing_token)
            created_ladders, created_belts = (
                self.setup_writer._create_missing_belts(
                    studio_id,
                    actor_id,
                    planned_rows,
                    belt_rank_lookup,
                    import_run["id"],
                    non_critical_errors,
                )
                if effective_options.create_missing_belts
                else ([], [])
            )

            imported, imported_without_belt = self._import_valid_rows(
                planned_rows=planned_rows,
                studio_id=studio_id,
                import_run_id=import_run["id"],
                processing_token=processing_token,
                import_runs=import_runs,
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

            result = self._save_result_with_warning_fallback(
                import_runs,
                import_run["id"],
                processing_token,
                result,
                effective_idempotency_key,
            )
            return self._write_final_audit_log(
                import_runs,
                import_run["id"],
                processing_token,
                result,
                studio_id=studio_id,
                actor_id=actor_id,
                imported=imported,
                total_rows=len(rows),
                created_programs=created_programs,
                created_ladders=created_ladders,
                created_belts=created_belts,
                imported_without_belt=imported_without_belt,
                idempotency_key=effective_idempotency_key,
            )
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
        import_runs: StudentImportRunStore,
    ) -> tuple[int, int]:
        imported = 0
        imported_without_belt = 0

        for row_index, row in enumerate(planned_rows):
            if row_index % IMPORT_RUN_CLAIM_CHECK_ROW_INTERVAL == 0:
                import_runs.ensure_claim_active(import_run_id, processing_token)
            if not row["is_valid"]:
                continue

            mapped = dict(row["data"])
            guardian_fields = self._pop_guardian_fields(mapped)
            program_ids = self.memberships.normalize_program_ids_for_write(
                studio_id,
                row.get("resolved_program_id"),
                None,
            )
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
                    mapped["notes"] = self.planner.append_import_note(
                        mapped.get("notes"),
                        f"Imported current belt (unresolved): {unresolved_belt_value}",
                    )

            mapped["id"] = deterministic_import_uuid(
                import_run_id,
                "student-row",
                str(row["row_number"]),
            )
            mapped["studio_id"] = studio_id
            mapped = prepare_student_write_payload(mapped, set_default_is_minor=True)

            try:
                self._import_student_row_atomic(
                    mapped=mapped,
                    studio_id=studio_id,
                    import_run_id=import_run_id,
                    processing_token=processing_token,
                    row_number=row["row_number"],
                    guardian_fields=guardian_fields,
                    program_ids=program_ids,
                )
            except Exception:
                logger.exception(
                    "Student import row failed",
                    extra={
                        "studio_id": studio_id,
                        "import_run_id": import_run_id,
                        "row_number": row["row_number"],
                    },
                )
                row["issues"].append(make_import_issue(
                    "execute_failed",
                    STUDENT_IMPORT_ROW_FAILED_MESSAGE,
                    field=None,
                ))
                row["is_valid"] = False
                continue

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

    def _save_result_with_warning_fallback(
        self,
        import_runs: StudentImportRunStore,
        import_run_id: str,
        processing_token: str,
        result: CsvImportResult,
        idempotency_key: str,
    ) -> CsvImportResult:
        try:
            if not import_runs.save_result(import_run_id, processing_token, result):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This student import was reclaimed before its result could be saved. Retry shortly with the same idempotency key.",
                )
        except Exception as exc:
            if isinstance(exc, HTTPException):
                raise
            logger.exception(
                "Student import result cache save failed",
                extra={"import_run_id": import_run_id},
            )
            result = import_runs.apply_result_execution_metadata(
                result,
                idempotency_key=idempotency_key,
                non_critical_errors=[
                    *result.non_critical_errors,
                    STUDENT_IMPORT_RESULT_SAVE_WARNING,
                ],
            )
        return result

    def _write_final_audit_log(
        self,
        import_runs: StudentImportRunStore,
        import_run_id: str,
        processing_token: str,
        result: CsvImportResult,
        *,
        studio_id: str,
        actor_id: str,
        imported: int,
        total_rows: int,
        created_programs: list[str],
        created_ladders: list[str],
        created_belts: list[str],
        imported_without_belt: int,
        idempotency_key: str,
    ) -> CsvImportResult:
        try:
            self.supabase.table("audit_logs").insert({
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "students.imported",
                "entity_type": "student",
                "entity_id": None,
                "metadata": {
                    "imported": imported,
                    "total": total_rows,
                    "created_programs": created_programs,
                    "created_ladders": created_ladders,
                    "created_belts": created_belts,
                    "imported_without_belt": imported_without_belt,
                    "idempotency_key": idempotency_key,
                },
            }).execute()
        except Exception:
            logger.exception(
                "Student import final audit log write failed",
                extra={"studio_id": studio_id, "import_run_id": import_run_id},
            )
            result = import_runs.apply_result_execution_metadata(
                result,
                idempotency_key=idempotency_key,
                non_critical_errors=[
                    *result.non_critical_errors,
                    STUDENT_IMPORT_AUDIT_LOG_WARNING,
                ],
            )
            try:
                import_runs.save_result(import_run_id, processing_token, result)
            except Exception:
                pass
        return result

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
