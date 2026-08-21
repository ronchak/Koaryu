from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Callable, Final, Literal, Mapping, Optional


ReportAvailability = Literal["available", "deferred_billing"]
ReportSourceProvider = Literal["postgrest", "auth_admin"]


@dataclass(frozen=True)
class ReportSourceSpec:
    key: str
    provider: ReportSourceProvider
    relation: str


REPORT_SOURCE_SPECS: Final[Mapping[str, ReportSourceSpec]] = MappingProxyType({
    "attendance": ReportSourceSpec("attendance", "postgrest", "attendance"),
    "audit_logs": ReportSourceSpec("audit_logs", "postgrest", "audit_logs"),
    "auth_users": ReportSourceSpec("auth_users", "auth_admin", "users"),
    "belt_ladders": ReportSourceSpec("belt_ladders", "postgrest", "belt_ladders"),
    "belt_ranks": ReportSourceSpec("belt_ranks", "postgrest", "belt_ranks"),
    "billing_adjustments": ReportSourceSpec("billing_adjustments", "postgrest", "billing_adjustments"),
    "billing_disputes": ReportSourceSpec("billing_disputes", "postgrest", "billing_disputes"),
    "billing_enrollments": ReportSourceSpec("billing_enrollments", "postgrest", "student_billing_enrollments"),
    "billing_invoice_items": ReportSourceSpec("billing_invoice_items", "postgrest", "billing_invoice_items"),
    "billing_invoices": ReportSourceSpec("billing_invoices", "postgrest", "billing_invoices"),
    "billing_payers": ReportSourceSpec("billing_payers", "postgrest", "billing_payers"),
    "billing_payments": ReportSourceSpec("billing_payments", "postgrest", "billing_payments"),
    "billing_plan_programs": ReportSourceSpec("billing_plan_programs", "postgrest", "billing_plan_programs"),
    "billing_plans": ReportSourceSpec("billing_plans", "postgrest", "billing_plans"),
    "billing_refunds": ReportSourceSpec("billing_refunds", "postgrest", "billing_refunds"),
    "billing_subscriptions": ReportSourceSpec("billing_subscriptions", "postgrest", "billing_subscriptions"),
    "class_sessions": ReportSourceSpec("class_sessions", "postgrest", "class_sessions"),
    "class_templates": ReportSourceSpec("class_templates", "postgrest", "class_templates"),
    "email_usage_events": ReportSourceSpec("email_usage_events", "postgrest", "email_usage_events"),
    "export_jobs": ReportSourceSpec("export_jobs", "postgrest", "export_jobs"),
    "guardians": ReportSourceSpec("guardians", "postgrest", "guardians"),
    "invoices": ReportSourceSpec("invoices", "postgrest", "billing_invoices"),
    "lead_activities": ReportSourceSpec("lead_activities", "postgrest", "lead_activities"),
    "leads": ReportSourceSpec("leads", "postgrest", "leads"),
    "memberships": ReportSourceSpec("memberships", "postgrest", "student_program_memberships"),
    "payments": ReportSourceSpec("payments", "postgrest", "billing_payments"),
    "programs": ReportSourceSpec("programs", "postgrest", "programs"),
    "promotions": ReportSourceSpec("promotions", "postgrest", "promotions"),
    "sessions": ReportSourceSpec("sessions", "postgrest", "class_sessions"),
    "staff_profiles": ReportSourceSpec("staff_profiles", "postgrest", "staff_profiles"),
    "staff_roles": ReportSourceSpec("staff_roles", "postgrest", "staff_roles"),
    "student_billing_enrollments": ReportSourceSpec("student_billing_enrollments", "postgrest", "student_billing_enrollments"),
    "student_guardians": ReportSourceSpec("student_guardians", "postgrest", "student_guardians"),
    "student_import_runs": ReportSourceSpec("student_import_runs", "postgrest", "student_import_runs"),
    "student_program_memberships": ReportSourceSpec("student_program_memberships", "postgrest", "student_program_memberships"),
    "students": ReportSourceSpec("students", "postgrest", "students"),
    "studio_payment_accounts": ReportSourceSpec("studio_payment_accounts", "postgrest", "studio_payment_accounts"),
    "studio_subscriptions": ReportSourceSpec("studio_subscriptions", "postgrest", "studio_subscriptions"),
    "studios": ReportSourceSpec("studios", "postgrest", "studios"),
})


@dataclass(frozen=True)
class CsvReport:
    id: str
    title: str
    filename: str
    columns: tuple[str, ...]
    source_keys: tuple[str, ...]
    table: Optional[str] = None
    order_by: tuple[tuple[str, bool], ...] = ()
    custom_builder: Optional[Callable[[Any, str], list[dict[str, Any]]]] = None
    min_role: str = "admin"
    contains_sensitive_data: bool = True
    availability: ReportAvailability = "available"


def _report(
    id: str,
    title: str,
    filename: str,
    columns: tuple[str, ...],
    *,
    source_keys: tuple[str, ...],
    table: Optional[str] = None,
    order_by: tuple[tuple[str, bool], ...] = (),
    custom_builder: Optional[Callable[[Any, str], list[dict[str, Any]]]] = None,
    min_role: str = "admin",
    contains_sensitive_data: bool = True,
    availability: ReportAvailability = "available",
) -> CsvReport:
    return CsvReport(
        id=id,
        title=title,
        filename=filename,
        table=table,
        columns=columns,
        source_keys=source_keys,
        order_by=order_by,
        custom_builder=custom_builder,
        min_role=min_role,
        contains_sensitive_data=contains_sensitive_data,
        availability=availability,
    )
