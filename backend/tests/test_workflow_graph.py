"""Graph validation uses synthetic catalogs and never contacts a service."""

from copy import deepcopy
from decimal import Decimal
from itertools import pairwise
from types import MappingProxyType

import pytest
from pydantic import ValidationError

from app.schemas.workflow import WorkflowGraph, WorkflowLayout
from app.services.workflow_graph import validate_workflow_draft, validate_workflow_graph

UUID = "c7b7167e-6dc0-442d-8672-e7df7a4e0d9e"


def freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(freeze(item) for item in value)
    return value


@pytest.fixture
def catalog():
    fields = {
        "sample.text": {"value_type": "string", "operators": ["eq", "neq"]},
        "sample.number": {
            "value_type": "number",
            "operators": ["eq", "neq", "gt", "gte", "lt", "lte"],
        },
        "sample.boolean": {"value_type": "boolean", "operators": ["eq", "neq"]},
        "sample.enum": {
            "value_type": "enum",
            "operators": ["eq", "neq", "in", "not_in"],
            "values": ["open", "closed"],
        },
        "sample.uuid": {
            "value_type": "uuid",
            "operators": ["eq", "neq", "in", "not_in"],
            "nullable": True,
        },
        "sample.datetime": {
            "value_type": "datetime",
            "operators": ["eq", "neq", "gt", "gte", "lt", "lte"],
        },
        "other.text": {"value_type": "string", "operators": ["eq", "neq"]},
    }
    triggers = {}
    for trigger_id, subject, offset in (
        ("sample.created", "lead", False),
        ("sample.upcoming", "trial", True),
        ("other.created", "invoice", False),
    ):
        other = trigger_id == "other.created"
        triggers[trigger_id] = {
            "id": trigger_id,
            "subject_kind": subject,
            "recipient_ids": ["other_contact"] if other else ["sample_contact"],
            "field_ids": ["other.text"]
            if other
            else [name for name in fields if name.startswith("sample.")],
            "template_variables": ["studio_name", "other_name"]
            if other
            else ["studio_name", "sample_name"],
            "supports_offset": offset,
            "supports_program_filter": not other,
            "delay_fields": ["sample.starts_at"] if offset else [],
            "supports_lead_follow_up": not other,
        }
    return freeze(
        {
            "triggers": triggers,
            "fields": fields,
            "recipients": {"sample_contact": {}, "other_contact": {}},
            "variables": {"studio_name": {}, "sample_name": {}, "other_name": {}},
            "delay_fields": {"sample.starts_at": {"trigger_ids": ["sample.upcoming"]}},
        }
    )


def node(identifier, kind, **config):
    return {"id": identifier, "type": kind, "config": config}


def edge(identifier, source, target, port="next"):
    return {"id": identifier, "source": source, "target": target, "port": port}


def graph(*middle, trigger="sample.created"):
    nodes = [node("start", "trigger", event_type=trigger), *middle, node("end", "end")]
    return {
        "schema_version": 1,
        "nodes": nodes,
        "edges": [
            edge(f"e{index}", source["id"], target["id"])
            for index, (source, target) in enumerate(pairwise(nodes))
        ],
    }


def email(**overrides):
    return node(
        "mail",
        "email",
        **{
            "recipient": "sample_contact",
            "subject_template": "Hello {{sample_name}}",
            "body_template": "Welcome to {{studio_name}}.\nA & B <plain text>",
            "reply_to_email": "",
            **overrides,
        },
    )


def condition(field="sample.number", operator="gte", value=2):
    result = graph(node("check", "condition", field=field, operator=operator, value=value), email())
    result["edges"] = [
        edge("first", "start", "check"),
        edge("yes", "check", "mail", "yes"),
        edge("no", "check", "end", "no"),
        edge("finish", "mail", "end"),
    ]
    return result


def codes(result):
    return {issue.code for issue in result.issues}


