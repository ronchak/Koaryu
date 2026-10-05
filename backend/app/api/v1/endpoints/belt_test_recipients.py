"""Admin belt-test recipient routes backed by atomic domain commands."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import (
    ProviderDependency,
    get_current_user_id,
    get_requested_studio_id,
    get_supabase,
    run_supabase_operation,
)
from app.schemas.belt_test_recipient import (
    BeltTestRecipientApprovalResponse,
    BeltTestRecipientApprove,
    BeltTestRecipientListResponse,
    BeltTestRecipientResponse,
    BeltTestRecipientRevoke,
)
from app.services.belt_test_recipient_service import ADMIN_REQUIRED_DETAIL, BeltTestRecipientService
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)

router = APIRouter(prefix="/belt-tests", tags=["belt-tests"])


def _admin_studio(client, user_id: str, requested_studio_id: str | None) -> str:
    membership = resolve_write_staff_role_for_user(client, user_id, requested_studio_id)
    if membership.get("role") != "admin":
        raise HTTPException(403, ADMIN_REQUIRED_DETAIL)
    ensure_platform_subscription_access(client, membership["studio_id"])
    return membership["studio_id"]


@router.get("/{event_id}/recipients", response_model=BeltTestRecipientListResponse)
async def list_belt_test_recipients(
    event_id: UUID,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=512),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return BeltTestRecipientService(client).list_recipients(
            studio_id, user_id, event_id, limit, cursor
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("/{event_id}/recipients/approve", response_model=BeltTestRecipientApprovalResponse)
async def approve_belt_test_recipients(
    event_id: UUID,
    data: BeltTestRecipientApprove,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return (
            BeltTestRecipientService(client)
            .approve_recipients(studio_id, user_id, event_id, data)
            .payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post(
    "/{event_id}/recipients/{recipient_id}/revoke", response_model=BeltTestRecipientResponse
)
async def revoke_belt_test_recipient(
    event_id: UUID,
    recipient_id: UUID,
    data: BeltTestRecipientRevoke,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return (
            BeltTestRecipientService(client)
            .revoke_recipient(studio_id, user_id, event_id, recipient_id, data)
            .payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")
