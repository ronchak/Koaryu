"""Strict observed summaries cannot acquire counters from model defaults."""

import warnings
from copy import deepcopy

import pytest
from pydantic import ValidationError

from app.schemas.automation import MissedClassProcessResponse
from app.schemas.automation_batch import (
    AutomationBatchResponse,
    OccurrenceProcessRequest,
    OccurrenceProcessResponse,
)
from app.schemas.workflow_dispatch import WorkflowProcessResponse

MODELS = {"attendance": MissedClassProcessResponse, "workflows": WorkflowProcessResponse}


def engine_summary(engine, **changes):
    return {**MODELS[engine]().model_dump(), **changes}


def batch_summary(**changes):
    return {
        "occurrences": {"created_event_count": 0, "enqueued_run_count": 0, "has_more": False},
        "attendance": engine_summary("attendance"),
        "workflows": engine_summary("workflows"),
        "has_more": False,
        **changes,
    }


@pytest.mark.parametrize("limit", [1, 100])
def test_occurrence_request_has_exact_required_integer_limit(limit):
    assert OccurrenceProcessRequest(p_limit=limit).model_dump() == {"p_limit": limit}


@pytest.mark.parametrize("value", [0, 101, True, False, "1", 1.0, None, [], {}])
def test_occurrence_request_rejects_invalid_limits(value):
    with pytest.raises(ValidationError):
        OccurrenceProcessRequest(p_limit=value)


@pytest.mark.parametrize("data", [{}, {"p_limit": 1, "extra": 1}])
def test_occurrence_request_is_closed_and_required(data):
    with pytest.raises(ValidationError):
        OccurrenceProcessRequest.model_validate(data)


@pytest.mark.parametrize("created,enqueued", [(0, 100), (100, 0), (100, 100)])
def test_occurrence_counts_have_no_invented_inequality(created, enqueued):
    response = OccurrenceProcessResponse.model_validate(
        {"created_event_count": created, "enqueued_run_count": enqueued, "has_more": True},
        context={"p_limit": 100},
    )
    assert (response.created_event_count, response.enqueued_run_count) == (created, enqueued)


@pytest.mark.parametrize("field", ["created_event_count", "enqueued_run_count"])
@pytest.mark.parametrize("value", [-1, 101, True, "1", 1.0, None, []])
def test_occurrence_counters_are_strict(field, value):
    data = batch_summary()["occurrences"]
    data[field] = value
    with pytest.raises(ValidationError):
        OccurrenceProcessResponse.model_validate(data)


@pytest.mark.parametrize("field", list(OccurrenceProcessResponse.model_fields))
def test_occurrence_fields_cannot_be_omitted(field):
    data = batch_summary()["occurrences"]
    del data[field]
    with pytest.raises(ValidationError):
        OccurrenceProcessResponse.model_validate(data)


def test_occurrence_context_bounds_each_counter_and_is_distinct_from_engine_limit():
    for field in ("created_event_count", "enqueued_run_count"):
        data = batch_summary()
        data["occurrences"][field] = 100
        with pytest.raises(ValidationError):
            OccurrenceProcessResponse.model_validate(data["occurrences"], context={"p_limit": 99})
        assert AutomationBatchResponse.model_validate(data, context={"limit": 1}).occurrences


@pytest.mark.parametrize(
    "engine,field", [(e, f) for e, m in MODELS.items() for f in m.model_fields]
)
def test_every_nested_engine_key_must_be_observed(engine, field):
    data = batch_summary()
    del data[engine][field]
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("engine", MODELS)
@pytest.mark.parametrize("value", [True, False, "0", 0.0, None, [], -1, 11])
def test_engine_counters_reject_coercion_and_out_of_range(engine, value):
    for field in set(MODELS[engine].model_fields) - {"has_more"}:
        data = batch_summary()
        data[engine][field] = value
        with pytest.raises(ValidationError):
            AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("field", ["has_more", "occurrences", "attendance", "workflows"])
def test_outer_fields_are_required_even_nullable_engines(field):
    data = batch_summary()
    del data[field]
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("location", [None, "occurrences", "attendance", "workflows"])
def test_all_objects_are_closed(location):
    data = batch_summary()
    (data if location is None else data[location])["private"] = "private sentinel value"
    with pytest.raises(ValidationError) as error:
        AutomationBatchResponse.model_validate(data)
    assert "private sentinel value" not in str(error.value)


@pytest.mark.parametrize("location", [None, "occurrences", "attendance", "workflows"])
@pytest.mark.parametrize("value", [0, 1, "false", None])
def test_every_has_more_is_an_actual_boolean(location, value):
    data = batch_summary()
    (data if location is None else data[location])["has_more"] = value
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("engine", MODELS)
def test_only_complete_expected_model_instances_are_accepted(engine):
    model = MODELS[engine]
    data = batch_summary()
    data[engine] = model(**engine_summary(engine))
    assert AutomationBatchResponse.model_validate(data)
    for invalid in (
        model(),
        model(processed=0),
        MODELS["workflows" if engine == "attendance" else "attendance"](),
    ):
        data[engine] = invalid
        with pytest.raises(ValidationError):
            AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("engine,admitted", [("attendance", "enqueued"), ("workflows", "claimed")])
def test_request_limit_and_existing_count_equations_both_hold(engine, admitted):
    data = batch_summary()
    data[engine][admitted] = 2
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data, context={"limit": 1})
    data[engine] = engine_summary(engine, **{admitted: 2, "processed": 2, "accepted": 2})
    assert AutomationBatchResponse.model_validate(data, context={"limit": 2})
    data[engine]["accepted"] = 1
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("engine", MODELS)
@pytest.mark.parametrize("missing", [True, False])
def test_aggregate_requires_more_for_null_or_component_hint(engine, missing):
    data = batch_summary()
    if missing:
        data[engine] = None
    else:
        data[engine]["has_more"] = True
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data)
    data["has_more"] = True
    assert AutomationBatchResponse.model_validate(data).has_more
    if missing:
        assert getattr(AutomationBatchResponse.model_validate(data), engine) is None


def test_complete_batch_cannot_invent_more_or_default_occurrences():
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(batch_summary(has_more=True))
    data = deepcopy(batch_summary())
    data["occurrences"]["has_more"] = True
    data["has_more"] = True
    assert AutomationBatchResponse.model_validate(data)
    data["occurrences"] = OccurrenceProcessResponse.model_construct(has_more=True)
    with pytest.raises(ValidationError):
        AutomationBatchResponse.model_validate(data)


@pytest.mark.parametrize("engine", MODELS)
def test_constructed_private_wrong_type_is_rejected_without_serialization_warning(engine):
    data = batch_summary()
    data[engine] = MODELS[engine].model_construct(
        **engine_summary(engine, processed="private sentinel")
    )
    with warnings.catch_warnings(record=True) as observed:
        warnings.simplefilter("always")
        with pytest.raises(ValidationError) as error:
            AutomationBatchResponse.model_validate(data)
    assert not observed and "private sentinel" not in str(error.value)
