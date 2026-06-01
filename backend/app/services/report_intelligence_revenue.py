from datetime import date, timedelta
from typing import Any

from app.services.report_intelligence_helpers import (
    BILLING_RISK_STATUSES,
    OPEN_INVOICE_STATUSES,
    _attendance_events,
    _family_row,
    _index_many,
    _index_one,
    _is_active_student,
    _leakage_row,
    _parse_date,
)


def build_revenue_leakage(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    students_by_id = _index_one(data.get("students", []), "id")
    active_students = [student for student in data.get("students", []) if _is_active_student(student)]
    enrollments_by_student = _index_many(data.get("billing_enrollments", []), "student_id")
    payers_by_id = _index_one(data.get("billing_payers", []), "id")
    invoices_by_id = _index_one(data.get("invoices", []), "id")
    rows: list[dict[str, Any]] = []

    for student in active_students:
        active_enrollments = [row for row in enrollments_by_student.get(student["id"], []) if row.get("status") in {"pending", "active", "paused"}]
        if not active_enrollments:
            rows.append(_leakage_row("active_student_without_billing", "high", student, detail="Active student has no active billing enrollment.", action="Attach the student to a payer and billing plan."))

    for enrollment in data.get("billing_enrollments", []):
        if enrollment.get("status") not in {"pending", "active", "paused"}:
            continue
        student = students_by_id.get(enrollment.get("student_id")) or {}
        payer = payers_by_id.get(enrollment.get("payer_id"))
        if not payer:
            rows.append(_leakage_row("enrollment_without_payer", "high", student, enrollment=enrollment, detail="Billing enrollment has no payer.", action="Assign a family payer before the next billing run."))
        if not enrollment.get("next_bill_on") and enrollment.get("status") == "active":
            rows.append(_leakage_row("active_enrollment_missing_next_bill_date", "medium", student, enrollment=enrollment, payer=payer, detail="Active billing enrollment has no next_bill_on date.", action="Review the billing schedule and set the next bill date."))
        billing_status = enrollment.get("billing_status") or (payer or {}).get("billing_status")
        if billing_status in BILLING_RISK_STATUSES:
            rows.append(_leakage_row("billing_status_needs_attention", "high", student, enrollment=enrollment, payer=payer, detail=f"Billing status is {billing_status}.", action="Follow up with payer and resolve payment method or balance."))

    for invoice in data.get("invoices", []):
        unpaid = max(0, int(invoice.get("amount_due_cents") or 0) - int(invoice.get("amount_paid_cents") or 0))
        if invoice.get("status") in OPEN_INVOICE_STATUSES and unpaid > 0:
            rows.append(_leakage_row(
                "open_invoice_balance",
                "high" if unpaid >= 10000 else "medium",
                students_by_id.get(invoice.get("student_id")) or {},
                payer=payers_by_id.get(invoice.get("payer_id")),
                invoice=invoice,
                amount_cents=unpaid,
                detail=f"Invoice has {unpaid} cents unpaid.",
                action="Collect, void, or mark the invoice externally resolved.",
            ))

    for payment in data.get("payments", []):
        if payment.get("status") == "failed" and (_parse_date(payment.get("created_at")) or today) >= today - timedelta(days=29):
            invoice = invoices_by_id.get(payment.get("invoice_id")) or {}
            rows.append(_leakage_row(
                "failed_payment_last_30_days",
                "high",
                students_by_id.get(invoice.get("student_id")) or {},
                payer=payers_by_id.get(payment.get("payer_id")),
                invoice=invoice,
                amount_cents=int(payment.get("amount_cents") or 0),
                detail="A payment failed in the last 30 days.",
                action="Retry payment or contact the payer.",
            ))

    severity_rank = {"high": 0, "medium": 1, "low": 2}
    return sorted(rows, key=lambda row: (severity_rank.get(row["severity"], 9), -int(row.get("amount_cents") or 0), row["student_name"]))


def build_family_account_health(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    students_by_id = _index_one(data.get("students", []), "id")
    enrollments_by_payer = _index_many(data.get("billing_enrollments", []), "payer_id")
    payers = data.get("billing_payers", [])
    guardians_by_id = _index_one(data.get("guardians", []), "id")
    guardian_links = data.get("student_guardians", [])
    enrollments_by_student = _index_many(data.get("billing_enrollments", []), "student_id")
    payers_by_id = _index_one(payers, "id")
    rows: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    for payer in payers:
        student_ids = {row.get("student_id") for row in enrollments_by_payer.get(payer.get("id"), []) if row.get("student_id")}
        rows.append(_family_row(
            f"payer:{payer.get('id')}",
            payer.get("display_name") or "Unnamed payer",
            payer,
            [students_by_id[student_id] for student_id in student_ids if student_id in students_by_id],
            events,
            enrollments_by_student,
            payers_by_id,
            today,
        ))
        seen_keys.add(f"payer:{payer.get('id')}")

    links_by_guardian = _index_many(guardian_links, "guardian_id")
    for guardian_id, links in links_by_guardian.items():
        key = f"guardian:{guardian_id}"
        if key in seen_keys:
            continue
        guardian = guardians_by_id.get(guardian_id) or {}
        rows.append(_family_row(
            key,
            f"{guardian.get('first_name') or ''} {guardian.get('last_name') or ''}".strip() or "Unnamed guardian",
            guardian,
            [students_by_id[link.get("student_id")] for link in links if link.get("student_id") in students_by_id],
            events,
            enrollments_by_student,
            payers_by_id,
            today,
        ))
    return sorted(rows, key=lambda row: (int(row["priority_score"]), int(row["active_students"])), reverse=True)
