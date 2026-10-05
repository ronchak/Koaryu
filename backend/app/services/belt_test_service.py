"""Belt-test RPC boundary. SQL owns authority, receipts, transitions, and events."""

from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Annotated, Any
from uuid import UUID

from fastapi import HTTPException
from postgrest.exceptions import APIError
from pydantic import Field, StrictBool, ValidationError

from app.schemas.belt_test import (
    BeltTestEventCreate,
    BeltTestEventListResponse,
    BeltTestEventResponse,
    BeltTestEventUpdate,
    BeltTestModel,
)
from app.schemas.trial_appointment import UTCInstant

ADMIN_REQUIRED_DETAIL = "Only studio admins can manage belt-test events."
UNAVAILABLE_DETAIL = "Belt-test events are temporarily unavailable. Try again shortly."
INVALID_CURSOR_DETAIL = "Invalid belt-test event cursor."
_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND"): (404, "Belt-test event or ladder not found."),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid belt-test event request."),
    ("P0001", "AUTOMATION_REVISION_CONFLICT"): (
        409,
        "This belt-test event changed. Reload it before saving.",
    ),
    ("P0001", "AUTOMATION_OPERATION_CONFLICT"): (
        409,
        "This operation was already used for a different request.",
    ),
    ("P0001", "AUTOMATION_STATE_CONFLICT"): (
        409,
        "This belt-test event cannot be changed in its current state.",
    ),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (409, "The studio is busy. Try again shortly."),
}


class _Cursor(BeltTestModel):
    created_at: UTCInstant
    id: UUID


class BeltTestEventMutationResult(BeltTestModel):
    payload: BeltTestEventResponse
    operation_id: UUID
    replayed: StrictBool


class _ReadEnvelope(BeltTestModel):
    payload: BeltTestEventResponse


class _ListPayload(BeltTestModel):
    items: Annotated[list[BeltTestEventResponse], Field(strict=True, max_length=100)]
    next_cursor: _Cursor | None
    has_more: StrictBool


class _ListEnvelope(BeltTestModel):
    payload: _ListPayload


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
    except (ValueError, TypeError, binascii.Error, UnicodeError):
        raise HTTPException(422, INVALID_CURSOR_DETAIL) from None


def _encode_cursor(cursor: _Cursor) -> str:
    raw = json.dumps(cursor.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


class BeltTestService:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def _call(self, name: str, params: dict) -> dict:
        try:
            result = self.supabase.rpc(name, params).execute().data
            if not isinstance(result, dict):
                raise ValueError("Invalid belt-test RPC envelope.")
            return result
        except APIError as exc:
            status_code, detail = 503, UNAVAILABLE_DETAIL
            if isinstance(exc.code, str) and isinstance(exc.message, str):
                status_code, detail = _ERRORS.get((exc.code, exc.message), (status_code, detail))
            raise HTTPException(status_code, detail) from None
        except Exception:  # noqa: BLE001 - Provider messages can contain private data.
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    @staticmethod
    def _check_identity(
        row: BeltTestEventResponse,
        studio_id: str | UUID,
        event_id: str | UUID | None = None,
    ) -> None:
        if row.studio_id != UUID(str(studio_id)) or (
            event_id is not None and row.id != UUID(str(event_id))
        ):
            raise ValueError("Invalid belt-test event identity.")

    def get(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID,
    ) -> BeltTestEventResponse:
        result = self._call(
            "get_belt_test_event_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_event_id": str(event_id),
            },
        )
        try:
            payload = _ReadEnvelope.model_validate(result).payload
            self._check_identity(payload, studio_id, event_id)
            return payload
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def list(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        limit: int = 50,
        cursor: str | None = None,
    ) -> BeltTestEventListResponse:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "Invalid belt-test event page limit.")
        decoded_cursor = _decode_cursor(cursor)
        result = self._call(
            "list_belt_test_events_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_limit": limit,
                "p_cursor": decoded_cursor,
            },
        )
        try:
            payload = _ListEnvelope.model_validate(result).payload
            if len(payload.items) > limit or payload.has_more != (payload.next_cursor is not None):
                raise ValueError("Invalid belt-test event page.")
            for row in payload.items:
                self._check_identity(row, studio_id)
            if payload.next_cursor is not None and (
                not payload.items
                or payload.next_cursor.id != payload.items[-1].id
                or payload.next_cursor.created_at != payload.items[-1].created_at
            ):
                raise ValueError("Invalid belt-test event cursor.")
            return BeltTestEventListResponse(
                items=payload.items,
                next_cursor=_encode_cursor(payload.next_cursor) if payload.next_cursor else None,
                has_more=payload.has_more,
            )
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def create(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        data: BeltTestEventCreate,
    ) -> BeltTestEventMutationResult:
        request = data.model_dump(mode="json", exclude={"operation_id"})
        return self._mutate(studio_id, actor_id, None, data.operation_id, None, request)

    def update(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID,
        data: BeltTestEventUpdate,
    ) -> BeltTestEventMutationResult:
        request = data.model_dump(
            mode="json", exclude={"operation_id", "expected_revision"}, exclude_unset=True
        )
        return self._mutate(
            studio_id, actor_id, event_id, data.operation_id, data.expected_revision, request
        )

    def _mutate(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID | None,
        operation_id: UUID,
        expected_revision: int | None,
        request: dict,
    ) -> BeltTestEventMutationResult:
        result = self._call(
            "mutate_belt_test_event_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_event_id": str(event_id) if event_id is not None else None,
                "p_operation_id": str(operation_id),
                "p_expected_revision": expected_revision,
                "p_request": request,
            },
        )
        try:
            response = BeltTestEventMutationResult.model_validate(result)
            self._check_identity(response.payload, studio_id, event_id)
            if response.operation_id != operation_id:
                raise ValueError("Invalid operation receipt.")
            return response
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
