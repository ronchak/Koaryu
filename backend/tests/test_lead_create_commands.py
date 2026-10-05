"""Lead creation HTTP/SDK boundary proofs, with no SQL or provider integration."""

import asyncio
import inspect
import json
from copy import deepcopy
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest import SyncPostgrestClient
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from pydantic import ValidationError

from app.api.v1.endpoints import leads
from app.core.deps import (
    PROVIDER_OPERATION_TIMEOUT_DETAIL,
    get_current_user_id,
    get_supabase,
)
from app.core.provider_lane import ProviderLaneOperationTimeoutError
from app.core.provider_runtime import SupabaseProviderRuntime
from app.schemas.lead import LeadCreate, LeadResponse, LeadUpdate
from app.services import lead_service, studio_scope
from app.services.lead_service import LeadService
from tests.fakes.supabase import TableBackedSupabase

STUDIO, ACTOR, LEAD, PROGRAM, ASSIGNEE, OPERATION, OTHER = (
    str(UUID(int=value)) for value in range(1, 8)
)
RPC = "create_lead_atomic_v1"
UNAVAILABLE = "Lead creation could not be confirmed. Check the lead list before trying again."
ADMIN_REQUIRED = "Only studio admins and front desk staff can manage leads."
REQUEST_DEFAULTS = {
    "first_name": "Aiko",
    "last_name": "Tanaka",
    "email": None,
    "phone": None,
    "source": "walk_in",
    "stage": "inquiry",
    "program_interest": None,
    "program_id": None,
    "is_minor": False,
    "guardian_name": None,
    "guardian_email": None,
    "guardian_phone": None,
    "assigned_staff_id": None,
    "follow_up_date": None,
    "notes": None,
}
BODY = {"first_name": "Aiko", "last_name": "Tanaka", "operation_id": OPERATION}
ROW = {
    **REQUEST_DEFAULTS,
    "id": LEAD,
    "studio_id": STUDIO,
    "lost_reason": None,
    "converted_student_id": None,
    "created_at": "2026-10-01T12:00:00+00:00",
    "updated_at": "2026-10-01T12:00:00+00:00",
}
RECEIPT = {"payload": ROW, "operation_id": OPERATION, "replayed": False}
MALFORMED_IDENTITIES = [[], {}, None, 0, True, 1.5]
ERRORS = [
    ("42501", "AUTOMATION_ADMIN_REQUIRED", 403, ADMIN_REQUIRED),
    (
        "P0002",
        "AUTOMATION_NOT_FOUND",
        404,
        "Lead or related record not found in this studio",
    ),
    ("22023", "AUTOMATION_INVALID_REQUEST", 422, "Invalid lead request."),
    (
        "P0001",
        "AUTOMATION_REVISION_CONFLICT",
        409,
        "This lead changed. Reload it before saving.",
    ),
    (
        "P0001",
        "AUTOMATION_OPERATION_CONFLICT",
        409,
        "This lead operation was already used for a different request.",
    ),
    (
        "P0001",
        "AUTOMATION_STATE_CONFLICT",
        409,
        "This lead cannot be changed in its current state.",
    ),
    (
        "P0001",
        "AUTOMATION_STUDIO_BUSY",
        409,
        "The studio is busy. Try the lead request again shortly.",
    ),
]


def provider_error_body(**updates):
    return {
        "code": "P0001",
        "message": "AUTOMATION_STATE_CONFLICT",
        "details": "private lead details",
        "hint": "private SQL",
        **updates,
    }


class Database(TableBackedSupabase):
    def __init__(self):
        super().__init__(
            {
                "staff_roles": [
                    {
                        "user_id": ACTOR,
                        "studio_id": STUDIO,
                        "role": "admin",
                        "archived_at": None,
                    }
                ]
            }
        )
        self.rpc_calls = []
        self.execute_calls = []
        self.result = deepcopy(RECEIPT)

    def rpc(self, name, params):
        self.rpc_calls.append((name, deepcopy(params)))

        def execute():
            self.execute_calls.append(name)
            if isinstance(self.result, Exception):
                raise self.result
            return SimpleNamespace(data=deepcopy(self.result))

        return SimpleNamespace(execute=execute)


