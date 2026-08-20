from fastapi import APIRouter, Depends, Query
from typing import Optional
from supabase import Client
from app.core.deps import ProviderDependency, run_supabase_operation
from app.core.deps import (
    get_current_studio_id,
    get_current_user_id,
    get_lead_manager_studio_id,
    get_lead_conversion_manager_studio_id,
    get_supabase,
)
from app.schemas.lead import (
    LeadCreate, LeadUpdate, LeadResponse,
    LeadActivityCreate, LeadActivityResponse,
    LeadConvert,
)
from app.services.lead_service import LeadService

router = APIRouter(prefix="/leads", tags=["leads"])


@router.get("", response_model=list[LeadResponse])
async def list_leads(
    stage: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).list_leads(studio_id, stage, source)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("", response_model=LeadResponse, status_code=201)
async def create_lead(
    data: LeadCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_lead_manager_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).create_lead(data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/{lead_id}", response_model=LeadResponse)
async def get_lead(
    lead_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).get_lead(lead_id, studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.patch("/{lead_id}", response_model=LeadResponse)
async def update_lead(
    lead_id: str,
    data: LeadUpdate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_lead_manager_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).update_lead(lead_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.get("/{lead_id}/activities", response_model=list[LeadActivityResponse])
async def get_activities(
    lead_id: str,
    studio_id: str = Depends(get_current_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).get_activities(lead_id, studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/{lead_id}/activities", response_model=LeadActivityResponse, status_code=201)
async def add_activity(
    lead_id: str,
    data: LeadActivityCreate,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_lead_manager_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).add_activity(lead_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/{lead_id}/convert", response_model=LeadResponse)
async def convert_lead(
    lead_id: str,
    data: LeadConvert,
    user_id: str = Depends(get_current_user_id),
    studio_id: str = Depends(get_lead_conversion_manager_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await LeadService(client).convert_to_student(lead_id, data, studio_id, user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
