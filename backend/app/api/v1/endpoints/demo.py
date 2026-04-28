from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from supabase import Client

from app.core.config import get_settings
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.demo import DemoResetResponse
from app.services.demo_service import DemoService
from app.services.studio_scope import resolve_staff_role_for_user

router = APIRouter(prefix="/demo", tags=["demo"])


@router.post("/reset", response_model=DemoResetResponse)
async def reset_demo_studio(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    settings = get_settings()
    if settings.ENVIRONMENT != "development" and not settings.DEMO_RESET_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Demo reset is disabled for this environment.",
        )

    if not requested_studio_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose an active studio before resetting demo data.",
        )

    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    if membership.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins can reset demo data.",
        )

    return await DemoService(supabase).reset_demo_studio(requested_studio_id, user_id)
