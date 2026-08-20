from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from app.core.config import get_settings
from app.schemas.student import (
    StudentListSortDir,
    StudentListSortKey,
    StudentRosterPageResponse,
    StudentRosterRowResponse,
    StudentStatus,
)
from app.services.student_list_query import normalize_student_list_search
from app.services.supabase_rpc import first_rpc_row


CURSOR_VERSION = 1
CURSOR_NULL_POLICY = "primary:nulls_last_asc_nulls_first_desc;tie:asc"
CURSOR_TIE_BREAKER = "id"
ROSTER_RPC_NAME = "list_student_roster"
_MAX_CURSOR_LENGTH = 4096


class StudentRosterCursorError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        recover_to: str = "first",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.recover_to = recover_to


@dataclass(frozen=True)
class StudentRosterQuery:
    studio_id: str
    full_roster: bool
    search: str
    status: Optional[str]
    program_id: Optional[str]
    inactivity_days: Optional[int]
    new_student_window: Optional[str]
    today: Optional[str]
    sort_by: str
    sort_dir: str
    page_size: int

    @classmethod
    def build(
        cls,
        studio_id: str,
        *,
        full_roster: bool = False,
        search: Optional[str] = None,
        status: Optional[StudentStatus] = None,
        program_id: Optional[str] = None,
        inactivity_days: Optional[int] = None,
        new_student_window: Optional[str] = None,
        today: Optional[date] = None,
        sort_by: StudentListSortKey,
        sort_dir: StudentListSortDir,
        page_size: int,
    ) -> "StudentRosterQuery":
        normalized_program_id: Optional[str] = None
        if program_id:
            try:
                normalized_program_id = str(uuid.UUID(program_id))
            except (TypeError, ValueError) as exc:
                raise ValueError("program_id must be a UUID") from exc

        if inactivity_days not in (None, 14, 30, 90):
            raise ValueError("inactivity_days must be one of 14, 30, or 90")
        if new_student_window not in (None, "14", "30", "90", "ytd"):
            raise ValueError("new_student_window must be one of 14, 30, 90, or ytd")
        if (inactivity_days is not None or new_student_window is not None) and today is None:
            raise ValueError("today is required for a derived roster filter")

        return cls(
            studio_id=str(studio_id),
            full_roster=bool(full_roster),
            search=normalize_student_list_search(search),
            status=status,
            program_id=normalized_program_id,
            inactivity_days=inactivity_days,
            new_student_window=new_student_window,
            today=today.isoformat() if today else None,
            sort_by=sort_by,
            sort_dir=sort_dir,
            page_size=page_size,
        )

    def binding(self) -> dict[str, Any]:
        return {
            "studio_id": self.studio_id,
            "full_roster": self.full_roster,
            "search": self.search,
            "status": self.status,
            "program_id": self.program_id,
            "inactivity_days": self.inactivity_days,
            "new_student_window": self.new_student_window,
            "today": self.today,
            "sort_by": self.sort_by,
            "sort_dir": self.sort_dir,
            "page_size": self.page_size,
            "null_policy": CURSOR_NULL_POLICY,
            "tie_breaker": CURSOR_TIE_BREAKER,
        }

    def rpc_params(self) -> dict[str, Any]:
        return {
            "p_studio_id": self.studio_id,
            "p_search": self.search or None,
            "p_status": self.status,
            "p_program_id": self.program_id,
            "p_inactivity_days": self.inactivity_days,
            "p_new_student_window": self.new_student_window,
            "p_today": self.today,
            "p_sort_by": self.sort_by,
            "p_sort_dir": self.sort_dir,
            "p_page_size": self.page_size,
        }


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _cursor_key() -> bytes:
    # SUPABASE_SERVICE_ROLE_KEY is already mandatory server-only runtime
    # configuration. It never enters the token or any response payload.
    secret = get_settings().SUPABASE_SERVICE_ROLE_KEY
    if not secret:
        raise StudentRosterCursorError(
            "cursor_integrity_unavailable",
            "Roster cursor integrity is unavailable.",
        )
    return secret.encode("utf-8")


def _query_fingerprint(query: StudentRosterQuery) -> str:
    """Return a keyed, non-reversible binding for the complete query."""
    return hmac.new(_cursor_key(), _canonical_json(query.binding()), hashlib.sha256).hexdigest()


def encode_roster_cursor(
    query: StudentRosterQuery,
    *,
    ordinal: int,
    direction: str,
    anchor: dict[str, Any],
) -> str:
    if direction not in {"next", "previous"} or ordinal < 1:
        raise ValueError("invalid roster cursor state")
    payload = {
        "version": CURSOR_VERSION,
        "query_fingerprint": _query_fingerprint(query),
        "ordinal": ordinal,
        "direction": direction,
        "anchor": {
            "id": str(anchor["id"]),
            "revision": str(anchor["revision"]),
        },
    }
    encoded_payload = base64.urlsafe_b64encode(_canonical_json(payload)).rstrip(b"=").decode("ascii")
    signature = hmac.new(_cursor_key(), encoded_payload.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded_payload}.{signature}"


