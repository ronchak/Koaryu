"""Run RPC boundary. SQL owns authorized snapshots and original cancel receipts."""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Annotated, Any
from uuid import UUID

from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import Field, StrictBool

from app.schemas.trial_appointment import UTCInstant
from app.schemas.workflow_run import (
    WorkflowRunCancelRequest,
    WorkflowRunDetail,
    WorkflowRunListResponse,
    WorkflowRunModel,
    WorkflowRunSummary,
)

ADMIN_REQUIRED_DETAIL = "Only studio admins can view or cancel workflow runs."
UNAVAILABLE_DETAIL = "Workflow runs are temporarily unavailable. Try again shortly."
INVALID_CURSOR_DETAIL = "Invalid workflow run cursor."
_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND"): (404, "Workflow or run not found."),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid workflow run request."),
    ("P0001", "AUTOMATION_REVISION_CONFLICT"): (
        409,
        "This run changed. Reload it before cancelling.",
    ),
    ("P0001", "AUTOMATION_OPERATION_CONFLICT"): (
        409,
        "This operation was already used for a different request.",
    ),
    ("P0001", "AUTOMATION_STATE_CONFLICT"): (
        409,
        "This run cannot be cancelled in its current state.",
    ),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (409, "The studio is busy. Try again shortly."),
}


class _Cursor(WorkflowRunModel):
    created_at: UTCInstant
    id: UUID


class _ListPayload(WorkflowRunModel):
    items: Annotated[list[WorkflowRunSummary], Field(strict=True, max_length=100)]
    next_cursor: _Cursor | None
    has_more: StrictBool


class _ListEnvelope(WorkflowRunModel):
    payload: _ListPayload


class _DetailEnvelope(WorkflowRunModel):
    payload: WorkflowRunDetail


class WorkflowRunMutationResult(WorkflowRunModel):
    payload: WorkflowRunDetail
    operation_id: UUID
    replayed: StrictBool


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


class WorkflowRunService:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def _call(self, name: str, params: dict) -> dict:
        try:
            result = self.supabase.rpc(name, params).execute().data
            if not isinstance(result, dict):
                raise TypeError("Invalid workflow run RPC envelope.")
            return result
        except APIError as exc:
            code, message = getattr(exc, "code", None), getattr(exc, "message", None)
            error = (503, UNAVAILABLE_DETAIL)
            if isinstance(code, str) and isinstance(message, str):
                error = _ERRORS.get((code, message), error)
            raise HTTPException(*error) from None
        except Exception:  # noqa: BLE001 - Do not expose private errors or retry uncertain writes.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    @staticmethod
    def _scope(studio_id: str | UUID, actor_id: str | UUID) -> dict:
        return {"p_studio_id": str(studio_id), "p_actor_id": str(actor_id)}

    @staticmethod
    def _check_identity(
        row: WorkflowRunSummary,
        studio_id: str | UUID,
        *,
        workflow_id: UUID | None = None,
        run_id: UUID | None = None,
    ) -> None:
        if (
            row.studio_id != UUID(str(studio_id))
            or (workflow_id is not None and row.workflow_id != workflow_id)
            or (run_id is not None and row.id != run_id)
        ):
            raise ValueError("Invalid run identity.")

    def list(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        workflow_id: UUID,
        limit: int = 50,
        cursor: str | None = None,
    ) -> WorkflowRunListResponse:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "Invalid workflow run page limit.")
        decoded = _decode_cursor(cursor)
        result = self._call(
            "list_automation_workflow_runs_v1",
            {
                **self._scope(studio_id, actor_id),
                "p_workflow_id": str(workflow_id),
                "p_limit": limit,
                "p_cursor": decoded,
            },
        )
        try:
            payload = _ListEnvelope.model_validate(result).payload
            if len(payload.items) > limit or payload.has_more != (payload.next_cursor is not None):
                raise ValueError("Invalid run page.")
            for row in payload.items:
                self._check_identity(row, studio_id, workflow_id=workflow_id)
            keys = [(row.created_at, row.id) for row in payload.items]
            if len({row.id for row in payload.items}) != len(payload.items) or keys != sorted(
                keys, reverse=True
            ):
                raise ValueError("Invalid run page order.")
            if decoded is not None:
                previous = _Cursor.model_validate(decoded)
                if any(key >= (previous.created_at, previous.id) for key in keys):
                    raise ValueError("Invalid run page boundary.")
            if payload.next_cursor is not None and (
                not payload.items
                or payload.next_cursor.id != payload.items[-1].id
                or payload.next_cursor.created_at != payload.items[-1].created_at
            ):
                raise ValueError("Invalid run cursor.")
            return WorkflowRunListResponse(
                items=payload.items,
                next_cursor=_encode_cursor(payload.next_cursor) if payload.next_cursor else None,
                has_more=payload.has_more,
            )
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def get(self, studio_id: str | UUID, actor_id: str | UUID, run_id: UUID) -> WorkflowRunDetail:
        result = self._call(
            "get_automation_workflow_run_v1",
            {**self._scope(studio_id, actor_id), "p_run_id": str(run_id)},
        )
        try:
            detail = _DetailEnvelope.model_validate(result).payload
            self._check_identity(detail.run, studio_id, run_id=run_id)
            return detail
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def cancel(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        run_id: UUID,
        data: WorkflowRunCancelRequest,
    ) -> WorkflowRunMutationResult:
        result = self._call(
            "cancel_automation_workflow_run_v1",
            {
                **self._scope(studio_id, actor_id),
                "p_run_id": str(run_id),
                "p_operation_id": str(data.operation_id),
                "p_expected_revision": data.expected_revision,
            },
        )
        try:
            response = WorkflowRunMutationResult.model_validate(result)
            run = response.payload.run
            self._check_identity(run, studio_id, run_id=run_id)
            # Matching replays contain the original snapshot, never today's revision.
            if (
                response.operation_id != data.operation_id
                or run.revision != data.expected_revision + 1
                or run.can_cancel
                or run.cancel_requested_at is None
                or run.cancel_reason is None
            ):
                raise ValueError("Invalid cancellation result.")
            return response
        except (ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
