import json
import re
from collections.abc import Mapping
from typing import get_args

import pytest

from app.schemas.lead import LeadSource, LeadStage
from app.schemas.student import StudentStatus
from app.services.workflow_catalog import CATALOG, build_preset, get_workflow_catalog


TRIGGERS = {
    "student.enrolled": "student",
    "student.promoted": "promotion",
    "lead.created": "lead",
    "lead.stage_changed": "lead",
    "trial.scheduled": "trial",
    "trial.completed": "trial",
    "trial.no_show": "trial",
    "trial.upcoming": "trial",
    "invoice.overdue": "invoice",
    "invoice.payment_failed": "invoice",
    "belt_test.approved": "belt_test",
    "belt_test.upcoming": "belt_test",
}
PRESETS = {
    "welcome": ("student.enrolled", "trigger email end"),
    "promotion_congratulations": ("student.promoted", "trigger email end"),
    "new_lead_follow_up": ("lead.created", "trigger email delay condition lead_follow_up end"),
    "trial_reminder": ("trial.upcoming", "trigger email end"),
    "trial_completion_follow_up": (
        "trial.completed",
        "trigger delay condition email lead_follow_up end",
    ),
    "trial_no_show": ("trial.no_show", "trigger condition email lead_follow_up end"),
    "overdue_recovery": ("invoice.overdue", "trigger email delay condition email end"),
    "failed_payment_notice": ("invoice.payment_failed", "trigger condition email end"),
    "belt_test_invitation": ("belt_test.approved", "trigger email delay email end"),
}


def _assert_immutable(value):
    if isinstance(value, Mapping):
        with pytest.raises(TypeError):
            value["mutated"] = True
        for child in value.values():
            _assert_immutable(child)
    elif isinstance(value, tuple):
        if value:
            with pytest.raises(TypeError):
                value[0] = None
        for child in value:
            _assert_immutable(child)
    else:
        assert value is None or type(value) in {str, bool, int}


def _mutate_copy(value):
    if isinstance(value, dict):
        for child in list(value.values()):
            _mutate_copy(child)
        value["mutated"] = True
    elif isinstance(value, list):
        for child in value:
            _mutate_copy(child)
        value.append("mutated")


def test_catalog_is_deeply_immutable_and_snapshots_are_independent_json():
    _assert_immutable(CATALOG)
    original = get_workflow_catalog()
    snapshot = get_workflow_catalog()
    assert json.loads(json.dumps(snapshot)) == original
    _mutate_copy(snapshot)
    assert get_workflow_catalog() == original


@pytest.mark.parametrize("preset_id", PRESETS)
def test_preset_copies_are_independent_of_each_other_and_catalog(preset_id):
    original = build_preset(preset_id)
    copy = build_preset(preset_id)
    _mutate_copy(copy)
    assert build_preset(preset_id) == original
    assert (
        next(
            preset["graph"]
            for preset in get_workflow_catalog()["presets"]
            if preset["id"] == preset_id
        )
        == original
    )


def test_unknown_preset_is_rejected():
    with pytest.raises(ValueError, match="^unknown_workflow_preset$"):
        build_preset("belt_test_reminder")


def test_catalog_has_exact_locked_ids_and_value_types():
    assert set(CATALOG) == {
        "triggers",
        "fields",
        "recipients",
        "variables",
        "delay_fields",
        "presets",
    }
    assert {key: value["subject_kind"] for key, value in CATALOG["triggers"].items()} == TRIGGERS
    assert set(CATALOG["recipients"]) == {
        "student_or_guardian",
        "lead_or_guardian",
        "invoice_payer",
        "assigned_staff",
    }
    assert {key: field["value_type"] for key, field in CATALOG["fields"].items()} == {
        "student.status": "enum",
        "student.on_hold": "boolean",
        "student.is_minor": "boolean",
        "lead.stage": "enum",
        "lead.source": "enum",
        "lead.unconverted": "boolean",
        "trial.status": "enum",
        "invoice.overdue": "boolean",
        "invoice.open_balance": "boolean",
        "invoice.collection_method": "enum",
        "program.id": "uuid",
        "promotion.rank_id": "uuid",
        "belt_test.event_scheduled": "boolean",
        "belt_test.approval_current": "boolean",
    }
    assert set(CATALOG["variables"]) == {
        "studio_name",
        "recipient_name",
        "student_first_name",
        "rank_name",
        "program_name",
        "lead_first_name",
        "trial_start",
        "trial_location",
        "invoice_number",
        "invoice_balance",
        "invoice_due_date",
        "event_name",
        "event_start",
        "event_location",
    }
    for section in ("triggers", "fields", "recipients", "variables", "delay_fields"):
        for key, item in CATALOG[section].items():
            assert item["id"] == key
            assert item["label"].strip()
    for field in CATALOG["fields"].values():
        if field["value_type"] == "boolean":
            assert field["operators"] == ("eq", "neq")
        else:
            assert field["operators"] == ("eq", "neq", "in", "not_in")
        assert ("values" in field) == (field["value_type"] == "enum")
        assert field["nullable"] == (field["id"] in {"program.id", "invoice.collection_method"})
    assert CATALOG["fields"]["student.status"]["values"] == get_args(StudentStatus)
    assert CATALOG["fields"]["lead.stage"]["values"] == get_args(LeadStage)
    assert CATALOG["fields"]["lead.source"]["values"] == get_args(LeadSource)
    assert CATALOG["fields"]["trial.status"]["values"] == (
        "scheduled",
        "completed",
        "no_show",
        "canceled",
    )
    assert CATALOG["fields"]["invoice.collection_method"]["values"] == (
        "send_invoice",
        "charge_automatically",
    )


