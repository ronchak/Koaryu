"""HTTP and service boundaries for transactional lead commands.

Real rollback/concurrency proofs live in the PostgreSQL contract suite.
"""

import asyncio
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.api.v1.endpoints import leads
from app.core.deps import get_current_user_id, get_lead_manager_studio_id, get_supabase
from app.schemas import lead as schemas
from app.services.lead_service import LeadService
from tests.fakes.supabase import FakeResult, TableBackedSupabase
from tests.test_lead_service import lead_row

OPERATION_ID = "58319893-bc83-45a5-8fb3-2432b54e4c84"


def follow_up_request(**kwargs):
    return schemas.LeadFollowUpRequest(operation_id=OPERATION_ID, **kwargs)


def provider_error(code, message="private provider details"):
    return APIError({"code": code, "message": message, "details": None, "hint": None})


@pytest.mark.parametrize(
    "payload",
    [
        {"stage": "trial_scheduled", "notes": None},
        {"assigned_staff_id": None},
        {"program_id": None},
        {"stage": None},
        {"notes": "updated", "studio_id": "other", "converted_student_id": "student-2"},
    ],
)
def test_patch_sends_only_supplied_allowlisted_fields_to_atomic_rpc(payload):
    supabase = TableBackedSupabase()
    data = schemas.LeadUpdate.model_validate(payload)
    row = lead_row(stage="trial_scheduled")
    with patch(
        "app.services.lead_service.execute_required_rpc", return_value=FakeResult(row)
    ) as rpc:
        result = asyncio.run(
            LeadService(supabase).update_lead("lead-1", data, "studio-1", "actor-1")
        )
    rpc.assert_called_once_with(
        supabase,
        "update_lead_atomic",
        {
            "p_studio_id": "studio-1",
            "p_actor_id": "actor-1",
            "p_lead_id": "lead-1",
            "p_patch": data.model_dump(exclude_unset=True),
        },
    )
    assert result.stage == "trial_scheduled"
    assert not supabase.query_log


def test_empty_patch_is_rejected_without_provider_work():
    supabase = TableBackedSupabase()
    with patch("app.services.lead_service.execute_required_rpc") as rpc:
        with pytest.raises(HTTPException) as error:
            asyncio.run(
                LeadService(supabase).update_lead(
                    "lead-1", schemas.LeadUpdate(), "studio-1", "actor-1"
                )
            )
    assert error.value.status_code == 400
    rpc.assert_not_called()
    assert not supabase.query_log


@pytest.mark.parametrize("target", [None, "offer_sent", "enrolled", "closed_lost"])
def test_follow_up_passes_frozen_request_and_identity_without_pre_reads(target):
    supabase = TableBackedSupabase()
    row = lead_row(stage=target or "inquiry", follow_up_date=None)
    with patch(
        "app.services.lead_service.execute_required_rpc", return_value=FakeResult([row])
    ) as rpc:
        service = LeadService(supabase)
        result = asyncio.run(
            service.follow_up_lead(
                "lead-1", follow_up_request(next_stage=target), "studio-1", "actor-1"
            )
        )
    rpc.assert_called_once_with(
        supabase,
        "follow_up_lead_atomic",
        {
            "p_studio_id": "studio-1",
            "p_actor_id": "actor-1",
            "p_lead_id": "lead-1",
            "p_operation_id": OPERATION_ID,
            "p_request": {"next_stage": target},
        },
    )
    assert result.follow_up_date is None
    assert not supabase.query_log


def test_follow_up_omitted_target_is_canonical_null_and_uuid_is_required():
    data = follow_up_request()
    assert data.operation_id == UUID(OPERATION_ID)
    assert data.next_stage is None


@pytest.mark.parametrize("command", ["patch", "follow_up"])
@pytest.mark.parametrize(
    "code,status", [("22023", 400), ("42501", 403), ("P0002", 404), ("23505", 409)]
)
def test_domain_errors_are_mapped_without_provider_detail_or_fallback(command, code, status):
    supabase = TableBackedSupabase()
    message = (
        "Follow-up operation identity conflict." if code == "23505" else "private provider details"
    )
    with patch(
        "app.services.lead_service.execute_required_rpc", side_effect=provider_error(code, message)
    ):
        with pytest.raises(HTTPException) as error:
            invoke_command(supabase, command)
    assert error.value.status_code == status
    assert "private provider details" not in error.value.detail
    assert not supabase.query_log


