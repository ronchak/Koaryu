from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import HTTPException, status
from supabase import Client

from app.core.config import PERMISSIVE_ENVIRONMENTS, get_settings

ACTIVE_PLATFORM_SUBSCRIPTION_STATUSES = {"active", "trialing", "comped"}
SUBSCRIPTION_REQUIRED_DETAIL = {
    "code": "SUBSCRIPTION_REQUIRED",
    "message": "Koaryu Core subscription required.",
}
BILLING_STATUS_UNAVAILABLE_DETAIL = {
    "code": "BILLING_STATUS_UNAVAILABLE",
    "message": "Koaryu Core subscription status could not be verified. Try again shortly.",
}
MISSING_STRIPE_CONFIGURATION_DETAIL = "Stripe is not configured for this environment."
STAFF_ROLE_MEMBERSHIP_COLUMNS = "studio_id, role, created_at, archived_at"
STAFF_MEMBERSHIP_STATUS = Literal["none", "active", "archived"]
STAFF_ARCHIVED_DETAIL = {
    "code": "STAFF_ARCHIVED",
    "message": "This staff account is archived.",
}
MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL = {
    "code": "MULTIPLE_STUDIO_MEMBERSHIPS",
    "message": (
        "This account has more than one studio membership. "
        "Contact the account owner or Koaryu support before continuing."
    ),
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
        .is_("archived_at", None)
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
        .select(STAFF_ROLE_MEMBERSHIP_COLUMNS)
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return result.data or []


def resolve_staff_membership_state_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    user_email: Optional[str] = None,
    require_explicit_studio_selection: bool = False,
) -> tuple[Optional[dict], STAFF_MEMBERSHIP_STATUS]:
    """Resolve active access while retaining archived identity state.

    The query intentionally includes archived rows. They are reservations and
    must participate in ambiguity checks, but they never become an active
    tenant membership.
    """
    _ = user_email
    _ = require_explicit_studio_selection
    roles = list_staff_roles_for_user(supabase, user_id)

    # Koaryu supports exactly one studio per Auth identity. Fail closed before
    # considering a caller-controlled selector, including for archived rows.
    if len(roles) > 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=MULTIPLE_STUDIO_MEMBERSHIPS_DETAIL,
        )

    membership = None
    if requested_studio_id:
        membership = next(
            (
                role for role in roles
                if role.get("studio_id") == requested_studio_id
            ),
            None,
        )
        if membership is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have access to the requested studio.",
            )
    elif roles:
        membership = roles[0]

    if membership is None:
        return None, "none"
    if membership.get("archived_at") is not None:
        return None, "archived"
    return membership, "active"


def get_platform_subscription_access(supabase: Client, studio_id: str) -> dict:
    from app.services.platform_billing_service import (
        AccessRepairDeferred,
        AccessRepairInFlight,
        AccessRepairProviderError,
        PlatformBillingService,
    )

    try:
        row = PlatformBillingService(supabase).get_access_status_row(studio_id, strict_repairs=True)
        return _platform_subscription_access_from_row(row)
    except AccessRepairInFlight:
        # The async request boundary releases the provider-lane permit, awaits
        # the leader's completion signal, and retries with this request's own
        # thread-affine client.
        raise
    except (AccessRepairProviderError, AccessRepairDeferred) as exc:
        # A provider fault must never upgrade a studio, so local state is
        # consulted here only to deny. When the local row already shows the
        # studio as non-entitled the answer does not depend on Stripe at all,
        # and reporting SUBSCRIPTION_REQUIRED is both accurate and actionable;
        # returning BILLING_STATUS_UNAVAILABLE instead told a lapsed studio that
        # Koaryu was broken. A locally entitled row is still not trusted while
        # it cannot be verified, so it continues to fail closed below.
        #
        # AccessRepairDeferred arrives here for the same reason: it is a repair
        # that failed earlier in the window, replayed, and it must produce the
        # answer that failure produced.
        local_access = _get_local_platform_subscription_access(supabase, studio_id)
        if local_access["subscription_required"]:
            return local_access

        raise _billing_status_unavailable_exception() from exc
    except Exception as exc:
        if _is_noncritical_access_repair_error(exc):
            return _get_local_platform_subscription_access(supabase, studio_id)

        # Our own code failed — a persistence write, the projector, Supabase.
        # That is no evidence about this studio's entitlement, so it is not
        # answered from local state: telling a studio SUBSCRIPTION_REQUIRED
        # because our projector raised presents our outage as their billing
        # problem, and hides the fault behind a response that looks routine.
        raise _billing_status_unavailable_exception() from exc


def _platform_subscription_access_from_row(row: dict) -> dict:
    status_value = row.get("status") or "incomplete"
    comped = bool(row.get("comped", False))
    subscription_required = not (comped or status_value in ACTIVE_PLATFORM_SUBSCRIPTION_STATUSES)
    trial_end = row.get("trial_end")
    if status_value == "trialing" and trial_end and _trial_has_ended(trial_end):
        subscription_required = True

    return {
        "status": status_value,
        "comped": comped,
        "subscription_required": subscription_required,
    }


def _is_noncritical_access_repair_error(exc: Exception) -> bool:
    environment = get_settings().ENVIRONMENT.strip().lower()
    return (
        isinstance(exc, HTTPException)
        and exc.status_code == status.HTTP_409_CONFLICT
        and exc.detail == MISSING_STRIPE_CONFIGURATION_DETAIL
        and environment in PERMISSIVE_ENVIRONMENTS
    )


