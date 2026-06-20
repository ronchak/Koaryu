import re
import uuid
from typing import Optional

from supabase import Client

from app.schemas.student import StudentListSortDir, StudentListSortKey, StudentStatus


STUDENT_LIST_SEARCH_COLUMNS = (
    "legal_first_name",
    "legal_last_name",
    "preferred_name",
    "email",
    "phone",
)
STUDENT_LIST_PRIMARY_SORT_COLUMNS = {
    "status": "status",
    "membership_start_date": "membership_start_date",
    "created_at": "created_at",
}


def normalize_student_list_search(search: Optional[str]) -> str:
    if not search:
        return ""

    # PostgREST's `or` filter is string-based, so keep the user term as plain
    # searchable text without letting grammar delimiters or wildcards change query shape.
    term = re.sub(r"[\x00-\x1f\x7f]+", " ", search)
    term = re.sub(r"[(),%_]+", " ", term)
    term = re.sub(r"\s+", " ", term).strip()
    return term[:80]


class StudentListQuery:
    def __init__(self, supabase: Client):
        self.supabase = supabase

    def fetch_page(
        self,
        studio_id: str,
        *,
        search: Optional[str],
        status_filter: Optional[StudentStatus],
        program_id: Optional[str],
        page: int,
        page_size: int,
        sort_by: StudentListSortKey,
        sort_dir: StudentListSortDir,
    ) -> tuple[list[dict], int]:
        normalized_search = normalize_student_list_search(search)

        if program_id:
            student_ids, total = self._program_filter_page_ids(
                studio_id,
                program_id,
                search=normalized_search,
                status_filter=status_filter,
                page=page,
                page_size=page_size,
                sort_by=sort_by,
                sort_dir=sort_dir,
            )
            return self._fetch_students_by_page_ids(studio_id, student_ids), total

        sort_desc = sort_dir == "desc"
        query = (
            self.supabase.table("students")
            .select("*", count="exact")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
        )

        if status_filter:
            query = query.eq("status", status_filter)

        if normalized_search:
            search_pattern = f"%{normalized_search}%"
            query = query.or_(
                ",".join(
                    f"{column}.ilike.{search_pattern}"
                    for column in STUDENT_LIST_SEARCH_COLUMNS
                )
            )

        if sort_by == "name":
            query = query.order("legal_last_name", desc=sort_desc).order("legal_first_name", desc=sort_desc)
        else:
            primary_sort_column = STUDENT_LIST_PRIMARY_SORT_COLUMNS.get(sort_by, "created_at")
            query = query.order(primary_sort_column, desc=sort_desc)
            query = query.order("legal_last_name").order("legal_first_name").order("id")

        offset = (page - 1) * page_size
        result = query.range(offset, offset + page_size - 1).execute()
        return result.data or [], result.count or 0

    def _program_filter_page_ids(
        self,
        studio_id: str,
        program_id: str,
        *,
        search: str,
        status_filter: Optional[str],
        page: int,
        page_size: int,
        sort_by: str,
        sort_dir: str,
    ) -> tuple[list[str], int]:
        try:
            normalized_program_id = str(uuid.UUID(program_id))
        except (TypeError, ValueError):
            return [], 0

        offset = (page - 1) * page_size
        result = self.supabase.rpc(
            "list_student_ids_for_program_filter",
            {
                "p_studio_id": studio_id,
                "p_program_id": normalized_program_id,
                "p_search": search or None,
                "p_status": status_filter or None,
                "p_sort_by": sort_by if sort_by in {"name", *STUDENT_LIST_PRIMARY_SORT_COLUMNS.keys()} else "name",
                "p_sort_dir": "desc" if sort_dir == "desc" else "asc",
                "p_limit": page_size,
                "p_offset": offset,
            },
        ).execute()

        rows = result.data or []
        total = int((rows[0] or {}).get("total_count") or 0) if rows else 0
        student_ids = [
            str(row["student_id"])
            for row in rows
            if row.get("student_id")
        ]
        return student_ids, total

    def _fetch_students_by_page_ids(
        self,
        studio_id: str,
        student_ids: list[str],
    ) -> list[dict]:
        if not student_ids:
            return []

        result = (
            self.supabase.table("students")
            .select("*")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .in_("id", student_ids)
            .execute()
        )
        rows_by_id = {
            row["id"]: row
            for row in (result.data or [])
            if row.get("id")
        }
        return [
            rows_by_id[student_id]
            for student_id in student_ids
            if student_id in rows_by_id
        ]
