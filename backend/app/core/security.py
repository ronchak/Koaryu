from fastapi import HTTPException, status
from jose import JWTError, ExpiredSignatureError, jwt

from app.core.config import get_settings
from app.db.supabase import get_supabase_client


def get_user_id_from_token(token: str) -> str:
    """
    Extract user_id from a validated JWT token.
    Supabase access tokens are HS256-signed JWTs, so we can verify them locally
    and avoid a network round trip to Auth on every request when local env is
    configured correctly. If the local JWT secret is stale/mismatched, fall back
    to Supabase Auth verification so sign-in still works instead of hard-failing.
    """
    try:
        payload = jwt.decode(
            token,
            get_settings().SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        user_id = payload.get("sub")
        if not isinstance(user_id, str) or not user_id:
            raise JWTError("Missing subject claim")
        return user_id
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except JWTError as exc:
        try:
            response = get_supabase_client().auth.get_user(token)
            if not response or not response.user:
                raise ValueError("Token is invalid or user not found")
            return response.user.id
        except Exception as fallback_error:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=f"Invalid authentication token: {str(fallback_error or exc)}",
                headers={"WWW-Authenticate": "Bearer"},
            )
