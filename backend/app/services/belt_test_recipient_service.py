"""Recipient RPC boundary; SQL owns eligibility, atomicity, receipts, and events."""

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

from app.schemas.belt_test import BeltTestModel
from app.schemas.belt_test_recipient import (
    BeltTestRecipientApprovalResponse,
    BeltTestRecipientApprove,
    BeltTestRecipientListResponse,
    BeltTestRecipientResponse,
    BeltTestRecipientRevoke,
)
from app.schemas.trial_appointment import UTCInstant

ADMIN_REQUIRED_DETAIL = "Only studio admins can manage belt-test recipients."
UNAVAILABLE_DETAIL = "Belt-test recipients are temporarily unavailable. Try again shortly."
INVALID_CURSOR_DETAIL = "Invalid belt-test recipient cursor."
_ERRORS = {
    ("42501", "AUTOMATION_ADMIN_REQUIRED"): (403, ADMIN_REQUIRED_DETAIL),
    ("P0002", "AUTOMATION_NOT_FOUND"): (404, "Belt-test event or recipient not found."),
    ("22023", "AUTOMATION_INVALID_REQUEST"): (422, "Invalid belt-test recipient request."),
    ("P0001", "AUTOMATION_REVISION_CONFLICT"): (
        409,
        "The belt-test event or recipient changed. Reload it before saving.",
    ),
    ("P0001", "AUTOMATION_OPERATION_CONFLICT"): (
        409,
        "This belt-test recipient operation was already used for a different request.",
    ),
    ("P0001", "AUTOMATION_STATE_CONFLICT"): (
        409,
        "These belt-test recipients cannot be changed in their current state.",
    ),
    ("P0001", "AUTOMATION_STUDIO_BUSY"): (
        409,
        "The studio is busy. Try the belt-test recipient request again shortly.",
    ),
}


class _Cursor(BeltTestModel):
    created_at: UTCInstant
    id: UUID


class BeltTestRecipientApprovalResult(BeltTestModel):
    payload: BeltTestRecipientApprovalResponse
    operation_id: UUID
    replayed: StrictBool


class BeltTestRecipientMutationResult(BeltTestModel):
    payload: BeltTestRecipientResponse
    operation_id: UUID
    replayed: StrictBool


class _ListPayload(BeltTestModel):
    items: Annotated[list[BeltTestRecipientResponse], Field(strict=True, max_length=100)]
    next_cursor: _Cursor | None
    has_more: StrictBool


class _ListEnvelope(BeltTestModel):
    payload: _ListPayload


class _ReadEnvelope(BeltTestModel):
    payload: BeltTestRecipientResponse


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate recipient cursor key.")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("Nonfinite recipient cursor value.")


def _decode_cursor(token: str | None) -> dict | None:
    if token is None:
        return None
    try:
        if (
            not isinstance(token, str)
            or not 1 <= len(token) <= 512
            or not re.fullmatch(r"[A-Za-z0-9_-]+", token)
        ):
            raise ValueError("Invalid recipient cursor encoding.")
        raw = base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != token:
            raise ValueError("Invalid recipient cursor encoding.")
        value = json.loads(raw, object_pairs_hook=_unique_object, parse_constant=_reject_constant)
        return _Cursor.model_validate(value).model_dump(mode="json")
    except (ValueError, TypeError, binascii.Error, UnicodeError):
        raise HTTPException(422, INVALID_CURSOR_DETAIL) from None


