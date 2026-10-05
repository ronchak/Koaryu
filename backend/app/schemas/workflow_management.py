"""Workflow management requests, public reads, and command-specific receipts."""

from __future__ import annotations

import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    JsonValue,
    SerializerFunctionWrapHandler,
    StrictBool,
    StrictStr,
    field_validator,
    model_serializer,
    model_validator,
)

from app.core.request_body_limits import DEFAULT_API_REQUEST_MAX_BYTES
from app.schemas.automation import AutomationDeliveryStatus
from app.schemas.belt_test import BeltTestEventResponse
from app.schemas.belt_test_recipient import (
    BeltTestRecipientApprovalResponse,
    BeltTestRecipientResponse,
)
from app.schemas.lead import LeadResponse
from app.schemas.trial_appointment import Revision, TrialAppointmentResponse, UTCInstant
from app.schemas.workflow import (
    WorkflowGraph,
    WorkflowLayout,
    WorkflowValidationIssue,
)
from app.services.workflow_catalog import CATALOG
from app.services.workflow_graph import validate_workflow_draft

REQUEST_TOO_LARGE_DETAIL = "Workflow request is too large."
INVALID_REQUEST_DETAIL = "Invalid workflow request."


def guard_workflow_request(value: object) -> None:
    """Bound the complete canonical JSON body before nested model validation.

    This is deliberately absent from stored graph and response models. Some
    retained incomplete drafts exceed the transport limit and still need repair.
    """
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    try:
        # json.dumps accepts tuples and non-string keys. Neither is JSON data.
        pending = [value]
        visited = set()
        while pending:
            item = pending.pop()
            if type(item) in {dict, list}:
                if id(item) in visited:
                    continue
                visited.add(id(item))
            if type(item) is dict:
                if any(type(key) is not str for key in item):
                    raise ValueError
                pending.extend(item.values())
            elif type(item) is list:
                pending.extend(item)
            elif item is not None and type(item) not in {str, int, float, bool}:
                raise ValueError
        size = 0
        encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        for chunk in encoder.iterencode(value):
            size += len(chunk.encode("utf-8"))
            if size > DEFAULT_API_REQUEST_MAX_BYTES:
                raise HTTPException(422, REQUEST_TOO_LARGE_DETAIL)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise HTTPException(422, INVALID_REQUEST_DETAIL) from None


def _nonblank(value: str) -> str:
    if isinstance(value, str) and not value.strip():
        raise ValueError("Enter a workflow name.")
    return value


def _integer(value: object) -> object:
    if type(value) is not int:
        raise ValueError("Use an integer.")
    return value


WorkflowName = Annotated[
    str, Field(strict=True, min_length=1, max_length=120), BeforeValidator(_nonblank)
]
WorkflowDescription = Annotated[str, Field(strict=True, max_length=500)]
WorkflowStatus = Literal["draft", "active", "paused", "archived"]
WorkflowAction = Literal["publish", "start", "pause", "archive"]
WorkflowCommand = Literal[
    "workflow.create",
    "workflow.save",
    "workflow.publish",
    "workflow.start",
    "workflow.pause",
    "workflow.archive",
]
RunCount = Annotated[int, Field(strict=True, ge=0)]


class WorkflowManagementModel(BaseModel):
    model_config = ConfigDict(extra="forbid", revalidate_instances="always")


class WorkflowRequest(WorkflowManagementModel):
    @model_validator(mode="before")
    @classmethod
    def bound_request(cls, value: object) -> object:
        guard_workflow_request(value)
        return value


class WorkflowCreate(WorkflowRequest):
    operation_id: UUID
    name: WorkflowName
    description: WorkflowDescription
    graph: WorkflowGraph
    layout: WorkflowLayout

    @model_validator(mode="after")
    def validate_draft_safety(self) -> WorkflowCreate:
        if not validate_workflow_draft(self.graph, catalog=CATALOG, layout=self.layout).valid:
            raise ValueError("Use a safe workflow draft.")
        return self


