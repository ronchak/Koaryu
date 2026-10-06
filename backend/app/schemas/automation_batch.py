"""Complete, closed summaries for one confirmed automation batch."""

from typing import Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    ValidationInfo,
    field_validator,
    model_validator,
)

from app.schemas.automation import MissedClassProcessResponse
from app.schemas.workflow_dispatch import WorkflowProcessResponse


class _BatchModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", revalidate_instances="always", hide_input_in_errors=True
    )


class OccurrenceProcessRequest(_BatchModel):
    p_limit: int = Field(strict=True, ge=1, le=100)


class OccurrenceProcessResponse(_BatchModel):
    created_event_count: int = Field(strict=True, ge=0, le=100)
    enqueued_run_count: int = Field(strict=True, ge=0, le=100)
    has_more: StrictBool

    @model_validator(mode="after")
    def within_request(self, info: ValidationInfo):
        limit = (info.context or {}).get("p_limit", 100)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("invalid_occurrence_limit")
        if max(self.created_event_count, self.enqueued_run_count) > limit:
            raise ValueError("invalid_occurrence_counts")
        return self


def _complete_summary(value: Any, model: type[BaseModel]) -> dict:
    """Check observed keys before a legacy model can supply its defaults."""
    fields = set(model.model_fields)
    if type(value) is model:
        if value.model_fields_set != fields:
            raise ValueError("incomplete_automation_summary")
        value = {key: getattr(value, key, None) for key in fields}
    if type(value) is not dict or set(value) != fields:
        raise ValueError("invalid_automation_summary")
    for key, count in value.items():
        if key == "has_more":
            if type(count) is not bool:
                raise ValueError("invalid_automation_summary")
        elif type(count) is not int or not 0 <= count <= 10:
            raise ValueError("invalid_automation_summary")
    return value


class AutomationBatchResponse(_BatchModel):
    occurrences: OccurrenceProcessResponse
    attendance: MissedClassProcessResponse | None
    workflows: WorkflowProcessResponse | None
    has_more: StrictBool

    @field_validator("occurrences", mode="before")
    @classmethod
    def complete_occurrences(cls, value):
        if isinstance(value, BaseModel):
            if type(value) is not OccurrenceProcessResponse or value.model_fields_set != set(
                OccurrenceProcessResponse.model_fields
            ):
                raise ValueError("incomplete_occurrence_summary")
            return {
                key: getattr(value, key, None) for key in OccurrenceProcessResponse.model_fields
            }
        return value

    @field_validator("attendance", "workflows", mode="before")
    @classmethod
    def complete_engine(cls, value, info: ValidationInfo):
        if value is None:
            return None
        model = (
            MissedClassProcessResponse
            if info.field_name == "attendance"
            else WorkflowProcessResponse
        )
        value = _complete_summary(value, model)
        limit = (info.context or {}).get("limit", 10)
        if type(limit) is not int or not 1 <= limit <= 10:
            raise ValueError("invalid_automation_limit")
        admitted = "enqueued" if info.field_name == "attendance" else "claimed"
        if max(value[admitted], value["processed"]) > limit:
            raise ValueError("invalid_automation_summary_limit")
        return value

    @model_validator(mode="after")
    def coherent_hint(self):
        expected = self.occurrences.has_more or any(
            result is None or result.has_more for result in (self.attendance, self.workflows)
        )
        if self.has_more is not expected:
            raise ValueError("invalid_automation_batch_hint")
        return self