def invoke_command(supabase, command):
    service = LeadService(supabase)
    if command == "patch":
        return asyncio.run(
            service.update_lead(
                "lead-1", schemas.LeadUpdate(program_id="program-1"), "studio-1", "actor-1"
            )
        )
    return asyncio.run(service.follow_up_lead("lead-1", follow_up_request(), "studio-1", "actor-1"))


@pytest.mark.parametrize("command", ["patch", "follow_up"])
@pytest.mark.parametrize("code", ["PGRST202", "42703", "XX000", "P0001", "23505"])
def test_missing_rpc_or_unexpected_failure_never_drops_fields_or_uses_split_writes(command, code):
    supabase = TableBackedSupabase()
    error = provider_error(code)
    with patch("app.services.lead_service.execute_required_rpc", side_effect=error):
        with pytest.raises(APIError) as raised:
            invoke_command(supabase, command)
    assert raised.value is error
    assert not supabase.query_log


@pytest.mark.parametrize("command", ["patch", "follow_up"])
def test_missing_rpc_client_has_no_legacy_write_fallback(command):
    supabase = TableBackedSupabase()
    with pytest.raises(RuntimeError, match="required"):
        invoke_command(supabase, command)
    assert not supabase.query_log


@pytest.mark.parametrize("command", ["patch", "follow_up"])
def test_empty_command_result_is_not_reported_as_success(command):
    supabase = TableBackedSupabase()
    with patch("app.services.lead_service.execute_required_rpc", return_value=FakeResult([])):
        with pytest.raises(HTTPException) as error:
            invoke_command(supabase, command)
    assert error.value.status_code == 500


def app_client():
    app = FastAPI()
    app.include_router(leads.router)
    app.dependency_overrides[get_current_user_id] = lambda: "actor-1"
    app.dependency_overrides[get_lead_manager_studio_id] = lambda: "studio-1"
    app.dependency_overrides[get_supabase] = lambda: TableBackedSupabase()
    return TestClient(app)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"operation_id": "bad"},
        {"operation_id": OPERATION_ID, "next_stage": "bad"},
        {"operation_id": OPERATION_ID, "program_id": "other"},
    ],
)
def test_follow_up_http_rejects_invalid_request_before_service(payload):
    with patch("app.api.v1.endpoints.leads.LeadService") as service:
        response = app_client().post("/leads/lead-1/follow-up", json=payload)
    assert response.status_code == 422
    service.assert_not_called()


@pytest.mark.parametrize("target", [None, "offer_sent"])
def test_follow_up_http_non_conversion_preserves_lead_permission(target):
    with patch("app.api.v1.endpoints.leads.LeadService") as service:
        service.return_value.follow_up_lead = AsyncMock(return_value=lead_row())
        response = app_client().post(
            "/leads/lead-1/follow-up", json={"operation_id": OPERATION_ID, "next_stage": target}
        )
    assert response.status_code == 200, response.text
    service.return_value.follow_up_lead.assert_awaited_once_with(
        "lead-1", follow_up_request(next_stage=target), "studio-1", "actor-1"
    )


def test_follow_up_http_enrollment_checks_conversion_permission_even_if_lead_management_allowed():
    with patch(
        "app.api.v1.endpoints.leads.resolve_lead_conversion_manager_staff_role_for_user",
        create=True,
        side_effect=HTTPException(status_code=403, detail="Conversion denied"),
    ) as permission:
        with patch("app.api.v1.endpoints.leads.LeadService") as service:
            response = app_client().post(
                "/leads/lead-1/follow-up",
                json={"operation_id": OPERATION_ID, "next_stage": "enrolled"},
            )
    assert response.status_code == 403, response.text
    permission.assert_called_once()
    assert permission.call_args.args[1:] == ("actor-1", "studio-1")
    assert permission.call_args.kwargs == {"require_platform_subscription": True}
    service.assert_not_called()