def test_complete_branch_delay_follow_up_and_email(catalog):
    draft = condition()
    draft["nodes"][0]["config"] = {
        "event_type": "sample.upcoming",
        "program_id": UUID,
        "offset_minutes": -1440,
    }
    draft["nodes"].extend(
        [
            node("wait", "delay", mode="until", field="sample.starts_at", offset_minutes=-60),
            node("duration", "delay", mode="duration", minutes=0),
            node("follow", "lead_follow_up", due_in_days=0, note=""),
        ]
    )
    draft["edges"][-1] = edge("finish", "mail", "wait")
    draft["edges"].extend(
        [
            edge("wait_next", "wait", "duration"),
            edge("duration_next", "duration", "follow"),
            edge("follow_next", "follow", "end"),
        ]
    )
    layout = {"positions": {"start": {"x": -100000, "y": 100000}, "mail": {"x": 1.5, "y": 0}}}
    original = deepcopy((draft, layout))
    assert validate_workflow_graph(draft, catalog=catalog, layout=layout).valid
    assert validate_workflow_graph(
        WorkflowGraph.model_validate(draft),
        catalog=catalog,
        layout=WorkflowLayout.model_validate(layout),
    ).valid
    assert (draft, layout) == original


def test_simple_graph_and_serialized_model_round_trip(catalog):
    model = WorkflowGraph.model_validate(graph(email()))
    assert "offset_minutes" not in model.model_dump()["nodes"][0]["config"]
    assert validate_workflow_graph(model, catalog=catalog).valid
    assert validate_workflow_graph(model.model_dump(), catalog=catalog).valid


def test_draft_accepts_incomplete_disconnected_cyclic_nodes(catalog):
    draft = graph(
        node("check", "condition"),
        node("wait", "delay", mode="duration"),
        node("follow", "lead_follow_up"),
        node("mail", "email"),
        trigger=None,
    )
    draft["edges"] = [edge("loop", "wait", "wait")]
    WorkflowGraph.model_validate(draft)
    assert validate_workflow_draft(draft, catalog=catalog).valid
    result = validate_workflow_graph(draft, catalog=catalog)
    assert {
        "incomplete_config",
        "cycle",
        "unreachable_node",
        "no_path_to_end",
        "invalid_outgoing_ports",
    } <= codes(result)


def test_empty_draft_and_missing_positions(catalog):
    draft = {"schema_version": 1, "nodes": [], "edges": []}
    assert validate_workflow_draft(draft, catalog=catalog, layout={"positions": {}}).valid
    assert {"trigger_count", "end_required"} <= codes(
        validate_workflow_graph(draft, catalog=catalog)
    )
    assert validate_workflow_graph(graph(), catalog=catalog, layout={"positions": {}}).valid


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda g: g["nodes"].append(node("orphan", "end")), "unreachable_node"),
        (
            lambda g: g["nodes"].append(
                node("extra_trigger", "trigger", event_type="sample.created")
            ),
            "trigger_count",
        ),
        (lambda g: g["edges"].append(edge("back", "end", "start")), "incoming_trigger_edge"),
        (lambda g: g["edges"].append(edge("back", "end", "start")), "outgoing_end_edge"),
        (
            lambda g: g["edges"].append(edge("duplicate_output", "start", "end")),
            "invalid_edge_port",
        ),
        (lambda g: g["edges"][0].update(port="yes"), "invalid_edge_port"),
        (lambda g: g["edges"].clear(), "no_path_to_end"),
    ],
)
def test_executable_topology(catalog, mutate, expected):
    draft = graph()
    mutate(draft)
    assert expected in codes(validate_workflow_graph(draft, catalog=catalog))


