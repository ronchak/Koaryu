"""One deadline across auth, admission, provider calls, and response transfer."""
import asyncio
import json
import logging
import os
import re
import time
from contextvars import ContextVar

from starlette.responses import JSONResponse

request_deadline: ContextVar[float | None] = ContextVar("request_deadline", default=None)
logger = logging.getLogger("uvicorn.error.request_timing")


def is_bulk_request(path: str, method: str) -> bool:
    return (
        path.startswith(("/students/import/", "/students/bulk/", "/reports/exports/", "/internal/", "/demo/"))
        or method == "POST" and path in {
            "/schedule/window/materialize", "/schedule/sessions/materialize",
            "/schedule/sessions/generate-week", "/schedule/attendance/bulk",
        }
        or method == "POST" and re.fullmatch(r"/students/[^/]+/photo", path) is not None
    )


class RequestDeadlineMiddleware:
    def __init__(self, app, api_v1_prefix="/api/v1", interactive_seconds=30.0, bulk_seconds=120.0):
        self.app = app
        self.prefix = api_v1_prefix
        self.interactive_seconds = interactive_seconds
        self.bulk_seconds = bulk_seconds
        commit = os.environ.get("RENDER_GIT_COMMIT", "")
        self.release = commit if re.fullmatch(r"[0-9a-f]{40}", commit) else None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith(self.prefix + "/"):
            return await self.app(scope, receive, send)
        started = time.monotonic()
        path = scope["path"][len(self.prefix):]
        budget = self.bulk_seconds if is_bulk_request(path, scope["method"]) else self.interactive_seconds
        deadline = started + budget
        token = request_deadline.set(deadline)
        response_started = False
        response_status = 500
        timed_out = False
        timeout = asyncio.timeout_at(deadline)

        async def timed_send(message):
            nonlocal response_started, response_status
            if message["type"] == "http.response.start":
                response_started = True
                response_status = message["status"]
                headers = list(message.get("headers", []))
                headers.append((b"server-timing", f"koaryu_request;dur={(time.monotonic() - started) * 1000:.1f}".encode()))
                message = {**message, "headers": headers}
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                # Response cleanup is allowed to finish after the client has its body.
                timeout.reschedule(None)
                request_deadline.set(None)

        try:
            async with timeout:
                await self.app(scope, receive, timed_send)
        except TimeoutError:
            if not timeout.expired():
                raise
            timed_out = True
            if response_started:
                # Closing an incomplete body preserves the client's unknown-write outcome.
                raise
            response_status = 504
            response = JSONResponse({"detail": "Request timed out. Please retry.", "error": {"code": "http_504", "status_code": 504}},
                                    status_code=504, headers={"Cache-Control": "no-store", "Retry-After": "1"})
            await response(scope, receive, send)
        finally:
            request_deadline.reset(token)
            route = getattr(scope.get("route"), "path", "unmatched")
            # Route templates contain parameter names, never raw URLs or identifiers.
            logger.info("koaryu_request_timing %s", json.dumps({
                "release": self.release, "route": route,
                "method": scope["method"] if scope["method"] in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} else "OTHER",
                "status": response_status,
                "duration_ms": round((time.monotonic() - started) * 1000), "timed_out": timed_out,
            }, separators=(",", ":")))
