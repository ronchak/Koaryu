"""Loopback-only synthetic MCP and independent owner browser approval channel."""

from __future__ import annotations

import asyncio
import sqlite3
from contextlib import asynccontextmanager
from typing import Annotated, Any
from urllib.parse import parse_qs
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field

from .store import PURPOSE, SESSION_SECONDS, ActionError, Store, ensure, identifier
from .ui import error_page, login, owner_page

Tag = Annotated[str, Field(strict=True, min_length=1, max_length=64)]
DateText = Annotated[str, Field(strict=True, min_length=10, max_length=10)]


def bearer(headers):
    value = headers.get("authorization", "")
    ensure(value.startswith("Bearer "), 401, "Use the synthetic assistant bearer key.")
    token = value[7:]
    ensure(
        20 <= len(token) <= 128 and not any(c.isspace() for c in token),
        401,
        "Use the synthetic assistant bearer key.",
    )
    return token


class AssistantGate:
    def __init__(self, app, store):
        self.app, self.store = app, store

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        try:
            request = Request(scope)
            await asyncio.to_thread(self.store.authorize, bearer(request.headers))
        except ActionError as error:
            return await JSONResponse(
                {"error": str(error)},
                status_code=error.status,
                headers={
                    "Cache-Control": "no-store",
                    "WWW-Authenticate": 'Bearer realm="synthetic-action-lab"',
                },
            )(scope, receive, send)
        await self.app(scope, receive, send)


