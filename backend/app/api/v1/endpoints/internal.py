import logging
import os
import secrets
import threading
import time
from typing import Optional
from urllib.parse import urlparse
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from starlette.concurrency import run_in_threadpool
from supabase import Client

from app.core.config import (
    KOARYU_PRODUCTION_SUPABASE_URL,
    KOARYU_STAGING_SUPABASE_URL,
    get_settings,
    validate_raw_header_value,
)
from app.core.deps import get_operational_alert_supabase, get_supabase
from app.schemas.account import AccountDeletionProcessResponse
from app.schemas.operational_alerts import (
    OperationalAlertAcknowledgementResponse,
    OperationalAlertEvaluationResponse,
)
from app.schemas.support import (
    SupportTicketResponse,
    SupportTicketSeverity,
    SupportTicketStatus,
    SupportTicketTopic,
    SupportTicketTriageUpdate,
    SupportTriageFilters,
)
from app.services.account_service import AccountService
from app.services.operational_alerts import (
    EVALUATION_BATCH_TIMEOUT_SECONDS,
    HttpsAlertDestination,
    OperationalAlertDeadlineExceeded,
    OperationalAlertService,
)
from app.services.support_service import SupportService

router = APIRouter(prefix="/internal", tags=["internal"])
logger = logging.getLogger(__name__)
_OPERATIONAL_ALERT_EVALUATION_LOCK = threading.Lock()


class _OperationalAlertEvaluationBusy(RuntimeError):
    pass


def _verify_secret(provided: Optional[str], expected: str, purpose: str) -> None:
    try:
        validate_raw_header_value(f"{purpose} secret", expected)
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{purpose} secret is not safely configured.",
        ) from None
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{purpose} secret is not configured.",
        )
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal secret.")


def _verify_operational_alert_target(environment: str, supabase_url: str) -> str:
    normalized_environment = environment.strip().lower()
    if (
        normalized_environment == "staging"
        and supabase_url == KOARYU_STAGING_SUPABASE_URL
    ):
        return normalized_environment
    if (
        normalized_environment == "production"
        and supabase_url == KOARYU_PRODUCTION_SUPABASE_URL
    ):
        return normalized_environment
    parsed = urlparse(supabase_url)
    if (
        normalized_environment in {"development", "test"}
        and parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1"}
    ):
        return normalized_environment
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Operational alert evaluator target is not safe.",
    )


def _run_operational_alert_evaluation(
    *,
    supabase: Client,
    settings,
    environment: str,
    commit_sha: str | None,
    deadline_monotonic: float,
):
    """Own the overlap lock for the full lifetime of the synchronous worker."""
    if not _OPERATIONAL_ALERT_EVALUATION_LOCK.acquire(blocking=False):
        raise _OperationalAlertEvaluationBusy
    try:
        if time.monotonic() >= deadline_monotonic:
            raise OperationalAlertDeadlineExceeded(
                "operational alert evaluation deadline exceeded"
            )
        destination = HttpsAlertDestination.from_settings(settings)
        return OperationalAlertService(supabase, destination=destination).evaluate(
            environment=environment,
            commit_sha=commit_sha,
            deadline_monotonic=deadline_monotonic,
        )
    finally:
        _OPERATIONAL_ALERT_EVALUATION_LOCK.release()


@router.post("/account-deletions/process-due", response_model=AccountDeletionProcessResponse)
async def process_due_account_deletions(
    response: Response,
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.ACCOUNT_DELETION_WORKER_SECRET, "Account deletion worker")
    result = await AccountService(supabase).process_due_deletions()
    if settings.OPERATIONAL_ALERTS_ENABLED:
        try:
            alert_environment = _verify_operational_alert_target(
                settings.ENVIRONMENT,
                settings.SUPABASE_URL,
            )
            heartbeat_sequence = OperationalAlertService(supabase).record_heartbeat(
                environment=alert_environment,
                worker_id="deletion-worker",
                commit_sha=os.environ.get("RENDER_GIT_COMMIT"),
            )
            response.headers["X-Koaryu-Heartbeat-Sequence"] = str(heartbeat_sequence)
        except Exception as exc:
            logger.warning(
                "Operational alert deletion-worker heartbeat failed",
                extra={"exception_type": type(exc).__name__},
            )
    if result.failed > 0:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result.model_dump(mode="json"),
        )
    return result