@pytest.fixture
def database():
    return Database()


def create(database, body=None):
    return asyncio.run(
        LeadService(database).create_lead(
            LeadCreate(**(BODY if body is None else body)), STUDIO, ACTOR
        )
    )


def assert_unavailable(call):
    with pytest.raises(HTTPException) as error:
        call()
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    return error.value


def assert_one_rpc(database):
    assert len(database.rpc_calls) == 1
    assert database.execute_calls == [RPC]
    assert database.query_log == []


def test_defaults_and_readonly_extra_handling_are_preserved(database):
    body = {
        **BODY,
        "id": OTHER,
        "studio_id": OTHER,
        "actor_id": OTHER,
        "converted_student_id": OTHER,
        "lost_reason": "other",
        "created_at": "caller timestamp",
    }
    result = create(database, body)
    assert result.model_dump(mode="json") == ROW
    assert database.rpc_calls == [
        (
            RPC,
            {
                "p_studio_id": STUDIO,
                "p_actor_id": ACTOR,
                "p_operation_id": OPERATION,
                "p_request": REQUEST_DEFAULTS,
            },
        )
    ]
    assert_one_rpc(database)


@pytest.mark.parametrize("operation", [{}, {"operation_id": None}])
def test_legacy_request_allocates_one_fresh_uuid_per_invocation(database, monkeypatch, operation):
    generated = Mock(side_effect=[UUID(OPERATION), UUID(OTHER)])
    monkeypatch.setattr(lead_service.uuid, "uuid4", generated)
    data = LeadCreate(first_name="Aiko", last_name="Tanaka", **operation)
    service = LeadService(database)
    for operation_id in [OPERATION, OTHER]:
        database.result["operation_id"] = operation_id
        assert asyncio.run(service.create_lead(data, STUDIO, ACTOR)).id == LEAD
    assert generated.call_count == 2
    assert [params["p_operation_id"] for _, params in database.rpc_calls] == [OPERATION, OTHER]
    assert all(params["p_request"] == REQUEST_DEFAULTS for _, params in database.rpc_calls)
    assert database.execute_calls == [RPC, RPC]
    assert database.query_log == []
    assert data.operation_id is None


def test_explicit_operation_is_normalized_and_never_allocated_again(database, monkeypatch):
    operation = UUID("abcdefab-cdef-abcd-efab-cdefabcdefab")
    database.result["operation_id"] = str(operation)
    generated = Mock(side_effect=AssertionError("Explicit command allocated another identity"))
    monkeypatch.setattr(lead_service.uuid, "uuid4", generated)
    create(database, {**BODY, "operation_id": operation.hex.upper()})
    assert database.rpc_calls[0][1]["p_operation_id"] == str(operation)
    generated.assert_not_called()
    assert_one_rpc(database)


def test_existing_field_values_and_coercion_reach_typed_json_request(database):
    body = {
        **BODY,
        "first_name": "  Aiko  ",
        "last_name": "",
        "email": "legacy contact string",
        "phone": None,
        "source": "other",
        "stage": "closed_lost",
        "program_interest": "Children's class",
        "program_id": "legacy non-UUID string",
        "is_minor": "true",
        "guardian_name": "Guardian",
        "guardian_email": None,
        "guardian_phone": "555-0100",
        "assigned_staff_id": "legacy assignee string",
        "follow_up_date": "2026-10-09",
        "notes": "Follow up soon",
    }
    create(database, body)
    assert database.rpc_calls[0][1]["p_request"] == {
        key: True if key == "is_minor" else value
        for key, value in body.items()
        if key != "operation_id"
    }
    assert_one_rpc(database)


@pytest.mark.parametrize(
    "stage", ["inquiry", "trial_scheduled", "trial_completed", "offer_sent", "closed_lost"]
)
@pytest.mark.parametrize("source", ["walk_in", "referral", "social", "search", "website", "other"])
def test_existing_create_stage_and_source_literals_remain_accepted(stage, source):
    request = LeadCreate(**BODY, stage=stage, source=source)
    assert (request.stage, request.source) == (stage, source)


