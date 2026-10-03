"""Birth dates use the studio's date, never the API host's date."""

from datetime import date

from fastapi import HTTPException


def validate_student_birth_date(date_of_birth: date | str | None, business_date: date | None):
    if date_of_birth is None:
        return
    birth_date = (
        date.fromisoformat(date_of_birth) if isinstance(date_of_birth, str) else date_of_birth
    )
    if business_date is None:
        raise RuntimeError("Studio business date is required to validate a birth date.")
    if birth_date > business_date:
        raise HTTPException(status_code=422, detail="Date of birth cannot be in the future.")
