"""The adapter owns transport/errors; real SQL contracts own rank mutations."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError as PostgrestAPIError

from app.api.v1.endpoints import belts
from app.core.deps import get_current_user_id, get_promotion_manager_studio_id, get_supabase
from app.core.error_handlers import register_error_handlers
from app.schemas.belt import DemoteStudent, PromoteStudent
from app.services.belt_service import BeltService

STUDIO = "11111111-1111-4111-8111-111111111111"
ACTOR = "22222222-2222-4222-8222-222222222222"
STUDENT = "33333333-3333-4333-8333-333333333333"
TARGET = "44444444-4444-4444-8444-444444444444"
OPERATION = "55555555-5555-4555-8555-555555555555"
PROGRAM = "66666666-6666-4666-8666-666666666666"
MEMBERSHIP = "77777777-7777-4777-8777-777777777777"


def rpc_client(*, row=None, error=None):
    client = Mock(spec=["rpc"])
    client.rpc.return_value.execute.return_value = SimpleNamespace(data=row)
    client.rpc.return_value.execute.side_effect = error
    return client


def receipt(kind):
    return {
        "id": "88888888-8888-4888-8888-888888888888", "studio_id": STUDIO,
        "student_id": STUDENT, "operation_id": OPERATION, "transition_kind": kind,
        "to_rank_id": None, "promoted_by": None, "promoted_at": "2026-09-08T00:00:00Z",
        "from_rank_name_snapshot": "White", "to_rank_name_snapshot": "Yellow",
        "command_fingerprint": "internal evidence is not an API field",
    }


@pytest.mark.parametrize("kind,context,as_list", [
    ("promotion", {}, False),
    ("demotion", {"program_id": PROGRAM, "student_program_membership_id": MEMBERSHIP}, True),
])
def test_one_rpc_receives_original_command_and_returns_retained_history(kind, context, as_list):
    row = receipt(kind)
    client = rpc_client(row=[row] if as_list else row)
    payload = dict(student_id=STUDENT, to_rank_id=TARGET, operation_id=OPERATION, **context)
    data = PromoteStudent(**payload, notes=None) if kind == "promotion" else DemoteStudent(**payload, reason="  Correction  ")
    method = BeltService(client).promote_student if kind == "promotion" else BeltService(client).demote_student
    result = asyncio.run(method(data, STUDIO, ACTOR))
    client.rpc.assert_called_once_with("record_student_rank_transition_v3", {
        "p_studio_id": STUDIO, "p_actor_id": ACTOR, "p_student_id": STUDENT,
        "p_to_rank_id": TARGET, "p_operation_id": OPERATION, "p_transition_kind": kind,
        "p_program_id": context.get("program_id"),
        "p_student_program_membership_id": context.get("student_program_membership_id"),
        "p_notes": None if kind == "promotion" else "Correction",
    })
    client.rpc.return_value.execute.assert_called_once_with()
    assert (result.id, result.from_rank_name, result.to_rank_name) == (row["id"], "White", "Yellow")
    assert result.to_rank_id is None and result.promoted_by is None
    assert "command_fingerprint" not in result.model_dump()


def test_absent_operation_gets_one_key_and_empty_result_is_not_success():
    client = rpc_client(row=[])
    with pytest.raises(HTTPException) as error:
        asyncio.run(BeltService(client).promote_student(
            PromoteStudent(student_id=STUDENT, to_rank_id=TARGET), STUDIO, ACTOR,
        ))
    assert error.value.status_code == 500
    assert client.rpc.call_count == 1
    assert UUID(client.rpc.call_args.args[1]["p_operation_id"]).version == 4


@pytest.mark.parametrize("code,detail,expected", [
    ("22023", "rank_transition_conflict", 409),
    ("22023", "rank_transition_invalid", 400),
    ("P0001", "rank_transition_invalid", 400),
    ("P0002", "rank_transition_not_found", 404),
    ("22023", "unowned internal failure", 500),
    ("P0001", "unowned trigger failure", 500),
    ("XX000", "rank_transition_conflict", 500),
])
def test_real_http_path_maps_only_owned_domain_errors(code, detail, expected):
    provider_error = PostgrestAPIError({
        "code": code, "details": detail, "hint": None,
        "message": "Rank command was rejected." if expected != 500 else "private SQL diagnostic",
    })
    db = rpc_client(error=provider_error)
    app = FastAPI()
    register_error_handlers(app)
    app.include_router(belts.router)
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_promotion_manager_studio_id] = lambda: STUDIO
    app.dependency_overrides[get_supabase] = lambda: db
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/belts/promote", json={
            "student_id": STUDENT, "to_rank_id": TARGET, "operation_id": OPERATION,
        })
    assert response.status_code == expected, response.text
    assert response.json()["error"]["status_code"] == expected
    assert response.json()["detail"] == (
        "This rank change could not be verified against the recorded history. Check the student's history before trying again."
        if expected == 409 else "Internal server error." if expected == 500 else "Rank command was rejected."
    )
    assert db.rpc.call_count == 1
