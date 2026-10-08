"""Workflow management routes with current membership and entitlement checks."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.config import get_settings
from app.core.deps import (
    ProviderDependency,
    get_current_user_id,
    get_requested_studio_id,
    get_supabase,
    run_supabase_operation,
)
from app.schemas.workflow import WorkflowValidationResult
from app.schemas.workflow_management import (
    AutomationOperationResponse,
    WorkflowAction,
    WorkflowCatalogResponse,
    WorkflowCreate,
    WorkflowDetail,
    WorkflowLifecycleRequest,
    WorkflowListResponse,
    WorkflowPublish,
    WorkflowSave,
    WorkflowValidate,
)
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)
from app.services.workflow_management_service import (
    ADMIN_REQUIRED_DETAIL,
    RECEIPT_REQUIRED_DETAIL,
    WorkflowManagementService,
)

router = APIRouter(prefix="/automations", tags=["workflow-management"])
Provider = Annotated[ProviderDependency, Depends(get_supabase)]
Actor = Annotated[str, Depends(get_current_user_id)]
RequestedStudio = Annotated[str | None, Depends(get_requested_studio_id)]


def _membership(client, user_id: str, requested_studio_id: str | None, *, receipt: bool = False):
    membership = resolve_write_staff_role_for_user(client, user_id, requested_studio_id)
    allowed = {"admin", "front_desk"} if receipt else {"admin"}
    if membership.get("role") not in allowed:
        raise HTTPException(403, RECEIPT_REQUIRED_DETAIL if receipt else ADMIN_REQUIRED_DETAIL)
    ensure_platform_subscription_access(client, membership["studio_id"])
    return membership


@router.get("/catalog", response_model=WorkflowCatalogResponse)
async def get_workflow_catalog(
    supabase: Provider, user_id: Actor, requested_studio_id: RequestedStudio
):
    def operation(client):
        _membership(client, user_id, requested_studio_id)
        return WorkflowManagementService(client, get_settings()).catalog(user_id)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.get("/workflows", response_model=WorkflowListResponse)
async def list_workflows(
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=512),
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return WorkflowManagementService(client).list(
            membership["studio_id"], user_id, limit, cursor
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("/workflows", response_model=WorkflowDetail, status_code=201)
async def create_workflow(
    data: WorkflowCreate,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return (
            WorkflowManagementService(client).create(membership["studio_id"], user_id, data).payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("/workflows/validate", response_model=WorkflowValidationResult)
async def validate_workflow(
    data: WorkflowValidate,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return WorkflowManagementService(client).validate(membership["studio_id"], user_id, data)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.get("/workflows/{workflow_id}", response_model=WorkflowDetail)
async def get_workflow(
    workflow_id: UUID,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return WorkflowManagementService(client).get(membership["studio_id"], user_id, workflow_id)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.put("/workflows/{workflow_id}", response_model=WorkflowDetail)
async def save_workflow(
    workflow_id: UUID,
    data: WorkflowSave,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        return (
            WorkflowManagementService(client)
            .save(membership["studio_id"], user_id, workflow_id, data)
            .payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


async def _command(
    workflow_id: UUID,
    data: WorkflowLifecycleRequest,
    action: WorkflowAction,
    supabase: ProviderDependency,
    user_id: str,
    requested_studio_id: str | None,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id)
        settings = get_settings() if action == "start" else None
        return (
            WorkflowManagementService(client, settings)
            .command(membership["studio_id"], user_id, workflow_id, action, data)
            .payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post("/workflows/{workflow_id}/publish", response_model=WorkflowDetail)
async def publish_workflow(
    workflow_id: UUID,
    data: WorkflowPublish,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    return await _command(workflow_id, data, "publish", supabase, user_id, requested_studio_id)


@router.post("/workflows/{workflow_id}/start", response_model=WorkflowDetail)
async def start_workflow(
    workflow_id: UUID,
    data: WorkflowLifecycleRequest,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    return await _command(workflow_id, data, "start", supabase, user_id, requested_studio_id)


@router.post("/workflows/{workflow_id}/pause", response_model=WorkflowDetail)
async def pause_workflow(
    workflow_id: UUID,
    data: WorkflowLifecycleRequest,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    return await _command(workflow_id, data, "pause", supabase, user_id, requested_studio_id)


@router.post("/workflows/{workflow_id}/archive", response_model=WorkflowDetail)
async def archive_workflow(
    workflow_id: UUID,
    data: WorkflowLifecycleRequest,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    return await _command(workflow_id, data, "archive", supabase, user_id, requested_studio_id)


@router.get("/operations/{operation_id}", response_model=AutomationOperationResponse)
async def get_automation_operation(
    operation_id: UUID,
    supabase: Provider,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    def operation(client):
        membership = _membership(client, user_id, requested_studio_id, receipt=True)
        return WorkflowManagementService(client).operation(
            membership["studio_id"], user_id, operation_id, membership["role"]
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")
