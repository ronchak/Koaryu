"""Pure domain predicates, independent of workflow persistence and delivery."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from app.services.workflow_catalog import CATALOG

MISSING = object()
_OPEN_LEAD_STAGES = frozenset({"inquiry", "trial_scheduled", "trial_completed", "offer_sent"})


def lead_is_enrolled(lead: Mapping) -> bool:
    """A conversion remains authoritative if someone later edits the lead stage."""
    return bool(lead.get("converted_student_id")) or lead.get("stage") == "enrolled"


def lead_is_open_unconverted(lead: Mapping) -> bool:
    stage = lead.get("stage")
    return (
        not lead.get("converted_student_id")
        and isinstance(stage, str)
        and stage in _OPEN_LEAD_STAGES
    )


def _scalar(value: Any, field: Mapping, *, allow_null: bool) -> Any:
    if value is None and allow_null and field["nullable"]:
        return None
    value_type = field["value_type"]
    if value_type == "boolean":
        if type(value) is bool:
            return value
    elif isinstance(value, str) and len(value) <= 500:
        if value_type == "enum" and value in field["values"]:
            return value
        if value_type == "uuid":
            try:
                return str(UUID(value))
            except ValueError:
                pass
    raise ValueError("invalid_workflow_condition_value")


def condition_fact_available(field_id: str, actual: Any = MISSING) -> bool:
    """Whether a supplied fact is known and valid, independently of comparison."""
    if not isinstance(field_id, str) or field_id not in CATALOG["fields"]:
        raise ValueError("unknown_workflow_condition_field")
    if actual is MISSING:
        return False
    try:
        _scalar(actual, CATALOG["fields"][field_id], allow_null=True)
    except ValueError:
        return False
    return True


def condition_matches(field_id: str, operator: str, expected: Any, actual: Any = MISSING) -> bool:
    """Compare one supplied fact using the field's declared type and operators.

    Omitted facts fail closed, including negative comparisons. Explicit null is
    a known value only for nullable fields in scalar equality comparisons.
    """
    if not isinstance(field_id, str) or field_id not in CATALOG["fields"]:
        raise ValueError("unknown_workflow_condition_field")
    field = CATALOG["fields"][field_id]
    if not isinstance(operator, str) or operator not in field["operators"]:
        raise ValueError("unsupported_workflow_condition_operator")
    membership = operator in {"in", "not_in"}
    if membership:
        if not isinstance(expected, (list, tuple)) or not 1 <= len(expected) <= 100:
            raise ValueError("invalid_workflow_condition_value")
        expected = tuple(_scalar(value, field, allow_null=False) for value in expected)
    else:
        expected = _scalar(expected, field, allow_null=True)
    if actual is MISSING:
        return False
    try:
        actual = _scalar(actual, field, allow_null=not membership)
    except ValueError:
        return False
    if operator == "eq":
        return actual == expected
    if operator == "neq":
        return actual != expected
    if operator == "in":
        return actual in expected
    return actual not in expected
