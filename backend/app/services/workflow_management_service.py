"""Strict workflow RPC boundary; SQL owns current authority and atomic receipts."""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Annotated, Any
from uuid import UUID

from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import Field, StrictBool, ValidationError, field_validator, model_validator

from app.core.request_body_limits import DEFAULT_API_REQUEST_MAX_BYTES
from app.schemas.trial_appointment import UTCInstant
from app.schemas.workflow import WorkflowValidationResult
from app.schemas.workflow_management import (
    AutomationOperationResponse,
    BeltTestApprovalOperationResponse,
    WorkflowAction,
    WorkflowAvailability,
    WorkflowCatalogResponse,
    WorkflowCreate,
    WorkflowDetail,
    WorkflowLifecycleRequest,
    WorkflowListResponse,
    WorkflowManagementModel,
    WorkflowOperationResponse,
    WorkflowPublish,
    WorkflowSave,
    WorkflowSummary,
    WorkflowValidate,
    guard_workflow_request,
    require_complete_issues,
    validate_workflow_command_result,
)
from app.services.workflow_capabilities import resolve_workflow_capabilities
from app.services.workflow_catalog import CATALOG, get_workflow_catalog
from app.services.workflow_graph import validate_workflow_graph

ADMIN_REQUIRED_DETAIL = "Only studio admins can manage workflows."
RECEIPT_REQUIRED_DETAIL = "You do not have access to this operation."
UNAVAILABLE_DETAIL = "Workflows are temporarily unavailable. Try again shortly."
INVALID_CURSOR_DETAIL = "Invalid workflow cursor."
_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND"): (404, "Workflow or operation not found."),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid workflow request."),
    ("P0001", "AUTOMATION_REVISION_CONFLICT"): (
        409,
        "This workflow changed. Reload it before saving.",
    ),
    ("P0001", "AUTOMATION_OPERATION_CONFLICT"): (
        409,
        "This operation was already used for a different request.",
    ),
    ("P0001", "AUTOMATION_STATE_CONFLICT"): (
        409,
        "This workflow cannot be changed in its current state.",
    ),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (409, "The studio is busy. Try again shortly."),
}


class _Cursor(WorkflowManagementModel):
    created_at: UTCInstant
    id: UUID


class WorkflowMutationResult(WorkflowManagementModel):
    payload: WorkflowDetail
    operation_id: UUID
    replayed: StrictBool


class _DetailEnvelope(WorkflowManagementModel):
    payload: WorkflowDetail


class _ListPayload(WorkflowManagementModel):
    items: Annotated[list[WorkflowSummary], Field(strict=True, max_length=100)]
    next_cursor: _Cursor | None
    has_more: StrictBool


class _ListEnvelope(WorkflowManagementModel):
    payload: _ListPayload


class _OperationEnvelope(WorkflowManagementModel):
    payload: AutomationOperationResponse


class _ValidationPayload(WorkflowValidationResult):
    @field_validator("issues", mode="before")
    @classmethod
    def complete_issues(cls, value: object) -> object:
        return require_complete_issues(value)

    @model_validator(mode="after")
    def consistent_result(self) -> _ValidationPayload:
        if self.valid != (not self.issues):
            raise ValueError("Invalid workflow validation result.")
        return self


class _ValidationEnvelope(WorkflowManagementModel):
    payload: _ValidationPayload


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate cursor key.")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("Nonfinite cursor value.")


def _decode_cursor(token: str | None) -> dict | None:
    if token is None:
        return None
    try:
        if (
            not isinstance(token, str)
            or not 1 <= len(token) <= 512
            or not re.fullmatch(r"[A-Za-z0-9_-]+", token)
        ):
            raise ValueError("Invalid cursor encoding.")
        raw = base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != token:
            raise ValueError("Invalid cursor encoding.")
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        return _Cursor.model_validate(value).model_dump(mode="json")
    except (ValueError, TypeError, binascii.Error, UnicodeError, RecursionError):
        raise HTTPException(422, INVALID_CURSOR_DETAIL) from None


