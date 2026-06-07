from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Response
from supabase import Client

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.report_export_service import ReportExportService, require_report_export_access
from app.services.studio_scope import resolve_staff_role_for_user

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/exports/{report_id}")
async def export_report_csv(
    report_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
):
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    studio_id = membership["studio_id"]
    service = ReportExportService(supabase)
    report = service.get_report(report_id)
    require_report_export_access(report, membership.get("role") or "")

    csv_text, filename = await service.build_csv_for_report(report, studio_id)
    supabase.table("audit_logs").insert({
        "studio_id": studio_id,
        "actor_id": user_id,
        "action": "report.exported",
        "entity_type": "report",
        "entity_id": None,
        "metadata": {
            "report_id": report.id,
            "filename": report.filename,
            "contains_sensitive_data": report.contains_sensitive_data,
            "min_role": report.min_role,
            "row_count": max(0, csv_text.count("\n") - 1),
        },
    }).execute()

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    download_name = filename.replace(".csv", f"-{timestamp}.csv")

    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
            "Cache-Control": "no-store, private",
            "Vary": "Authorization, X-Studio-Id, Cookie",
        },
    )
