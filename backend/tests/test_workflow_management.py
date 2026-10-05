"""Synthetic workflow boundary proofs. These tests do not execute SQL or send mail."""

import base64
import json
from copy import deepcopy
from datetime import UTC
from importlib.metadata import version
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import UUID

import httpx
import pytest
from fastapi import HTTPException
from postgrest import SyncPostgrestClient
from postgrest.exceptions import APIError
from postgrest.utils import SyncClient
from pydantic import TypeAdapter, ValidationError

from app.core.request_body_limits import DEFAULT_API_REQUEST_MAX_BYTES
from app.schemas import workflow_management as schema
from app.schemas.lead import LeadResponse
from app.schemas.trial_appointment import MAX_REVISION
from app.schemas.workflow import WorkflowGraph, WorkflowPosition
from app.schemas.workflow_management import (
    AutomationOperationResponse,
    WorkflowCreate,
    WorkflowDetail,
    WorkflowLifecycleRequest,
    WorkflowPublish,
    WorkflowSave,
    WorkflowValidate,
    guard_workflow_request,
)
from app.services import workflow_management_service as boundary
from app.services.workflow_catalog import CATALOG, build_preset, get_workflow_catalog
from app.services.workflow_graph import validate_workflow_draft, validate_workflow_graph
from app.services.workflow_management_service import UNAVAILABLE_DETAIL, WorkflowManagementService
from tests.fakes.supabase import TableBackedSupabase

STUDIO, ACTOR, WORKFLOW, OPERATION, VERSION, OTHER, EVENT, LEAD, STUDENT, RECIPIENT = (
    str(UUID(int=value)) for value in range(1, 11)
)
INSTANT = "2020-10-01T12:00:00Z"
GRAPH = {
    "schema_version": 1,
    "nodes": [
        {"id": "trigger", "type": "trigger", "config": {"event_type": "lead.created"}},
        {
            "id": "condition",
            "type": "condition",
            "config": {"field": "program.id", "operator": "eq"},
        },
    ],
    "edges": [],
}
CREATE = {
    "operation_id": OPERATION,
    "name": "  Follow up  ",
    "description": "",
    "graph": GRAPH,
    "layout": {"positions": {}},
}
SAVE = {**CREATE, "expected_revision": 8}
COMMAND = {"operation_id": OPERATION, "expected_revision": 8}
ROW = {
    "id": WORKFLOW,
    "name": CREATE["name"],
    "description": "",
    "status": "draft",
    "revision": 1,
    "draft_graph": GRAPH,
    "draft_layout": {"positions": {}},
    "validation_issues": [],
    "published_version_id": None,
    "published_version_number": None,
    "published_at": None,
    "updated_at": INSTANT,
    "has_unpublished_changes": True,
    "pending_run_count": 0,
    "sending_run_count": 0,
}
PUBLISHED = {
    **ROW,
    "status": "paused",
    "revision": 9,
    "published_version_id": VERSION,
    "published_version_number": 2,
    "published_at": INSTANT,
    "has_unpublished_changes": True,
    "pending_run_count": 3,
    "sending_run_count": 1,
}
SUMMARY = {
    **{
        key: value
        for key, value in PUBLISHED.items()
        if key not in {"draft_graph", "draft_layout", "validation_issues"}
    },
    "trigger_event_type": "trial.scheduled",
    "draft_trigger_event_type": "lead.created",
    "created_at": INSTANT,
}
CURSOR = {"created_at": INSTANT, "id": WORKFLOW}
ISSUE = {
    "code": "reference_unavailable",
    "message": "Choose an available program or rank.",
    "node_id": "condition",
    "edge_id": None,
    "field": "config.value",
}
READY = {
    "delivery_status": {
        "mode": "test",
        "configured": True,
        "can_enable": True,
        "sender": "sender@example.com",
        "test_recipient": "actor@example.com",
        "reason": None,
    },
    "capabilities": {"can_start": True, "can_test_email": True, "disabled_reason": None},
    "scheduler": {"enabled": True, "interval_seconds": 60},
}
CREATE_RPC = "create_automation_workflow_v1"
SAVE_RPC = "save_automation_workflow_v1"
COMMAND_RPC = "command_automation_workflow_v1"
GET_RPC = "get_automation_workflow_v1"
LIST_RPC = "list_automation_workflows_v1"
VALIDATE_RPC = "validate_automation_workflow_v1"
OPERATION_RPC = "get_automation_operation_v1"
RPCS = [CREATE_RPC, SAVE_RPC, COMMAND_RPC, GET_RPC, LIST_RPC, VALIDATE_RPC, OPERATION_RPC]


def mutation(row=ROW, replayed=False):
    return {"payload": deepcopy(row), "operation_id": OPERATION, "replayed": replayed}


def operation_receipt(
    command="workflow.create", result=ROW, entity_type="workflow", entity_id=WORKFLOW
):
    return {
        "payload": {
            "operation_id": OPERATION,
            "state": "committed",
            "command": command,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "result": deepcopy(result),
            "committed_at": INSTANT,
        }
    }


class Database(TableBackedSupabase):
    def __init__(self):
        super().__init__(
            {
                "staff_roles": [
                    {"user_id": ACTOR, "studio_id": STUDIO, "role": "admin", "archived_at": None}
                ]
            }
        )
        self.rpc_calls = []
        self.execute_calls = []
        self.handlers = {
            CREATE_RPC: mutation(),
            SAVE_RPC: mutation({**ROW, "revision": 9}),
            GET_RPC: {"payload": deepcopy(ROW)},
            LIST_RPC: {
                "payload": {"items": [deepcopy(SUMMARY)], "next_cursor": None, "has_more": False}
            },
            COMMAND_RPC: lambda params: mutation(
                {
                    **PUBLISHED,
                    "has_unpublished_changes": params["p_action"] != "publish",
                    "status": {
                        "publish": "paused",
                        "start": "active",
                        "pause": "paused",
                        "archive": "archived",
                    }[params["p_action"]],
                }
            ),
            VALIDATE_RPC: {"payload": {"valid": True, "issues": []}},
            OPERATION_RPC: operation_receipt(),
        }

    def rpc(self, name, params):
        self.rpc_calls.append((name, deepcopy(params)))

        def execute():
            self.execute_calls.append(name)
            result = self.handlers[name]
            if isinstance(result, Exception):
                raise result
            return SimpleNamespace(data=deepcopy(result(params) if callable(result) else result))

        return SimpleNamespace(execute=execute)


