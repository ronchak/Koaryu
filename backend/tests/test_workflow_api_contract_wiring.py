"""Official router and generated contract proofs without provider or database I/O."""

import importlib.util
import json
from collections import Counter
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.routing import iter_route_contexts
from pydantic import TypeAdapter, ValidationError

from app.api.v1.endpoints import (
    belt_test_recipients,
    belt_tests,
    trial_appointments,
    workflow_management,
    workflow_runs,
    workflow_simulation,
)
from app.main import app
from app.schemas.workflow import (
    ConditionConfig,
    DurationDelayConfig,
    EmailConfig,
    LeadFollowUpConfig,
    TriggerConfig,
    UntilDelayConfig,
    WorkflowGraph,
    WorkflowLayout,
    WorkflowValidationIssue,
)
from app.schemas.workflow_management import (
    AutomationOperationResponse,
    WorkflowCreate,
    WorkflowDetail,
    WorkflowFieldMetadata,
    WorkflowPresetMetadata,
    WorkflowValidate,
)
from app.services.workflow_catalog import get_workflow_catalog
from tests.test_workflow_management import CREATE, INSTANT, OPERATION, ROW, WORKFLOW

ROOT = Path(__file__).resolve().parents[2]
APPROVED_ROUTES = {
    "/leads/{lead_id}/trial-appointments": {
        "get": trial_appointments.list_trial_appointments,
        "post": trial_appointments.create_trial_appointment,
    },
    "/leads/{lead_id}/trial-appointments/{appointment_id}": {
        "get": trial_appointments.get_trial_appointment,
        "patch": trial_appointments.update_trial_appointment,
    },
    "/belt-tests": {
        "get": belt_tests.list_belt_test_events,
        "post": belt_tests.create_belt_test_event,
    },
    "/belt-tests/{event_id}": {
        "get": belt_tests.get_belt_test_event,
        "patch": belt_tests.update_belt_test_event,
    },
    "/belt-tests/{event_id}/recipients": {"get": belt_test_recipients.list_belt_test_recipients},
    "/belt-tests/{event_id}/recipients/approve": {
        "post": belt_test_recipients.approve_belt_test_recipients
    },
    "/belt-tests/{event_id}/recipients/{recipient_id}": {
        "get": belt_test_recipients.get_belt_test_recipient
    },
    "/belt-tests/{event_id}/recipients/{recipient_id}/revoke": {
        "post": belt_test_recipients.revoke_belt_test_recipient
    },
    "/automations/catalog": {"get": workflow_management.get_workflow_catalog},
    "/automations/workflows": {
        "get": workflow_management.list_workflows,
        "post": workflow_management.create_workflow,
    },
    "/automations/workflows/validate": {"post": workflow_management.validate_workflow},
    "/automations/workflows/{workflow_id}": {
        "get": workflow_management.get_workflow,
        "put": workflow_management.save_workflow,
    },
    "/automations/workflows/{workflow_id}/publish": {"post": workflow_management.publish_workflow},
    "/automations/workflows/{workflow_id}/start": {"post": workflow_management.start_workflow},
    "/automations/workflows/{workflow_id}/pause": {"post": workflow_management.pause_workflow},
    "/automations/workflows/{workflow_id}/archive": {"post": workflow_management.archive_workflow},
    "/automations/operations/{operation_id}": {"get": workflow_management.get_automation_operation},
    "/automations/workflows/{workflow_id}/runs": {"get": workflow_runs.list_workflow_runs},
    "/automations/runs/{run_id}": {"get": workflow_runs.get_workflow_run},
    "/automations/runs/{run_id}/cancel": {"post": workflow_runs.cancel_workflow_run},
    "/automations/workflows/{workflow_id}/simulate": {
        "post": workflow_simulation.simulate_workflow
    },
}
LEGACY_RESPONSES = [
    ("/automations/missed-class", "get", "200", "MissedClassSettingsResponse"),
    ("/automations/missed-class", "put", "200", "MissedClassSettingsResponse"),
    ("/automations/missed-class/preview", "post", "200", "MissedClassPreviewResponse"),
    ("/automations/missed-class/activity", "get", "200", "MissedClassActivityResponse"),
    ("/internal/automations/missed-class/process-due", "post", "200", "MissedClassProcessResponse"),
    ("/leads", "get", "200", "LeadResponse"),
    ("/leads", "post", "201", "LeadResponse"),
    ("/leads/{lead_id}", "get", "200", "LeadResponse"),
    ("/leads/{lead_id}", "patch", "200", "LeadResponse"),
    ("/leads/{lead_id}/activities", "get", "200", "LeadActivityResponse"),
    ("/leads/{lead_id}/activities", "post", "201", "LeadActivityResponse"),
    ("/leads/{lead_id}/convert", "post", "200", "LeadResponse"),
    ("/leads/{lead_id}/follow-up", "post", "200", "LeadResponse"),
]


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location(
        "api_generator", ROOT / "scripts/generate-api-types.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def openapi(generator):
    return generator.load_openapi()


@pytest.fixture(scope="module")
def contracts(generator):
    return generator.render_contracts()


@pytest.mark.parametrize("path,methods", APPROVED_ROUTES.items())
def test_approved_routes_are_registered_once_on_the_real_app(openapi, path, methods):
    path = "/api/v1" + path
    assert set(openapi["paths"][path]) == set(methods)
    for method, handler in methods.items():
        matches = [
            route
            for route in iter_route_contexts(app.routes)
            if route.path == path and method.upper() in getattr(route, "methods", set())
        ]
        assert len(matches) == 1
        assert matches[0].endpoint is handler


def test_recipient_detail_reuses_complete_response_with_identity_only(openapi):
    detail = openapi["paths"]["/api/v1/belt-tests/{event_id}/recipients/{recipient_id}"]["get"]
    assert detail["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/BeltTestRecipientResponse"
    }
    assert "requestBody" not in detail
    assert {
        (param["name"], param["in"]) for param in detail["parameters"] if param["in"] != "header"
    } == {("event_id", "path"), ("recipient_id", "path")}


def test_simulation_uses_accepted_request_and_response_schemas(openapi):
    operation = openapi["paths"]["/api/v1/automations/workflows/{workflow_id}/simulate"]["post"]
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/WorkflowSimulationRequest"
    }
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/WorkflowSimulationResponse"
    }


