from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from app.services.report_intelligence_helpers import (
    OPEN_INVOICE_STATUSES,
    OPEN_LEAD_STAGES,
    SUCCESS_PAYMENT_STATUSES,
    _attendance_events,
    _count_events,
    _date_key,
    _days_since,
    _index_many,
    _index_one,
    _is_active_student,
    _last_first_visit,
    _latest_by,
    _lifecycle_segment,
    _monthly_equivalent_cents,
    _onboarding_status,
    _parse_date,
    _student_name,
    _student_risk,
    _student_start_date,
)


def build_owner_kpi_summary(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    students = data.get("students", [])
    active_students = [student for student in students if _is_active_student(student)]
    leads = data.get("leads", [])
    sessions = [row for row in data.get("sessions", []) if not row.get("deleted_at")]
    plans_by_id = {row.get("id"): row for row in data.get("billing_plans", [])}
    active_enrollments = [row for row in data.get("billing_enrollments", []) if row.get("status") == "active"]
    invoices = data.get("invoices", [])
    payments = data.get("payments", [])

    visits_30 = _count_events(events, start=today - timedelta(days=29), end=today)
    unique_attendees_30 = len({
        event.get("student_id")
        for event in events
        if today - timedelta(days=29) <= event["event_date"] <= today
    })
    sessions_30 = [
        row
        for row in sessions
        if row.get("status") != "canceled"
        and (session_date := _parse_date(row.get("date")))
        and today - timedelta(days=29) <= session_date <= today
    ]
    attendance_by_session: dict[str, int] = defaultdict(int)
    for event in events:
        if today - timedelta(days=29) <= event["event_date"] <= today:
            attendance_by_session[event.get("session_id")] += 1
    capacity_total = sum(int(row.get("capacity") or 0) for row in sessions_30 if row.get("capacity"))
    capacity_attendance = sum(
        attendance_by_session.get(row.get("id"), 0)
        for row in sessions_30
        if row.get("capacity")
    )
    mrr_cents = sum(_monthly_equivalent_cents(plans_by_id.get(row.get("billing_plan_id"))) for row in active_enrollments)
    open_invoice_cents = sum(
        max(0, int(row.get("amount_due_cents") or 0) - int(row.get("amount_paid_cents") or 0))
        for row in invoices
        if row.get("status") in OPEN_INVOICE_STATUSES
    )
    failed_payment_cents = sum(
        int(row.get("amount_cents") or 0)
        for row in payments
        if row.get("status") == "failed" and (_parse_date(row.get("created_at")) or today) >= today - timedelta(days=29)
    )
    new_students_30 = sum(
        1
        for student in students
        if (start_date := _student_start_date(student)) and start_date >= today - timedelta(days=29) and not student.get("deleted_at")
    )
    total_leads = len(leads)
    enrolled_leads = sum(1 for lead in leads if lead.get("stage") == "enrolled" or lead.get("converted_student_id"))
    active_leads = sum(1 for lead in leads if lead.get("stage") in OPEN_LEAD_STAGES)
    new_leads_30 = sum(
        1
        for lead in leads
        if (_parse_date(lead.get("created_at")) or today) >= today - timedelta(days=29)
    )

    return [
        {"metric": "active_students", "value": len(active_students), "context": "Students with active or trialing status and no deleted_at."},
        {"metric": "new_students_30_days", "value": new_students_30, "context": "Students whose membership_start_date or created_at is within 30 days."},
        {"metric": "visits_30_days", "value": visits_30, "context": "Non-absent attendance records tied to sessions in the last 30 days."},
        {"metric": "unique_attendees_30_days", "value": unique_attendees_30, "context": "Distinct students with at least one non-absent visit in the last 30 days."},
        {"metric": "avg_visits_per_active_student_30_days", "value": round(visits_30 / len(active_students), 2) if active_students else 0, "context": "30-day visits divided by active student count."},
        {"metric": "class_utilization_30_days", "value": round(capacity_attendance / capacity_total, 4) if capacity_total else "", "context": "Attendance divided by capacity for non-canceled sessions with capacity."},
        {"metric": "active_pipeline_leads", "value": active_leads, "context": "Leads still before enrolled or closed_lost."},
        {"metric": "new_leads_30_days", "value": new_leads_30, "context": "Leads created in the last 30 days."},
        {"metric": "lead_conversion_rate", "value": round(enrolled_leads / total_leads, 4) if total_leads else "", "context": "Enrolled or converted leads divided by all leads."},
        {"metric": "estimated_mrr_cents", "value": mrr_cents, "context": "Monthly-equivalent value of active billing enrollments."},
        {"metric": "open_invoice_exposure_cents", "value": open_invoice_cents, "context": "Unpaid amount on open, uncollectible, or partially refunded invoices."},
        {"metric": "failed_payment_amount_30_days_cents", "value": failed_payment_cents, "context": "Failed payment amount created in the last 30 days."},
    ]


def build_quiet_churn_watchlist(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    enrollments_by_student = _index_many(data.get("billing_enrollments", []), "student_id")
    payers_by_id = _index_one(data.get("billing_payers", []), "id")
    promotions_by_student = _latest_by(data.get("promotions", []), "student_id", "promoted_at")
    rows: list[dict[str, Any]] = []
    for student in data.get("students", []):
        if not _is_active_student(student):
            continue
        risk = _student_risk(student, events, enrollments_by_student, payers_by_id, today)
        if int(risk["risk_score"]) < 10:
            continue
        promotion = promotions_by_student.get(student.get("id")) or {}
        rows.append({
            "student_id": student.get("id"),
            "student_name": _student_name(student),
            "student_status": student.get("status"),
            "membership_start_date": _date_key(student.get("membership_start_date")),
            "last_visit_date": risk["last_visit"].isoformat() if risk["last_visit"] else "",
            "days_since_last_visit": risk["days_since_last_visit"],
            "visits_last_14_days": risk["visits_last_14_days"],
            "visits_last_30_days": risk["visits_last_30_days"],
            "visits_previous_30_days": risk["visits_previous_30_days"],
            "visits_last_90_days": risk["visits_last_90_days"],
            "billing_status": risk["billing_status"],
            "billing_enrollment_id": risk["billing_enrollment_id"],
            "payer_id": risk["payer_id"],
            "last_promotion_at": _date_key(promotion.get("promoted_at")),
            "days_since_last_promotion": _days_since(promotion.get("promoted_at"), today),
            "risk_score": risk["risk_score"],
            "risk_flags": risk["risk_flags"],
        })
    return sorted(rows, key=lambda row: (int(row["risk_score"]), row["student_name"]), reverse=True)


def build_first_90_days_onboarding(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    leads_by_student = _index_one([lead for lead in data.get("leads", []) if lead.get("converted_student_id")], "converted_student_id")
    rows: list[dict[str, Any]] = []
    for student in data.get("students", []):
        if student.get("deleted_at"):
            continue
        start_date = _student_start_date(student)
        if not start_date:
            continue
        days_since_start = (today - start_date).days
        if days_since_start < 0 or days_since_start > 90:
            continue
        first_visit = _last_first_visit(events, student["id"], first=True)
        visits_to_date = _count_events(events, student_id=student["id"], start=start_date, end=today)
        visits_first_7 = _count_events(events, student_id=student["id"], start=start_date, end=min(today, start_date + timedelta(days=6)))
        visits_first_30 = _count_events(events, student_id=student["id"], start=start_date, end=min(today, start_date + timedelta(days=29)))
        visits_first_90 = _count_events(events, student_id=student["id"], start=start_date, end=min(today, start_date + timedelta(days=89)))
        status, action = _onboarding_status(days_since_start, visits_to_date, visits_first_7, visits_first_30)
        lead = leads_by_student.get(student.get("id")) or {}
        rows.append({
            "student_id": student.get("id"),
            "student_name": _student_name(student),
            "student_status": student.get("status"),
            "membership_start_date": start_date.isoformat(),
            "days_since_start": days_since_start,
            "first_visit_date": first_visit.isoformat() if first_visit else "",
            "days_to_first_visit": (first_visit - start_date).days if first_visit else "",
            "visits_to_date": visits_to_date,
            "visits_first_7_days": visits_first_7,
            "visits_first_30_days": visits_first_30,
            "visits_first_90_days": visits_first_90,
            "completed_first_5_classes": visits_to_date >= 5,
            "lead_source": lead.get("source") or "",
            "lead_id": lead.get("id") or "",
            "onboarding_status": status,
            "recommended_action": action,
        })
    return sorted(rows, key=lambda row: (row["onboarding_status"], -int(row["days_since_start"])))


def build_lead_quality_after_enrollment(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    students_by_id = _index_one(data.get("students", []), "id")
    invoices_by_id = _index_one(data.get("invoices", []), "id")
    payments_by_student: dict[str, int] = defaultdict(int)
    for payment in data.get("payments", []):
        if payment.get("status") not in SUCCESS_PAYMENT_STATUSES:
            continue
        invoice = invoices_by_id.get(payment.get("invoice_id")) or {}
        student_id = invoice.get("student_id")
        if student_id:
            payments_by_student[student_id] += int(payment.get("amount_cents") or 0)

    groups: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "source": "",
        "total_leads": 0,
        "active_pipeline_leads": 0,
        "enrolled_or_converted_leads": 0,
        "converted_students_with_records": 0,
        "active_converted_students": 0,
        "first_30_day_visits": 0,
        "lifetime_payment_cents": 0,
    })
    for lead in data.get("leads", []):
        source = lead.get("source") or "unknown"
        row = groups[source]
        row["source"] = source
        row["total_leads"] += 1
        if lead.get("stage") in OPEN_LEAD_STAGES:
            row["active_pipeline_leads"] += 1
        if lead.get("stage") == "enrolled" or lead.get("converted_student_id"):
            row["enrolled_or_converted_leads"] += 1
        student = students_by_id.get(lead.get("converted_student_id"))
        if not student:
            continue
        row["converted_students_with_records"] += 1
        if _is_active_student(student):
            row["active_converted_students"] += 1
        start_date = _student_start_date(student)
        if start_date:
            row["first_30_day_visits"] += _count_events(events, student_id=student["id"], start=start_date, end=start_date + timedelta(days=29))
        row["lifetime_payment_cents"] += payments_by_student.get(student["id"], 0)

    rows = []
    for row in groups.values():
        converted = int(row["converted_students_with_records"])
        total = int(row["total_leads"])
        row["lead_conversion_rate"] = round(int(row["enrolled_or_converted_leads"]) / total, 4) if total else ""
        row["avg_first_30_day_visits_per_converted_student"] = round(int(row["first_30_day_visits"]) / converted, 2) if converted else ""
        row["avg_lifetime_payment_per_converted_student_cents"] = round(int(row["lifetime_payment_cents"]) / converted) if converted else ""
        row["active_converted_student_rate"] = round(int(row["active_converted_students"]) / converted, 4) if converted else ""
        rows.append(row)
    return sorted(rows, key=lambda row: (int(row["lifetime_payment_cents"]), int(row["enrolled_or_converted_leads"])), reverse=True)


def build_lifecycle_segmentation(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    enrollments_by_student = _index_many(data.get("billing_enrollments", []), "student_id")
    payers_by_id = _index_one(data.get("billing_payers", []), "id")
    rows = []
    for student in data.get("students", []):
        if student.get("deleted_at"):
            continue
        risk = _student_risk(student, events, enrollments_by_student, payers_by_id, today)
        start_date = _student_start_date(student)
        days_since_start = (today - start_date).days if start_date else ""
        segment, reason = _lifecycle_segment(student, risk, days_since_start)
        rows.append({
            "student_id": student.get("id"),
            "student_name": _student_name(student),
            "student_status": student.get("status"),
            "membership_start_date": start_date.isoformat() if start_date else "",
            "days_since_start": days_since_start,
            "lifecycle_segment": segment,
            "segment_reason": reason,
            "last_visit_date": risk["last_visit"].isoformat() if risk["last_visit"] else "",
            "days_since_last_visit": risk["days_since_last_visit"],
            "visits_last_30_days": risk["visits_last_30_days"],
            "billing_status": risk["billing_status"],
            "risk_score": risk["risk_score"],
            "risk_flags": risk["risk_flags"],
        })
    return sorted(rows, key=lambda row: (row["lifecycle_segment"], row["student_name"]))