@pytest.fixture
def database():
    return Database()


@pytest.fixture
def capabilities(monkeypatch):
    helper = Mock(return_value=deepcopy(READY))
    monkeypatch.setattr(boundary, "resolve_workflow_capabilities", helper)
    return helper


def invoke(service, rpc):
    if rpc == CREATE_RPC:
        return service.create(STUDIO, ACTOR, WorkflowCreate(**deepcopy(CREATE)))
    if rpc == SAVE_RPC:
        return service.save(STUDIO, ACTOR, UUID(WORKFLOW), WorkflowSave(**deepcopy(SAVE)))
    if rpc == COMMAND_RPC:
        return service.command(
            STUDIO, ACTOR, UUID(WORKFLOW), "pause", WorkflowLifecycleRequest(**COMMAND)
        )
    if rpc == GET_RPC:
        return service.get(STUDIO, ACTOR, UUID(WORKFLOW))
    if rpc == LIST_RPC:
        return service.list(STUDIO, ACTOR)
    if rpc == VALIDATE_RPC:
        return service.validate(STUDIO, ACTOR, WorkflowValidate(graph=deepcopy(GRAPH)))
    return service.operation(STUDIO, ACTOR, UUID(OPERATION), "admin")


def assert_unavailable(call):
    with pytest.raises(HTTPException) as error:
        call()
    assert (error.value.status_code, error.value.detail) == (503, UNAVAILABLE_DETAIL)
    assert error.value.__cause__ is None
    assert error.value.__suppress_context__


def encoded(value):
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_safe_incomplete_draft_omission_null_and_cycles_survive_roundtrip(database):
    graph = deepcopy(GRAPH)
    graph["edges"] = [{"id": "self", "source": "condition", "target": "condition", "port": "yes"}]
    assert validate_workflow_draft(graph, catalog=CATALOG).valid
    assert not validate_workflow_graph(graph, catalog=CATALOG).valid
    database.handlers[CREATE_RPC] = mutation({**ROW, "draft_graph": graph})
    result = WorkflowManagementService(database).create(
        STUDIO, ACTOR, WorkflowCreate(**{**CREATE, "graph": graph})
    )
    assert "value" not in database.rpc_calls[0][1]["p_graph"]["nodes"][1]["config"]
    assert (
        "value" not in result.payload.model_dump(mode="json")["draft_graph"]["nodes"][1]["config"]
    )
    graph["nodes"][1]["config"]["value"] = None
    assert (
        WorkflowCreate(**{**CREATE, "graph": graph}).model_dump(mode="json")["graph"]["nodes"][1][
            "config"
        ]["value"]
        is None
    )


@pytest.mark.parametrize("field,limit", [("name", 120), ("description", 500)])
def test_text_bounds_count_unicode_codepoints_and_preserve_supplied_text(field, limit):
    value = "🦉" * limit
    assert getattr(WorkflowCreate(**{**CREATE, field: value}), field) == value
    with pytest.raises(ValidationError):
        WorkflowCreate(**{**CREATE, field: value + "🦉"})
    assert WorkflowCreate(**CREATE).name == "  Follow up  "


@pytest.mark.parametrize("name", ["", "   ", "\n\t", None, 42, False, [], {}])
def test_name_is_required_meaningful_text(name):
    with pytest.raises(ValidationError):
        WorkflowCreate(**{**CREATE, "name": name})


@pytest.mark.parametrize("field", list(CREATE))
def test_create_requires_all_editable_fields(field):
    data = deepcopy(CREATE)
    data.pop(field)
    with pytest.raises(ValidationError):
        WorkflowCreate(**data)


@pytest.mark.parametrize("revision", [True, False, 0, -1, 1.0, "1", None, MAX_REVISION + 1])
def test_revision_is_strict_positive_bigint(revision):
    with pytest.raises(ValidationError):
        WorkflowLifecycleRequest(**{**COMMAND, "expected_revision": revision})


def test_uuid_canonicalization_and_revision_upper_bound():
    body = WorkflowLifecycleRequest(
        operation_id=UUID(OPERATION).hex.upper(), expected_revision=MAX_REVISION
    )
    assert body.model_dump(mode="json") == {
        "operation_id": OPERATION,
        "expected_revision": MAX_REVISION,
    }


@pytest.mark.parametrize(
    "model,body",
    [
        (WorkflowCreate, CREATE),
        (WorkflowSave, SAVE),
        (WorkflowLifecycleRequest, COMMAND),
        (WorkflowPublish, COMMAND),
        (WorkflowValidate, {"graph": GRAPH}),
    ],
)
@pytest.mark.parametrize(
    "field", ["studio_id", "actor_id", "can_start", "p_start_replay_only", "readiness", "unknown"]
)
def test_request_envelopes_forbid_overrides(model, body, field):
    with pytest.raises(ValidationError):
        model(**{**body, field: True})


@pytest.mark.parametrize("value", [None, 0, 1, "false", "true", [], {}])
def test_cancel_pending_is_strict_and_publish_only(value):
    with pytest.raises(ValidationError):
        WorkflowPublish(**COMMAND, cancel_pending=value)
    with pytest.raises(ValidationError):
        WorkflowLifecycleRequest(**COMMAND, cancel_pending=False)