def test_actual_app_has_no_duplicate_routes_or_operation_ids(openapi):
    route_pairs = Counter(
        (route.path, method)
        for route in iter_route_contexts(app.routes)
        for method in route.methods or set()
    )
    operation_ids = Counter(
        operation["operationId"]
        for path in openapi["paths"].values()
        for operation in path.values()
        if isinstance(operation, dict) and "operationId" in operation
    )
    assert all(count == 1 for count in route_pairs.values())
    assert all(count == 1 for count in operation_ids.values())
    assert len(route_pairs) >= sum(len(methods) for methods in APPROVED_ROUTES.values())


@pytest.mark.parametrize("path,method,status,model", LEGACY_RESPONSES)
def test_legacy_automation_and_lead_response_references_remain(
    openapi, path, method, status, model
):
    response = openapi["paths"]["/api/v1" + path][method]["responses"][status]
    schema = response["content"]["application/json"]["schema"]
    if schema.get("type") == "array":
        schema = schema["items"]
    assert schema["$ref"] == f"#/components/schemas/{model}"


def test_operation_readback_exposes_only_accepted_command_variants(openapi):
    response = openapi["paths"]["/api/v1/automations/operations/{operation_id}"]["get"][
        "responses"
    ]["200"]
    schema = response["content"]["application/json"]["schema"]
    assert schema["discriminator"]["propertyName"] == "command"
    assert set(schema["discriminator"]["mapping"]) == {
        "workflow.create",
        "workflow.save",
        "workflow.publish",
        "workflow.start",
        "workflow.pause",
        "workflow.archive",
        "lead.create",
        "trial.create",
        "trial.update",
        "belt_test.create",
        "belt_test.update",
        "belt_test.approve",
        "belt_test.revoke",
        "run.cancel",
        "test_email.create",
    }
    assert len(schema["oneOf"]) == 8
    acknowledgment = openapi["components"]["schemas"]["WorkflowTestEmailAcknowledgment"]
    assert (
        set(acknowledgment["properties"])
        == set(acknowledgment["required"])
        == {
            "operation_id",
            "test_delivery_id",
            "state",
        }
    )
    assert acknowledgment["properties"]["state"]["const"] == "queued"
    assert "WorkflowTestEmailRequest" not in openapi["components"]["schemas"]
    assert "WorkflowTestEmailResponse" not in openapi["components"]["schemas"]


