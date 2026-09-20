from datetime import date, datetime, timezone
from typing import Optional

from app.services.student_age import is_minor_on_date


def is_minor_from_date_of_birth(date_of_birth: Optional[date]) -> bool:
    today = datetime.now(timezone.utc).date()
    return is_minor_on_date(date_of_birth, today)


def prepare_student_write_payload(payload: dict, *, for_creation: bool) -> dict:
    if payload.get("tags") is None and (for_creation or "tags" in payload):
        payload["tags"] = []

    date_of_birth = payload.get("date_of_birth")
    if isinstance(date_of_birth, str) and date_of_birth:
        date_of_birth = date.fromisoformat(date_of_birth)
        payload["date_of_birth"] = date_of_birth
    if date_of_birth:
        payload["is_minor"] = is_minor_from_date_of_birth(date_of_birth)
        payload["date_of_birth"] = str(date_of_birth)
    elif for_creation:
        payload["is_minor"] = False

    if payload.get("membership_start_date"):
        if isinstance(payload["membership_start_date"], str):
            payload["membership_start_date"] = date.fromisoformat(payload["membership_start_date"])
        payload["membership_start_date"] = str(payload["membership_start_date"])

    if payload.get("hold_start_date"):
        if isinstance(payload["hold_start_date"], str):
            payload["hold_start_date"] = date.fromisoformat(payload["hold_start_date"])
        payload["hold_start_date"] = str(payload["hold_start_date"])

    if payload.get("hold_end_date"):
        if isinstance(payload["hold_end_date"], str):
            payload["hold_end_date"] = date.fromisoformat(payload["hold_end_date"])
        payload["hold_end_date"] = str(payload["hold_end_date"])

    return payload