def decode_roster_cursor(token: str, query: StudentRosterQuery) -> dict[str, Any]:
    if not isinstance(token, str) or not token or len(token) > _MAX_CURSOR_LENGTH or token.count(".") != 1:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor is malformed.")

    encoded_payload, signature = token.split(".", 1)
    try:
        expected = hmac.new(_cursor_key(), encoded_payload.encode("ascii"), hashlib.sha256).hexdigest()
    except UnicodeEncodeError as exc:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor is malformed.") from exc
    if not hmac.compare_digest(signature, expected):
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor integrity check failed.")

    try:
        padded = encoded_payload + "=" * (-len(encoded_payload) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")))
    except (ValueError, UnicodeDecodeError, UnicodeEncodeError, json.JSONDecodeError) as exc:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor is malformed.") from exc

    if not isinstance(payload, dict) or set(payload) != {
        "version", "query_fingerprint", "ordinal", "direction", "anchor"
    } or payload.get("version") != CURSOR_VERSION:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor version is unsupported.")
    if payload.get("query_fingerprint") != _query_fingerprint(query):
        raise StudentRosterCursorError(
            "cursor_query_mismatch",
            "Roster cursor does not match the current query.",
        )
    if payload.get("direction") not in {"next", "previous"}:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor direction is invalid.")
    if not isinstance(payload.get("ordinal"), int) or payload["ordinal"] < 1:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor ordinal is invalid.")

    anchor = payload.get("anchor")
    if not isinstance(anchor, dict) or set(anchor) != {"id", "revision"}:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor boundary is missing.")
    try:
        uuid.UUID(str(anchor["id"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor boundary is invalid.") from exc
    if not isinstance(anchor.get("revision"), str) or not anchor["revision"]:
        raise StudentRosterCursorError("invalid_cursor", "Roster cursor revision is invalid.")
    return payload


def _cursor_error_from_rpc(row: dict[str, Any]) -> Optional[StudentRosterCursorError]:
    error = row.get("cursor_error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    if code == "stale_cursor":
        return StudentRosterCursorError(
            "stale_cursor",
            "Roster cursor is stale because the boundary row changed or was removed.",
            recover_to="nearest_prior",
        )
    return StudentRosterCursorError("invalid_cursor", "Roster cursor could not be used.")


def _anchor_from_row(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    if set(value) != {"id", "revision"}:
        return None
    try:
        uuid.UUID(str(value["id"]))
    except (TypeError, ValueError):
        return None
    if not isinstance(value["revision"], str) or not value["revision"]:
        return None
    return value


def fetch_student_roster_page(
    supabase: Any,
    query: StudentRosterQuery,
    *,
    cursor: Optional[str],
) -> StudentRosterPageResponse:
    cursor_payload: Optional[dict[str, Any]] = None
    params = query.rpc_params()
    if cursor:
        cursor_payload = decode_roster_cursor(cursor, query)
        anchor = cursor_payload["anchor"]
        params.update(
            {
                "p_cursor_direction": cursor_payload["direction"],
                "p_cursor_id": anchor["id"],
                "p_cursor_revision": anchor["revision"],
            }
        )

    result = supabase.rpc(ROSTER_RPC_NAME, params).execute()
    row = first_rpc_row(result)
    if row is None:
        raise RuntimeError("Roster RPC returned no result.")
    cursor_error = _cursor_error_from_rpc(row)
    if cursor_error:
        raise cursor_error

    items = row.get("items")
    if not isinstance(items, list):
        raise RuntimeError("Roster RPC returned an invalid page projection.")
    page_ordinal = int(cursor_payload["ordinal"]) if cursor_payload else 1
    has_next = bool(row.get("has_next"))
    has_previous = bool(row.get("has_previous"))
    next_anchor = _anchor_from_row(row.get("next_anchor"))
    previous_anchor = _anchor_from_row(row.get("previous_anchor"))

    next_cursor = (
        encode_roster_cursor(query, ordinal=page_ordinal + 1, direction="next", anchor=next_anchor)
        if has_next and next_anchor
        else None
    )
    previous_cursor = (
        encode_roster_cursor(query, ordinal=page_ordinal - 1, direction="previous", anchor=previous_anchor)
        if has_previous and previous_anchor
        else None
    )
    return StudentRosterPageResponse(
        items=[StudentRosterRowResponse.model_validate(item) for item in items],
        total=int(row.get("total") or 0),
        page_size=query.page_size,
        page_ordinal=page_ordinal,
        has_next=has_next,
        next_cursor=next_cursor,
        has_previous=has_previous,
        previous_cursor=previous_cursor,
    )
