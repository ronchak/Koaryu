from typing import Optional

from fastapi import APIRouter, Depends, status
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.support import SupportTicketCreate, SupportTicketResponse
from app.services.studio_scope import resolve_staff_role_for_user
from app.services.support_service import SupportService

router = APIRouter(prefix="/support", tags=["support"])


def _staff_studio_id(supabase: Client, user_id: str, requested_studio_id: Optional[str]) -> str:
    return resolve_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]


@router.post("/tickets", response_model=SupportTicketResponse, status_code=status.HTTP_201_CREATED)
async def create_support_ticket(
    data: SupportTicketCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _staff_studio_id(supabase, user_id, requested_studio_id)
    return await SupportService(supabase).create_ticket(data, studio_id, user_id)


@router.get("/tickets", response_model=list[SupportTicketResponse])
async def list_support_tickets(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _staff_studio_id(supabase, user_id, requested_studio_id)
    return await SupportService(supabase).list_tickets(studio_id, user_id, requested_studio_id)
