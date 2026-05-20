import secrets
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from supabase import Client

from app.core.config import get_settings
from app.core.deps import get_supabase
from app.schemas.account import AccountDeletionProcessResponse
from app.schemas.support import (
    SupportTicketResponse,
    SupportTicketSeverity,
    SupportTicketStatus,
    SupportTicketTopic,
    SupportTicketTriageUpdate,
    SupportTriageFilters,
)
from app.services.account_service import AccountService
from app.services.support_service import SupportService

router = APIRouter(prefix="/internal", tags=["internal"])


def _verify_secret(provided: Optional[str], expected: str, purpose: str) -> None:
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{purpose} secret is not configured.",
        )
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal secret.")


@router.post("/account-deletions/process-due", response_model=AccountDeletionProcessResponse)
async def process_due_account_deletions(
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.ACCOUNT_DELETION_WORKER_SECRET, "Account deletion worker")
    result = await AccountService(supabase).process_due_deletions()
    if result.failed > 0:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=result.model_dump(mode="json"),
        )
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
