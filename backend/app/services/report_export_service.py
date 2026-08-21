import csv
import json
import tempfile
import threading
from dataclasses import dataclass
from datetime import date
from io import StringIO
from typing import Any, Callable, Optional, Union

from fastapi import HTTPException, status
from supabase import Client

from app.services.report_export_catalog import CsvReport, build_report_catalog
from app.services.report_export_budget import (
    EXPORT_MAX_OUTPUT_BYTES,
    ReportExportBudget,
    ReportExportBudgetSnapshot,
)
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
EXPORT_SPOOL_MAX_MEMORY_BYTES = 1 * 1024 * 1024
EXPORT_STREAM_CHUNK_BYTES = 64 * 1024


@dataclass(frozen=True)
class ReportExportArtifact:
    """A fully generated report whose backing spool is ready for delivery."""

    spool: Any
    filename: str
    emitted_data_rows: int
    output_bytes: int
    budget: ReportExportBudgetSnapshot
    spool_threshold_bytes: int
    spool_rolled: bool

    @property
    def spool_closed(self) -> bool:
        return bool(self.spool.closed)

    def close(self) -> None:
        self.spool.close()

    def stream(self) -> "_ReportExportSpoolIterator":
        return _ReportExportSpoolIterator(self.spool)


class ReportExportArtifactLease:
    """Transfer or abandon an artifact across the provider worker boundary."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._artifact: Optional[ReportExportArtifact] = None
        self._abandoned = False

    def offer(self, artifact: ReportExportArtifact) -> bool:
        with self._lock:
            if self._abandoned:
                should_close = True
            else:
                self._artifact = artifact
                should_close = False
        if should_close:
            artifact.close()
            return False
        return True

    def claim(self, artifact: ReportExportArtifact) -> Optional[ReportExportArtifact]:
        with self._lock:
            if self._artifact is artifact:
                self._artifact = None
                return artifact
        return None

    def abandon(self) -> None:
        with self._lock:
            self._abandoned = True
            artifact = self._artifact
            self._artifact = None
        if artifact is not None:
            artifact.close()


class _ReportExportSpoolIterator:
    """Sync iterator for Starlette's bounded threadpool response adapter."""

    def __init__(self, spool: Any) -> None:
        self._spool = spool
        self._started = False
        self._closed = False

    def __iter__(self) -> "_ReportExportSpoolIterator":
        return self

    def __next__(self) -> bytes:
        if self._closed:
            raise StopIteration
        try:
            if not self._started:
                self._spool.seek(0)
                self._started = True
            chunk = self._spool.read(EXPORT_STREAM_CHUNK_BYTES)
            if not chunk:
                self.close()
                raise StopIteration
            return chunk
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._spool.close()


class _Utf8SpoolWriter:
    """The text sink used by DictWriter, with byte and elapsed admission."""

    def __init__(self, spool: Any, budget: ReportExportBudget) -> None:
        self._spool = spool
        self._budget = budget

    def write(self, value: str) -> int:
        self._budget.check_elapsed()
        encoded = value.encode("utf-8")
        self._budget.consume_output_bytes(len(encoded))
        written = self._spool.write(encoded)
        if written != len(encoded):
            raise OSError("short write while constructing report export")
        return len(value)

    def flush(self) -> None:
        return None


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
    def __init__(
        self,
        supabase: Client,
        *,
        today: Optional[date] = None,
        budget: Optional[ReportExportBudget] = None,
    ):
        self.supabase = supabase
        self.today = today or date.today()
        self.budget = budget or ReportExportBudget()
        self._active_report: Optional[CsvReport] = None

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
        return ReportExportDataFetcher(self.supabase, budget=self.budget)

    @property
    def budget_snapshot(self) -> ReportExportBudgetSnapshot:
        return self.budget.snapshot()

    async def build_csv(self, report_id: str, studio_id: str) -> tuple[str, str]:
        report = self.get_report(report_id)
        return await self.build_csv_for_report(report, studio_id)

    async def build_csv_artifact(
        self,
        report_id: str,
        studio_id: str,
    ) -> ReportExportArtifact:
        report = self.get_report(report_id)
        return await self.build_csv_artifact_for_report(report, studio_id)

    async def build_csv_artifact_for_report(
        self,
        report: CsvReport,
        studio_id: str,
    ) -> ReportExportArtifact:
        # Keep the legacy method as the compatibility seam used by existing
        # internal tests. The endpoint selects the artifact return path.
        artifact = await self.build_csv_for_report(
            report,
            studio_id,
            _return_artifact=True,
        )
        if not isinstance(artifact, ReportExportArtifact):
            raise TypeError("report export did not produce a spool artifact")
        return artifact

    async def build_csv_for_report(
        self,
        report: CsvReport,
        studio_id: str,
        *,
        _return_artifact: bool = False,
    ) -> tuple[str, str] | ReportExportArtifact:
        artifact = await self._build_csv_artifact_for_report(report, studio_id)
        if _return_artifact:
            return artifact
        try:
            artifact.spool.seek(0)
            body = artifact.spool.read(EXPORT_MAX_OUTPUT_BYTES)
            if len(body) != artifact.output_bytes:
                raise OSError("report export spool byte count changed during read")
            return body.decode("utf-8"), artifact.filename
        finally:
            artifact.close()

    async def _build_csv_artifact_for_report(
        self,
        report: CsvReport,
        studio_id: str,
    ) -> ReportExportArtifact:
        self.budget.check_elapsed()
        spool = tempfile.SpooledTemporaryFile(
            max_size=EXPORT_SPOOL_MAX_MEMORY_BYTES,
            mode="w+b",
        )
        previous_report = self._active_report
        self._active_report = report
        try:
            rows = (
                report.custom_builder(self, studio_id)
                if report.custom_builder
                else self._fetch_table_rows(report, studio_id)
            )
        except BaseException:
            spool.close()
            raise
        finally:
            self._active_report = previous_report

        try:
            self.budget.check_elapsed()
            writer = csv.DictWriter(
                _Utf8SpoolWriter(spool, self.budget),
                fieldnames=list(report.columns),
                extrasaction="ignore",
                lineterminator="\r\n",
            )
            writer.writeheader()
            for row in rows:
                self.budget.check_output_row()
                writer.writerow({
                    column: _csv_value(row.get(column))
                    for column in report.columns
                })
                self.budget.consume_output_row()
                self.budget.check_elapsed()

            self.budget.check_elapsed()
            snapshot = self.budget.snapshot()
            spool_rolled = bool(getattr(spool, "_rolled", False))
        except BaseException:
            spool.close()
            raise

        return ReportExportArtifact(
            spool=spool,
            filename=report.filename,
            emitted_data_rows=snapshot.emitted_rows,
            output_bytes=snapshot.output_bytes,
            budget=snapshot,
            spool_threshold_bytes=EXPORT_SPOOL_MAX_MEMORY_BYTES,
            spool_rolled=spool_rolled,
        )

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
        if self._active_report is None:
            raise RuntimeError("Intelligence report context is required")
        return self._report_data().fetch_intelligence_dataset(self._active_report, studio_id)

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
        dataset = self._report_data().fetch_staff_dataset(studio_id)
        role_rows = dataset["staff_roles"]
        profile_map = {
            row.get("user_id"): row
            for row in dataset["staff_profiles"]
            if row.get("user_id")
        }
        auth_users = dataset["auth_users"]
        return [
            service._hydrate_staff_member(
                row,
                user=auth_users.get(row.get("user_id")),
                profile=profile_map.get(row.get("user_id")),
            ).model_dump()
            for row in role_rows
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
