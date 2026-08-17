import asyncio
import unittest
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Response

from app.api.v1.endpoints.dashboard import _set_private_dashboard_headers
from app.main import app
from app.schemas.auth import AuthResponse, UserProfile
from app.schemas.dashboard_summary import (
    DashboardSummaryTestReadinessCounts,
    DashboardSummaryTodaySchedule,
    DashboardSummaryTodaySession,
)
from app.services.dashboard_summary_service import (
    PRIVATE_CACHE_CONTROL,
    PRIVATE_VARY,
    DashboardSummaryService,
)
from app.services.dashboard_summary_store import DashboardSummaryStore
from tests.fakes.supabase import TableBackedSupabase


PROTECTED_TABLES = {
    "attendance",
    "belt_ladders",
    "belt_ranks",
    "billing_invoices",
    "billing_payers",
    "billing_plans",
    "class_sessions",
    "class_templates",
    "programs",
    "students",
    "studio_payment_accounts",
}
STUDENT_PII_COLUMNS = {
    "email",
    "emergency_contact_phone",
    "emergency_contact_relation",
    "guardians",
    "notes",
    "phone",
    "photo_path",
    "photo_url",
}


def assert_dashboard_student_columns(columns: str) -> None:
    selected = {part.strip() for part in columns.split(",")}
    if "*" in selected:
        raise AssertionError("Dashboard summary must not select full student rows.")
    leaked_columns = selected.intersection(STUDENT_PII_COLUMNS)
    if leaked_columns:
        raise AssertionError(f"Dashboard summary selected student PII columns: {sorted(leaked_columns)}")


class FakeSupabase(TableBackedSupabase):
    def __init__(self, tables):
        super().__init__(tables)
        self.required_eq_filters = {table: {"studio_id"} for table in PROTECTED_TABLES}
        self.select_assertions["students"] = assert_dashboard_student_columns


def auth_response(role="admin", studio_id="studio-1"):
    return AuthResponse(
        user=UserProfile(id="user-1", email="owner@example.com", full_name="Owner"),
        staff_profiles_available=True,
        studio_id=studio_id,
        role=role,
    )


