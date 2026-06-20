from collections import defaultdict
from datetime import date, datetime, timedelta
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
