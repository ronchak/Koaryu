from datetime import date

import pytest

from app.services.student_write_payload import prepare_student_write_payload


@pytest.mark.parametrize("fields", [{"notes": "Edited"}, {"date_of_birth": None}])
def test_partial_save_does_not_overwrite_known_minor_status(fields):
    payload = prepare_student_write_payload(fields.copy(), for_creation=False)
    assert "is_minor" not in payload


def test_creation_preserves_explicit_minor_knowledge_without_fabricating_dob():
    payload = prepare_student_write_payload({"is_minor": True}, for_creation=True)
    assert payload["is_minor"] is True
    assert "date_of_birth" not in payload


def test_known_adult_dob_overrides_minor_flag_in_write_payload():
    payload = prepare_student_write_payload(
        {"date_of_birth": date(2000, 1, 1), "is_minor": True}, for_creation=False
    )
    assert payload["is_minor"] is False
    assert payload["date_of_birth"] == "2000-01-01"
