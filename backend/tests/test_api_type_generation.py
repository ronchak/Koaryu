import importlib.util
import json
import re
import subprocess
import sys
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.openapi.models import Schema
from pydantic import Field, create_model

ROOT = Path(__file__).resolve().parents[2]
NEW_ALIASES = {
    "ApiWorkflowSimulationAction",
    "ApiWorkflowSimulationEntityContext",
    "ApiWorkflowSimulationRequest",
    "ApiWorkflowSimulationResponse",
    "ApiWorkflowSimulationSyntheticContext",
    "ApiWorkflowSimulationTrace",
    "ApiWorkflowTestEmailRequest",
    "ApiWorkflowTestEmailResponse",
}


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location(
        "api_type_generator", ROOT / "scripts/generate-api-types.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def aliases(contracts):
    blocks = contracts.split("\n\n")[1:]
    pairs = [(re.match(r"export (?:interface|type) (\w+)", block)[1], block) for block in blocks]
    assert len(dict(pairs)) == len(pairs), "Duplicate generated alias"
    return dict(pairs)


def register_model(generator, monkeypatch, model, mode="validation"):
    monkeypatch.setattr(
        generator, "EXTRA_PYDANTIC_SCHEMA_MODELS", (("test", model.__name__, mode),)
    )
    monkeypatch.setattr(
        generator,
        "importlib",
        SimpleNamespace(import_module=lambda _: SimpleNamespace(**{model.__name__: model})),
    )


class ApiTypeGenerationTest(unittest.TestCase):
    def test_frontend_api_contract_types_are_current(self):
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            [sys.executable, "scripts/generate-api-types.py", "--check"],
            cwd=root,
            capture_output=True,
            text=True,
        )

        self.assertEqual(
            result.returncode,
            0,
            result.stdout + result.stderr,
        )

    def test_array_item_unions_are_parenthesized(self):
        root = Path(__file__).resolve().parents[2]
        generated_types = (
            root / "frontend" / "src" / "types" / "generated" / "api-contracts.ts"
        ).read_text()

        self.assertIn("loc: (string | number)[];", generated_types)
        self.assertNotIn("loc: string | number[];", generated_types)

    def test_embedded_form_payload_contracts_are_generated(self):
        root = Path(__file__).resolve().parents[2]
        generated_types = (
            root / "frontend" / "src" / "types" / "generated" / "api-contracts.ts"
        ).read_text()

        self.assertIn("export interface ApiCsvImportRequest", generated_types)
        self.assertIn("options?: ApiCsvImportOptions;", generated_types)
        self.assertIn("export interface ApiClassSessionDeleteScope", generated_types)
        self.assertIn("export interface ApiStudentListQueryContract", generated_types)
        self.assertIn(
            'status?: "active" | "trialing" | "inactive" | "paused" | "canceled" | null;',
            generated_types,
        )
        self.assertIn("export interface ApiStudentRosterPageResponse", generated_types)
        self.assertIn("export interface ApiStudentRosterCursorErrorResponse", generated_types)
        self.assertIn("cursor?: string | null;", generated_types)
        self.assertIn("export interface ApiStudentListResponse", generated_types)


def test_registry_modes_preserve_every_legacy_alias(generator, monkeypatch):
    registry = generator.EXTRA_PYDANTIC_SCHEMA_MODELS
    assert registry[:5] == (
        ("app.schemas.student", "CsvImportOptions", "validation"),
        ("app.schemas.student", "CsvImportRequest", "validation"),
        ("app.schemas.student", "StudentListQueryContract", "validation"),
        ("app.schemas.student", "StudentListResponse", "validation"),
        ("app.schemas.schedule", "ClassSessionDeleteScope", "validation"),
    )
    assert registry[5:] == (
        ("app.schemas.workflow_simulation", "WorkflowSimulationRequest", "validation"),
        ("app.schemas.workflow_simulation", "WorkflowSimulationResponse", "serialization"),
        ("app.schemas.workflow_test_email", "WorkflowTestEmailRequest", "validation"),
        ("app.schemas.workflow_test_email", "WorkflowTestEmailResponse", "serialization"),
    )
    openapi = generator.load_openapi()
    schemas = deepcopy(openapi["components"]["schemas"])
    # Reproduce the original five-root insertion and response classification.
    for module_name, model_name, _ in registry[:5]:
        model = getattr(generator.importlib.import_module(module_name), model_name)
        schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        for name, definition in schema.pop("$defs", {}).items():
            schemas.setdefault(name, definition)
        schemas.setdefault(model_name, schema)
    responses = generator.collect_response_schema_names(openapi, schemas)
    previous = (
        "\n\n".join(
            [generator.HEADER.rstrip()]
            + [generator.render_schema(name, schemas[name], responses) for name in sorted(schemas)]
        )
        + "\n"
    )
    monkeypatch.setattr(generator, "EXTRA_PYDANTIC_SCHEMA_MODELS", registry[:5])
    assert generator.render_contracts() == previous
    monkeypatch.setattr(generator, "EXTRA_PYDANTIC_SCHEMA_MODELS", registry)
    current = aliases(generator.render_contracts())
    old = aliases(previous)
    assert NEW_ALIASES <= current.keys()
    assert current.keys() - old.keys() == NEW_ALIASES - old.keys()
    assert old.keys() <= current.keys()
    assert {name: current[name] for name in old} == old


