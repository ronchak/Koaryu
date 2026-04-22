from fastapi import HTTPException, status
from app.db.supabase import get_supabase_client


def get_user_id_from_token(token: str) -> str:
    """
    Extract user_id from a validated JWT token using the Supabase client.
    This avoids local algorithm mismatch issues (like ES256 vs HS256) by
    having the official Supabase Gotrue instance validate the token natively.
    """
    try:
        # get_user with a token explicitly fetches and verifies the user session
        res = get_supabase_client().auth.get_user(token)
        if not res or not res.user:
            raise ValueError("Token is invalid or user not found")
        return res.user.id
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid authentication token: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )
