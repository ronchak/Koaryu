from __future__ import annotations

from types import MappingProxyType
from typing import Any, Callable, Mapping, Union

from fastapi import HTTPException
from postgrest.exceptions import APIError as PostgrestAPIError

from app.services.report_export_budget import (
    EXPORT_MAX_ROWS,
    EXPORT_TOO_LARGE_DETAIL,
    ReportExportBudget,
)
from app.services.report_export_catalog_types import CsvReport, REPORT_SOURCE_SPECS
from app.services.staff_service import (
    BASE_STAFF_ROLE_COLUMNS,
    EXTENDED_STAFF_ROLE_COLUMNS,
    OPTIONAL_STAFF_PROFILE_SCHEMA_ERROR_CODES,
    STAFF_PROFILE_COLUMNS,
)


EXPORT_PAGE_SIZE = 1000
FILTER_VALUE_BATCH_SIZE = 200


def _columns(*values: str) -> tuple[str, ...]:
    return tuple(values)


def _manifest(
    **entries: tuple[tuple[str, tuple[str, ...]], ...],
) -> Mapping[str, Mapping[str, tuple[str, ...]]]:
    return MappingProxyType({
        report_id: MappingProxyType(dict(source_entries))
        for report_id, source_entries in entries.items()
    })


# These are intentionally per report/source rather than per table. A report may
# use the same physical table for different reasons, and each pair is reviewed
# against the fields read by that report's locked builder.
INTELLIGENCE_INPUT_COLUMNS: Mapping[str, Mapping[str, tuple[str, ...]]] = _manifest(
    owner_kpi_summary=(
        ("students", _columns("id", "studio_id", "status", "membership_start_date", "deleted_at", "created_at")),
        ("leads", _columns("id", "studio_id", "stage", "converted_student_id", "created_at")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity", "deleted_at")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
        ("billing_plans", _columns("id", "studio_id", "amount_cents", "billing_interval")),
        ("billing_enrollments", _columns("id", "studio_id", "billing_plan_id", "status")),
        ("invoices", _columns("id", "studio_id", "status", "amount_due_cents", "amount_paid_cents")),
        ("payments", _columns("id", "studio_id", "status", "amount_cents", "created_at")),
    ),
    quiet_churn_watchlist=(
        ("students", _columns("id", "studio_id", "legal_first_name", "legal_last_name", "preferred_name", "status", "membership_start_date", "deleted_at", "created_at")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
        ("billing_enrollments", _columns("id", "studio_id", "student_id", "status", "billing_status", "payer_id", "created_at")),
        ("billing_payers", _columns("id", "studio_id", "billing_status")),
        ("promotions", _columns("id", "studio_id", "student_id", "student_program_membership_id", "program_id", "promoted_at")),
    ),
    first_90_days_onboarding=(
        ("students", _columns("id", "studio_id", "legal_first_name", "legal_last_name", "preferred_name", "status", "membership_start_date", "deleted_at", "created_at")),
        ("leads", _columns("id", "studio_id", "converted_student_id", "source")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
    ),
    lead_quality_after_enrollment=(
        ("students", _columns("id", "studio_id", "status", "membership_start_date", "deleted_at", "created_at")),
        ("leads", _columns("id", "studio_id", "source", "stage", "converted_student_id")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
        ("invoices", _columns("id", "studio_id", "student_id")),
        ("payments", _columns("id", "studio_id", "invoice_id", "status", "amount_cents")),
    ),
    belt_momentum_testing_pipeline=(
        ("students", _columns("id", "studio_id", "legal_first_name", "legal_last_name", "preferred_name", "status", "membership_start_date", "program_id", "current_belt_rank_id", "deleted_at", "created_at")),
        ("programs", _columns("id", "studio_id", "name")),
        ("memberships", _columns("id", "studio_id", "student_id", "program_id", "status", "current_belt_rank_id", "started_at")),
        ("belt_ladders", _columns("id", "studio_id", "program_id")),
        ("belt_ranks", _columns("id", "studio_id", "ladder_id", "name", "display_order", "min_classes", "min_months", "requires_approval")),
        ("promotions", _columns("id", "studio_id", "student_id", "student_program_membership_id", "program_id", "promoted_at")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
    ),
    revenue_leakage=(
        ("students", _columns("id", "studio_id", "legal_first_name", "legal_last_name", "preferred_name", "status", "membership_start_date", "deleted_at", "created_at")),
        ("billing_enrollments", _columns("id", "studio_id", "student_id", "payer_id", "status", "billing_status", "next_bill_on")),
        ("billing_payers", _columns("id", "studio_id", "display_name", "billing_status")),
        ("invoices", _columns("id", "studio_id", "student_id", "payer_id", "status", "amount_due_cents", "amount_paid_cents")),
        ("payments", _columns("id", "studio_id", "payer_id", "invoice_id", "status", "amount_cents", "created_at")),
    ),
    schedule_utilization_demand=(
        ("programs", _columns("id", "studio_id", "name")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "start_time", "date", "deleted_at", "status", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
    ),
    family_account_health=(
        ("students", _columns("id", "studio_id", "status", "membership_start_date", "deleted_at", "created_at")),
        ("guardians", _columns("id", "studio_id", "first_name", "last_name", "email", "phone")),
        ("student_guardians", _columns("id", "student_id", "guardian_id")),
        ("billing_enrollments", _columns("id", "studio_id", "student_id", "payer_id", "status", "billing_status", "created_at")),
        ("billing_payers", _columns("id", "studio_id", "display_name", "email", "phone", "billing_status", "balance_cents")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
    ),
    lifecycle_segmentation=(
        ("students", _columns("id", "studio_id", "legal_first_name", "legal_last_name", "preferred_name", "status", "membership_start_date", "deleted_at", "created_at")),
        ("billing_enrollments", _columns("id", "studio_id", "student_id", "status", "billing_status", "payer_id", "created_at")),
        ("billing_payers", _columns("id", "studio_id", "billing_status")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "status", "date", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
    ),
    instructor_staff_impact=(
        ("leads", _columns("id", "studio_id", "assigned_staff_id", "stage", "converted_student_id")),
        ("sessions", _columns("id", "studio_id", "program_id", "instructor_id", "name", "date", "deleted_at", "status", "capacity")),
        ("attendance", _columns("id", "studio_id", "session_id", "student_id", "status", "checked_in_at")),
    ),
    data_hygiene_readiness=(
        ("students", _columns("id", "studio_id", "status", "deleted_at", "is_minor", "emergency_contact_name", "program_id", "current_belt_rank_id")),
        ("student_guardians", _columns("id", "student_id", "guardian_id")),
        ("memberships", _columns("id", "studio_id", "student_id", "status", "current_belt_rank_id")),
        ("billing_enrollments", _columns("id", "studio_id", "student_id")),
        ("leads", _columns("id", "studio_id", "stage", "follow_up_date")),
        ("billing_payers", _columns("id", "studio_id", "email", "phone")),
    ),
)


class ReportExportDataFetcher:
    def __init__(self, supabase: Any, *, budget: ReportExportBudget | None = None):
        self.supabase = supabase
        self.budget = budget or ReportExportBudget()

    def fetch_intelligence_dataset(
        self,
        report: CsvReport | str,
        studio_id: str,
    ) -> dict[str, list[dict[str, Any]]]:
        if isinstance(report, str):
            from app.services.report_export_catalog import build_complete_report_catalog
            from app.services.report_export_service import ReportExportService

            report = build_complete_report_catalog(ReportExportService).get(report)
            if report is None:
                raise RuntimeError("Unknown intelligence report")
        manifest = INTELLIGENCE_INPUT_COLUMNS.get(report.id)
        if manifest is None or tuple(manifest) != tuple(report.source_keys):
            raise RuntimeError(f"No exact intelligence input manifest for {report.id}")
        if "student_guardians" in report.source_keys:
            if not report.source_keys or report.source_keys[0] != "students":
                raise RuntimeError("student_guardians requires students to be fetched first")

        dataset: dict[str, list[dict[str, Any]]] = {}
        for source_key in report.source_keys:
            columns = manifest.get(source_key)
            spec = REPORT_SOURCE_SPECS.get(source_key)
            if columns is None or spec is None or spec.provider != "postgrest":
                raise RuntimeError(f"Invalid intelligence source manifest entry: {report.id}/{source_key}")
            if source_key == "student_guardians":
                student_ids = [
                    row["id"] for row in dataset.get("students", []) if row.get("id")
                ]
                dataset[source_key] = (
                    self._fetch_rows_by_values(
                        spec.relation,
                        columns,
                        "student_id",
                        student_ids,
                        order_by=(("id", False),),
                    )
                    if student_ids else []
                )
                continue
            dataset[source_key] = self._fetch_rows(
                spec.relation,
                columns,
                studio_id,
            )
        return dataset

    def fetch_staff_dataset(self, studio_id: str) -> dict[str, Any]:
        role_rows = self._fetch_staff_role_rows(studio_id)
        user_ids = list(dict.fromkeys(
            row["user_id"]
            for row in role_rows
            if isinstance(row.get("user_id"), str) and row["user_id"].strip()
        ))
        profile_rows: list[dict[str, Any]] = []
        if user_ids:
            try:
                profile_rows = self._fetch_rows_by_values(
                    "staff_profiles",
                    STAFF_PROFILE_COLUMNS,
                    "user_id",
                    user_ids,
                )
            except PostgrestAPIError as exc:
                if exc.code not in OPTIONAL_STAFF_PROFILE_SCHEMA_ERROR_CODES:
                    raise
        auth_users = self._fetch_auth_users(user_ids) if user_ids else {}
        return {
            "staff_roles": role_rows,
            "staff_profiles": profile_rows,
            "auth_users": auth_users,
        }

    def _fetch_staff_role_rows(self, studio_id: str) -> list[dict[str, Any]]:
        def fetch(columns: str) -> list[dict[str, Any]]:
            def query_factory() -> Any:
                query = (
                    self.supabase.table("staff_roles")
                    .select(columns)
                    .eq("studio_id", studio_id)
                    .is_("archived_at", None)
                )
                return self._apply_export_order(
                    query,
                    (("created_at", False),),
                    columns,
                )

            return self._paged_rows(query_factory)

        try:
            return fetch(EXTENDED_STAFF_ROLE_COLUMNS)
        except PostgrestAPIError as exc:
            if exc.code != "42703":
                raise
            return fetch(BASE_STAFF_ROLE_COLUMNS)

    def _fetch_auth_users(self, user_ids: list[str]) -> dict[str, Any]:
        requested = set(user_ids)
        found: dict[str, Any] = {}
        page = 1
        while requested - found.keys():
            self.budget.admit_provider_call()
            try:
                response = self.supabase.auth.admin.list_users(
                    page=page,
                    per_page=EXPORT_PAGE_SIZE,
                )
            except HTTPException:
                raise
            except Exception:
                break
            users = response or []
            if not isinstance(users, list):
                users = getattr(users, "users", []) or []
            self.budget.consume_rows(len(users))
            for user in users:
                user_id = user.get("id") if isinstance(user, dict) else getattr(user, "id", None)
                if user_id in requested:
                    found[user_id] = user
            if len(users) < EXPORT_PAGE_SIZE:
                break
            page += 1
        return found

    def fetch_table_rows(self, report: CsvReport, studio_id: str) -> list[dict[str, Any]]:
        if not report.table:
            return []

        def query_factory() -> Any:
            query = (
                self.supabase.table(report.table)
                .select(", ".join(report.columns))
                .eq("studio_id", studio_id)
            )
            return self._apply_export_order(query, report.order_by, report.columns)

        return self._paged_rows(query_factory)

    def _single_row(self, table: str, columns: str, studio_id: str) -> dict[str, Any]:
        query = (
            self.supabase.table(table)
            .select(columns)
            .eq("studio_id" if table != "studios" else "id", studio_id)
            .limit(1)
        )
        self.budget.admit_provider_call()
        result = query.execute()
        data = result.data or []
        if isinstance(data, dict):
            self.budget.consume_rows(1)
            return data
        self.budget.consume_rows(len(data))
        return data[0] if data else {}

    def _fetch_rows(
        self,
        table: str,
        columns: Union[str, tuple[str, ...]],
        studio_id: str,
        *,
        order_by: tuple[tuple[str, bool], ...] = (),
    ) -> list[dict[str, Any]]:
        def query_factory() -> Any:
            query = self.supabase.table(table).select(", ".join(columns) if isinstance(columns, tuple) else columns).eq("studio_id", studio_id)
            return self._apply_export_order(query, order_by, columns)

        return self._paged_rows(query_factory)

    def _fetch_rows_by_values(
        self,
        table: str,
        columns: Union[str, tuple[str, ...]],
        filter_column: str,
        values: list[str],
        *,
        order_by: tuple[tuple[str, bool], ...] = (),
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for value_batch in self._chunks(values, FILTER_VALUE_BATCH_SIZE):
            def query_factory(value_batch: list[str] = value_batch) -> Any:
                query = (
                    self.supabase.table(table)
                    .select(", ".join(columns) if isinstance(columns, tuple) else columns)
                    .in_(filter_column, value_batch)
                )
                return self._apply_export_order(query, order_by, columns)

            rows.extend(self._paged_rows(query_factory))
        self._sort_export_rows(rows, order_by, columns)
        return rows

    def _paged_rows(
        self,
        query_factory: Callable[[], Any],
        *,
        page_size: int = EXPORT_PAGE_SIZE,
        max_rows: int = EXPORT_MAX_ROWS,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            query = query_factory().range(offset, offset + page_size - 1)
            self.budget.admit_provider_call()
            result = query.execute()
            page = result.data or []
            for row in page:
                self.budget.consume_rows(1)
                rows.append(row)
                if len(rows) > max_rows:
                    raise HTTPException(status_code=413, detail=EXPORT_TOO_LARGE_DETAIL)
            if len(page) < page_size:
                return rows
            offset += page_size

    def _apply_export_order(
        self,
        query: Any,
        order_by: tuple[tuple[str, bool], ...],
        columns: Union[str, tuple[str, ...]],
    ) -> Any:
        ordered_columns: set[str] = set()
        for column, descending in order_by:
            query = query.order(column, desc=descending)
            ordered_columns.add(column)
        if "id" not in ordered_columns and self._columns_include_id(columns):
            query = query.order("id", desc=False)
        return query

    def _columns_include_id(self, columns: Union[str, tuple[str, ...]]) -> bool:
        if isinstance(columns, tuple):
            return "id" in columns
        return any(part.strip() == "id" for part in columns.split(","))

    def _sort_export_rows(
        self,
        rows: list[dict[str, Any]],
        order_by: tuple[tuple[str, bool], ...],
        columns: Union[str, tuple[str, ...]],
    ) -> None:
        effective_order = list(order_by)
        has_id_order = any(column == "id" for column, _descending in effective_order)
        if self._columns_include_id(columns) and not has_id_order:
            effective_order.append(("id", False))
        for column, descending in reversed(effective_order):
            rows.sort(key=lambda row: str(row.get(column) or ""), reverse=descending)

    def _chunks(self, values: list[str], size: int) -> list[list[str]]:
        return [values[index:index + size] for index in range(0, len(values), size)]
