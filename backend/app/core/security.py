import time
from threading import Lock
from typing import Any

import httpx
from fastapi import HTTPException, status
import jwt
from jwt import ExpiredSignatureError, InvalidTokenError as JWTError, PyJWK

from app.core.config import get_settings
from app.db.supabase import get_supabase_client


SUPABASE_AUTH_AUDIENCE = "authenticated"
SUPABASE_AUTH_JWT_OPTIONS = {
    "require": ["aud", "exp", "iat", "iss", "sub"],
    "verify_aud": True,
    "verify_exp": True,
    "verify_iat": True,
    "verify_iss": True,
    "verify_signature": True,
}
SUPABASE_ASYMMETRIC_JWT_ALGORITHMS = {
    "ES256": {"kty": "EC", "crv": "P-256"},
    "RS256": {"kty": "RSA"},
}
SUPABASE_JWKS_CACHE_TTL_SECONDS = 600
SUPABASE_JWKS_FORCED_REFRESH_INTERVAL_SECONDS = 30
SUPABASE_JWKS_REQUEST_TIMEOUT_SECONDS = 2.0

_jwks_cache_lock = Lock()
_jwks_cache: dict[str, Any] = {
    "url": None,
    "expires_at": 0.0,
    "refresh_allowed_at": 0.0,
    "refreshing": False,
    "keys": [],
}


class JWKSUnavailableError(Exception):
    """The signing-key provider is temporarily unavailable or refreshing."""


def _invalid_auth_token_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _clear_jwks_cache_for_tests() -> None:
    """Reset module-level JWKS cache in tests."""
    with _jwks_cache_lock:
        _jwks_cache.update(
            {
                "url": None,
                "expires_at": 0.0,
                "refresh_allowed_at": 0.0,
                "refreshing": False,
                "keys": [],
            }
        )


def _supabase_jwks_url(issuer: str) -> str:
    return f"{issuer}/.well-known/jwks.json"


