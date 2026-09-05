from fastapi import APIRouter, Depends, Query
from typing import Optional
from app.core.deps import ProviderDependency, run_supabase_operation

from app.core.deps import (
    get_current_studio_id,
    get_current_user_id,
    get_requested_studio_id,
    get_supabase,
)
from app.schemas.program import (
    ProgramCreate,
    ProgramResponse,
    ProgramUpdate,
    ProgramUsageResponse,
)
from app.services.program_service import ProgramService
from app.services.studio_scope import resolve_admin_staff_role_for_user

router = APIRouter(prefix="/programs", tags=["programs"])


@router.get("", response_model=list[ProgramResponse])
async def list_programs(
    include_archived: bool = Query(False),
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return ProgramService(client).list_programs_sync(studio_id, include_archived)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("", response_model=ProgramResponse, status_code=201)
async def create_program(
    data: ProgramCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        membership = resolve_admin_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await ProgramService(client).create_program(data, membership["studio_id"], user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/{program_id}", response_model=ProgramResponse)
async def get_program(
    program_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await ProgramService(client).get_program(program_id, studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/{program_id}", response_model=ProgramResponse)
async def update_program(
    program_id: str,
    data: ProgramUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        membership = resolve_admin_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await ProgramService(client).update_program(program_id, data, membership["studio_id"], user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/{program_id}/archive", response_model=ProgramResponse)
async def archive_program(
    program_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        membership = resolve_admin_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await ProgramService(client).archive_program(program_id, membership["studio_id"], user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/{program_id}/restore", response_model=ProgramResponse)
async def restore_program(
    program_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        membership = resolve_admin_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        return await ProgramService(client).restore_program(program_id, membership["studio_id"], user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/{program_id}/usage", response_model=ProgramUsageResponse)
async def get_program_usage(
    program_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await ProgramService(client).get_usage(program_id, studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