class WorkflowSave(WorkflowCreate):
    expected_revision: Revision


class WorkflowLifecycleRequest(WorkflowRequest):
    operation_id: UUID
    expected_revision: Revision


class WorkflowPublish(WorkflowLifecycleRequest):
    cancel_pending: StrictBool = False


class WorkflowValidate(WorkflowRequest):
    # Invalid graph shapes are diagnostics, not invalid request envelopes.
    graph: JsonValue
    layout: JsonValue = Field(default_factory=dict)


def require_complete_issues(value: object) -> object:
    if not isinstance(value, list):
        raise ValueError("Invalid workflow issues.")  # noqa: TRY004 - Pydantic wraps ValueError, not TypeError.
    fields = set(WorkflowValidationIssue.model_fields)
    for issue in value:
        if isinstance(issue, WorkflowValidationIssue):
            if issue.model_fields_set != fields:
                raise ValueError("Incomplete workflow issue.")
        elif not isinstance(issue, dict) or set(issue) != fields:
            raise ValueError("Incomplete workflow issue.")
    return value


class _WorkflowMetadata(WorkflowManagementModel):
    id: UUID
    name: WorkflowName
    description: WorkflowDescription
    status: WorkflowStatus
    revision: Revision
    published_version_id: UUID | None
    published_version_number: Revision | None
    published_at: UTCInstant | None
    updated_at: UTCInstant
    has_unpublished_changes: StrictBool
    pending_run_count: RunCount
    sending_run_count: RunCount

    @model_validator(mode="after")
    def validate_publication(self) -> _WorkflowMetadata:
        present = (
            self.published_version_id is not None,
            self.published_version_number is not None,
            self.published_at is not None,
        )
        if any(present) != all(present) or (
            self.status in {"active", "paused"} and not all(present)
        ):
            raise ValueError("Invalid workflow publication.")
        if self.status == "draft" and any(present):
            raise ValueError("A draft cannot have a publication.")
        return self


class WorkflowDetail(_WorkflowMetadata):
    draft_graph: WorkflowGraph
    draft_layout: WorkflowLayout
    validation_issues: Annotated[
        list[WorkflowValidationIssue], BeforeValidator(require_complete_issues)
    ]


class WorkflowSummary(_WorkflowMetadata):
    trigger_event_type: StrictStr | None
    draft_trigger_event_type: StrictStr | None
    created_at: UTCInstant


class WorkflowListResponse(WorkflowManagementModel):
    items: Annotated[list[WorkflowSummary], Field(strict=True, max_length=100)]
    next_cursor: Annotated[str, Field(strict=True, min_length=1, max_length=512)] | None
    has_more: StrictBool

    @model_validator(mode="after")
    def validate_cursor_presence(self) -> WorkflowListResponse:
        if self.has_more != (self.next_cursor is not None):
            raise ValueError("Invalid workflow page.")
        return self


class WorkflowTriggerMetadata(WorkflowManagementModel):
    id: StrictStr
    label: StrictStr
    subject_kind: Literal["student", "promotion", "lead", "trial", "invoice", "belt_test"]
    simulation_entity_type: Literal[
        "student",
        "promotion",
        "lead",
        "trial_appointment",
        "invoice",
        "payment",
        "belt_test_recipient",
    ]
    recipient_ids: list[StrictStr]
    field_ids: list[StrictStr]
    template_variables: list[StrictStr]
    supports_offset: StrictBool
    supports_program_filter: StrictBool
    delay_fields: list[StrictStr]
    supports_lead_follow_up: StrictBool


class WorkflowFieldMetadata(WorkflowManagementModel):
    id: StrictStr
    label: StrictStr
    value_type: Literal["boolean", "enum", "uuid"]
    operators: list[Literal["eq", "neq", "in", "not_in"]]
    nullable: StrictBool
    values: list[StrictStr] = Field(default_factory=list)

    @model_serializer(mode="wrap")
    def omit_unset_values(self, handler: SerializerFunctionWrapHandler):
        # A dict return annotation would erase these fields in response OpenAPI.
        result = handler(self)
        if "values" not in self.model_fields_set:
            result.pop("values", None)
        return result


