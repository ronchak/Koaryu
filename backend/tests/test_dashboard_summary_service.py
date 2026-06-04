import asyncio
import unittest
from datetime import date
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.schemas.auth import AuthResponse, UserProfile
from app.schemas.dashboard_summary import DashboardSummaryTestReadinessCounts
from app.services.dashboard_summary_service import DashboardSummaryService, PRIVATE_VARY
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
STUDENT_PII_COLUMNS = {"email", "phone", "notes", "photo_path", "photo_url", "guardians"}


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
        studio_id=studio_id,
        role=role,
    )


class DashboardSummaryServiceTest(unittest.TestCase):
    def test_private_vary_includes_cookie_for_cookie_studio_selection(self):
        self.assertEqual(PRIVATE_VARY, "Authorization, X-Studio-Id, Cookie")

    def build_service(self, tables):
        service = DashboardSummaryService(FakeSupabase(tables))
        service._test_readiness_counts = lambda _studio_id: DashboardSummaryTestReadinessCounts(
            ready_to_test=2,
            needs_approval=1,
            available=True,
        )
        return service

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

    def base_tables(self):
        today = "2026-05-20"
        return {
            "students": [
                {"id": f"s-{index}", "studio_id": "studio-1", "legal_first_name": f"Student{index}", "legal_last_name": "One", "preferred_name": None, "status": "active", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-01-01", "created_at": "2026-01-01T00:00:00Z", "deleted_at": None}
                for index in range(250)
            ] + [
                {"id": "trial", "studio_id": "studio-1", "legal_first_name": "Trial", "legal_last_name": "One", "preferred_name": None, "status": "trialing", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-05-10", "created_at": "2026-05-10T00:00:00Z", "deleted_at": None},
                {"id": "paused", "studio_id": "studio-1", "legal_first_name": "Paused", "legal_last_name": "One", "preferred_name": None, "status": "paused", "hold_start_date": today, "hold_end_date": None, "membership_start_date": "2026-04-01", "created_at": "2026-04-01T00:00:00Z", "deleted_at": None},
                {"id": "inactive", "studio_id": "studio-1", "legal_first_name": "Inactive", "legal_last_name": "One", "preferred_name": None, "status": "inactive", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2025-01-01", "created_at": "2025-01-01T00:00:00Z", "deleted_at": None},
                {"id": "canceled", "studio_id": "studio-1", "legal_first_name": "Canceled", "legal_last_name": "One", "preferred_name": None, "status": "canceled", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2025-01-01", "created_at": "2025-01-01T00:00:00Z", "deleted_at": None},
                {"id": "deleted", "studio_id": "studio-1", "legal_first_name": "Deleted", "legal_last_name": "One", "preferred_name": None, "status": "active", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-01-01", "created_at": "2026-01-01T00:00:00Z", "deleted_at": "2026-05-01T00:00:00Z"},
                {"id": "other-studio", "studio_id": "studio-2", "legal_first_name": "Other", "legal_last_name": "Studio", "preferred_name": None, "status": "active", "hold_start_date": None, "hold_end_date": None, "membership_start_date": "2026-01-01", "created_at": "2026-01-01T00:00:00Z", "deleted_at": None},
            ],
            "leads": [
                {"id": "lead-1", "studio_id": "studio-1", "stage": "inquiry", "follow_up_date": today},
                {"id": "lead-2", "studio_id": "studio-1", "stage": "enrolled", "follow_up_date": today},
                {"id": "lead-other", "studio_id": "studio-2", "stage": "inquiry", "follow_up_date": today},
            ],
            "class_sessions": [
                {"id": "live-session", "studio_id": "studio-1", "template_id": "template-live", "date": today, "status": "scheduled", "deleted_at": None, "capacity": 10},
                {"id": "canceled-session", "studio_id": "studio-1", "template_id": "template-canceled", "date": today, "status": "canceled", "deleted_at": None, "capacity": 10},
                {"id": "deleted-session", "studio_id": "studio-1", "template_id": "template-deleted", "date": today, "status": "scheduled", "deleted_at": "2026-05-20T01:00:00Z", "capacity": 10},
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
        self.assertEqual(summary.students.active_students, 251)
        self.assertEqual(summary.students.trialing_students, 1)
        self.assertEqual(summary.students.on_hold_students, 1)
        self.assertEqual(summary.leads.active_leads, 1)
        self.assertEqual(summary.leads.enrolled_leads, 1)
        self.assertEqual(summary.billing.payment_attention_count, 3)
        self.assertEqual(summary.belts.belt_count, 1)
        self.assertEqual(summary.belts.tip_count, 1)
        self.assertEqual(summary.recent_students[0].display_name.startswith("Trial"), True)
        self.assertFalse(hasattr(summary.recent_students[0], "email"))

    def test_today_class_count_is_template_aware_without_resurrecting_tombstones(self):
        service = self.build_service(self.base_tables())

        count = service._today_class_count("studio-1", date(2026, 5, 20))

        self.assertEqual(count, 2)

    def test_instructor_billing_is_redacted(self):
        service = self.build_service(self.base_tables())

        summary, _timings = service._build_summary_sync(
            auth_response(role="instructor"),
            {"id": "studio-1", "name": "River City", "timezone": "America/Los_Angeles"},
            today_override=date(2026, 5, 20),
        )

        self.assertFalse(summary.billing.can_view_billing)
        self.assertIsNone(summary.billing.payment_attention_count)
        self.assertIsNone(summary.billing.has_plans)
        self.assertIsNone(summary.billing.payments_ready)

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


if __name__ == "__main__":
    unittest.main()
