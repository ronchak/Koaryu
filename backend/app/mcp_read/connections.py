"""Connection ownership, live authorization and native Supabase OAuth consent."""

import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

import httpx
from fastapi import HTTPException

from app.mcp_read.catalog import PERMISSIONS
from app.mcp_read.schemas import AUTHORIZATION_ID_PATTERN
from app.services.studio_scope import (
    ensure_platform_subscription_access,
    resolve_staff_role_for_user,
)

CONNECTION_COLUMNS = "id,user_id,studio_id,client_id,client_name,permissions,resource,session_id,authorized_at,expires_at,revoked_at,last_used_at,last_tool,last_dataset,last_row_count"


def owner(client: Any, user_id: str, studio_id: str | None = None, *, require_subscription=True):
    membership = resolve_staff_role_for_user(client, user_id, studio_id)
    if membership.get("role") != "admin":
        raise HTTPException(403, "Only active studio admins can connect an assistant.")
    if require_subscription:
        ensure_platform_subscription_access(client, membership["studio_id"], read_only=True)
    return membership


def authorize_read(client: Any, claims: dict, resource: str) -> dict:
    """No writes, provider repairs, Stripe calls or authorization cache."""
    try:
        connection_id = str(UUID(claims["koaryu_connection_id"]))
        session_id = str(UUID(claims["session_id"]))
        client_id = str(UUID(claims["client_id"]))
        if (
            claims.get("sub") != f"urn:koaryu:mcp:{connection_id}"
            or claims.get("scope") != "offline_access"
        ):
            raise ValueError()
        rows = (
            client.table("mcp_connections")
            .select(CONNECTION_COLUMNS)
            .eq("id", connection_id)
            .eq("client_id", client_id)
            .limit(1)
            .execute()
            .data
        )
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError()
        connection = rows[0]
        expiry = datetime.fromisoformat(connection["expires_at"])
        if (
            connection.get("revoked_at") is not None
            or expiry <= datetime.now(UTC)
            or connection.get("resource") != resource
            or connection.get("session_id") != session_id
            or claims.get("aud") != resource
        ):
            raise ValueError()
        owner(client, str(UUID(connection["user_id"])), connection["studio_id"])
        permissions = connection["permissions"]
        if (
            not isinstance(permissions, list)
            or not permissions
            or any(p not in PERMISSIONS for p in permissions)
        ):
            raise ValueError()
        return connection
    except (KeyError, TypeError, ValueError):
        raise HTTPException(
            401, "Connection expired or disconnected. Connect again in Koaryu."
        ) from None


def list_connections(client: Any, user_id: str) -> list[dict]:
    membership = owner(client, user_id, require_subscription=False)
    rows = (
        client.table("mcp_connections")
        .select(CONNECTION_COLUMNS)
        .eq("user_id", user_id)
        .eq("studio_id", membership["studio_id"])
        .order("authorized_at", desc=True)
        .limit(100)
        .execute()
        .data
    )
    return [public_connection(row) for row in rows or []]


def public_connection(row: dict):
    return {
        key: row.get(key)
        for key in (
            "id",
            "client_id",
            "client_name",
            "permissions",
            "authorized_at",
            "expires_at",
            "revoked_at",
            "last_used_at",
            "last_tool",
            "last_dataset",
            "last_row_count",
        )
    }


async def revoke_native_grant(settings, token: str, client_id: str) -> bool:
    """Local revocation already took effect; clear native consent for reconnect."""
    settings.validate_supabase_service_role_configuration()
    async with httpx.AsyncClient(
        timeout=10.0, trust_env=False, follow_redirects=False
    ) as transport:
        try:
            result = await transport.delete(
                settings.SUPABASE_URL + "/auth/v1/user/oauth/grants",
                params={"client_id": str(UUID(client_id))},
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                },
            )
            return result.status_code in {200, 204, 404}
        except httpx.HTTPError:
            return False


async def oauth_request(settings, token: str, authorization_id: str, *, decision=None):
    """Call only the pinned project's Auth service as the signed-in owner."""
    authorization_id = validate_authorization_id(authorization_id)
    settings.validate_supabase_service_role_configuration()
    url = f"{settings.SUPABASE_URL}/auth/v1/oauth/authorizations/{authorization_id}"
    headers = {"Authorization": f"Bearer {token}", "apikey": settings.SUPABASE_SERVICE_ROLE_KEY}
    async with httpx.AsyncClient(
        timeout=10.0, trust_env=False, follow_redirects=False
    ) as transport:
        try:
            response = await (
                transport.get(url, headers=headers)
                if decision is None
                else transport.post(url + "/consent", headers=headers, json={"action": decision})
            )
            if response.status_code != 200:
                raise HTTPException(
                    400,
                    "This connection request has expired or is unavailable. Start it again in your assistant.",
                )
            data = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(
                503, "Connection authorization is temporarily unavailable."
            ) from None
    if not isinstance(data, dict):
        raise HTTPException(503, "Invalid connection authorization response.")
    return data


def save_consent(
    client,
    user_id: str,
    details: dict,
    authorization_id: str,
    permissions: list[str],
    expires_days: int,
    resource: str,
):
    authorization_id = validate_authorization_id(authorization_id)
    membership = owner(client, user_id)
    require_connector_scope(details)
    if not permissions or any(p not in PERMISSIONS for p in permissions):
        raise HTTPException(422, "Choose at least one supported data permission.")
    try:
        if details["authorization_id"] != authorization_id or str(details["user"]["id"]) != user_id:
            raise ValueError()
        client_id = str(UUID(details["client"]["id"]))
        name = details["client"].get("name") or "AI assistant"
        if not isinstance(name, str) or len(name) > 200:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "Invalid connection authorization request.") from None
    result = (
        client.rpc(
            "authorize_mcp_connection",
            {
                "p_user_id": user_id,
                "p_studio_id": membership["studio_id"],
                "p_client_id": client_id,
                "p_client_name": name,
                # Supabase's browser request ID is an opaque string, not its
                # internal UUID. Preserve stable consent replay semantics without
                # storing or interpreting that external identifier as a UUID.
                "p_consent_id": str(
                    uuid5(
                        NAMESPACE_URL,
                        f"koaryu:mcp:consent:{user_id}:{client_id}:{authorization_id}",
                    )
                ),
                "p_permissions": sorted(set(permissions)),
                "p_resource": resource,
                "p_expires_at": (datetime.now(UTC) + timedelta(days=expires_days)).isoformat(),
            },
        )
        .execute()
        .data
    )
    if not isinstance(result, dict) or not result.get("id"):
        raise HTTPException(503, "Could not save connection access. Try again.")
    return public_connection(result)


def revoke_connection(client, user_id: str, connection_id: UUID):
    membership = owner(client, user_id, require_subscription=False)
    rows = (
        client.table("mcp_connections")
        .update({"revoked_at": datetime.now(UTC).isoformat()})
        .eq("id", str(connection_id))
        .eq("user_id", user_id)
        .eq("studio_id", membership["studio_id"])
        .execute()
        .data
    )
    if not rows:
        raise HTTPException(404, "Connection not found.")
    return public_connection(rows[0])


def require_connector_scope(details: dict):
    if details.get("scope") != "offline_access":
        raise HTTPException(
            400,
            "This connector requires only the offline_access OAuth scope. Restart the connection without OpenID, profile, email or phone scopes.",
        )


def validate_authorization_id(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(AUTHORIZATION_ID_PATTERN, value) is None:
        raise HTTPException(400, "Invalid connection authorization request.")
    return value
