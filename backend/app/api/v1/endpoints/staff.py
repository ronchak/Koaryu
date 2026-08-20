from typing import Optional

from fastapi import APIRouter, Depends, Response, status
from supabase import Client
from app.core.deps import ProviderDependency, run_supabase_operation

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.account import AccountDeletionRequestResponse
from app.schemas.staff import (
    StaffDeletionRequestCreate,
    StaffInviteCreate,
    StaffLegalNameResponse,
    StaffLegalNameUpdate,
    StaffMemberResponse,
    StaffRoleUpdate,
)
from app.services.staff_service import StaffService
from app.services.studio_scope import (
    resolve_admin_staff_role_for_user,
    resolve_staff_role_for_user,
)

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
    include_archived: bool = False,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        return await StaffService(client).list_staff(
            studio_id,
            include_archived=include_archived,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post(
    "/invitations",
    response_model=StaffMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
async def invite_staff(
    data: StaffInviteCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        return await StaffService(client).invite_staff(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch(
    "/{target_user_id}/legal-name",
    response_model=StaffLegalNameResponse,
)
async def update_staff_legal_name(
    target_user_id: str,
    data: StaffLegalNameUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        membership = resolve_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=False,
        )
        return await StaffService(client).update_staff_legal_name(
            target_user_id,
            data,
            membership["studio_id"],
            user_id,
            membership["role"],
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/{staff_role_id}", response_model=StaffMemberResponse)
async def update_staff_role(
    staff_role_id: str,
    data: StaffRoleUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        return await StaffService(client).update_staff_role(
            staff_role_id,
            data,
            studio_id,
            user_id,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/{staff_role_id}/archive", response_model=StaffMemberResponse)
async def archive_staff(
    staff_role_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        return await StaffService(client).archive_staff(staff_role_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/{staff_role_id}/unarchive", response_model=StaffMemberResponse)
async def unarchive_staff(
    staff_role_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        return await StaffService(client).unarchive_staff(staff_role_id, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post(
    "/{staff_role_id}/deletion-request",
    response_model=AccountDeletionRequestResponse,
)
async def schedule_staff_deletion(
    staff_role_id: str,
    data: StaffDeletionRequestCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        return await StaffService(client).schedule_staff_deletion(
            staff_role_id,
            data,
            studio_id,
            user_id,
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.delete("/{staff_role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_staff(
    staff_role_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        studio_id = _resolve_admin_studio_id(client, user_id, requested_studio_id)
        await StaffService(client).remove_staff(staff_role_id, studio_id, user_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
