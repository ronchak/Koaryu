import csv
import json
from datetime import date
from io import StringIO
from typing import Any, Callable, Optional, Union

from fastapi import HTTPException, status
from supabase import Client

from app.services.report_export_catalog import CsvReport, build_report_catalog
from app.services.report_export_data import ReportExportDataFetcher
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

REPORT_EXPORT_ROLE_RANK = {
    "front_desk": 10,
    "admin": 20,
}


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


def require_report_export_access(report: CsvReport, role: str) -> None:
    if REPORT_EXPORT_ROLE_RANK.get(role, 0) < REPORT_EXPORT_ROLE_RANK.get(report.min_role, 999):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to export this report.",
        )


class ReportExportService:
    def __init__(self, supabase: Client, *, today: Optional[date] = None):
        self.supabase = supabase
        self.today = today or date.today()

    def list_reports(self) -> list[CsvReport]:
        return list(REPORTS.values())

    def get_report(self, report_id: str) -> CsvReport:
        report = REPORTS.get(report_id)
        if not report:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Report export not found.",
            )
        return report

    def _report_data(self) -> ReportExportDataFetcher:
        return ReportExportDataFetcher(self.supabase)

    async def build_csv(self, report_id: str, studio_id: str) -> tuple[str, str]:
        report = self.get_report(report_id)
        return await self.build_csv_for_report(report, studio_id)

    async def build_csv_for_report(self, report: CsvReport, studio_id: str) -> tuple[str, str]:
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
        return self._report_data().fetch_intelligence_dataset(studio_id)

    def _fetch_table_rows(self, report: CsvReport, studio_id: str) -> list[dict[str, Any]]:
        return self._report_data().fetch_table_rows(report, studio_id)

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
            relationship_rows = self._fetch_rows_by_values(
                "student_guardians",
                "id, student_id, guardian_id",
                "student_id",
                student_ids,
                order_by=(("id", False),),
            )

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
        return self._report_data()._single_row(table, columns, studio_id)

    def _fetch_rows(
        self,
        table: str,
        columns: str,
        studio_id: str,
        *,
        order_by: tuple[tuple[str, bool], ...] = (),
    ) -> list[dict[str, Any]]:
        return self._report_data()._fetch_rows(table, columns, studio_id, order_by=order_by)

    def _fetch_rows_by_values(
        self,
        table: str,
        columns: str,
        filter_column: str,
        values: list[str],
        *,
        order_by: tuple[tuple[str, bool], ...] = (),
    ) -> list[dict[str, Any]]:
        return self._report_data()._fetch_rows_by_values(
            table,
            columns,
            filter_column,
            values,
            order_by=order_by,
        )

    def _paged_rows(
        self,
        query_factory: Callable[[], Any],
        *,
        page_size: int = 1000,
    ) -> list[dict[str, Any]]:
        return self._report_data()._paged_rows(query_factory, page_size=page_size)

    def _apply_export_order(
        self,
        query: Any,
        order_by: tuple[tuple[str, bool], ...],
        columns: Union[str, tuple[str, ...]],
    ) -> Any:
        return self._report_data()._apply_export_order(query, order_by, columns)

    def _columns_include_id(self, columns: Union[str, tuple[str, ...]]) -> bool:
        return self._report_data()._columns_include_id(columns)

    def _sort_export_rows(
        self,
        rows: list[dict[str, Any]],
        order_by: tuple[tuple[str, bool], ...],
        columns: Union[str, tuple[str, ...]],
    ) -> None:
        self._report_data()._sort_export_rows(rows, order_by, columns)

    def _chunks(self, values: list[str], size: int) -> list[list[str]]:
        return self._report_data()._chunks(values, size)

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


REPORTS = build_report_catalog(ReportExportService)
