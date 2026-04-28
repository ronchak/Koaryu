import csv
import json
from dataclasses import dataclass
from datetime import date
from io import StringIO
from typing import Any, Callable, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.services.report_intelligence import (
    build_belt_momentum_testing_pipeline,
    build_data_hygiene_readiness,
    build_family_account_health,
    build_first_90_days_onboarding,
    build_instructor_staff_impact,
    build_lead_quality_after_enrollment,
    build_lifecycle_segmentation,
    build_owner_kpi_summary,
    build_quiet_churn_watchlist,
    build_revenue_leakage,
    build_schedule_utilization_demand,
)
from app.services.staff_service import StaffService


@dataclass(frozen=True)
class CsvReport:
    id: str
    title: str
    filename: str
    columns: tuple[str, ...]
    table: Optional[str] = None
    order_by: tuple[tuple[str, bool], ...] = ()
    custom_builder: Optional[Callable[["ReportExportService", str], list[dict[str, Any]]]] = None


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _csv_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list, tuple)):
        return _json_text(value)
    if not isinstance(value, str):
        return value

    if value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return f"'{value}"
    return value


class ReportExportService:
    def __init__(self, supabase: Client, *, today: Optional[date] = None):
        self.supabase = supabase
        self.today = today or date.today()

    def list_reports(self) -> list[CsvReport]:
        return list(REPORTS.values())

    async def build_csv(self, report_id: str, studio_id: str) -> tuple[str, str]:
        report = REPORTS.get(report_id)
        if not report:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Report export not found.",
            )

        rows = report.custom_builder(self, studio_id) if report.custom_builder else self._fetch_table_rows(report, studio_id)
        csv_text = self._write_csv(report.columns, rows)
        return csv_text, report.filename

    def _build_owner_kpi_summary_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_owner_kpi_summary(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_quiet_churn_watchlist_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_quiet_churn_watchlist(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_first_90_days_onboarding_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_first_90_days_onboarding(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_lead_quality_after_enrollment_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_lead_quality_after_enrollment(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_belt_momentum_testing_pipeline_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_belt_momentum_testing_pipeline(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_revenue_leakage_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_revenue_leakage(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_schedule_utilization_demand_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_schedule_utilization_demand(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_family_account_health_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_family_account_health(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_lifecycle_segmentation_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_lifecycle_segmentation(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_instructor_staff_impact_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_instructor_staff_impact(self._fetch_intelligence_dataset(studio_id), self.today)

    def _build_data_hygiene_readiness_rows(self, studio_id: str) -> list[dict[str, Any]]:
        return build_data_hygiene_readiness(self._fetch_intelligence_dataset(studio_id), self.today)

    def _fetch_intelligence_dataset(self, studio_id: str) -> dict[str, list[dict[str, Any]]]:
        students = self._fetch_rows(
            "students",
            (
                "id, studio_id, legal_first_name, legal_last_name, preferred_name, "
                "date_of_birth, is_minor, email, phone, emergency_contact_name, "
                "emergency_contact_phone, emergency_contact_relation, status, "
                "membership_start_date, program_id, current_belt_rank_id, tags, "
                "deleted_at, created_at, updated_at"
            ),
            studio_id,
        )
        student_ids = [row["id"] for row in students if row.get("id")]
        student_guardians: list[dict[str, Any]] = []
        if student_ids:
            student_guardians = (
                self.supabase.table("student_guardians")
                .select("id, student_id, guardian_id")
                .in_("student_id", student_ids)
                .execute()
                .data
                or []
            )

        return {
            "students": students,
            "programs": self._fetch_rows(
                "programs",
                "id, studio_id, name, description, color_hex, sort_order, is_system, archived_at, created_at, updated_at",
                studio_id,
            ),
            "memberships": self._fetch_rows(
                "student_program_memberships",
                "id, studio_id, student_id, program_id, status, started_at, ended_at, current_belt_rank_id, created_at, updated_at",
                studio_id,
            ),
            "guardians": self._fetch_rows(
                "guardians",
                "id, studio_id, first_name, last_name, email, phone, relation, is_primary_contact, created_at",
                studio_id,
            ),
            "student_guardians": student_guardians,
            "leads": self._fetch_rows(
                "leads",
                (
                    "id, studio_id, first_name, last_name, email, phone, source, stage, "
                    "program_interest, program_id, is_minor, guardian_name, guardian_email, "
                    "guardian_phone, assigned_staff_id, follow_up_date, lost_reason, notes, "
                    "converted_student_id, created_at, updated_at"
                ),
                studio_id,
            ),
            "lead_activities": self._fetch_rows(
                "lead_activities",
                "id, studio_id, lead_id, activity_type, description, created_by, created_at",
                studio_id,
            ),
            "sessions": self._fetch_rows(
                "class_sessions",
                (
                    "id, studio_id, template_id, name, date, start_time, end_time, "
                    "instructor_id, program_id, capacity, status, notes, deleted_at, created_at"
                ),
                studio_id,
            ),
            "attendance": self._fetch_rows(
                "attendance",
                (
                    "id, studio_id, session_id, student_id, status, checked_in_at, "
                    "checked_in_by, is_cross_program, counts_toward_eligibility, override_reason"
                ),
                studio_id,
            ),
            "belt_ladders": self._fetch_rows(
                "belt_ladders",
                "id, studio_id, name, program_id, sub_rank_term, created_at, updated_at",
                studio_id,
            ),
            "belt_ranks": self._fetch_rows(
                "belt_ranks",
                (
                    "id, ladder_id, studio_id, name, color_hex, display_order, min_classes, "
                    "min_months, requires_approval, is_tip, tip_color_hex, created_at"
                ),
                studio_id,
            ),
            "promotions": self._fetch_rows(
                "promotions",
                (
                    "id, studio_id, student_id, student_program_membership_id, program_id, "
                    "from_rank_id, to_rank_id, promoted_by, notes, promoted_at"
                ),
                studio_id,
            ),
            "billing_payers": self._fetch_rows(
                "billing_payers",
                (
                    "id, studio_id, guardian_id, display_name, email, phone, address_line1, "
                    "address_city, address_state, address_zip, autopay_status, billing_status, "
                    "balance_cents, created_at, updated_at"
                ),
                studio_id,
            ),
            "billing_plans": self._fetch_rows(
                "billing_plans",
                (
                    "id, studio_id, name, amount_cents, currency, billing_interval, status, "
                    "signup_fee_cents, trial_days, archived_at, created_at, updated_at"
                ),
                studio_id,
            ),
            "billing_enrollments": self._fetch_rows(
                "student_billing_enrollments",
                (
                    "id, studio_id, student_id, payer_id, billing_plan_id, status, billing_status, "
                    "start_date, end_date, next_bill_on, stripe_subscription_id, created_at, updated_at"
                ),
                studio_id,
            ),
            "invoices": self._fetch_rows(
                "billing_invoices",
                (
                    "id, studio_id, payer_id, student_id, enrollment_id, invoice_type, status, "
                    "amount_due_cents, amount_paid_cents, currency, due_date, paid_at, external, "
                    "created_at, updated_at"
                ),
                studio_id,
            ),
            "payments": self._fetch_rows(
                "billing_payments",
                (
                    "id, studio_id, payer_id, invoice_id, status, amount_cents, currency, "
                    "payment_method_type, external_method, note, processed_at, created_at, updated_at"
                ),
                studio_id,
            ),
        }

    def _fetch_table_rows(self, report: CsvReport, studio_id: str) -> list[dict[str, Any]]:
        if not report.table:
            return []

        query = (
            self.supabase.table(report.table)
            .select(", ".join(report.columns))
            .eq("studio_id", studio_id)
        )

        for column, descending in report.order_by:
            query = query.order(column, desc=descending)

        result = query.execute()
        return result.data or []

    def _write_csv(self, columns: tuple[str, ...], rows: list[dict[str, Any]]) -> str:
        output = StringIO()
        writer = csv.DictWriter(output, fieldnames=list(columns), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({column: _csv_value(row.get(column)) for column in columns})
        return output.getvalue()

    def _build_studio_overview_rows(self, studio_id: str) -> list[dict[str, Any]]:
        studio = self._single_row(
            "studios",
            "id, name, slug, owner_id, logo_url, timezone, created_at, updated_at",
            studio_id,
        )
        subscription = self._single_row(
            "studio_subscriptions",
            (
                "studio_id, stripe_customer_id, stripe_subscription_id, status, plan_name, "
                "monthly_price_cents, currency, trial_start, trial_end, current_period_start, "
                "current_period_end, cancel_at_period_end, last_payment_status, comped, "
                "metadata, created_at, updated_at"
            ),
            studio_id,
        )
        payment_account = self._single_row(
            "studio_payment_accounts",
            (
                "studio_id, stripe_connected_account_id, status, charges_enabled, payouts_enabled, "
                "details_submitted, requirements_due, platform_fee_bps, metadata, created_at, updated_at"
            ),
            studio_id,
        )

        return [
            {
                "studio_id": studio.get("id", studio_id),
                "name": studio.get("name"),
                "slug": studio.get("slug"),
                "owner_id": studio.get("owner_id"),
                "logo_url": studio.get("logo_url"),
                "timezone": studio.get("timezone"),
                "studio_created_at": studio.get("created_at"),
                "studio_updated_at": studio.get("updated_at"),
                "subscription_status": subscription.get("status"),
                "subscription_stripe_customer_id": subscription.get("stripe_customer_id"),
                "subscription_stripe_subscription_id": subscription.get("stripe_subscription_id"),
                "subscription_plan_name": subscription.get("plan_name"),
                "subscription_monthly_price_cents": subscription.get("monthly_price_cents"),
                "subscription_currency": subscription.get("currency"),
                "subscription_trial_start": subscription.get("trial_start"),
                "subscription_trial_end": subscription.get("trial_end"),
                "subscription_current_period_start": subscription.get("current_period_start"),
                "subscription_current_period_end": subscription.get("current_period_end"),
                "subscription_cancel_at_period_end": subscription.get("cancel_at_period_end"),
                "subscription_last_payment_status": subscription.get("last_payment_status"),
                "subscription_comped": subscription.get("comped"),
                "subscription_metadata": subscription.get("metadata"),
                "payment_account_status": payment_account.get("status"),
                "payment_account_stripe_connected_account_id": payment_account.get("stripe_connected_account_id"),
                "payment_account_charges_enabled": payment_account.get("charges_enabled"),
                "payment_account_payouts_enabled": payment_account.get("payouts_enabled"),
                "payment_account_details_submitted": payment_account.get("details_submitted"),
                "payment_account_requirements_due": payment_account.get("requirements_due"),
                "payment_account_platform_fee_bps": payment_account.get("platform_fee_bps"),
                "payment_account_metadata": payment_account.get("metadata"),
                "payment_account_created_at": payment_account.get("created_at"),
                "payment_account_updated_at": payment_account.get("updated_at"),
            }
        ]

    def _build_guardian_contact_rows(self, studio_id: str) -> list[dict[str, Any]]:
        students = self._fetch_rows(
            "students",
            "id, legal_first_name, legal_last_name, preferred_name, status, deleted_at",
            studio_id,
            order_by=(("legal_last_name", False), ("legal_first_name", False)),
        )
        guardians = self._fetch_rows(
            "guardians",
            "id, studio_id, first_name, last_name, email, phone, relation, is_primary_contact, created_at",
            studio_id,
            order_by=(("last_name", False), ("first_name", False)),
        )
        student_by_id = {row["id"]: row for row in students}
        guardian_by_id = {row["id"]: row for row in guardians}

        student_ids = list(student_by_id.keys())
        relationship_rows: list[dict[str, Any]] = []
        if student_ids:
            result = (
                self.supabase.table("student_guardians")
                .select("id, student_id, guardian_id")
                .in_("student_id", student_ids)
                .execute()
            )
            relationship_rows = result.data or []

        rows: list[dict[str, Any]] = []
        linked_guardian_ids: set[str] = set()
        for relationship in relationship_rows:
            guardian = guardian_by_id.get(relationship.get("guardian_id"))
            student = student_by_id.get(relationship.get("student_id"))
            if not guardian:
                continue
            linked_guardian_ids.add(guardian["id"])
            rows.append(self._guardian_contact_row(relationship, guardian, student))

        for guardian in guardians:
            if guardian["id"] not in linked_guardian_ids:
                rows.append(self._guardian_contact_row({}, guardian, None))

        return rows

    def _build_staff_rows(self, studio_id: str) -> list[dict[str, Any]]:
        service = StaffService(self.supabase)
        result = service._list_staff_role_rows(studio_id)
        return [
            service._hydrate_staff_member(row).model_dump()
            for row in (result.data or [])
        ]

    def _single_row(self, table: str, columns: str, studio_id: str) -> dict[str, Any]:
        result = (
            self.supabase.table(table)
            .select(columns)
            .eq("studio_id" if table != "studios" else "id", studio_id)
            .limit(1)
            .execute()
        )
        return (result.data or [{}])[0]

    def _fetch_rows(
        self,
        table: str,
        columns: str,
        studio_id: str,
        *,
        order_by: tuple[tuple[str, bool], ...] = (),
    ) -> list[dict[str, Any]]:
        query = self.supabase.table(table).select(columns).eq("studio_id", studio_id)
        for column, descending in order_by:
            query = query.order(column, desc=descending)
        result = query.execute()
        return result.data or []

    def _guardian_contact_row(
        self,
        relationship: dict[str, Any],
        guardian: dict[str, Any],
        student: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
        return {
            "student_guardian_id": relationship.get("id"),
            "student_id": relationship.get("student_id"),
            "student_legal_first_name": student.get("legal_first_name") if student else None,
            "student_legal_last_name": student.get("legal_last_name") if student else None,
            "student_preferred_name": student.get("preferred_name") if student else None,
            "student_status": student.get("status") if student else None,
            "student_deleted_at": student.get("deleted_at") if student else None,
            "guardian_id": guardian.get("id"),
            "guardian_first_name": guardian.get("first_name"),
            "guardian_last_name": guardian.get("last_name"),
            "guardian_email": guardian.get("email"),
            "guardian_phone": guardian.get("phone"),
            "guardian_relation": guardian.get("relation"),
            "guardian_is_primary_contact": guardian.get("is_primary_contact"),
            "guardian_created_at": guardian.get("created_at"),
        }


def _report(
    id: str,
    title: str,
    filename: str,
    columns: tuple[str, ...],
    *,
    table: Optional[str] = None,
    order_by: tuple[tuple[str, bool], ...] = (),
    custom_builder: Optional[Callable[[ReportExportService, str], list[dict[str, Any]]]] = None,
) -> CsvReport:
    return CsvReport(
        id=id,
        title=title,
        filename=filename,
        table=table,
        columns=columns,
        order_by=order_by,
        custom_builder=custom_builder,
    )


REPORTS: dict[str, CsvReport] = {
    "owner_kpi_summary": _report(
        "owner_kpi_summary",
        "Owner KPI summary",
        "owner-kpi-summary.csv",
        ("metric", "value", "context"),
        custom_builder=ReportExportService._build_owner_kpi_summary_rows,
    ),
    "quiet_churn_watchlist": _report(
        "quiet_churn_watchlist",
        "Quiet churn watchlist",
        "quiet-churn-watchlist.csv",
        (
            "student_id",
            "student_name",
            "student_status",
            "membership_start_date",
            "last_visit_date",
            "days_since_last_visit",
            "visits_last_14_days",
            "visits_last_30_days",
            "visits_previous_30_days",
            "visits_last_90_days",
            "billing_status",
            "billing_enrollment_id",
            "payer_id",
            "last_promotion_at",
            "days_since_last_promotion",
            "risk_score",
            "risk_flags",
        ),
        custom_builder=ReportExportService._build_quiet_churn_watchlist_rows,
    ),
    "first_90_days_onboarding": _report(
        "first_90_days_onboarding",
        "First 90 days onboarding",
        "first-90-days-onboarding.csv",
        (
            "student_id",
            "student_name",
            "student_status",
            "membership_start_date",
            "days_since_start",
            "first_visit_date",
            "days_to_first_visit",
            "visits_to_date",
            "visits_first_7_days",
            "visits_first_30_days",
            "visits_first_90_days",
            "completed_first_5_classes",
            "lead_source",
            "lead_id",
            "onboarding_status",
            "recommended_action",
        ),
        custom_builder=ReportExportService._build_first_90_days_onboarding_rows,
    ),
    "lead_quality_after_enrollment": _report(
        "lead_quality_after_enrollment",
        "Lead quality after enrollment",
        "lead-quality-after-enrollment.csv",
        (
            "source",
            "total_leads",
            "active_pipeline_leads",
            "enrolled_or_converted_leads",
            "lead_conversion_rate",
            "converted_students_with_records",
            "active_converted_students",
            "active_converted_student_rate",
            "first_30_day_visits",
            "avg_first_30_day_visits_per_converted_student",
            "lifetime_payment_cents",
            "avg_lifetime_payment_per_converted_student_cents",
        ),
        custom_builder=ReportExportService._build_lead_quality_after_enrollment_rows,
    ),
    "belt_momentum_testing_pipeline": _report(
        "belt_momentum_testing_pipeline",
        "Belt momentum and testing pipeline",
        "belt-momentum-testing-pipeline.csv",
        (
            "student_id",
            "student_name",
            "program_id",
            "program_name",
            "membership_id",
            "current_rank_id",
            "current_rank_name",
            "next_rank_id",
            "next_rank_name",
            "classes_since_rank_start",
            "classes_required_for_next_rank",
            "days_at_rank",
            "days_required_for_next_rank",
            "classes_met",
            "time_met",
            "requires_approval",
            "pipeline_status",
        ),
        custom_builder=ReportExportService._build_belt_momentum_testing_pipeline_rows,
    ),
    "revenue_leakage": _report(
        "revenue_leakage",
        "Revenue leakage",
        "revenue-leakage.csv",
        (
            "leakage_type",
            "severity",
            "student_id",
            "student_name",
            "payer_id",
            "payer_name",
            "enrollment_id",
            "invoice_id",
            "amount_cents",
            "detail",
            "recommended_action",
        ),
        custom_builder=ReportExportService._build_revenue_leakage_rows,
    ),
    "schedule_utilization_demand": _report(
        "schedule_utilization_demand",
        "Schedule utilization and demand",
        "schedule-utilization-demand.csv",
        (
            "program_id",
            "program_name",
            "class_name",
            "start_time",
            "sessions_scheduled",
            "sessions_canceled",
            "sessions_with_capacity",
            "total_capacity",
            "total_attendance",
            "unique_students",
            "attendance_last_30_days",
            "attendance_prior_60_days",
            "average_attendance",
            "average_capacity",
            "utilization_rate",
            "recommendation",
        ),
        custom_builder=ReportExportService._build_schedule_utilization_demand_rows,
    ),
    "family_account_health": _report(
        "family_account_health",
        "Family account health",
        "family-account-health.csv",
        (
            "household_key",
            "household_name",
            "contact_email",
            "contact_phone",
            "billing_status",
            "balance_cents",
            "total_students",
            "active_students",
            "visits_last_30_days",
            "at_risk_active_students",
            "missing_contact_method",
            "priority_score",
        ),
        custom_builder=ReportExportService._build_family_account_health_rows,
    ),
    "lifecycle_segmentation": _report(
        "lifecycle_segmentation",
        "Lifecycle segmentation",
        "lifecycle-segmentation.csv",
        (
            "student_id",
            "student_name",
            "student_status",
            "membership_start_date",
            "days_since_start",
            "lifecycle_segment",
            "segment_reason",
            "last_visit_date",
            "days_since_last_visit",
            "visits_last_30_days",
            "billing_status",
            "risk_score",
            "risk_flags",
        ),
        custom_builder=ReportExportService._build_lifecycle_segmentation_rows,
    ),
    "instructor_staff_impact": _report(
        "instructor_staff_impact",
        "Instructor and staff impact",
        "instructor-staff-impact.csv",
        (
            "staff_user_id",
            "classes_taught_90_days",
            "total_attendance_90_days",
            "average_attendance_per_class",
            "unique_students_90_days",
            "sessions_with_capacity",
            "utilization_rate",
            "assigned_leads",
            "assigned_leads_enrolled_or_converted",
            "assigned_lead_conversion_rate",
        ),
        custom_builder=ReportExportService._build_instructor_staff_impact_rows,
    ),
    "data_hygiene_readiness": _report(
        "data_hygiene_readiness",
        "Data hygiene and studio readiness",
        "data-hygiene-readiness.csv",
        (
            "issue_type",
            "severity",
            "entity_type",
            "entity_id",
            "student_id",
            "detail",
            "recommended_action",
        ),
        custom_builder=ReportExportService._build_data_hygiene_readiness_rows,
    ),
    "studio_overview": _report(
        "studio_overview",
        "Studio overview",
        "studio-overview.csv",
        (
            "studio_id",
            "name",
            "slug",
            "owner_id",
            "logo_url",
            "timezone",
            "studio_created_at",
            "studio_updated_at",
            "subscription_status",
            "subscription_stripe_customer_id",
            "subscription_stripe_subscription_id",
            "subscription_plan_name",
            "subscription_monthly_price_cents",
            "subscription_currency",
            "subscription_trial_start",
            "subscription_trial_end",
            "subscription_current_period_start",
            "subscription_current_period_end",
            "subscription_cancel_at_period_end",
            "subscription_last_payment_status",
            "subscription_comped",
            "subscription_metadata",
            "payment_account_status",
            "payment_account_stripe_connected_account_id",
            "payment_account_charges_enabled",
            "payment_account_payouts_enabled",
            "payment_account_details_submitted",
            "payment_account_requirements_due",
            "payment_account_platform_fee_bps",
            "payment_account_metadata",
            "payment_account_created_at",
            "payment_account_updated_at",
        ),
        custom_builder=ReportExportService._build_studio_overview_rows,
    ),
    "students": _report(
        "students",
        "Students",
        "students.csv",
        (
            "id",
            "studio_id",
            "legal_first_name",
            "legal_last_name",
            "preferred_name",
            "date_of_birth",
            "is_minor",
            "hold_start_date",
            "hold_end_date",
            "email",
            "phone",
            "address_line1",
            "address_city",
            "address_state",
            "address_zip",
            "emergency_contact_name",
            "emergency_contact_phone",
            "emergency_contact_relation",
            "status",
            "membership_start_date",
            "program_id",
            "current_belt_rank_id",
            "stripe_customer_id",
            "photo_path",
            "photo_updated_at",
            "notes",
            "tags",
            "deleted_at",
            "created_at",
            "updated_at",
        ),
        table="students",
        order_by=(("legal_last_name", False), ("legal_first_name", False)),
    ),
    "guardian_contacts": _report(
        "guardian_contacts",
        "Guardians and contacts",
        "guardian-contacts.csv",
        (
            "student_guardian_id",
            "student_id",
            "student_legal_first_name",
            "student_legal_last_name",
            "student_preferred_name",
            "student_status",
            "student_deleted_at",
            "guardian_id",
            "guardian_first_name",
            "guardian_last_name",
            "guardian_email",
            "guardian_phone",
            "guardian_relation",
            "guardian_is_primary_contact",
            "guardian_created_at",
        ),
        custom_builder=ReportExportService._build_guardian_contact_rows,
    ),
    "student_program_memberships": _report(
        "student_program_memberships",
        "Student program enrollments",
        "student-program-enrollments.csv",
        (
            "id",
            "studio_id",
            "student_id",
            "program_id",
            "status",
            "started_at",
            "ended_at",
            "current_belt_rank_id",
            "created_at",
            "updated_at",
        ),
        table="student_program_memberships",
        order_by=(("created_at", True),),
    ),
    "programs": _report(
        "programs",
        "Programs",
        "programs.csv",
        (
            "id",
            "studio_id",
            "name",
            "description",
            "color_hex",
            "sort_order",
            "is_system",
            "archived_at",
            "created_at",
            "updated_at",
        ),
        table="programs",
        order_by=(("sort_order", False), ("name", False)),
    ),
    "belt_ladders": _report(
        "belt_ladders",
        "Belt ladders",
        "belt-ladders.csv",
        (
            "id",
            "studio_id",
            "name",
            "program_id",
            "sub_rank_term",
            "created_at",
            "updated_at",
        ),
        table="belt_ladders",
        order_by=(("created_at", False),),
    ),
    "belt_ranks": _report(
        "belt_ranks",
        "Belt ranks",
        "belt-ranks.csv",
        (
            "id",
            "ladder_id",
            "studio_id",
            "name",
            "color_hex",
            "display_order",
            "min_classes",
            "min_months",
            "requires_approval",
            "is_tip",
            "tip_color_hex",
            "created_at",
        ),
        table="belt_ranks",
        order_by=(("ladder_id", False), ("display_order", False)),
    ),
    "promotions": _report(
        "promotions",
        "Promotion history",
        "promotion-history.csv",
        (
            "id",
            "studio_id",
            "student_id",
            "student_program_membership_id",
            "program_id",
            "from_rank_id",
            "to_rank_id",
            "promoted_by",
            "notes",
            "promoted_at",
        ),
        table="promotions",
        order_by=(("promoted_at", True),),
    ),
    "leads": _report(
        "leads",
        "Leads",
        "leads.csv",
        (
            "id",
            "studio_id",
            "first_name",
            "last_name",
            "email",
            "phone",
            "source",
            "stage",
            "program_interest",
            "program_id",
            "is_minor",
            "guardian_name",
            "guardian_email",
            "guardian_phone",
            "assigned_staff_id",
            "follow_up_date",
            "lost_reason",
            "notes",
            "converted_student_id",
            "created_at",
            "updated_at",
        ),
        table="leads",
        order_by=(("created_at", True),),
    ),
    "lead_activities": _report(
        "lead_activities",
        "Lead activities",
        "lead-activities.csv",
        (
            "id",
            "studio_id",
            "lead_id",
            "activity_type",
            "description",
            "created_by",
            "created_at",
        ),
        table="lead_activities",
        order_by=(("created_at", True),),
    ),
    "class_templates": _report(
        "class_templates",
        "Recurring class templates",
        "class-templates.csv",
        (
            "id",
            "studio_id",
            "name",
            "day_of_week",
            "start_time",
            "end_time",
            "start_date",
            "end_date",
            "instructor_id",
            "program_id",
            "capacity",
            "is_active",
            "created_at",
            "updated_at",
        ),
        table="class_templates",
        order_by=(("day_of_week", False), ("start_time", False)),
    ),
    "class_sessions": _report(
        "class_sessions",
        "Class sessions",
        "class-sessions.csv",
        (
            "id",
            "studio_id",
            "template_id",
            "name",
            "date",
            "start_time",
            "end_time",
            "instructor_id",
            "program_id",
            "capacity",
            "status",
            "notes",
            "deleted_at",
            "created_at",
        ),
        table="class_sessions",
        order_by=(("date", True), ("start_time", True)),
    ),
    "attendance": _report(
        "attendance",
        "Attendance records",
        "attendance.csv",
        (
            "id",
            "studio_id",
            "session_id",
            "student_id",
            "status",
            "checked_in_at",
            "checked_in_by",
            "is_cross_program",
            "counts_toward_eligibility",
            "override_reason",
        ),
        table="attendance",
        order_by=(("checked_in_at", True),),
    ),
    "billing_payers": _report(
        "billing_payers",
        "Billing payers",
        "billing-payers.csv",
        (
            "id",
            "studio_id",
            "guardian_id",
            "display_name",
            "email",
            "phone",
            "address_line1",
            "address_city",
            "address_state",
            "address_zip",
            "stripe_account_id",
            "stripe_customer_id",
            "default_payment_method_brand",
            "default_payment_method_last4",
            "autopay_status",
            "autopay_authorized_at",
            "autopay_disabled_at",
            "billing_status",
            "balance_cents",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="billing_payers",
        order_by=(("display_name", False),),
    ),
    "billing_plans": _report(
        "billing_plans",
        "Billing plans",
        "billing-plans.csv",
        (
            "id",
            "studio_id",
            "name",
            "description",
            "amount_cents",
            "currency",
            "billing_interval",
            "status",
            "signup_fee_cents",
            "trial_days",
            "proration_behavior",
            "freeze_behavior",
            "cancellation_policy",
            "tax_behavior",
            "stripe_account_id",
            "stripe_product_id",
            "stripe_price_id",
            "stripe_price_version",
            "metadata",
            "archived_at",
            "created_at",
            "updated_at",
        ),
        table="billing_plans",
        order_by=(("created_at", True),),
    ),
    "billing_plan_programs": _report(
        "billing_plan_programs",
        "Billing plan programs",
        "billing-plan-programs.csv",
        (
            "id",
            "studio_id",
            "billing_plan_id",
            "program_id",
            "created_at",
        ),
        table="billing_plan_programs",
        order_by=(("created_at", True),),
    ),
    "billing_subscriptions": _report(
        "billing_subscriptions",
        "Billing subscriptions",
        "billing-subscriptions.csv",
        (
            "id",
            "studio_id",
            "payer_id",
            "stripe_account_id",
            "stripe_customer_id",
            "stripe_subscription_id",
            "collection_mode",
            "billing_interval",
            "currency",
            "status",
            "current_period_start",
            "current_period_end",
            "cancel_at_period_end",
            "default_payment_method_id",
            "application_fee_percent",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="billing_subscriptions",
        order_by=(("created_at", True),),
    ),
    "student_billing_enrollments": _report(
        "student_billing_enrollments",
        "Student billing enrollments",
        "student-billing-enrollments.csv",
        (
            "id",
            "studio_id",
            "student_id",
            "payer_id",
            "billing_plan_id",
            "billing_subscription_id",
            "collection_mode",
            "status",
            "billing_status",
            "start_date",
            "end_date",
            "next_bill_on",
            "stripe_subscription_id",
            "stripe_subscription_item_id",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="student_billing_enrollments",
        order_by=(("created_at", True),),
    ),
    "billing_invoices": _report(
        "billing_invoices",
        "Billing invoices",
        "billing-invoices.csv",
        (
            "id",
            "studio_id",
            "payer_id",
            "student_id",
            "enrollment_id",
            "stripe_invoice_id",
            "stripe_account_id",
            "stripe_customer_id",
            "stripe_subscription_id",
            "stripe_payment_intent_id",
            "invoice_number",
            "invoice_type",
            "status",
            "amount_due_cents",
            "amount_paid_cents",
            "amount_remaining_cents",
            "currency",
            "hosted_invoice_url",
            "invoice_pdf",
            "due_date",
            "paid_at",
            "finalized_at",
            "voided_at",
            "collection_method",
            "last_payment_error",
            "application_fee_amount_cents",
            "external",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="billing_invoices",
        order_by=(("created_at", True),),
    ),
    "billing_invoice_items": _report(
        "billing_invoice_items",
        "Billing invoice items",
        "billing-invoice-items.csv",
        (
            "id",
            "studio_id",
            "invoice_id",
            "student_id",
            "enrollment_id",
            "billing_plan_id",
            "stripe_invoice_item_id",
            "stripe_price_id",
            "description",
            "quantity",
            "unit_amount_cents",
            "amount_cents",
            "metadata",
            "created_at",
        ),
        table="billing_invoice_items",
        order_by=(("created_at", True),),
    ),
    "billing_payments": _report(
        "billing_payments",
        "Billing payments",
        "billing-payments.csv",
        (
            "id",
            "studio_id",
            "payer_id",
            "invoice_id",
            "stripe_customer_id",
            "stripe_invoice_id",
            "stripe_payment_intent_id",
            "stripe_charge_id",
            "stripe_account_id",
            "stripe_payment_method_id",
            "status",
            "amount_cents",
            "currency",
            "payment_method_type",
            "external_method",
            "note",
            "receipt_url",
            "failure_code",
            "failure_message",
            "application_fee_amount_cents",
            "refunded_amount_cents",
            "processed_at",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="billing_payments",
        order_by=(("created_at", True),),
    ),
    "billing_refunds": _report(
        "billing_refunds",
        "Billing refunds",
        "billing-refunds.csv",
        (
            "id",
            "studio_id",
            "payment_id",
            "stripe_refund_id",
            "stripe_charge_id",
            "stripe_payment_intent_id",
            "stripe_account_id",
            "amount_cents",
            "status",
            "reason",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="billing_refunds",
        order_by=(("created_at", True),),
    ),
    "billing_disputes": _report(
        "billing_disputes",
        "Billing disputes",
        "billing-disputes.csv",
        (
            "id",
            "studio_id",
            "payment_id",
            "stripe_dispute_id",
            "stripe_charge_id",
            "stripe_payment_intent_id",
            "stripe_account_id",
            "amount_cents",
            "status",
            "reason",
            "liability_owner",
            "metadata",
            "created_at",
            "updated_at",
        ),
        table="billing_disputes",
        order_by=(("created_at", True),),
    ),
    "billing_adjustments": _report(
        "billing_adjustments",
        "Billing adjustments",
        "billing-adjustments.csv",
        (
            "id",
            "studio_id",
            "payer_id",
            "student_id",
            "amount_cents",
            "reason",
            "note",
            "created_by",
            "created_at",
        ),
        table="billing_adjustments",
        order_by=(("created_at", True),),
    ),
    "email_usage_events": _report(
        "email_usage_events",
        "Email usage events",
        "email-usage-events.csv",
        (
            "id",
            "studio_id",
            "category",
            "recipient",
            "provider_message_id",
            "quantity",
            "sent_at",
            "metadata",
            "created_at",
        ),
        table="email_usage_events",
        order_by=(("sent_at", True),),
    ),
    "student_import_runs": _report(
        "student_import_runs",
        "Student import runs",
        "student-import-runs.csv",
        (
            "id",
            "studio_id",
            "actor_id",
            "operation",
            "idempotency_key",
            "request_hash",
            "status",
            "result_json",
            "error_message",
            "started_at",
            "completed_at",
            "created_at",
            "updated_at",
        ),
        table="student_import_runs",
        order_by=(("created_at", True),),
    ),
    "export_jobs": _report(
        "export_jobs",
        "Export jobs",
        "export-jobs.csv",
        (
            "id",
            "studio_id",
            "export_type",
            "status",
            "requested_by",
            "download_url",
            "error",
            "metadata",
            "created_at",
            "updated_at",
            "completed_at",
        ),
        table="export_jobs",
        order_by=(("created_at", True),),
    ),
    "staff_roles": _report(
        "staff_roles",
        "Staff roles",
        "staff-roles.csv",
        (
            "id",
            "studio_id",
            "user_id",
            "email",
            "full_name",
            "role",
            "status",
            "invited_by",
            "created_at",
            "updated_at",
            "last_sign_in_at",
        ),
        custom_builder=ReportExportService._build_staff_rows,
    ),
    "audit_logs": _report(
        "audit_logs",
        "Audit logs",
        "audit-logs.csv",
        (
            "id",
            "studio_id",
            "actor_id",
            "action",
            "entity_type",
            "entity_id",
            "metadata",
            "created_at",
        ),
        table="audit_logs",
        order_by=(("created_at", True),),
    ),
}
