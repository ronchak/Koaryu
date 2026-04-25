import csv
import hashlib
import io
import json
import re
import uuid
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Optional
from supabase import Client
from fastapi import HTTPException, status
from postgrest.exceptions import APIError as PostgrestAPIError
from app.schemas.student import (
    StudentCreate, StudentUpdate, StudentResponse, StudentListResponse,
    GuardianCreate, GuardianResponse, CsvImportActionOptions, CsvImportIssue,
    CsvImportOptions, CsvImportResult, CsvImportRow, CsvImportSetupIssue,
    CsvImportWarning,
    BulkTagUpdate, BulkStatusUpdate,
    StudentProgramMembershipCreate, StudentProgramMembershipResponse,
    StudentProgramMembershipUpdate,
)
from app.services.program_service import ProgramService
from app.services.studio_scope import ensure_optional_studio_record

VALID_STATUSES = {"active", "trialing", "inactive", "paused", "canceled"}
STATUS_ALIASES = {
    "overdue": "paused",
}
BELT_COLOR_PRESETS = {
    "white": "#F5F5F5",
    "yellow": "#FACC15",
    "gold": "#EAB308",
    "orange": "#F97316",
    "green": "#22C55E",
    "blue": "#3B82F6",
    "purple": "#A855F7",
    "brown": "#92400E",
    "red": "#EF4444",
    "black": "#111827",
    "gray": "#6B7280",
    "grey": "#6B7280",
}
BELT_IMPORT_ORDER = [
    "white",
    "yellow",
    "gold",
    "orange",
    "green",
    "blue",
    "purple",
    "brown",
    "red",
    "black",
    "gray",
    "grey",
]
COMMON_IMPORT_DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%m-%d-%Y",
    "%m-%d-%y",
)
IMPORT_RUN_OPERATION = "students_csv_execute"
IMPORT_RUN_STALE_AFTER_SECONDS = 45