class DashboardSummaryServiceTest(unittest.TestCase):
    def test_summary_get_has_no_body_and_private_headers_include_cookie(self):
        self.assertEqual(PRIVATE_VARY, "Authorization, X-Studio-Id, Cookie")
        self.assertEqual(PRIVATE_CACHE_CONTROL, "no-store, private")

        response = Response()
        _set_private_dashboard_headers(response)
        self.assertEqual(response.headers["Cache-Control"], "no-store, private")
        self.assertEqual(response.headers["Vary"], "Authorization, X-Studio-Id, Cookie")

        operation = app.openapi()["paths"]["/api/v1/dashboard/summary"]["get"]
        self.assertNotIn("requestBody", operation)

    def build_service(self, tables):
        service = DashboardSummaryService(FakeSupabase(tables))
        service._test_readiness_counts = lambda _studio_id: DashboardSummaryTestReadinessCounts(
            ready_to_test=2,
            needs_approval=1,
            available=True,
        )
        return service

    def fully_materialized_tables(self):
        tables = self.base_tables()
        tables["class_sessions"].append({
            "id": "generated-session",
            "studio_id": "studio-1",
            "template_id": "template-generated",
            "name": "Advanced Class",
            "date": "2026-05-20",
            "start_time": "18:00:00",
            "end_time": "19:00:00",
            "status": "scheduled",
            "deleted_at": None,
            "capacity": 12,
        })
        return tables

    def test_test_readiness_counts_defers_full_eligibility_engine(self):
        fake_supabase = FakeSupabase({
            "attendance": [{"id": "attendance-1", "studio_id": "studio-1"}],
            "promotions": [{"id": "promotion-1", "studio_id": "studio-1"}],
            "student_program_memberships": [{"id": "membership-1", "studio_id": "studio-1"}],
        })
        service = DashboardSummaryService(fake_supabase)

        counts = service._test_readiness_counts("studio-1")

        self.assertFalse(counts.available)
        self.assertIsNone(counts.ready_to_test)
        self.assertIsNone(counts.needs_approval)
        self.assertEqual(fake_supabase.log, [])

    def test_today_schedule_schema_enforces_the_five_row_contract(self):
        row = DashboardSummaryTodaySession(
            id="session-1",
            start_time="09:00:00",
            end_time="10:00:00",
            name="Fundamentals",
        )

        with self.assertRaises(ValueError):
            DashboardSummaryTodaySchedule(available=True, rows=[row] * 6)

    def base_tables(self):
        today = "2026-05-20"
        return {
            "students": [
                {"id": f"s-{index}", "studio_id": "studio-1", "legal_first_name": f"Student{index}", "legal_last_name": "One", "preferred_name": None, "status": "active", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-01-01", "created_at": "2026-01-01T00:00:00Z", "deleted_at": None, "emergency_contact_name": None if index == 248 else "" if index == 249 else f"Contact {index}"}
                for index in range(250)
            ] + [
                {"id": "trial", "studio_id": "studio-1", "legal_first_name": "Trial", "legal_last_name": "One", "preferred_name": None, "status": "trialing", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-05-10", "created_at": "2026-05-10T00:00:00Z", "deleted_at": None, "emergency_contact_name": "Trial Contact"},
                {"id": "paused", "studio_id": "studio-1", "legal_first_name": "Paused", "legal_last_name": "One", "preferred_name": None, "status": "paused", "hold_start_date": today, "hold_end_date": None, "membership_start_date": "2026-04-01", "created_at": "2026-04-01T00:00:00Z", "deleted_at": None, "emergency_contact_name": "Paused Contact"},
                {"id": "inactive", "studio_id": "studio-1", "legal_first_name": "Inactive", "legal_last_name": "One", "preferred_name": None, "status": "inactive", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2025-01-01", "created_at": "2025-01-01T00:00:00Z", "deleted_at": None},
                {"id": "canceled", "studio_id": "studio-1", "legal_first_name": "Canceled", "legal_last_name": "One", "preferred_name": None, "status": "canceled", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2025-01-01", "created_at": "2025-01-01T00:00:00Z", "deleted_at": None},
                {"id": "deleted", "studio_id": "studio-1", "legal_first_name": "Deleted", "legal_last_name": "One", "preferred_name": None, "status": "active", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-01-01", "created_at": "2026-01-01T00:00:00Z", "deleted_at": "2026-05-01T00:00:00Z", "emergency_contact_name": "Deleted Contact"},
                {"id": "other-studio", "studio_id": "studio-2", "legal_first_name": "Other", "legal_last_name": "Studio", "preferred_name": None, "status": "active", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-01-01", "created_at": "2026-01-01T00:00:00Z", "deleted_at": None, "emergency_contact_name": "Other Contact"},
            ],
            "leads": [
                {"id": "lead-1", "studio_id": "studio-1", "stage": "inquiry", "follow_up_date": today},
                {"id": "lead-2", "studio_id": "studio-1", "stage": "enrolled", "follow_up_date": today},
                {"id": "lead-other", "studio_id": "studio-2", "stage": "inquiry", "follow_up_date": today},
            ],
            "class_sessions": [
                {"id": "live-session", "studio_id": "studio-1", "template_id": "template-live", "name": "Beginner Class", "date": today, "start_time": "09:00:00", "end_time": "10:00:00", "status": "scheduled", "deleted_at": None, "capacity": 10},
                {"id": "canceled-session", "studio_id": "studio-1", "template_id": "template-canceled", "name": "Canceled Class", "date": today, "start_time": "11:00:00", "end_time": "12:00:00", "status": "canceled", "deleted_at": None, "capacity": 10},
                {"id": "deleted-session", "studio_id": "studio-1", "template_id": "template-deleted", "name": "Deleted Class", "date": today, "start_time": "13:00:00", "end_time": "14:00:00", "status": "scheduled", "deleted_at": "2026-05-20T01:00:00Z", "capacity": 10},
            ],
            "class_templates": [
                {"id": "template-live", "studio_id": "studio-1", "day_of_week": 3, "start_date": "2026-01-01", "end_date": None, "is_active": True},
                {"id": "template-canceled", "studio_id": "studio-1", "day_of_week": 3, "start_date": "2026-01-01", "end_date": None, "is_active": True},
                {"id": "template-deleted", "studio_id": "studio-1", "day_of_week": 3, "start_date": "2026-01-01", "end_date": None, "is_active": True},
                {"id": "template-generated", "studio_id": "studio-1", "day_of_week": 3, "start_date": "2026-01-01", "end_date": None, "is_active": True},
            ],
            "attendance": [
                {"id": "a-1", "studio_id": "studio-1", "student_id": "s-0", "session_id": "live-session", "status": "present", "checked_in_at": "2026-05-19T12:00:00Z"},
            ],
            "programs": [
                {"id": "program-1", "studio_id": "studio-1", "is_system": False, "archived_at": None},
                {"id": "program-system", "studio_id": "studio-1", "is_system": True, "archived_at": None},
            ],
            "belt_ladders": [
                {"id": "ladder-1", "studio_id": "studio-1", "program_id": "program-1"},
            ],
            "belt_ranks": [
                {"id": "rank-1", "studio_id": "studio-1", "ladder_id": "ladder-1", "is_tip": False},
                {"id": "tip-1", "studio_id": "studio-1", "ladder_id": "ladder-1", "is_tip": True},
            ],
            "billing_payers": [
                {"id": "payer-1", "studio_id": "studio-1", "billing_status": "past_due"},
                {"id": "payer-other", "studio_id": "studio-2", "billing_status": "past_due"},
            ],
            "billing_invoices": [
                {"id": "invoice-1", "studio_id": "studio-1", "status": "open", "due_date": today},
                {"id": "invoice-2", "studio_id": "studio-1", "status": "uncollectible", "due_date": None},
                {"id": "invoice-other", "studio_id": "studio-2", "status": "uncollectible", "due_date": None},
            ],
            "billing_plans": [
                {"id": "plan-1", "studio_id": "studio-1", "archived_at": None},
            ],
            "studio_payment_accounts": [
                {"studio_id": "studio-1", "charges_enabled": True},
            ],
        }

    def test_summary_uses_exact_full_studio_counts_and_excludes_deleted_cross_tenant_rows(self):
        service = self.build_service(self.base_tables())

        summary, _timings = service._build_summary_sync(
            auth_response(role="admin"),
            {"id": "studio-1", "name": "River City", "timezone": "America/Los_Angeles"},
            today_override=date(2026, 5, 20),
        )

        self.assertEqual(summary.students.total_students, 254)
        self.assertEqual(summary.today, "2026-05-20")
        self.assertEqual(summary.timezone, "America/Los_Angeles")
        self.assertIsNotNone(datetime.fromisoformat(summary.generated_at))
        self.assertEqual(summary.students.active_students, 251)
        self.assertEqual(summary.students.trialing_students, 1)
        self.assertEqual(summary.students.on_hold_students, 1)
        self.assertEqual(summary.leads.active_leads, 1)
        self.assertEqual(summary.leads.enrolled_leads, 1)
        self.assertEqual(summary.billing.payment_attention_count, 3)
        self.assertEqual(summary.belts.belt_count, 1)
        self.assertEqual(summary.belts.tip_count, 1)
        self.assertTrue(summary.emergency_contacts.available)
        self.assertEqual(summary.emergency_contacts.active_students, 251)
        self.assertEqual(summary.emergency_contacts.students_with_contact_name, 249)
        self.assertEqual(summary.emergency_contacts.students_missing_contact_name, 2)
        self.assertEqual(summary.recent_students[0].display_name.startswith("Trial"), True)
        self.assertFalse(hasattr(summary.recent_students[0], "email"))

        student_scan_queries = [
            entry
            for entry in service.supabase.log
            if entry["table"] == "students"
            and entry["range"] is not None
        ]
        self.assertEqual(len(student_scan_queries), 1)
        selected_student_columns = {
            column.strip() for column in student_scan_queries[0]["columns"].split(",")
        }
        self.assertIn("emergency_contact_name", selected_student_columns)
        self.assertNotIn("emergency_contact_phone", selected_student_columns)
        self.assertNotIn("emergency_contact_relation", selected_student_columns)
        self.assertIn(("eq", "studio_id", "studio-1"), student_scan_queries[0]["filters"])
        self.assertIn(("is", "deleted_at", "null"), student_scan_queries[0]["filters"])
        self.assertFalse(any(
            entry["table"] == "students"
            and any(key == "emergency_contact_name" for _operation, key, _value in entry["filters"])
            for entry in service.supabase.log
        ))
        self.assertEqual(len(service.supabase.log), 29)

        serialized = summary.model_dump(mode="json")
        self.assertTrue({
            "auth",
            "studio",
            "generated_at",
            "today",
            "timezone",
            "students",
            "leads",
            "schedule",
            "belts",
            "inactivity",
            "new_students",
            "operational",
            "churn",
            "test_readiness",
            "billing",
            "setup",
            "recent_students",
            "actions",
        }.issubset(serialized))
        self.assertEqual(
            {"payment_attention_count", "has_plans", "payments_ready"}
            - serialized["billing"].keys(),
            set(),
        )

    def test_today_is_unavailable_when_template_is_unmaterialized_without_resurrecting_tombstones(self):
        service = self.build_service(self.base_tables())

        schedule, today_schedule = service._today_schedule("studio-1", date(2026, 5, 20))

        self.assertEqual(schedule.today_sessions, 2)
        self.assertFalse(today_schedule.available)
        self.assertFalse(today_schedule.expected_counts_available)
        self.assertEqual(today_schedule.rows, [])
        self.assertIsNone(today_schedule.overflow_count)
        self.assertNotIn("overflow_count", today_schedule.model_dump(mode="json"))
        self.assertFalse(any(entry["table"] == "attendance" for entry in service.supabase.log))

        session_query = next(entry for entry in service.supabase.log if entry["table"] == "class_sessions")
        self.assertEqual(
            session_query["columns"],
            "id, template_id, name, start_time, end_time, capacity, status, deleted_at",
        )
        self.assertIn(("gte", "date", "2026-05-20"), session_query["filters"])
        self.assertIn(("lt", "date", "2026-05-21"), session_query["filters"])

    def test_billing_amounts_role_omission_and_query_ceilings(self):
        billing_tables = {
            "billing_invoices",
            "billing_payers",
            "billing_plans",
            "studio_payment_accounts",
        }
        role_expectations = {
            "admin": (30, True),
            "front_desk": (30, True),
            "instructor": (25, False),
            None: (25, False),
        }

        for role, (ceiling, can_view_billing) in role_expectations.items():
            with self.subTest(role=role):
                service = self.build_service(self.fully_materialized_tables())
                summary, _timings = service._build_summary_sync(
                    auth_response(role=role),
                    {"id": "studio-1", "name": "River City", "timezone": "America/Los_Angeles"},
                    today_override=date(2026, 5, 20),
                )

                serialized_billing = summary.model_dump(mode="json")["billing"]
                billing_reads = [
                    entry for entry in service.supabase.log if entry["table"] in billing_tables
                ]
                self.assertEqual(len(service.supabase.log), ceiling)
                self.assertTrue(summary.today_schedule.available)
                self.assertEqual(
                    [row.id for row in summary.today_schedule.rows],
                    ["live-session", "generated-session"],
                )
                self.assertEqual(summary.schedule.today_sessions, 2)
                self.assertEqual(summary.billing.can_view_billing, can_view_billing)
                if can_view_billing:
                    self.assertEqual(len(billing_reads), 5)
                    self.assertEqual(serialized_billing["amounts"], {"available": False})
                else:
                    self.assertEqual(billing_reads, [])
                    self.assertNotIn("amounts", serialized_billing)
                    self.assertIsNone(serialized_billing["payment_attention_count"])
                    self.assertIsNone(serialized_billing["has_plans"])
                    self.assertIsNone(serialized_billing["payments_ready"])

                for query in service.supabase.log:
                    if query["table"] in PROTECTED_TABLES:
                        self.assertIn(("eq", "studio_id", "studio-1"), query["filters"])

    def test_today_returns_five_stably_sorted_rows_and_one_batched_attendance_query(self):
        session_specs = [
            ("session-z", "10:00:00"),
            ("session-b", "09:00:00"),
            ("session-a", "09:00:00"),
            ("session-early", "08:00:00"),
            ("session-late", "12:00:00"),
            ("session-mid", "11:00:00"),
        ]
        tables = self.base_tables()
        tables["class_templates"] = []
        tables["class_sessions"] = [
            {
                "id": session_id,
                "studio_id": "studio-1",
                "template_id": None,
                "name": f"Class {session_id}",
                "date": "2026-05-20",
                "start_time": start_time,
                "end_time": "13:00:00",
                "status": "scheduled",
                "deleted_at": None,
                "capacity": 20,
            }
            for session_id, start_time in session_specs
        ] + [{
            "id": "tomorrow-session",
            "studio_id": "studio-1",
            "template_id": None,
            "name": "Tomorrow",
            "date": "2026-05-21",
            "start_time": "07:00:00",
            "end_time": "08:00:00",
            "status": "scheduled",
            "deleted_at": None,
            "capacity": 20,
        }]
        tables["attendance"] = [
            {"id": "today-attendance", "studio_id": "studio-1", "student_id": "s-0", "session_id": "session-early", "status": "present", "checked_in_at": "2026-05-20T15:00:00Z"},
            {"id": "absent-attendance", "studio_id": "studio-1", "student_id": "s-1", "session_id": "session-early", "status": "absent", "checked_in_at": "2026-05-20T15:00:00Z"},
            {"id": "overflow-attendance", "studio_id": "studio-1", "student_id": "s-2", "session_id": "session-late", "status": "present", "checked_in_at": "2026-05-20T15:00:00Z"},
            {"id": "other-studio-attendance", "studio_id": "studio-2", "student_id": "s-3", "session_id": "session-early", "status": "present", "checked_in_at": "2026-05-20T15:00:00Z"},
        ]
        service = self.build_service(tables)

        schedule, today_schedule = service._today_schedule("studio-1", date(2026, 5, 20))

        self.assertEqual(schedule.today_sessions, 6)
        self.assertTrue(today_schedule.available)
        self.assertFalse(today_schedule.expected_counts_available)
        self.assertEqual(today_schedule.overflow_count, 1)
        self.assertEqual(
            [row.id for row in today_schedule.rows],
            ["session-early", "session-a", "session-b", "session-z", "session-mid"],
        )
        self.assertEqual(today_schedule.rows[0].attendance_count, 1)
        self.assertIsNone(today_schedule.rows[0].expected_count)
        self.assertNotIn("expected_count", today_schedule.rows[0].model_dump(mode="json"))

        attendance_queries = [entry for entry in service.supabase.log if entry["table"] == "attendance"]
        self.assertEqual(len(attendance_queries), 1)
        attendance_query = attendance_queries[0]
        self.assertEqual(attendance_query["columns"], "session_id")
        self.assertIn(("eq", "studio_id", "studio-1"), attendance_query["filters"])
        self.assertIn(("neq", "status", "absent"), attendance_query["filters"])
        requested_ids = next(
            value
            for operation, key, value in attendance_query["filters"]
            if operation == "in" and key == "session_id"
        )
        self.assertEqual(requested_ids, {row.id for row in today_schedule.rows})
        self.assertNotIn("session-late", requested_ids)

    def test_empty_today_is_available_and_malformed_live_row_degrades_only_today(self):
        tables = self.base_tables()
        tables["class_templates"] = []
        tables["class_sessions"] = []
        service = self.build_service(tables)

        schedule, today_schedule = service._today_schedule("studio-1", date(2026, 5, 20))

        self.assertEqual(schedule.today_sessions, 0)
        self.assertTrue(today_schedule.available)
        self.assertEqual(today_schedule.rows, [])
        self.assertEqual(today_schedule.overflow_count, 0)
        self.assertFalse(any(entry["table"] == "attendance" for entry in service.supabase.log))

        malformed_tables = self.base_tables()
        malformed_tables["class_templates"] = []
        malformed_tables["class_sessions"] = [{
            "id": "malformed-session",
            "studio_id": "studio-1",
            "template_id": None,
            "name": "",
            "date": "2026-05-20",
            "start_time": "not-a-time",
            "end_time": "10:00:00",
            "status": "scheduled",
            "deleted_at": None,
            "capacity": 10,
        }]
        malformed_service = self.build_service(malformed_tables)

        malformed_schedule, malformed_today = malformed_service._today_schedule(
            "studio-1",
            date(2026, 5, 20),
        )

        self.assertEqual(malformed_schedule.today_sessions, 1)
        self.assertFalse(malformed_today.available)
        self.assertEqual(malformed_today.rows, [])
        self.assertFalse(any(entry["table"] == "attendance" for entry in malformed_service.supabase.log))

    def test_studio_today_uses_valid_timezone_and_falls_back_to_utc(self):
        local_today, local_timezone = DashboardSummaryService._studio_today("America/Los_Angeles")
        utc_today, utc_timezone = DashboardSummaryService._studio_today("Not/A-Timezone")
        malformed_today, malformed_timezone = DashboardSummaryService._studio_today("../timezone")

        self.assertEqual(local_timezone, "America/Los_Angeles")
        self.assertEqual(local_today, datetime.now(ZoneInfo("America/Los_Angeles")).date())
        self.assertEqual(utc_timezone, "UTC")
        self.assertEqual(utc_today, datetime.now(timezone.utc).date())
        self.assertEqual(malformed_timezone, "UTC")
        self.assertEqual(malformed_today, datetime.now(timezone.utc).date())

    def test_no_studio_summary_does_not_read_protected_tables(self):
        fake_supabase = FakeSupabase({"students": [{"id": "should-not-read", "studio_id": "studio-1"}]})
        service = DashboardSummaryService(fake_supabase)
        auth = auth_response(studio_id=None)

        with patch(
            "app.services.dashboard_summary_service.AuthService.get_user_profile",
            new=AsyncMock(return_value=auth),
        ), patch(
            "app.services.dashboard_summary_service.ensure_platform_subscription_access"
        ) as ensure_access:
            summary, _timings = asyncio.run(service.get_dashboard_summary("user-1"))

        self.assertIsNone(summary.studio)
        self.assertEqual(fake_supabase.log, [])
        ensure_access.assert_not_called()
        serialized = summary.model_dump(mode="json")
        self.assertNotIn("today_schedule", serialized)
        self.assertNotIn("emergency_contacts", serialized)
        self.assertNotIn("amounts", serialized["billing"])
        self.assertIn("studio", serialized)
        self.assertIsNone(serialized["studio"])
        self.assertIn("today", serialized)
        self.assertIsNone(serialized["today"])

    def test_subscription_gate_runs_before_protected_summary_reads(self):
        fake_supabase = FakeSupabase(self.base_tables())
        service = DashboardSummaryService(fake_supabase)

        with patch(
            "app.services.dashboard_summary_service.AuthService.get_user_profile",
            new=AsyncMock(return_value=auth_response()),
        ), patch(
            "app.services.dashboard_summary_service.ensure_platform_subscription_access",
            side_effect=HTTPException(status_code=402, detail="subscription required"),
        ):
            with self.assertRaises(HTTPException):
                asyncio.run(service.get_dashboard_summary("user-1"))

        self.assertEqual(fake_supabase.log, [])

    def test_summary_store_uses_stable_order_for_ranged_fetches(self):
        fake_supabase = FakeSupabase({
            "students": [
                {"id": "student-b", "studio_id": "studio-1"},
                {"id": "student-a", "studio_id": "studio-1"},
            ],
        })
        store = DashboardSummaryStore(fake_supabase)

        rows = store.fetch_rows(
            "students",
            "id, studio_id",
            lambda query: query.eq("studio_id", "studio-1"),
            page_size=1,
        )

        self.assertEqual([row["id"] for row in rows], ["student-a", "student-b"])
        student_fetches = [
            entry
            for entry in fake_supabase.log
            if entry["table"] == "students" and entry["range"] is not None
        ]
        self.assertTrue(student_fetches)
        self.assertTrue(all(("id", False) in entry["orders"] for entry in student_fetches))

    def test_summary_store_fetch_one_handles_empty_maybe_single_response(self):
        fake_supabase = MagicMock()
        maybe_single_query = fake_supabase.table.return_value.select.return_value.maybe_single.return_value
        maybe_single_query.execute.return_value = None
        store = DashboardSummaryStore(fake_supabase)

        row = store.fetch_one("studio_payment_accounts", "studio_id", lambda query: query)

        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