def test_each_condition_branch_must_reach_end(catalog):
    draft = condition()
    draft["nodes"].append(node("dead_end", "delay", mode="duration", minutes=10))
    draft["edges"][2]["target"] = "dead_end"
    result = validate_workflow_graph(draft, catalog=catalog)
    assert any(
        issue.code == "no_path_to_end" and issue.node_id == "dead_end" for issue in result.issues
    )
    draft["edges"][2]["port"] = "yes"
    assert "invalid_outgoing_ports" in codes(validate_workflow_graph(draft, catalog=catalog))


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda g: g["nodes"].append(deepcopy(g["nodes"][0])), "duplicate_node_id"),
        (lambda g: g["edges"].append(deepcopy(g["edges"][0])), "duplicate_edge_id"),
        (lambda g: g["edges"][0].update(source="missing"), "unknown_node"),
        (lambda g: g["edges"][0].update(target="missing"), "unknown_node"),
        (lambda g: g["nodes"][0].update(id="invalid space"), "invalid_id"),
        (lambda g: g["edges"][0].update(id=""), "invalid_id"),
        (lambda g: g["nodes"][0].update(id="é"), "invalid_id"),
        (lambda g: g["nodes"][0].update(id="x" * 65), "out_of_bounds"),
        (lambda g: g["nodes"].extend(node(f"end{i}", "end") for i in range(39)), "out_of_bounds"),
        (
            lambda g: g["edges"].extend(edge(f"edge{i}", "start", "end") for i in range(60)),
            "out_of_bounds",
        ),
        (lambda g: g.update(schema_version=True), "unsupported_schema_version"),
        (lambda g: g.update(schema_version="1"), "unsupported_schema_version"),
        (lambda g: g.update(schema_version=2), "unsupported_schema_version"),
        (lambda g: g["nodes"][0].update(type="code"), "unknown_type"),
        (lambda g: g["nodes"][0]["config"].update(sql="select *"), "unknown_field"),
        (lambda g: g["nodes"][-1]["config"].update(secret="must not echo"), "unknown_field"),
        (lambda g: g["edges"][0].update(port="source_port"), "invalid_structure"),
        (lambda g: g["edges"][0].update(source_port="next"), "unknown_field"),
        (lambda g: g.update(viewport={}), "unknown_field"),
    ],
)
def test_unsafe_structure_never_saves(catalog, mutate, expected):
    draft = graph()
    mutate(draft)
    for validate in (validate_workflow_draft, validate_workflow_graph):
        assert expected in codes(validate(draft, catalog=catalog))


@pytest.mark.parametrize(
    "kind,config",
    [
        ("trigger", {"event_type": "sample.upcoming", "offset_minutes": True}),
        ("trigger", {"event_type": "sample.upcoming", "offset_minutes": None}),
        ("trigger", {"event_type": "sample.upcoming", "offset_minutes": -129601}),
        ("trigger", {"event_type": "sample.upcoming", "offset_minutes": 1}),
        ("trigger", {"event_type": "sample.upcoming", "offset_minutes": 0}),
        ("trigger", {"event_type": "sample.created", "program_id": "bad"}),
        ("trigger", {"event_type": "sample.created", "program_id": ""}),
        ("trigger", {"event_type": "sample.created", "program_id": " "}),
        ("trigger", {"event_type": "sample.created", "program_id": 1}),
        ("delay", {"mode": "duration", "minutes": True}),
        ("delay", {"mode": "duration", "minutes": -1}),
        ("delay", {"mode": "duration", "minutes": 129601}),
        ("delay", {"mode": "duration", "minutes": "2"}),
        ("delay", {"mode": "until", "field": "sample.starts_at", "offset_minutes": None}),
        ("delay", {"mode": "until", "field": "sample.starts_at", "offset_minutes": 129601}),
        ("delay", {"mode": "until", "field": "sample.starts_at", "offset_minutes": -129601}),
        ("delay", {"mode": "duration", "minutes": 1, "field": "sample.starts_at"}),
        ("delay", {"mode": "until", "field": "sample.starts_at", "minutes": 1}),
        ("lead_follow_up", {"due_in_days": True}),
        ("lead_follow_up", {"due_in_days": -1}),
        ("lead_follow_up", {"due_in_days": 91}),
        ("lead_follow_up", {"due_in_days": 1, "note": "x" * 1001}),
        ("email", {"subject_template": "x" * 201}),
        ("email", {"body_template": "x" * 5001}),
        ("email", {"reply_to_email": "x" * 255}),
        ("condition", {"field": "sample.text", "value": "x" * 501}),
        ("condition", {"field": "sample.enum", "operator": "in", "value": ["open"] * 101}),
        ("condition", {"value": {"code": "arbitrary"}}),
        ("condition", {"value": [[1]]}),
        ("condition", {"value": float("nan")}),
        ("condition", {"value": float("inf")}),
        ("condition", {"value": -float("inf")}),
        ("condition", {"value": [float("nan")]}),
        ("condition", {"value": Decimal("1.2")}),
        ("condition", {"value": [Decimal("1.2")]}),
    ],
)
def test_config_bounds_and_types(catalog, kind, config):
    draft = graph(node("invalid", kind, **config), trigger=None)
    assert not validate_workflow_draft(draft, catalog=catalog).valid
    with pytest.raises(ValidationError):
        WorkflowGraph.model_validate(draft)