def test_real_graph_requests_and_responses_keep_typed_configs(openapi):
    schemas = openapi["components"]["schemas"]
    for owner, field in [
        ("WorkflowCreate", "graph"),
        ("WorkflowDetail", "draft_graph"),
        ("WorkflowPresetMetadata", "graph"),
    ]:
        graph_name = schemas[owner]["properties"][field]["$ref"].rsplit("/", 1)[-1]
        nodes = schemas[graph_name]["properties"]["nodes"]["items"]
        mode = "Input" if owner == "WorkflowCreate" else "Output"
        assert nodes["discriminator"]["propertyName"] == "type"
        assert len(nodes["oneOf"]) == 6
        for kind, config, properties in [
            ("trigger", "TriggerConfig", {"event_type", "program_id", "offset_minutes"}),
            ("condition", "ConditionConfig", {"field", "operator", "value"}),
        ]:
            config = f"{config}-{mode}"
            node_name = nodes["discriminator"]["mapping"][kind].rsplit("/", 1)[-1]
            assert schemas[node_name]["properties"]["type"]["const"] == kind
            assert (
                schemas[node_name]["properties"]["config"]["$ref"]
                == f"#/components/schemas/{config}"
            )
            assert set(schemas[config]["properties"]) == properties
    assert (
        schemas["TriggerConfig-Output"]["properties"]["offset_minutes"]["x-optional-on-wire"]
        is True
    )
    assert schemas["WorkflowFieldMetadata"]["properties"]["values"]["x-optional-on-wire"] is True
    assert schemas["ConditionConfig-Output"]["properties"]["value"]["x-optional-on-wire"] is True


@pytest.mark.parametrize("value", [{}, {"value": None}, {"value": WORKFLOW}, {"value": [WORKFLOW]}])
@pytest.mark.parametrize("offset", [{}, {"offset_minutes": -1440}])
def test_omission_survives_request_detail_receipt_and_graph_roundtrip(value, offset):
    graph = deepcopy(CREATE["graph"])
    graph["nodes"][0]["config"]["event_type"] = "trial.upcoming"
    graph["nodes"][0]["config"].update(offset)
    graph["nodes"][1]["config"].update(value)
    if isinstance(value.get("value"), list):
        graph["nodes"][1]["config"]["operator"] = "in"
    expected = deepcopy(graph)
    expected["nodes"][0]["config"]["program_id"] = None
    request = WorkflowCreate.model_validate({**CREATE, "graph": graph})
    detail = WorkflowDetail.model_validate({**ROW, "draft_graph": graph})
    receipt = TypeAdapter(AutomationOperationResponse).validate_python(
        {
            "operation_id": OPERATION,
            "state": "committed",
            "entity_id": WORKFLOW,
            "committed_at": INSTANT,
            "command": "workflow.create",
            "entity_type": "workflow",
            "result": {**ROW, "draft_graph": graph},
        }
    )
    for serialized in [
        request.model_dump(mode="json")["graph"],
        detail.model_dump(mode="json")["draft_graph"],
        receipt.model_dump(mode="json")["result"]["draft_graph"],
        WorkflowGraph.model_validate_json(json.dumps(graph)).model_dump(mode="json"),
    ]:
        assert serialized == expected
        assert "x-optional-on-wire" not in json.dumps(serialized)