def huge_safe_draft():
    return {
        "schema_version": 1,
        "nodes": [
            {"id": f"condition_{i}", "type": "condition", "config": {"value": ["🦉" * 500] * 100}}
            for i in range(40)
        ],
        "edges": [],
    }


def test_request_limit_is_canonical_entire_body_before_graph_validation(monkeypatch):
    assert DEFAULT_API_REQUEST_MAX_BYTES == 1048576
    prefix = {"graph": "", "layout": {}}
    overhead = len(json.dumps(prefix, ensure_ascii=False, separators=(",", ":")).encode())
    prefix["graph"] = "x" * (DEFAULT_API_REQUEST_MAX_BYTES - overhead)
    assert WorkflowValidate(**prefix).graph == prefix["graph"]
    prefix["graph"] += "x"
    with pytest.raises(HTTPException) as error:
        WorkflowValidate(**prefix)
    assert (error.value.status_code, error.value.detail) == (422, schema.REQUEST_TOO_LARGE_DETAIL)
    graph = huge_safe_draft()
    called = Mock(side_effect=AssertionError("Nested validator must not run"))
    monkeypatch.setattr(schema, "validate_workflow_draft", called)
    with pytest.raises(HTTPException):
        WorkflowCreate(**{**CREATE, "graph": graph})
    called.assert_not_called()
    # A small graph cannot hide an oversized value elsewhere in the envelope.
    with pytest.raises(HTTPException):
        WorkflowCreate(**{**CREATE, "description": "x" * DEFAULT_API_REQUEST_MAX_BYTES})


@pytest.mark.parametrize(
    "bad", [float("nan"), float("inf"), b"bytes", (1, 2), {1: "key"}, {"set"}, "\ud800"]
)
def test_non_json_safe_validation_request_is_fixed_safe_422(bad):
    with pytest.raises(HTTPException) as error:
        WorkflowValidate(graph=bad)
    assert (error.value.status_code, error.value.detail) == (422, schema.INVALID_REQUEST_DETAIL)


def test_circular_request_is_rejected_without_hanging():
    value = []
    value.append(value)
    with pytest.raises(HTTPException):
        guard_workflow_request(value)


NUL_REQUESTS = [
    (WorkflowCreate, CREATE),
    (WorkflowSave, SAVE),
    (WorkflowValidate, {"graph": GRAPH}),
]


def nul_workflow_body(body, location):
    body = deepcopy(body)
    if location == "graph_value":
        body["graph"]["nodes"][0]["config"]["event_type"] = "A\x00B"
    elif location == "graph_key":
        body["graph"]["A\x00B"] = None
    else:
        body[location] = "A\x00B"
    return body


@pytest.mark.parametrize("model,body", NUL_REQUESTS)
@pytest.mark.parametrize("location", ["name", "description", "graph_value", "graph_key"])
def test_shared_nul_guard_rejects_before_nested_request_work(monkeypatch, model, body, location):
    body = nul_workflow_body(body, location)
    original = deepcopy(body)
    nested = Mock(side_effect=AssertionError("NUL must not reach graph validation"))
    monkeypatch.setattr(schema, "validate_workflow_draft", nested)
    for validate in (guard_workflow_request, model.model_validate):
        with pytest.raises(HTTPException) as error:
            validate(body)
        assert (error.value.status_code, error.value.detail) == (422, schema.INVALID_REQUEST_DETAIL)
    nested.assert_not_called()
    assert body == original


@pytest.mark.parametrize("model,body", NUL_REQUESTS)
@pytest.mark.parametrize("location", ["value", "key"])
def test_direct_services_reject_nul_before_graph_validation_or_rpc(
    database, monkeypatch, model, body, location
):
    data = model.model_validate(deepcopy(body))
    if isinstance(data, WorkflowValidate):
        data.graph = {"A\x00B": None} if location == "key" else "A\x00B"
    elif location == "key":
        data.layout.positions["A\x00B"] = WorkflowPosition(x=0, y=0)
    else:
        data.name = "A\x00B"
    nested = Mock(side_effect=AssertionError("NUL must not reach semantic validation"))
    monkeypatch.setattr(boundary, "validate_workflow_graph", nested)
    service = WorkflowManagementService(database)
    with pytest.raises(HTTPException) as error:
        if isinstance(data, WorkflowSave):
            service.save(STUDIO, ACTOR, UUID(WORKFLOW), data)
        elif isinstance(data, WorkflowCreate):
            service.create(STUDIO, ACTOR, data)
        else:
            service.validate(STUDIO, ACTOR, data)
    assert (error.value.status_code, error.value.detail) == (422, schema.INVALID_REQUEST_DETAIL)
    assert database.rpc_calls == [] and database.query_log == []
    nested.assert_not_called()


@pytest.mark.parametrize("model,body", NUL_REQUESTS)
def test_shared_size_guard_retains_precedence_over_nul(model, body):
    with pytest.raises(HTTPException) as error:
        model.model_validate({**body, "graph": huge_safe_draft(), "A\x00B": None})
    assert (error.value.status_code, error.value.detail) == (422, schema.REQUEST_TOO_LARGE_DETAIL)


@pytest.mark.parametrize("bad", ["\ud800", float("nan"), b"bytes", (1, 2), {1: "key"}])
def test_nul_does_not_bypass_existing_non_json_and_utf8_rejection(bad):
    with pytest.raises(HTTPException) as error:
        guard_workflow_request({"bad": bad, "A\x00B": None})
    assert (error.value.status_code, error.value.detail) == (422, schema.INVALID_REQUEST_DETAIL)


