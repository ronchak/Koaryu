import csv
import io
from datetime import date, datetime, timezone
from typing import Optional
from supabase import Client
from fastapi import HTTPException, status
from app.schemas.student import (
    StudentCreate, StudentUpdate, StudentResponse, StudentListResponse,
    GuardianCreate, GuardianResponse, CsvImportRow, CsvImportResult,
    BulkTagUpdate, BulkStatusUpdate,
)
from app.services.studio_scope import ensure_optional_studio_record

VALID_STATUSES = {"active", "trialing", "inactive", "paused", "canceled"}

# CSV column aliases — maps common spreadsheet header names to Koaryu fields
CSV_FIELD_ALIASES: dict[str, str] = {
    "first name": "legal_first_name",
    "firstname": "legal_first_name",
    "first_name": "legal_first_name",
    "last name": "legal_last_name",
    "lastname": "legal_last_name",
    "last_name": "legal_last_name",
    "preferred name": "preferred_name",
    "nickname": "preferred_name",
    "dob": "date_of_birth",
    "birthday": "date_of_birth",
    "birth date": "date_of_birth",
    "email": "email",
    "phone": "phone",
    "mobile": "phone",
    "cell": "phone",
    "status": "status",
    "notes": "notes",
    "tags": "tags",
    "program": "program_id",
    "guardian name": "guardian_name",
    "parent name": "guardian_name",
    "guardian email": "guardian_email",
    "parent email": "guardian_email",
    "guardian phone": "guardian_phone",
    "parent phone": "guardian_phone",
    "relation": "guardian_relation",
}


def _normalize_header(h: str) -> str:
    return h.strip().lower()


