from typing import Optional

from fastapi import APIRouter, Depends, Header
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.billing import BillingActionRequest, BillingLinkResponse, EmailUsageResponse, PlatformBillingStatusResponse
from app.services.platform_billing_service import PlatformBillingService
from app.services.studio_scope import resolve_billing_admin_staff_role_for_user, resolve_staff_role_for_user

router = APIRouter(prefix="/platform-billing", tags=["platform-billing"])


def _admin_studio_id(supabase: Client, user_id: str, requested_studio_id: Optional[str]) -> str:
    return resolve_billing_admin_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]


def _staff_studio_id(supabase: Client, user_id: str, requested_studio_id: Optional[str]) -> str:
    return resolve_staff_role_for_user(supabase, user_id, requested_studio_id)["studio_id"]


@router.get("/status", response_model=PlatformBillingStatusResponse)
async def get_platform_billing_status(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _staff_studio_id(supabase, user_id, requested_studio_id)
    return await PlatformBillingService(supabase).get_status(studio_id)


@router.get("/email-usage", response_model=EmailUsageResponse)
async def get_email_usage(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await PlatformBillingService(supabase).get_email_usage(studio_id)


@router.post("/checkout", response_model=BillingLinkResponse)
async def create_checkout(
    data: BillingActionRequest,
    request_idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await PlatformBillingService(supabase).create_checkout_link(
        studio_id,
        user_id,
        data.success_url,
        data.cancel_url,
        request_idempotency_key,
    )


@router.post("/portal", response_model=BillingLinkResponse)
async def create_portal(
    data: BillingActionRequest,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _admin_studio_id(supabase, user_id, requested_studio_id)
    return await PlatformBillingService(supabase).create_portal_link(studio_id, user_id, data.return_url)
