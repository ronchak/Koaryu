import asyncio
import unittest

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.schemas.schedule import AttendanceCheckIn
from app.services.schedule_attendance_actions import (
    ATTENDANCE_LIST_RANGE_MAX_DAYS,
    ATTENDANCE_SESSION_IDS_MAX,
)
from app.services.schedule_service import (
    CLASS_SESSION_LIST_SELECT,
    SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS,
    ScheduleService,
)
from tests.fakes.supabase import RpcBackedSupabase


def conflict_error() -> PostgrestAPIError:
    return PostgrestAPIError({
        "code": "23505",
        "message": "duplicate key value violates unique constraint",
        "details": "",
        "hint": "",
    })


class FakeSupabase(RpcBackedSupabase):
    def __init__(self, tables: dict[str, list[dict]]):
        super().__init__(tables)
        self.insert_defaults["class_sessions"] = {
            "status": "scheduled",
            "created_at": "2026-05-24T12:00:00Z",
        }
        self.unique_constraints["class_sessions"] = [("template_id", "date")]
        self.unique_conflict_error_factory = lambda _table, _columns: conflict_error()

    def _rpc_delete_recurring_class_series_atomic(self, params: dict):
        session = next(
            (
                row
                for row in self.tables.setdefault("class_sessions", [])
                if row.get("id") == params["p_session_id"]
                and row.get("studio_id") == params["p_studio_id"]
                and row.get("deleted_at") is None
            ),
            None,
        )
        if not session:
            raise AssertionError("Class session not found.")
        if not session.get("template_id"):
            raise AssertionError("Only recurring classes can be deleted for the full series.")
        template = next(
            (
                row
                for row in self.tables.setdefault("class_templates", [])
                if row.get("id") == session.get("template_id")
                and row.get("studio_id") == params["p_studio_id"]
            ),
            None,
        )
        if not template:
            raise AssertionError("Class template not found.")

        template["is_active"] = False
        template["end_date"] = "2026-05-30"
        deleted_count = 0
        for row in self.tables.setdefault("class_sessions", []):
            if (
                row.get("studio_id") == params["p_studio_id"]
                and row.get("template_id") == session.get("template_id")
                and row.get("date") >= session.get("date")
                and row.get("deleted_at") is None
            ):
                row["deleted_at"] = "2026-05-31T00:00:00Z"
                row["status"] = "canceled"
                deleted_count += 1
        if deleted_count == 0:
            raise AssertionError("Failed to delete recurring class series.")
        self.tables.setdefault("audit_logs", []).append({
            "studio_id": params["p_studio_id"],
            "actor_id": params["p_actor_id"],
            "action": "class_series.deleted",
            "entity_type": "class_template",
            "entity_id": template["id"],
            "metadata": {
                "start_date": session["date"],
                "session_name": session["name"],
            },
        })
        return None


def template_row(template_id: str, name: str) -> dict:
    return {
        "id": template_id,
        "studio_id": "studio-1",
        "name": name,
        "day_of_week": 0,
        "start_time": "09:00",
        "end_time": "10:00",
        "start_date": "2026-05-24",
        "end_date": None,
        "instructor_id": None,
        "program_id": None,
        "capacity": 10,
        "is_active": True,
        "created_at": "2026-05-01T00:00:00Z",
        "updated_at": "2026-05-01T00:00:00Z",
    }


def session_row(session_id: str, template_id: str, session_date: str) -> dict:
    return {
        "id": session_id,
        "studio_id": "studio-1",
        "template_id": template_id,
        "name": "Youth Basics",
        "date": session_date,
        "start_time": "09:00",
        "end_time": "10:00",
        "instructor_id": None,
        "program_id": None,
        "capacity": 10,
        "status": "scheduled",
        "notes": None,
        "created_at": "2026-05-24T12:00:00Z",
        "deleted_at": None,
    }


class ScheduleServiceTest(unittest.TestCase):
    def test_materialize_sessions_skips_concurrent_duplicate_and_inserts_remaining_rows(self):
        supabase = FakeSupabase({
            "class_templates": [
                template_row("template-1", "Youth Basics"),
                template_row("template-2", "Adult Basics"),
            ],
            "class_sessions": [],
        })
        service = ScheduleService(supabase)
        raced = {"done": False}

        def before_insert(table_name: str, payloads: list[dict], rows: list[dict]) -> None:
            if table_name != "class_sessions" or raced["done"]:
                return
            raced["done"] = True
            rows.append({
                "id": "race-session",
                "studio_id": "studio-1",
                "template_id": "template-1",
                "name": "Youth Basics",
                "date": "2026-05-24",
                "start_time": "09:00",
                "end_time": "10:00",
                "status": "scheduled",
                "created_at": "2026-05-24T12:00:00Z",
            })

        supabase.before_insert = before_insert

        asyncio.run(service._materialize_sessions_for_range("studio-1", "2026-05-24", "2026-05-24"))

        sessions = supabase.tables["class_sessions"]
        self.assertEqual(
            sorted((row["template_id"], row["date"]) for row in sessions),
            [("template-1", "2026-05-24"), ("template-2", "2026-05-24")],
        )
        class_session_inserts = [
            query["insert"]
            for query in supabase.query_log
            if query["table"] == "class_sessions" and query["insert"] is not None
        ]
        self.assertEqual([len(payload) for payload in class_session_inserts], [2, 1])
        self.assertTrue(all(isinstance(payload, list) for payload in class_session_inserts))

    def test_list_sessions_materializes_recurring_sessions_on_read(self):
        supabase = FakeSupabase({
            "class_templates": [template_row("template-1", "Youth Basics")],
            "class_sessions": [],
        })
        service = ScheduleService(supabase)

        sessions = asyncio.run(service.list_sessions("studio-1", "2026-05-24", "2026-05-24"))

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].template_id, "template-1")
        self.assertEqual(sessions[0].date, "2026-05-24")
        self.assertEqual(sessions[0].attendance_count, 0)
        self.assertEqual(
            [(row["template_id"], row["date"]) for row in supabase.tables["class_sessions"]],
            [("template-1", "2026-05-24")],
        )

    def test_list_sessions_surfaces_generated_recurring_session_with_one_off_session(self):
        supabase = FakeSupabase({
            "class_templates": [template_row("template-1", "Youth Basics")],
            "class_sessions": [
                {
                    "id": "one-off-session",
                    "studio_id": "studio-1",
                    "template_id": None,
                    "name": "Makeup Class",
                    "date": "2026-05-24",
                    "start_time": "11:00",
                    "end_time": "12:00",
                    "instructor_id": None,
                    "program_id": None,
                    "capacity": 8,
                    "status": "scheduled",
                    "notes": None,
                    "created_at": "2026-05-24T12:00:00Z",
                    "deleted_at": None,
                },
            ],
            "attendance": [
                {
                    "id": "attendance-1",
                    "studio_id": "studio-1",
                    "session_id": "one-off-session",
                    "student_id": "student-1",
                    "status": "present",
                },
            ],
        })
        service = ScheduleService(supabase)

        sessions = asyncio.run(service.list_sessions("studio-1", "2026-05-24", "2026-05-24"))

        self.assertEqual(
            [(session.name, session.template_id, session.date, session.attendance_count) for session in sessions],
            [
                ("Youth Basics", "template-1", "2026-05-24", 0),
                ("Makeup Class", None, "2026-05-24", 1),
            ],
        )
        self.assertEqual(len(supabase.tables["class_sessions"]), 2)

    def test_list_sessions_rejects_ranges_above_visible_cap(self):
        supabase = FakeSupabase({
            "class_templates": [template_row("template-1", "Youth Basics")],
            "class_sessions": [],
        })
        service = ScheduleService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.list_sessions("studio-1", "2026-01-01", "2026-05-01"))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn(
            f"cannot exceed {SCHEDULE_SESSION_LIST_RANGE_MAX_DAYS} days",
            context.exception.detail,
        )
        self.assertEqual(supabase.tables["class_sessions"], [])

    def test_list_sessions_returns_existing_persisted_sessions(self):
        supabase = FakeSupabase({
            "class_sessions": [
                session_row("session-1", "template-1", "2026-05-24"),
            ],
            "attendance": [
                {
                    "id": "attendance-1",
                    "studio_id": "studio-1",
                    "session_id": "session-1",
                    "student_id": "student-1",
                    "status": "present",
                },
                {
                    "id": "attendance-2",
                    "studio_id": "studio-1",
                    "session_id": "session-1",
                    "student_id": "student-2",
                    "status": "absent",
                },
            ],
        })
        selected_columns: list[str] = []
        supabase.select_assertions["class_sessions"] = selected_columns.append
        service = ScheduleService(supabase)

        sessions = asyncio.run(service.list_sessions("studio-1", "2026-05-24", "2026-05-24"))

        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].id, "session-1")
        self.assertEqual(sessions[0].attendance_count, 1)
        self.assertIn(CLASS_SESSION_LIST_SELECT, selected_columns)

    def test_list_attendance_rejects_ranges_above_visible_cap(self):
        supabase = FakeSupabase({"attendance": [], "class_sessions": []})
        service = ScheduleService(supabase)

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.list_attendance("studio-1", "2026-01-01", "2026-05-01"))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn(
            f"cannot exceed {ATTENDANCE_LIST_RANGE_MAX_DAYS} days",
            context.exception.detail,
        )
        self.assertFalse(
            any(query["table"] == "attendance" for query in supabase.query_log)
        )

    def test_list_attendance_rejects_oversized_session_id_list(self):
        supabase = FakeSupabase({"attendance": [], "class_sessions": []})
        service = ScheduleService(supabase)
        session_ids = [f"session-{index}" for index in range(ATTENDANCE_SESSION_IDS_MAX + 1)]

        with self.assertRaises(HTTPException) as context:
            asyncio.run(service.list_attendance("studio-1", session_ids=session_ids))

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn(
            f"session_ids cannot exceed {ATTENDANCE_SESSION_IDS_MAX} values",
            context.exception.detail,
        )
        self.assertFalse(
            any(query["table"] == "attendance" for query in supabase.query_log)
        )

    def test_generate_week_uses_actor_for_created_session_audit(self):
        supabase = FakeSupabase({
            "class_templates": [template_row("template-1", "Youth Basics")],
            "class_sessions": [],
            "audit_logs": [],
        })
        service = ScheduleService(supabase)

        created = asyncio.run(service.generate_sessions_for_week("studio-1", "2026-05-25", "actor-1"))

        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].date, "2026-05-31")
        self.assertEqual(supabase.tables["audit_logs"][0]["actor_id"], "actor-1")
        self.assertEqual(supabase.tables["audit_logs"][0]["action"], "class_session.created")

    def test_generate_week_rejects_bad_week_start_before_querying(self):
        for week_start, detail in (
            ("not-a-date", "week_start must be in YYYY-MM-DD format"),
            ("2026-05-26", "week_start must be a Monday"),
        ):
            with self.subTest(week_start=week_start):
                supabase = FakeSupabase({"class_templates": [], "class_sessions": []})
                service = ScheduleService(supabase)

                with self.assertRaises(HTTPException) as context:
                    asyncio.run(service.generate_sessions_for_week("studio-1", week_start, "actor-1"))

                self.assertEqual(context.exception.status_code, 400)
                self.assertEqual(context.exception.detail, detail)
                self.assertFalse(supabase.query_log)

    def test_delete_future_series_sets_template_end_before_deleted_session(self):
        supabase = FakeSupabase({
            "class_templates": [template_row("template-1", "Youth Basics")],
            "class_sessions": [
                session_row("past-session", "template-1", "2026-05-24"),
                session_row("selected-session", "template-1", "2026-05-31"),
                session_row("future-session", "template-1", "2026-06-07"),
            ],
            "audit_logs": [],
        })
        service = ScheduleService(supabase)

        asyncio.run(service.delete_session(
            "selected-session",
            "studio-1",
            "actor-1",
            "future_series",
        ))

        template = supabase.tables["class_templates"][0]
        self.assertFalse(template["is_active"])
        self.assertEqual(template["end_date"], "2026-05-30")

        sessions = {row["id"]: row for row in supabase.tables["class_sessions"]}
        self.assertIsNone(sessions["past-session"]["deleted_at"])
        self.assertEqual(sessions["past-session"]["status"], "scheduled")
        self.assertIsNotNone(sessions["selected-session"]["deleted_at"])
        self.assertEqual(sessions["selected-session"]["status"], "canceled")
        self.assertIsNotNone(sessions["future-session"]["deleted_at"])
        self.assertEqual(sessions["future-session"]["status"], "canceled")

        audit = supabase.tables["audit_logs"][0]
        self.assertEqual(audit["action"], "class_series.deleted")
        self.assertEqual(audit["metadata"]["start_date"], "2026-05-31")
        self.assertEqual(
            [name for name, _params in supabase.rpc_calls],
            ["delete_recurring_class_series_atomic"],
        )
        direct_writes = [
            query
            for query in supabase.query_log
            if query["table"] in {"class_templates", "class_sessions", "audit_logs"}
            and (query["update"] is not None or query["insert"] is not None)
        ]
        self.assertEqual(direct_writes, [])

    def test_check_in_rejects_canceled_or_deleted_session(self):
        for session_row in (
            {
                "id": "session-canceled",
                "studio_id": "studio-1",
                "program_id": None,
                "status": "canceled",
                "deleted_at": None,
            },
            {
                "id": "session-deleted",
                "studio_id": "studio-1",
                "program_id": None,
                "status": "scheduled",
                "deleted_at": "2026-05-24T12:00:00Z",
            },
        ):
            with self.subTest(session_id=session_row["id"]):
                supabase = FakeSupabase({
                    "attendance": [],
                    "class_sessions": [session_row],
                    "students": [{"id": "student-1", "studio_id": "studio-1"}],
                })
                service = ScheduleService(supabase)

                with self.assertRaises(HTTPException) as context:
                    asyncio.run(service.check_in(
                        AttendanceCheckIn(
                            session_id=session_row["id"],
                            student_id="student-1",
                        ),
                        "studio-1",
                        "actor-1",
                    ))

                self.assertEqual(context.exception.status_code, 409)
                self.assertEqual(supabase.tables["attendance"], [])


if __name__ == "__main__":
    unittest.main()
