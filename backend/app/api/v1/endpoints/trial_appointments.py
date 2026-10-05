"""Admin trial appointment routes backed by atomic domain commands."""

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
from app.schemas.trial_appointment import (
    TrialAppointmentCreate,
    TrialAppointmentListResponse,
    TrialAppointmentResponse,
    TrialAppointmentUpdate,
)
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_write_staff_role_for_user,
)
from app.services.trial_appointment_service import (
    ADMIN_REQUIRED_DETAIL,
    TrialAppointmentService,
)

router = APIRouter(prefix="/leads", tags=["trial-appointments"])


def _admin_studio(client, user_id: str, requested_studio_id: str | None) -> str:
    membership = resolve_write_staff_role_for_user(client, user_id, requested_studio_id)
    if membership.get("role") != "admin":
        raise HTTPException(403, ADMIN_REQUIRED_DETAIL)
    ensure_platform_subscription_access(client, membership["studio_id"])
    return membership["studio_id"]


@router.get("/{lead_id}/trial-appointments", response_model=TrialAppointmentListResponse)
async def list_trial_appointments(
    lead_id: UUID,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1, max_length=512),
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return TrialAppointmentService(client).list(studio_id, user_id, lead_id, limit, cursor)

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.post(
    "/{lead_id}/trial-appointments", response_model=TrialAppointmentResponse, status_code=201
)
async def create_trial_appointment(
    lead_id: UUID,
    data: TrialAppointmentCreate,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return TrialAppointmentService(client).create(studio_id, user_id, lead_id, data).payload

    return await run_supabase_operation(supabase, operation, lane="interactive")


@router.patch(
    "/{lead_id}/trial-appointments/{appointment_id}", response_model=TrialAppointmentResponse
)
async def update_trial_appointment(
    lead_id: UUID,
    appointment_id: UUID,
    data: TrialAppointmentUpdate,
    supabase: Annotated[ProviderDependency, Depends(get_supabase)],
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: str | None = Depends(get_requested_studio_id),
):
    def operation(client):
        studio_id = _admin_studio(client, user_id, requested_studio_id)
        return (
            TrialAppointmentService(client)
            .update(studio_id, user_id, lead_id, appointment_id, data)
            .payload
        )

    return await run_supabase_operation(supabase, operation, lane="interactive")
