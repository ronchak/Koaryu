from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.student import StudentUpdate
from tests.test_student_crud_actions import FakeStudentWriteSupabase, build_actions


def student_client():
    return FakeStudentWriteSupabase(
        {
            "programs": [],
            "students": [
                {
                    "id": "student-1",
                    "studio_id": "studio-1",
                    "legal_first_name": "Student",
                    "legal_last_name": "One",
                    "status": "active",
                    "tags": [],
                }
            ],
            "student_program_memberships": [],
            "guardians": [],
            "student_guardians": [],
            "audit_logs": [],
        }
    )


def test_guardian_only_add_uses_atomic_profile_rpc_and_response_snapshot():
    client = student_client()
    actions = build_actions(client)
    seen = {}

    def response(row, **kwargs):
        seen.update(kwargs)
        return row

    actions.row_to_response = response
    asyncio.run(
        actions.update_student(
            "student-1",
            StudentUpdate(
                guardians=[
                    {
                        "first_name": "Kenji",
                        "last_name": "",
                        "phone": "555-0199",
                        "is_primary_contact": True,
                    }
                ]
            ),
            "studio-1",
            "actor-1",
        )
    )
    rpc, params = client.rpc_calls[0]
    assert rpc == "write_student_profile_v2_atomic"
    assert params["p_student"] == {}
    assert not params["p_replace_programs"]
    assert params["p_guardians"] == [
        {
            "first_name": "Kenji",
            "last_name": "",
            "phone": "555-0199",
            "is_primary_contact": True,
        }
    ]
    assert seen["guardians"][0].phone == "555-0199"


def test_existing_guardian_patch_serializes_identity_and_only_supplied_fields():
    client = student_client()
    guardian_id = str(uuid4())
    client.tables["guardians"] = [
        {
            "id": guardian_id,
            "studio_id": "studio-1",
            "first_name": "Kenji",
            "last_name": "",
            "phone": "old",
            "is_primary_contact": True,
        }
    ]
    client.tables["student_guardians"] = [{"student_id": "student-1", "guardian_id": guardian_id}]
    asyncio.run(
        build_actions(client).update_student(
            "student-1",
            StudentUpdate(
                guardians=[
                    {
                        "id": guardian_id,
                        "phone": None,
                    }
                ]
            ),
            "studio-1",
            "actor-1",
        )
    )
    assert client.rpc_calls[0][1]["p_guardians"] == [{"id": guardian_id, "phone": None}]
    assert "guardians" not in client.rpc_calls[0][1]["p_student"]


@pytest.mark.parametrize("guardian_field", [{}, {"guardians": []}])
def test_omitted_and_empty_guardians_preserve_existing_atomic_write_semantics(guardian_field):
    client = student_client()
    asyncio.run(
        build_actions(client).update_student(
            "student-1", StudentUpdate(notes="Changed", **guardian_field), "studio-1", "actor-1"
        )
    )
    assert client.rpc_calls[0][1]["p_guardians"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {"guardians": None},
        {"guardians": {}},
        {"guardians": [None]},
        {"guardians": [{"first_name": "", "last_name": ""}]},
        {"guardians": [{"first_name": "Kenji", "last_name": None}]},
        {"guardians": [{"id": None, "first_name": "Kenji", "last_name": ""}]},
        {"guardians": [{"id": "bad", "phone": "x"}]},
        {"guardians": [{"id": str(uuid4())}]},
        {"guardians": [{"id": str(uuid4()), "first_name": None}]},
        {"guardians": [{"id": str(uuid4()), "is_primary_contact": None}]},
        {"guardians": [{"id": str(uuid4()), "studio_id": str(uuid4()), "phone": "x"}]},
    ],
)
def test_invalid_guardian_payloads_fail_schema_before_writes(payload):
    with pytest.raises(ValidationError):
        StudentUpdate.model_validate(payload)


def test_single_name_existing_contact_can_be_patched_or_clear_surname():
    guardian_id = str(uuid4())
    patch = StudentUpdate.model_validate(
        {"guardians": [{"id": guardian_id, "phone": "x", "last_name": ""}]}
    )
    assert patch.guardians[0].last_name == ""


def test_duplicate_guardian_ids_are_rejected_before_rpc():
    guardian_id = str(uuid4())
    with pytest.raises(ValidationError, match="Duplicate guardian id"):
        StudentUpdate.model_validate(
            {
                "guardians": [
                    {"id": guardian_id, "phone": "one"},
                    {"id": guardian_id, "phone": "two"},
                ]
            }
        )
