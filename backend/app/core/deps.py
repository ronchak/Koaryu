from typing import Optional

from fastapi import Depends, Header, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.security import get_user_id_from_token
from app.db.supabase import create_supabase_client
from app.services.studio_scope import resolve_staff_role_for_user
from supabase import Client

security = HTTPBearer()
ACTIVE_STUDIO_COOKIE = "koaryu-active-studio"


async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> str:
    """
    FastAPI dependency that extracts and validates the user ID from
    the Authorization Bearer token.
    """
    return get_user_id_from_token(credentials.credentials)


async def get_supabase() -> Client:
    """FastAPI dependency that provides an isolated Supabase admin client."""
    return create_supabase_client()


async def get_requested_studio_id(
    request: Request,
    studio_id_header: Optional[str] = Header(None, alias="X-Studio-Id"),
) -> Optional[str]:
    if studio_id_header:
        return studio_id_header
    return request.cookies.get(ACTIVE_STUDIO_COOKIE)


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