def _load_supabase_jwks(jwks_url: str, *, force_refresh: bool = False) -> list[dict[str, Any]]:
    # Claim a cache fill under the lock, but perform network I/O after releasing
    # it. Known cached keys remain readable while one caller refreshes, and
    # followers fail closed instead of occupying the request threadpool.
    with _jwks_cache_lock:
        now = time.monotonic()
        if _jwks_cache["url"] != jwks_url:
            _jwks_cache.update(
                {
                    "url": jwks_url,
                    "expires_at": 0.0,
                    "refresh_allowed_at": 0.0,
                    "refreshing": False,
                    "keys": [],
                }
            )

        if not force_refresh and _jwks_cache["expires_at"] > now:
            return list(_jwks_cache["keys"])

        if _jwks_cache["refreshing"]:
            raise JWKSUnavailableError("Supabase JWKS refresh is already in progress")

        # A key miss may justify one early refresh for a legitimate rotation,
        # but random kids must not turn every request into blocking network I/O.
        if force_refresh and _jwks_cache["refresh_allowed_at"] > now:
            return list(_jwks_cache["keys"])

        if not force_refresh and _jwks_cache["refresh_allowed_at"] > now:
            raise JWKSUnavailableError("Supabase JWKS refresh is temporarily throttled")

        _jwks_cache["refreshing"] = True
        _jwks_cache["refresh_allowed_at"] = (
            now + SUPABASE_JWKS_FORCED_REFRESH_INTERVAL_SECONDS
        )

    try:
        response = httpx.get(
            jwks_url,
            timeout=SUPABASE_JWKS_REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        body = response.json()
        keys = body.get("keys") if isinstance(body, dict) else None
        if not isinstance(keys, list) or not all(isinstance(key, dict) for key in keys):
            raise JWKSUnavailableError("Supabase JWKS response is invalid")
    except Exception as exc:
        with _jwks_cache_lock:
            if _jwks_cache["url"] == jwks_url:
                _jwks_cache["refreshing"] = False
        if isinstance(exc, JWKSUnavailableError):
            raise
        raise JWKSUnavailableError("Supabase JWKS could not be loaded") from exc

    with _jwks_cache_lock:
        if _jwks_cache["url"] != jwks_url:
            return list(keys)
        refreshed_at = time.monotonic()
        _jwks_cache.update(
            {
                "expires_at": refreshed_at + SUPABASE_JWKS_CACHE_TTL_SECONDS,
                "refresh_allowed_at": (
                    refreshed_at + SUPABASE_JWKS_FORCED_REFRESH_INTERVAL_SECONDS
                ),
                "refreshing": False,
                "keys": keys,
            }
        )
        return list(keys)


def _jwk_matches_header(key: dict[str, Any], *, kid: str, alg: str) -> bool:
    expected = SUPABASE_ASYMMETRIC_JWT_ALGORITHMS[alg]
    if key.get("kid") != kid:
        return False
    if key.get("alg") != alg:
        return False
    if key.get("kty") != expected["kty"]:
        return False
    if expected.get("crv") and key.get("crv") != expected["crv"]:
        return False
    if key.get("use") not in (None, "sig"):
        return False
    key_ops = key.get("key_ops")
    if key_ops is not None and (
        not isinstance(key_ops, list) or "verify" not in key_ops
    ):
        return False
    return True


def _select_supabase_jwk(jwks_url: str, *, kid: str, alg: str) -> dict[str, Any]:
    for force_refresh in (False, True):
        keys = _load_supabase_jwks(jwks_url, force_refresh=force_refresh)
        for key in keys:
            if _jwk_matches_header(key, kid=kid, alg=alg):
                return key
    raise JWTError("Supabase JWKS key not found")


def _decode_supabase_token_payload(
    token: str,
    *,
    issuer: str,
    jwt_secret: str,
    allow_legacy_hs256: bool,
) -> dict[str, Any]:
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        raise
    except Exception as exc:
        raise JWTError("JWT header is invalid") from exc

    alg = header.get("alg") if isinstance(header, dict) else None
    if alg == "HS256":
        if not allow_legacy_hs256:
            raise JWTError("Legacy HS256 JWT signing is disabled")
        return jwt.decode(
            token,
            jwt_secret,
            algorithms=["HS256"],
            audience=SUPABASE_AUTH_AUDIENCE,
            issuer=issuer,
            options=SUPABASE_AUTH_JWT_OPTIONS,
        )

    if alg in SUPABASE_ASYMMETRIC_JWT_ALGORITHMS:
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid:
            raise JWTError("JWT key id is missing")
        key = _select_supabase_jwk(_supabase_jwks_url(issuer), kid=kid, alg=alg)
        try:
            verification_key = PyJWK.from_dict(key, algorithm=alg)
        except Exception as exc:
            raise JWTError("JWT verification key is invalid") from exc
        return jwt.decode(
            token,
            verification_key,
            algorithms=[alg],
            audience=SUPABASE_AUTH_AUDIENCE,
            issuer=issuer,
            options=SUPABASE_AUTH_JWT_OPTIONS,
        )

    raise JWTError("JWT signing algorithm is unsupported")


def _extract_authenticated_user_id(payload: dict[str, Any]) -> str:
    user_id = payload.get("sub")
    if not isinstance(user_id, str) or not user_id:
        raise _invalid_auth_token_exception()
    if payload.get("role") != SUPABASE_AUTH_AUDIENCE:
        raise _invalid_auth_token_exception()
    return user_id


def _is_production_environment(settings: Any) -> bool:
    return str(getattr(settings, "ENVIRONMENT", "development")).strip().lower() == "production"


def get_user_id_from_token(token: str) -> str:
    """
    Extract user_id from a validated JWT token.
    Verify current asymmetric Supabase access tokens locally. Legacy HS256 is
    accepted only during an explicitly configured migration window. Avoid
    putting Supabase Auth in the hot path for production requests. If local
    development JWT configuration is stale/mismatched, fall back to Supabase
    Auth verification so sign-in still works instead of hard-failing.
    """
    settings = get_settings()
    issuer = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1"

    try:
        payload = _decode_supabase_token_payload(
            token,
            issuer=issuer,
            jwt_secret=settings.SUPABASE_JWT_SECRET,
            allow_legacy_hs256=bool(
                getattr(settings, "SUPABASE_ALLOW_LEGACY_HS256", False)
            ),
        )
        return _extract_authenticated_user_id(payload)
    except JWKSUnavailableError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication keys are temporarily unavailable",
            headers={"Retry-After": str(SUPABASE_JWKS_FORCED_REFRESH_INTERVAL_SECONDS)},
        )
    except ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except JWTError:
        if _is_production_environment(settings):
            raise _invalid_auth_token_exception()
        try:
            response = get_supabase_client().auth.get_user(token)
            if not response or not response.user:
                raise ValueError("Token is invalid or user not found")
            return response.user.id
        except Exception:
            raise _invalid_auth_token_exception()
