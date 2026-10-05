"""Unmounted preview route pending the SQL current-fact and parity proofs."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.core.deps import (
    ProviderDependency,
    get_current_user_id,
    get_requested_studio_id,
    get_supabase,
    run_supabase_operation,
)
from app.schemas.workflow_simulation import WorkflowSimulationRequest, WorkflowSimulationResponse
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)
from app.services.workflow_management_service import ADMIN_REQUIRED_DETAIL
from app.services.workflow_simulation_service import WorkflowSimulationService

router = APIRouter(prefix="/automations", tags=["workflow-simulation"])


@router.post("/workflows/{workflow_id}/simulate", response_model=WorkflowSimulationResponse)
async def simulate_workflow(
    workflow_id: UUID,
    data: WorkflowSimulationRequest,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: Annotated[str, Depends(get_current_user_id)],
    requested_studio_id: Annotated[str | None, Depends(get_requested_studio_id)],
):
    def operation(client):
        membership = resolve_write_staff_role_for_user(client, user_id, requested_studio_id)
        if membership.get("role") != "admin":
            raise HTTPException(403, ADMIN_REQUIRED_DETAIL)
        ensure_platform_subscription_access(client, membership["studio_id"], read_only=True)
        return WorkflowSimulationService(client).simulate(
            membership["studio_id"], user_id, workflow_id, data
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")
