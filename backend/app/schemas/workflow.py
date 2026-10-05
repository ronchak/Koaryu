"""Bounded draft contracts for visual automation graphs."""

from __future__ import annotations

import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    field_validator,
    model_serializer,
)
from pydantic_core import PydanticCustomError

from app.services.automation_email import normalize_email_address

NODE_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
WorkflowId = Annotated[str, Field(pattern=NODE_ID_PATTERN, min_length=1, max_length=64)]
CatalogChoice = Annotated[str, Field(max_length=100)]
ConditionString = Annotated[str, Field(max_length=500)]
ConditionScalar = ConditionString | bool | int | Annotated[float, Field(allow_inf_nan=False)]
ConditionValue = ConditionScalar | Annotated[list[ConditionScalar], Field(max_length=100)] | None


class WorkflowModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")


class TriggerConfig(WorkflowModel):
    event_type: CatalogChoice | None = None
    program_id: Annotated[str, Field(max_length=36)] | None = None
    offset_minutes: int = Field(default=-1, ge=-129600, le=-1)

    @model_serializer(mode="wrap")
    def omit_unset_offset(self, handler: SerializerFunctionWrapHandler) -> dict:
        result = handler(self)
        if "offset_minutes" not in self.model_fields_set:
            result.pop("offset_minutes", None)
        return result

    @field_validator("program_id")
    @classmethod
    def validate_program_id(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                if str(UUID(value)) != value.lower():
                    raise ValueError
            except ValueError:
                raise PydanticCustomError(
                    "invalid_uuid", "Select a valid program identifier."
                ) from None
        return value


class ConditionConfig(WorkflowModel):
    field: CatalogChoice | None = None
    operator: CatalogChoice | None = None
    value: ConditionValue = None

    @field_validator("value", mode="before")
    @classmethod
    def validate_json_scalars(cls, value: object) -> object:
        if value is None:
            return value
        values = value if isinstance(value, list) else [value]
        if any(type(item) not in {str, bool, int, float} for item in values):
            raise PydanticCustomError("invalid_type", "Use JSON scalar comparison values.")
        return value

    @model_serializer(mode="wrap")
    def omit_unset_value(self, handler: SerializerFunctionWrapHandler) -> dict:
        result = handler(self)
        if "value" not in self.model_fields_set:
            result.pop("value", None)
        return result


class DurationDelayConfig(WorkflowModel):
    mode: Literal["duration"]
    minutes: Annotated[int, Field(ge=0, le=129600)] | None = None


class UntilDelayConfig(WorkflowModel):
    mode: Literal["until"]
    field: CatalogChoice | None = None
    offset_minutes: Annotated[int, Field(ge=-129600, le=129600)] = 0


DelayConfig = Annotated[DurationDelayConfig | UntilDelayConfig, Field(discriminator="mode")]


class EmailConfig(WorkflowModel):
    recipient: CatalogChoice | None = None
    subject_template: str = Field(default="", max_length=200)
    body_template: str = Field(default="", max_length=5000)
    reply_to_email: str = Field(default="", max_length=254)

    @field_validator("reply_to_email")
    @classmethod
    def validate_reply_to(cls, value: str) -> str:
        if value.strip(" ") == "":
            return ""
        try:
            return normalize_email_address(value)
        except ValueError:
            raise PydanticCustomError(
                "invalid_email", "Enter one valid reply-to email address."
            ) from None


class LeadFollowUpConfig(WorkflowModel):
    due_in_days: Annotated[int, Field(ge=0, le=90)] | None = None
    note: str = Field(default="", max_length=1000)


class EndConfig(WorkflowModel):
    pass


class TriggerNode(WorkflowModel):
    id: WorkflowId
    type: Literal["trigger"]
    config: TriggerConfig


class ConditionNode(WorkflowModel):
    id: WorkflowId
    type: Literal["condition"]
    config: ConditionConfig


class DelayNode(WorkflowModel):
    id: WorkflowId
    type: Literal["delay"]
    config: DelayConfig


class EmailNode(WorkflowModel):
    id: WorkflowId
    type: Literal["email"]
    config: EmailConfig


class LeadFollowUpNode(WorkflowModel):
    id: WorkflowId
    type: Literal["lead_follow_up"]
    config: LeadFollowUpConfig


class EndNode(WorkflowModel):
    id: WorkflowId
    type: Literal["end"]
    config: EndConfig


WorkflowNode = Annotated[
    TriggerNode | ConditionNode | DelayNode | EmailNode | LeadFollowUpNode | EndNode,
    Field(discriminator="type"),
]


class WorkflowEdge(WorkflowModel):
    id: WorkflowId
    source: WorkflowId
    target: WorkflowId
    port: Literal["next", "yes", "no"]


class WorkflowGraph(WorkflowModel):
    schema_version: int = Field(ge=1, le=1)
    nodes: list[WorkflowNode] = Field(max_length=40)
    edges: list[WorkflowEdge] = Field(max_length=60)


class WorkflowPosition(WorkflowModel):
    x: float = Field(ge=-100000, le=100000, allow_inf_nan=False)
    y: float = Field(ge=-100000, le=100000, allow_inf_nan=False)

    @field_validator("x", "y", mode="before")
    @classmethod
    def validate_numeric_coordinates(cls, value: object) -> object:
        if type(value) not in {int, float}:
            raise PydanticCustomError("invalid_type", "Positions must contain finite numbers.")
        return value


class WorkflowLayout(WorkflowModel):
    positions: dict[WorkflowId, WorkflowPosition] = Field(default_factory=dict, max_length=40)


class WorkflowValidationIssue(WorkflowModel):
    code: str
    message: str
    node_id: str | None = None
    edge_id: str | None = None
    field: str | None = None


class WorkflowValidationResult(WorkflowModel):
    valid: bool
    issues: list[WorkflowValidationIssue]


def is_workflow_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(NODE_ID_PATTERN, value) is not None
