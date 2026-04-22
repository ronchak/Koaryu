from typing import Optional

from fastapi import HTTPException, status
from supabase import Client


def ensure_studio_record(
    supabase: Client,
    table: str,
    record_id: str,
    studio_id: str,
    detail: str,
) -> None:
    result = (
        supabase.table(table)
        .select("id")
        .eq("id", record_id)
        .eq("studio_id", studio_id)
        .limit(1)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def ensure_optional_studio_record(
    supabase: Client,
    table: str,
    record_id: Optional[str],
    studio_id: str,
    detail: str,
) -> None:
    if record_id:
        ensure_studio_record(supabase, table, record_id, studio_id, detail)


def ensure_staff_user_in_studio(
    supabase: Client,
    user_id: Optional[str],
    studio_id: str,
    detail: str,
) -> None:
    if not user_id:
        return

    result = (
        supabase.table("staff_roles")
        .select("id")
        .eq("user_id", user_id)
        .eq("studio_id", studio_id)
        .limit(1)
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
