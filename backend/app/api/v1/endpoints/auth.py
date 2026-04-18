from fastapi import APIRouter, Depends
from supabase import Client
from app.core.deps import get_current_user_id, get_supabase
from app.schemas.auth import AuthResponse
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me", response_model=AuthResponse)
async def get_me(
    user_id: str = Depends(get_current_user_id),
    supabase: Client = Depends(get_supabase),
):
    """Get the current authenticated user's profile and studio association."""
    service = AuthService(supabase)
    return await service.get_user_profile(user_id)
