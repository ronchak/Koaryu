from typing import Optional

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.concurrency import run_in_threadpool
from app.core.security import get_user_id_from_token
from app.db.supabase import create_supabase_client
from app.services.studio_scope import (
    resolve_belt_configuration_admin_staff_role_for_user,
    resolve_lead_conversion_manager_staff_role_for_user,
    resolve_lead_manager_staff_role_for_user,
    resolve_promotion_manager_staff_role_for_user,
    resolve_roster_schedule_manager_staff_role_for_user,
    resolve_staff_role_for_user,
    resolve_write_staff_role_for_user,
)
from supabase import Client

security = HTTPBearer(auto_error=False)
ACTIVE_STUDIO_COOKIE = "koaryu-active-studio"
AUTHENTICATION_REQUIRED_DETAIL = "Invalid authentication token"


def _authentication_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=AUTHENTICATION_REQUIRED_DETAIL,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _normalized_requested_studio_id(value: Optional[str]) -> Optional[str]:
    normalized = value.strip() if value else None
    return normalized or None


async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> str:
    """
    FastAPI dependency that extracts and validates the user ID from
    the Authorization Bearer token.
    """
    if credentials is None or not credentials.credentials:
        raise _authentication_exception()
    # JWKS verification can perform a bounded synchronous provider request on a
    # cold cache or key rotation. Keep that I/O off the ASGI event loop.
    return await run_in_threadpool(get_user_id_from_token, credentials.credentials)


async def get_supabase() -> Client:
    """FastAPI dependency that provides an isolated Supabase admin client."""
    return create_supabase_client()


async def get_requested_studio_id(
    request: Request,
    studio_id_header: Optional[str] = Header(None, alias="X-Studio-Id"),
) -> Optional[str]:
    """
    Return an optional active-studio selector from request state.

    This value is not tenant identity proof. It only selects which membership
    the authenticated user wants to operate in; service dependencies must pass
    it through studio_scope resolution before using it for data access.
    """
    requested_from_header = _normalized_requested_studio_id(studio_id_header)
    if requested_from_header:
        return requested_from_header
    return _normalized_requested_studio_id(request.cookies.get(ACTIVE_STUDIO_COOKIE))


async def get_current_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    """
    FastAPI dependency that resolves the studio_id for the current user.
    Prefers an explicitly requested studio when present and validates that the
    user belongs to it. Falls back to a deterministic membership when the
    request does not yet carry active studio state.
    """
    membership = resolve_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


async def get_current_write_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    membership = resolve_write_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


async def get_current_write_staff_role(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> dict:
    return resolve_write_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )


async def get_roster_schedule_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    membership = resolve_roster_schedule_manager_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


async def get_belt_configuration_admin_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    membership = resolve_belt_configuration_admin_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


async def get_promotion_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    membership = resolve_promotion_manager_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


async def get_lead_conversion_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    membership = resolve_lead_conversion_manager_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]


async def get_lead_manager_studio_id(
    user_id: str = Depends(get_current_user_id),
    requested_studio_id: Optional[str] = Depends(get_requested_studio_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    membership = resolve_lead_manager_staff_role_for_user(
        supabase,
        user_id,
        requested_studio_id,
        require_platform_subscription=True,
    )
    return membership["studio_id"]
