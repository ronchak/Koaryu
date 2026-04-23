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


def list_staff_roles_for_user(
    supabase: Client,
    user_id: str,
) -> list[dict]:
    result = (
        supabase.table("staff_roles")
        .select("studio_id, role, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return result.data or []


def resolve_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
) -> dict:
    roles = list_staff_roles_for_user(supabase, user_id)

    if not roles:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No studio found for this user. Complete onboarding first.",
        )

    if requested_studio_id:
        for role in roles:
            if role["studio_id"] == requested_studio_id:
                return role

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to the requested studio.",
        )

    # Preserve a deterministic default for sessions that do not yet carry
    # explicit studio selection. Prefer the most recently created membership,
    # which matches the latest studio a user just onboarded into more often
    # than the oldest historical membership.
    return roles[0]