def _billing_status_unavailable_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            **BILLING_STATUS_UNAVAILABLE_DETAIL,
            "subscription_required": True,
        },
    )


def _get_local_platform_subscription_access(supabase: Client, studio_id: str) -> dict:
    result = (
        supabase.table("studio_subscriptions")
        .select("status, comped, trial_end")
        .eq("studio_id", studio_id)
        .maybe_single()
        .execute()
    )
    return _platform_subscription_access_from_row(result.data or {})


def _trial_has_ended(trial_end: str) -> bool:
    trial_end_text = str(trial_end).replace("Z", "+00:00")
    try:
        trial_ends_at = datetime.fromisoformat(trial_end_text)
        if trial_ends_at.tzinfo is None:
            trial_ends_at = trial_ends_at.replace(tzinfo=timezone.utc)
        return trial_ends_at <= datetime.now(timezone.utc)
    except ValueError:
        return True


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


def resolve_optional_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    user_email: Optional[str] = None,
    require_platform_subscription: bool = False,
    require_explicit_studio_selection: bool = False,
) -> Optional[dict]:
    """
    Resolve the authenticated user's authoritative studio membership.

    `requested_studio_id` comes from caller-controlled active-studio state and
    is only a selector. The returned membership is the server-verified tenant
    identity. Returning None is reserved for a true no-membership identity;
    archived-only identities fail closed with the stable archived denial.
    """
    # Pending invite rows are not memberships. StaffService links invites to
    # the Supabase Auth user returned by invite_user_by_email; this resolver
    # must not grant access from email equality alone.
    _ = user_email
    membership, membership_status = resolve_staff_membership_state_for_user(
        supabase,
        user_id,
        requested_studio_id,
        user_email=user_email,
        require_explicit_studio_selection=require_explicit_studio_selection,
    )

    if membership_status == "archived":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=STAFF_ARCHIVED_DETAIL,
        )

    if membership_status == "active" and membership and require_platform_subscription:
        ensure_platform_subscription_access(supabase, membership["studio_id"])

    return membership


def resolve_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
    require_explicit_studio_selection: bool = False,
) -> dict:
    membership, membership_status = resolve_staff_membership_state_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_explicit_studio_selection=require_explicit_studio_selection,
    )

    if membership_status == "archived":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=STAFF_ARCHIVED_DETAIL,
        )

    if membership is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No studio found for this user. Complete onboarding first.",
        )

    if require_platform_subscription:
        ensure_platform_subscription_access(supabase, membership["studio_id"])

    return membership


def resolve_write_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=require_platform_subscription,
        require_explicit_studio_selection=True,
    )


def _resolve_write_staff_role_for_allowed_roles(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str],
    *,
    allowed_roles: set[str],
    detail: str,
    require_platform_subscription: bool = False,
) -> dict:
    membership = resolve_write_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
    )

    if membership.get("role") not in allowed_roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=detail,
        )

    if require_platform_subscription:
        ensure_platform_subscription_access(supabase, membership["studio_id"])

    return membership


def resolve_roster_schedule_manager_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return _resolve_write_staff_role_for_allowed_roles(
        supabase,
        user_id,
        requested_studio_id,
        allowed_roles={"admin", "front_desk"},
        detail="Only studio admins and front desk staff can perform roster or schedule bulk and deletion actions.",
        require_platform_subscription=require_platform_subscription,
    )


def resolve_belt_configuration_admin_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return _resolve_write_staff_role_for_allowed_roles(
        supabase,
        user_id,
        requested_studio_id,
        allowed_roles={"admin"},
        detail="Only studio admins can manage belt configuration.",
        require_platform_subscription=require_platform_subscription,
    )


def resolve_promotion_manager_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return _resolve_write_staff_role_for_allowed_roles(
        supabase,
        user_id,
        requested_studio_id,
        allowed_roles={"admin", "instructor"},
        detail="Only studio admins and instructors can promote or demote students.",
        require_platform_subscription=require_platform_subscription,
    )


def resolve_lead_conversion_manager_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return _resolve_write_staff_role_for_allowed_roles(
        supabase,
        user_id,
        requested_studio_id,
        allowed_roles={"admin", "front_desk"},
        detail="Only studio admins and front desk staff can convert leads.",
        require_platform_subscription=require_platform_subscription,
    )


def resolve_lead_manager_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return _resolve_write_staff_role_for_allowed_roles(
        supabase,
        user_id,
        requested_studio_id,
        allowed_roles={"admin", "front_desk"},
        detail="Only studio admins and front desk staff can manage leads.",
        require_platform_subscription=require_platform_subscription,
    )


def resolve_billing_routine_write_staff_role_for_user(
    supabase: Client,
    user_id: str,
    requested_studio_id: Optional[str] = None,
    *,
    require_platform_subscription: bool = False,
) -> dict:
    return _resolve_write_staff_role_for_allowed_roles(
        supabase,
        user_id,
        requested_studio_id,
        allowed_roles={"admin", "front_desk"},
        detail="Only studio admins and front desk staff can perform routine billing actions.",
        require_platform_subscription=require_platform_subscription,
    )


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
    )

    if membership.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins can manage billing setup.",
        )

    if require_platform_subscription:
        ensure_platform_subscription_access(supabase, membership["studio_id"])

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
    )

    if membership.get("role") not in {"admin", "front_desk"}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only studio admins and front desk staff can view billing.",
        )

    if require_platform_subscription:
        ensure_platform_subscription_access(supabase, membership["studio_id"])

    return membership
