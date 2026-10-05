"""Admin automation routes, public opt-out, and the isolated scheduler boundary."""

import base64
import hashlib
import time
from typing import Annotated
from urllib.parse import parse_qs

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from starlette.concurrency import run_in_threadpool

from app.api.v1.endpoints.internal import _verify_secret
from app.core.config import get_settings
from app.core.deps import (
    ProviderDependency,
    get_current_user_id,
    get_requested_studio_id,
    get_supabase,
    run_supabase_operation,
)
from app.schemas.automation import (
    MissedClassActivityResponse,
    MissedClassPreviewRequest,
    MissedClassPreviewResponse,
    MissedClassProcessRequest,
    MissedClassProcessResponse,
    MissedClassRuleUpdate,
    MissedClassSettingsResponse,
)
from app.services.automation_service import (
    ADMIN_REQUIRED_DETAIL,
    WORK_BUDGET_SECONDS,
    AutomationService,
    process_due_missed_class_automations,
)
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)

router = APIRouter(prefix="/automations", tags=["automations"])
worker_router = APIRouter(prefix="/internal/automations", tags=["internal"])


def _admin_studio(client, user_id: str, requested_studio_id: str | None) -> str:
    membership = resolve_write_staff_role_for_user(client, user_id, requested_studio_id)
    if membership.get("role") != "admin":
        raise HTTPException(403, ADMIN_REQUIRED_DETAIL)
    ensure_platform_subscription_access(client, membership["studio_id"])
    return membership["studio_id"]


@router.get("/missed-class", response_model=MissedClassSettingsResponse)
async def get_missed_class_rule(
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return AutomationService(client, get_settings()).get_rule(studio_id, user_id)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.put("/missed-class", response_model=MissedClassSettingsResponse)
async def save_missed_class_rule(
    data: MissedClassRuleUpdate,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return AutomationService(client, get_settings()).save_rule(studio_id, user_id, data)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("/missed-class/preview", response_model=MissedClassPreviewResponse)
async def preview_missed_class_rule(
    data: MissedClassPreviewRequest,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return AutomationService(client, get_settings()).preview(studio_id, user_id, data)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.get("/missed-class/activity", response_model=MissedClassActivityResponse)
async def get_missed_class_activity(
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    limit: int = Query(default=50, ge=1, le=100),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return AutomationService(client, get_settings()).activity(studio_id, user_id, limit)

    return await run_supabase_operation(supabase, operation, lane="interactive")


_UNSUBSCRIBE_SCRIPT = (
    "const token=location.hash.slice(1);"
    'history.replaceState(null,"",location.pathname);'
    "if(/^[a-f0-9]{64}$/.test(token)){"
    'document.getElementById("token").value=token;'
    'document.getElementById("confirm").disabled=false;'
    '}else{document.getElementById("link-error").textContent='
    '"This unsubscribe link is missing or invalid. Please open the link from your reminder email.";}'
)
_SCRIPT_HASH = base64.b64encode(hashlib.sha256(_UNSUBSCRIBE_SCRIPT.encode()).digest()).decode()
_UNSUBSCRIBE_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'sha256-" + _SCRIPT_HASH + "'; "
        "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    ),
}
_UNSUBSCRIBE_PAGE = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    '<meta name="referrer" content="no-referrer"><title>Unsubscribe from reminders</title>'
    "</head><body><main><h1>Unsubscribe from reminders</h1>"
    "<p>Confirm to stop these missed-class reminders for this email address.</p>"
    '<form method="post" action="unsubscribe">'
    '<input type="hidden" id="token" name="token" value="">'
    '<p id="link-error" role="status" aria-live="polite"></p>'
    '<button id="confirm" type="submit" disabled>Confirm unsubscribe</button></form>'
    "<noscript>JavaScript is needed to read the private link in this email.</noscript>"
    "</main><script>" + _UNSUBSCRIBE_SCRIPT + "</script></body></html>"
)
_UNSUBSCRIBE_CONFIRMATION = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    "<title>Reminder preference</title></head><body><main><h1>Request received</h1>"
    "<p>If the link was valid, these reminders are now unsubscribed.</p></main></body></html>"
)
_UNSUBSCRIBE_ERROR = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    "<title>Reminder preference</title></head><body><main><h1>Please try again</h1>"
    "<p>Your preference could not be saved. Please try the link again shortly.</p>"
    "</main></body></html>"
)


@router.get("/unsubscribe", response_class=HTMLResponse, include_in_schema=False)
async def unsubscribe_confirmation():
    # Mail scanners and prefetchers cannot change preference through GET.
    return HTMLResponse(_UNSUBSCRIBE_PAGE, headers=_UNSUBSCRIBE_HEADERS)


@router.post("/unsubscribe", response_class=HTMLResponse, include_in_schema=False)
async def unsubscribe(
    request: Request,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
):
    token = ""
    if (
        request.headers.get("content-type", "").split(";", 1)[0]
        == "application/x-www-form-urlencoded"
    ):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 1024:
                break
        if len(body) <= 1024:
            try:
                fields = parse_qs(body.decode("ascii"), max_num_fields=8)
                values = fields.get("token", [])
                if len(values) == 1 and len(values[0]) <= 256:
                    token = values[0]
            except (ValueError, UnicodeError):
                pass
    try:
        await run_supabase_operation(
            supabase,
            lambda client: AutomationService(client, get_settings()).suppress(token),
            lane="interactive",
        )
    except HTTPException:
        return HTMLResponse(_UNSUBSCRIBE_ERROR, status_code=503, headers=_UNSUBSCRIBE_HEADERS)
    return HTMLResponse(_UNSUBSCRIBE_CONFIRMATION, headers=_UNSUBSCRIBE_HEADERS)


_PROCESS_REQUEST_BODY = Body(default_factory=MissedClassProcessRequest)


@worker_router.post("/missed-class/process-due", response_model=MissedClassProcessResponse)
async def process_due_missed_class(
    data: MissedClassProcessRequest = _PROCESS_REQUEST_BODY,
    internal_secret: str | None = Header(default=None, alias="X-Internal-Secret"),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.AUTOMATION_WORKER_SECRET, "Automation worker")
    # Start the admission budget before threadpool scheduling. No service client
    # is obtained through request dependencies or before secret verification.
    deadline = time.monotonic() + WORK_BUDGET_SECONDS
    return await run_in_threadpool(
        process_due_missed_class_automations,
        settings,
        limit=data.limit,
        deadline_monotonic=deadline,
    )