def test_catalog_presets_and_metadata_keep_omission():
    catalog = get_workflow_catalog()
    for preset in catalog["presets"]:
        wire = WorkflowPresetMetadata.model_validate(preset).model_dump(mode="json")
        expected = WorkflowGraph.model_validate(preset["graph"]).model_dump(mode="json")
        assert wire["graph"] == expected
        for source, result in zip(preset["graph"]["nodes"], wire["graph"]["nodes"], strict=True):
            if source["type"] == "trigger":
                assert ("offset_minutes" in source["config"]) == (
                    "offset_minutes" in result["config"]
                )
            elif source["type"] == "condition":
                assert ("value" in source["config"]) == ("value" in result["config"])
    for metadata in catalog["fields"].values():
        assert WorkflowFieldMetadata.model_validate(metadata).model_dump(mode="json") == metadata


@pytest.mark.parametrize("values", [{}, {"values": []}, {"values": ["inquiry"]}])
def test_metadata_values_omission_and_explicit_values(values):
    metadata = {
        "id": "lead.stage",
        "label": "Stage",
        "value_type": "enum",
        "operators": ["eq"],
        "nullable": False,
        **values,
    }
    assert WorkflowFieldMetadata.model_validate(metadata).model_dump(mode="json") == metadata


def test_nonnullable_omitted_properties_still_reject_explicit_null():
    with pytest.raises(ValidationError):
        TriggerConfig(offset_minutes=None)
    with pytest.raises(ValidationError):
        WorkflowFieldMetadata(
            id="lead.stage",
            label="Stage",
            value_type="enum",
            operators=["eq"],
            nullable=False,
            values=None,
        )
    assert ConditionConfig(value=None).model_dump(mode="json")["value"] is None
    assert "value" not in ConditionConfig().model_dump(mode="json")


@pytest.mark.parametrize(
    "schema,expected",
    [
        ({"type": "string", "const": "trigger"}, '"trigger"'),
        ({"type": "integer", "const": 40}, "40"),
        ({"type": "boolean", "const": True}, "true"),
        ({"type": "boolean", "const": False}, "false"),
        ({"const": None}, "null"),
        ({"const": "fixed", "enum": ["fixed"]}, '"fixed"'),
        ({"type": "string", "enum": ["yes", "no"]}, '"yes" | "no"'),
        ({"anyOf": [{"type": "integer"}, {"type": "number"}, {"type": "null"}]}, "number | null"),
        ({"oneOf": [{"const": "yes"}, {"const": "no"}]}, '"yes" | "no"'),
        (
            {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "number"}]}},
            "(string | number)[]",
        ),
        ({"$ref": "#/components/schemas/Recursive"}, "ApiRecursive"),
        ({"type": "array", "items": {"$ref": "#/components/schemas/Recursive"}}, "ApiRecursive[]"),
    ],
)
def test_generator_literals_enums_unions_and_recursive_references(generator, schema, expected):
    assert generator.schema_to_ts(schema) == expected


@pytest.mark.parametrize(
    "schema",
    [
        {"type": "integer", "default": -1},
        {"type": "array", "items": {"type": "string"}, "default": []},
    ],
)
def test_optional_marker_does_not_change_unmarked_response_default_policy(generator, schema):
    args = ("ExampleResponse", "value")
    assert generator.is_required_property(*args, schema, set(), {"ExampleResponse"})
    marked = {**schema, "x-optional-on-wire": True}
    assert not generator.is_required_property(*args, marked, set(), {"ExampleResponse"})
    assert generator.is_required_property(*args, marked, {"value"}, {"ExampleResponse"})
    assert generator.is_required_property(
        *args, {**schema, "x-optional-on-wire": "true"}, set(), {"ExampleResponse"}
    )


