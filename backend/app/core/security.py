from jose import jwt, JWTError
from fastapi import HTTPException, status
from app.core.config import get_settings


def decode_jwt(token: str) -> dict:
    """
    Decode and validate a Supabase JWT token.
    Returns the payload dict with user info.
    """
    settings = get_settings()

    try:
        payload = jwt.decode(
            token,
            settings.SUPABASE_JWT_SECRET,
            algorithms=["HS256"],
            audience="authenticated",
        )
        return payload
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid authentication token: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )


def get_user_id_from_token(token: str) -> str:
    """Extract user_id (sub) from a validated JWT token."""
    payload = decode_jwt(token)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing user identifier",
        )
    return user_id
