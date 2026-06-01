import asyncio
import unittest
from typing import Optional

from app.schemas.student import StudentResponse
from app.services.student_list_query import normalize_student_list_search
from app.services.student_service import StudentService
from tests.fakes.supabase import RpcBackedSupabase


PROGRAM_A_ID = "11111111-1111-1111-1111-111111111111"
PROGRAM_B_ID = "22222222-2222-2222-2222-222222222222"


def student_row(
    student_id: str,
    first_name: str,
    last_name: str,
    *,
    studio_id: str = "studio-1",
    status: str = "active",
    program_id: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
    deleted_at: Optional[str] = None,
    created_at: str = "2026-01-01T00:00:00Z",
) -> dict:
    return {
        "id": student_id,
        "studio_id": studio_id,
        "legal_first_name": first_name,
        "legal_last_name": last_name,
        "preferred_name": None,
        "status": status,
        "program_id": program_id,
        "email": email,
        "phone": phone,
        "tags": [],
        "deleted_at": deleted_at,
        "created_at": created_at,
        "updated_at": created_at,
    }


class FakeSupabase(RpcBackedSupabase):
    def _program_matches(self, row: dict) -> bool:
        program_id = self._current_rpc_params["p_program_id"]
        if row.get("program_id") == program_id:
            return True
        return any(
            membership.get("studio_id") == self._current_rpc_params["p_studio_id"]
            and membership.get("student_id") == row.get("id")
            and membership.get("program_id") == program_id
            and membership.get("status") in {"active", "paused"}
            and membership.get("ended_at") is None
            for membership in self.tables.get("student_program_memberships", [])
        )

    def _search_matches(self, row: dict) -> bool:
        term = (self._current_rpc_params.get("p_search") or "").lower()
        if not term:
            return True
        return any(
            term in str(row.get(column) or "").lower()
            for column in (
                "legal_first_name",
                "legal_last_name",
                "preferred_name",
                "email",
                "phone",
            )
        )

    def _rpc_list_student_ids_for_program_filter(self, params: dict):
        self._current_rpc_params = params
        status = params.get("p_status")
        rows = [
            row
            for row in self.tables.get("students", [])
            if row.get("studio_id") == params["p_studio_id"]
            and row.get("deleted_at") is None
            and (not status or row.get("status") == status)
            and self._search_matches(row)
            and self._program_matches(row)
        ]

        sort_by = params.get("p_sort_by") or "name"
        sort_dir = params.get("p_sort_dir") or "asc"
        reverse = sort_dir == "desc"
        if sort_by == "status":
            rows.sort(key=lambda row: (row.get("legal_last_name") or "", row.get("legal_first_name") or "", row.get("id") or ""))
            rows.sort(key=lambda row: row.get("status") or "", reverse=reverse)
        elif sort_by == "membership_start_date":
            rows.sort(key=lambda row: (row.get("legal_last_name") or "", row.get("legal_first_name") or "", row.get("id") or ""))
            rows.sort(key=lambda row: row.get("membership_start_date") or "", reverse=reverse)
        elif sort_by == "created_at":
            rows.sort(key=lambda row: (row.get("legal_last_name") or "", row.get("legal_first_name") or "", row.get("id") or ""))
            rows.sort(key=lambda row: row.get("created_at") or "", reverse=reverse)
        else:
            rows.sort(key=lambda row: (row.get("legal_last_name") or "", row.get("legal_first_name") or ""), reverse=reverse)

        total = len(rows)
        offset = params.get("p_offset") or 0
        limit = params.get("p_limit") or 50
        page_rows = rows[offset:offset + limit]
        if not page_rows:
            return [{"student_id": None, "total_count": total}]
        return [
            {"student_id": row["id"], "total_count": total}
            for row in page_rows
        ]


