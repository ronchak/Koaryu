from typing import Optional

from fastapi import APIRouter, Depends
from app.core.deps import ProviderDependency, run_supabase_operation

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.account import AccountDeletionRequestCreate, AccountDeletionRequestResponse
from app.services.account_service import AccountService

router = APIRouter(prefix="/account", tags=["account"])


@router.get("/deletion-request", response_model=Optional[AccountDeletionRequestResponse])
async def get_account_deletion_request(
    user_id: str = Depends(get_current_user_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await AccountService(client).get_deletion_request(user_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/deletion-request", response_model=AccountDeletionRequestResponse)
async def schedule_account_deletion(
    data: AccountDeletionRequestCreate,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await AccountService(client).schedule_deletion(data, user_id, requested_studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )


@router.post("/deletion-request/cancel", response_model=Optional[AccountDeletionRequestResponse])
async def cancel_account_deletion(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        return await AccountService(client).cancel_deletion(user_id, requested_studio_id)
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
