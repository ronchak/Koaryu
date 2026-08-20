from typing import Optional

from fastapi import APIRouter, Depends, Header
from supabase import Client
from app.core.deps import ProviderDependency, run_supabase_operation
from app.core.deps import get_current_user_id, get_current_studio_id, get_requested_studio_id, get_supabase
from app.schemas.studio import StudioCreate, StudioUpdate, StudioResponse
from app.services.studio_scope import resolve_admin_staff_role_for_user
from app.services.studio_service import StudioService

router = APIRouter(prefix="/studios", tags=["studios"])


@router.post("", response_model=StudioResponse, status_code=201)
async def create_studio(
    data: StudioCreate,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    user_id: str = Depends(get_current_user_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        """
        Create a new studio for the authenticated user.
        Also creates an admin staff_role for the user.
        """
        service = StudioService(client)
        return await service.create_studio(data, user_id, idempotency_key)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/current", response_model=StudioResponse)
async def get_current_studio(
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        """Get the current user's studio."""
        service = StudioService(client)
        return await service.get_studio(studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/current", response_model=StudioResponse)
async def update_current_studio(
    data: StudioUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        """Update the current user's studio settings."""
        membership = resolve_admin_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        service = StudioService(client)
        return await service.update_studio(membership["studio_id"], data, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