@pytest.mark.parametrize("event,kind", TRIGGERS.items())
def test_trigger_applicability(event, kind):
    trigger = CATALOG["triggers"][event]
    assert set(trigger) == {
        "id",
        "label",
        "subject_kind",
        "simulation_entity_type",
        "recipient_ids",
        "field_ids",
        "template_variables",
        "supports_offset",
        "supports_program_filter",
        "delay_fields",
        "supports_lead_follow_up",
    }
    assert trigger["supports_offset"] == (event in {"trial.upcoming", "belt_test.upcoming"})
    expected_entity_type = {
        "trial": "trial_appointment",
        "belt_test": "belt_test_recipient",
    }.get(kind, kind)
    if event == "invoice.payment_failed":
        expected_entity_type = "payment"
    assert trigger["simulation_entity_type"] == expected_entity_type
    assert trigger["supports_program_filter"] == (kind != "invoice")
    assert trigger["supports_lead_follow_up"] == (kind in {"lead", "trial"})
    assert trigger["recipient_ids"] == (
        ("lead_or_guardian", "assigned_staff")
        if kind in {"lead", "trial"}
        else ("invoice_payer",)
        if kind == "invoice"
        else ("student_or_guardian",)
    )
    expected_fields = {
        "student": {"student.status", "student.on_hold", "student.is_minor"},
        "promotion": {
            "student.status",
            "student.on_hold",
            "student.is_minor",
            "program.id",
            "promotion.rank_id",
        },
        "lead": {"lead.stage", "lead.source", "lead.unconverted", "program.id"},
        "trial": {"lead.stage", "lead.source", "lead.unconverted", "trial.status", "program.id"},
        "invoice": {"invoice.overdue", "invoice.open_balance", "invoice.collection_method"},
        "belt_test": {
            "student.status",
            "student.on_hold",
            "student.is_minor",
            "program.id",
            "belt_test.event_scheduled",
            "belt_test.approval_current",
        },
    }
    expected_variables = {
        "student": {"student_first_name"},
        "promotion": {"student_first_name", "rank_name", "program_name"},
        "lead": {"lead_first_name"},
        "trial": {"lead_first_name", "trial_start", "trial_location"},
        "invoice": {"invoice_number", "invoice_balance", "invoice_due_date"},
        "belt_test": {"student_first_name", "event_name", "event_start", "event_location"},
    }
    assert set(trigger["field_ids"]) == expected_fields[kind]
    assert (
        set(trigger["template_variables"])
        == {"studio_name", "recipient_name"} | expected_variables[kind]
    )
    assert set(trigger["field_ids"]) <= CATALOG["fields"].keys()
    assert set(trigger["template_variables"]) <= CATALOG["variables"].keys()


def test_anchors_are_available_only_for_future_scheduled_events():
    expected = {
        "trial.starts_at": ("trial.scheduled", "trial.upcoming"),
        "belt_test.starts_at": ("belt_test.approved", "belt_test.upcoming"),
    }
    assert set(CATALOG["delay_fields"]) == set(expected)
    for anchor, events in expected.items():
        assert CATALOG["delay_fields"][anchor]["trigger_ids"] == events
        assert CATALOG["delay_fields"][anchor]["value_type"] == "datetime"
    for event, trigger in CATALOG["triggers"].items():
        assert trigger["delay_fields"] == tuple(
            anchor for anchor, events in expected.items() if event in events
        )


def test_optional_display_values_have_safe_explicit_fallbacks():
    optional = {
        "recipient_name",
        "program_name",
        "trial_location",
        "invoice_number",
        "invoice_due_date",
        "event_location",
    }
    for name, variable in CATALOG["variables"].items():
        assert set(variable) == {"id", "label", "value_type", "fallback"}
        assert variable["value_type"] == "string"
        fallback = variable["fallback"]
        if name in optional:
            assert isinstance(fallback, str) and fallback.strip()
            assert not re.search(r"[{}<>\x00-\x1f]|https?://", fallback)
        else:
            assert fallback is None


