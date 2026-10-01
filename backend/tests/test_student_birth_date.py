from datetime import date, datetime, timezone
import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.student import CsvImportOptions, StudentCreate, StudentUpdate
from app.services.student_birth_date import validate_student_birth_date
from app.services.student_age import age_on_date, is_minor_on_date
from app.services.student_import_planner import StudentImportPlanner
from app.services.studio_business_date import studio_today
from tests.fakes.supabase import TableBackedSupabase
from tests.test_student_crud_actions import FakeStudentWriteSupabase, build_actions


@pytest.mark.parametrize("birth_date", [None, "2008-02-29", "2026-09-29"])
def test_valid_birth_dates(birth_date):
    validate_student_birth_date(birth_date, date(2026, 9, 29))


@pytest.mark.parametrize(
    "dob,reference,age",
    [
        ("2008-09-30", "2026-09-29", 17),
        ("2008-09-30", "2026-09-30", 18),
        ("2008-02-29", "2026-02-28", 17),
        ("2008-02-29", "2026-03-01", 18),
        ("2026-09-30", "2026-09-29", None),
    ],
)
def test_age_and_minor_status_never_use_negative_age(dob, reference, age):
    reference_date = date.fromisoformat(reference)
    assert age_on_date(date.fromisoformat(dob), reference_date) == age
    assert is_minor_on_date(dob, reference_date) is (age is not None and age < 18)


def test_legacy_invalid_calendar_dates_do_not_break_minor_display():
    assert not is_minor_on_date("2026-02-30", date(2026, 9, 29))


@pytest.mark.parametrize("birth_date", ["2026-09-30", "2027-01-01"])
def test_future_birth_dates_are_field_errors(birth_date):
    with pytest.raises(HTTPException) as raised:
        validate_student_birth_date(birth_date, date(2026, 9, 29))
    assert raised.value.status_code == 422
    assert raised.value.detail == "Date of birth cannot be in the future."


@pytest.mark.parametrize("model", [StudentCreate, StudentUpdate])
def test_api_schemas_reject_invalid_calendar_dates(model):
    with pytest.raises(ValidationError):
        model(legal_first_name="Aiko", legal_last_name="Tanaka", date_of_birth="2026-02-30")


@pytest.mark.parametrize("zone", ["America/Los_Angeles", "Pacific/Kiritimati"])
@pytest.mark.parametrize("operation", ["create", "update"])
def test_api_saves_use_studio_today_and_never_write_future_dob(monkeypatch, zone, operation):
    instant = datetime(2026, 9, 30, 1, 0, tzinfo=timezone.utc)
    today = studio_today(zone, now=instant)[0]
    monkeypatch.setattr(
        "app.services.student_crud_actions.studio_today_for_studio", lambda *_: today
    )
    db = FakeStudentWriteSupabase(
        {
            "programs": [{"id": "program-1", "studio_id": "studio-1"}],
            "students": [{"id": "student-1", "studio_id": "studio-1", "date_of_birth": None}],
            "student_program_memberships": [],
            "guardians": [],
            "student_guardians": [],
            "audit_logs": [],
        }
    )
    actions = build_actions(db)
    schema = StudentCreate if operation == "create" else StudentUpdate
    model = schema(legal_first_name="Aiko", legal_last_name="Tanaka", date_of_birth="2026-10-01")
    with pytest.raises(HTTPException) as raised:
        if operation == "create":
            asyncio.run(actions.create_student(model, "studio-1", "actor-1"))
        else:
            asyncio.run(actions.update_student("student-1", model, "studio-1", "actor-1"))
    assert raised.value.status_code == 422
    assert db.rpc_calls == []
    assert db.tables["audit_logs"] == []
    model = schema(legal_first_name="Aiko", legal_last_name="Tanaka", date_of_birth=today)
    if operation == "create":
        saved = asyncio.run(actions.create_student(model, "studio-1", "actor-1"))
    else:
        saved = asyncio.run(actions.update_student("student-1", model, "studio-1", "actor-1"))
    assert saved["date_of_birth"] == today.isoformat()


def test_update_omission_and_clear_preserve_payload_semantics():
    assert "date_of_birth" not in StudentUpdate(notes="Unrelated edit").model_dump(
        exclude_unset=True
    )
    assert StudentUpdate(date_of_birth=None).model_dump(exclude_unset=True) == {
        "date_of_birth": None
    }
    validate_student_birth_date(None, None)


def test_import_rejects_future_dates_by_studio_date_and_keeps_today_and_leap_day(monkeypatch):
    today = date(2026, 9, 29)
    monkeypatch.setattr(
        "app.services.student_import_planner.studio_today_for_studio", lambda *_: today
    )
    planner = StudentImportPlanner(
        TableBackedSupabase(
            {
                "programs": [],
                "belt_ladders": [],
                "belt_ranks": [],
            }
        )
    )
    result, rows = planner.prepare_import(
        [
            {"Name": "Aiko Tanaka", "DOB": dob}
            for dob in ["09/30/2026", "2026-09-29", "2008-02-29", "2026-02-30"]
        ],
        {"Name": "full_name", "DOB": "date_of_birth"},
        "studio",
        CsvImportOptions(),
    )
    assert result.valid_rows == 2
    assert result.error_rows == 2
    assert [row["is_valid"] for row in rows] == [False, True, True, False]
    assert rows[0]["issues"][0].code == "future_date_of_birth"
    assert rows[0]["issues"][0].field == "date_of_birth"
    assert rows[3]["issues"][0].code == "invalid_date_of_birth"
