"""Trial RPC boundary. SQL owns authority, receipts, transitions, and events."""

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

from app.schemas.trial_appointment import (
    TrialAppointmentCreate,
    TrialAppointmentListResponse,
    TrialAppointmentModel,
    TrialAppointmentResponse,
    TrialAppointmentUpdate,
    UTCInstant,
)

ADMIN_REQUIRED_DETAIL = "Only studio admins can manage trial appointments."
UNAVAILABLE_DETAIL = "Trial appointments are temporarily unavailable. Try again shortly."
INVALID_CURSOR_DETAIL = "Invalid trial appointment cursor."
_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND"): (404, "Trial appointment or lead not found."),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid trial appointment request."),
    ("P0001", "AUTOMATION_REVISION_CONFLICT"): (
        409,
        "This trial appointment changed. Reload it before saving.",
    ),
    ("P0001", "AUTOMATION_OPERATION_CONFLICT"): (
        409,
        "This operation was already used for a different request.",
    ),
    ("P0001", "AUTOMATION_STATE_CONFLICT"): (
        409,
        "This trial appointment cannot be changed in its current state.",
    ),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (409, "The studio is busy. Try again shortly."),
}


class _Cursor(TrialAppointmentModel):
    created_at: UTCInstant
    id: UUID


class TrialAppointmentMutationResult(TrialAppointmentModel):
    payload: TrialAppointmentResponse
    operation_id: UUID
    replayed: StrictBool


class _ReadEnvelope(TrialAppointmentModel):
    payload: TrialAppointmentResponse


class _ListPayload(TrialAppointmentModel):
    items: Annotated[list[TrialAppointmentResponse], Field(strict=True, max_length=100)]
    next_cursor: _Cursor | None
    has_more: StrictBool


class _ListEnvelope(TrialAppointmentModel):
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


class TrialAppointmentService:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def _call(self, name: str, params: dict) -> dict:
        try:
            result = self.supabase.rpc(name, params).execute().data
            if not isinstance(result, dict):
                raise ValueError("Invalid trial RPC envelope.")
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
        row: TrialAppointmentResponse,
        studio_id: str | UUID,
        lead_id: str | UUID,
        appointment_id: str | UUID | None = None,
    ) -> None:
        if (
            row.studio_id != UUID(str(studio_id))
            or row.lead_id != UUID(str(lead_id))
            or (appointment_id is not None and row.id != UUID(str(appointment_id)))
        ):
            raise ValueError("Invalid appointment identity.")

    def get(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        lead_id: str | UUID,
        appointment_id: str | UUID,
    ) -> TrialAppointmentResponse:
        result = self._call(
            "get_lead_trial_appointment_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_lead_id": str(lead_id),
                "p_appointment_id": str(appointment_id),
            },
        )
        try:
            payload = _ReadEnvelope.model_validate(result).payload
            self._check_identity(payload, studio_id, lead_id, appointment_id)
            return payload
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def list(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        lead_id: str | UUID,
        limit: int = 50,
        cursor: str | None = None,
    ) -> TrialAppointmentListResponse:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "Invalid trial appointment page limit.")
        decoded_cursor = _decode_cursor(cursor)
        result = self._call(
            "list_lead_trial_appointments_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_lead_id": str(lead_id),
                "p_limit": limit,
                "p_cursor": decoded_cursor,
            },
        )
        try:
            payload = _ListEnvelope.model_validate(result).payload
            if len(payload.items) > limit or payload.has_more != (payload.next_cursor is not None):
                raise ValueError("Invalid appointment page.")
            for row in payload.items:
                self._check_identity(row, studio_id, lead_id)
            if payload.next_cursor is not None and (
                not payload.items
                or payload.next_cursor.id != payload.items[-1].id
                or payload.next_cursor.created_at != payload.items[-1].created_at
            ):
                raise ValueError("Invalid appointment cursor.")
            return TrialAppointmentListResponse(
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
        lead_id: str | UUID,
        data: TrialAppointmentCreate,
    ) -> TrialAppointmentMutationResult:
        request = data.model_dump(mode="json", exclude={"operation_id"}, exclude_unset=True)
        request.setdefault("location", data.location)
        return self._mutate(studio_id, actor_id, lead_id, None, data.operation_id, None, request)

    def update(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        lead_id: str | UUID,
        appointment_id: str | UUID,
        data: TrialAppointmentUpdate,
    ) -> TrialAppointmentMutationResult:
        request = data.model_dump(
            mode="json", exclude={"operation_id", "expected_revision"}, exclude_unset=True
        )
        return self._mutate(
            studio_id,
            actor_id,
            lead_id,
            appointment_id,
            data.operation_id,
            data.expected_revision,
            request,
        )

    def _mutate(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        lead_id: str | UUID,
        appointment_id: str | UUID | None,
        operation_id: UUID,
        expected_revision: int | None,
        request: dict,
    ) -> TrialAppointmentMutationResult:
        result = self._call(
            "mutate_lead_trial_appointment_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_lead_id": str(lead_id),
                "p_appointment_id": str(appointment_id) if appointment_id is not None else None,
                "p_operation_id": str(operation_id),
                "p_expected_revision": expected_revision,
                "p_request": request,
            },
        )
        try:
            response = TrialAppointmentMutationResult.model_validate(result)
            self._check_identity(response.payload, studio_id, lead_id, appointment_id)
            if response.operation_id != operation_id:
                raise ValueError("Invalid operation receipt.")
            return response
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
