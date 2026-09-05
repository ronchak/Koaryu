import time
from typing import Optional

from fastapi import APIRouter, Depends, Response
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
    allow_partial: bool = False,
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
            allow_partial=allow_partial,
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
    total_started = time.perf_counter()
    context_started = time.perf_counter()
    context = await run_supabase_operation(
        supabase,
        lambda client: DashboardSummaryService(client).resolve_fact_context_sync(
            user_id,
            requested_studio_id,
        ),
        lane="interactive",
    )
    timings = {"context": (time.perf_counter() - context_started) * 1000}
    payload, timings = await DashboardSummaryService.get_dashboard_summary_from_fact_context(
        supabase,
        context,
        timings=timings,
        total_started=total_started,
    )
    server_timing = DashboardSummaryService.server_timing_value(timings)
    _set_private_dashboard_headers(response, server_timing)
    return payload