def test_nul_cyclic_request_still_rejects_without_hanging():
    body = {"A\x00B": None}
    body["graph"] = body
    with pytest.raises(HTTPException) as error:
        guard_workflow_request(body)
    assert (error.value.status_code, error.value.detail) == (422, schema.INVALID_REQUEST_DETAIL)


def test_literal_backslash_u0000_is_representable_and_unchanged(database):
    graph = build_preset("welcome")
    graph["nodes"][1]["config"]["body_template"] = r"A\u0000B"
    data = WorkflowCreate(
        **{**CREATE, "name": r"A\u0000B", "description": r"A\u0000B", "graph": graph}
    )
    WorkflowManagementService(database).create(STUDIO, ACTOR, data)
    params = database.rpc_calls[0][1]
    assert params["p_graph"] == graph and params["p_name"] == params["p_description"] == r"A\u0000B"
    guard_workflow_request({r"A\u0000B": [r"A\u0000B"]})


def test_nul_does_not_add_request_rules_to_pure_graphs_or_retained_details(database):
    graph = build_preset("welcome")
    graph["nodes"][1]["config"]["body_template"] = "A\x00B"
    assert WorkflowGraph.model_validate(graph)
    assert not validate_workflow_graph(graph, catalog=CATALOG).valid
    database.handlers[GET_RPC] = {"payload": {**ROW, "draft_graph": graph}}
    result = invoke(WorkflowManagementService(database), GET_RPC)
    assert result.draft_graph.nodes[1].config.body_template == "A\x00B"


def test_large_stored_safe_draft_still_loads_and_pure_validation_is_unchanged(database):
    graph = huge_safe_draft()
    assert len(json.dumps(graph, ensure_ascii=False).encode()) > 8_000_000
    assert validate_workflow_draft(graph, catalog=CATALOG).valid
    assert WorkflowGraph.model_validate(graph)
    database.handlers[GET_RPC] = {"payload": {**ROW, "draft_graph": graph}}
    result = invoke(WorkflowManagementService(database), GET_RPC)
    assert len(result.draft_graph.nodes) == 40
    assert result.draft_graph.nodes[0].config.value == ["🦉" * 500] * 100


@pytest.mark.parametrize("field", list(ROW))
def test_provider_detail_must_be_complete(database, field):
    row = deepcopy(ROW)
    row.pop(field)
    database.handlers[GET_RPC] = {"payload": row}
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), GET_RPC))


@pytest.mark.parametrize(
    "changes",
    [
        {"id": OTHER},
        {"revision": True},
        {"revision": "1"},
        {"revision": 0},
        {"revision": MAX_REVISION + 1},
        {"pending_run_count": True},
        {"sending_run_count": -1},
        {"has_unpublished_changes": "false"},
        {"published_version_id": VERSION},
        {"status": "active"},
        {"status": "paused"},
        {"updated_at": "2020-10-01T12:00:00"},
        {"updated_at": 1},
        {"updated_at": "infinity"},
        {"studio_id": STUDIO},
        {"created_at": INSTANT},
        {"validation_issues": [{"code": "x", "message": "safe"}]},
    ],
)
def test_malformed_detail_facts_fail_closed(database, changes):
    database.handlers[GET_RPC] = {"payload": {**ROW, **changes}}
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), GET_RPC))


def test_aware_dates_normalize_to_utc_and_draft_does_not_replace_publication():
    row = WorkflowDetail(**{**PUBLISHED, "updated_at": "2020-10-01T05:00:00-07:00"})
    assert row.updated_at.tzinfo == UTC
    assert row.published_version_id == UUID(VERSION)
    assert row.validation_issues == []
    assert row.has_unpublished_changes and row.pending_run_count == 3 and row.sending_run_count == 1
    assert row.draft_graph.nodes[1].config.value is None


@pytest.mark.parametrize("rpc", RPCS)
def test_exact_rpc_name_parameters_and_one_execution(database, rpc):
    invoke(WorkflowManagementService(database), rpc)
    assert database.execute_calls == [rpc]
    name, params = database.rpc_calls[0]
    assert name == rpc
    assert params["p_studio_id"] == STUDIO and params["p_actor_id"] == ACTOR
    fields = {"p_studio_id", "p_actor_id"}
    fields |= {
        CREATE_RPC: {"p_operation_id", "p_name", "p_description", "p_graph", "p_layout"},
        SAVE_RPC: {
            "p_workflow_id",
            "p_operation_id",
            "p_expected_revision",
            "p_name",
            "p_description",
            "p_graph",
            "p_layout",
        },
        COMMAND_RPC: {
            "p_workflow_id",
            "p_operation_id",
            "p_expected_revision",
            "p_action",
            "p_cancel_pending",
            "p_start_replay_only",
        },
        GET_RPC: {"p_workflow_id"},
        LIST_RPC: {"p_limit", "p_cursor"},
        VALIDATE_RPC: {"p_graph", "p_layout"},
        OPERATION_RPC: {"p_operation_id"},
    }[rpc]
    assert set(params) == fields
    assert database.query_log == []  # No current entity/reference or receipt pre-read.


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize(
    "bad",
    [
        None,
        [],
        [ROW],
        "message",
        {"message": "private"},
        {"payload": None},
        {"payload": ROW, "extra": True},
    ],
)
def test_no_rpc_envelope_compatibility_fallback(database, rpc, bad):
    database.handlers[rpc] = bad
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), rpc))
    assert database.execute_calls == [rpc]


