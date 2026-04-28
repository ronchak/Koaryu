from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, status
from supabase import Client

ACTIVE_PLATFORM_SUBSCRIPTION_STATUSES = {"active", "trialing", "comped"}
SUBSCRIPTION_REQUIRED_DETAIL = {
    "code": "SUBSCRIPTION_REQUIRED",
    "message": "Koaryu Core subscription required.",
}


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


def get_platform_subscription_access(supabase: Client, studio_id: str) -> dict:
    result = (
        supabase.table("studio_subscriptions")
        .select("status, comped, trial_end")
        .eq("studio_id", studio_id)
        .maybe_single()
        .execute()
    )
    row = result.data or {}
    status_value = row.get("status") or "incomplete"
    comped = bool(row.get("comped", False))
    subscription_required = not (comped or status_value in ACTIVE_PLATFORM_SUBSCRIPTION_STATUSES)

    trial_end = row.get("trial_end")
    if status_value == "trialing" and trial_end:
        trial_end_text = str(trial_end).replace("Z", "+00:00")
        try:
            trial_ends_at = datetime.fromisoformat(trial_end_text)
            if trial_ends_at.tzinfo is None:
                trial_ends_at = trial_ends_at.replace(tzinfo=timezone.utc)
            if trial_ends_at <= datetime.now(timezone.utc):
                subscription_required = True
        except ValueError:
            subscription_required = True

    return {
        "status": status_value,
        "comped": comped,
        "subscription_required": subscription_required,
    }


def ensure_platform_subscription_access(supabase: Client, studio_id: str) -> None:
    access = get_platform_subscription_access(supabase, studio_id)
    if not access["subscription_required"]:
        return

    raise HTTPException(
        status_code=status.HTTP_402_PAYMENT_REQUIRED,
        detail={
            **SUBSCRIPTION_REQUIRED_DETAIL,
            "status": access["status"],
            "comped": access["comped"],
            "subscription_required": True,
        },
    )


def resolve_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
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
                if require_platform_subscription:
                    ensure_platform_subscription_access(supabase, role["studio_id"])
                return role

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to the requested studio.",
        )

    # Preserve a deterministic default for sessions that do not yet carry
    # explicit studio selection. Prefer the most recently created membership,
    # which matches the latest studio a user just onboarded into more often
    # than the oldest historical membership.
    membership = roles[0]

    if require_platform_subscription:
        ensure_platform_subscription_access(supabase, membership["studio_id"])

    return membership


def resolve_admin_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )

    if membership.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins can manage staff roles.",
        )

    return membership


def resolve_program_manager_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )

    if membership.get("role") not in {"admin", "front_desk"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins and front desk staff can manage programs.",
        )

    return membership


def resolve_billing_admin_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )

    if membership.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins can manage billing setup.",
        )

    return membership


def resolve_billing_manager_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
    )

    if membership.get("role") not in {"admin", "front_desk"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins and front desk staff can manage billing.",
        )

    return membership
