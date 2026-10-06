"""Unmounted synthetic test routes pending Core's SQL and readiness proofs."""

import time
from functools import partial
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.deps import get_current_user_id, get_requested_studio_id
from app.schemas.workflow_test_email import WorkflowTestEmailRequest, WorkflowTestEmailResponse
from app.services.automation_service import WORK_BUDGET_SECONDS
from app.services.workflow_test_email_service import (
    create_workflow_test_email,
    get_workflow_test_email,
)

router = APIRouter(prefix="/automations", tags=["workflow-test-email"])
Actor = Annotated[str, Depends(get_current_user_id)]
RequestedStudio = Annotated[str | None, Depends(get_requested_studio_id)]


@router.post("/workflows/{workflow_id}/test-email", response_model=WorkflowTestEmailResponse)
async def test_workflow_email(
    workflow_id: UUID,
    data: WorkflowTestEmailRequest,
    user_id: Actor,
    requested_studio_id: RequestedStudio,
):
    deadline = time.monotonic() + WORK_BUDGET_SECONDS
    return await run_in_threadpool(
        partial(
            create_workflow_test_email,
            get_settings(),
            user_id,
            requested_studio_id,
            workflow_id,
            data,
            deadline_monotonic=deadline,
        )
    )


@router.get("/test-deliveries/{test_delivery_id}", response_model=WorkflowTestEmailResponse)
async def get_test_email(
    test_delivery_id: UUID, user_id: Actor, requested_studio_id: RequestedStudio
):
    # The scoped SQL reader also reconciles this test's expired lease.
    deadline = time.monotonic() + WORK_BUDGET_SECONDS
    return await run_in_threadpool(
        partial(
            get_workflow_test_email,
            get_settings(),
            user_id,
            requested_studio_id,
            test_delivery_id,
            deadline_monotonic=deadline,
        )
    )
