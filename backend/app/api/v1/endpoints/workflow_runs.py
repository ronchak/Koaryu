"""Admin workflow run history and cancellation routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import (
    ProviderDependency,
    get_current_user_id,
    get_requested_studio_id,
    get_supabase,
    run_supabase_operation,
)
from app.schemas.workflow_run import (
    WorkflowRunCancelRequest,
    WorkflowRunDetail,
    WorkflowRunListResponse,
)
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)
from app.services.workflow_run_service import ADMIN_REQUIRED_DETAIL, WorkflowRunService

router = APIRouter(prefix="/automations", tags=["workflow-runs"])
Provider = Annotated[ProviderDependency, Depends(get_supabase)]
Actor = Annotated[str, Depends(get_current_user_id)]
RequestedStudio = Annotated[str | None, Depends(get_requested_studio_id)]


def _membership(client, user_id: str, requested_studio_id: str | None):
    membership = resolve_write_staff_role_for_user(client, user_id, requested_studio_id)
    if membership.get("role") != "admin":
        raise HTTPException(403, ADMIN_REQUIRED_DETAIL)
    ensure_platform_subscription_access(client, membership["studio_id"])
    return membership


@router.get("/workflows/{workflow_id}/runs", response_model=WorkflowRunListResponse)
async def list_workflow_runs(
    workflow_id: UUID,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=512),
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return WorkflowRunService(client).list(
            membership["studio_id"], user_id, workflow_id, limit, cursor
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.get("/runs/{run_id}", response_model=WorkflowRunDetail)
async def get_workflow_run(
    run_id: UUID,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return WorkflowRunService(client).get(membership["studio_id"], user_id, run_id)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("/runs/{run_id}/cancel", response_model=WorkflowRunDetail)
async def cancel_workflow_run(
    run_id: UUID,
    data: WorkflowRunCancelRequest,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return (
            WorkflowRunService(client)
            .cancel(membership["studio_id"], user_id, run_id, data)
            .payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")
