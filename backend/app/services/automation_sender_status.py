"""Read-only sender admission observations for public automation availability."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from app.services.automation_email import email_delivery_status
from app.services.automation_email_credentials import PROVIDER_KEY
from app.services.supabase_rpc import execute_required_rpc

SENDER_STATUS_RPC = "get_automation_sender_status_v1"


@dataclass(frozen=True)
class SenderStatus:
    mode: Literal["ready", "cooldown", "auth_blocked"]
    reason: str | None


@dataclass(frozen=True)
class EmailDeliveryObservation:
    delivery_status: dict[str, Any]
    gate: SenderStatus | None


def read_sender_status(client: Any) -> SenderStatus | None:
    """Accept only the closed status envelope. Uncertainty never grants admission."""
    # Dispatch schemas reach workflow management through simulation. Keep this
    # vocabulary dependency local so status imports cannot create that cycle.
    from app.schemas.workflow_dispatch import TRANSPORT_CODES

    try:
        data = execute_required_rpc(
            client, SENDER_STATUS_RPC, {"p_provider_key": PROVIDER_KEY}
        ).data
        if type(data) is not dict or set(data) != {"payload"}:
            return None
        payload = data["payload"]
        if type(payload) is not dict or set(payload) != {"mode", "reason"}:
            return None
        mode, reason = payload["mode"], payload["reason"]
        if type(mode) is not str or mode not in {"ready", "cooldown", "auth_blocked"}:
            return None
        if mode == "ready":
            if reason is not None:
                return None
        elif type(reason) is not str or reason not in TRANSPORT_CODES | {
            "sender_rejection_unclassified"
        }:
            return None
        return SenderStatus(mode, reason)
    except Exception:  # noqa: BLE001 - Missing, malformed and failed SDK reads are all unavailable.
        return None


def observe_email_delivery_status(settings: Any, client: Any) -> EmailDeliveryObservation:
    """Overlay current admission without altering local preparation eligibility.

    Reading a newer credential binding never repairs or reinterprets the gate.
    This observation is advisory; SQL preparation and begin own actual admission.
    """
    delivery = email_delivery_status(settings, client)
    if delivery.get("can_enable") is not True:
        return EmailDeliveryObservation(delivery, None)
    gate = read_sender_status(client)
    if gate is None or gate.mode != "ready":
        reason = (
            "authentication_required"
            if gate is not None
            and gate.mode == "auth_blocked"
            and gate.reason != "sender_rejection_unclassified"
            else "unavailable"
        )
        delivery = {**delivery, "can_enable": False, "reason": reason}
    return EmailDeliveryObservation(delivery, gate)
