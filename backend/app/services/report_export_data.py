from __future__ import annotations

from typing import Any, Callable, Union

from fastapi import HTTPException


EXPORT_PAGE_SIZE = 1000
EXPORT_MAX_ROWS = 50_000
FILTER_VALUE_BATCH_SIZE = 200


class ReportExportDataFetcher:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def fetch_intelligence_dataset(self, studio_id: str) -> dict[str, list[dict[str, Any]]]:
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
            student_guardians = self._fetch_rows_by_values(
                "student_guardians",
                "id, student_id, guardian_id",
                "student_id",
                student_ids,
                order_by=(("id", False),),
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

    def fetch_table_rows(self, report: Any, studio_id: str) -> list[dict[str, Any]]:
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
        def query_factory() -> Any:
            query = self.supabase.table(table).select(columns).eq("studio_id", studio_id)
            return self._apply_export_order(query, order_by, columns)

        return self._paged_rows(query_factory)

    def _fetch_rows_by_values(
        self,
        table: str,
        columns: str,
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
                    .select(columns)
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
            result = query_factory().range(offset, offset + page_size - 1).execute()
            page = result.data or []
            rows.extend(page)
            if len(rows) > max_rows:
                raise HTTPException(
                    status_code=413,
                    detail="Export is too large. Apply filters or request an async export.",
                )
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
