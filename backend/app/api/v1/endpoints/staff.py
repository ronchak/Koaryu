from typing import Optional

from fastapi import APIRouter, Depends, Response, status
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.staff import StaffInviteCreate, StaffMemberResponse, StaffRoleUpdate
from app.services.staff_service import StaffService
from app.services.studio_scope import resolve_admin_staff_role_for_user

router = APIRouter(prefix="/staff", tags=["staff"])


def _resolve_admin_studio_id(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str],
) -> str:
    membership = resolve_admin_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


@router.get("", response_model=list[StaffMemberResponse])
async def list_staff(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _resolve_admin_studio_id(supabase, user_id, requested_studio_id)
    return await StaffService(supabase).list_staff(studio_id)


@router.post(
    "/invitations",
    response_model=StaffMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
async def invite_staff(
    data: StaffInviteCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _resolve_admin_studio_id(supabase, user_id, requested_studio_id)
    return await StaffService(supabase).invite_staff(data, studio_id, user_id)


@router.patch("/{staff_role_id}", response_model=StaffMemberResponse)
async def update_staff_role(
    staff_role_id: str,
    data: StaffRoleUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _resolve_admin_studio_id(supabase, user_id, requested_studio_id)
    return await StaffService(supabase).update_staff_role(
        staff_role_id,
        data,
        studio_id,
        user_id,
    )


@router.delete("/{staff_role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_staff(
    staff_role_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _resolve_admin_studio_id(supabase, user_id, requested_studio_id)
    await StaffService(supabase).remove_staff(staff_role_id, studio_id, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