@pytest.mark.parametrize("replayed", [False, True])
@pytest.mark.parametrize("action", ["create", "save", "publish", "start", "pause", "archive"])
def test_success_guarantees_apply_to_original_revision_even_on_replay(
    database, capabilities, action, replayed
):
    status = {
        "create": "draft",
        "save": "paused",
        "publish": "active",
        "start": "active",
        "pause": "paused",
        "archive": "archived",
    }[action]
    row = deepcopy(ROW if action == "create" else PUBLISHED)
    row["status"] = status
    if action == "publish":
        row["has_unpublished_changes"] = False
    rpc = CREATE_RPC if action == "create" else SAVE_RPC if action == "save" else COMMAND_RPC
    database.handlers[rpc] = mutation(row, replayed)
    service = WorkflowManagementService(database)

    def call():
        if action in {"create", "save"}:
            return invoke(service, rpc)
        data = (
            WorkflowPublish(**COMMAND)
            if action == "publish"
            else WorkflowLifecycleRequest(**COMMAND)
        )
        return service.command(STUDIO, ACTOR, UUID(WORKFLOW), action, data)

    response = call()
    assert response.replayed is replayed
    assert response.payload.revision == (1 if action == "create" else 9)
    for bad_revision in [0, 2 if action == "create" else 8, 10, "9", True]:
        database.handlers[rpc]["payload"]["revision"] = bad_revision
        assert_unavailable(call)
    database.handlers[rpc] = mutation(
        {**row, "status": "archived" if action != "archive" else "active"}, replayed
    )
    assert_unavailable(call)


@pytest.mark.parametrize(
    "field,value",
    [("operation_id", OTHER), ("operation_id", None), ("replayed", "true"), ("replayed", 1)],
)
def test_mutation_receipt_echo_is_strict(database, field, value):
    database.handlers[CREATE_RPC][field] = value
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), CREATE_RPC))


@pytest.mark.parametrize("capable", [False, True])
@pytest.mark.parametrize("replayed", [False, True])
def test_start_replay_flag_comes_from_actual_capability(database, capabilities, capable, replayed):
    capabilities.return_value["capabilities"]["can_start"] = capable
    capabilities.return_value["capabilities"]["disabled_reason"] = (
        None if capable else "Workflow scheduling is disabled."
    )
    database.handlers[COMMAND_RPC] = mutation({**PUBLISHED, "status": "active"}, replayed)
    service = WorkflowManagementService(database, settings="trusted settings")
    call = lambda: service.command(
        STUDIO, ACTOR, UUID(WORKFLOW), "start", WorkflowLifecycleRequest(**COMMAND)
    )
    if not capable and not replayed:
        assert_unavailable(call)
    else:
        assert call().replayed is replayed
    assert database.rpc_calls[0][1]["p_start_replay_only"] is (not capable)
    capabilities.assert_called_once_with(database, "trusted settings", ACTOR)
    assert len(database.execute_calls) == 1


def test_disabled_new_start_is_sql_conflict_but_matching_original_replays(database, capabilities):
    capabilities.return_value["capabilities"].update(
        can_start=False, disabled_reason="Workflow scheduling is disabled."
    )
    database.handlers[COMMAND_RPC] = APIError(
        {
            "code": "P0001",
            "message": "AUTOMATION_STATE_CONFLICT",
            "details": "private",
            "hint": "private",
        }
    )
    service = WorkflowManagementService(database)
    with pytest.raises(HTTPException) as error:
        service.command(STUDIO, ACTOR, UUID(WORKFLOW), "start", WorkflowLifecycleRequest(**COMMAND))
    assert error.value.status_code == 409
    assert database.execute_calls == [COMMAND_RPC]
    # This synthetic receipt models the SQL-owned exact-key replay decision.
    database.handlers[COMMAND_RPC] = mutation({**PUBLISHED, "status": "active"}, True)
    response = service.command(
        STUDIO, ACTOR, UUID(WORKFLOW), "start", WorkflowLifecycleRequest(**COMMAND)
    )
    assert response.replayed and response.payload.revision == 9


@pytest.mark.parametrize("action", ["publish", "pause", "archive"])
def test_non_start_commands_do_not_inspect_capabilities(database, capabilities, action):
    data = (
        WorkflowPublish(**COMMAND, cancel_pending=True)
        if action == "publish"
        else WorkflowLifecycleRequest(**COMMAND)
    )
    WorkflowManagementService(database).command(STUDIO, ACTOR, UUID(WORKFLOW), action, data)
    params = database.rpc_calls[0][1]
    assert params["p_start_replay_only"] is False
    assert params["p_cancel_pending"] is (action == "publish")
    capabilities.assert_not_called()


def test_catalog_is_typed_fresh_metadata_with_real_helper_output(capabilities):
    service = WorkflowManagementService(Database(), "settings")
    first = service.catalog(ACTOR)
    second = service.catalog(ACTOR)
    original = get_workflow_catalog()
    assert first.schema_version == 1 and first.limits.max_request_bytes == 1048576
    for key, value in READY.items():
        assert first.model_dump(mode="json")[key] == value
    first.triggers["lead.created"].recipient_ids.clear()
    first.presets[0].graph.nodes.clear()
    assert (
        second.triggers["lead.created"].recipient_ids
        == original["triggers"]["lead.created"]["recipient_ids"]
    )
    assert second.presets[0].graph.nodes
    assert get_workflow_catalog() == original


def test_catalog_closed_entity_types_and_omitted_nonnullable_field_values():
    catalog = get_workflow_catalog()
    field = schema.WorkflowFieldMetadata(**catalog["fields"]["student.on_hold"])
    assert "values" not in field.model_dump(mode="json")
    for value in [None, [True], [1]]:
        with pytest.raises(ValidationError):
            schema.WorkflowFieldMetadata(
                **{**catalog["fields"]["student.on_hold"], "values": value}
            )
    for key in ["subject_kind", "simulation_entity_type"]:
        with pytest.raises(ValidationError):
            schema.WorkflowTriggerMetadata(
                **{**catalog["triggers"]["lead.created"], key: "unknown"}
            )
    for metadata in catalog["triggers"].values():
        assert schema.WorkflowTriggerMetadata(**metadata)