@pytest.mark.parametrize(
    "updates",
    [
        {"stage": "enrolled"},
        {"source": "bad"},
        {"operation_id": "bad"},
        {"operation_id": 1},
        {"operation_id": []},
    ],
)
def test_invalid_request_literals_and_operation_ids_are_rejected(updates):
    with pytest.raises(ValidationError):
        LeadCreate(**{**BODY, **updates})


@pytest.mark.parametrize("replayed", [False, True])
def test_receipt_result_never_checks_changed_program_or_assignee_or_reloads(database, replayed):
    database.tables["programs"] = [
        {"id": PROGRAM, "studio_id": STUDIO, "archived_at": "2026-10-04"}
    ]
    # ASSIGNEE no longer has a staff role; the mutable lead also changed later.
    database.tables["leads"] = [{**ROW, "stage": "closed_lost", "notes": "Later edit"}]
    original = {**ROW, "program_id": PROGRAM, "assigned_staff_id": ASSIGNEE}
    database.result = {"payload": original, "operation_id": OPERATION, "replayed": replayed}
    result = create(database, {**BODY, "program_id": PROGRAM, "assigned_staff_id": ASSIGNEE})
    assert result.model_dump(mode="json") == original
    assert_one_rpc(database)


@pytest.mark.parametrize("field", list(ROW))
def test_receipt_requires_every_response_field_including_nulls(database, field):
    del database.result["payload"][field]
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize(
    "result",
    [
        None,
        [],
        [RECEIPT],
        ROW,
        "private data",
        {"payload": ROW},
        {**RECEIPT, "message": "ok"},
        {**RECEIPT, "extra": None},
        {**RECEIPT, "payload": {**ROW, "extra": "private"}},
        {**RECEIPT, "payload": [ROW]},
    ],
)
def test_malformed_envelope_never_returns_success_or_uses_row_fallback(database, result):
    database.result = result
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize("replayed", [None, 0, 1, "true", "false", [], {}])
def test_replay_marker_requires_an_actual_boolean(database, replayed):
    database.result["replayed"] = replayed
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize("operation", [OTHER, "bad", "", None, 1, [], {}, UUID(OPERATION)])
def test_operation_echo_requires_matching_uuid_string(database, operation):
    database.result["operation_id"] = operation
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", "bad"),
        ("id", None),
        ("id", 1),
        ("id", UUID(LEAD)),
        ("studio_id", "bad"),
        ("studio_id", OTHER),
        ("studio_id", None),
        ("studio_id", UUID(STUDIO)),
        ("is_minor", 0),
        ("is_minor", "false"),
        ("first_name", 1),
        ("created_at", None),
        ("source", "bad"),
        ("stage", "bad"),
        ("email", []),
        ("notes", {}),
    ],
)
def test_canonical_payload_identity_and_existing_types_are_validated(database, field, value):
    database.result["payload"][field] = value
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize("code,message,status,detail", ERRORS)
def test_known_command_errors_have_fixed_sanitized_mapping(database, code, message, status, detail):
    database.result = APIError(provider_error_body(code=code, message=message))
    with pytest.raises(HTTPException) as error:
        create(database)
    assert (error.value.status_code, error.value.detail) == (status, detail)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert_one_rpc(database)


@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("identity", MALFORMED_IDENTITIES)
def test_malformed_error_identity_is_unavailable_before_any_lookup(database, field, identity):
    database.result = APIError(provider_error_body(**{field: identity}))
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize("field", ["code", "message"])
def test_missing_error_identity_is_unavailable(database, field):
    database.result = APIError(provider_error_body())
    delattr(database.result, field)
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