@pytest.mark.parametrize(
    "layout",
    [
        {"positions": {"start": {"x": True, "y": 0}}},
        {"positions": {"start": {"x": "1", "y": 0}}},
        {"positions": {"start": {"x": Decimal("1.2"), "y": 0}}},
        {"positions": {"start": {"x": float("nan"), "y": 0}}},
        {"positions": {"start": {"x": float("inf"), "y": 0}}},
        {"positions": {"start": {"x": -100001, "y": 0}}},
        {"positions": {"start": {"x": 0, "y": 100001}}},
        {"positions": {"missing": {"x": 0, "y": 0}}},
        {"positions": {"bad id": {"x": 0, "y": 0}}},
        {"positions": {"start": {"x": 0, "y": 0, "selected": True}}},
        {"positions": {}, "zoom": 1},
    ],
)
def test_invalid_layout_never_saves(catalog, layout):
    assert not validate_workflow_draft(graph(), catalog=catalog, layout=layout).valid


@pytest.mark.parametrize(
    "field,operator,value",
    [
        ("sample.text", "eq", "hello"),
        ("sample.text", "neq", ""),
        ("sample.number", "gt", 1),
        ("sample.number", "lte", 2.5),
        ("sample.boolean", "eq", True),
        ("sample.enum", "neq", "open"),
        ("sample.enum", "in", ["open", "closed"]),
        ("sample.enum", "not_in", ["closed"]),
        ("sample.uuid", "eq", UUID),
        ("sample.uuid", "in", [UUID]),
        ("sample.uuid", "eq", None),
        ("sample.uuid", "neq", None),
        ("sample.datetime", "gte", "2026-10-05T12:30:00Z"),
        ("sample.datetime", "lt", "2026-10-05T12:30:00.123-07:00"),
    ],
)
def test_catalog_condition_types(catalog, field, operator, value):
    assert validate_workflow_graph(condition(field, operator, value), catalog=catalog).valid


@pytest.mark.parametrize(
    "field,operator,value",
    [
        ("sample.text", "gt", "hello"),
        ("sample.text", "eq", 1),
        ("sample.text", "eq", True),
        ("sample.number", "eq", True),
        ("sample.number", "gt", "1"),
        ("sample.boolean", "eq", 1),
        ("sample.boolean", "eq", "true"),
        ("sample.boolean", "gt", True),
        ("sample.enum", "eq", "missing"),
        ("sample.enum", "eq", ["open"]),
        ("sample.enum", "in", []),
        ("sample.enum", "in", "open"),
        ("sample.enum", "not_in", ["unknown"]),
        ("sample.uuid", "in", ["broken"]),
        ("sample.uuid", "eq", "12345"),
        ("sample.number", "in", [1, 2]),
        ("sample.datetime", "eq", "2026-02-30T12:00:00Z"),
        ("sample.datetime", "eq", "2026-10-05"),
        ("sample.datetime", "eq", "2026-10-05T12:00:00"),
        ("sample.datetime", "eq", 1791220000),
        ("sample.datetime", "eq", "2026-10-05T12:00:00+24:00"),
        ("sample.datetime", "eq", "2026-10-05T12:00:00+12:99"),
        ("sample.number", "evaluate", 1),
        ("other.text", "eq", "hello"),
        ("unknown.field", "eq", "hello"),
    ],
)
def test_invalid_condition_choices_never_save(catalog, field, operator, value):
    assert not validate_workflow_draft(condition(field, operator, value), catalog=catalog).valid