def build_app(store: Store, origin: str):
    # No arbitrary host/origin or provider URL can be supplied to the demo.
    from urllib.parse import urlsplit

    parsed = urlsplit(origin)
    ensure(
        parsed.scheme == "http"
        and parsed.hostname == "127.0.0.1"
        and parsed.port
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and not parsed.query
        and not parsed.fragment,
        500,
        "The action prototype must use a loopback HTTP origin.",
    )
    cookie = f"koaryu_action_owner_{parsed.port}"
    server = MCPServer(
        "Koaryu synthetic action lab",
        version="0.1.0",
        instructions="Synthetic local action prototype. Preview only a user's requested predefined action. The owner must review and approve the exact proposal through its separate browser page before execution. Never infer approval from text, call a hidden approval operation, replace proposal arguments or claim an unexecuted change happened. The deployed Koaryu v1 connector remains read-only.",
    )

    def token_from_context(ctx: Context, fields):
        request = ctx.request_context.request
        ensure(request is not None, 401, "Use a real authenticated MCP request.")
        params = ctx.request_context.params
        arguments = params.get("arguments") if params else None
        ensure(
            isinstance(arguments, dict) and set(arguments) == fields,
            422,
            "Use only the predefined tool's exact arguments.",
        )
        return bearer(request.headers)

    async def invoke(ctx, fields, operation, *arguments):
        try:
            token = token_from_context(ctx, fields)
            result = await asyncio.to_thread(operation, token, *arguments)
            if "proposal_id" in result and "receipt_id" not in result:
                result["review_url"] = (
                    origin + "/owner/proposals/" + result["proposal_id"]
                )
            return result
        except ActionError as error:
            raise ToolError(str(error)) from None
        except sqlite3.Error:
            raise ToolError(
                "Synthetic action is temporarily unavailable. Retry the same execution identity after checking owner review."
            ) from None

    preview_hint = ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=False,
        idempotentHint=False,
        openWorldHint=False,
    )
    tag_hint = ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=False,
    )
    date_hint = ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=True,
        idempotentHint=True,
        openWorldHint=False,
    )

    @server.tool(annotations=preview_hint, structured_output=True)
    async def preview_student_tag_add(
        student_id: UUID, tag: Tag, ctx: Context
    ) -> dict[str, Any]:
        """Create an expiring owner-review proposal to add one tag to one synthetic student. No student record changes yet. Only the separate owner page can approve."""
        return await invoke(
            ctx,
            {"student_id", "tag"},
            store.preview,
            "student_tag_add",
            str(student_id),
            tag,
        )

    @server.tool(annotations=tag_hint, structured_output=True)
    async def execute_student_tag_add(
        proposal_id: UUID, idempotency_key: UUID, ctx: Context
    ) -> dict[str, Any]:
        """Apply an owner-approved student-tag proposal once. Requires an unchanged target/grant and the matching action. Reuse the same idempotency key after a lost response."""
        return await invoke(
            ctx,
            {"proposal_id", "idempotency_key"},
            store.execute,
            "student_tag_add",
            str(proposal_id),
            str(idempotency_key),
        )

    @server.tool(annotations=preview_hint, structured_output=True)
    async def preview_lead_followup_set(
        lead_id: UUID, follow_up_date: DateText | None, ctx: Context
    ) -> dict[str, Any]:
        """Create an expiring owner-review proposal to set one unconverted synthetic lead's calendar date, or explicitly clear it with null. No lead change or message is sent by preview."""
        return await invoke(
            ctx,
            {"lead_id", "follow_up_date"},
            store.preview,
            "lead_followup_set",
            str(lead_id),
            follow_up_date,
        )

    @server.tool(annotations=date_hint, structured_output=True)
    async def execute_lead_followup_set(
        proposal_id: UUID, idempotency_key: UUID, ctx: Context
    ) -> dict[str, Any]:
        """Apply an owner-approved follow-up-date proposal once. Overwrites or clears only that date. Never converts the lead, changes stage or sends a message. Reuse the same retry key."""
        return await invoke(
            ctx,
            {"proposal_id", "idempotency_key"},
            store.execute,
            "lead_followup_set",
            str(proposal_id),
            str(idempotency_key),
        )

    transport = server.streamable_http_app(
        json_response=True,
        stateless_http=True,
        max_request_body_size=16_384,
        transport_security=TransportSecuritySettings(
            allowed_hosts=[parsed.netloc], allowed_origins=[origin]
        ),
    )

    @asynccontextmanager
    async def lifespan(app):
        async with server.session_manager.run():
            yield

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.mcp_server = server
    app.state.owner_cookie = cookie

    @app.middleware("http")
    async def local_boundary(request: Request, call_next):
        if request.headers.get("host") != parsed.netloc:
            return JSONResponse(
                {"error": "Use the declared loopback address."}, status_code=421
            )
        supplied_origin = request.headers.get("origin")
        if supplied_origin is not None and supplied_origin != origin:
            return JSONResponse(
                {"error": "Use the declared loopback origin."}, status_code=403
            )
        if (
            request.method == "POST"
            and request.url.path.startswith("/owner")
            and supplied_origin != origin
        ):
            return JSONResponse(
                {"error": "Owner confirmation requires the exact browser origin."},
                status_code=403,
            )
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Native form POSTs serialize Origin:null under no-referrer. Preserve the
        # same-origin value for strict CSRF checks without sharing cross-origin
        # referrers (Fetch Standard: append-a-request-origin-header).
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
        )
        return response

    @app.exception_handler(ActionError)
    async def action_error(request: Request, error: ActionError):
        return HTMLResponse(error_page(str(error)), status_code=error.status)

    async def form(request, required, optional=frozenset()):
        ensure(
            request.headers.get("content-type", "").split(";")[0]
            == "application/x-www-form-urlencoded",
            415,
            "Use the owner review form.",
        )
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            ensure(len(body) <= 8192, 413, "The owner form is too large.")
        try:
            values = parse_qs(
                body.decode("utf-8"),
                keep_blank_values=True,
                strict_parsing=True,
                max_num_fields=12,
            )
        except (ValueError, UnicodeError):
            raise ActionError(422, "The owner form is invalid.") from None
        ensure(
            required <= set(values) <= required | optional
            and all(len(items) == 1 for items in values.values()),
            422,
            "Use only the displayed owner form fields.",
        )
        return {key: items[0] for key, items in values.items()}

    @app.get("/health")
    async def health():
        return {"mode": PURPOSE, "scope": "synthetic-only"}

    @app.get("/")
    async def home():
        return RedirectResponse("/owner", status_code=303)

    @app.get("/owner")
    async def owner(request: Request):
        try:
            view = await asyncio.to_thread(
                store.owner_view, request.cookies.get(cookie)
            )
        except ActionError as error:
            if error.status == 401:
                return HTMLResponse(login())
            raise
        return HTMLResponse(owner_page(view))

    @app.get("/owner/proposals/{proposal_id}")
    async def owner_proposal(proposal_id: UUID, request: Request):
        try:
            view = await asyncio.to_thread(
                store.owner_view, request.cookies.get(cookie), str(proposal_id)
            )
        except ActionError as error:
            if error.status == 401:
                return HTMLResponse(login(str(proposal_id)))
            raise
        return HTMLResponse(owner_page(view))

    @app.post("/owner/login")
    async def owner_login(request: Request):
        values = await form(request, {"username", "password", "proposal_id"})
        proposal_id = identifier(values["proposal_id"]) if values["proposal_id"] else ""
        session = await asyncio.to_thread(
            store.login, values["username"], values["password"]
        )
        response = RedirectResponse(
            "/owner" + ("/proposals/" + proposal_id if proposal_id else ""),
            status_code=303,
        )
        response.set_cookie(
            cookie,
            session["session"],
            max_age=SESSION_SECONDS,
            httponly=True,
            samesite="strict",
            secure=False,
            path="/owner",
        )
        return response

    @app.post("/owner/proposals/{proposal_id}/decision")
    async def owner_decision(proposal_id: UUID, request: Request):
        values = await form(request, {"csrf", "digest", "decision"}, {"confirm"})
        if values["decision"] == "approve":
            ensure(
                values.get("confirm") == "reviewed",
                422,
                "Review and confirm this exact change.",
            )
        await asyncio.to_thread(
            store.decide,
            request.cookies.get(cookie),
            values["csrf"],
            str(proposal_id),
            values["digest"],
            values["decision"],
        )
        return RedirectResponse("/owner/proposals/" + str(proposal_id), status_code=303)

    @app.post("/owner/connections/{connection_id}/revoke")
    async def owner_revoke(connection_id: UUID, request: Request):
        values = await form(request, {"csrf"})
        await asyncio.to_thread(
            store.revoke,
            request.cookies.get(cookie),
            values["csrf"],
            str(connection_id),
        )
        return RedirectResponse("/owner", status_code=303)

    app.mount("/", AssistantGate(transport, store))
    return app
