from datetime import date
from typing import Any, Callable, Optional

from supabase import Client

from app.schemas.dashboard_summary import (
    DashboardSummaryBeltCounts,
    DashboardSummaryBillingCounts,
    DashboardSummaryChurnCounts,
    DashboardSummaryLeadCounts,
    DashboardSummaryNewStudentCounts,
    DashboardSummaryRecentStudent,
    DashboardSummaryScheduleCounts,
    DashboardSummarySetupFlags,
    DashboardSummaryStudentCounts,
)
from app.services.dashboard_summary_attendance import (
    ACTIVE_STUDENT_STATUSES,
    DashboardSummaryAttendanceMetrics,
)
from app.services.dashboard_summary_store import DashboardSummaryStore


BILLING_VISIBLE_ROLES = {"admin", "front_desk"}
ACTIVE_LEAD_STAGES = ["inquiry", "trial_scheduled", "trial_completed", "offer_sent"]


class DashboardSummaryCounts:
    def __init__(self, supabase: Client, store: DashboardSummaryStore):
        self.supabase = supabase
        self.store = store

    @staticmethod
    def _is_student_on_hold_now(row: dict[str, Any], today: date) -> bool:
        return DashboardSummaryAttendanceMetrics._is_student_on_hold_now(row, today)

    @staticmethod
    def _student_start_date(row: dict[str, Any]) -> Optional[date]:
        return DashboardSummaryAttendanceMetrics._student_start_date(row)

    @staticmethod
    def _build_recent_student(row: dict[str, Any]) -> DashboardSummaryRecentStudent:
        first_name = row.get("preferred_name") or row.get("legal_first_name") or ""
        last_name = row.get("legal_last_name") or ""
        display_name = f"{first_name} {last_name}".strip() or "Unnamed student"
        started_on = row.get("membership_start_date") or str(row.get("created_at") or "")[:10] or None
        return DashboardSummaryRecentStudent(
            id=row["id"],
            display_name=display_name,
            status=row.get("status") or "active",
            started_on=started_on,
        )

    def count_rows(
        self,
        table: str,
        apply_filters: Callable[[Any], Any],
    ) -> int:
        return self.store.count_rows(table, apply_filters)

    def fetch_rows(
        self,
        table: str,
        columns: str,
        apply_filters: Callable[[Any], Any],
        *,
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        return self.store.fetch_rows(table, columns, apply_filters, page_size=page_size)

    def fetch_studio_summary(self, studio_id: str) -> dict[str, Any]:
        return self.store.fetch_studio_summary(studio_id)

    def student_counts(
        self,
        studio_id: str,
        student_rows: list[dict[str, Any]],
        today: date,
    ) -> DashboardSummaryStudentCounts:
        active_students = self.count_rows(
            "students",
            lambda query: query
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .in_("status", ["active", "trialing"]),
        )
        trialing_students = self.count_rows(
            "students",
            lambda query: query
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .eq("status", "trialing"),
        )
        total_students = self.count_rows(
            "students",
            lambda query: query.eq("studio_id", studio_id).is_("deleted_at", "null"),
        )
        on_hold_students = sum(1 for row in student_rows if self._is_student_on_hold_now(row, today))
        return DashboardSummaryStudentCounts(
            total_students=total_students,
            active_students=active_students,
            trialing_students=trialing_students,
            on_hold_students=on_hold_students,
        )

    def lead_counts(self, studio_id: str, today: date) -> DashboardSummaryLeadCounts:
        enrolled_leads = self.count_rows(
            "leads",
            lambda query: query.eq("studio_id", studio_id).eq("stage", "enrolled"),
        )
        active_leads = self.count_rows(
            "leads",
            lambda query: query.eq("studio_id", studio_id).in_("stage", ACTIVE_LEAD_STAGES),
        )
        due_today_leads = self.count_rows(
            "leads",
            lambda query: query
            .eq("studio_id", studio_id)
            .in_("stage", ACTIVE_LEAD_STAGES)
            .lte("follow_up_date", today.isoformat()),
        )
        return DashboardSummaryLeadCounts(
            active_leads=active_leads,
            enrolled_leads=enrolled_leads,
            due_today_leads=due_today_leads,
        )

    def belt_counts(self, studio_id: str) -> DashboardSummaryBeltCounts:
        visible_program_rows = self.fetch_rows(
            "programs",
            "id, is_system, archived_at",
            lambda query: query.eq("studio_id", studio_id),
        )
        visible_program_ids = [
            row["id"]
            for row in visible_program_rows
            if row.get("id") and not row.get("is_system") and not row.get("archived_at")
        ]
        if not visible_program_ids:
            return DashboardSummaryBeltCounts()

        ladder_rows = self.fetch_rows(
            "belt_ladders",
            "id",
            lambda query: query.eq("studio_id", studio_id).in_("program_id", visible_program_ids),
        )
        ladder_ids = [row["id"] for row in ladder_rows if row.get("id")]
        if not ladder_ids:
            return DashboardSummaryBeltCounts()

        belt_count = self.count_rows(
            "belt_ranks",
            lambda query: query
            .eq("studio_id", studio_id)
            .in_("ladder_id", ladder_ids)
            .eq("is_tip", False),
        )
        tip_count = self.count_rows(
            "belt_ranks",
            lambda query: query
            .eq("studio_id", studio_id)
            .in_("ladder_id", ladder_ids)
            .eq("is_tip", True),
        )
        return DashboardSummaryBeltCounts(belt_count=belt_count, tip_count=tip_count)

    def new_student_counts(
        self,
        student_rows: list[dict[str, Any]],
        today: date,
        lookback_14: date,
        lookback_30: date,
        lookback_90: date,
        year_start: date,
    ) -> DashboardSummaryNewStudentCounts:
        new_14 = 0
        new_30 = 0
        new_90 = 0
        new_year_to_date = 0

        for row in student_rows:
            if row.get("status") not in ACTIVE_STUDENT_STATUSES:
                continue
            start_date = self._student_start_date(row)
            if not start_date or start_date > today:
                continue
            if start_date >= lookback_14:
                new_14 += 1
            if start_date >= lookback_30:
                new_30 += 1
            if start_date >= lookback_90:
                new_90 += 1
            if start_date >= year_start:
                new_year_to_date += 1

        return DashboardSummaryNewStudentCounts(
            new_14=new_14,
            new_30=new_30,
            new_90=new_90,
            new_year_to_date=new_year_to_date,
        )

    def churn_counts(
        self,
        studio_id: str,
        total_students: int,
    ) -> DashboardSummaryChurnCounts:
        inactive_students = self.count_rows(
            "students",
            lambda query: query
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .eq("status", "inactive"),
        )
        canceled_students = self.count_rows(
            "students",
            lambda query: query
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .eq("status", "canceled"),
        )
        churn_marked_students = inactive_students + canceled_students
        return DashboardSummaryChurnCounts(
            inactive_students=inactive_students,
            canceled_students=canceled_students,
            churn_marked_students=churn_marked_students,
            churn_rate=churn_marked_students / total_students if total_students else None,
        )

    def billing_counts(
        self,
        studio_id: str,
        role: Optional[str],
        today: date,
    ) -> DashboardSummaryBillingCounts:
        if role not in BILLING_VISIBLE_ROLES:
            return DashboardSummaryBillingCounts(can_view_billing=False)

        payer_attention_count = self.count_rows(
            "billing_payers",
            lambda query: query
            .eq("studio_id", studio_id)
            .in_("billing_status", ["past_due", "failed", "unpaid"]),
        )
        uncollectible_invoice_count = self.count_rows(
            "billing_invoices",
            lambda query: query
            .eq("studio_id", studio_id)
            .eq("status", "uncollectible"),
        )
        overdue_open_invoice_count = self.count_rows(
            "billing_invoices",
            lambda query: query
            .eq("studio_id", studio_id)
            .eq("status", "open")
            .lte("due_date", today.isoformat()),
        )
        active_plan_count = self.count_rows(
            "billing_plans",
            lambda query: query.eq("studio_id", studio_id).is_("archived_at", "null"),
        )
        payment_account = self.store.fetch_one(
            "studio_payment_accounts",
            "studio_id, charges_enabled",
            lambda query: query.eq("studio_id", studio_id),
        )

        return DashboardSummaryBillingCounts(
            can_view_billing=True,
            payment_attention_count=payer_attention_count + uncollectible_invoice_count + overdue_open_invoice_count,
            has_plans=active_plan_count > 0,
            payments_ready=bool(payment_account and payment_account.get("charges_enabled")),
        )

    def setup_flags(
        self,
        studio_id: str,
        student_counts: DashboardSummaryStudentCounts,
        belt_counts: DashboardSummaryBeltCounts,
        schedule_counts: DashboardSummaryScheduleCounts,
        billing_counts: DashboardSummaryBillingCounts,
    ) -> DashboardSummarySetupFlags:
        program_count = self.count_rows(
            "programs",
            lambda query: query
            .eq("studio_id", studio_id)
            .eq("is_system", False)
            .is_("archived_at", "null"),
        )
        active_template_count = self.count_rows(
            "class_templates",
            lambda query: query.eq("studio_id", studio_id).eq("is_active", True),
        )
        live_session_count = self.count_rows(
            "class_sessions",
            lambda query: query.eq("studio_id", studio_id).is_("deleted_at", "null"),
        )

        return DashboardSummarySetupFlags(
            has_programs=program_count > 0,
            has_students=student_counts.total_students > 0,
            has_belt_system=belt_counts.belt_count > 0,
            has_weekly_classes=active_template_count > 0 or live_session_count > 0 or schedule_counts.today_sessions > 0,
            has_tuition_plans=billing_counts.has_plans if billing_counts.can_view_billing else None,
        )

    def recent_students(self, studio_id: str) -> list[DashboardSummaryRecentStudent]:
        rows = (
            self.supabase.table("students")
            .select("id, legal_first_name, legal_last_name, preferred_name, status, membership_start_date, created_at")
            .eq("studio_id", studio_id)
            .is_("deleted_at", "null")
            .order("created_at", desc=True)
            .limit(5)
            .execute()
            .data
            or []
        )
        return [self._build_recent_student(row) for row in rows]
