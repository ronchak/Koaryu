from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from app.services.report_intelligence_helpers import (
    OPEN_LEAD_STAGES,
    _attendance_events,
    _count_events,
    _hygiene_row,
    _index_many,
    _index_one,
    _is_active_student,
    _parse_date,
    _promotion_lookup,
    _student_name,
    _student_start_date,
)


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
