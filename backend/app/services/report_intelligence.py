from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional


ACTIVE_STUDENT_STATUSES = {"active", "trialing"}
OPEN_LEAD_STAGES = {"inquiry", "trial_scheduled", "trial_completed", "offer_sent"}
SUCCESS_PAYMENT_STATUSES = {"succeeded", "externally_recorded"}
BILLING_RISK_STATUSES = {"past_due", "failed", "unpaid"}
OPEN_INVOICE_STATUSES = {"open", "uncollectible", "partially_refunded"}
MISSING = "missing"


def _parse_date(value: Any) -> Optional[date]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def _days_since(value: Any, today: date) -> Optional[int]:
    parsed = _parse_date(value)
    if not parsed:
        return None
    return (today - parsed).days


def _date_key(value: Any) -> str:
    parsed = _parse_date(value)
    return parsed.isoformat() if parsed else ""


def _student_name(student: dict[str, Any]) -> str:
    preferred = student.get("preferred_name")
    first = preferred or student.get("legal_first_name") or ""
    last = student.get("legal_last_name") or ""
    return f"{first} {last}".strip()


def _student_start_date(student: dict[str, Any]) -> Optional[date]:
    return _parse_date(student.get("membership_start_date")) or _parse_date(student.get("created_at"))


def _is_active_student(student: dict[str, Any]) -> bool:
    return not student.get("deleted_at") and student.get("status") in ACTIVE_STUDENT_STATUSES


def _monthly_equivalent_cents(plan: Optional[dict[str, Any]]) -> int:
    if not plan:
        return 0
    amount = int(plan.get("amount_cents") or 0)
    interval = plan.get("billing_interval")
    if interval == "weekly":
        return round(amount * 52 / 12)
    if interval == "biweekly":
        return round(amount * 26 / 12)
    if interval == "annual":
        return round(amount / 12)
    if interval == "monthly":
        return amount
    return 0


