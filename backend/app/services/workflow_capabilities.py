"""Advisory workflow availability from current schema, sender and Auth facts."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from uuid import UUID

from app.services.automation_email import (
    delivery_configuration,
    email_delivery_status,
    normalize_email_address,
)
from app.services.generated_release_readiness import RELEASE_PREFLIGHT_RPC
from app.services.release_schema_readiness import validate_release_schema_preflight
from app.services.supabase_rpc import execute_required_rpc

_WORKFLOW_PREFLIGHT_RPC = "koaryu_release_schema_preflight_v38"
_WORKFLOW_MANIFEST = "release-db-attestation-v57"


def _preflight_row(client: Any, name: str) -> dict[str, Any]:
    data = execute_required_rpc(client, name, {}).data
    if isinstance(data, list) and len(data) == 1:
        data = data[0]
    if (
        not isinstance(data, dict)
        or set(data)
        != {
            "ready",
            "migration_count",
            "migration_head",
            "pending_versions",
            "security_failures",
            "manifest_version",
        }
        or type(data.get("migration_count")) is not int
        or data["migration_count"] <= 0
        or not isinstance(data.get("migration_head"), str)
        or re.fullmatch(r"[0-9]{14}", data["migration_head"]) is None
        or not isinstance(data.get("pending_versions"), list)
        or not data["pending_versions"]
        or not all(
            isinstance(item, str) and re.fullmatch(r"[0-9]{14}", item)
            for item in data["pending_versions"]
        )
        or data["pending_versions"] != sorted(set(data["pending_versions"]))
        or data["pending_versions"][-1] != data["migration_head"]
        or len(data["pending_versions"]) > data["migration_count"]
        or data.get("security_failures") != []
    ):
        raise ValueError("invalid_workflow_preflight")
    return data


def _schema_ready(client: Any) -> bool:
    try:
        current = _preflight_row(client, RELEASE_PREFLIGHT_RPC)
        validate_release_schema_preflight(current)
        # The current generated contract binds exact release facts. The original
        # guarded V38 contract binds workflow support, including its future
        # compatibility checks, without another hand-maintained head/count pin.
        workflow = (
            current
            if RELEASE_PREFLIGHT_RPC == _WORKFLOW_PREFLIGHT_RPC
            else _preflight_row(client, _WORKFLOW_PREFLIGHT_RPC)
        )
        return (
            workflow.get("ready") is True and workflow.get("manifest_version") == _WORKFLOW_MANIFEST
        )
    except Exception:  # noqa: BLE001 - Provider and malformed SDK failures disable this advisory action.
        return False


def _verified_test_recipient(client: Any, settings: Any, actor_id: Any) -> bool:
    try:
        actor = str(UUID(str(actor_id)))
        response = client.auth.admin.get_user_by_id(actor)
        user = response.user
        if str(UUID(user.id)) != actor:
            return False
        confirmed = user.email_confirmed_at
        if isinstance(confirmed, str):
            confirmed = datetime.fromisoformat(confirmed)
        if not isinstance(confirmed, datetime) or confirmed.utcoffset() is None:
            return False
        recipient = normalize_email_address(user.email)
        allowed = delivery_configuration(settings).allowed_recipients
        return not allowed or recipient in allowed
    except Exception:  # noqa: BLE001 - Provider and malformed SDK failures disable this advisory action.
        return False


def resolve_workflow_capabilities(client: Any, settings: Any, actor_id: Any) -> dict[str, Any]:
    """Run inside the caller's bounded Supabase lane after studio authorization.

    The supplied repository client uses the pinned Auth SDK's finite HTTP timeout.
    This synchronous helper creates no client, refreshes no credential, and sends
    nothing. The test-mail owner must recheck identity immediately before sending.
    """
    delivery = email_delivery_status(settings, client)
    ready = _schema_ready(client)
    worker_enabled = getattr(settings, "AUTOMATION_WORKER_ENABLED", False) is True
    sender_ready = delivery.get("can_enable") is True
    can_start = ready and sender_ready and worker_enabled
    can_test_email = ready and sender_ready and _verified_test_recipient(client, settings, actor_id)
    if not ready:
        reason = "Workflow setup is unavailable."
    elif not sender_ready:
        reason = "Email sending is unavailable."
    elif not worker_enabled and not can_test_email:
        reason = "Workflow scheduling and test email are unavailable."
    elif not worker_enabled:
        reason = "Workflow scheduling is disabled."
    elif not can_test_email:
        reason = "Test email requires an available verified account email."
    else:
        reason = None
    return {
        "delivery_status": delivery,
        "capabilities": {
            "can_start": can_start,
            "can_test_email": can_test_email,
            "disabled_reason": reason,
        },
        "scheduler": {"enabled": worker_enabled, "interval_seconds": 60},
    }