def test_null_and_missing_values_respect_nullable_metadata(catalog):
    for field, operator in (("sample.number", "eq"), ("sample.uuid", "in"), ("sample.uuid", "gt")):
        draft = condition(field, operator, None)
        assert not validate_workflow_graph(draft, catalog=catalog).valid
    draft = condition("sample.uuid", "eq", None)
    del draft["nodes"][1]["config"]["value"]
    assert validate_workflow_draft(draft, catalog=catalog).valid
    assert "incomplete_config" in codes(validate_workflow_graph(draft, catalog=catalog))
    model = WorkflowGraph.model_validate(draft)
    assert "value" not in model.model_dump()["nodes"][1]["config"]
    assert "incomplete_config" in codes(validate_workflow_graph(model, catalog=catalog))
    assert "incomplete_config" in codes(
        validate_workflow_graph(model.model_dump(), catalog=catalog)
    )
    draft["nodes"][1]["config"].update(operator="in", value=[None])
    assert not validate_workflow_draft(draft, catalog=catalog).valid


@pytest.mark.parametrize(
    "middle",
    [
        email(recipient="other_contact"),
        email(recipient="someone@example.com"),
        email(subject_template="{{other_name}}"),
        email(body_template="{{unknown_variable}}"),
        node("wait", "delay", mode="until", field="sample.starts_at"),
        node("wait", "delay", mode="until", field="arbitrary.url"),
    ],
)
def test_trigger_specific_catalog_choices_apply_to_drafts(catalog, middle):
    assert not validate_workflow_draft(graph(middle), catalog=catalog).valid


def test_trigger_offset_program_filter_and_action_applicability(catalog):
    draft = graph()
    draft["nodes"][0]["config"]["offset_minutes"] = -1
    assert "trigger_incompatible" in codes(validate_workflow_draft(draft, catalog=catalog))
    draft = graph(trigger="other.created")
    draft["nodes"][0]["config"]["program_id"] = UUID
    assert "trigger_incompatible" in codes(validate_workflow_draft(draft, catalog=catalog))
    draft = graph(node("follow", "lead_follow_up", due_in_days=1), trigger="other.created")
    assert "trigger_incompatible" in codes(validate_workflow_draft(draft, catalog=catalog))
    assert validate_workflow_draft(
        graph(email(subject_template="{{other_name}}"), trigger=None), catalog=catalog
    ).valid


def test_upcoming_offset_is_explicit_and_survives_serialization(catalog):
    draft = graph(trigger="sample.upcoming")
    model = WorkflowGraph.model_validate(draft)
    assert "offset_minutes" not in model.model_dump()["nodes"][0]["config"]
    for candidate in (draft, model, model.model_dump()):
        assert validate_workflow_draft(candidate, catalog=catalog).valid
        assert "incomplete_config" in codes(validate_workflow_graph(candidate, catalog=catalog))
    for offset in (-1, -129600):
        draft["nodes"][0]["config"]["offset_minutes"] = offset
        model = WorkflowGraph.model_validate(draft)
        assert model.model_dump()["nodes"][0]["config"]["offset_minutes"] == offset
        assert validate_workflow_graph(model, catalog=catalog).valid