def _attendance_events(data: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    sessions_by_id = {row.get("id"): row for row in data.get("sessions", [])}
    events: list[dict[str, Any]] = []
    for record in data.get("attendance", []):
        if record.get("status") == "absent":
            continue
        session = sessions_by_id.get(record.get("session_id")) or {}
        event_date = _parse_date(session.get("date")) or _parse_date(record.get("checked_in_at"))
        if not event_date:
            continue
        events.append({
            **record,
            "event_date": event_date,
            "session_program_id": session.get("program_id"),
            "session_instructor_id": session.get("instructor_id"),
            "session_capacity": session.get("capacity"),
            "session_name": session.get("name"),
            "session_status": session.get("status"),
        })
    return events


def _count_events(
    events: Iterable[dict[str, Any]],
    *,
    student_id: Optional[str] = None,
    start: Optional[date] = None,
    end: Optional[date] = None,
) -> int:
    count = 0
    for event in events:
        if student_id and event.get("student_id") != student_id:
            continue
        event_date = event["event_date"]
        if start and event_date < start:
            continue
        if end and event_date > end:
            continue
        count += 1
    return count


def _last_event_date(events: Iterable[dict[str, Any]], student_id: str) -> Optional[date]:
    dates = [event["event_date"] for event in events if event.get("student_id") == student_id]
    return max(dates) if dates else None


def _active_billing_for_student(
    student_id: str,
    enrollments_by_student: dict[str, list[dict[str, Any]]],
    payers_by_id: dict[str, dict[str, Any]],
) -> tuple[Optional[dict[str, Any]], Optional[dict[str, Any]], str]:
    enrollments = [
        row
        for row in enrollments_by_student.get(student_id, [])
        if row.get("status") in {"pending", "active", "paused"}
    ]
    if not enrollments:
        return None, None, "no_billing_enrollment"
    enrollment = sorted(enrollments, key=lambda row: str(row.get("created_at") or ""), reverse=True)[0]
    payer = payers_by_id.get(enrollment.get("payer_id"))
    status = enrollment.get("billing_status") or payer.get("billing_status") if payer else enrollment.get("billing_status")
    return enrollment, payer, status or "unknown"


def _promotion_lookup(data: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for promotion in data.get("promotions", []):
        key = promotion.get("student_program_membership_id") or f"student:{promotion.get('student_id')}:{promotion.get('program_id') or ''}"
        promoted_at = _parse_date(promotion.get("promoted_at"))
        if not key or not promoted_at:
            continue
        previous = latest.get(key)
        if not previous or promoted_at > previous["promoted_at_date"]:
            latest[key] = {**promotion, "promoted_at_date": promoted_at}
    return latest


def _student_risk(
    student: dict[str, Any],
    events: list[dict[str, Any]],
    enrollments_by_student: dict[str, list[dict[str, Any]]],
    payers_by_id: dict[str, dict[str, Any]],
    today: date,
) -> dict[str, Any]:
    student_id = student["id"]
    last_visit = _last_event_date(events, student_id)
    visits_14 = _count_events(events, student_id=student_id, start=today - timedelta(days=13), end=today)
    visits_30 = _count_events(events, student_id=student_id, start=today - timedelta(days=29), end=today)
    visits_previous_30 = _count_events(events, student_id=student_id, start=today - timedelta(days=59), end=today - timedelta(days=30))
    visits_90 = _count_events(events, student_id=student_id, start=today - timedelta(days=89), end=today)
    enrollment, payer, billing_status = _active_billing_for_student(student_id, enrollments_by_student, payers_by_id)

    risk_score = 0
    flags: list[str] = []
    days_since_last = (today - last_visit).days if last_visit else None
    if last_visit is None:
        risk_score += 35
        flags.append("no_attendance_history")
    elif days_since_last is not None and days_since_last > 30:
        risk_score += 30
        flags.append("no_visit_30_plus_days")
    elif days_since_last is not None and days_since_last > 14:
        risk_score += 20
        flags.append("no_visit_15_plus_days")

    if visits_30 == 0:
        risk_score += 25
        flags.append("zero_visits_last_30")
    elif visits_30 <= 1:
        risk_score += 15
        flags.append("one_visit_last_30")

    if visits_previous_30 >= 3 and visits_30 <= visits_previous_30 * 0.5:
        risk_score += 20
        flags.append("attendance_down_50_percent")

    if billing_status in BILLING_RISK_STATUSES:
        risk_score += 15
        flags.append(f"billing_{billing_status}")

    if student.get("status") == "paused":
        risk_score += 10
        flags.append("paused_student")

    return {
        "last_visit": last_visit,
        "days_since_last_visit": days_since_last,
        "visits_last_14_days": visits_14,
        "visits_last_30_days": visits_30,
        "visits_previous_30_days": visits_previous_30,
        "visits_last_90_days": visits_90,
        "billing_enrollment_id": enrollment.get("id") if enrollment else None,
        "payer_id": payer.get("id") if payer else None,
        "billing_status": billing_status,
        "risk_score": risk_score,
        "risk_flags": "|".join(flags),
    }


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


def build_belt_momentum_testing_pipeline(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    students_by_id = _index_one(data.get("students", []), "id")
    programs_by_id = _index_one(data.get("programs", []), "id")
    ranks_by_id = _index_one(data.get("belt_ranks", []), "id")
    ranks_by_ladder = _index_many(data.get("belt_ranks", []), "ladder_id")
    ladders_by_program = {row.get("program_id"): row for row in data.get("belt_ladders", []) if row.get("program_id")}
    latest_promotions = _promotion_lookup(data)
    rows: list[dict[str, Any]] = []

    memberships = [row for row in data.get("memberships", []) if row.get("status") == "active"]
    if not memberships:
        memberships = [
            {
                "id": "",
                "student_id": student.get("id"),
                "program_id": student.get("program_id"),
                "current_belt_rank_id": student.get("current_belt_rank_id"),
                "status": student.get("status"),
            }
            for student in data.get("students", [])
            if _is_active_student(student)
        ]

    for membership in memberships:
        student = students_by_id.get(membership.get("student_id"))
        if not student or not _is_active_student(student):
            continue
        current_rank = ranks_by_id.get(membership.get("current_belt_rank_id") or student.get("current_belt_rank_id"))
        program = programs_by_id.get(membership.get("program_id") or student.get("program_id")) or {}
        next_rank = None
        if current_rank:
            siblings = sorted(ranks_by_ladder.get(current_rank.get("ladder_id"), []), key=lambda row: int(row.get("display_order") or 0))
            for rank in siblings:
                if int(rank.get("display_order") or 0) > int(current_rank.get("display_order") or 0):
                    next_rank = rank
                    break
        elif program.get("id") in ladders_by_program:
            siblings = sorted(ranks_by_ladder.get(ladders_by_program[program.get("id")].get("id"), []), key=lambda row: int(row.get("display_order") or 0))
            next_rank = siblings[0] if siblings else None

        promo_key = membership.get("id") or f"student:{student.get('id')}:{membership.get('program_id') or ''}"
        latest_promotion = latest_promotions.get(promo_key) or latest_promotions.get(f"student:{student.get('id')}:{membership.get('program_id') or ''}") or {}
        rank_start = latest_promotion.get("promoted_at_date") or _parse_date(membership.get("started_at")) or _student_start_date(student)
        classes_since = _count_events(events, student_id=student["id"], start=rank_start, end=today) if rank_start else _count_events(events, student_id=student["id"], end=today)
        days_at_rank = (today - rank_start).days if rank_start else ""
        required_classes = int(next_rank.get("min_classes") or 0) if next_rank else 0
        required_days = int(next_rank.get("min_months") or 0) * 30 if next_rank else 0
        classes_met = bool(next_rank) and classes_since >= required_classes
        time_met = bool(next_rank) and isinstance(days_at_rank, int) and days_at_rank >= required_days
        if not current_rank and not next_rank:
            status_text = "missing_rank_ladder"
        elif not next_rank:
            status_text = "top_rank"
        elif classes_met and time_met:
            status_text = "ready_for_review" if next_rank.get("requires_approval") else "ready_to_test"
        elif classes_met:
            status_text = "time_pending"
        elif time_met:
            status_text = "classes_pending"
        else:
            status_text = "building_momentum"
        rows.append({
            "student_id": student.get("id"),
            "student_name": _student_name(student),
            "program_id": program.get("id") or membership.get("program_id") or "",
            "program_name": program.get("name") or "",
            "membership_id": membership.get("id") or "",
            "current_rank_id": current_rank.get("id") if current_rank else "",
            "current_rank_name": current_rank.get("name") if current_rank else "",
            "next_rank_id": next_rank.get("id") if next_rank else "",
            "next_rank_name": next_rank.get("name") if next_rank else "",
            "classes_since_rank_start": classes_since,
            "classes_required_for_next_rank": required_classes,
            "days_at_rank": days_at_rank,
            "days_required_for_next_rank": required_days,
            "classes_met": classes_met,
            "time_met": time_met,
            "requires_approval": bool(next_rank.get("requires_approval")) if next_rank else False,
            "pipeline_status": status_text,
        })
    status_rank = {"ready_to_test": 0, "ready_for_review": 1, "classes_pending": 2, "time_pending": 3}
    return sorted(rows, key=lambda row: (status_rank.get(row["pipeline_status"], 9), row["student_name"]))


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


def build_schedule_utilization_demand(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    programs_by_id = _index_one(data.get("programs", []), "id")
    attendance_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        attendance_by_session[event.get("session_id")].append(event)
    grouped: dict[str, dict[str, Any]] = {}
    for session in data.get("sessions", []):
        session_date = _parse_date(session.get("date"))
        if not session_date or session.get("deleted_at") or session_date < today - timedelta(days=89) or session_date > today:
            continue
        key = f"{session.get('program_id') or ''}|{session.get('name') or ''}|{session.get('start_time') or ''}"
        row = grouped.setdefault(key, {
            "program_id": session.get("program_id") or "",
            "program_name": (programs_by_id.get(session.get("program_id")) or {}).get("name") or "",
            "class_name": session.get("name") or "",
            "start_time": str(session.get("start_time") or ""),
            "sessions_scheduled": 0,
            "sessions_canceled": 0,
            "sessions_with_capacity": 0,
            "total_capacity": 0,
            "total_attendance": 0,
            "unique_students": set(),
            "attendance_last_30_days": 0,
            "attendance_prior_60_days": 0,
        })
        row["sessions_scheduled"] += 1
        if session.get("status") == "canceled":
            row["sessions_canceled"] += 1
        attendees = attendance_by_session.get(session.get("id"), [])
        row["total_attendance"] += len(attendees)
        for event in attendees:
            row["unique_students"].add(event.get("student_id"))
        if session.get("capacity"):
            row["sessions_with_capacity"] += 1
            row["total_capacity"] += int(session.get("capacity") or 0)
        if session_date >= today - timedelta(days=29):
            row["attendance_last_30_days"] += len(attendees)
        else:
            row["attendance_prior_60_days"] += len(attendees)
    rows = []
    for row in grouped.values():
        scheduled = int(row["sessions_scheduled"])
        capacity = int(row["total_capacity"])
        utilization = round(int(row["total_attendance"]) / capacity, 4) if capacity else ""
        avg_attendance = round(int(row["total_attendance"]) / max(1, scheduled - int(row["sessions_canceled"])), 2)
        recommendation = "monitor"
        if utilization != "" and utilization >= 0.85 and scheduled >= 3:
            recommendation = "consider_adding_capacity_or_more_sessions"
        elif utilization != "" and utilization <= 0.35 and scheduled >= 3:
            recommendation = "consider_consolidating_or_repositioning"
        elif int(row["attendance_last_30_days"]) > int(row["attendance_prior_60_days"]) / 2:
            recommendation = "demand_rising"
        rows.append({
            **{key: value for key, value in row.items() if key != "unique_students"},
            "unique_students": len(row["unique_students"]),
            "average_attendance": avg_attendance,
            "average_capacity": round(capacity / int(row["sessions_with_capacity"]), 2) if row["sessions_with_capacity"] else "",
            "utilization_rate": utilization,
            "recommendation": recommendation,
        })
    return sorted(rows, key=lambda row: (row["recommendation"], int(row["total_attendance"])), reverse=True)


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


def build_instructor_staff_impact(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    events = _attendance_events(data)
    leads_by_staff = _index_many(data.get("leads", []), "assigned_staff_id")
    rows_by_staff: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "staff_user_id": "",
        "classes_taught_90_days": 0,
        "total_attendance_90_days": 0,
        "unique_students_90_days": set(),
        "sessions_with_capacity": 0,
        "total_capacity": 0,
    })
    attendance_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        attendance_by_session[event.get("session_id")].append(event)
    for session in data.get("sessions", []):
        session_date = _parse_date(session.get("date"))
        if not session_date or session_date < today - timedelta(days=89) or session_date > today or session.get("deleted_at") or session.get("status") == "canceled":
            continue
        staff_id = session.get("instructor_id") or "unassigned"
        row = rows_by_staff[staff_id]
        row["staff_user_id"] = staff_id
        row["classes_taught_90_days"] += 1
        attendees = attendance_by_session.get(session.get("id"), [])
        row["total_attendance_90_days"] += len(attendees)
        for event in attendees:
            row["unique_students_90_days"].add(event.get("student_id"))
        if session.get("capacity"):
            row["sessions_with_capacity"] += 1
            row["total_capacity"] += int(session.get("capacity") or 0)
    rows = []
    for staff_id, row in rows_by_staff.items():
        staff_leads = leads_by_staff.get(staff_id, [])
        enrolled = sum(1 for lead in staff_leads if lead.get("stage") == "enrolled" or lead.get("converted_student_id"))
        classes = int(row["classes_taught_90_days"])
        attendance = int(row["total_attendance_90_days"])
        capacity = int(row["total_capacity"])
        rows.append({
            "staff_user_id": staff_id,
            "classes_taught_90_days": classes,
            "total_attendance_90_days": attendance,
            "average_attendance_per_class": round(attendance / classes, 2) if classes else 0,
            "unique_students_90_days": len(row["unique_students_90_days"]),
            "sessions_with_capacity": row["sessions_with_capacity"],
            "utilization_rate": round(attendance / capacity, 4) if capacity else "",
            "assigned_leads": len(staff_leads),
            "assigned_leads_enrolled_or_converted": enrolled,
            "assigned_lead_conversion_rate": round(enrolled / len(staff_leads), 4) if staff_leads else "",
        })
    return sorted(rows, key=lambda row: (int(row["total_attendance_90_days"]), int(row["assigned_leads_enrolled_or_converted"])), reverse=True)


def build_data_hygiene_readiness(data: dict[str, list[dict[str, Any]]], today: date) -> list[dict[str, Any]]:
    del today
    guardians_by_student = _index_many(data.get("student_guardians", []), "student_id")
    billing_enrollments_by_student = _index_many(data.get("billing_enrollments", []), "student_id")
    memberships_by_student = _index_many(data.get("memberships", []), "student_id")
    rows: list[dict[str, Any]] = []
    for student in data.get("students", []):
        if student.get("deleted_at"):
            continue
        student_id = student.get("id")
        active = _is_active_student(student)
        if student.get("is_minor") and not guardians_by_student.get(student_id):
            rows.append(_hygiene_row("minor_without_guardian", "high", "student", student_id, student_id, "Minor student has no linked guardian.", "Add at least one guardian contact."))
        if active and not student.get("emergency_contact_name"):
            rows.append(_hygiene_row("missing_emergency_contact", "medium", "student", student_id, student_id, "Active student has no emergency contact name.", "Add emergency contact details."))
        if active and not student.get("program_id") and not any(row.get("status") == "active" for row in memberships_by_student.get(student_id, [])):
            rows.append(_hygiene_row("missing_program_assignment", "medium", "student", student_id, student_id, "Active student is not clearly assigned to a program.", "Assign a program membership."))
        has_membership_rank = any(row.get("current_belt_rank_id") for row in memberships_by_student.get(student_id, []))
        if active and not student.get("current_belt_rank_id") and not has_membership_rank:
            rows.append(_hygiene_row("missing_rank_assignment", "low", "student", student_id, student_id, "Active student has no current belt rank on the legacy student record.", "Set the current rank or verify program membership rank."))
        if active and not billing_enrollments_by_student.get(student_id):
            rows.append(_hygiene_row("missing_billing_enrollment", "high", "student", student_id, student_id, "Active student has no billing enrollment.", "Attach a billing plan or mark billing as intentionally external."))

    for lead in data.get("leads", []):
        if lead.get("stage") in OPEN_LEAD_STAGES and not lead.get("follow_up_date"):
            rows.append(_hygiene_row("active_lead_without_follow_up", "medium", "lead", lead.get("id"), "", "Active lead has no follow-up date.", "Schedule a follow-up date."))
    for payer in data.get("billing_payers", []):
        if not payer.get("email") and not payer.get("phone"):
            rows.append(_hygiene_row("payer_without_contact_method", "high", "billing_payer", payer.get("id"), "", "Payer has neither email nor phone.", "Add at least one payer contact method."))
    severity_rank = {"high": 0, "medium": 1, "low": 2}
    return sorted(rows, key=lambda row: (severity_rank.get(row["severity"], 9), row["issue_type"], row["entity_id"] or ""))


def _index_one(rows: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    return {row[key]: row for row in rows if row.get(key)}


def _index_many(rows: list[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get(key):
            grouped[row[key]].append(row)
    return grouped


def _latest_by(rows: list[dict[str, Any]], key: str, date_key: str) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        group_key = row.get(key)
        row_date = _parse_date(row.get(date_key))
        if not group_key or not row_date:
            continue
        previous = latest.get(group_key)
        if not previous or row_date > (_parse_date(previous.get(date_key)) or date.min):
            latest[group_key] = row
    return latest


def _last_first_visit(events: list[dict[str, Any]], student_id: str, *, first: bool) -> Optional[date]:
    dates = sorted(event["event_date"] for event in events if event.get("student_id") == student_id)
    if not dates:
        return None
    return dates[0] if first else dates[-1]


def _onboarding_status(days_since_start: int, visits_to_date: int, visits_first_7: int, visits_first_30: int) -> tuple[str, str]:
    if visits_to_date >= 5:
        return "habit_forming", "Keep momentum and introduce the next rank/progress checkpoint."
    if days_since_start >= 14 and visits_to_date == 0:
        return "no_first_visit", "Prioritize immediate personal outreach."
    if days_since_start >= 30 and visits_first_30 < 4:
        return "weak_first_month", "Call or text with a specific class recommendation this week."
    if days_since_start >= 7 and visits_first_7 == 0:
        return "slow_start", "Nudge toward the next beginner-friendly class."
    return "on_track", "Keep normal onboarding touchpoints."


def _leakage_row(
    leakage_type: str,
    severity: str,
    student: dict[str, Any],
    *,
    enrollment: Optional[dict[str, Any]] = None,
    payer: Optional[dict[str, Any]] = None,
    invoice: Optional[dict[str, Any]] = None,
    amount_cents: int = 0,
    detail: str,
    action: str,
) -> dict[str, Any]:
    return {
        "leakage_type": leakage_type,
        "severity": severity,
        "student_id": student.get("id") or "",
        "student_name": _student_name(student) if student else "",
        "payer_id": (payer or {}).get("id") or "",
        "payer_name": (payer or {}).get("display_name") or "",
        "enrollment_id": (enrollment or {}).get("id") or "",
        "invoice_id": (invoice or {}).get("id") or "",
        "amount_cents": amount_cents,
        "detail": detail,
        "recommended_action": action,
    }


def _family_row(
    household_key: str,
    household_name: str,
    contact: dict[str, Any],
    students: list[dict[str, Any]],
    events: list[dict[str, Any]],
    enrollments_by_student: dict[str, list[dict[str, Any]]],
    payers_by_id: dict[str, dict[str, Any]],
    today: date,
) -> dict[str, Any]:
    active_students = [student for student in students if _is_active_student(student)]
    visits_30 = sum(_count_events(events, student_id=student["id"], start=today - timedelta(days=29), end=today) for student in students)
    at_risk = 0
    for student in active_students:
        risk = _student_risk(student, events, enrollments_by_student, payers_by_id, today)
        if int(risk["risk_score"]) >= 40:
            at_risk += 1
    contact_missing = not contact.get("email") and not contact.get("phone")
    balance = int(contact.get("balance_cents") or 0)
    priority = at_risk * 35 + (25 if contact.get("billing_status") in BILLING_RISK_STATUSES else 0) + (15 if contact_missing else 0) + min(25, balance // 5000)
    return {
        "household_key": household_key,
        "household_name": household_name,
        "contact_email": contact.get("email") or "",
        "contact_phone": contact.get("phone") or "",
        "billing_status": contact.get("billing_status") or "",
        "balance_cents": balance,
        "total_students": len(students),
        "active_students": len(active_students),
        "visits_last_30_days": visits_30,
        "at_risk_active_students": at_risk,
        "missing_contact_method": contact_missing,
        "priority_score": priority,
    }


def _lifecycle_segment(student: dict[str, Any], risk: dict[str, Any], days_since_start: Any) -> tuple[str, str]:
    if student.get("status") in {"inactive", "canceled"}:
        return "inactive_or_canceled", f"Student status is {student.get('status')}."
    if student.get("status") == "paused":
        return "paused", "Student is paused."
    if isinstance(days_since_start, int) and days_since_start <= 90:
        return "new_first_90_days", "Student is still in the first 90 days."
    if int(risk["risk_score"]) >= 40:
        return "at_risk", risk["risk_flags"]
    if int(risk["visits_last_30_days"]) >= 4:
        return "core_engaged", "Four or more visits in the last 30 days."
    if int(risk["visits_last_30_days"]) >= 1:
        return "active_light", "One to three visits in the last 30 days."
    return "quiet", "No visits in the last 30 days."


def _hygiene_row(issue_type: str, severity: str, entity_type: str, entity_id: Any, student_id: Any, detail: str, action: str) -> dict[str, Any]:
    return {
        "issue_type": issue_type,
        "severity": severity,
        "entity_type": entity_type,
        "entity_id": entity_id or "",
        "student_id": student_id or "",
        "detail": detail,
        "recommended_action": action,
    }