def _encode_cursor(cursor: _Cursor) -> str:
    raw = json.dumps(cursor.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


class BeltTestRecipientService:
    def __init__(self, supabase: Any):
        self.supabase = supabase

    def _call(self, name: str, params: dict) -> dict:
        try:
            result = self.supabase.rpc(name, params).execute().data
            if not isinstance(result, dict):
                raise ValueError("Invalid belt-test recipient RPC envelope.")
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
        row: BeltTestRecipientResponse,
        studio_id: str | UUID,
        event_id: str | UUID,
        recipient_id: str | UUID | None = None,
    ) -> None:
        if (
            row.studio_id != UUID(str(studio_id))
            or row.event_id != UUID(str(event_id))
            or (recipient_id is not None and row.id != UUID(str(recipient_id)))
        ):
            raise ValueError("Invalid belt-test recipient identity.")

    def get_recipient(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID,
        recipient_id: str | UUID,
    ) -> BeltTestRecipientResponse:
        result = self._call(
            "get_belt_test_recipient_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_event_id": str(event_id),
                "p_recipient_id": str(recipient_id),
            },
        )
        try:
            payload = _ReadEnvelope.model_validate(result).payload
            self._check_identity(payload, studio_id, event_id, recipient_id)
            return payload
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def list_recipients(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID,
        limit: int = 50,
        cursor: str | None = None,
    ) -> BeltTestRecipientListResponse:
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "Invalid belt-test recipient page limit.")
        decoded_cursor = _decode_cursor(cursor)
        result = self._call(
            "list_belt_test_recipients_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_event_id": str(event_id),
                "p_limit": limit,
                "p_cursor": decoded_cursor,
            },
        )
        try:
            payload = _ListEnvelope.model_validate(result).payload
            if len(payload.items) > limit or payload.has_more != (payload.next_cursor is not None):
                raise ValueError("Invalid belt-test recipient page.")
            for row in payload.items:
                self._check_identity(row, studio_id, event_id)
            if payload.next_cursor is not None and (
                not payload.items
                or payload.next_cursor.id != payload.items[-1].id
                or payload.next_cursor.created_at != payload.items[-1].created_at
            ):
                raise ValueError("Invalid belt-test recipient cursor.")
            return BeltTestRecipientListResponse(
                items=payload.items,
                next_cursor=_encode_cursor(payload.next_cursor) if payload.next_cursor else None,
                has_more=payload.has_more,
            )
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def approve_recipients(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID,
        data: BeltTestRecipientApprove,
    ) -> BeltTestRecipientApprovalResult:
        result = self._call(
            "approve_belt_test_recipients_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_event_id": str(event_id),
                "p_operation_id": str(data.operation_id),
                "p_expected_event_revision": data.expected_event_revision,
                "p_recipients": [row.model_dump(mode="json") for row in data.recipients],
            },
        )
        try:
            response = BeltTestRecipientApprovalResult.model_validate(result)
            if (
                response.operation_id != data.operation_id
                or response.payload.event_revision != data.expected_event_revision
            ):
                raise ValueError("Invalid belt-test recipient operation receipt.")
            expected_pairs = {
                (row.student_id, row.student_program_membership_id) for row in data.recipients
            }
            pairs = set()
            recipient_ids = set()
            for row in response.payload.items:
                self._check_identity(row, studio_id, event_id)
                if (
                    row.state != "approved"
                    or row.approved_schedule_revision != response.payload.schedule_revision
                ):
                    raise ValueError("Invalid belt-test recipient approval.")
                pairs.add((row.student_id, row.student_program_membership_id))
                recipient_ids.add(row.id)
            if (
                len(response.payload.items) != len(data.recipients)
                or len(recipient_ids) != len(response.payload.items)
                or len(pairs) != len(response.payload.items)
                or pairs != expected_pairs
            ):
                raise ValueError("Invalid belt-test recipient approval batch.")
            return response
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None

    def revoke_recipient(
        self,
        studio_id: str | UUID,
        actor_id: str | UUID,
        event_id: str | UUID,
        recipient_id: str | UUID,
        data: BeltTestRecipientRevoke,
    ) -> BeltTestRecipientMutationResult:
        result = self._call(
            "revoke_belt_test_recipient_v1",
            {
                "p_studio_id": str(studio_id),
                "p_actor_id": str(actor_id),
                "p_event_id": str(event_id),
                "p_recipient_id": str(recipient_id),
                "p_operation_id": str(data.operation_id),
                "p_expected_revision": data.expected_revision,
            },
        )
        try:
            response = BeltTestRecipientMutationResult.model_validate(result)
            self._check_identity(response.payload, studio_id, event_id, recipient_id)
            if response.operation_id != data.operation_id or response.payload.state != "revoked":
                raise ValueError("Invalid belt-test recipient revocation receipt.")
            return response
        except (ValidationError, ValueError, TypeError):
            raise HTTPException(503, UNAVAILABLE_DETAIL) from None