def test_generated_aliases_keep_discriminants_and_optional_value_types(contracts):
    for expected in [
        "export interface ApiTriggerConfig_Output {\n  event_type: string | null;\n  program_id: string | null;\n  offset_minutes?: number;\n}",
        "export interface ApiConditionConfig_Output {\n  field: string | null;\n  operator: string | null;\n  value?: string | boolean | number | (string | boolean | number)[] | null;\n}",
        "  values?: string[];",
        '  mode: "duration";',
        '  mode: "until";',
        '  state: "committed";',
        '  command: "belt_test.approve";',
        '  command: "lead.create";',
        '  entity_type: "workflow";',
        "  max_nodes: 40;",
        "  max_request_bytes: 1048576;",
        "  schema_version: 1;",
        "  node_id: string | null;",
        "  edge_id: string | null;",
        "  field: string | null;",
    ]:
        assert expected in contracts
    for kind in ["trigger", "condition", "delay", "email", "lead_follow_up", "end"]:
        assert f'  type: "{kind}";' in contracts
    assert "export type ApiTriggerConfig = Record" not in contracts
    assert "export type ApiConditionConfig = Record" not in contracts
    assert "x-optional-on-wire" not in contracts


def test_run_routes_and_cancel_receipt_expose_the_accepted_aliases(contracts):
    for name in [
        "RunCancelOperationResponse",
        "WorkflowRunDetail",
        "WorkflowRunSummary",
        "WorkflowRunStep",
        "WorkflowEmailAttemptSummary",
        "WorkflowRunCancelRequest",
        "WorkflowRunListResponse",
    ]:
        assert f"export interface Api{name} {{" in contracts
    assert '  command: "run.cancel";' in contracts
    assert "export interface ApiTestEmailOperationResponse {" in contracts
    assert "export interface ApiWorkflowTestEmailAcknowledgment {" in contracts
    assert '  command: "test_email.create";' in contracts
    assert "  result: ApiWorkflowTestEmailAcknowledgment;" in contracts
    assert "ApiWorkflowTestEmailRequest" in contracts
    assert "ApiWorkflowTestEmailResponse" in contracts
    assert '  entity_type: "workflow_run";' in contracts
    assert "  result: ApiWorkflowRunDetail;" in contracts
    assert (
        "export interface ApiWorkflowRunCancelRequest {\n  operation_id: string;\n  expected_revision: number;\n}"
        in contracts
    )
    assert (
        "export interface ApiWorkflowRunListResponse {\n  items: ApiWorkflowRunSummary[];\n  next_cursor: string | null;\n  has_more: boolean;\n}"
        in contracts
    )


def test_official_generation_is_byte_identical_and_matches_checked_in_artifact(
    generator, contracts
):
    assert generator.render_contracts() == contracts
    assert generator.TARGET.read_text() == contracts


def test_layout_map_and_empty_end_config_retain_their_value_contracts(
    generator, openapi, contracts
):
    schemas = openapi["components"]["schemas"]
    positions = schemas["WorkflowLayout-Output"]["properties"]["positions"]
    assert positions["patternProperties"] == {
        "^[A-Za-z0-9_-]{1,64}$": {"$ref": "#/components/schemas/WorkflowPosition"}
    }
    assert generator.schema_to_ts(positions) == "Record<string, ApiWorkflowPosition>"
    assert "  positions: Record<string, ApiWorkflowPosition>;" in contracts
    assert "  positions?: Record<string, ApiWorkflowPosition>;" in contracts
    assert generator.schema_to_ts(schemas["EndConfig"]) == "Record<string, never>"
    assert "export type ApiEndConfig = Record<string, never>;" in contracts
    assert generator.schema_to_ts({"type": "object"}) == "Record<string, unknown>"
    assert (
        generator.schema_to_ts({"type": "object", "additionalProperties": True})
        == "Record<string, unknown>"
    )
    assert (
        generator.schema_to_ts({"type": "object", "additionalProperties": {"type": "string"}})
        == "Record<string, string>"
    )


