from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.report_export_service import ReportExportService
from app.services.studio_scope import resolve_staff_role_for_user

router = APIRouter(prefix="/reports", tags=["reports"])


def _export_studio_id(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str],
) -> str:
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    if membership.get("role") not in {"admin", "front_desk"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins and front desk staff can export studio data.",
        )
    return membership["studio_id"]


@router.get("/exports/{report_id}")
async def export_report_csv(
    report_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    studio_id = _export_studio_id(supabase, user_id, requested_studio_id)
    csv_text, filename = await ReportExportService(supabase).build_csv(report_id, studio_id)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    download_name = filename.replace(".csv", f"-{timestamp}.csv")

    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
        },
    )
