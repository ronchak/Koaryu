"""Pure, deterministic safety and executable validation for workflow drafts."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from app.schemas.workflow import (
    WorkflowGraph,
    WorkflowLayout,
    WorkflowValidationIssue,
    WorkflowValidationResult,
    is_workflow_id,
)

_TOKEN = re.compile(r"\{\{([a-z][a-z0-9_]*)\}\}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_BODY_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
_OPERATORS = frozenset(("eq", "neq", "gt", "gte", "lt", "lte", "in", "not_in"))
_ORDERING = frozenset(("gt", "gte", "lt", "lte"))
_MEMBERSHIP = frozenset(("in", "not_in"))
_FIELDS = frozenset(
    (
        "schema_version",
        "nodes",
        "edges",
        "id",
        "type",
        "config",
        "source",
        "target",
        "port",
        "event_type",
        "program_id",
        "offset_minutes",
        "field",
        "operator",
        "value",
        "mode",
        "minutes",
        "recipient",
        "subject_template",
        "body_template",
        "reply_to_email",
        "due_in_days",
        "note",
        "positions",
        "x",
        "y",
    )
)


def validate_workflow_graph(
    graph: WorkflowGraph | object,
    *,
    catalog: Mapping[str, Any],
    layout: WorkflowLayout | object | None = None,
) -> WorkflowValidationResult:
    """Validate all requirements for execution without mutating the supplied graph."""
    return _validate(graph, catalog=catalog, layout=layout, executable=True)


def validate_workflow_draft(
    graph: WorkflowGraph | object,
    *,
    catalog: Mapping[str, Any],
    layout: WorkflowLayout | object | None = None,
) -> WorkflowValidationResult:
    """Check saveable data and catalog choices while permitting unfinished topology."""
    return _validate(graph, catalog=catalog, layout=layout, executable=False)


def _issue(
    issues: list[WorkflowValidationIssue],
    code: str,
    message: str,
    *,
    node_id: str | None = None,
    edge_id: str | None = None,
    field: str | None = None,
) -> None:
    issues.append(
        WorkflowValidationIssue(
            code=code, message=message, node_id=node_id, edge_id=edge_id, field=field
        )
    )


def _shape_issues(
    exc: ValidationError, raw: object, *, layout: bool
) -> list[WorkflowValidationIssue]:
    issues: list[WorkflowValidationIssue] = []
    if isinstance(raw, (WorkflowGraph, WorkflowLayout)):
        raw = raw.model_dump()
    for error in exc.errors(include_url=False, include_input=False):
        loc = error["loc"]
        node_id = edge_id = None
        start = 0
        if (
            not layout
            and len(loc) >= 2
            and loc[0] in {"nodes", "edges"}
            and isinstance(loc[1], int)
        ):
            items = raw.get(loc[0], []) if isinstance(raw, Mapping) else []
            item = (
                items[loc[1]] if isinstance(items, (list, tuple)) and loc[1] < len(items) else None
            )
            identifier = item.get("id") if isinstance(item, Mapping) else None
            if is_workflow_id(identifier):
                if loc[0] == "nodes":
                    node_id = identifier
                else:
                    edge_id = identifier
            start = 2
        if layout and len(loc) >= 2 and loc[0] == "positions":
            node_id = loc[1] if is_workflow_id(loc[1]) else None
            start = 2
        # Only schema-owned field names can enter diagnostics, never arbitrary payload keys.
        path = [part for part in loc[start:] if isinstance(part, str) and part in _FIELDS]
        field = ".".join(path) or ("positions" if layout else None)
        kind = error["type"]
        code, message = "invalid_structure", "Use the supported workflow data format."
        if kind == "extra_forbidden":
            code, message = "unknown_field", "Remove unsupported workflow fields."
        elif kind == "union_tag_invalid":
            code, message = "unknown_type", "Select a supported node or delay type."
        elif kind == "union_tag_not_found" or kind == "missing":
            code, message = "missing_field", "Include the required workflow field."
        elif kind in {"invalid_uuid", "invalid_email", "invalid_type"}:
            code = kind
            message = {
                "invalid_uuid": "Select a valid program identifier.",
                "invalid_email": "Enter one valid reply-to email address.",
                "invalid_type": "Use the required value type.",
            }[kind]
        elif kind in {
            "too_long",
            "string_too_long",
            "greater_than_equal",
            "less_than_equal",
            "finite_number",
        }:
            code, message = "out_of_bounds", "Keep this value within the supported bounds."
        elif kind in {"string_pattern_mismatch", "string_too_short"}:
            code, message = (
                "invalid_id",
                "Use an identifier with 1 to 64 letters, numbers, underscores or hyphens.",
            )
        elif kind.endswith(("_type", "_parsing")):
            code, message = "invalid_type", "Use the required value type."
        if field == "schema_version":
            code, message = "unsupported_schema_version", "Use workflow schema version 1."
        _issue(issues, code, message, node_id=node_id, edge_id=edge_id, field=field)
    return issues


def _validate(
    raw_graph: object,
    *,
    catalog: Mapping[str, Any],
    layout: object | None,
    executable: bool,
) -> WorkflowValidationResult:
    issues: list[WorkflowValidationIssue] = []
    graph = parsed_layout = None
    try:
        graph = WorkflowGraph.model_validate(raw_graph)
    except ValidationError as exc:
        issues.extend(_shape_issues(exc, raw_graph, layout=False))
    if layout is not None:
        try:
            parsed_layout = WorkflowLayout.model_validate(layout)
        except ValidationError as exc:
            issues.extend(_shape_issues(exc, layout, layout=True))
    if graph is not None:
        structure_safe = _references(graph, parsed_layout, issues)
        _configs(graph, catalog, issues, executable=executable)
        if executable and structure_safe:
            _topology(graph, issues)
    # Sorting and deduplication make diagnostics independent of traversal/set order.
    unique = {
        (item.node_id, item.edge_id, item.field, item.code, item.message): item for item in issues
    }
    ordered = [
        unique[key] for key in sorted(unique, key=lambda key: tuple(part or "" for part in key))
    ]
    return WorkflowValidationResult(valid=not ordered, issues=ordered)


def _references(
    graph: WorkflowGraph,
    layout: WorkflowLayout | None,
    issues: list[WorkflowValidationIssue],
) -> bool:
    safe = True
    nodes = {node.id for node in graph.nodes}
    for kind, items in (("node", graph.nodes), ("edge", graph.edges)):
        for identifier, count in sorted(Counter(item.id for item in items).items()):
            if count > 1:
                safe = False
                _issue(
                    issues,
                    f"duplicate_{kind}_id",
                    f"Each {kind} needs a unique identifier.",
                    node_id=identifier if kind == "node" else None,
                    edge_id=identifier if kind == "edge" else None,
                    field="id",
                )
    for edge in graph.edges:
        for field in ("source", "target"):
            if getattr(edge, field) not in nodes:
                safe = False
                _issue(
                    issues,
                    "unknown_node",
                    "Connect this edge to an existing node.",
                    edge_id=edge.id,
                    field=field,
                )
    if layout:
        for node_id in sorted(layout.positions):
            if node_id not in nodes:
                _issue(
                    issues,
                    "unknown_layout_node",
                    "Only existing nodes can have saved positions.",
                    node_id=node_id,
                    field="positions",
                )
    return safe


def _blank(value: object) -> bool:
    return value is None or isinstance(value, str) and not value.strip()


def _configs(
    graph: WorkflowGraph,
    catalog: Mapping[str, Any],
    issues: list[WorkflowValidationIssue],
    *,
    executable: bool,
) -> None:
    selected_triggers = [
        catalog["triggers"][node.config.event_type]
        for node in graph.nodes
        if node.type == "trigger" and node.config.event_type in catalog["triggers"]
    ]

    def choice(
        node_id: str, value: str | None, group: str, field: str, applicability: str | None = None
    ) -> bool:
        if _blank(value):
            if executable:
                _issue(
                    issues,
                    "incomplete_config",
                    "Choose a value before running this workflow.",
                    node_id=node_id,
                    field=field,
                )
            return False
        if value not in catalog[group]:
            _issue(
                issues,
                "unknown_catalog_choice",
                "Choose a supported catalog value.",
                node_id=node_id,
                field=field,
            )
            return False
        if applicability and any(
            value not in trigger[applicability] for trigger in selected_triggers
        ):
            _issue(
                issues,
                "trigger_incompatible",
                "This choice is unavailable for the selected trigger.",
                node_id=node_id,
                field=field,
            )
        return True

    for node in graph.nodes:
        config = node.config
        if node.type == "trigger":
            known = choice(node.id, config.event_type, "triggers", "config.event_type")
            if known:
                trigger = catalog["triggers"][config.event_type]
                if "offset_minutes" in config.model_fields_set and not trigger["supports_offset"]:
                    _issue(
                        issues,
                        "trigger_incompatible",
                        "This trigger does not support an offset.",
                        node_id=node.id,
                        field="config.offset_minutes",
                    )
                if (
                    executable
                    and trigger["supports_offset"]
                    and "offset_minutes" not in config.model_fields_set
                ):
                    _issue(
                        issues,
                        "incomplete_config",
                        "Choose when this trigger runs before the event.",
                        node_id=node.id,
                        field="config.offset_minutes",
                    )
                if not _blank(config.program_id) and not trigger["supports_program_filter"]:
                    _issue(
                        issues,
                        "trigger_incompatible",
                        "This trigger does not support a program filter.",
                        node_id=node.id,
                        field="config.program_id",
                    )
        elif node.type == "condition":
            known = choice(node.id, config.field, "fields", "config.field", "field_ids")
            if _blank(config.operator):
                if executable:
                    _issue(
                        issues,
                        "incomplete_config",
                        "Choose a comparison operator.",
                        node_id=node.id,
                        field="config.operator",
                    )
            elif config.operator not in _OPERATORS:
                _issue(
                    issues,
                    "unknown_operator",
                    "Choose a supported comparison operator.",
                    node_id=node.id,
                    field="config.operator",
                )
            if known:
                _condition(
                    node.id, config, catalog["fields"][config.field], issues, executable=executable
                )
            elif executable and _blank(config.value):
                _issue(
                    issues,
                    "incomplete_config",
                    "Enter a comparison value.",
                    node_id=node.id,
                    field="config.value",
                )
        elif node.type == "email":
            choice(node.id, config.recipient, "recipients", "config.recipient", "recipient_ids")
            for field in ("subject_template", "body_template"):
                template = getattr(config, field)
                _template(
                    node.id,
                    field,
                    template,
                    catalog,
                    selected_triggers,
                    issues,
                    executable=executable,
                )
        elif node.type == "delay":
            if config.mode == "duration":
                if executable and config.minutes is None:
                    _issue(
                        issues,
                        "incomplete_config",
                        "Choose a delay duration.",
                        node_id=node.id,
                        field="config.minutes",
                    )
            else:
                known = choice(
                    node.id, config.field, "delay_fields", "config.field", "delay_fields"
                )
                if known and any(
                    trigger["id"] not in catalog["delay_fields"][config.field]["trigger_ids"]
                    for trigger in selected_triggers
                ):
                    _issue(
                        issues,
                        "trigger_incompatible",
                        "This anchor is unavailable for the selected trigger.",
                        node_id=node.id,
                        field="config.field",
                    )
        elif node.type == "lead_follow_up":
            if any(not trigger["supports_lead_follow_up"] for trigger in selected_triggers):
                _issue(
                    issues,
                    "trigger_incompatible",
                    "Follow-up actions require a lead or trial trigger.",
                    node_id=node.id,
                    field="config",
                )
            if executable and config.due_in_days is None:
                _issue(
                    issues,
                    "incomplete_config",
                    "Choose the follow-up due date.",
                    node_id=node.id,
                    field="config.due_in_days",
                )


def _condition(
    node_id: str,
    config: Any,
    metadata: Mapping[str, Any],
    issues: list[WorkflowValidationIssue],
    *,
    executable: bool,
) -> None:
    operator = config.operator
    value_type = metadata["value_type"]
    if not _blank(operator) and (
        operator not in metadata["operators"]
        or operator in _ORDERING
        and value_type not in {"number", "datetime"}
        or operator in _MEMBERSHIP
        and value_type not in {"enum", "uuid"}
    ):
        _issue(
            issues,
            "invalid_operator",
            "This operator is unavailable for the selected field.",
            node_id=node_id,
            field="config.operator",
        )
    value = config.value
    if value is None:
        nullable_comparison = (
            metadata.get("nullable", False)
            and operator in {"eq", "neq"}
            and "value" in config.model_fields_set
        )
        if not nullable_comparison and executable:
            _issue(
                issues,
                "incomplete_config",
                "Enter a comparison value.",
                node_id=node_id,
                field="config.value",
            )
        return
    if operator in _MEMBERSHIP:
        valid = (
            isinstance(value, list)
            and bool(value)
            and all(_typed_value(item, metadata) for item in value)
        )
    elif isinstance(value, list):
        # A draft can select values before selecting its membership operator.
        valid = (
            _blank(operator)
            and value_type in {"enum", "uuid"}
            and bool(value)
            and all(_typed_value(item, metadata) for item in value)
        )
    else:
        valid = _typed_value(value, metadata)
    if not valid:
        _issue(
            issues,
            "invalid_condition_value",
            "Use a value of the selected field's type.",
            node_id=node_id,
            field="config.value",
        )


def _typed_value(value: object, metadata: Mapping[str, Any]) -> bool:
    value_type = metadata["value_type"]
    if value_type == "string":
        return isinstance(value, str)
    if value_type == "boolean":
        return isinstance(value, bool)
    if value_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if value_type == "enum":
        return isinstance(value, str) and value in metadata["values"]
    if value_type == "uuid":
        try:
            return isinstance(value, str) and str(UUID(value)) == value.lower()
        except ValueError:
            return False
    if value_type == "datetime":
        if not isinstance(value, str) or not _DATETIME.fullmatch(value):
            return False
        if not value.endswith("Z") and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
            return False
        try:
            parsed = datetime.fromisoformat(value)
            return parsed.tzinfo is not None and parsed.utcoffset() is not None
        except ValueError:
            return False
    return False


def _template(
    node_id: str,
    field: str,
    template: str,
    catalog: Mapping[str, Any],
    triggers: list[Mapping[str, Any]],
    issues: list[WorkflowValidationIssue],
    *,
    executable: bool,
) -> None:
    field_path = f"config.{field}"
    if executable and not template.strip():
        _issue(
            issues,
            "incomplete_config",
            "Enter email subject and body text.",
            node_id=node_id,
            field=field_path,
        )
    residue = _TOKEN.sub("", template)
    # Match the existing plain-text renderer: exact double-brace names, no expressions.
    if (
        "{" in residue
        or "}" in residue
        or _BODY_CONTROL.search(template)
        or "\r" in template
        or field == "subject_template"
        and _CONTROL.search(template)
    ):
        _issue(
            issues,
            "invalid_template",
            "Use plain text and supported double-brace variables.",
            node_id=node_id,
            field=field_path,
        )
    variables = {match.group(1) for match in _TOKEN.finditer(template)}
    if any(name not in catalog["variables"] for name in variables):
        _issue(
            issues,
            "unknown_template_variable",
            "Use a supported template variable.",
            node_id=node_id,
            field=field_path,
        )
    if any(name not in trigger["template_variables"] for name in variables for trigger in triggers):
        _issue(
            issues,
            "trigger_incompatible",
            "This template variable is unavailable for the selected trigger.",
            node_id=node_id,
            field=field_path,
        )


def _topology(graph: WorkflowGraph, issues: list[WorkflowValidationIssue]) -> None:
    nodes = {node.id: node for node in graph.nodes}
    incoming: dict[str, list[Any]] = {node_id: [] for node_id in nodes}
    outgoing: dict[str, list[Any]] = {node_id: [] for node_id in nodes}
    for edge in graph.edges:
        outgoing[edge.source].append(edge)
        incoming[edge.target].append(edge)
    triggers = [node.id for node in graph.nodes if node.type == "trigger"]
    ends = [node.id for node in graph.nodes if node.type == "end"]
    if len(triggers) != 1:
        _issue(issues, "trigger_count", "Add exactly one trigger.", field="nodes")
    if not ends:
        _issue(issues, "end_required", "Add at least one end node.", field="nodes")
    for node in graph.nodes:
        expected = (
            {"yes", "no"} if node.type == "condition" else set() if node.type == "end" else {"next"}
        )
        counts = Counter(edge.port for edge in outgoing[node.id])
        if set(counts) != expected or any(count != 1 for count in counts.values()):
            _issue(
                issues,
                "invalid_outgoing_ports",
                "Connect each required output exactly once.",
                node_id=node.id,
                field="edges",
            )
        for edge in outgoing[node.id]:
            if edge.port not in expected or counts[edge.port] > 1:
                _issue(
                    issues,
                    "invalid_edge_port",
                    "Use one edge for each output supported by this node.",
                    node_id=node.id,
                    edge_id=edge.id,
                    field="port",
                )
        if node.type == "trigger":
            for edge in incoming[node.id]:
                _issue(
                    issues,
                    "incoming_trigger_edge",
                    "Triggers cannot have incoming edges.",
                    node_id=node.id,
                    edge_id=edge.id,
                    field="target",
                )
        if node.type == "end":
            for edge in outgoing[node.id]:
                _issue(
                    issues,
                    "outgoing_end_edge",
                    "End nodes cannot have outgoing edges.",
                    node_id=node.id,
                    edge_id=edge.id,
                    field="source",
                )

    # A back edge proves a cycle. A maximum of forty nodes bounds recursion.
    visited: set[str] = set()
    active: set[str] = set()

    def visit(node_id: str) -> None:
        visited.add(node_id)
        active.add(node_id)
        for edge in outgoing[node_id]:
            if edge.target in active:
                _issue(
                    issues,
                    "cycle",
                    "Remove the cycle before running this workflow.",
                    node_id=node_id,
                    edge_id=edge.id,
                    field="edges",
                )
            elif edge.target not in visited:
                visit(edge.target)
        active.remove(node_id)

    for node_id in nodes:
        if node_id not in visited:
            visit(node_id)

    def reachable(start: list[str], adjacency: Mapping[str, list[Any]], attribute: str) -> set[str]:
        found: set[str] = set()
        pending = list(start)
        while pending:
            current = pending.pop()
            if current in found:
                continue
            found.add(current)
            pending.extend(getattr(edge, attribute) for edge in adjacency[current])
        return found

    from_trigger = reachable(triggers, outgoing, "target") if len(triggers) == 1 else None
    to_end = reachable(ends, incoming, "source")
    for node in graph.nodes:
        if from_trigger is not None and node.id not in from_trigger:
            _issue(
                issues,
                "unreachable_node",
                "Connect this node to the trigger.",
                node_id=node.id,
                field="edges",
            )
        if node.id not in to_end:
            _issue(
                issues,
                "no_path_to_end",
                "Connect this node to an end node.",
                node_id=node.id,
                field="edges",
            )