def test_validation_input_stays_arbitrary_json_with_optional_layout(openapi, contracts):
    # Diagnostic input accepts invalid graph shapes; persisted/output graphs are concrete.
    schemas = openapi["components"]["schemas"]
    assert schemas["JsonValue"] == {}
    assert schemas["WorkflowValidate"]["required"] == ["graph"]
    assert schemas["WorkflowValidate"]["properties"]["layout"]["x-optional-on-wire"] is True
    assert (
        "export interface ApiWorkflowValidate {\n  graph: ApiJsonValue;\n  layout?: ApiJsonValue;\n}"
        in contracts
    )
    assert WorkflowValidate.model_validate({"graph": {}}).model_dump(mode="json") == {
        "graph": {},
        "layout": {},
    }
    assert WorkflowValidate.model_validate({"graph": None, "layout": None}).model_dump(
        mode="json"
    ) == {"graph": None, "layout": None}


def test_generator_reference_collection_terminates_on_recursive_schemas(generator):
    schemas = {"Recursive": {"type": "array", "items": {"$ref": "#/components/schemas/Recursive"}}}
    assert generator.expand_schema_refs({"Recursive"}, schemas) == {"Recursive"}
    assert (
        generator.render_schema("Recursive", schemas["Recursive"], set())
        == "export type ApiRecursive = ApiRecursive[];"
    )


@pytest.mark.parametrize(
    "model,payload,expected",
    [
        (TriggerConfig, {}, {"event_type": None, "program_id": None}),
        (ConditionConfig, {}, {"field": None, "operator": None}),
        (DurationDelayConfig, {"mode": "duration"}, {"mode": "duration", "minutes": None}),
        (
            UntilDelayConfig,
            {"mode": "until"},
            {"mode": "until", "field": None, "offset_minutes": 0},
        ),
        (
            EmailConfig,
            {},
            {"recipient": None, "subject_template": "", "body_template": "", "reply_to_email": ""},
        ),
        (LeadFollowUpConfig, {}, {"due_in_days": None, "note": ""}),
        (WorkflowLayout, {}, {"positions": {}}),
        (
            WorkflowValidationIssue,
            {"code": "incomplete", "message": "Choose a value."},
            {
                "code": "incomplete",
                "message": "Choose a value.",
                "node_id": None,
                "edge_id": None,
                "field": None,
            },
        ),
        (
            WorkflowFieldMetadata,
            {
                "id": "program.id",
                "label": "Program",
                "value_type": "uuid",
                "operators": ["eq"],
                "nullable": True,
            },
            {
                "id": "program.id",
                "label": "Program",
                "value_type": "uuid",
                "operators": ["eq"],
                "nullable": True,
            },
        ),
    ],
)
def test_input_defaults_and_serialized_output_requirements_are_distinct(model, payload, expected):
    instance = model.model_validate(payload)
    assert instance.model_dump(mode="json") == expected
    assert json.loads(instance.model_dump_json()) == expected
    validation = model.model_json_schema(mode="validation")
    serialization = model.model_json_schema(mode="serialization")
    assert set(validation.get("required", [])) == set(payload)
    assert set(serialization.get("required", [])) == set(expected)
    for field, schema in serialization["properties"].items():
        if schema.get("x-optional-on-wire") is True:
            assert field not in serialization.get("required", [])
        assert "x-optional-on-wire" not in expected


@pytest.mark.parametrize("version", [True, False, 1.0, "1", 0, 2])
def test_graph_version_const_metadata_preserves_strict_runtime_validation(version):
    graph = {"schema_version": version, "nodes": [], "edges": []}
    with pytest.raises(ValidationError):
        WorkflowGraph.model_validate(graph)
    valid = {**graph, "schema_version": 1}
    assert WorkflowGraph.model_validate(valid).model_dump(mode="json") == valid
    for mode in ["validation", "serialization"]:
        assert (
            WorkflowGraph.model_json_schema(mode=mode)["properties"]["schema_version"]["const"] == 1
        )