def _encode_cursor(cursor: _Cursor) -> str:
    raw = json.dumps(cursor.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


class WorkflowManagementService:
    def __init__(self, supabase: Any, settings: Any = None):
        self.supabase = supabase
        self.settings = settings

    def _call(self, name: str, params: dict) -> dict:
        try:
            result = self.supabase.rpc(name, params).execute().data
            if not isinstance(result, dict):
                raise TypeError("Invalid workflow RPC envelope.")
            return result
        except APIError as exc:
            code, message = getattr(exc, "code", None), getattr(exc, "message", None)
            error = (503, UNAVAILABLE_DETAIL)
            if isinstance(code, str) and isinstance(message, str):
                error = _ERRORS.get((code, message), error)
            raise HTTPException(*error) from None
        except Exception:  # noqa: BLE001 - Never expose provider messages or retry an uncertain write.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def _availability(self, actor_id: str | UUID) -> WorkflowAvailability:
        try:
            return WorkflowAvailability.model_validate(
                resolve_workflow_capabilities(self.supabase, self.settings, actor_id)
            )
        except Exception:  # noqa: BLE001 - Credential and Auth errors must remain private.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def catalog(self, actor_id: str | UUID) -> WorkflowCatalogResponse:
        availability = self._availability(actor_id)
        return WorkflowCatalogResponse.model_validate(
            {
                **get_workflow_catalog(),
                **availability.model_dump(mode="json"),
                "schema_version": 1,
                "limits": {
                    "max_nodes": 40,
                    "max_edges": 60,
                    "max_workflows": 100,
                    "max_active_workflows": 25,
                    "max_delay_minutes": 129600,
                    "max_request_bytes": DEFAULT_API_REQUEST_MAX_BYTES,
                },
            }
        )

    @staticmethod
    def _scope(studio_id: str | UUID, actor_id: str | UUID) -> dict:
        return {"p_studio_id": str(studio_id), "p_actor_id": str(actor_id)}

    def list(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        limit: int = 50,
        cursor: str | None = None,
    ) -> WorkflowListResponse:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "Invalid workflow page limit.")
        result = self._call(
            "list_automation_workflows_v1",
            {
                **self._scope(studio_id, actor_id),
                "p_limit": limit,
                "p_cursor": _decode_cursor(cursor),
            },
        )
        try:
            payload = _ListEnvelope.model_validate(result).payload
            if len(payload.items) > limit or payload.has_more != (payload.next_cursor is not None):
                raise ValueError("Invalid workflow page.")
            if payload.next_cursor is not None and (
                not payload.items
                or payload.next_cursor.id != payload.items[-1].id
                or payload.next_cursor.created_at != payload.items[-1].created_at
            ):
                raise ValueError("Invalid workflow cursor.")
            return WorkflowListResponse(
                items=payload.items,
                next_cursor=_encode_cursor(payload.next_cursor) if payload.next_cursor else None,
                has_more=payload.has_more,
            )
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def get(self, studio_id: str | UUID, actor_id: str | UUID, workflow_id: UUID) -> WorkflowDetail:
        result = self._call(
            "get_automation_workflow_v1",
            {**self._scope(studio_id, actor_id), "p_workflow_id": str(workflow_id)},
        )
        try:
            row = _DetailEnvelope.model_validate(result).payload
            if row.id != workflow_id:
                raise ValueError("Invalid workflow identity.")
            return row
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def create(
        self, studio_id: str | UUID, actor_id: str | UUID, data: WorkflowCreate
    ) -> WorkflowMutationResult:
        request = data.model_dump(mode="json")
        guard_workflow_request(request)
        result = self._call(
            "create_automation_workflow_v1",
            {
                **self._scope(studio_id, actor_id),
                **{f"p_{key}": value for key, value in request.items()},
            },
        )
        return self._mutation_result(result, data.operation_id, "create")

    def save(
        self, studio_id: str | UUID, actor_id: str | UUID, workflow_id: UUID, data: WorkflowSave
    ) -> WorkflowMutationResult:
        request = data.model_dump(mode="json")
        guard_workflow_request(request)
        result = self._call(
            "save_automation_workflow_v1",
            {
                **self._scope(studio_id, actor_id),
                "p_workflow_id": str(workflow_id),
                **{f"p_{key}": value for key, value in request.items()},
            },
        )
        return self._mutation_result(
            result, data.operation_id, "save", workflow_id, data.expected_revision
        )

    def command(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        workflow_id: UUID,
        action: WorkflowAction,
        data: WorkflowLifecycleRequest,
    ) -> WorkflowMutationResult:
        guard_workflow_request(data)
        if action not in {"publish", "start", "pause", "archive"} or (
            isinstance(data, WorkflowPublish) != (action == "publish")
        ):
            raise HTTPException(422, "Invalid workflow command.")
        replay_only = action == "start" and not self._availability(actor_id).capabilities.can_start
        result = self._call(
            "command_automation_workflow_v1",
            {
                **self._scope(studio_id, actor_id),
                "p_workflow_id": str(workflow_id),
                "p_operation_id": str(data.operation_id),
                "p_expected_revision": data.expected_revision,
                "p_action": action,
                "p_cancel_pending": data.cancel_pending
                if isinstance(data, WorkflowPublish)
                else False,
                "p_start_replay_only": replay_only,
            },
        )
        response = self._mutation_result(
            result, data.operation_id, action, workflow_id, data.expected_revision
        )
        if replay_only and not response.replayed:
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
        return response

    @staticmethod
    def _mutation_result(
        result: dict,
        operation_id: UUID,
        action: str,
        workflow_id: UUID | None = None,
        expected_revision: int | None = None,
    ) -> WorkflowMutationResult:
        try:
            response = WorkflowMutationResult.model_validate(result)
            if response.operation_id != operation_id or (
                workflow_id is not None and response.payload.id != workflow_id
            ):
                raise ValueError("Invalid workflow operation identity.")
            validate_workflow_command_result(f"workflow.{action}", response.payload)
            if expected_revision is not None and response.payload.revision != expected_revision + 1:
                raise ValueError("Invalid workflow result revision.")
            return response
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def validate(
        self, studio_id: str | UUID, actor_id: str | UUID, data: WorkflowValidate
    ) -> WorkflowValidationResult:
        guard_workflow_request(data)
        python_result = validate_workflow_graph(data.graph, catalog=CATALOG, layout=data.layout)
        result = self._call(
            "validate_automation_workflow_v1",
            {**self._scope(studio_id, actor_id), "p_graph": data.graph, "p_layout": data.layout},
        )
        try:
            sql_result = _ValidationEnvelope.model_validate(result).payload
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
        issues = {}
        for issue in [*python_result.issues, *sql_result.issues]:
            key = (issue.code, issue.message, issue.node_id, issue.edge_id, issue.field)
            issues.setdefault(key, issue)
        return WorkflowValidationResult(
            valid=python_result.valid and sql_result.valid, issues=list(issues.values())
        )

    def operation(
        self, studio_id: str | UUID, actor_id: str | UUID, operation_id: UUID, role: str
    ) -> AutomationOperationResponse:
        result = self._call(
            "get_automation_operation_v1",
            {**self._scope(studio_id, actor_id), "p_operation_id": str(operation_id)},
        )
        try:
            receipt = _OperationEnvelope.model_validate(result).payload
            if receipt.operation_id != operation_id:
                raise ValueError("Invalid operation identity.")
            if not isinstance(receipt, WorkflowOperationResponse):
                rows = (
                    receipt.result.items
                    if isinstance(receipt, BeltTestApprovalOperationResponse)
                    else [receipt.result]
                )
                if any(UUID(str(row.studio_id)) != UUID(str(studio_id)) for row in rows):
                    raise ValueError("Invalid operation studio.")
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
        if role != "admin" and not (role == "front_desk" and receipt.command == "lead.create"):
            raise HTTPException(403, RECEIPT_REQUIRED_DETAIL)
        # SQL checks the original actor. Contact or assignee fields cannot prove it.
        return receipt
