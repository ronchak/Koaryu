from datetime import date
from typing import Optional


def age_on_date(date_of_birth: date, reference_date: date) -> int:
    age = reference_date.year - date_of_birth.year
    if (reference_date.month, reference_date.day) < (
        date_of_birth.month,
        date_of_birth.day,
    ):
        age -= 1
    return age


def is_minor_on_date(date_of_birth: Optional[date | str], reference_date: date) -> bool:
    if not date_of_birth:
        return False
    if isinstance(date_of_birth, str):
        date_of_birth = date.fromisoformat(date_of_birth)
    return age_on_date(date_of_birth, reference_date) < 18
