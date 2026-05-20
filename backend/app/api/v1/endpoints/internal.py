from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from supabase import Client

from app.core.config import get_settings
from app.core.deps import get_supabase
from app.schemas.account import AccountDeletionProcessResponse
from app.schemas.support import SupportTicketResponse
from app.services.account_service import AccountService
from app.services.support_service import SupportService

router = APIRouter(prefix="/internal", tags=["internal"])


def _verify_secret(provided: Optional[str], expected: str, purpose: str) -> None:
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{purpose} secret is not configured.",
        )
    if provided != expected:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal secret.")


@router.post("/account-deletions/process-due", response_model=AccountDeletionProcessResponse)
async def process_due_account_deletions(
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.ACCOUNT_DELETION_WORKER_SECRET, "Account deletion worker")
    return await AccountService(supabase).process_due_deletions()


@router.get("/support/tickets", response_model=list[SupportTicketResponse])
async def list_support_triage_tickets(
    internal_secret: Optional[str] = Header(None, alias="X-Internal-Secret"),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    _verify_secret(internal_secret, settings.SUPPORT_TRIAGE_SECRET, "Support triage")
    return await SupportService(supabase).list_triage_tickets()