def _normalize_header(h: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", h.strip().lower()).strip()


def _compact_header(h: str) -> str:
    return _normalize_header(h).replace(" ", "")


RAW_CSV_FIELD_ALIASES: dict[str, str] = {
    "first name": "legal_first_name",
    "first_names": "legal_first_name",
    "student first name": "legal_first_name",
    "given name": "legal_first_name",
    "forename": "legal_first_name",
    "last name": "legal_last_name",
    "last_names": "legal_last_name",
    "student last name": "legal_last_name",
    "surname": "legal_last_name",
    "family name": "legal_last_name",
    "preferred name": "preferred_name",
    "preferred first name": "preferred_name",
    "nickname": "preferred_name",
    "nick name": "preferred_name",
    "dob": "date_of_birth",
    "date of birth": "date_of_birth",
    "birth date": "date_of_birth",
    "birthdate": "date_of_birth",
    "birthday": "date_of_birth",
    "student birthday": "date_of_birth",
    "email": "email",
    "email address": "email",
    "student email": "email",
    "phone": "phone",
    "phone number": "phone",
    "mobile": "phone",
    "mobile number": "phone",
    "cell": "phone",
    "cell phone": "phone",
    "cellphone": "phone",
    "telephone": "phone",
    "status": "status",
    "student status": "status",
    "notes": "notes",
    "note": "notes",
    "tags": "tags",
    "tag": "tags",
    "labels": "tags",
    "program": "program_id",
    "program name": "program_id",
    "student program": "program_id",
    "membership program": "program_id",
    "current belt": "current_belt_rank_id",
    "current belt rank": "current_belt_rank_id",
    "current rank": "current_belt_rank_id",
    "belt rank": "current_belt_rank_id",
    "guardian name": "guardian_name",
    "guardian full name": "guardian_name",
    "parent name": "guardian_name",
    "parent full name": "guardian_name",
    "parent guardian name": "guardian_name",
    "guardian email": "guardian_email",
    "parent email": "guardian_email",
    "guardian phone": "guardian_phone",
    "guardian phone number": "guardian_phone",
    "guardian mobile": "guardian_phone",
    "parent phone": "guardian_phone",
    "parent phone number": "guardian_phone",
    "parent mobile": "guardian_phone",
    "relation": "guardian_relation",
    "guardian relation": "guardian_relation",
    "guardian relationship": "guardian_relation",
    "parent relation": "guardian_relation",
    "parent relationship": "guardian_relation",
    "membership start date": "membership_start_date",
    "membership date": "membership_start_date",
    "enrollment date": "membership_start_date",
    "enrolment date": "membership_start_date",
    "start date": "membership_start_date",
    "join date": "membership_start_date",
    "joined on": "membership_start_date",
    "member since": "membership_start_date",
    "address": "address_line1",
    "address line 1": "address_line1",
    "street address": "address_line1",
    "city": "address_city",
    "state": "address_state",
    "province": "address_state",
    "zip": "address_zip",
    "zip code": "address_zip",
    "postal code": "address_zip",
    "emergency contact name": "emergency_contact_name",
    "emergency name": "emergency_contact_name",
    "emergency contact phone": "emergency_contact_phone",
    "emergency phone": "emergency_contact_phone",
    "emergency contact relation": "emergency_contact_relation",
    "emergency relation": "emergency_contact_relation",
}

CSV_FIELD_ALIASES: dict[str, str] = {
    _normalize_header(alias): field for alias, field in RAW_CSV_FIELD_ALIASES.items()
}
COMPACT_CSV_FIELD_ALIASES: dict[str, str] = {
    _compact_header(alias): field for alias, field in RAW_CSV_FIELD_ALIASES.items()
}


def _infer_csv_field_from_tokens(tokens: set[str]) -> str:
    if not tokens:
        return ""

    if "hold" in tokens:
        return ""

    if "guardian" in tokens or "parent" in tokens:
        if {"email", "mail"} & tokens:
            return "guardian_email"
        if {"phone", "mobile", "cell", "telephone", "tel"} & tokens:
            return "guardian_phone"
        if {"relation", "relationship"} & tokens:
            return "guardian_relation"
        if {"name", "contact"} & tokens:
            return "guardian_name"

    if "emergency" in tokens:
        if {"phone", "mobile", "cell", "telephone", "tel"} & tokens:
            return "emergency_contact_phone"
        if {"relation", "relationship"} & tokens:
            return "emergency_contact_relation"
        if {"name", "contact"} & tokens:
            return "emergency_contact_name"

    if "dob" in tokens or "birthday" in tokens or {"birth", "date"} <= tokens:
        return "date_of_birth"

    if {"first", "name"} <= tokens or {"given", "name"} <= tokens or "forename" in tokens:
        return "legal_first_name"

    if {"last", "name"} <= tokens or {"family", "name"} <= tokens or "surname" in tokens:
        return "legal_last_name"

    if {"preferred", "name"} <= tokens or "nickname" in tokens or {"nick", "name"} <= tokens:
        return "preferred_name"

    if {"membership", "start", "date"} <= tokens or {"membership", "date"} <= tokens:
        return "membership_start_date"
    if {"enrollment", "date"} <= tokens or {"enrolment", "date"} <= tokens:
        return "membership_start_date"
    if {"join", "date"} <= tokens or {"member", "since"} <= tokens:
        return "membership_start_date"
    if "start" in tokens and "date" in tokens and "class" not in tokens and "belt" not in tokens:
        return "membership_start_date"

    if "program" in tokens or "track" in tokens:
        return "program_id"

    if "order" in tokens and ("belt" in tokens or "rank" in tokens):
        return ""

    if "belt" in tokens and ("current" in tokens or "rank" in tokens):
        return "current_belt_rank_id"

    if {"email", "mail"} & tokens:
        return "email"

    if {"phone", "mobile", "cell", "telephone", "tel"} & tokens:
        return "phone"

    if "status" in tokens:
        return "status"

    if "notes" in tokens or "note" in tokens:
        return "notes"

    if "tags" in tokens or "tag" in tokens or "labels" in tokens:
        return "tags"

    if "address" in tokens:
        return "address_line1"

    if "city" in tokens:
        return "address_city"

    if "state" in tokens or "province" in tokens:
        return "address_state"

    if "zip" in tokens or ("postal" in tokens and "code" in tokens):
        return "address_zip"

    return ""


def _auto_map_csv_header(header: str) -> str:
    normalized = _normalize_header(header)
    if not normalized:
        return ""

    alias_match = CSV_FIELD_ALIASES.get(normalized)
    if alias_match:
        return alias_match

    compact_match = COMPACT_CSV_FIELD_ALIASES.get(_compact_header(header))
    if compact_match:
        return compact_match

    return _infer_csv_field_from_tokens(set(normalized.split()))


def _make_import_issue(
    code: str,
    message: str,
    *,
    severity: str = "error",
    field: Optional[str] = None,
    value: Optional[str] = None,
    suggested_action: Optional[str] = None,
) -> CsvImportIssue:
    return CsvImportIssue(
        code=code,
        severity=severity,
        field=field,
        value=value,
        message=message,
        suggested_action=suggested_action,
    )


def _infer_belt_color_hex(name: str) -> str:
    tokens = set(_normalize_header(name).split())
    for token, color_hex in BELT_COLOR_PRESETS.items():
        if token in tokens:
            return color_hex
    return "#FFFFFF"


def _belt_import_sort_key(name: str) -> tuple[int, str]:
    tokens = set(_normalize_header(name).split())
    for index, token in enumerate(BELT_IMPORT_ORDER):
        if token in tokens:
            return (index, name.lower())
    return (len(BELT_IMPORT_ORDER), name.lower())


def _format_program_label(raw_program_value: Optional[str]) -> str:
    if not raw_program_value:
        return "this program"
    value = raw_program_value.strip()
    if not value:
        return "this program"
    try:
        uuid.UUID(value)
    except ValueError:
        return value
    return "this program"


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

    def _guardian_row_to_response(self, guardian_row: dict) -> GuardianResponse:
        return GuardianResponse(**{
            "id": guardian_row["id"],
            "first_name": guardian_row["first_name"],
            "last_name": guardian_row["last_name"],
            "email": guardian_row.get("email"),
            "phone": guardian_row.get("phone"),
            "relation": guardian_row.get("relation"),
            "is_primary_contact": guardian_row.get("is_primary_contact", False),
        })

    def _guardian_from_link_row(self, row: dict) -> Optional[GuardianResponse]:
        if not isinstance(row, dict):
            return None
        guardian = row.get("guardians") or {}
        if not guardian:
            return None
        return self._guardian_row_to_response(guardian)

    def _fetch_guardians_for_students(
        self,
        student_ids: list[str],
    ) -> dict[str, list[GuardianResponse]]:
        ordered_student_ids = list(dict.fromkeys(student_ids))
        guardians_by_student_id: dict[str, list[GuardianResponse]] = {
            student_id: []
            for student_id in ordered_student_ids
        }
        if not ordered_student_ids:
            return guardians_by_student_id

        result = (
            self.supabase.table("student_guardians")
            .select("student_id, guardian_id, guardians(*)")
            .in_("student_id", ordered_student_ids)
            .execute()
        )
        for row in result.data or []:
            student_id = row.get("student_id")
            if student_id not in guardians_by_student_id:
                continue
            guardian = self._guardian_from_link_row(row)
            if guardian:
                guardians_by_student_id[student_id].append(guardian)

        return guardians_by_student_id

    def _fetch_guardians_for_student(self, student_id: str) -> list[GuardianResponse]:
        return self._fetch_guardians_for_students([student_id]).get(student_id, [])

    def _membership_row_to_response(self, row: dict) -> StudentProgramMembershipResponse:
        program = row.get("programs") or {}
        rank = row.get("belt_ranks") or {}
        if isinstance(program, list):
            program = program[0] if program else {}
        if isinstance(rank, list):
            rank = rank[0] if rank else {}
        return StudentProgramMembershipResponse(
            id=row["id"],
            studio_id=row["studio_id"],
            student_id=row["student_id"],
            program_id=row["program_id"],
            program_name=program.get("name"),
            program_color_hex=program.get("color_hex"),
            status=row.get("status") or "active",
            started_at=row.get("started_at"),
            ended_at=row.get("ended_at"),
            current_belt_rank_id=row.get("current_belt_rank_id"),
            current_belt_rank_name=rank.get("name"),
            current_belt_rank_color=rank.get("color_hex"),
            created_at=row["created_at"],
            updated_at=row.get("updated_at") or row["created_at"],
        )

    def _fetch_memberships_for_students(
        self,
        student_ids: list[str],
    ) -> dict[str, list[StudentProgramMembershipResponse]]:
        ordered_student_ids = list(dict.fromkeys(student_ids))
        memberships_by_student_id: dict[str, list[StudentProgramMembershipResponse]] = {
            student_id: []
            for student_id in ordered_student_ids
        }
        if not ordered_student_ids:
            return memberships_by_student_id

        try:
            result = (
                self.supabase.table("student_program_memberships")
                .select("*, programs(name, color_hex), belt_ranks(name, color_hex)")
                .in_("student_id", ordered_student_ids)
                .order("created_at")
                .execute()
            )
        except PostgrestAPIError as exc:
            if not self._is_optional_membership_schema_error(exc):
                raise
            return memberships_by_student_id

        for row in result.data or []:
            student_id = row.get("student_id")
            if student_id not in memberships_by_student_id:
                continue
            memberships_by_student_id[student_id].append(self._membership_row_to_response(row))

        return memberships_by_student_id

    def _fetch_memberships_for_student(self, student_id: str) -> list[StudentProgramMembershipResponse]:
        return self._fetch_memberships_for_students([student_id]).get(student_id, [])

    def _embedded_guardians_from_row(self, row: dict) -> Optional[list[GuardianResponse]]:
        if "student_guardians" not in row:
            return None

        link_rows = row.get("student_guardians") or []
        if isinstance(link_rows, dict):
            link_rows = [link_rows]

        guardians = []
        for link_row in link_rows:
            guardian = self._guardian_from_link_row(link_row)
            if guardian:
                guardians.append(guardian)
        return guardians

    def _rows_to_responses(self, rows: list[dict]) -> list[StudentResponse]:
        student_ids = [
            row["id"]
            for row in rows
            if row.get("id")
        ]
        guardians_by_student_id = self._fetch_guardians_for_students([
            *student_ids
        ])
        memberships_by_student_id = self._fetch_memberships_for_students(student_ids)
        return [
            self._row_to_response(
                row,
                guardians=guardians_by_student_id.get(row.get("id"), []),
                memberships=memberships_by_student_id.get(row.get("id"), []),
            )
            for row in rows
        ]

    def _row_to_response(
        self,
        row: dict,
        guardians: Optional[list[GuardianResponse]] = None,
        memberships: Optional[list[StudentProgramMembershipResponse]] = None,
    ) -> StudentResponse:
        if guardians is None:
            guardians = self._embedded_guardians_from_row(row)
        if guardians is None:
            guardians = self._fetch_guardians_for_student(row["id"])
        if memberships is None:
            memberships = self._fetch_memberships_for_student(row["id"])

        normalized_row = {
            **{
                k: v
                for k, v in row.items()
                if k not in ("deleted_at", "student_guardians")
            },
            "tags": row.get("tags") or [],
        }
        return StudentResponse(
            **normalized_row,
            guardians=guardians,
            program_memberships=memberships,
        )

    def _rank_program_id(self, rank_id: Optional[str], studio_id: str) -> Optional[str]:
        if not rank_id:
            return None
        result = (
            self.supabase.table("belt_ranks")
            .select("id, belt_ladders!inner(program_id, studio_id)")
            .eq("id", rank_id)
            .eq("studio_id", studio_id)
            .maybe_single()
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Current belt rank not found")
        ladder = result.data.get("belt_ladders") or {}
        if isinstance(ladder, list):
            ladder = ladder[0] if ladder else {}
        return ladder.get("program_id")

    def _normalize_program_ids_for_write(
        self,
        studio_id: str,
        program_id: Optional[str],
        program_ids: Optional[list[str]],
    ) -> list[str]:
        values: list[str] = []
        if program_ids is not None:
            values.extend(program_ids)
        elif program_id:
            values.append(program_id)

        normalized = []
        seen: set[str] = set()
        for value in values:
            if value and value not in seen:
                ProgramService(self.supabase).ensure_program_active(studio_id, value)
                normalized.append(value)
                seen.add(value)

        if not normalized:
            normalized.append(ProgramService(self.supabase).get_unassigned_program_id(studio_id))

        return normalized

    def _membership_write_payload(self, payload: dict) -> dict:
        next_payload = dict(payload)
        for key in ("started_at", "ended_at"):
            if next_payload.get(key):
                next_payload[key] = str(next_payload[key])
        return next_payload

    def _is_optional_membership_schema_error(self, exc: PostgrestAPIError) -> bool:
        return exc.code in {"42P01", "42703", "PGRST204", "PGRST205"}

    def _ensure_student_exists(self, student_id: str, studio_id: str) -> None:
        result = (
            self.supabase.table("students")
            .select("id")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .limit(1)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student not found")

    def _sync_legacy_program_fields(
        self,
        student_id: str,
        studio_id: str,
        program_ids: list[str],
        current_belt_rank_id: Optional[str] = None,
    ) -> None:
        update_payload = {"program_id": program_ids[0] if program_ids else None}
        if current_belt_rank_id is not None:
            update_payload["current_belt_rank_id"] = current_belt_rank_id
        (
            self.supabase.table("students")
            .update(update_payload)
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )

    def _replace_active_program_memberships(
        self,
        student_id: str,
        studio_id: str,
        program_ids: list[str],
        *,
        current_belt_rank_id: Optional[str] = None,
        started_at: Optional[str] = None,
    ) -> None:
        try:
            existing = (
                self.supabase.table("student_program_memberships")
                .select("id, program_id, status, ended_at")
                .eq("student_id", student_id)
                .eq("studio_id", studio_id)
                .is_("ended_at", "null")
                .execute()
            )
            existing_by_program = {
                row["program_id"]: row
                for row in existing.data or []
                if row.get("program_id")
            }
            desired = set(program_ids)
            now = datetime.now(timezone.utc).date().isoformat()

            for program_id, row in existing_by_program.items():
                if program_id not in desired:
                    (
                        self.supabase.table("student_program_memberships")
                        .update({"status": "ended", "ended_at": now, "current_belt_rank_id": None})
                        .eq("id", row["id"])
                        .eq("studio_id", studio_id)
                        .execute()
                    )

            rank_program_id = self._rank_program_id(current_belt_rank_id, studio_id) if current_belt_rank_id else None
            membership_rows = []
            for program_id in program_ids:
                rank_for_membership = (
                    current_belt_rank_id
                    if current_belt_rank_id and (rank_program_id in {None, program_id})
                    else None
                )
                row = existing_by_program.get(program_id)
                if row:
                    update_payload = {
                        "status": "active",
                        "ended_at": None,
                        "current_belt_rank_id": rank_for_membership,
                    }
                    if started_at:
                        update_payload["started_at"] = started_at
                    (
                        self.supabase.table("student_program_memberships")
                        .update(update_payload)
                        .eq("id", row["id"])
                        .eq("studio_id", studio_id)
                        .execute()
                    )
                    continue

                membership_rows.append({
                    "studio_id": studio_id,
                    "student_id": student_id,
                    "program_id": program_id,
                    "status": "active",
                    "started_at": started_at,
                    "current_belt_rank_id": rank_for_membership,
                })

            if membership_rows:
                self.supabase.table("student_program_memberships").insert(membership_rows).execute()
        except PostgrestAPIError as exc:
            if not self._is_optional_membership_schema_error(exc):
                raise

        self._sync_legacy_program_fields(student_id, studio_id, program_ids, current_belt_rank_id)

    def _parse_import_date(
        self,
        raw_value: Optional[str],
        field_label: str,
    ) -> tuple[Optional[str], Optional[str]]:
        if raw_value is None:
            return None, None

        value = raw_value.strip()
        if not value:
            return None, None

        candidates = [value]
        if "T" in value:
            candidates.append(value.split("T", 1)[0])
        if " " in value:
            candidates.append(value.split(" ", 1)[0])

        for candidate in candidates:
            try:
                return date.fromisoformat(candidate).isoformat(), None
            except ValueError:
                pass

            for fmt in COMMON_IMPORT_DATE_FORMATS:
                try:
                    return datetime.strptime(candidate, fmt).date().isoformat(), None
                except ValueError:
                    continue

        return None, f"Invalid {field_label}: '{raw_value}'"

    def _build_named_record_lookup(
        self,
        table_name: str,
        studio_id: str,
    ) -> tuple[set[str], dict[str, str], set[str]]:
        result = (
            self.supabase.table(table_name)
            .select("id, name")
            .eq("studio_id", studio_id)
            .execute()
        )

        id_lookup: set[str] = set()
        name_lookup: dict[str, str] = {}
        ambiguous_names: set[str] = set()

        for row in result.data or []:
            record_id = row.get("id")
            record_name = row.get("name")
            if not record_id or not record_name:
                continue

            id_lookup.add(record_id)
            normalized_name = _normalize_header(record_name)
            if not normalized_name:
                continue

            if normalized_name in name_lookup and name_lookup[normalized_name] != record_id:
                ambiguous_names.add(normalized_name)
                name_lookup.pop(normalized_name, None)
                continue

            if normalized_name not in ambiguous_names:
                name_lookup[normalized_name] = record_id

        return id_lookup, name_lookup, ambiguous_names

    def _build_belt_rank_lookup(self, studio_id: str) -> dict[str, Any]:
        ladders_result = (
            self.supabase.table("belt_ladders")
            .select("id, name, program_id")
            .eq("studio_id", studio_id)
            .execute()
        )
        ladder_meta = {
            row["id"]: {
                "name": row.get("name"),
                "program_id": row.get("program_id"),
            }
            for row in (ladders_result.data or [])
            if row.get("id")
        }
        ladders_by_program: dict[str, list[str]] = defaultdict(list)
        unscoped_ladder_ids: list[str] = []
        for ladder_id, ladder in ladder_meta.items():
            program_id = ladder.get("program_id")
            if program_id:
                ladders_by_program[program_id].append(ladder_id)
            else:
                unscoped_ladder_ids.append(ladder_id)

        result = (
            self.supabase.table("belt_ranks")
            .select("id, name, ladder_id")
            .eq("studio_id", studio_id)
            .execute()
        )

        id_lookup: set[str] = set()
        name_lookup: dict[str, str] = {}
        ambiguous_names: set[str] = set()
        rank_meta: dict[str, dict[str, Optional[str]]] = {}
        rank_ids_by_name: dict[str, list[str]] = defaultdict(list)
        program_rank_name_lookup: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        unscoped_rank_name_lookup: dict[str, list[str]] = defaultdict(list)

        for row in result.data or []:
            record_id = row.get("id")
            record_name = row.get("name")
            ladder_id = row.get("ladder_id")
            if not record_id or not record_name:
                continue

            id_lookup.add(record_id)
            normalized_name = _normalize_header(record_name)
            if normalized_name:
                rank_ids_by_name[normalized_name].append(record_id)
                if normalized_name in name_lookup and name_lookup[normalized_name] != record_id:
                    ambiguous_names.add(normalized_name)
                    name_lookup.pop(normalized_name, None)
                elif normalized_name not in ambiguous_names:
                    name_lookup[normalized_name] = record_id

            ladder = ladder_meta.get(ladder_id, {})
            program_id = ladder.get("program_id")
            if normalized_name and program_id:
                program_rank_name_lookup[program_id][normalized_name].append(record_id)
            elif normalized_name and not program_id:
                unscoped_rank_name_lookup[normalized_name].append(record_id)
            rank_meta[record_id] = {
                "ladder_id": ladder_id,
                "ladder_name": ladder.get("name"),
                "program_id": program_id,
            }

        return {
            "id_lookup": id_lookup,
            "name_lookup": name_lookup,
            "ambiguous_names": ambiguous_names,
            "name_to_rank_ids": {
                normalized_name: list(rank_ids)
                for normalized_name, rank_ids in rank_ids_by_name.items()
            },
            "program_rank_name_lookup": {
                program_id: {
                    normalized_name: list(rank_ids)
                    for normalized_name, rank_ids in name_map.items()
                }
                for program_id, name_map in program_rank_name_lookup.items()
            },
            "unscoped_rank_name_lookup": {
                normalized_name: list(rank_ids)
                for normalized_name, rank_ids in unscoped_rank_name_lookup.items()
            },
            "rank_meta": rank_meta,
            "ladder_meta": ladder_meta,
            "ladders_by_program": dict(ladders_by_program),
            "unscoped_ladder_ids": unscoped_ladder_ids,
            "sole_ladder_id": next(iter(ladder_meta)) if len(ladder_meta) == 1 else None,
            "ladder_count": len(ladder_meta),
            "rank_count": len(rank_meta),
        }

    def _resolve_belt_rank_reference(
        self,
        raw_value: Optional[str],
        *,
        resolved_program_id: Optional[str],
        raw_program_value: Optional[str],
        belt_rank_lookup: dict[str, Any],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        if raw_value is None:
            return None, None, None

        value = raw_value.strip()
        if not value:
            return None, None, None

        program_label = _format_program_label(raw_program_value)
        if raw_program_value and not resolved_program_id:
            return None, "missing", (
                f"Current belt '{raw_value}' could not be matched until {program_label} is set up in this studio."
            )

        try:
            parsed_uuid = str(uuid.UUID(value))
        except ValueError:
            parsed_uuid = None

        if parsed_uuid:
            if parsed_uuid not in belt_rank_lookup["id_lookup"]:
                return None, "missing", f"Current belt '{raw_value}' was not found in this studio"

            if resolved_program_id:
                belt_meta = belt_rank_lookup["rank_meta"].get(parsed_uuid) or {}
                belt_program_id = belt_meta.get("program_id")
                sole_ladder_id = belt_rank_lookup.get("sole_ladder_id")
                belt_ladder_id = belt_meta.get("ladder_id")
                if belt_program_id == resolved_program_id:
                    return parsed_uuid, None, None
                if belt_program_id is None and sole_ladder_id and belt_ladder_id == sole_ladder_id:
                    return parsed_uuid, None, None
                if belt_program_id != resolved_program_id:
                    return None, "missing", (
                        f"Current belt '{raw_value}' does not belong to the ladder for {program_label}."
                    )
            return parsed_uuid, None, None

        normalized_name = _normalize_header(value)
        if not normalized_name:
            return None, None, None

        if resolved_program_id:
            program_rank_ids = (
                belt_rank_lookup.get("program_rank_name_lookup", {})
                .get(resolved_program_id, {})
                .get(normalized_name, [])
            )
            if len(program_rank_ids) == 1:
                return program_rank_ids[0], None, None
            if len(program_rank_ids) > 1:
                return None, "ambiguous", (
                    f"Current belt '{raw_value}' matches multiple belt ranks in the ladder for {program_label}."
                )

            program_ladders = belt_rank_lookup.get("ladders_by_program", {}).get(resolved_program_id, [])
            if not program_ladders:
                sole_ladder_id = belt_rank_lookup.get("sole_ladder_id")
                unscoped_ladder_ids = belt_rank_lookup.get("unscoped_ladder_ids", [])
                if sole_ladder_id and len(unscoped_ladder_ids) == 1 and unscoped_ladder_ids[0] == sole_ladder_id:
                    unscoped_rank_ids = belt_rank_lookup.get("unscoped_rank_name_lookup", {}).get(normalized_name, [])
                    if len(unscoped_rank_ids) == 1:
                        return unscoped_rank_ids[0], None, None
                    if len(unscoped_rank_ids) > 1:
                        return None, "ambiguous", (
                            f"Current belt '{raw_value}' matches multiple belt ranks in the default ladder for {program_label}."
                        )
                if not program_ladders:
                    return None, "missing", (
                        f"Current belt '{raw_value}' was not found because {program_label} does not have a belt ladder yet."
                    )

            return None, "missing", (
                f"Current belt '{raw_value}' was not found in the belt ladder for {program_label}."
            )

        global_rank_ids = belt_rank_lookup.get("name_to_rank_ids", {}).get(normalized_name, [])
        if len(global_rank_ids) > 1:
            return None, "ambiguous", f"Current belt '{raw_value}' matches multiple belt ranks in this studio"
        if len(global_rank_ids) == 1:
            return global_rank_ids[0], None, None

        return None, "missing", f"Current belt '{raw_value}' was not found in this studio"

    def _classify_belt_creation_target(
        self,
        *,
        resolved_program_id: Optional[str],
        pending_program_name: Optional[str],
        raw_program_value: Optional[str],
        options: CsvImportOptions,
        belt_rank_lookup: dict[str, Any],
    ) -> dict[str, Any]:
        if resolved_program_id:
            ladders = belt_rank_lookup.get("ladders_by_program", {}).get(resolved_program_id, [])
            if len(ladders) == 1:
                ladder_id = ladders[0]
                ladder_name = (
                    (belt_rank_lookup.get("ladder_meta", {}).get(ladder_id) or {}).get("name")
                    or "the matching ladder"
                )
                return {
                    "mode": "existing_ladder",
                    "ladder_id": ladder_id,
                    "ladder_name": ladder_name,
                    "program_label": _format_program_label(raw_program_value),
                }
            if len(ladders) == 0:
                return {
                    "mode": "create_program_ladder",
                    "program_label": _format_program_label(raw_program_value),
                }
            return {
                "mode": "ambiguous_program_ladder",
                "program_label": _format_program_label(raw_program_value),
            }

        if pending_program_name and options.create_missing_programs:
            return {
                "mode": "create_program_and_ladder",
                "program_label": pending_program_name.strip(),
            }

        if raw_program_value:
            return {
                "mode": "program_missing",
                "program_label": _format_program_label(raw_program_value),
            }

        return {
            "mode": "program_required",
            "program_label": "this row",
        }

    def _resolve_named_import_reference(
        self,
        raw_value: Optional[str],
        *,
        label: str,
        id_lookup: set[str],
        name_lookup: dict[str, str],
        ambiguous_names: set[str],
    ) -> tuple[Optional[str], Optional[str], Optional[str]]:
        if raw_value is None:
            return None, None, None

        value = raw_value.strip()
        if not value:
            return None, None, None

        try:
            parsed_uuid = str(uuid.UUID(value))
        except ValueError:
            parsed_uuid = None

        if parsed_uuid:
            if parsed_uuid in id_lookup:
                return parsed_uuid, None, None
            return None, "missing", f"{label} '{raw_value}' was not found in this studio"

        normalized_name = _normalize_header(value)
        if normalized_name in ambiguous_names:
            return None, "ambiguous", f"{label} '{raw_value}' matches multiple records in this studio"

        resolved_id = name_lookup.get(normalized_name)
        if resolved_id:
            return resolved_id, None, None

        return None, "missing", f"{label} '{raw_value}' was not found in this studio"

    def _append_import_note(self, existing: Optional[str], note: str) -> str:
        base = (existing or "").strip()
        if not base:
            return note
        if note in base:
            return base
        return f"{base}\n{note}"

    def _normalize_import_status(
        self,
        raw_value: Optional[str],
        options: CsvImportOptions,
        issues: list[CsvImportIssue],
    ) -> Optional[str]:
        if raw_value is None:
            return None

        value = raw_value.strip().lower()
        if not value:
            return None

        if options.status_alias_mode == "normalize" and value in STATUS_ALIASES:
            normalized = STATUS_ALIASES[value]
            issues.append(_make_import_issue(
                "normalized_status",
                f"Status '{raw_value}' will be imported as '{normalized}'.",
                severity="warning",
                field="status",
                value=raw_value,
            ))
            return normalized

        if value not in VALID_STATUSES:
            issues.append(_make_import_issue(
                "invalid_status",
                f"Invalid status '{value}'. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
                field="status",
                value=raw_value,
            ))
            return value

        return value

    def _build_import_row_plan(
        self,
        raw_row: dict,
        mapping: dict[str, str],
        *,
        options: CsvImportOptions,
        program_lookup: Optional[tuple[set[str], dict[str, str], set[str]]] = None,
        belt_rank_lookup: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        mapped: dict = {}
        row_issues: list[CsvImportIssue] = []
        plan: dict[str, Any] = {
            "data": mapped,
            "issues": row_issues,
            "pending_program_name": None,
            "pending_belt_name": None,
            "belt_creation_target_ladder_id": None,
            "belt_creation_requires_new_ladder": False,
            "resolved_program_id": None,
            "resolved_belt_rank_id": None,
            "unresolved_belt_value": None,
        }

        for csv_col, koaryu_field in mapping.items():
            if not koaryu_field:
                continue

            raw_value = raw_row.get(csv_col, "")
            value = raw_value.strip() if isinstance(raw_value, str) else raw_value
            if value in ("", None):
                continue
            mapped[koaryu_field] = value

        if not mapped.get("legal_first_name"):
            row_issues.append(_make_import_issue(
                "missing_first_name",
                "Missing required field: first name",
                field="legal_first_name",
            ))
        if not mapped.get("legal_last_name"):
            row_issues.append(_make_import_issue(
                "missing_last_name",
                "Missing required field: last name",
                field="legal_last_name",
            ))

        if mapped.get("status") and isinstance(mapped["status"], str):
            mapped["status"] = self._normalize_import_status(mapped["status"], options, row_issues)

        if "tags" in mapped and isinstance(mapped["tags"], str):
            mapped["tags"] = [t.strip() for t in mapped["tags"].split(",") if t.strip()]

        for field_name, field_label in (
            ("date_of_birth", "date of birth"),
            ("membership_start_date", "membership start date"),
        ):
            if field_name not in mapped:
                continue
            parsed_date, date_error = self._parse_import_date(mapped.get(field_name), field_label)
            if date_error:
                row_issues.append(_make_import_issue(
                    f"invalid_{field_name}",
                    date_error,
                    field=field_name,
                    value=mapped.get(field_name),
                ))
            elif parsed_date:
                mapped[field_name] = parsed_date

        raw_program = mapped.get("program_id") if isinstance(mapped.get("program_id"), str) else None
        if program_lookup and mapped.get("program_id"):
            program_id, program_error_code, program_error = self._resolve_named_import_reference(
                mapped.get("program_id"),
                label="Program",
                id_lookup=program_lookup[0],
                name_lookup=program_lookup[1],
                ambiguous_names=program_lookup[2],
            )
            if program_error_code == "ambiguous":
                row_issues.append(_make_import_issue(
                    "ambiguous_program",
                    program_error or "Program matches multiple records in this studio",
                    field="program_id",
                    value=raw_program,
                    suggested_action="Choose the correct Program column value or clean up duplicate programs in this studio.",
                ))
            elif program_error_code == "missing":
                if options.create_missing_programs:
                    plan["pending_program_name"] = raw_program
                    row_issues.append(_make_import_issue(
                        "missing_program",
                        f"Program '{raw_program}' will be created during import.",
                        severity="warning",
                        field="program_id",
                        value=raw_program,
                    ))
                else:
                    row_issues.append(_make_import_issue(
                        "missing_program",
                        program_error or f"Program '{raw_program}' was not found in this studio",
                        field="program_id",
                        value=raw_program,
                        suggested_action="Turn on 'Create missing programs' or remove the Program mapping.",
                    ))
            elif program_id:
                plan["resolved_program_id"] = program_id

        if belt_rank_lookup and mapped.get("current_belt_rank_id"):
            raw_belt = mapped.get("current_belt_rank_id")
            belt_rank_id, belt_rank_error_code, belt_rank_error = self._resolve_belt_rank_reference(
                mapped.get("current_belt_rank_id"),
                resolved_program_id=plan.get("resolved_program_id"),
                raw_program_value=raw_program,
                belt_rank_lookup=belt_rank_lookup,
            )
            if belt_rank_error_code == "ambiguous":
                row_issues.append(_make_import_issue(
                    "ambiguous_belt",
                    belt_rank_error or "Current belt matches multiple belt ranks in this studio",
                    field="current_belt_rank_id",
                    value=raw_belt,
                    suggested_action="Set up clearer belt ladders or remove the Current Belt mapping for this import.",
                ))
            elif belt_rank_error_code == "missing":
                plan["unresolved_belt_value"] = raw_belt
                belt_creation_target = self._classify_belt_creation_target(
                    resolved_program_id=plan.get("resolved_program_id"),
                    pending_program_name=plan.get("pending_program_name"),
                    raw_program_value=raw_program,
                    options=options,
                    belt_rank_lookup=belt_rank_lookup,
                )
                target_mode = belt_creation_target["mode"]
                plan["belt_creation_target_ladder_id"] = belt_creation_target.get("ladder_id")
                plan["belt_creation_requires_new_ladder"] = target_mode in {
                    "create_program_ladder",
                    "create_program_and_ladder",
                }
                no_ladder_setup = belt_rank_lookup["ladder_count"] == 0
                issue_code = (
                    "missing_belt_ladder"
                    if no_ladder_setup or target_mode in {"create_program_ladder", "create_program_and_ladder"}
                    else "missing_belt"
                )
                issue_message = (
                    f"Current belt '{raw_belt}' could not be matched because this studio does not have a belt ladder set up yet."
                    if no_ladder_setup
                    else belt_rank_error or f"Current belt '{raw_belt}' was not found in this studio"
                )
                if options.create_missing_belts and target_mode == "existing_ladder":
                    plan["pending_belt_name"] = str(raw_belt).strip()
                    row_issues.append(_make_import_issue(
                        "missing_belt",
                        f"Current belt '{raw_belt}' will be created in '{belt_creation_target['ladder_name']}' during import.",
                        severity="warning",
                        field="current_belt_rank_id",
                        value=raw_belt,
                    ))
                elif options.create_missing_belts and target_mode in {"create_program_ladder", "create_program_and_ladder"}:
                    plan["pending_belt_name"] = str(raw_belt).strip()
                    row_issues.append(_make_import_issue(
                        "missing_belt_ladder",
                        f"Current belt '{raw_belt}' will be created in a new ladder for {belt_creation_target['program_label']} during import.",
                        severity="warning",
                        field="current_belt_rank_id",
                        value=raw_belt,
                    ))
                elif target_mode == "ambiguous_program_ladder":
                    row_issues.append(_make_import_issue(
                        "ambiguous_belt_ladder",
                        f"{belt_creation_target['program_label']} has multiple belt ladders, so Koaryu cannot safely auto-create '{raw_belt}'.",
                        field="current_belt_rank_id",
                        value=raw_belt,
                        suggested_action="Choose one ladder for this program in Belt Tracker before importing current belts.",
                    ))
                elif target_mode == "program_required":
                    if options.import_without_unresolved_belt:
                        row_issues.append(_make_import_issue(
                            issue_code,
                            f"{issue_message} Map the Program column if you want Koaryu to create the right ladder and belt automatically. The student can still be imported without a current belt.",
                            severity="warning",
                            field="current_belt_rank_id",
                            value=raw_belt,
                            suggested_action="Map the Program column or set up the ladder manually in Belt Tracker.",
                        ))
                    else:
                        row_issues.append(_make_import_issue(
                            issue_code,
                            f"{issue_message} Map the Program column if you want Koaryu to create the right ladder and belt automatically.",
                            field="current_belt_rank_id",
                            value=raw_belt,
                            suggested_action="Map the Program column or set up the ladder manually in Belt Tracker.",
                        ))
                elif options.import_without_unresolved_belt:
                    row_issues.append(_make_import_issue(
                        issue_code,
                        f"{issue_message} The student can still be imported without a current belt.",
                        severity="warning",
                        field="current_belt_rank_id",
                        value=raw_belt,
                        suggested_action=(
                            "Turn on 'Create missing belts' or set up the belt ladder in Belt Tracker to match these students later."
                            if target_mode in {"existing_ladder", "create_program_ladder", "create_program_and_ladder"}
                            else "Set up the belt ladder in Belt Tracker to match these students later."
                        ),
                    ))
                else:
                    row_issues.append(_make_import_issue(
                        issue_code,
                        (
                            f"No belt ladder is set up for {belt_creation_target['program_label']} yet."
                            if target_mode in {"create_program_ladder", "create_program_and_ladder"}
                            else issue_message
                        ),
                        field="current_belt_rank_id",
                        value=raw_belt,
                        suggested_action=(
                            "Turn on 'Create missing belts' or open Belt Tracker and add the missing belt ladder or belt ranks."
                            if target_mode in {"existing_ladder", "create_program_ladder", "create_program_and_ladder"}
                            else "Open Belt Tracker and add the missing ladder or belt ranks."
                        ),
                    ))
            elif belt_rank_id:
                plan["resolved_belt_rank_id"] = belt_rank_id

        resolved_program_id = plan.get("resolved_program_id")
        resolved_belt_rank_id = plan.get("resolved_belt_rank_id")
        if resolved_program_id and resolved_belt_rank_id and belt_rank_lookup:
            belt_meta = belt_rank_lookup["rank_meta"].get(resolved_belt_rank_id) or {}
            belt_program_id = belt_meta.get("program_id")
            if belt_program_id and belt_program_id != resolved_program_id:
                row_issues.append(_make_import_issue(
                    "belt_program_mismatch",
                    "The selected Program and Current Belt belong to different ladders.",
                    field="current_belt_rank_id",
                    value=mapped.get("current_belt_rank_id"),
                    suggested_action="Verify the Program mapping or remove the Current Belt mapping for this row.",
                ))

        plan["is_valid"] = not any(issue.severity == "error" for issue in row_issues)
        return plan

    def _build_import_result(
        self,
        rows: list[dict[str, Any]],
        *,
        total_rows: int,
    ) -> CsvImportResult:
        issue_rows: list[CsvImportRow] = []
        valid_rows = 0
        error_rows = 0
        normalized_status_rows: list[int] = []
        normalized_status_values: set[str] = set()
        unresolved_belt_rows: list[int] = []
        unresolved_belt_values: set[str] = set()
        setup_buckets: dict[str, dict[str, Any]] = {
            "missing_program": {"row_numbers": [], "values": set(), "severity": "warning"},
            "ambiguous_program": {"row_numbers": [], "values": set(), "severity": "error"},
            "missing_belt_ladder": {"row_numbers": [], "values": set(), "severity": "warning"},
            "missing_belt": {"row_numbers": [], "values": set(), "severity": "warning"},
            "ambiguous_belt": {"row_numbers": [], "values": set(), "severity": "error"},
            "ambiguous_belt_ladder": {"row_numbers": [], "values": set(), "severity": "error"},
        }

        for row in rows:
            if row["is_valid"]:
                valid_rows += 1
            else:
                error_rows += 1

            if row["issues"]:
                error_messages = [
                    issue.message for issue in row["issues"] if issue.severity == "error"
                ]
                warning_messages = [
                    issue.message for issue in row["issues"] if issue.severity == "warning"
                ]
                issue_rows.append(CsvImportRow(
                    row_number=row["row_number"],
                    data=row["data"],
                    issues=row["issues"],
                    errors=error_messages,
                    warnings=warning_messages,
                    is_valid=row["is_valid"],
                ))

            for issue in row["issues"]:
                if issue.code == "normalized_status":
                    normalized_status_rows.append(row["row_number"])
                    if issue.value:
                        normalized_status_values.add(issue.value)
                if (
                    issue.code in {"missing_belt", "missing_belt_ladder"}
                    and row["is_valid"]
                    and not row.get("pending_belt_name")
                ):
                    unresolved_belt_rows.append(row["row_number"])
                    if issue.value:
                        unresolved_belt_values.add(issue.value)
                bucket = setup_buckets.get(issue.code)
                if bucket is not None:
                    bucket["row_numbers"].append(row["row_number"])
                    if issue.value:
                        bucket["values"].add(issue.value)
                    if issue.severity == "error":
                        bucket["severity"] = "error"

        warnings: list[CsvImportWarning] = []
        if normalized_status_rows:
            warnings.append(CsvImportWarning(
                code="normalized_status",
                message="Some student statuses will be normalized during import.",
                row_numbers=normalized_status_rows,
                field="status",
                values=sorted(normalized_status_values),
            ))
        if unresolved_belt_rows:
            warnings.append(CsvImportWarning(
                code="import_without_belt",
                message="Some students will be imported without a current belt until your ladder is configured.",
                row_numbers=unresolved_belt_rows,
                field="current_belt_rank_id",
                values=sorted(unresolved_belt_values),
                suggested_action="Open Belt Tracker after import to finish assigning belts.",
            ))

        setup_issues: list[CsvImportSetupIssue] = []
        can_create_missing_belts = any(
            row.get("unresolved_belt_value")
            and (row.get("belt_creation_target_ladder_id") or row.get("belt_creation_requires_new_ladder"))
            for row in rows
        )
        if setup_buckets["missing_program"]["row_numbers"]:
            severity = setup_buckets["missing_program"]["severity"]
            setup_issues.append(CsvImportSetupIssue(
                code="missing_program",
                severity=severity,
                message=(
                    "This CSV references programs that are not set up in this studio yet."
                    if severity == "error"
                    else "Some programs are missing today and will be created during import."
                ),
                row_numbers=setup_buckets["missing_program"]["row_numbers"],
                values=sorted(setup_buckets["missing_program"]["values"]),
                suggested_action="Create missing programs during import or remove the Program mapping.",
            ))
        if setup_buckets["ambiguous_program"]["row_numbers"]:
            setup_issues.append(CsvImportSetupIssue(
                code="ambiguous_program",
                severity="error",
                message="Some Program values match multiple programs in this studio.",
                row_numbers=setup_buckets["ambiguous_program"]["row_numbers"],
                values=sorted(setup_buckets["ambiguous_program"]["values"]),
                suggested_action="Clean up duplicate programs or remove the Program mapping for those rows.",
            ))
        if setup_buckets["missing_belt_ladder"]["row_numbers"]:
            severity = setup_buckets["missing_belt_ladder"]["severity"]
            if can_create_missing_belts:
                missing_belt_ladder_message = (
                    "It looks like some programs do not have belt ladders set up yet, but Koaryu can create them during import."
                )
            elif severity == "error":
                missing_belt_ladder_message = (
                    "It looks like your belt ladder is not set up yet, so current belt values cannot be matched."
                )
            else:
                missing_belt_ladder_message = (
                    "Your belt ladder is not set up yet. Students can still be imported without current belts."
                )
            setup_issues.append(CsvImportSetupIssue(
                code="missing_belt_ladder",
                severity=severity,
                message=missing_belt_ladder_message,
                row_numbers=setup_buckets["missing_belt_ladder"]["row_numbers"],
                values=sorted(setup_buckets["missing_belt_ladder"]["values"]),
                suggested_action=(
                    "Turn on 'Create missing belts' to create ladders for those programs during import."
                    if can_create_missing_belts
                    else "Open Belt Tracker and configure your ladder."
                ),
            ))
        if setup_buckets["missing_belt"]["row_numbers"]:
            severity = setup_buckets["missing_belt"]["severity"]
            if can_create_missing_belts:
                missing_belt_message = (
                    "Some current belt values do not match their program ladders yet, but Koaryu can create them during import."
                )
            elif severity == "error":
                missing_belt_message = (
                    "Some current belt values do not match the belt ladder configured for this studio."
                )
            else:
                missing_belt_message = (
                    "Some current belt values do not match this studio's ladder, but those students can still import without belts."
                )
            setup_issues.append(CsvImportSetupIssue(
                code="missing_belt",
                severity=severity,
                message=missing_belt_message,
                row_numbers=setup_buckets["missing_belt"]["row_numbers"],
                values=sorted(setup_buckets["missing_belt"]["values"]),
                suggested_action=(
                    "Turn on 'Create missing belts' to add these ranks to the matching program ladders during import."
                    if can_create_missing_belts
                    else "Open Belt Tracker to add or reconcile the missing belt names."
                ),
            ))
        if setup_buckets["ambiguous_belt"]["row_numbers"]:
            setup_issues.append(CsvImportSetupIssue(
                code="ambiguous_belt",
                severity="error",
                message="Some current belt values match multiple belt ranks in this studio.",
                row_numbers=setup_buckets["ambiguous_belt"]["row_numbers"],
                values=sorted(setup_buckets["ambiguous_belt"]["values"]),
                suggested_action="Resolve duplicate belt rank names or remove the Current Belt mapping for those rows.",
            ))
        if setup_buckets["ambiguous_belt_ladder"]["row_numbers"]:
            setup_issues.append(CsvImportSetupIssue(
                code="ambiguous_belt_ladder",
                severity="error",
                message="Some programs have multiple belt ladders, so Koaryu cannot safely decide where new belts belong.",
                row_numbers=setup_buckets["ambiguous_belt_ladder"]["row_numbers"],
                values=sorted(setup_buckets["ambiguous_belt_ladder"]["values"]),
                suggested_action="Reduce each program to one ladder or assign current belts manually after import.",
            ))

        actions_available = CsvImportActionOptions(
            can_create_missing_programs=bool(setup_buckets["missing_program"]["row_numbers"]),
            can_create_missing_belts=can_create_missing_belts,
            can_import_without_unresolved_belt=bool(
                setup_buckets["missing_belt"]["row_numbers"]
                or setup_buckets["missing_belt_ladder"]["row_numbers"]
            ),
            belt_tracker_href=(
                "/belt-tracker"
                if setup_buckets["missing_belt"]["row_numbers"]
                or setup_buckets["missing_belt_ladder"]["row_numbers"]
                or setup_buckets["ambiguous_belt"]["row_numbers"]
                else None
            ),
        )

        return CsvImportResult(
            total_rows=total_rows,
            valid_rows=valid_rows,
            error_rows=error_rows,
            rows=issue_rows,
            errors=[row for row in issue_rows if not row.is_valid],
            warnings=warnings,
            setup_issues=setup_issues,
            actions_available=actions_available,
            imported_without_belt_count=len(unresolved_belt_rows),
            normalized_status_count=len(normalized_status_rows),
        )

    def _prepare_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        studio_id: Optional[str],
        options: CsvImportOptions,
    ) -> tuple[CsvImportResult, list[dict[str, Any]]]:
        program_lookup = self._build_named_record_lookup("programs", studio_id) if studio_id else None
        belt_rank_lookup = self._build_belt_rank_lookup(studio_id) if studio_id else None

        planned_rows: list[dict[str, Any]] = []
        for i, raw_row in enumerate(rows, start=2):
            row_plan = self._build_import_row_plan(
                raw_row,
                mapping,
                options=options,
                program_lookup=program_lookup,
                belt_rank_lookup=belt_rank_lookup,
            )
            row_plan["row_number"] = i
            planned_rows.append(row_plan)

        return self._build_import_result(planned_rows, total_rows=len(rows)), planned_rows

    def _hydrate_import_result(
        self,
        planned_rows: list[dict[str, Any]],
        *,
        total_rows: int,
        created_programs: Optional[list[str]] = None,
        created_ladders: Optional[list[str]] = None,
        created_belts: Optional[list[str]] = None,
        imported_without_belt_count: int = 0,
        imported_count: int = 0,
        idempotency_key: Optional[str] = None,
    ) -> CsvImportResult:
        result = self._build_import_result(planned_rows, total_rows=total_rows)
        result.created_programs = created_programs or []
        result.created_ladders = created_ladders or []
        result.created_belts = created_belts or []
        result.imported_without_belt_count = imported_without_belt_count
        result.imported_count = imported_count
        result.idempotency_key = idempotency_key
        return result

    def _normalize_idempotency_key(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    def _compute_import_request_hash(
        self,
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

    def _deterministic_import_uuid(self, import_run_id: str, namespace: str, value: str) -> str:
        return str(uuid.uuid5(uuid.UUID(import_run_id), f"{namespace}:{value}"))

    def _parse_datetime(self, value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    def _apply_result_execution_metadata(
        self,
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

    def _load_cached_import_result(
        self,
        run_row: dict[str, Any],
        *,
        idempotency_key: str,
    ) -> Optional[CsvImportResult]:
        result_payload = run_row.get("result_json")
        if not result_payload:
            return None
        result = CsvImportResult.model_validate(result_payload)
        return self._apply_result_execution_metadata(
            result,
            idempotency_key=idempotency_key,
            reused_result=True,
        )

    def _fetch_import_run(
        self,
        studio_id: str,
        idempotency_key: str,
    ) -> Optional[dict[str, Any]]:
        result = (
            self.supabase.table("student_import_runs")
            .select("*")
            .eq("studio_id", studio_id)
            .eq("operation", IMPORT_RUN_OPERATION)
            .eq("idempotency_key", idempotency_key)
            .maybe_single()
            .execute()
        )
        return result.data if result else None

    def _claim_import_run(
        self,
        *,
        studio_id: str,
        actor_id: str,
        rows: list[dict[str, Any]],
        mapping: dict[str, str],
        options: CsvImportOptions,
        idempotency_key: Optional[str],
    ) -> tuple[dict[str, Any], Optional[CsvImportResult], str]:
        request_hash = self._compute_import_request_hash(rows, mapping, options)
        effective_key = self._normalize_idempotency_key(idempotency_key) or f"auto:{request_hash}"
        now = datetime.now(timezone.utc)

        def handle_existing(run_row: dict[str, Any]) -> tuple[dict[str, Any], Optional[CsvImportResult], str]:
            if run_row.get("request_hash") != request_hash:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="This idempotency key is already in use for a different student import request.",
                )

            if run_row.get("status") == "completed":
                cached = self._load_cached_import_result(run_row, idempotency_key=effective_key)
                if cached is not None:
                    return run_row, cached, effective_key

            last_updated_at = self._parse_datetime(run_row.get("updated_at")) or self._parse_datetime(run_row.get("created_at"))
            if run_row.get("status") == "processing" and last_updated_at:
                age_seconds = (now - last_updated_at.astimezone(timezone.utc)).total_seconds()
                if age_seconds < IMPORT_RUN_STALE_AFTER_SECONDS:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="This student import is still processing for the provided idempotency key. Retry shortly with the same key.",
                    )

            update_result = (
                self.supabase.table("student_import_runs")
                .update({
                    "actor_id": actor_id,
                    "status": "processing",
                    "error_message": None,
                    "started_at": now.isoformat(),
                    "completed_at": None,
                })
                .eq("id", run_row["id"])
                .eq("studio_id", studio_id)
                .execute()
            )
            return (update_result.data or [run_row])[0], None, effective_key

        existing = self._fetch_import_run(studio_id, effective_key)
        if existing:
            return handle_existing(existing)

        try:
            insert_result = (
                self.supabase.table("student_import_runs")
                .insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "operation": IMPORT_RUN_OPERATION,
                    "idempotency_key": effective_key,
                    "request_hash": request_hash,
                    "status": "processing",
                    "started_at": now.isoformat(),
                })
                .execute()
            )
            if insert_result.data:
                return insert_result.data[0], None, effective_key
        except Exception:
            existing = self._fetch_import_run(studio_id, effective_key)
            if existing:
                return handle_existing(existing)
            raise

        existing = self._fetch_import_run(studio_id, effective_key)
        if existing:
            return handle_existing(existing)
        raise HTTPException(status_code=500, detail="Failed to initialize the student import run.")

    def _save_import_run_result(
        self,
        import_run_id: str,
        result: CsvImportResult,
    ) -> None:
        self.supabase.table("student_import_runs").update({
            "status": "completed",
            "result_json": result.model_dump(mode="json"),
            "error_message": None,
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", import_run_id).execute()

    def _mark_import_run_failed(
        self,
        import_run_id: str,
        message: str,
    ) -> None:
        self.supabase.table("student_import_runs").update({
            "status": "failed",
            "error_message": message[:1000],
        }).eq("id", import_run_id).execute()

    def _create_missing_programs(
        self,
        studio_id: str,
        actor_id: str,
        planned_rows: list[dict[str, Any]],
        import_run_id: str,
        non_critical_errors: Optional[list[str]] = None,
    ) -> list[str]:
        requested_names: dict[str, str] = {}
        for row in planned_rows:
            raw_name = row.get("pending_program_name")
            if not raw_name:
                continue
            normalized_name = _normalize_header(raw_name)
            if normalized_name and normalized_name not in requested_names:
                requested_names[normalized_name] = raw_name.strip()

        if not requested_names:
            return []

        program_lookup = self._build_named_record_lookup("programs", studio_id)
        program_service = ProgramService(self.supabase)
        created_programs: list[str] = []
        for normalized_name, raw_name in requested_names.items():
            existing_id = program_lookup[1].get(normalized_name)
            if existing_id:
                continue

            program_id = self._deterministic_import_uuid(import_run_id, "program", normalized_name)
            result = None
            sort_order = (len(program_lookup[0]) + len(created_programs)) * 10
            full_program_row = {
                "id": program_id,
                "studio_id": studio_id,
                "name": raw_name,
                "description": "Program created from student import.",
                "color_hex": "#64748B",
                "sort_order": sort_order,
                "is_system": False,
                "archived_at": None,
            }
            try:
                result = (
                    self.supabase.table("programs")
                    .upsert(
                        full_program_row,
                        on_conflict="id",
                    )
                    .execute()
                )
            except PostgrestAPIError as exc:
                if exc.code not in {"42703", "PGRST204", "PGRST205"}:
                    result = None
                else:
                    result = (
                        self.supabase.table("programs")
                        .upsert(
                            {
                                "id": program_id,
                                "studio_id": studio_id,
                                "name": raw_name,
                                "description": "Program created from student import.",
                            },
                            on_conflict="id",
                        )
                        .execute()
                    )
            except Exception:
                result = None
            if not result or not result.data:
                refreshed_lookup = self._build_named_record_lookup("programs", studio_id)
                if refreshed_lookup[1].get(normalized_name):
                    program_lookup = refreshed_lookup
                    continue
                raise HTTPException(status_code=500, detail=f"Failed to create program '{raw_name}'")

            created_programs.append(raw_name)
            program_lookup = self._build_named_record_lookup("programs", studio_id)

        if created_programs:
            program_service.ensure_program_ladders(studio_id)
            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "programs.created_from_import",
                    "entity_type": "program",
                    "entity_id": None,
                    "metadata": {"names": created_programs},
                }).execute()
            except Exception as exc:
                if non_critical_errors is not None:
                    non_critical_errors.append(
                        f"Programs were created, but the import audit log could not be written: {exc}"
                    )

        refreshed_lookup = self._build_named_record_lookup("programs", studio_id)
        for row in planned_rows:
            raw_name = row.get("pending_program_name")
            if not raw_name:
                continue
            resolved_id, _, _ = self._resolve_named_import_reference(
                raw_name,
                label="Program",
                id_lookup=refreshed_lookup[0],
                name_lookup=refreshed_lookup[1],
                ambiguous_names=refreshed_lookup[2],
            )
            row["resolved_program_id"] = resolved_id

        return created_programs

    def _create_missing_belts(
        self,
        studio_id: str,
        actor_id: str,
        planned_rows: list[dict[str, Any]],
        belt_rank_lookup: dict[str, Any],
        import_run_id: str,
        non_critical_errors: Optional[list[str]] = None,
    ) -> tuple[list[str], list[str]]:
        pending_rows = [row for row in planned_rows if row.get("pending_belt_name")]
        if not pending_rows:
            return [], []

        ladders_by_program: dict[str, list[str]] = defaultdict(list, {
            program_id: list(ladder_ids)
            for program_id, ladder_ids in belt_rank_lookup.get("ladders_by_program", {}).items()
        })
        ladder_meta = {
            ladder_id: dict(meta)
            for ladder_id, meta in belt_rank_lookup.get("ladder_meta", {}).items()
        }

        requested_program_ids = sorted({
            row.get("resolved_program_id")
            for row in pending_rows
            if row.get("resolved_program_id")
        })
        program_names: dict[str, str] = {}
        if requested_program_ids:
            programs_result = (
                self.supabase.table("programs")
                .select("id, name")
                .eq("studio_id", studio_id)
                .in_("id", requested_program_ids)
                .execute()
            )
            program_names = {
                row["id"]: row.get("name") or "Imported Program"
                for row in (programs_result.data or [])
                if row.get("id")
            }

        requested_new_ladders: dict[str, str] = {}
        for row in pending_rows:
            if row.get("belt_creation_target_ladder_id"):
                continue

            program_id = row.get("resolved_program_id")
            if not program_id:
                continue

            program_ladders = ladders_by_program.get(program_id, [])
            if len(program_ladders) == 1:
                row["belt_creation_target_ladder_id"] = program_ladders[0]
                row["belt_creation_requires_new_ladder"] = False
                continue

            if len(program_ladders) == 0:
                requested_new_ladders[program_id] = program_names.get(program_id, "Imported Program")
                continue

            row["issues"].append(_make_import_issue(
                "ambiguous_belt_ladder",
                f"{program_names.get(program_id, 'This program')} has multiple belt ladders, so Koaryu could not safely auto-create this current belt during import.",
                field="current_belt_rank_id",
                value=row.get("unresolved_belt_value"),
                suggested_action="Choose one ladder for this program in Belt Tracker, then retry the import.",
            ))
            row["is_valid"] = False

        created_ladders: list[str] = []
        created_ladder_ids: dict[str, str] = {}
        for program_id, program_name in sorted(requested_new_ladders.items(), key=lambda item: item[1].lower()):
            existing_program_ladders = (
                self.supabase.table("belt_ladders")
                .select("id, name, program_id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .order("created_at")
                .execute()
            )
            existing_program_ladder_rows = existing_program_ladders.data or []
            if len(existing_program_ladder_rows) == 1:
                existing_ladder = existing_program_ladder_rows[0]
                ladder_id = existing_ladder["id"]
                created_ladder_ids[program_id] = ladder_id
                ladders_by_program[program_id] = [ladder_id]
                ladder_meta[ladder_id] = {
                    "name": existing_ladder.get("name") or program_name,
                    "program_id": program_id,
                }
                continue
            if len(existing_program_ladder_rows) > 1:
                raise HTTPException(
                    status_code=409,
                    detail=f"Program '{program_name}' has multiple ladders. Please clean them up in Belt Tracker before importing current belts.",
                )

            ladder_id = self._deterministic_import_uuid(import_run_id, "ladder", program_id)
            result = None
            try:
                result = (
                    self.supabase.table("belt_ladders")
                    .upsert(
                        {
                            "id": ladder_id,
                            "studio_id": studio_id,
                            "name": program_name,
                            "program_id": program_id,
                            "sub_rank_term": "Stripe",
                        },
                        on_conflict="id",
                    )
                    .execute()
                )
            except Exception:
                result = None
            if not result or not result.data:
                existing_program_ladders = (
                    self.supabase.table("belt_ladders")
                    .select("id, name, program_id")
                    .eq("studio_id", studio_id)
                    .eq("program_id", program_id)
                    .order("created_at")
                    .execute()
                )
                existing_program_ladder_rows = existing_program_ladders.data or []
                if len(existing_program_ladder_rows) == 1:
                    existing_ladder = existing_program_ladder_rows[0]
                    ladder_id = existing_ladder["id"]
                    created_ladder_ids[program_id] = ladder_id
                    ladders_by_program[program_id] = [ladder_id]
                    ladder_meta[ladder_id] = {
                        "name": existing_ladder.get("name") or program_name,
                        "program_id": program_id,
                    }
                    continue
                raise HTTPException(status_code=500, detail=f"Failed to create ladder for program '{program_name}'")

            ladder_id = result.data[0]["id"]
            created_ladder_ids[program_id] = ladder_id
            ladders_by_program[program_id] = [ladder_id]
            ladder_meta[ladder_id] = {
                "name": result.data[0].get("name") or program_name,
                "program_id": program_id,
            }
            created_ladders.append(program_name)

        if created_ladders:
            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "belt_ladders.created_from_import",
                    "entity_type": "belt_ladder",
                    "entity_id": None,
                    "metadata": {"names": created_ladders},
                }).execute()
            except Exception as exc:
                if non_critical_errors is not None:
                    non_critical_errors.append(
                        f"Belt ladders were created, but the import audit log could not be written: {exc}"
                    )

        for row in pending_rows:
            if row.get("belt_creation_target_ladder_id"):
                continue
            program_id = row.get("resolved_program_id")
            if program_id and program_id in created_ladder_ids:
                row["belt_creation_target_ladder_id"] = created_ladder_ids[program_id]
                row["belt_creation_requires_new_ladder"] = False

        requested_belts: dict[tuple[str, str], dict[str, str]] = {}
        for row in pending_rows:
            raw_name = row.get("pending_belt_name")
            ladder_id = row.get("belt_creation_target_ladder_id")
            if not raw_name or not ladder_id:
                continue

            normalized_name = _normalize_header(raw_name)
            if not normalized_name:
                continue

            key = (ladder_id, normalized_name)
            if key not in requested_belts:
                ladder_name = (
                    (ladder_meta.get(ladder_id) or {}).get("name")
                    or "Imported ladder"
                )
                requested_belts[key] = {
                    "raw_name": raw_name.strip(),
                    "ladder_name": ladder_name,
                }

        if not requested_belts:
            return created_ladders, []

        ladder_ids = sorted({ladder_id for ladder_id, _ in requested_belts.keys()})
        ranks_result = (
            self.supabase.table("belt_ranks")
            .select("id, ladder_id, display_order, name")
            .eq("studio_id", studio_id)
            .in_("ladder_id", ladder_ids)
            .order("display_order")
            .execute()
        )

        next_display_order: dict[str, int] = defaultdict(int)
        existing_rank_ids_by_key: dict[tuple[str, str], str] = {}
        for rank in ranks_result.data or []:
            ladder_id = rank.get("ladder_id")
            if not ladder_id:
                continue
            next_display_order[ladder_id] = max(
                next_display_order[ladder_id],
                int(rank.get("display_order", 0)) + 1,
            )
            normalized_rank_name = _normalize_header(rank.get("name") or "")
            if normalized_rank_name:
                existing_rank_ids_by_key[(ladder_id, normalized_rank_name)] = rank["id"]

        created_belt_ids: dict[tuple[str, str], str] = {}
        created_belts: list[str] = []
        ordered_requests = sorted(
            requested_belts.items(),
            key=lambda item: (item[0][0], _belt_import_sort_key(item[1]["raw_name"])),
        )
        for (ladder_id, normalized_name), meta in ordered_requests:
            existing_rank_id = existing_rank_ids_by_key.get((ladder_id, normalized_name))
            if existing_rank_id:
                created_belt_ids[(ladder_id, normalized_name)] = existing_rank_id
                continue

            rank_id = self._deterministic_import_uuid(import_run_id, "belt", f"{ladder_id}:{normalized_name}")
            result = None
            try:
                result = (
                    self.supabase.table("belt_ranks")
                    .upsert(
                        {
                            "id": rank_id,
                            "studio_id": studio_id,
                            "ladder_id": ladder_id,
                            "name": meta["raw_name"],
                            "color_hex": _infer_belt_color_hex(meta["raw_name"]),
                            "display_order": next_display_order[ladder_id],
                            "min_classes": 0,
                            "min_months": 0,
                            "requires_approval": True,
                            "is_tip": False,
                            "tip_color_hex": None,
                        },
                        on_conflict="id",
                    )
                    .execute()
                )
            except Exception:
                result = None

            if result and result.data:
                created_belt_ids[(ladder_id, normalized_name)] = result.data[0]["id"]
                existing_rank_ids_by_key[(ladder_id, normalized_name)] = result.data[0]["id"]
                next_display_order[ladder_id] += 1
                created_belts.append(f"{meta['raw_name']} ({meta['ladder_name']})")
                continue

            existing_rank = (
                self.supabase.table("belt_ranks")
                .select("id, name")
                .eq("studio_id", studio_id)
                .eq("ladder_id", ladder_id)
                .execute()
            )
            existing_rank_id = next(
                (
                    rank.get("id")
                    for rank in (existing_rank.data or [])
                    if _normalize_header(rank.get("name") or "") == normalized_name
                ),
                None,
            )
            if not existing_rank_id:
                raise HTTPException(status_code=500, detail=f"Failed to create belt '{meta['raw_name']}'")
            created_belt_ids[(ladder_id, normalized_name)] = existing_rank_id

        if created_belts:
            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "belt_ranks.created_from_import",
                    "entity_type": "belt_rank",
                    "entity_id": None,
                    "metadata": {"names": created_belts},
                }).execute()
            except Exception as exc:
                if non_critical_errors is not None:
                    non_critical_errors.append(
                        f"Belt ranks were created, but the import audit log could not be written: {exc}"
                    )

        for row in planned_rows:
            raw_name = row.get("pending_belt_name")
            ladder_id = row.get("belt_creation_target_ladder_id")
            if not raw_name or not ladder_id:
                continue
            normalized_name = _normalize_header(raw_name)
            created_rank_id = created_belt_ids.get((ladder_id, normalized_name))
            if created_rank_id:
                row["resolved_belt_rank_id"] = created_rank_id

        return created_ladders, created_belts

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
            memberships = (
                self.supabase.table("student_program_memberships")
                .select("student_id")
                .eq("studio_id", studio_id)
                .eq("program_id", program_id)
                .in_("status", ["active", "paused"])
                .is_("ended_at", "null")
                .execute()
            )
            student_ids = [row["student_id"] for row in (memberships.data or []) if row.get("student_id")]
            if not student_ids:
                return StudentListResponse(items=[], total=0, page=page, page_size=page_size)
            query = query.in_("id", student_ids)

        offset = (page - 1) * page_size
        query = query.range(offset, offset + page_size - 1)

        result = query.execute()

        items = self._rows_to_responses(result.data or [])

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
        raw_data = data.model_dump(exclude={"guardians"})
        program_ids = self._normalize_program_ids_for_write(
            studio_id,
            raw_data.get("program_id"),
            raw_data.pop("program_ids", None),
        )
        student_dict = raw_data
        ensure_optional_studio_record(
            self.supabase,
            "programs",
            program_ids[0] if program_ids else None,
            studio_id,
            "Program not found",
        )
        student_dict["program_id"] = program_ids[0]
        student_dict["studio_id"] = studio_id
        student_dict = self._prepare_student_write(student_dict, set_default_is_minor=True)

        result = self.supabase.table("students").insert(student_dict).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create student")

        student = result.data[0]
        self._replace_active_program_memberships(
            student["id"],
            studio_id,
            program_ids,
            current_belt_rank_id=student.get("current_belt_rank_id"),
            started_at=student.get("membership_start_date"),
        )

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

        return self._row_to_response(student, guardians=guardian_responses)

    async def get_student(self, student_id: str, studio_id: str) -> StudentResponse:
        result = (
            self.supabase.table("students")
            .select("*")
            .eq("id", student_id)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .maybe_single()
            .execute()
        )
        if not result or not result.data:
            raise HTTPException(status_code=404, detail="Student not found")
        return self._row_to_response(result.data)

    async def update_student(
        self, student_id: str, data: StudentUpdate, studio_id: str, actor_id: str
    ) -> StudentResponse:
        update_dict = data.model_dump(exclude_unset=True)
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        program_ids_were_set = "program_ids" in update_dict or "program_id" in update_dict
        program_ids = None
        if program_ids_were_set:
            program_ids = self._normalize_program_ids_for_write(
                studio_id,
                update_dict.get("program_id"),
                update_dict.pop("program_ids", None),
            )
            update_dict["program_id"] = program_ids[0]
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
        if program_ids is not None:
            self._replace_active_program_memberships(
                student_id,
                studio_id,
                program_ids,
                current_belt_rank_id=update_dict.get("current_belt_rank_id") or result.data[0].get("current_belt_rank_id"),
                started_at=result.data[0].get("membership_start_date"),
            )
        elif "current_belt_rank_id" in update_dict:
            memberships = self._fetch_memberships_for_student(student_id)
            active_program_ids = [
                membership.program_id
                for membership in memberships
                if membership.status in {"active", "paused"} and not membership.ended_at
            ]
            if active_program_ids:
                self._replace_active_program_memberships(
                    student_id,
                    studio_id,
                    active_program_ids,
                    current_belt_rank_id=result.data[0].get("current_belt_rank_id"),
                    started_at=result.data[0].get("membership_start_date"),
                )

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

    async def list_program_memberships(
        self,
        student_id: str,
        studio_id: str,
    ) -> list[StudentProgramMembershipResponse]:
        self._ensure_student_exists(student_id, studio_id)
        return self._fetch_memberships_for_student(student_id)

    async def add_program_membership(
        self,
        student_id: str,
        data: StudentProgramMembershipCreate,
        studio_id: str,
        actor_id: str,
    ) -> StudentProgramMembershipResponse:
        self._ensure_student_exists(student_id, studio_id)
        ProgramService(self.supabase).ensure_program_active(studio_id, data.program_id)
        row = self._membership_write_payload(data.model_dump())
        row["student_id"] = student_id
        row["studio_id"] = studio_id
        result = self.supabase.table("student_program_memberships").insert(row).execute()
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to add student program membership")
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.program_added",
            "entity_type": "student",
            "entity_id": student_id,
            "metadata": {"program_id": data.program_id},
        }).execute()
        memberships = self._fetch_memberships_for_student(student_id)
        active_program_ids = [
            membership.program_id
            for membership in memberships
            if membership.status in {"active", "paused"} and not membership.ended_at
        ]
        if active_program_ids:
            self._sync_legacy_program_fields(student_id, studio_id, active_program_ids)
        return self._membership_row_to_response(result.data[0])

    async def update_program_membership(
        self,
        student_id: str,
        membership_id: str,
        data: StudentProgramMembershipUpdate,
        studio_id: str,
        actor_id: str,
    ) -> StudentProgramMembershipResponse:
        self._ensure_student_exists(student_id, studio_id)
        update_dict = self._membership_write_payload(data.model_dump(exclude_unset=True))
        if not update_dict:
            raise HTTPException(status_code=400, detail="No fields to update")
        if update_dict.get("status") == "ended" and not update_dict.get("ended_at"):
            update_dict["ended_at"] = datetime.now(timezone.utc).date().isoformat()
        if update_dict.get("status") in {"active", "paused"}:
            update_dict["ended_at"] = None
        result = (
            self.supabase.table("student_program_memberships")
            .update(update_dict)
            .eq("id", membership_id)
            .eq("student_id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student program membership not found")
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.program_updated",
            "entity_type": "student_program_membership",
            "entity_id": membership_id,
            "metadata": update_dict,
        }).execute()
        memberships = self._fetch_memberships_for_student(student_id)
        active_program_ids = [
            membership.program_id
            for membership in memberships
            if membership.status in {"active", "paused"} and not membership.ended_at
        ]
        if active_program_ids:
            self._sync_legacy_program_fields(student_id, studio_id, active_program_ids)
        return self._membership_row_to_response(result.data[0])

    async def remove_program_membership(
        self,
        student_id: str,
        membership_id: str,
        studio_id: str,
        actor_id: str,
    ) -> None:
        self._ensure_student_exists(student_id, studio_id)
        now = datetime.now(timezone.utc).date().isoformat()
        result = (
            self.supabase.table("student_program_memberships")
            .update({"status": "ended", "ended_at": now, "current_belt_rank_id": None})
            .eq("id", membership_id)
            .eq("student_id", student_id)
            .eq("studio_id", studio_id)
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=404, detail="Student program membership not found")
        self.supabase.table("audit_logs").insert({
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": "student.program_removed",
            "entity_type": "student_program_membership",
            "entity_id": membership_id,
            "metadata": {"student_id": student_id},
        }).execute()
        memberships = self._fetch_memberships_for_student(student_id)
        active_program_ids = [
            membership.program_id
            for membership in memberships
            if membership.status in {"active", "paused"} and not membership.ended_at
        ]
        if not active_program_ids:
            active_program_ids = [ProgramService(self.supabase).get_unassigned_program_id(studio_id)]
            self._replace_active_program_memberships(student_id, studio_id, active_program_ids)
        else:
            self._sync_legacy_program_fields(student_id, studio_id, active_program_ids)

    # ---- Bulk Actions ----

    async def bulk_update_tags(
        self, data: BulkTagUpdate, studio_id: str, actor_id: str
    ) -> int:
        student_ids = list(dict.fromkeys(data.student_ids))
        existing = (
            self.supabase.table("students")
            .select("id, tags")
            .in_("id", student_ids)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        existing_rows = existing.data or []
        existing_by_id = {row["id"]: row for row in existing_rows}
        missing_ids = [sid for sid in student_ids if sid not in existing_by_id]
        if missing_ids:
            raise HTTPException(
                status_code=404,
                detail="One or more selected students are no longer available",
            )

        tags_to_add = list(dict.fromkeys(tag.strip() for tag in data.tags_to_add if tag.strip()))
        tags_to_remove = {tag.strip() for tag in data.tags_to_remove if tag.strip()}
        audit_logs = []

        for sid in student_ids:
            current_tags: list[str] = existing_by_id[sid].get("tags") or []
            next_tags = [tag for tag in current_tags if tag not in tags_to_remove]
            for tag in tags_to_add:
                if tag not in next_tags:
                    next_tags.append(tag)

            result = (
                self.supabase.table("students")
                .update({"tags": next_tags})
                .eq("id", sid)
                .eq("studio_id", studio_id)
                .is_("deleted_at", "null")
                .execute()
            )
            if not result.data:
                raise HTTPException(
                    status_code=409,
                    detail="One or more selected students changed during the bulk update",
                )

            audit_logs.append({
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "student.tags.bulk_updated",
                "entity_type": "student",
                "entity_id": sid,
                "metadata": {
                    "tags_to_add": tags_to_add,
                    "tags_to_remove": sorted(tags_to_remove),
                    "resulting_tags": next_tags,
                },
            })

        if audit_logs:
            self.supabase.table("audit_logs").insert(audit_logs).execute()

        return len(student_ids)

    async def bulk_update_status(
        self, data: BulkStatusUpdate, studio_id: str, actor_id: str
    ) -> int:
        if data.status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status: {data.status}")
        student_ids = list(dict.fromkeys(data.student_ids))
        existing = (
            self.supabase.table("students")
            .select("id, status")
            .in_("id", student_ids)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        existing_rows = existing.data or []
        existing_by_id = {row["id"]: row for row in existing_rows}
        missing_ids = [sid for sid in student_ids if sid not in existing_by_id]
        if missing_ids:
            raise HTTPException(
                status_code=404,
                detail="One or more selected students are no longer available",
            )

        result = (
            self.supabase.table("students")
            .update({"status": data.status})
            .in_("id", student_ids)
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .execute()
        )
        if len(result.data or []) != len(student_ids):
            raise HTTPException(
                status_code=409,
                detail="One or more selected students changed during the bulk update",
            )

        audit_logs = [
            {
                "studio_id": studio_id,
                "actor_id": actor_id,
                "action": "student.status.bulk_updated",
                "entity_type": "student",
                "entity_id": sid,
                "metadata": {
                    "previous_status": existing_by_id[sid].get("status"),
                    "new_status": data.status,
                },
            }
            for sid in student_ids
        ]
        if audit_logs:
            self.supabase.table("audit_logs").insert(audit_logs).execute()

        return len(student_ids)

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
            mapping[h] = _auto_map_csv_header(h)
        return mapping

    def validate_import_rows(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        options: Optional[CsvImportOptions] = None,
        studio_id: Optional[str] = None,
    ) -> CsvImportResult:
        """Validate rows against the mapping. Returns a structured result."""
        effective_options = options or CsvImportOptions()
        result, _ = self._prepare_import(rows, mapping, studio_id, effective_options)
        return result

    async def execute_import(
        self,
        rows: list[dict],
        mapping: dict[str, str],
        options: Optional[CsvImportOptions],
        studio_id: str,
        actor_id: str,
        idempotency_key: Optional[str] = None,
    ) -> CsvImportResult:
        """Execute the import for all valid rows."""
        effective_options = options or CsvImportOptions()
        import_run, cached_result, effective_idempotency_key = self._claim_import_run(
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

        try:
            _, planned_rows = self._prepare_import(rows, mapping, studio_id, effective_options)

            created_programs = (
                self._create_missing_programs(
                    studio_id,
                    actor_id,
                    planned_rows,
                    import_run["id"],
                    non_critical_errors,
                )
                if effective_options.create_missing_programs
                else []
            )
            ProgramService(self.supabase).ensure_program_ladders(studio_id)
            belt_rank_lookup = self._build_belt_rank_lookup(studio_id)
            created_ladders, created_belts = (
                self._create_missing_belts(
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

            imported = 0
            imported_without_belt = 0

            for row in planned_rows:
                if not row["is_valid"]:
                    continue

                mapped = dict(row["data"])

                guardian_name = mapped.pop("guardian_name", None)
                guardian_email = mapped.pop("guardian_email", None)
                guardian_phone = mapped.pop("guardian_phone", None)
                guardian_relation = mapped.pop("guardian_relation", None)
                program_ids = self._normalize_program_ids_for_write(
                    studio_id,
                    row.get("resolved_program_id"),
                    None,
                )
                mapped["program_id"] = program_ids[0]

                unresolved_belt_value = row.get("unresolved_belt_value")
                resolved_belt_rank_id = row.get("resolved_belt_rank_id")
                if resolved_belt_rank_id:
                    mapped["current_belt_rank_id"] = resolved_belt_rank_id
                else:
                    mapped.pop("current_belt_rank_id", None)
                    if unresolved_belt_value:
                        imported_without_belt += 1
                        mapped["notes"] = self._append_import_note(
                            mapped.get("notes"),
                            f"Imported current belt (unresolved): {unresolved_belt_value}",
                        )

                mapped["id"] = self._deterministic_import_uuid(
                    import_run["id"],
                    "student-row",
                    str(row["row_number"]),
                )
                mapped["studio_id"] = studio_id
                mapped = self._prepare_student_write(mapped, set_default_is_minor=True)

                try:
                    s_result = (
                        self.supabase.table("students")
                        .upsert(mapped, on_conflict="id")
                        .execute()
                    )
                    if not s_result.data:
                        raise RuntimeError("Failed to create student")
                    self._replace_active_program_memberships(
                        mapped["id"],
                        studio_id,
                        program_ids,
                        current_belt_rank_id=mapped.get("current_belt_rank_id"),
                        started_at=mapped.get("membership_start_date"),
                    )
                except Exception as exc:
                    row["issues"].append(_make_import_issue(
                        "execute_failed",
                        str(exc) or "Failed to import this row",
                        field=None,
                    ))
                    row["is_valid"] = False
                    continue

                student_id = s_result.data[0]["id"]

                if guardian_name:
                    try:
                        parts = guardian_name.split(" ", 1)
                        g_first = parts[0]
                        g_last = parts[1] if len(parts) > 1 else ""
                        guardian_id = self._deterministic_import_uuid(
                            import_run["id"],
                            "guardian-row",
                            str(row["row_number"]),
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
                                import_run["id"],
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
                        row["issues"].append(_make_import_issue(
                            "guardian_import_failed",
                            f"Student imported, but guardian details could not be linked automatically: {str(exc) or 'guardian import failed'}.",
                            severity="warning",
                            field="guardian_name",
                            value=guardian_name,
                            suggested_action="Open the student record after import if you need to add the guardian manually.",
                        ))

                imported += 1

            result = self._hydrate_import_result(
                planned_rows,
                total_rows=len(rows),
                created_programs=created_programs,
                created_ladders=created_ladders,
                created_belts=created_belts,
                imported_without_belt_count=imported_without_belt,
                imported_count=imported,
                idempotency_key=effective_idempotency_key,
            )
            result = self._apply_result_execution_metadata(
                result,
                idempotency_key=effective_idempotency_key,
                non_critical_errors=non_critical_errors,
            )

            try:
                self._save_import_run_result(import_run["id"], result)
            except Exception as exc:
                result = self._apply_result_execution_metadata(
                    result,
                    idempotency_key=effective_idempotency_key,
                    non_critical_errors=[
                        *result.non_critical_errors,
                        f"Import data was committed, but the cached import result could not be saved: {exc}",
                    ],
                )

            try:
                self.supabase.table("audit_logs").insert({
                    "studio_id": studio_id,
                    "actor_id": actor_id,
                    "action": "students.imported",
                    "entity_type": "student",
                    "entity_id": None,
                    "metadata": {
                        "imported": imported,
                        "total": len(rows),
                        "created_programs": created_programs,
                        "created_ladders": created_ladders,
                        "created_belts": created_belts,
                        "imported_without_belt": imported_without_belt,
                        "idempotency_key": effective_idempotency_key,
                    },
                }).execute()
            except Exception as exc:
                result = self._apply_result_execution_metadata(
                    result,
                    idempotency_key=effective_idempotency_key,
                    non_critical_errors=[
                        *result.non_critical_errors,
                        f"Students were imported, but the final import audit log could not be written: {exc}",
                    ],
                )
                try:
                    self._save_import_run_result(import_run["id"], result)
                except Exception:
                    pass

            return result
        except HTTPException as exc:
            try:
                self._mark_import_run_failed(import_run["id"], str(exc.detail))
            except Exception:
                pass
            raise
        except Exception as exc:
            try:
                self._mark_import_run_failed(import_run["id"], str(exc) or "Failed to complete import")
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=str(exc) or "Failed to complete import") from exc
