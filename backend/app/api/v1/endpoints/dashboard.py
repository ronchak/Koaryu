import time
from typing import Optional

from fastapi import APIRouter, Depends, Response
from supabase import Client
from app.core.deps import ProviderDependency, run_supabase_operation

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.dashboard_bootstrap import DashboardBootstrapResponse
from app.schemas.dashboard_summary import DashboardSummaryResponse
from app.services.dashboard_bootstrap_service import DashboardBootstrapService
from app.services.dashboard_summary_service import (
    PRIVATE_CACHE_CONTROL,
    PRIVATE_VARY,
    DashboardSummaryService,
)
from app.services.auth_service import AuthService
from app.services.studio_scope import ensure_platform_subscription_access

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
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        """Return the critical initial dashboard payload in a single request."""
        service = DashboardBootstrapService(client)
        return await service.get_dashboard_bootstrap(
            user_id,
            requested_studio_id,
            provider_owned=True,
        )
    payload, timings = await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
    server_timing = DashboardBootstrapService.server_timing_value(timings)
    _set_private_dashboard_headers(response, server_timing)
    return payload


@router.get("/summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary(
    response: Response,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        """Build the summary synchronously on the owning provider worker."""
        total_started = time.perf_counter()
        auth = AuthService(client)._get_user_profile_sync(user_id, requested_studio_id)
        service = DashboardSummaryService(client)
        if not auth.studio_id:
            payload, timings = service._build_summary_sync(auth, {})
        else:
            ensure_platform_subscription_access(client, auth.studio_id)
            studio_row = service._fetch_studio_summary(auth.studio_id)
            payload, timings = service._build_summary_sync(auth, studio_row)
            timings["route_total"] = (time.perf_counter() - total_started) * 1000
        return payload, timings
    payload, timings = await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="interactive",
    )
    server_timing = DashboardSummaryService.server_timing_value(timings)
    _set_private_dashboard_headers(response, server_timing)
    return payload
