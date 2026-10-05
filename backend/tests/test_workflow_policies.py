from uuid import UUID

import pytest

from app.services.workflow_policies import (
    MISSING,
    condition_matches,
    lead_is_enrolled,
    lead_is_open_unconverted,
)


PROGRAM_ID = "a1234567-89ab-cdef-0123-456789abcdef"
OTHER_PROGRAM_ID = "b1234567-89ab-cdef-0123-456789abcdef"


@pytest.mark.parametrize(
    "stage",
    [
        "inquiry",
        "trial_scheduled",
        "trial_completed",
        "offer_sent",
        "enrolled",
        "closed_lost",
        None,
    ],
)
def test_conversion_stays_authoritative_after_a_stage_edit(stage):
    lead = {"stage": stage, "converted_student_id": PROGRAM_ID}
    assert lead_is_enrolled(lead)
    assert not lead_is_open_unconverted(lead)


@pytest.mark.parametrize(
    "lead,enrolled,open_unconverted",
    [
        ({"stage": "inquiry"}, False, True),
        ({"stage": "trial_scheduled"}, False, True),
        ({"stage": "trial_completed"}, False, True),
        ({"stage": "offer_sent", "converted_student_id": None}, False, True),
        ({"stage": "offer_sent", "converted_student_id": ""}, False, True),
        ({"stage": "enrolled"}, True, False),
        ({"stage": "closed_lost"}, False, False),
        ({"stage": "ENROLLED"}, False, False),
        ({"stage": "unknown"}, False, False),
        ({"stage": ["inquiry"]}, False, False),
        ({"stage": None}, False, False),
        ({}, False, False),
        ({"imported": True, "historical": True, "email_opened": True}, False, False),
        ({"stage": "inquiry", "imported": True, "email_clicked": True}, False, True),
    ],
)
def test_lead_state_comes_only_from_conversion_and_exact_stage(lead, enrolled, open_unconverted):
    assert lead_is_enrolled(lead) is enrolled
    assert lead_is_open_unconverted(lead) is open_unconverted


@pytest.mark.parametrize("expected", [True, False])
@pytest.mark.parametrize("actual", [True, False])
def test_boolean_conditions_use_boolean_equality(expected, actual):
    assert condition_matches("lead.unconverted", "eq", expected, actual) is (actual is expected)
    assert condition_matches("lead.unconverted", "neq", expected, actual) is (
        actual is not expected
    )


@pytest.mark.parametrize(
    "field,operator,expected,actual,result",
    [
        ("student.status", "eq", "active", "active", True),
        ("student.status", "eq", "active", "inactive", False),
        ("lead.stage", "neq", "enrolled", "inquiry", True),
        ("lead.stage", "neq", "enrolled", "enrolled", False),
        ("lead.source", "in", ["walk_in", "referral"], "referral", True),
        ("lead.source", "in", ["walk_in", "referral"], "website", False),
        ("trial.status", "not_in", ["no_show", "canceled"], "scheduled", True),
        ("trial.status", "not_in", ["no_show", "canceled"], "canceled", False),
        ("invoice.collection_method", "eq", "send_invoice", "send_invoice", True),
        ("program.id", "eq", PROGRAM_ID.upper(), PROGRAM_ID, True),
        ("promotion.rank_id", "neq", PROGRAM_ID, OTHER_PROGRAM_ID, True),
        ("program.id", "in", [PROGRAM_ID, OTHER_PROGRAM_ID], "{" + PROGRAM_ID.upper() + "}", True),
        ("program.id", "not_in", [PROGRAM_ID], OTHER_PROGRAM_ID, True),
        ("program.id", "not_in", [PROGRAM_ID], PROGRAM_ID.upper(), False),
    ],
)
def test_catalog_typed_conditions(field, operator, expected, actual, result):
    assert condition_matches(field, operator, expected, actual) is result


@pytest.mark.parametrize(
    "uuid_string",
    [
        PROGRAM_ID,
        PROGRAM_ID.upper(),
        PROGRAM_ID.replace("-", ""),
        "{" + PROGRAM_ID + "}",
        "urn:uuid:" + PROGRAM_ID,
    ],
)
def test_uuid_spellings_normalize_consistently(uuid_string):
    assert condition_matches("program.id", "eq", uuid_string, PROGRAM_ID)
    assert condition_matches("program.id", "eq", PROGRAM_ID, uuid_string)


@pytest.mark.parametrize(
    "field,operator,expected",
    [
        ("lead.unconverted", "eq", True),
        ("lead.unconverted", "neq", True),
        ("lead.stage", "neq", "enrolled"),
        ("lead.stage", "not_in", ["enrolled"]),
        ("program.id", "eq", None),
        ("program.id", "neq", None),
        ("program.id", "neq", PROGRAM_ID),
        ("program.id", "not_in", [PROGRAM_ID]),
    ],
)
def test_missing_facts_never_satisfy_any_condition(field, operator, expected):
    assert condition_matches(field, operator, expected) is False
    assert condition_matches(field, operator, expected, MISSING) is False