def test_follow_up_http_authorized_conversion_dispatches_one_command():
    with patch(
        "app.api.v1.endpoints.leads.resolve_lead_conversion_manager_staff_role_for_user",
        create=True,
        return_value={"studio_id": "studio-1"},
    ) as permission:
        with patch("app.api.v1.endpoints.leads.LeadService") as service:
            service.return_value.follow_up_lead = AsyncMock(return_value=lead_row(stage="enrolled"))
            response = app_client().post(
                "/leads/lead-1/follow-up",
                json={"operation_id": OPERATION_ID, "next_stage": "enrolled"},
            )
    assert response.status_code == 200, response.text
    permission.assert_called_once()
    service.return_value.follow_up_lead.assert_awaited_once()
    service.return_value.convert_to_student.assert_not_called()


class FailingLeadCommandSupabase(TableBackedSupabase):
    """Inject a failed database command without simulating transaction semantics."""

    def rpc(self, _name, _params):
        from tests.fakes.supabase import FakeRpcCall

        def fail():
            raise provider_error("XX000")

        return FakeRpcCall(fail)


def test_failed_patch_cannot_leave_a_prior_independent_lead_write():
    row = lead_row()
    supabase = FailingLeadCommandSupabase({"leads": [dict(row)], "lead_activities": []})
    supabase.table_failures["lead_activities"] = provider_error("XX000")
    with pytest.raises(APIError):
        asyncio.run(
            LeadService(supabase).update_lead(
                "lead-1", schemas.LeadUpdate(stage="offer_sent"), "studio-1", "actor-1"
            )
        )
    assert supabase.tables["leads"] == [row]
    assert supabase.tables["lead_activities"] == []


def test_failed_follow_up_cannot_leave_an_independent_contact_activity():
    row = lead_row()
    supabase = FailingLeadCommandSupabase({"leads": [dict(row)], "lead_activities": []})
    with pytest.raises(APIError):
        asyncio.run(
            LeadService(supabase).follow_up_lead(
                "lead-1", follow_up_request(next_stage="offer_sent"), "studio-1", "actor-1"
            )
        )
    assert supabase.tables["leads"] == [row]
    assert supabase.tables["lead_activities"] == []


@pytest.mark.parametrize("command", ["patch", "follow_up"])
def test_archived_program_preserves_existing_conflict_detail(command):
    program_id = "87618320-b27a-496d-9ae2-09619f6e97c7"
    error = APIError(
        {"code": "P0001", "message": "PROGRAM_INACTIVE", "details": program_id, "hint": None}
    )
    with patch("app.services.lead_service.execute_required_rpc", side_effect=error):
        with pytest.raises(HTTPException) as result:
            invoke_command(TableBackedSupabase(), command)
    assert result.value.status_code == 409
    assert result.value.detail == {
        "code": "PROGRAM_INACTIVE",
        "message": "Archived programs cannot be used for new records.",
        "details": {"program_id": program_id},
    }


@pytest.mark.parametrize("command", ["patch", "follow_up"])
@pytest.mark.parametrize(
    "code,message,details",
    [
        ("P0001", "PROGRAM_INACTIVE", "private non-UUID details"),
        ("P0001", "PROGRAM_INACTIVE", None),
        ("P0001", "OTHER_TRIGGER_ERROR", "87618320-b27a-496d-9ae2-09619f6e97c7"),
        ("XX000", "PROGRAM_INACTIVE", "87618320-b27a-496d-9ae2-09619f6e97c7"),
    ],
)
def test_unknown_program_marker_or_invalid_uuid_remains_server_error(
    command, code, message, details
):
    error = APIError({"code": code, "message": message, "details": details, "hint": None})
    with patch("app.services.lead_service.execute_required_rpc", side_effect=error):
        with pytest.raises(APIError) as result:
            invoke_command(TableBackedSupabase(), command)
    assert result.value is error