@pytest.mark.parametrize(
    "changes", [{"has_unpublished_changes": True}, {"validation_issues": [ISSUE]}]
)
@pytest.mark.parametrize("replayed", [False, True])
def test_publish_result_is_fully_published_in_mutation_and_receipt(database, changes, replayed):
    row = {**PUBLISHED, "has_unpublished_changes": False, **changes}
    database.handlers[COMMAND_RPC] = mutation(row, replayed)
    service = WorkflowManagementService(database)
    assert_unavailable(
        lambda: service.command(
            STUDIO, ACTOR, UUID(WORKFLOW), "publish", WorkflowPublish(**COMMAND)
        )
    )
    database.handlers[OPERATION_RPC] = operation_receipt("workflow.publish", row)
    assert_unavailable(lambda: invoke(service, OPERATION_RPC))


def test_maximal_unicode_templates_fit_normal_management_request():
    nodes = [{"id": "trigger", "type": "trigger", "config": {"event_type": "lead.created"}}]
    nodes += [
        {
            "id": f"email_{i}",
            "type": "email",
            "config": {
                "recipient": "lead_or_guardian",
                "subject_template": "🦉" * 200,
                "body_template": "🦉" * 5000,
            },
        }
        for i in range(38)
    ]
    nodes += [{"id": "end", "type": "end", "config": {}}]
    graph = {
        "schema_version": 1,
        "nodes": nodes,
        "edges": [
            {
                "id": f"edge_{i}",
                "source": nodes[i]["id"],
                "target": nodes[i + 1]["id"],
                "port": "next",
            }
            for i in range(39)
        ],
    }
    assert validate_workflow_graph(graph, catalog=CATALOG).valid
    body = WorkflowCreate(**{**CREATE, "graph": graph}).model_dump(mode="json")
    assert (
        790_000
        < len(json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode())
        < DEFAULT_API_REQUEST_MAX_BYTES
    )
    guard_workflow_request(body)


@pytest.mark.parametrize(
    "path,value",
    [
        (("capabilities", "can_start"), "true"),
        (("capabilities", "can_test_email"), 1),
        (("capabilities", "disabled_reason"), None),
        (("scheduler", "enabled"), False),
        (("scheduler", "interval_seconds"), 60.0),
        (("delivery_status", "can_enable"), False),
        (("delivery_status", "configured"), False),
        (("delivery_status", "reason"), "unavailable"),
    ],
)
def test_malformed_or_contradictory_capabilities_never_enable_start(
    database, capabilities, path, value
):
    capabilities.return_value[path[0]][path[1]] = value
    if path == ("capabilities", "disabled_reason"):
        capabilities.return_value["capabilities"]["can_start"] = False
    assert_unavailable(
        lambda: WorkflowManagementService(database).command(
            STUDIO, ACTOR, UUID(WORKFLOW), "start", WorkflowLifecycleRequest(**COMMAND)
        )
    )
    assert database.rpc_calls == []


def test_actual_capability_dependency_fails_closed_without_ready_schema(monkeypatch):
    # Exercise the actual dependency in addition to mocked-boundary cases.
    from app.services import workflow_capabilities

    monkeypatch.setattr(
        workflow_capabilities,
        "email_delivery_status",
        lambda *_: deepcopy(READY["delivery_status"]),
    )
    database = Database()  # Missing preflight RPCs, no Auth access.
    result = WorkflowManagementService(
        database, SimpleNamespace(AUTOMATION_WORKER_ENABLED=True)
    ).catalog(ACTOR)
    assert result.capabilities.can_start is False
    assert result.capabilities.can_test_email is False
    assert result.capabilities.disabled_reason == "Workflow setup is unavailable."


@pytest.mark.parametrize("graph", [None, 1, [], {}, {"schema_version": 77}, GRAPH])
def test_explicit_validation_always_uses_authority_rpc_even_for_graph_issues(database, graph):
    result = WorkflowManagementService(database).validate(
        STUDIO, ACTOR, WorkflowValidate(graph=deepcopy(graph))
    )
    assert result.valid is False and result.issues
    assert database.execute_calls == [VALIDATE_RPC]


def test_validation_combines_python_then_unique_sql_issues(database):
    expected = validate_workflow_graph(GRAPH, catalog=CATALOG, layout={})
    database.handlers[VALIDATE_RPC] = {
        "payload": {"valid": False, "issues": [expected.issues[0].model_dump(), ISSUE, ISSUE]}
    }
    result = invoke(WorkflowManagementService(database), VALIDATE_RPC)
    assert result.valid is False
    assert [row.model_dump() for row in result.issues] == [
        *[row.model_dump() for row in expected.issues],
        ISSUE,
    ]


@pytest.mark.parametrize(
    "valid,issues",
    [
        (True, [ISSUE]),
        (False, []),
        ("true", []),
        (True, [{}]),
        (False, [{"code": "x", "message": "safe"}]),
    ],
)
def test_contradictory_or_incomplete_sql_validation_is_unavailable(database, valid, issues):
    database.handlers[VALIDATE_RPC] = {"payload": {"valid": valid, "issues": issues}}
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), VALIDATE_RPC))


def test_valid_presets_and_current_reference_issue(database):
    service = WorkflowManagementService(database)
    for preset in get_workflow_catalog()["presets"]:
        assert service.validate(STUDIO, ACTOR, WorkflowValidate(graph=preset["graph"])).valid
    database.handlers[VALIDATE_RPC] = {"payload": {"valid": False, "issues": [ISSUE]}}
    result = service.validate(
        STUDIO,
        ACTOR,
        WorkflowValidate(graph=build_preset(get_workflow_catalog()["presets"][0]["id"])),
    )
    assert not result.valid and result.issues[0].code == "reference_unavailable"