@pytest.mark.parametrize(
    "code,message",
    [
        ("PGRST202", "Could not find create_lead_atomic_v1 in schema cache"),
        ("42883", "create_lead_atomic_v1 does not exist"),
        ("42703", "program_id does not exist"),
        ("PGRST204", "program_id missing"),
        ("XX000", "private failure"),
        ("P0001", "private failure"),
        ("42501", "private failure"),
        ("22023", "private failure"),
        ("P0002", "private failure"),
        ("P0002", "AUTOMATION_STATE_CONFLICT"),
    ],
)
def test_unknown_or_missing_rpc_error_has_no_old_schema_or_write_fallback(database, code, message):
    database.result = APIError(provider_error_body(code=code, message=message))
    assert_unavailable(lambda: create(database, {**BODY, "program_id": PROGRAM}))
    assert database.rpc_calls[0][1]["p_request"]["program_id"] == PROGRAM
    assert_one_rpc(database)


@pytest.mark.parametrize("rpc", [None, False])
def test_missing_client_rpc_has_no_direct_table_fallback(rpc):
    database = TableBackedSupabase()
    if rpc is False:
        database.rpc = False
    assert_unavailable(lambda: create(database))
    assert database.query_log == []


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError("private provider failure"),
        httpx.ReadTimeout("private provider timeout"),
        TimeoutError("private timeout"),
    ],
)
def test_unexpected_provider_failure_is_fixed_unavailable_without_retry(database, failure):
    database.result = failure
    assert_unavailable(lambda: create(database))
    assert_one_rpc(database)


def test_program_inactive_requires_matching_normalized_requested_uuid(database):
    program = UUID("abcdefab-cdef-abcd-efab-cdefabcdefab")
    database.result = APIError(
        provider_error_body(message="PROGRAM_INACTIVE", details=program.hex.upper())
    )
    with pytest.raises(HTTPException) as error:
        create(database, {**BODY, "program_id": str(program)})
    assert (error.value.status_code, error.value.detail) == (
        409,
        {
            "code": "PROGRAM_INACTIVE",
            "message": "Archived programs cannot be used for new records.",
            "details": {"program_id": str(program)},
        },
    )
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__ is True
    assert_one_rpc(database)


@pytest.mark.parametrize(
    "details", [None, "", "private detail", OTHER, [], {}, 1, True, UUID(PROGRAM)]
)
def test_program_inactive_malformed_or_mismatched_detail_is_fixed_unavailable(database, details):
    database.result = APIError(provider_error_body(message="PROGRAM_INACTIVE", details=details))
    assert_unavailable(lambda: create(database, {**BODY, "program_id": PROGRAM}))
    assert_one_rpc(database)


@pytest.mark.parametrize("program", [None, "", "not-a-uuid"])
def test_program_inactive_cannot_supply_identity_absent_from_valid_request(database, program):
    database.result = APIError(provider_error_body(message="PROGRAM_INACTIVE", details=PROGRAM))
    assert_unavailable(lambda: create(database, {**BODY, "program_id": program}))
    assert_one_rpc(database)


def test_program_inactive_missing_details_is_unavailable(database):
    database.result = APIError(provider_error_body(message="PROGRAM_INACTIVE"))
    del database.result.details
    assert_unavailable(lambda: create(database, {**BODY, "program_id": PROGRAM}))
    assert_one_rpc(database)


@pytest.fixture
def api(monkeypatch, database):
    def entitled(client, studio_id):
        assert client is database
        assert studio_id == STUDIO
        assert database.query_log
        assert database.rpc_calls == []

    subscription = Mock(side_effect=entitled)
    monkeypatch.setattr(studio_scope, "ensure_platform_subscription_access", subscription)
    app = FastAPI()
    app.include_router(leads.router)
    app.dependency_overrides[get_current_user_id] = lambda: ACTOR
    app.dependency_overrides[get_supabase] = lambda: database
    with TestClient(app) as client:
        yield client, database, subscription, app


@pytest.mark.parametrize("role", ["admin", "front_desk"])
@pytest.mark.parametrize("replayed", [False, True])
def test_http_current_lead_managers_create_and_replay_with_original_response(api, role, replayed):
    client, database, subscription, _ = api
    database.tables["staff_roles"][0]["role"] = role
    database.result["replayed"] = replayed
    response = client.post("/leads", json=BODY)
    assert response.status_code == 201
    assert response.json() == ROW
    assert database.execute_calls == [RPC]
    assert [query["table"] for query in database.query_log] == ["staff_roles"]
    subscription.assert_called_once_with(database, STUDIO)


