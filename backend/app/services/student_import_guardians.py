from __future__ import annotations

import uuid
from typing import Optional

from supabase import Client

from app.schemas.student import CsvImportIssue


class StudentImportGuardianWriter:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    @staticmethod
    def _deterministic_import_uuid(import_run_id: str, namespace: str, value: str) -> str:
        return str(uuid.uuid5(uuid.UUID(import_run_id), f"{namespace}:{value}"))

    def upsert_import_guardian(
        self,
        *,
        studio_id: str,
        student_id: str,
        import_run_id: str,
        row_number: int,
        guardian_name: Optional[str],
        guardian_email: Optional[str],
        guardian_phone: Optional[str],
        guardian_relation: Optional[str],
    ) -> Optional[CsvImportIssue]:
        if not guardian_name:
            return None

        try:
            parts = guardian_name.split(" ", 1)
            g_first = parts[0]
            g_last = parts[1] if len(parts) > 1 else ""
            guardian_id = self._deterministic_import_uuid(
                import_run_id,
                "guardian-row",
                str(row_number),
            )
            g_result = (
                self.supabase.table("guardians")
                .upsert({
                    "id": guardian_id,
                    "studio_id": studio_id,
                    "first_name": g_first,
                    "last_name": g_last,
                    "email": guardian_email,
                    "phone": guardian_phone,
                    "relation": guardian_relation,
                    "is_primary_contact": True,
                }, on_conflict="id")
                .execute()
            )
            if g_result.data:
                link_id = self._deterministic_import_uuid(
                    import_run_id,
                    "student-guardian-link",
                    f"{student_id}:{guardian_id}",
                )
                (
                    self.supabase.table("student_guardians")
                    .upsert({
                        "id": link_id,
                        "student_id": student_id,
                        "guardian_id": guardian_id,
                    }, on_conflict="id")
                    .execute()
                )
        except Exception as exc:
            return CsvImportIssue(
                code="guardian_import_failed",
                message=(
                    "Student imported, but guardian details could not be linked "
                    f"automatically: {str(exc) or 'guardian import failed'}."
                ),
                severity="warning",
                field="guardian_name",
                value=guardian_name,
                suggested_action=(
                    "Open the student record after import if you need to add the guardian manually."
                ),
            )

        return None