@pytest.mark.parametrize(
    "token",
    [
        "",
        "x" * 513,
        "abc=",
        "a+",
        "é",
        "A",
        encoded({"id": WORKFLOW}),
        encoded({**CURSOR, "extra": 1}),
        encoded({**CURSOR, "created_at": "infinity"}),
        encoded({**CURSOR, "id": None}),
        encoded(b'{"created_at":"2020-10-01T12:00:00Z","id":null,"id":null}'),
        encoded(b'{"created_at":NaN,"id":null}'),
        encoded([]),
    ],
)
def test_cursor_rejects_invalid_bounded_json_before_rpc(database, token):
    with pytest.raises(HTTPException) as error:
        WorkflowManagementService(database).list(STUDIO, ACTOR, cursor=token)
    assert (error.value.status_code, error.value.detail) == (422, boundary.INVALID_CURSOR_DETAIL)
    assert database.rpc_calls == []


@pytest.mark.parametrize("limit", [0, 101, True, "5", None, 1.0])
def test_service_page_limits_are_strict(database, limit):
    with pytest.raises(HTTPException) as error:
        WorkflowManagementService(database).list(STUDIO, ACTOR, limit=limit)
    assert error.value.status_code == 422 and not database.rpc_calls


def test_summary_published_and_draft_trigger_and_cursor_are_preserved(database):
    database.handlers[LIST_RPC]["payload"].update(next_cursor=CURSOR, has_more=True)
    result = WorkflowManagementService(database).list(
        STUDIO, ACTOR, limit=1, cursor=encoded(CURSOR)
    )
    assert (
        result.has_more
        and json.loads(
            base64.urlsafe_b64decode(result.next_cursor + "=" * (-len(result.next_cursor) % 4))
        )
        == CURSOR
    )
    assert result.items[0].trigger_event_type == "trial.scheduled"
    assert result.items[0].draft_trigger_event_type == "lead.created"
    assert database.rpc_calls[0][1]["p_cursor"] == CURSOR
    assert (
        not {"draft_graph", "draft_layout", "graph", "templates"}
        & result.items[0].model_dump().keys()
    )


@pytest.mark.parametrize(
    "change",
    [
        {"has_more": True},
        {"next_cursor": CURSOR},
        {"items": [], "next_cursor": CURSOR, "has_more": True},
        {"items": [SUMMARY, SUMMARY]},
        {"next_cursor": {**CURSOR, "id": OTHER}, "has_more": True},
        {"next_cursor": {**CURSOR, "created_at": "2021-01-01T00:00:00Z"}, "has_more": True},
        {"items": [{**SUMMARY, "draft_graph": GRAPH}]},
        {"items": [{**SUMMARY, "template": "private"}]},
    ],
)
def test_page_facts_and_last_row_cursor_must_agree(database, change):
    database.handlers[LIST_RPC]["payload"].update(change)
    assert_unavailable(lambda: WorkflowManagementService(database).list(STUDIO, ACTOR, limit=1))


def domain_receipts():
    # These complete DTO fixtures intentionally use historical revisions/dates.
    lead = {name: None for name in LeadResponse.model_fields}
    lead.update(
        id=LEAD,
        studio_id=STUDIO,
        first_name="Aiko",
        last_name="Tanaka",
        source="walk_in",
        stage="inquiry",
        is_minor=False,
        created_at=INSTANT,
        updated_at=INSTANT,
    )
    trial = {
        "id": OTHER,
        "studio_id": STUDIO,
        "lead_id": LEAD,
        "program_id": None,
        "starts_at": "2020-11-01T12:00:00Z",
        "ends_at": "2020-11-01T13:00:00Z",
        "timezone": "UTC",
        "location": "",
        "status": "scheduled",
        "revision": 8,
        "created_by": ACTOR,
        "created_at": INSTANT,
        "updated_at": INSTANT,
    }
    event = {key: value for key, value in trial.items() if key != "lead_id"}
    event.update(id=EVENT, name="Exam", ladder_id=OTHER, schedule_revision=3)
    recipient = {
        "id": RECIPIENT,
        "studio_id": STUDIO,
        "event_id": EVENT,
        "student_id": STUDENT,
        "student_program_membership_id": None,
        "approved_schedule_revision": 3,
        "approved_current_rank_id": None,
        "approved_target_rank_id": OTHER,
        "state": "approved",
        "revision": 2,
        "approved_by": ACTOR,
        "approved_at": INSTANT,
        "revoked_at": None,
        "created_at": INSTANT,
        "updated_at": INSTANT,
    }
    result = {}
    for action in ["create", "save", "publish", "start", "pause", "archive"]:
        row = deepcopy(ROW if action == "create" else PUBLISHED)
        row["status"] = {
            "create": "draft",
            "save": "paused",
            "publish": "active",
            "start": "active",
            "pause": "paused",
            "archive": "archived",
        }[action]
        if action == "publish":
            row["has_unpublished_changes"] = False
        result[f"workflow.{action}"] = operation_receipt(f"workflow.{action}", row)
    result["lead.create"] = operation_receipt("lead.create", lead, "lead", LEAD)
    for action in ["create", "update"]:
        result[f"trial.{action}"] = operation_receipt(
            f"trial.{action}", trial, "trial_appointment", OTHER
        )
        result[f"belt_test.{action}"] = operation_receipt(
            f"belt_test.{action}", event, "belt_test", EVENT
        )
    result["belt_test.approve"] = operation_receipt(
        "belt_test.approve",
        {"items": [recipient], "event_revision": 8, "schedule_revision": 3},
        "belt_test",
        EVENT,
    )
    result["belt_test.revoke"] = operation_receipt(
        "belt_test.revoke",
        {**recipient, "state": "revoked", "revoked_at": INSTANT},
        "belt_test_recipient",
        RECIPIENT,
    )
    return result


