"""Owner-facing connection management. These are ordinary app-auth routes."""

from typing import Annotated
from urllib.parse import urlparse
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import Field

from app.core.config import get_settings
from app.core.deps import (
    ProviderDependency,
    get_current_user_id,
    get_supabase,
    run_supabase_operation,
    security,
)
from app.mcp_read.catalog import DEFAULT_PERMISSIONS, PERMISSIONS
from app.mcp_read.connections import (
    list_connections,
    oauth_request,
    owner,
    require_connector_scope,
    revoke_connection,
    revoke_native_grant,
    save_consent,
)
from app.mcp_read.schemas import AUTHORIZATION_ID_PATTERN, Contract

router = APIRouter(prefix="/mcp", tags=["AI connections"])
AuthorizationId = Annotated[
    str, Path(pattern=AUTHORIZATION_ID_PATTERN, min_length=16, max_length=128)
]


class Consent(Contract):
    permissions: Annotated[list[str], Field(min_length=1, max_length=9)]
    expires_days: Annotated[int, Field(strict=True, ge=1, le=90)] = 30


def enabled():
    settings = get_settings()
    if not settings.MCP_ENABLED:
        raise HTTPException(404, "AI connections are not enabled on this server.")
    settings.validated_mcp_url()
    return settings


def safe_redirect(data):
    value = data.get("redirect_url")
    parsed = urlparse(value or "")
    if (
        not isinstance(value, str)
        or len(value) > 8192
        or any(ord(c) < 32 for c in value)
        or parsed.username
        or parsed.password
        or not parsed.hostname
        or (
            parsed.scheme != "https"
            and not (
                parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
            )
        )
    ):
        raise HTTPException(502, "The assistant returned an unsupported callback address.")
    return {"redirect_url": value}


@router.get("/connections")
async def connections(
    response: Response,
    user_id: Annotated[str, Depends(get_current_user_id)],
    provider: Annotated[ProviderDependency, Depends(get_supabase)],
):
    settings = get_settings()
    response.headers["Cache-Control"] = "no-store"
    if not settings.MCP_ENABLED:
        return {
            "enabled": False,
            "connections": [],
            "permissions": {},
            "default_permissions": [],
            "server_url": None,
        }
    rows = await run_supabase_operation(provider, lambda client: list_connections(client, user_id))
    return {
        "enabled": True,
        "connections": rows,
        "permissions": dict(PERMISSIONS),
        "default_permissions": DEFAULT_PERMISSIONS,
        "server_url": settings.validated_mcp_url(),
    }


@router.get("/authorizations/{authorization_id}")
async def authorization(
    authorization_id: AuthorizationId,
    response: Response,
    user_id: Annotated[str, Depends(get_current_user_id)],
    provider: Annotated[ProviderDependency, Depends(get_supabase)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
):
    settings = enabled()
    response.headers["Cache-Control"] = "no-store"
    await run_supabase_operation(provider, lambda client: owner(client, user_id))
    data = await oauth_request(settings, credentials.credentials, authorization_id)
    if "redirect_url" in data:
        return safe_redirect(data)
    try:
        if data["user"]["id"] != user_id or data["authorization_id"] != authorization_id:
            raise ValueError()
        UUID(data["client"]["id"])
        client_name = data["client"].get("name") or "AI assistant"
        if not isinstance(client_name, str) or len(client_name) > 200:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "Invalid connection request.") from None
    require_connector_scope(data)
    # Client metadata is self-declared. Never fetch its logo, site, or callback.
    return {
        "authorization_id": str(authorization_id),
        "client_name": client_name,
        "redirect_uri": data.get("redirect_uri"),
        "identity_scope": data.get("scope", ""),
        "permissions": dict(PERMISSIONS),
        "default_permissions": DEFAULT_PERMISSIONS,
    }


@router.post("/authorizations/{authorization_id}/approve")
async def approve(
    authorization_id: AuthorizationId,
    consent: Consent,
    response: Response,
    user_id: Annotated[str, Depends(get_current_user_id)],
    provider: Annotated[ProviderDependency, Depends(get_supabase)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
):
    settings = enabled()
    response.headers["Cache-Control"] = "no-store"
    data = await oauth_request(settings, credentials.credentials, authorization_id)
    # An already native-approved request must not silently grant new permissions.
    if "redirect_url" in data:
        return safe_redirect(data)
    await run_supabase_operation(
        provider,
        lambda client: save_consent(
            client,
            user_id,
            data,
            authorization_id,
            consent.permissions,
            consent.expires_days,
            settings.validated_mcp_url(),
        ),
    )
    return safe_redirect(
        await oauth_request(settings, credentials.credentials, authorization_id, decision="approve")
    )


@router.post("/authorizations/{authorization_id}/deny")
async def deny(
    authorization_id: AuthorizationId,
    response: Response,
    user_id: Annotated[str, Depends(get_current_user_id)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
):
    settings = enabled()
    response.headers["Cache-Control"] = "no-store"
    return safe_redirect(
        await oauth_request(settings, credentials.credentials, authorization_id, decision="deny")
    )


@router.delete("/connections/{connection_id}")
async def revoke(
    connection_id: UUID,
    response: Response,
    user_id: Annotated[str, Depends(get_current_user_id)],
    provider: Annotated[ProviderDependency, Depends(get_supabase)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
):
    settings = enabled()
    response.headers["Cache-Control"] = "no-store"
    result = await run_supabase_operation(
        provider, lambda client: revoke_connection(client, user_id, connection_id)
    )
    result["native_consent_removed"] = await revoke_native_grant(
        settings, credentials.credentials, result["client_id"]
    )
    return result