class StudentService:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    # ---- Helpers ----

    def _is_minor_from_date_of_birth(self, date_of_birth: Optional[date]) -> bool:
        if not date_of_birth:
            return False

        today = datetime.now(timezone.utc).date()
        age = today.year - date_of_birth.year
        if (today.month, today.day) < (date_of_birth.month, date_of_birth.day):
            age -= 1
        return age < 18

    def _prepare_student_write(self, payload: dict, *, set_default_is_minor: bool) -> dict:
        if payload.get("tags") is None:
            payload["tags"] = []

        date_of_birth = payload.get("date_of_birth")
        if isinstance(date_of_birth, str) and date_of_birth:
            date_of_birth = date.fromisoformat(date_of_birth)
            payload["date_of_birth"] = date_of_birth
        if date_of_birth:
            payload["is_minor"] = self._is_minor_from_date_of_birth(date_of_birth)
            payload["date_of_birth"] = str(date_of_birth)
        elif set_default_is_minor:
            payload["is_minor"] = False

        if payload.get("membership_start_date"):
            if isinstance(payload["membership_start_date"], str):
                payload["membership_start_date"] = date.fromisoformat(payload["membership_start_date"])
            payload["membership_start_date"] = str(payload["membership_start_date"])

        if payload.get("hold_start_date"):
            if isinstance(payload["hold_start_date"], str):
                payload["hold_start_date"] = date.fromisoformat(payload["hold_start_date"])
            payload["hold_start_date"] = str(payload["hold_start_date"])

        if payload.get("hold_end_date"):
            if isinstance(payload["hold_end_date"], str):
                payload["hold_end_date"] = date.fromisoformat(payload["hold_end_date"])
            payload["hold_end_date"] = str(payload["hold_end_date"])

        return payload

    def _fetch_guardians_for_student(self, student_id: str) -> list[GuardianResponse]:
        result = (
            self.supabase.table("student_guardians")
            .select("guardian_id, guardians(*)")
            .eq("student_id", student_id)
            .execute()
        )
        guards = []
        for row in result.data or []:
            g = row.get("guardians") or {}
            if g:
                guards.append(GuardianResponse(**{
                    "id": g["id"],
                    "first_name": g["first_name"],
                    "last_name": g["last_name"],
                    "email": g.get("email"),
                    "phone": g.get("phone"),
                    "relation": g.get("relation"),
                    "is_primary_contact": g.get("is_primary_contact", False),
                }))
        return guards

    def _row_to_response(self, row: dict) -> StudentResponse:
        guardians = self._fetch_guardians_for_student(row["id"])
        normalized_row = {
            **{k: v for k, v in row.items() if k != "deleted_at"},
            "tags": row.get("tags") or [],
        }
        return StudentResponse(
            **normalized_row,
            guardians=guardians,
        )

    # ---- CRUD ----

    async def list_students(
        self,
        studio_id: str,
        search: Optional[str] = None,
        status_filter: Optional[str] = None,
        program_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 50,
    ) -> StudentListResponse:
        query = (
            self.supabase.table("students")
            .select("*", count="exact")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .order("legal_last_name")
            .order("legal_first_name")
        )

        if status_filter:
            query = query.eq("status", status_filter)
        if program_id:
            query = query.eq("program_id", program_id)

        offset = (page - 1) * page_size
        query = query.range(offset, offset + page_size - 1)

        result = query.execute()

        items = []
        for row in result.data or []:
            normalized_row = {
                **{k: v for k, v in row.items() if k not in ("deleted_at",)},
                "tags": row.get("tags") or [],
            }
            items.append(StudentResponse(
                **normalized_row,
                guardians=[],
            ))

        # Search filtering (simple — will be enhanced with full-text in Phase 8)
        if search:
            s = search.lower()
            items = [
                i for i in items
                if s in i.legal_first_name.lower()
                or s in i.legal_last_name.lower()
                or (i.preferred_name and s in i.preferred_name.lower())
                or (i.email and s in i.email.lower())
            ]

        return StudentListResponse(
            items=items,
            total=result.count or 0,
            page=page,
            page_size=page_size,
        )

    async def create_student(
        self, data: StudentCreate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        guardians_data = data.guardians
        student_dict = data.model_dump(exclude={"guardians"})
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            student_dict.get("program_id"),
            studio_id,
            "Program not found",
        )
        student_dict["studio_id"] = studio_id
        student_dict = self._prepare_student_write(student_dict, set_default_is_minor=True)

        result = self.supabase.table("students").insert(student_dict).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create student")

        student = result.data[0]

        # Attach guardians
        guardian_responses = []
        for g in guardians_data:
            g_dict = g.model_dump()
            g_dict["studio_id"] = studio_id
            g_result = self.supabase.table("guardians").insert(g_dict).execute()
            if g_result.data:
                gid = g_result.data[0]["id"]
                self.supabase.table("student_guardians").insert({
                    "student_id": student["id"],
                    "guardian_id": gid,
                }).execute()
                guardian_responses.append(GuardianResponse(**g_result.data[0]))

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.created",
            "entity_type": "student",
            "entity_id": student["id"],
            "metadata": {"name": f"{data.legal_first_name} {data.legal_last_name}"},
        }).execute()

        return StudentResponse(
            **{k: v for k, v in student.items() if k != "deleted_at"},
            guardians=guardian_responses,
        )

    async def get_student(self, student_id: str, studio_id: str) -> StudentResponse:
        result = (
            self.supabase.table("students")
            .select("*")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")
        return self._row_to_response(result.data)

    async def update_student(
        self, student_id: str, data: StudentUpdate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            update_dict.get("program_id"),
            studio_id,
            "Program not found",
        )

        update_dict = self._prepare_student_write(update_dict, set_default_is_minor=False)

        result = (
            self.supabase.table("students")
            .update(update_dict)
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.updated",
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": update_dict,
        }).execute()

        return self._row_to_response(result.data[0])

    async def soft_delete_student(
        self, student_id: str, studio_id: str, actor_id: str
    ) -> None:
        result = (
            self.supabase.table("students")
            .update({"deleted_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.deleted",
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": {},
        }).execute()

    # ---- Bulk Actions ----

    async def bulk_update_tags(
        self, data: BulkTagUpdate, studio_id: str, actor_id: str
    ) -> int:
        updated = 0
        for sid in data.student_ids:
            existing = (
                self.supabase.table("students")
                .select("id, tags")
                .eq("id", sid)
                .eq("studio_id", studio_id)
                .single()
                .execute()
            )
            if not existing.data:
                continue
            current_tags: list = existing.data.get("tags") or []
            new_tags = list(
                set(current_tags + data.tags_to_add) - set(data.tags_to_remove)
            )
            self.supabase.table("students").update({"tags": new_tags}).eq("id", sid).eq("studio_id", studio_id).execute()
            updated += 1
        return updated

    async def bulk_update_status(
        self, data: BulkStatusUpdate, studio_id: str, actor_id: str
    ) -> int:
        if data.status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status: {data.status}")
        result = (
            self.supabase.table("students")
            .update({"status": data.status})
            .in_("id", data.student_ids)
            .eq("studio_id", studio_id)
            .execute()
        )
        return len(result.data or [])

    # ---- CSV Import ----

    def parse_csv(self, content: bytes) -> tuple[list[str], list[dict]]:
        """Parse raw CSV bytes. Returns (headers, rows)."""
        text = content.decode("utf-8-sig")  # handle BOM
        reader = csv.DictReader(io.StringIO(text))
        headers = reader.fieldnames or []
        rows = list(reader)
        return list(headers), rows

    def auto_map_headers(self, headers: list[str]) -> dict[str, str]:
        """Return a dict mapping CSV header → Koaryu field name using known aliases."""
        mapping: dict[str, str] = {}
        for h in headers:
            normalized = _normalize_header(h)
            if normalized in CSV_FIELD_ALIASES:
                mapping[h] = CSV_FIELD_ALIASES[normalized]
            else:
                mapping[h] = ""  # unmapped
        return mapping

    def validate_import_rows(
        self, rows: list[dict], mapping: dict[str, str]
    ) -> CsvImportResult:
        """Validate rows against the mapping. Returns a structured result."""
        parsed: list[CsvImportRow] = []
        valid = 0
        errors = 0

        for i, raw_row in enumerate(rows, start=2):  # row 1 is header
            mapped: dict = {}
            row_errors: list[str] = []

            for csv_col, koaryu_field in mapping.items():
                if not koaryu_field:
                    continue
                mapped[koaryu_field] = raw_row.get(csv_col, "").strip()

            # Required field check
            if not mapped.get("legal_first_name"):
                row_errors.append("Missing required field: first name")
            if not mapped.get("legal_last_name"):
                row_errors.append("Missing required field: last name")

            # Status validation
            if mapped.get("status") and isinstance(mapped["status"], str):
                mapped["status"] = mapped["status"].lower()
            if mapped.get("status") and mapped["status"] not in VALID_STATUSES:
                row_errors.append(
                    f"Invalid status '{mapped['status']}'. Must be one of: {', '.join(VALID_STATUSES)}"
                )

            # Tags — convert comma-separated string to list
            if "tags" in mapped and isinstance(mapped["tags"], str):
                mapped["tags"] = [t.strip() for t in mapped["tags"].split(",") if t.strip()]

            is_valid = len(row_errors) == 0
            if is_valid:
                valid += 1
            else:
                errors += 1

            parsed.append(CsvImportRow(
                row_number=i,
                data=mapped,
                errors=row_errors,
                is_valid=is_valid,
            ))

        return CsvImportResult(
            total_rows=len(rows),
            valid_rows=valid,
            error_rows=errors,
            errors=[r for r in parsed if not r.is_valid],
        )

    async def execute_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        studio_id: str,
        actor_id: str,
    ) -> CsvImportResult:
        """Execute the import for all valid rows."""
        validation = self.validate_import_rows(rows, mapping)

        imported = 0
        for i, raw_row in enumerate(rows, start=2):
            mapped: dict = {}
            for csv_col, koaryu_field in mapping.items():
                if koaryu_field:
                    mapped[koaryu_field] = raw_row.get(csv_col, "").strip() or None

            # Skip rows that have errors
            row_has_error = any(r.row_number == i for r in validation.errors)
            if row_has_error:
                continue

            if isinstance(mapped.get("tags"), str):
                mapped["tags"] = [t.strip() for t in (mapped["tags"] or "").split(",") if t.strip()]
            else:
                mapped["tags"] = mapped.get("tags") or []
            if isinstance(mapped.get("status"), str):
                mapped["status"] = mapped["status"].lower()

            # Pull guardian fields out before inserting student
            guardian_name = mapped.pop("guardian_name", None)
            guardian_email = mapped.pop("guardian_email", None)
            guardian_phone = mapped.pop("guardian_phone", None)
            guardian_relation = mapped.pop("guardian_relation", None)

            ensure_optional_studio_record(
                self.supabase,
                "programs",
                mapped.get("program_id"),
                studio_id,
                "Program not found",
            )
            mapped["studio_id"] = studio_id
            mapped = self._prepare_student_write(mapped, set_default_is_minor=True)
            try:
                s_result = self.supabase.table("students").insert(mapped).execute()
                if not s_result.data:
                    raise RuntimeError("Failed to create student")

                student_id = s_result.data[0]["id"]
                imported += 1

                # If guardian info present, create guardian record
                if guardian_name:
                    parts = guardian_name.split(" ", 1)
                    g_first = parts[0]
                    g_last = parts[1] if len(parts) > 1 else ""
                    g_result = self.supabase.table("guardians").insert({
                        "studio_id": studio_id,
                        "first_name": g_first,
                        "last_name": g_last,
                        "email": guardian_email,
                        "phone": guardian_phone,
                        "relation": guardian_relation,
                        "is_primary_contact": True,
                    }).execute()
                    if g_result.data:
                        self.supabase.table("student_guardians").insert({
                            "student_id": student_id,
                            "guardian_id": g_result.data[0]["id"],
                        }).execute()
            except Exception as exc:
                validation.errors.append(CsvImportRow(
                    row_number=i,
                    data={**mapped, **({} if not guardian_name else {
                        "guardian_name": guardian_name,
                        "guardian_email": guardian_email,
                        "guardian_phone": guardian_phone,
                        "guardian_relation": guardian_relation,
                    })},
                    errors=[str(exc) or "Failed to import this row"],
                    is_valid=False,
                ))

        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "students.imported",
            "entity_type": "student",
            "entity_id": None,
            "metadata": {"imported": imported, "total": len(rows)},
        }).execute()

        validation.error_rows = len(validation.errors)
        validation.imported_count = imported
        return validation