@pytest.mark.parametrize("command,receipt", domain_receipts().items())
def test_every_typed_receipt_discriminator_and_original_result(database, command, receipt):
    database.handlers[OPERATION_RPC] = deepcopy(receipt)
    result = invoke(WorkflowManagementService(database), OPERATION_RPC)
    assert result.command == command
    assert (
        TypeAdapter(AutomationOperationResponse).validate_python(receipt["payload"]).command
        == command
    )
    assert result.operation_id == UUID(OPERATION)
    assert database.execute_calls == [OPERATION_RPC]
    assert database.query_log == []
    if command == "belt_test.approve":
        assert result.result.event_revision == 8  # No current CAS was supplied or read.


@pytest.mark.parametrize("command,receipt", domain_receipts().items())
@pytest.mark.parametrize(
    "field,value",
    [
        ("entity_id", None),
        ("entity_id", STUDIO),
        ("entity_type", "unknown"),
        ("operation_id", OTHER),
        ("state", "pending"),
        ("command", "run.future"),
        ("result", {}),
    ],
)
def test_receipt_discriminator_and_entity_identity_fail_closed(
    database, command, receipt, field, value
):
    payload = deepcopy(receipt)
    payload["payload"][field] = value
    database.handlers[OPERATION_RPC] = payload
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), OPERATION_RPC))


@pytest.mark.parametrize(
    "command,receipt",
    [(key, value) for key, value in domain_receipts().items() if not key.startswith("workflow.")],
)
def test_receipt_result_studio_must_match_current_studio(database, command, receipt):
    changed = deepcopy(receipt)
    result = changed["payload"]["result"]
    if command == "belt_test.approve":
        result = result["items"][0]
    result["studio_id"] = OTHER
    database.handlers[OPERATION_RPC] = changed
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), OPERATION_RPC))


@pytest.mark.parametrize("field", list(LeadResponse.model_fields))
def test_lead_receipts_require_even_nullable_fields(database, field):
    receipt = domain_receipts()["lead.create"]
    receipt["payload"]["result"].pop(field)
    database.handlers[OPERATION_RPC] = receipt
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), OPERATION_RPC))


@pytest.mark.parametrize(
    "field,value",
    [
        ("program_id", "bad"),
        ("assigned_staff_id", "bad"),
        ("converted_student_id", "bad"),
        ("is_minor", 1),
        ("unknown", "private"),
    ],
)
def test_lead_receipt_uuids_and_facts_are_strict(database, field, value):
    receipt = domain_receipts()["lead.create"]
    receipt["payload"]["result"][field] = value
    database.handlers[OPERATION_RPC] = receipt
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), OPERATION_RPC))


@pytest.mark.parametrize(
    "case", ["empty", "duplicate_id", "duplicate_pair", "foreign_event", "schedule", "revoked"]
)
def test_approval_batch_identities_are_consistent(database, case):
    receipt = domain_receipts()["belt_test.approve"]
    batch = receipt["payload"]["result"]
    row = batch["items"][0]
    if case == "empty":
        batch["items"] = []
    elif case == "duplicate_id":
        batch["items"].append({**row, "student_id": OTHER})
    elif case == "duplicate_pair":
        batch["items"].append({**row, "id": OTHER})
    else:
        row[
            {
                "foreign_event": "event_id",
                "schedule": "approved_schedule_revision",
                "revoked": "state",
            }[case]
        ] = {"foreign_event": OTHER, "schedule": 7, "revoked": "revoked"}[case]
    database.handlers[OPERATION_RPC] = receipt
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), OPERATION_RPC))


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


@pytest.mark.parametrize("rpc", RPCS)
def test_pinned_sdk_complete_success_envelope_without_network(rpc):
    assert version("postgrest") == "0.17.2"
    requests = []

    def handler(request):
        requests.append(request)
        fake = Database()
        params = json.loads(request.content)
        return httpx.Response(200, json=fake.rpc(rpc, params).execute().data)

    with SyntheticPostgrestClient(handler) as client:
        assert invoke(WorkflowManagementService(client), rpc)
    assert len(requests) == 1
    assert requests[0].url.path == f"/rest/v1/rpc/{rpc}"


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize("field", ["code", "message"])
@pytest.mark.parametrize("value", [None, [], {}, 1, 1.5, True, False])
def test_pinned_sdk_malformed_error_identity_is_fixed_unavailable(rpc, field, value):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            503,
            json={
                "code": "P0001",
                "message": "AUTOMATION_STATE_CONFLICT",
                "details": "private",
                "hint": "private",
                field: value,
            },
        )

    with SyntheticPostgrestClient(handler) as client:
        assert_unavailable(lambda: invoke(WorkflowManagementService(client), rpc))
    assert len(calls) == 1


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize("pair,mapped", list(boundary._ERRORS.items()))
def test_known_owned_errors_have_safe_mapping_and_no_retry(database, rpc, pair, mapped):
    database.handlers[rpc] = APIError(
        {"code": pair[0], "message": pair[1], "details": "private", "hint": "private"}
    )
    with pytest.raises(HTTPException) as error:
        invoke(WorkflowManagementService(database), rpc)
    assert (error.value.status_code, error.value.detail) == mapped
    assert database.execute_calls == [rpc]


@pytest.mark.parametrize("rpc", RPCS)
@pytest.mark.parametrize(
    "failure",
    [
        APIError(
            {
                "code": "PGRST202",
                "message": "private function",
                "details": "private",
                "hint": "private",
            }
        ),
        APIError({"code": "42501", "message": "private", "details": "private", "hint": "private"}),
        RuntimeError("private provider transport"),
    ],
)
def test_unknown_missing_rpc_and_transport_errors_are_safe_unavailable(database, rpc, failure):
    database.handlers[rpc] = failure
    assert_unavailable(lambda: invoke(WorkflowManagementService(database), rpc))
    assert database.execute_calls == [rpc]