def test_workflow_requests_and_serialized_responses_keep_complete_contracts(generator):
    schemas = deepcopy(generator.load_openapi()["components"]["schemas"])
    roots = generator.add_extra_pydantic_schemas(schemas)
    assert roots == {"WorkflowSimulationResponse", "WorkflowTestEmailResponse"}
    contracts = aliases(generator.render_contracts())
    for request in ("WorkflowSimulationRequest", "WorkflowTestEmailRequest"):
        assert schemas[request]["properties"]["graph"]["$ref"] == (
            "#/components/schemas/WorkflowGraph-Input"
        )
        assert "  graph: ApiWorkflowGraph_Input;" in contracts[f"Api{request}"]
    assert "WorkflowGraph" not in schemas
    for config, field in (("TriggerConfig", "offset_minutes"), ("ConditionConfig", "value")):
        for suffix in ("Input", "Output"):
            schema = schemas[f"{config}-{suffix}"]
            assert field not in schema.get("required", [])
            assert f"  {field}?:" in contracts[f"Api{config}_{suffix}"]
    assert schemas["EmailConfig-Input"]["properties"]["subject_template"]["default"] == ""
    assert "  subject_template?: string;" in contracts["ApiEmailConfig_Input"]
    assert "  subject_template: string;" in contracts["ApiEmailConfig_Output"]
    for name, nullable in (
        ("WorkflowValidationIssue", ("node_id", "edge_id", "field")),
        ("WorkflowSimulationAction", ("scheduled_at", "reason")),
        (
            "WorkflowSimulationTrace",
            (
                "edge_id",
                "reason",
                "scheduled_at",
                "action_kind",
                "rendered_subject",
                "rendered_body",
            ),
        ),
    ):
        assert set(nullable) <= set(schemas[name]["required"])
        for field in nullable:
            assert re.search(rf"  {field}: .* \| null;", contracts[f"Api{name}"])
    assert "  future_conditions_rechecked: true;" in contracts["ApiWorkflowSimulationResponse"]
    assert contracts["ApiWorkflowTestEmailResponse"] == (
        "export interface ApiWorkflowTestEmailResponse {\n"
        "  operation_id: string;\n  test_delivery_id: string;\n"
        '  state: "queued" | "sending" | "accepted" | "failed" | "unknown";\n}'
    )
    assert '  state: "queued";' in contracts["ApiWorkflowTestEmailAcknowledgment"]
    assert (
        "  result: ApiWorkflowTestEmailAcknowledgment;"
        in contracts["ApiTestEmailOperationResponse"]
    )


def test_normalized_duplicate_retains_existing_schema_and_order(generator, monkeypatch):
    model = create_model("Normalized", value=(float | None, Field(default=None, ge=0)))
    register_model(generator, monkeypatch, model)
    raw = model.model_json_schema()
    mounted = Schema.model_validate(raw).model_dump(mode="json", by_alias=True, exclude_none=True)
    assert raw != mounted
    assert raw["properties"]["value"]["default"] is None
    schemas = {"Normalized": mounted}
    before = json.dumps(mounted)
    assert generator.add_extra_pydantic_schemas(schemas) == set()
    assert schemas["Normalized"] is mounted
    assert json.dumps(schemas["Normalized"]) == before


@pytest.mark.parametrize(
    "name,path,replacement",
    [
        ("WorkflowGraph-Input", ("required",), ["nodes", "edges"]),
        ("TriggerConfig-Input", ("properties", "event_type", "anyOf"), [{"type": "string"}]),
        ("TriggerConfig-Input", ("properties", "offset_minutes", "type"), "string"),
        ("WorkflowSimulationTrace", ("properties", "outcome", "enum"), ["entered"]),
        ("WorkflowGraph-Input", ("additionalProperties",), True),
        ("TriggerConfig-Input", ("properties", "extra"), {"type": "number"}),
        ("WorkflowGraph-Input", ("properties", "schema_version", "const"), True),
        ("WorkflowGraph-Input", ("properties", "schema_version", "enum"), [True]),
    ],
)
def test_real_schema_collisions_are_rejected(generator, name, path, replacement):
    schemas = deepcopy(generator.load_openapi()["components"]["schemas"])
    generator.add_extra_pydantic_schemas(schemas)
    target = schemas[name]
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = replacement
    with pytest.raises(ValueError, match=rf"^Pydantic schema conflict: \w+ / {name}$"):
        generator.add_extra_pydantic_schemas(schemas)