@pytest.mark.parametrize(
    "field,non_null", [("program.id", PROGRAM_ID), ("invoice.collection_method", "send_invoice")]
)
def test_explicit_null_is_a_known_nullable_value_only_for_scalar_equality(field, non_null):
    assert condition_matches(field, "eq", None, None)
    assert not condition_matches(field, "neq", None, None)
    assert condition_matches(field, "neq", None, non_null)
    assert not condition_matches(field, "eq", None, non_null)
    assert condition_matches(field, "neq", non_null, None)
    assert not condition_matches(field, "eq", non_null, None)
    assert not condition_matches(field, "in", [non_null], None)
    assert not condition_matches(field, "not_in", [non_null], None)


@pytest.mark.parametrize("invalid", [None, 0, 1, 0.0, 1.0, "true", "false", [], {}, object()])
def test_bad_boolean_facts_never_match_even_negative_predicates(invalid):
    assert not condition_matches("lead.unconverted", "eq", True, invalid)
    assert not condition_matches("lead.unconverted", "neq", True, invalid)


@pytest.mark.parametrize(
    "invalid", [None, 1, True, "ENROLLED", "enrolled ", "other", [], {}, object()]
)
def test_bad_enum_facts_never_match_even_negative_predicates(invalid):
    assert not condition_matches("lead.stage", "neq", "enrolled", invalid)
    assert not condition_matches("lead.stage", "not_in", ["enrolled"], invalid)


@pytest.mark.parametrize(
    "invalid", ["", "not-a-uuid", " " + PROGRAM_ID, 1, True, [], {}, UUID(PROGRAM_ID)]
)
def test_bad_uuid_facts_never_match_even_negative_predicates(invalid):
    assert not condition_matches("program.id", "neq", PROGRAM_ID, invalid)
    assert not condition_matches("program.id", "not_in", [PROGRAM_ID], invalid)


@pytest.mark.parametrize("field", ["unknown", "lead.email", "__class__", "", None, [], {}])
def test_unknown_or_malformed_fields_reject(field):
    with pytest.raises(ValueError, match="^unknown_workflow_condition_field$"):
        condition_matches(field, "eq", True)


@pytest.mark.parametrize(
    "field,operator",
    [
        ("lead.unconverted", "in"),
        ("lead.unconverted", "not_in"),
        ("program.id", "gt"),
        ("student.status", "gte"),
        ("lead.stage", "contains"),
        ("lead.stage", "EQ"),
        ("lead.stage", ""),
        ("lead.stage", None),
        ("lead.stage", []),
    ],
)
def test_unsupported_operators_reject(field, operator):
    with pytest.raises(ValueError, match="^unsupported_workflow_condition_operator$"):
        condition_matches(field, operator, True)


@pytest.mark.parametrize(
    "field,operator,expected",
    [
        ("student.is_minor", "eq", 1),
        ("student.is_minor", "eq", 0),
        ("student.is_minor", "neq", 1.0),
        ("student.is_minor", "eq", "true"),
        ("student.is_minor", "eq", None),
        ("student.is_minor", "eq", [True]),
        ("student.status", "eq", "ACTIVE"),
        ("student.status", "neq", "active "),
        ("lead.stage", "eq", "unknown"),
        ("lead.stage", "neq", None),
        ("lead.stage", "eq", ["inquiry"]),
        ("lead.stage", "eq", {}),
        ("lead.stage", "in", "inquiry"),
        ("lead.stage", "in", []),
        ("lead.stage", "in", ["inquiry"] * 101),
        ("lead.stage", "in", ["inquiry", "unknown"]),
        ("lead.stage", "not_in", ["inquiry", 1]),
        ("lead.stage", "in", [["inquiry"]]),
        ("program.id", "eq", "x" * 501),
        ("program.id", "eq", ""),
        ("program.id", "eq", True),
        ("program.id", "eq", UUID(PROGRAM_ID)),
        ("program.id", "not_in", [None]),
        ("program.id", "in", [PROGRAM_ID, "bad"]),
        ("promotion.rank_id", "neq", None),
        ("invoice.collection_method", "in", [None]),
        ("invoice.collection_method", "not_in", ["send_invoice", None]),
    ],
)
def test_invalid_expected_values_reject_even_when_actual_is_missing(field, operator, expected):
    with pytest.raises(ValueError, match="^invalid_workflow_condition_value$"):
        condition_matches(field, operator, expected)


def test_membership_array_boundary_is_one_to_one_hundred_values():
    assert condition_matches("lead.stage", "in", ["inquiry"], "inquiry")
    assert condition_matches("lead.stage", "in", ["inquiry"] * 100, "inquiry")
    assert condition_matches("program.id", "in", [PROGRAM_ID] * 100, PROGRAM_ID)
    assert condition_matches("lead.stage", "in", ("inquiry",), "inquiry")
