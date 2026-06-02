from fastapi import HTTPException, status
from jose import JWTError, ExpiredSignatureError, jwt

from app.core.config import get_settings
from app.db.supabase import get_supabase_client


SUPABASE_AUTH_AUDIENCE = "authenticated"
SUPABASE_AUTH_JWT_OPTIONS = {
    "require_aud": True,
    "require_exp": True,
    "require_iat": True,
    "require_iss": True,
    "require_sub": True,
    "verify_aud": True,
    "verify_exp": True,
}


def _invalid_auth_token_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_user_id_from_token(token: str) -> str:
    """
    Extract user_id from a validated JWT token.
    Supabase access tokens are HS256-signed JWTs, so we can verify them locally
    and avoid a network round trip to Auth on every request when local env is
    configured correctly. If the local JWT secret is stale/mismatched, fall back
    to Supabase Auth verification so sign-in still works instead of hard-failing.
    """
    settings = get_settings()
    issuer = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1"

    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience=SUPABASE_AUTH_AUDIENCE,
            issuer=issuer,
            options=SUPABASE_AUTH_JWT_OPTIONS,
        )
        user_id = payload.get("sub")
        if not isinstance(user_id, str) or not user_id:
            raise _invalid_auth_token_exception()
        if payload.get("role") != SUPABASE_AUTH_AUDIENCE:
            raise _invalid_auth_token_exception()
        return user_id
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except JWTError:
        try:
            response = get_supabase_client().auth.get_user(token)
            if not response or not response.user:
                raise ValueError("Token is invalid or user not found")
            return response.user.id
        except Exception:
            raise _invalid_auth_token_exception()