@pytest.mark.parametrize("denial", ["instructor", "archived", "multiple", "foreign", "none"])
@pytest.mark.parametrize("replayed", [False, True])
def test_http_actual_membership_resolver_denies_before_entitlement_or_rpc(api, denial, replayed):
    client, database, subscription, _ = api
    membership = database.tables["staff_roles"][0]
    database.result["replayed"] = replayed
    headers = {}
    expected = 403
    if denial == "instructor":
        membership["role"] = denial
    elif denial == "archived":
        membership["archived_at"] = "2026-10-04"
    elif denial == "multiple":
        database.tables["staff_roles"].append({**membership, "studio_id": OTHER})
        expected = 409
    elif denial == "foreign":
        headers["X-Studio-Id"] = OTHER
    else:
        database.tables["staff_roles"] = []
        expected = 404
    response = client.post("/leads", json=BODY, headers=headers)
    assert response.status_code == expected
    if denial == "instructor":
        assert response.json() == {"detail": ADMIN_REQUIRED}
    subscription.assert_not_called()
    assert database.rpc_calls == []
    assert [query["table"] for query in database.query_log] == ["staff_roles"]


@pytest.mark.parametrize("status", [402, 503])
def test_http_entitlement_status_is_preserved_before_mutation(api, status):
    client, database, subscription, _ = api
    subscription.side_effect = HTTPException(status, "Subscription unavailable")
    response = client.post("/leads", json=BODY)
    assert response.status_code == status
    assert response.json() == {"detail": "Subscription unavailable"}
    assert database.rpc_calls == []


def test_http_real_unauthenticated_dependency_denies_without_provider_work(api):
    client, database, subscription, app = api
    app.dependency_overrides.pop(get_current_user_id)
    response = client.post("/leads", json=BODY)
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    subscription.assert_not_called()
    assert database.rpc_calls == []
    assert database.query_log == []


@pytest.mark.parametrize(
    "updates", [{"operation_id": "bad"}, {"operation_id": []}, {"stage": "enrolled"}]
)
def test_http_invalid_request_is_422_before_mutation(api, updates):
    client, database, _, _ = api
    assert client.post("/leads", json={**BODY, **updates}).status_code == 422
    assert database.rpc_calls == []


@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("value", MALFORMED_IDENTITIES)
def test_http_malformed_provider_identity_remains_sanitized(api, field, value):
    client, database, _, _ = api
    database.result = APIError(provider_error_body(**{field: value}))
    response = client.post("/leads", json=BODY)
    assert response.status_code == 503
    assert response.json() == {"detail": UNAVAILABLE}
    assert database.execute_calls == [RPC]


def test_http_mutation_lane_timeout_keeps_shared_504_without_resubmission(api):
    client, database, subscription, app = api
    runtime = Mock(spec=SupabaseProviderRuntime)
    runtime.operation_wait_timeout.return_value = 1

    async def run(operation):
        result = operation(database)
        if inspect.isawaitable(result):
            await result
            raise ProviderLaneOperationTimeoutError("private caller wait timeout")
        return result

    runtime.run_interactive = AsyncMock(side_effect=run)
    app.dependency_overrides[get_supabase] = lambda: runtime
    response = client.post("/leads", json=BODY)
    assert response.status_code == 504
    assert response.json() == {"detail": PROVIDER_OPERATION_TIMEOUT_DETAIL}
    assert response.headers["Retry-After"] == "1"
    assert database.execute_calls == [RPC]
    subscription.assert_called_once_with(database, STUDIO)
    assert runtime.run_interactive.await_count == 2


