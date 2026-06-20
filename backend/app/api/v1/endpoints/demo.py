from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from supabase import Client

from app.core.config import get_settings
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.demo import DemoResetResponse, StudioDataClearResponse
from app.services.demo_service import DemoService
from app.services.studio_scope import resolve_staff_role_for_user

router = APIRouter(prefix="/demo", tags=["demo"])
DEMO_RESET_DESTRUCTIVE_ACTION = "demo-reset"
CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION = "clear-studio-data"


def ensure_demo_tools_enabled() -> None:
    if get_settings().DEMO_RESET_ENABLED:
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Demo data tools are disabled in this environment.",
    )


def configured_demo_studio_ids() -> set[str]:
    raw_value = getattr(get_settings(), "DEMO_RESET_STUDIO_IDS", "") or ""
    return {studio_id.strip() for studio_id in raw_value.split(",") if studio_id.strip()}


def ensure_demo_studio_target(studio_id: str) -> None:
    allowed_studio_ids = configured_demo_studio_ids()
    if studio_id in allowed_studio_ids:
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Demo data tools are restricted to explicitly configured demo studios.",
    )


def ensure_destructive_action_confirmed(
    provided_action: Optional[str],
    expected_action: str,
) -> None:
    if provided_action == expected_action:
        return

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Confirm this destructive action with X-Koaryu-Destructive-Action: {expected_action}.",
    )


@router.get("/capabilities", response_model=dict[str, bool])
async def get_demo_capabilities(
    user_id: str = Depends(get_current_user_id),
):
    return {"enabled": get_settings().DEMO_RESET_ENABLED}


@router.post("/reset", response_model=DemoResetResponse)
async def reset_demo_studio(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    destructive_action: Optional[str] = Header(default=None, alias="X-Koaryu-Destructive-Action"),
    supabase: Client = Depends(get_supabase),
):
    ensure_demo_tools_enabled()
    ensure_destructive_action_confirmed(destructive_action, DEMO_RESET_DESTRUCTIVE_ACTION)

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
    ensure_demo_studio_target(membership["studio_id"])

    return await DemoService(supabase).reset_demo_studio(membership["studio_id"], user_id)


@router.delete("/data", response_model=StudioDataClearResponse)
async def clear_studio_data(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    destructive_action: Optional[str] = Header(default=None, alias="X-Koaryu-Destructive-Action"),
    supabase: Client = Depends(get_supabase),
):
    ensure_demo_tools_enabled()
    ensure_destructive_action_confirmed(destructive_action, CLEAR_STUDIO_DATA_DESTRUCTIVE_ACTION)

    if not requested_studio_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose an active studio before clearing studio data.",
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
            detail="Only studio admins can clear studio data.",
        )
    ensure_demo_studio_target(membership["studio_id"])

    return await DemoService(supabase).clear_studio_data(membership["studio_id"])
