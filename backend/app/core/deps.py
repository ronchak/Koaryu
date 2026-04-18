from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.core.security import get_user_id_from_token
from app.db.supabase import get_supabase_client
from supabase import Client

security = HTTPBearer()


async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> str:
    """
    FastAPI dependency that extracts and validates the user ID from
    the Authorization Bearer token.
    """
    return get_user_id_from_token(credentials.credentials)


async def get_supabase() -> Client:
    """FastAPI dependency that provides the Supabase admin client."""
    return get_supabase_client()


async def get_current_studio_id(
    user_id: str = Depends(get_current_user_id),
    supabase: Client = Depends(get_supabase),
) -> str:
    """
    FastAPI dependency that resolves the studio_id for the current user.
    Looks up the user's staff_role record.
    """
    result = (
        supabase.table("staff_roles")
        .select("studio_id")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No studio found for this user. Complete onboarding first.",
        )

    return result.data[0]["studio_id"]
