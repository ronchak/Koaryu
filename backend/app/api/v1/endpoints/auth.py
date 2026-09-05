from typing import Optional

from fastapi import APIRouter, Depends
from app.core.deps import ProviderDependency, run_supabase_operation
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.auth import AuthResponse
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me", response_model=AuthResponse)
async def get_me(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        """Get the current authenticated user's profile and studio association."""
        service = AuthService(client)
        return service._get_user_profile_sync(user_id, requested_studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
