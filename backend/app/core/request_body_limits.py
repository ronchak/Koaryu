from __future__ import annotations

from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi.responses import JSONResponse

from app.core.error_handlers import error_response_payload
from app.core.upload_limits import (
    CSV_IMPORT_MAX_BYTES,
    CSV_IMPORT_MAX_CELL_CHARS,
    CSV_IMPORT_MAX_COLUMNS,
    STUDENT_PHOTO_MAX_BYTES,
)

ASGIScope = dict[str, Any]
ASGIMessage = dict[str, Any]
ASGIReceive = Callable[[], Awaitable[ASGIMessage]]
ASGISend = Callable[[ASGIMessage], Awaitable[None]]
ASGIApp = Callable[[ASGIScope, ASGIReceive, ASGISend], Awaitable[None]]

STRIPE_WEBHOOK_REQUEST_MAX_BYTES = 1024 * 1024
DEFAULT_API_REQUEST_MAX_BYTES = 1024 * 1024
STUDENT_PHOTO_MULTIPART_ALLOWANCE_BYTES = 1024 * 1024
STUDENT_PHOTO_REQUEST_MAX_BYTES = (
    STUDENT_PHOTO_MAX_BYTES + STUDENT_PHOTO_MULTIPART_ALLOWANCE_BYTES
)

# JSON.stringify may encode a control character from a valid CSV header as a
# six-byte `\uXXXX` escape. Mapping keys are limited by the same 100-column,
# 32,000-character contract as the parsed CSV. Two MiB then covers the fixed
# options, <=255-character idempotency keys, multipart framing, and filenames.
JSON_MAX_ESCAPED_BYTES_PER_CHARACTER = 6
CSV_IMPORT_MAPPING_JSON_MAX_BYTES = (
    CSV_IMPORT_MAX_COLUMNS
    * CSV_IMPORT_MAX_CELL_CHARS
    * JSON_MAX_ESCAPED_BYTES_PER_CHARACTER
)
CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES = 2 * 1024 * 1024
CSV_IMPORT_REQUEST_MAX_BYTES = (
    CSV_IMPORT_MAX_BYTES
    + CSV_IMPORT_MAPPING_JSON_MAX_BYTES
    + CSV_IMPORT_MULTIPART_METADATA_ALLOWANCE_BYTES
)


def request_body_limit_for_route(
    *,
    path: str,
    method: str,
    api_v1_prefix: str,
) -> int | None:
    normalized_method = method.upper()
    if normalized_method not in {"POST", "PATCH", "PUT", "DELETE"}:
        return None

    prefix = api_v1_prefix.rstrip("/")
    normalized_path = path.rstrip("/") or "/"
    if normalized_path != prefix and not normalized_path.startswith(f"{prefix}/"):
        return None
    relative_path = normalized_path.removeprefix(prefix)

    if normalized_method == "POST" and relative_path in {
        "/webhooks/stripe/platform",
        "/webhooks/stripe/connect",
    }:
        return STRIPE_WEBHOOK_REQUEST_MAX_BYTES

    if normalized_method == "POST" and relative_path in {
        "/students/import/parse",
        "/students/import/validate",
        "/students/import/execute",
    }:
        return CSV_IMPORT_REQUEST_MAX_BYTES

    segments = relative_path.strip("/").split("/")
    if (
        normalized_method == "POST"
        and len(segments) == 3
        and segments[0] == "students"
        and segments[1]
        and segments[2] == "photo"
    ):
        return STUDENT_PHOTO_REQUEST_MAX_BYTES

    return DEFAULT_API_REQUEST_MAX_BYTES


def _content_length(scope: ASGIScope) -> int | None:
    raw_values = [
        value.strip()
        for name, value in scope.get("headers", [])
        if name.lower() == b"content-length"
    ]
    if not raw_values:
        return None
    if len(raw_values) != 1 or not raw_values[0].isdigit():
        raise ValueError("Invalid Content-Length header.")
    return int(raw_values[0])


async def _send_error(
    scope: ASGIScope,
    receive: ASGIReceive,
    send: ASGISend,
    *,
    status_code: int,
    detail: str,
) -> None:
    response = JSONResponse(
        status_code=status_code,
        content=error_response_payload(detail=detail, status_code=status_code),
    )
    await response(scope, receive, send)


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, *, api_v1_prefix: str):
        self.app = app
        self.api_v1_prefix = api_v1_prefix

    async def __call__(
        self,
        scope: ASGIScope,
        receive: ASGIReceive,
        send: ASGISend,
    ) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        max_bytes = request_body_limit_for_route(
            path=scope.get("path", ""),
            method=scope.get("method", ""),
            api_v1_prefix=self.api_v1_prefix,
        )
        if max_bytes is None:
            await self.app(scope, receive, send)
            return

        try:
            declared_bytes = _content_length(scope)
        except ValueError:
            await _send_error(
                scope,
                receive,
                send,
                status_code=400,
                detail="Invalid Content-Length header.",
            )
            return

        if declared_bytes is not None and declared_bytes > max_bytes:
            await _send_error(
                scope,
                receive,
                send,
                status_code=413,
                detail="Request body is too large.",
            )
            return

        messages: deque[ASGIMessage] = deque()
        received_bytes = 0
        while True:
            message = await receive()
            messages.append(message)
            if message.get("type") == "http.disconnect":
                break
            if message.get("type") != "http.request":
                continue

            chunk = message.get("body", b"")
            received_bytes += len(chunk)
            if received_bytes > max_bytes:
                await _send_error(
                    scope,
                    receive,
                    send,
                    status_code=413,
                    detail="Request body is too large.",
                )
                return
            if not message.get("more_body", False):
                break

        async def replay_receive() -> ASGIMessage:
            if messages:
                return messages.popleft()
            return await receive()

        await self.app(scope, replay_receive, send)