@pytest.mark.parametrize(
    "text",
    [
        "{{sample_name.upper()}}",
        "{{ sample_name }}",
        "{{sample_name|safe}}",
        "{{__import__('os')}}",
        "{sample_name}",
        "{{sample_name}",
        "{{{sample_name}}}",
        "plain }",
        "{% execute %}",
        "bad\x00text",
        "bad\rtext",
        "bad\x85text",
    ],
)
def test_malformed_templates_never_save(catalog, text):
    for field in ("subject_template", "body_template"):
        assert "invalid_template" in codes(
            validate_workflow_draft(graph(email(**{field: text})), catalog=catalog)
        )


def test_subject_controls_and_plain_text_are_preserved(catalog):
    draft = graph(email(subject_template="Line\nBreak"))
    assert "invalid_template" in codes(validate_workflow_draft(draft, catalog=catalog))
    body = '<script>plain text</script> & "quoted"\n\ttab'
    draft = graph(email(body_template=body, reply_to_email=" STAFF@Example.COM "))
    model = WorkflowGraph.model_validate(draft)
    assert model.nodes[1].config.body_template == body
    assert model.nodes[1].config.reply_to_email == "staff@example.com"
    assert validate_workflow_graph(draft, catalog=catalog).valid
    assert draft["nodes"][1]["config"]["reply_to_email"] == " STAFF@Example.COM "


@pytest.mark.parametrize(
    "reply_to",
    [
        "Name <person@example.com>",
        "person@example.com\r\nBcc: victim@example.com",
        "a@example.com,b@example.com",
        "a@localhost",
        "é@example.com",
        "a..b@example.com",
        "\t",
        "\n",
    ],
)
def test_invalid_reply_to_never_saves(catalog, reply_to):
    assert "invalid_email" in codes(
        validate_workflow_draft(graph(email(reply_to_email=reply_to)), catalog=catalog)
    )


@pytest.mark.parametrize("reply_to", ["", "   "])
def test_blank_reply_to_uses_sender_default(catalog, reply_to):
    assert validate_workflow_graph(graph(email(reply_to_email=reply_to)), catalog=catalog).valid


@pytest.mark.parametrize("raw", [None, [], 1, "secret-like value", {"nodes": None, "edges": None}])
def test_malformed_raw_objects_return_issues(catalog, raw):
    result = validate_workflow_graph(raw, catalog=catalog)
    assert not result.valid
    assert result.issues


def test_model_mutation_is_revalidated(catalog):
    model = WorkflowGraph.model_validate(graph())
    model.nodes[0].config.event_type = "arbitrary"
    assert "unknown_catalog_choice" in codes(validate_workflow_draft(model, catalog=catalog))
    model.schema_version = True
    assert "unsupported_schema_version" in codes(validate_workflow_graph(model, catalog=catalog))


def test_issues_are_stable_located_and_do_not_echo_payload_values(catalog):
    draft = graph(email(reply_to_email="secret-key=do-not-echo"))
    draft["nodes"][0]["config"]["offset_minutes"] = True
    result = validate_workflow_graph(draft, catalog=catalog)
    assert result == validate_workflow_graph(deepcopy(draft), catalog=catalog)
    assert any(
        issue.node_id == "mail" and issue.field == "config.reply_to_email"
        for issue in result.issues
    )
    assert any(
        issue.node_id == "start" and issue.field == "config.offset_minutes"
        for issue in result.issues
    )
    assert "do-not-echo" not in result.model_dump_json()
    for issue in result.model_dump()["issues"]:
        assert set(issue) == {"code", "message", "node_id", "edge_id", "field"}
    draft = graph()
    draft["edges"][0]["port"] = "secret-port"
    result = validate_workflow_graph(draft, catalog=catalog)
    assert any(issue.edge_id == "e0" and issue.field == "port" for issue in result.issues)
    draft["edges"][0]["secret-key"] = "secret-value"
    assert "secret" not in validate_workflow_graph(draft, catalog=catalog).model_dump_json()