@router.post(
    "/operational-alerts/evaluate",
    response_model=OperationalAlertEvaluationResponse,
)
async def evaluate_operational_alerts(
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_operational_alert_supabase),
):
    settings = get_settings()
    if not settings.OPERATIONAL_ALERTS_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Operational alerts are not enabled.",
        )
    environment = _verify_operational_alert_target(
        settings.ENVIRONMENT,
        settings.SUPABASE_URL,
    )
    _verify_secret(
        internal_secret,
        settings.OPERATIONAL_ALERT_WORKER_SECRET,
        "Operational alert evaluator",
    )
    deadline_monotonic = time.monotonic() + EVALUATION_BATCH_TIMEOUT_SECONDS
    try:
        return await run_in_threadpool(
            _run_operational_alert_evaluation,
            supabase=supabase,
            settings=settings,
            environment=environment,
            commit_sha=os.environ.get("RENDER_GIT_COMMIT"),
            deadline_monotonic=deadline_monotonic,
        )
    except _OperationalAlertEvaluationBusy:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Operational alert evaluation is already in progress.",
            headers={"Retry-After": "30"},
        ) from None
    except OperationalAlertDeadlineExceeded:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Operational alert evaluation exceeded its safe deadline.",
            headers={"Retry-After": "30"},
        ) from None


@router.post(
    "/operational-alerts/{episode_id}/acknowledge",
    response_model=OperationalAlertAcknowledgementResponse,
)
async def acknowledge_operational_alert(
    episode_id: UUID,
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    if not settings.OPERATIONAL_ALERTS_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Operational alerts are not enabled.",
        )
    environment = _verify_operational_alert_target(
        settings.ENVIRONMENT,
        settings.SUPABASE_URL,
    )
    actor_role: str | None = None
    actor_ref: str | None = None
    for name, configured_secret in (
        ("Operational alert primary acknowledgement", settings.OPERATIONAL_ALERT_PRIMARY_ACK_SECRET),
        ("Operational alert backup acknowledgement", settings.OPERATIONAL_ALERT_BACKUP_ACK_SECRET),
    ):
        try:
            validate_raw_header_value(name, configured_secret)
        except RuntimeError:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Operational alert acknowledgement secret is not safely configured.",
            ) from None
    if internal_secret and settings.OPERATIONAL_ALERT_PRIMARY_ACK_SECRET and secrets.compare_digest(
        internal_secret,
        settings.OPERATIONAL_ALERT_PRIMARY_ACK_SECRET,
    ):
        actor_role, actor_ref = "primary", "primary-owner"
    elif internal_secret and settings.OPERATIONAL_ALERT_BACKUP_ACK_SECRET and secrets.compare_digest(
        internal_secret,
        settings.OPERATIONAL_ALERT_BACKUP_ACK_SECRET,
    ):
        actor_role, actor_ref = "backup", "backup-owner"
    if actor_role is None or actor_ref is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal secret.")
    result = OperationalAlertService(supabase).acknowledge(
        environment=environment,
        episode_id=episode_id,
        actor_role=actor_role,
        actor_ref=actor_ref,
    )
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alert episode not found.")
    return result


@router.get("/support/tickets", response_model=list[SupportTicketResponse])
async def list_support_triage_tickets(
    ticket_status: Optional[list[SupportTicketStatus]] = Query(None, alias="status"),
    severity: Optional[list[SupportTicketSeverity]] = Query(None),
    topic: Optional[list[SupportTicketTopic]] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.SUPPORT_TRIAGE_SECRET, "Support triage")
    filters = SupportTriageFilters(
        statuses=ticket_status or [],
        severities=severity or [],
        topics=topic or [],
        limit=limit,
    )
    return await SupportService(supabase).list_triage_tickets(filters)


@router.patch("/support/tickets/{ticket_id}", response_model=SupportTicketResponse)
async def update_support_triage_ticket(
    ticket_id: UUID,
    data: SupportTicketTriageUpdate,
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.SUPPORT_TRIAGE_SECRET, "Support triage")
    return await SupportService(supabase).triage_ticket(str(ticket_id), data)