def _assert_connected_paths(graph):
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert len(nodes) == len(graph["nodes"]) <= 40
    assert len({edge["id"] for edge in graph["edges"]}) == len(graph["edges"]) <= 60
    outgoing = {node_id: [] for node_id in nodes}
    starts = [node["id"] for node in nodes.values() if node["type"] == "trigger"]
    assert len(starts) == 1
    for edge in graph["edges"]:
        assert set(edge) == {"id", "source", "target", "port"}
        assert edge["source"] in nodes and edge["target"] in nodes
        assert edge["target"] != starts[0]
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", edge["id"])
        outgoing[edge["source"]].append(edge)
    reached = set()

    def walk(node_id, ancestors):
        assert node_id not in ancestors
        reached.add(node_id)
        node = nodes[node_id]
        assert set(node) == {"id", "type", "config"}
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", node_id)
        ports = sorted(edge["port"] for edge in outgoing[node_id])
        assert ports == (
            []
            if node["type"] == "end"
            else ["no", "yes"]
            if node["type"] == "condition"
            else ["next"]
        )
        for edge in outgoing[node_id]:
            walk(edge["target"], ancestors | {node_id})

    walk(starts[0], set())
    assert reached == set(nodes)


@pytest.mark.parametrize("preset_id", PRESETS)
def test_presets_are_complete_applicable_graphs(preset_id):
    graph = build_preset(preset_id)
    event, node_types = PRESETS[preset_id]
    assert set(graph) == {"schema_version", "nodes", "edges"}
    assert graph["schema_version"] == 1
    assert [node["type"] for node in graph["nodes"]] == node_types.split()
    _assert_connected_paths(graph)
    trigger = CATALOG["triggers"][event]
    assert graph["nodes"][0]["config"] == {
        "event_type": event,
        "program_id": None,
        **({"offset_minutes": -1440} if preset_id == "trial_reminder" else {}),
    }
    for node in graph["nodes"]:
        config = node["config"]
        if node["type"] == "email":
            assert set(config) == {
                "recipient",
                "subject_template",
                "body_template",
                "reply_to_email",
            }
            assert config["recipient"] == trigger["recipient_ids"][0]
            assert config["reply_to_email"] == ""
            subject, body = config["subject_template"], config["body_template"]
            assert 0 < len(subject) <= 200 and 0 < len(body) <= 5000
            assert not re.search(r"[\x00-\x1f\x7f-\x9f]", subject)
            assert not re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", body)
            for template in (subject, body):
                tokens = re.findall(r"\{\{([a-z_]+)\}\}", template)
                assert set(tokens) <= set(trigger["template_variables"])
                assert not re.search(r"[{}<>]|https?://", re.sub(r"\{\{[a-z_]+\}\}", "", template))
        elif node["type"] == "condition":
            assert set(config) == {"field", "operator", "value"}
            assert config["field"] in trigger["field_ids"]
            assert config["operator"] == "eq" and config["value"] is True
        elif node["type"] == "lead_follow_up":
            assert trigger["supports_lead_follow_up"]
            assert set(config) == {"due_in_days", "note"}
            assert config["due_in_days"] == 0 and 0 < len(config["note"]) <= 1000
        elif node["type"] == "end":
            assert config == {}


def test_preset_delays_and_condition_fields_match_the_promised_behavior():
    assert {preset["id"] for preset in CATALOG["presets"]} == set(PRESETS)
    assert len(CATALOG["presets"]) == len(PRESETS)
    delays = {}
    conditions = {}
    for preset_id in PRESETS:
        graph = build_preset(preset_id)
        for node in graph["nodes"]:
            if node["type"] == "delay":
                delays[preset_id] = node["config"]
            elif node["type"] == "condition":
                conditions[preset_id] = node["config"]["field"]
    assert delays == {
        "new_lead_follow_up": {"mode": "duration", "minutes": 2880},
        "trial_completion_follow_up": {"mode": "duration", "minutes": 1440},
        "overdue_recovery": {"mode": "duration", "minutes": 4320},
        "belt_test_invitation": {
            "mode": "until",
            "field": "belt_test.starts_at",
            "offset_minutes": -1440,
        },
    }
    assert conditions == {
        "new_lead_follow_up": "lead.unconverted",
        "trial_completion_follow_up": "lead.unconverted",
        "trial_no_show": "lead.unconverted",
        "overdue_recovery": "invoice.overdue",
        "failed_payment_notice": "invoice.open_balance",
    }


@pytest.mark.parametrize(
    "preset_id,token", [("trial_reminder", "trial_start"), ("belt_test_invitation", "event_start")]
)
def test_pre_event_copy_uses_the_actual_start(preset_id, token):
    emails = [
        node["config"] for node in build_preset(preset_id)["nodes"] if node["type"] == "email"
    ]
    for email in emails:
        assert "{{" + token + "}}" in email["body_template"]
        assert "tomorrow" not in email["body_template"].lower()