class StudentServiceListTest(unittest.TestCase):
    def _service(self, rows: list[dict], memberships: Optional[list[dict]] = None) -> tuple[StudentService, FakeSupabase]:
        supabase = FakeSupabase({
            "students": rows,
            "student_program_memberships": memberships or [],
        })
        service = StudentService(supabase)
        service.rows_to_responses = lambda selected_rows: [  # type: ignore[method-assign]
            StudentResponse(**row, guardians=[], program_memberships=[])
            for row in selected_rows
        ]
        return service, supabase

    def test_search_applies_before_pagination_and_count(self):
        service, _ = self._service([
            student_row("s-1", "Sam", "Rivera"),
            student_row("s-2", "Samantha", "Cho"),
            student_row("s-3", "Alex", "Kim"),
            student_row("s-4", "Sam", "Other", studio_id="studio-2"),
        ])

        result = asyncio.run(
            service.list_students(
                "studio-1",
                search="sam",
                page=1,
                page_size=1,
                sort_by="name",
                sort_dir="asc",
            )
        )

        self.assertEqual(result.total, 2)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].studio_id, "studio-1")

    def test_program_filter_uses_studio_scoped_memberships_and_legacy_program_id_before_count(self):
        service, supabase = self._service(
            [
                student_row("s-1", "Mia", "Stone", program_id=PROGRAM_A_ID),
                student_row("s-2", "Noah", "Vale", program_id=PROGRAM_B_ID),
                student_row("s-legacy", "Legacy", "Student", program_id=PROGRAM_A_ID),
                student_row("s-3", "Other", "Tenant", studio_id="studio-2", program_id=PROGRAM_A_ID),
            ],
            memberships=[
                {"studio_id": "studio-1", "student_id": "s-1", "program_id": PROGRAM_A_ID, "status": "active", "ended_at": None},
                {"studio_id": "studio-2", "student_id": "s-3", "program_id": PROGRAM_A_ID, "status": "active", "ended_at": None},
            ],
        )

        result = asyncio.run(
            service.list_students(
                "studio-1",
                program_id=PROGRAM_A_ID,
                page=1,
                page_size=50,
            )
        )

        self.assertEqual([item.id for item in result.items], ["s-1", "s-legacy"])
        self.assertEqual(result.total, 2)
        self.assertTrue(any(name == "list_student_ids_for_program_filter" for name, _params in supabase.rpc_calls))
        self.assertFalse(any(entry["table"] == "student_program_memberships" for entry in supabase.query_log))

    def test_program_filter_rpc_only_expands_current_page_ids(self):
        rows = [
            student_row(f"s-{index:03d}", f"Student{index:03d}", "River", program_id=PROGRAM_A_ID)
            for index in range(25)
        ]
        service, supabase = self._service(rows)

        result = asyncio.run(
            service.list_students(
                "studio-1",
                program_id=PROGRAM_A_ID,
                page=2,
                page_size=3,
            )
        )

        self.assertEqual(result.total, 25)
        self.assertEqual([item.id for item in result.items], ["s-003", "s-004", "s-005"])
        students_id_filters = [
            value
            for entry in supabase.query_log
            if entry["table"] == "students"
            for op, key, value in entry["filters"]
            if op == "in" and key == "id"
        ]
        self.assertEqual(len(students_id_filters), 1)
        self.assertEqual(students_id_filters[0], {"s-003", "s-004", "s-005"})

    def test_program_filter_preserves_total_from_null_sentinel_without_followup_fetch(self):
        rows = [
            student_row(f"s-{index:03d}", f"Student{index:03d}", "River", program_id=PROGRAM_A_ID)
            for index in range(3)
        ]
        service, supabase = self._service(rows)

        result = asyncio.run(
            service.list_students(
                "studio-1",
                program_id=PROGRAM_A_ID,
                page=2,
                page_size=50,
            )
        )

        self.assertEqual(result.total, 3)
        self.assertEqual(result.items, [])
        self.assertFalse(any(
            entry["table"] == "students" and any(op == "in" and key == "id" for op, key, _value in entry["filters"])
            for entry in supabase.query_log
        ))

    def test_sort_parameters_are_applied_before_range(self):
        service, _ = self._service([
            student_row("s-old", "Older", "Student", created_at="2026-01-01T00:00:00Z"),
            student_row("s-new", "Newer", "Student", created_at="2026-05-01T00:00:00Z"),
        ])

        result = asyncio.run(
            service.list_students(
                "studio-1",
                page=1,
                page_size=1,
                sort_by="created_at",
                sort_dir="desc",
            )
        )

        self.assertEqual(result.total, 2)
        self.assertEqual([item.id for item in result.items], ["s-new"])

    def test_non_name_sort_uses_primary_direction_and_name_tie_breaks_ascending(self):
        service, _ = self._service([
            student_row("s-z", "Zed", "Tie", status="active"),
            student_row("s-a", "Ava", "Tie", status="active"),
            student_row("s-p", "Pat", "Ahead", status="paused"),
        ])

        result = asyncio.run(
            service.list_students(
                "studio-1",
                page=1,
                page_size=50,
                sort_by="status",
                sort_dir="desc",
            )
        )

        self.assertEqual([item.id for item in result.items], ["s-p", "s-a", "s-z"])

    def test_program_filter_sort_uses_primary_direction_and_name_tie_breaks_ascending(self):
        service, _ = self._service([
            student_row("s-z", "Zed", "Tie", program_id=PROGRAM_A_ID, status="active"),
            student_row("s-a", "Ava", "Tie", program_id=PROGRAM_A_ID, status="active"),
            student_row("s-p", "Pat", "Ahead", program_id=PROGRAM_A_ID, status="paused"),
        ])

        result = asyncio.run(
            service.list_students(
                "studio-1",
                program_id=PROGRAM_A_ID,
                page=1,
                page_size=50,
                sort_by="status",
                sort_dir="desc",
            )
        )

        self.assertEqual([item.id for item in result.items], ["s-p", "s-a", "s-z"])

    def test_search_term_is_normalized_before_postgrest_or_filter(self):
        self.assertEqual(
            normalize_student_list_search("Sam),studio_id.eq.other_%"),
            "Sam studio id.eq.other",
        )
        self.assertEqual(
            normalize_student_list_search("O'Connor D’Angelo José Renée"),
            "O'Connor D’Angelo José Renée",
        )

    def test_search_preserves_apostrophes_and_accented_names(self):
        service, _ = self._service([
            student_row("s-1", "José", "O'Connor"),
            student_row("s-2", "Renee", "Plain"),
        ])

        result = asyncio.run(
            service.list_students(
                "studio-1",
                search="José",
                page=1,
                page_size=50,
            )
        )

        self.assertEqual([item.id for item in result.items], ["s-1"])

        result = asyncio.run(
            service.list_students(
                "studio-1",
                search="O'Connor",
                page=1,
                page_size=50,
            )
        )

        self.assertEqual([item.id for item in result.items], ["s-1"])


if __name__ == "__main__":
    unittest.main()
