"""Admin belt-test event routes backed by atomic domain commands."""

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
from app.schemas.belt_test import (
    BeltTestEventCreate,
    BeltTestEventListResponse,
    BeltTestEventResponse,
    BeltTestEventUpdate,
)
from app.services.belt_test_service import ADMIN_REQUIRED_DETAIL, BeltTestService
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


@router.get("", response_model=BeltTestEventListResponse)
async def list_belt_test_events(
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=512),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return BeltTestService(client).list(studio_id, user_id, limit, cursor)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("", response_model=BeltTestEventResponse, status_code=201)
async def create_belt_test_event(
    data: BeltTestEventCreate,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return BeltTestService(client).create(studio_id, user_id, data).payload

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.get("/{event_id}", response_model=BeltTestEventResponse)
async def get_belt_test_event(
    event_id: UUID,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return BeltTestService(client).get(studio_id, user_id, event_id)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.patch("/{event_id}", response_model=BeltTestEventResponse)
async def update_belt_test_event(
    event_id: UUID,
    data: BeltTestEventUpdate,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return BeltTestService(client).update(studio_id, user_id, event_id, data).payload

    return await run_supabase_operation(supabase, operation, lane="interactive")