def test_public_response_and_update_schema_do_not_gain_command_fields(api):
    _, _, _, app = api
    schemas = app.openapi()["components"]["schemas"]
    response = schemas["LeadResponse"]
    assert set(response["properties"]) == set(ROW)
    assert set(response["required"]) == {
        "id",
        "studio_id",
        "first_name",
        "last_name",
        "source",
        "stage",
        "is_minor",
        "created_at",
        "updated_at",
    }
    assert "operation_id" not in LeadResponse.model_fields
    assert "operation_id" not in LeadUpdate.model_fields
    assert schemas["LeadCreate"]["required"] == ["first_name", "last_name"]
    assert schemas["LeadCreate"]["properties"]["operation_id"]["anyOf"] == [
        {"type": "string", "format": "uuid"},
        {"type": "null"},
    ]
    assert app.openapi()["paths"]["/leads"]["post"]["responses"]["201"]["content"][
        "application/json"
    ]["schema"] == {"$ref": "#/components/schemas/LeadResponse"}


class SyntheticPostgrestClient(SyncPostgrestClient):
    def __init__(self, handler):
        self.handler = handler
        super().__init__("https://synthetic.invalid/rest/v1")

    def create_session(self, base_url, headers, timeout, verify=True, proxy=None):
        return SyncClient(
            base_url=base_url,
            headers=headers,
            timeout=timeout,
            transport=httpx.MockTransport(self.handler),
            trust_env=False,
        )


@pytest.mark.parametrize("replayed", [False, True])
def test_pinned_sdk_parses_receipt_and_sends_exact_command_once_without_network(replayed):
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={**RECEIPT, "replayed": replayed})

    with SyntheticPostgrestClient(handler) as database:
        assert create(database).model_dump(mode="json") == ROW
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{RPC}"
    assert requests[0].method == "POST"
    assert json.loads(requests[0].content) == {
        "p_studio_id": STUDIO,
        "p_actor_id": ACTOR,
        "p_operation_id": OPERATION,
        "p_request": REQUEST_DEFAULTS,
    }


@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("value", MALFORMED_IDENTITIES)
def test_pinned_sdk_malformed_error_identity_is_unavailable_without_retry(field, value):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(503, json=provider_error_body(**{field: value}))

    with SyntheticPostgrestClient(handler) as database:
        error = assert_unavailable(lambda: create(database))
    assert isinstance(error.__context__, APIError)
    assert len(requests) == 1


@pytest.mark.parametrize("code,message,status,detail", ERRORS)
def test_pinned_sdk_known_errors_retain_fixed_mapping(code, message, status, detail):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(400, json=provider_error_body(code=code, message=message))

    with SyntheticPostgrestClient(handler) as database:
        with pytest.raises(HTTPException) as error:
            create(database)
    assert (error.value.status_code, error.value.detail) == (status, detail)
    assert len(requests) == 1


@pytest.mark.parametrize(
    "details,status",
    [(PROGRAM, 409), (OTHER, 503), (None, 503), ([], 503), ({}, 503), ("private details", 503)],
)
def test_pinned_sdk_program_inactive_detail_must_match_request(details, status):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            400, json=provider_error_body(message="PROGRAM_INACTIVE", details=details)
        )

    with SyntheticPostgrestClient(handler) as database:
        with pytest.raises(HTTPException) as error:
            create(database, {**BODY, "program_id": PROGRAM})
    assert error.value.status_code == status
    if status == 409:
        assert error.value.detail == {
            "code": "PROGRAM_INACTIVE",
            "message": "Archived programs cannot be used for new records.",
            "details": {"program_id": PROGRAM},
        }
    else:
        assert error.value.detail == UNAVAILABLE
    assert len(requests) == 1


@pytest.mark.parametrize(
    "status,body",
    [
        (200, None),
        (200, []),
        (200, [RECEIPT]),
        (200, ROW),
        (200, {**RECEIPT, "operation_id": OTHER}),
        (200, {**RECEIPT, "replayed": 1}),
        (200, {**RECEIPT, "payload": {**ROW, "studio_id": OTHER}}),
        (200, {**RECEIPT, "message": "private detail"}),
        (404, provider_error_body(code="PGRST202", message="create_lead_atomic_v1 missing")),
        (500, {"private": "malformed error"}),
    ],
)
def test_pinned_sdk_malformed_success_or_missing_command_fails_closed(status, body):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, json=body)

    with SyntheticPostgrestClient(handler) as database:
        assert_unavailable(lambda: create(database))
    assert len(requests) == 1