class WorkflowRecipientMetadata(WorkflowManagementModel):
    id: StrictStr
    label: StrictStr


class WorkflowVariableMetadata(WorkflowRecipientMetadata):
    value_type: Literal["string"]
    fallback: StrictStr | None


class WorkflowDelayMetadata(WorkflowRecipientMetadata):
    value_type: Literal["datetime"]
    trigger_ids: list[StrictStr]


class WorkflowPresetMetadata(WorkflowManagementModel):
    id: StrictStr
    name: StrictStr
    description: StrictStr
    graph: WorkflowGraph


class WorkflowLimits(WorkflowManagementModel):
    max_nodes: Annotated[Literal[40], BeforeValidator(_integer)]
    max_edges: Annotated[Literal[60], BeforeValidator(_integer)]
    max_workflows: Annotated[Literal[100], BeforeValidator(_integer)]
    max_active_workflows: Annotated[Literal[25], BeforeValidator(_integer)]
    max_delay_minutes: Annotated[Literal[129600], BeforeValidator(_integer)]
    max_request_bytes: Annotated[Literal[1048576], BeforeValidator(_integer)]


class WorkflowDeliveryStatus(AutomationDeliveryStatus):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")


class WorkflowCapabilities(WorkflowManagementModel):
    can_start: StrictBool
    can_test_email: StrictBool
    disabled_reason: StrictStr | None


class WorkflowScheduler(WorkflowManagementModel):
    enabled: StrictBool
    interval_seconds: Annotated[Literal[60], BeforeValidator(_integer)]


class WorkflowAvailability(WorkflowManagementModel):
    delivery_status: WorkflowDeliveryStatus
    capabilities: WorkflowCapabilities
    scheduler: WorkflowScheduler

    @model_validator(mode="after")
    def validate_capability_consistency(self) -> WorkflowAvailability:
        delivery, capabilities = self.delivery_status, self.capabilities
        if delivery.can_enable and (
            not delivery.configured or delivery.mode == "disabled" or delivery.reason is not None
        ):
            raise ValueError("Invalid workflow delivery status.")
        if capabilities.can_start and (not delivery.can_enable or not self.scheduler.enabled):
            raise ValueError("Invalid workflow start capability.")
        if capabilities.can_test_email and not delivery.can_enable:
            raise ValueError("Invalid workflow test capability.")
        if (capabilities.disabled_reason is None) != (
            capabilities.can_start and capabilities.can_test_email
        ):
            raise ValueError("Invalid workflow capability reason.")
        return self


class WorkflowCatalogResponse(WorkflowAvailability):
    schema_version: Annotated[Literal[1], BeforeValidator(_integer)]
    limits: WorkflowLimits
    triggers: dict[str, WorkflowTriggerMetadata]
    fields: dict[str, WorkflowFieldMetadata]
    recipients: dict[str, WorkflowRecipientMetadata]
    variables: dict[str, WorkflowVariableMetadata]
    delay_fields: dict[str, WorkflowDelayMetadata]
    presets: list[WorkflowPresetMetadata]


def validate_workflow_command_result(command: str, result: WorkflowDetail) -> None:
    allowed = {
        "workflow.create": {"draft"},
        "workflow.save": {"draft", "active", "paused"},
        "workflow.publish": {"active", "paused"},
        "workflow.start": {"active"},
        "workflow.pause": {"paused"},
        "workflow.archive": {"archived"},
    }
    if command not in allowed or result.status not in allowed[command]:
        raise ValueError("Invalid workflow command status.")
    if command == "workflow.create" and result.revision != 1:
        raise ValueError("Invalid workflow creation revision.")
    if command == "workflow.publish" and (
        result.validation_issues or result.has_unpublished_changes
    ):
        raise ValueError("Invalid published workflow result.")


