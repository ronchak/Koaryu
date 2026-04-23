from typing import Optional

from fastapi import APIRouter, Depends
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.schemas.dashboard_bootstrap import DashboardBootstrapResponse
from app.services.dashboard_bootstrap_service import DashboardBootstrapService

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/bootstrap", response_model=DashboardBootstrapResponse)
async def get_dashboard_bootstrap(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    """Return the critical initial dashboard payload in a single request."""
    service = DashboardBootstrapService(supabase)
    return await service.get_dashboard_bootstrap(user_id, requested_studio_id)
