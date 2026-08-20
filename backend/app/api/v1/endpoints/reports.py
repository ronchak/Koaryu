from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Response
from supabase import Client
from app.core.deps import ProviderDependency, run_supabase_operation

from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.report_export_service import ReportExportService, require_report_export_access
from app.services.studio_scope import resolve_staff_role_for_user

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/exports/{report_id}")
async def export_report_csv(
    report_id: str,
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: ProviderDependency = Depends(get_supabase),
):
    async def _provider_operation(client):
        service = ReportExportService(client)
        membership = resolve_staff_role_for_user(
            client,
            user_id,
            requested_studio_id,
            require_platform_subscription=True,
        )
        studio_id = membership["studio_id"]
        report = service.get_report(report_id)
        require_report_export_access(report, membership.get("role") or "")
        service.budget.check_elapsed()

        artifact = await service.build_csv_artifact_for_report(report, studio_id)
        service.budget.admit_provider_call()
        client.table("audit_logs").insert({
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
                "row_count": artifact.emitted_data_rows,
                "output_bytes": artifact.output_bytes,
                "spool_threshold_bytes": artifact.spool_threshold_bytes,
                "spool_rolled": artifact.spool_rolled,
                "budget": {
                    "fetched_rows": artifact.budget.fetched_rows,
                    "provider_calls_before_audit": artifact.budget.provider_calls,
                    "emitted_rows": artifact.emitted_data_rows,
                    "output_bytes": artifact.output_bytes,
                    "elapsed_seconds": artifact.budget.elapsed_seconds,
                },
            },
        }).execute()
        service.budget.check_elapsed()

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        download_name = artifact.filename.replace(".csv", f"-{timestamp}.csv")

        return Response(
            content=artifact.body,
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{download_name}"',
                "Cache-Control": "no-store, private",
                "Vary": "Authorization, X-Studio-Id, Cookie",
            },
        )
    return await run_supabase_operation(
        supabase,
        _provider_operation,
        lane="bulk",
    )
