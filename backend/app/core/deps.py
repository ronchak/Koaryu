from typing import Optional

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.security import get_user_id_from_token
from app.db.supabase import create_supabase_client
from app.services.studio_scope import resolve_staff_role_for_user
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
    return get_user_id_from_token(credentials.credentials)


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