@pytest.mark.parametrize("existing_only", [True, False])
def test_generated_type_name_collisions_are_rejected(generator, monkeypatch, existing_only):
    model = create_model("Collision-Name", value=(str, ...))
    register_model(generator, monkeypatch, model)
    schemas = {"Collision_Name": model.model_json_schema()}
    if existing_only:
        schemas["Collision-Name"] = deepcopy(schemas["Collision_Name"])
    with pytest.raises(ValueError, match=r"^Generated API type name conflict: ApiCollision_Name"):
        generator.add_extra_pydantic_schemas(schemas)


def test_reference_rewrite_preserves_literal_data_and_schema_keyword_property_names(generator):
    old = "#/components/schemas/Graph"
    new = "#/components/schemas/Graph-Input"
    literal = {"$ref": old, "discriminator": {"mapping": {"graph": old}}, "value": None}
    schema = {
        "$ref": old,
        "discriminator": {
            "propertyName": "kind",
            "mapping": {"graph": old, "remote": "other.json"},
        },
        "properties": {
            "default": {"$ref": old},
            "value": {
                "const": literal,
                "default": literal,
                "enum": [old, literal],
                "example": literal,
                "examples": [literal],
                "description": old,
                "x-literal": literal,
            },
        },
    }
    before = deepcopy(schema)
    rewritten = generator.rewrite_schema_refs(schema, {"Graph": "Graph-Input"})
    assert rewritten["$ref"] == new
    assert rewritten["discriminator"]["mapping"] == {"graph": new, "remote": "other.json"}
    assert rewritten["properties"]["default"] == {"$ref": new}
    assert rewritten["properties"]["value"] == before["properties"]["value"]
    assert schema == before
    for keyword in ("properties", "patternProperties", "$defs", "definitions", "dependentSchemas"):
        assert generator.rewrite_schema_refs(
            {keyword: {"item": {"$ref": old}}}, {"Graph": "Graph-Input"}
        ) == {keyword: {"item": {"$ref": new}}}
    for keyword in ("allOf", "anyOf", "oneOf", "prefixItems"):
        assert generator.rewrite_schema_refs(
            {keyword: [{"$ref": old}]}, {"Graph": "Graph-Input"}
        ) == {keyword: [{"$ref": new}]}
    for keyword in ("items", "additionalProperties", "not", "if", "then", "else"):
        assert generator.rewrite_schema_refs(
            {keyword: {"$ref": old}}, {"Graph": "Graph-Input"}
        ) == {keyword: {"$ref": new}}


def test_serialization_classification_does_not_tighten_other_extra_roots(generator, monkeypatch):
    child = create_model("DefaultedChild", value=(int, 7))
    response = create_model("ExtraResponse", child=(child, ...))
    legacy = create_model("LegacyResponse", value=(int, 7))
    request = create_model("OtherRequest", value=(int, 7))
    module = SimpleNamespace(**{model.__name__: model for model in (response, legacy, request)})
    monkeypatch.setattr(generator, "importlib", SimpleNamespace(import_module=lambda _: module))
    monkeypatch.setattr(generator, "load_openapi", dict)
    monkeypatch.setattr(
        generator,
        "EXTRA_PYDANTIC_SCHEMA_MODELS",
        (
            ("test", "ExtraResponse", "serialization"),
            ("test", "LegacyResponse", "validation"),
            ("test", "OtherRequest", "validation"),
        ),
    )
    contracts = aliases(generator.render_contracts())
    assert "  value: number;" in contracts["ApiDefaultedChild"]
    assert "  value?: number;" in contracts["ApiLegacyResponse"]
    assert "  value?: number;" in contracts["ApiOtherRequest"]


def test_actual_router_mounting_has_identical_aliases_in_an_isolated_process(generator):
    before = deepcopy(generator.load_openapi())
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import importlib.util
spec = importlib.util.spec_from_file_location("generator", "scripts/generate-api-types.py")
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
before = generator.render_contracts()
from app.main import app
from app.api.v1.endpoints import workflow_test_email
from fastapi.routing import iter_route_contexts
paths = (
    "/api/v1/automations/workflows/{workflow_id}/simulate",
    "/api/v1/automations/workflows/{workflow_id}/test-email",
    "/api/v1/automations/test-deliveries/{test_delivery_id}",
)
assert set(app.openapi()["paths"][paths[0]]) == {"post"}
assert sum(route.path == paths[0] for route in iter_route_contexts(app.routes)) == 1
assert all(path not in app.openapi()["paths"] for path in paths[1:])
app.include_router(workflow_test_email.router, prefix="/api/v1")
app.openapi_schema = None
assert all(path in app.openapi()["paths"] for path in paths)
assert generator.render_contracts() == before
assert generator.render_contracts() == before
print("Mounted aliases are byte-identical.")
""",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "Mounted aliases are byte-identical."
    assert generator.load_openapi() == before


if __name__ == "__main__":
    unittest.main()
