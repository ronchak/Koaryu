from typing import Optional

from fastapi import APIRouter, Depends, Response
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.dashboard_bootstrap import DashboardBootstrapResponse
from app.schemas.dashboard_summary import DashboardSummaryResponse
from app.services.dashboard_bootstrap_service import DashboardBootstrapService
from app.services.dashboard_summary_service import (
    PRIVATE_CACHE_CONTROL,
    PRIVATE_VARY,
    DashboardSummaryService,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _set_private_dashboard_headers(
    response: Response,
    server_timing: Optional[str] = None,
) -> None:
    response.headers["Cache-Control"] = PRIVATE_CACHE_CONTROL
    response.headers["Vary"] = PRIVATE_VARY
    if server_timing:
        response.headers["Server-Timing"] = server_timing


@router.get("/bootstrap", response_model=DashboardBootstrapResponse)
async def get_dashboard_bootstrap(
    response: Response,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    """Return the critical initial dashboard payload in a single request."""
    service = DashboardBootstrapService(supabase)
    payload, timings = await service.get_dashboard_bootstrap(user_id, requested_studio_id)
    server_timing = DashboardBootstrapService.server_timing_value(timings)
    _set_private_dashboard_headers(response, server_timing)
    return payload


@router.get("/summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary(
    response: Response,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    """Return the compact dashboard owner summary for an authenticated studio."""
    service = DashboardSummaryService(supabase)
    payload, timings = await service.get_dashboard_summary(user_id, requested_studio_id)
    server_timing = DashboardSummaryService.server_timing_value(timings)
    _set_private_dashboard_headers(response, server_timing)
    return payload