class _OperationReceipt(WorkflowManagementModel):
    operation_id: UUID
    state: Literal["committed"]
    entity_id: UUID
    committed_at: UTCInstant


class WorkflowOperationResponse(_OperationReceipt):
    command: WorkflowCommand
    entity_type: Literal["workflow"]
    result: WorkflowDetail

    @model_validator(mode="after")
    def validate_result(self) -> WorkflowOperationResponse:
        if self.entity_id != self.result.id:
            raise ValueError("Invalid workflow receipt identity.")
        validate_workflow_command_result(self.command, self.result)
        return self


class LeadCreateOperationResponse(_OperationReceipt):
    command: Literal["lead.create"]
    entity_type: Literal["lead"]
    result: LeadResponse

    @field_validator("result", mode="before")
    @classmethod
    def validate_complete_lead(cls, value: object) -> LeadResponse:
        if isinstance(value, LeadResponse):
            if value.model_fields_set != set(LeadResponse.model_fields):
                raise ValueError("Incomplete lead receipt.")
            value = value.model_dump()
        if not isinstance(value, dict) or set(value) != set(LeadResponse.model_fields):
            raise ValueError("Incomplete lead receipt.")
        result = LeadResponse.model_validate(value, strict=True)
        for field in (
            "id",
            "studio_id",
            "program_id",
            "assigned_staff_id",
            "converted_student_id",
        ):
            identifier = getattr(result, field)
            if identifier is not None:
                UUID(identifier)
        return result

    @model_validator(mode="after")
    def validate_identity(self) -> LeadCreateOperationResponse:
        if self.entity_id != UUID(self.result.id):
            raise ValueError("Invalid lead receipt identity.")
        return self


class TrialOperationResponse(_OperationReceipt):
    command: Literal["trial.create", "trial.update"]
    entity_type: Literal["trial_appointment"]
    result: TrialAppointmentResponse

    @model_validator(mode="after")
    def validate_identity(self) -> TrialOperationResponse:
        if self.entity_id != self.result.id:
            raise ValueError("Invalid trial receipt identity.")
        return self


class BeltTestOperationResponse(_OperationReceipt):
    command: Literal["belt_test.create", "belt_test.update"]
    entity_type: Literal["belt_test"]
    result: BeltTestEventResponse

    @model_validator(mode="after")
    def validate_identity(self) -> BeltTestOperationResponse:
        if self.entity_id != self.result.id:
            raise ValueError("Invalid belt-test receipt identity.")
        return self


class BeltTestApprovalOperationResponse(_OperationReceipt):
    command: Literal["belt_test.approve"]
    entity_type: Literal["belt_test"]
    result: BeltTestRecipientApprovalResponse

    @model_validator(mode="after")
    def validate_approval(self) -> BeltTestApprovalOperationResponse:
        items = self.result.items
        if (
            len({row.id for row in items}) != len(items)
            or len({(row.student_id, row.student_program_membership_id) for row in items})
            != len(items)
            or any(
                row.event_id != self.entity_id
                or row.approved_schedule_revision != self.result.schedule_revision
                or row.state != "approved"
                or row.revoked_at is not None
                for row in items
            )
        ):
            raise ValueError("Invalid belt-test approval receipt.")
        return self


class BeltTestRevokeOperationResponse(_OperationReceipt):
    command: Literal["belt_test.revoke"]
    entity_type: Literal["belt_test_recipient"]
    result: BeltTestRecipientResponse

    @model_validator(mode="after")
    def validate_identity(self) -> BeltTestRevokeOperationResponse:
        if self.entity_id != self.result.id or self.result.state != "revoked":
            raise ValueError("Invalid belt-test revoke receipt.")
        return self


AutomationOperationResponse = Annotated[
    WorkflowOperationResponse
    | LeadCreateOperationResponse
    | TrialOperationResponse
    | BeltTestOperationResponse
    | BeltTestApprovalOperationResponse
    | BeltTestRevokeOperationResponse,
    Field(discriminator="command"),
]
