from fastapi import APIRouter, Depends, Query
from typing import Optional
from supabase import Client

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
from app.services.studio_scope import resolve_program_manager_staff_role_for_user

router = APIRouter(prefix="/programs", tags=["programs"])


@router.get("", response_model=list[ProgramResponse])
async def list_programs(
    include_archived: bool = Query(False),
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ProgramService(supabase).list_programs(studio_id, include_archived)


@router.post("", response_model=ProgramResponse, status_code=201)
async def create_program(
    data: ProgramCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    membership = resolve_program_manager_staff_role_for_user(supabase, user_id, requested_studio_id)
    return await ProgramService(supabase).create_program(data, membership["studio_id"], user_id)


@router.get("/{program_id}", response_model=ProgramResponse)
async def get_program(
    program_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ProgramService(supabase).get_program(program_id, studio_id)


@router.patch("/{program_id}", response_model=ProgramResponse)
async def update_program(
    program_id: str,
    data: ProgramUpdate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    membership = resolve_program_manager_staff_role_for_user(supabase, user_id, requested_studio_id)
    return await ProgramService(supabase).update_program(program_id, data, membership["studio_id"], user_id)


@router.post("/{program_id}/archive", response_model=ProgramResponse)
async def archive_program(
    program_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    membership = resolve_program_manager_staff_role_for_user(supabase, user_id, requested_studio_id)
    return await ProgramService(supabase).archive_program(program_id, membership["studio_id"], user_id)


@router.post("/{program_id}/restore", response_model=ProgramResponse)
async def restore_program(
    program_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    membership = resolve_program_manager_staff_role_for_user(supabase, user_id, requested_studio_id)
    return await ProgramService(supabase).restore_program(program_id, membership["studio_id"], user_id)


@router.get("/{program_id}/usage", response_model=ProgramUsageResponse)
async def get_program_usage(
    program_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: Client = Depends(get_supabase),
):
    return await ProgramService(supabase).get_usage(program_id, studio_id)
