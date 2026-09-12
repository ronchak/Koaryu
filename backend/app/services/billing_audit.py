from typing import Any

from supabase import Client


def record_billing_audit(
    client: Client,
    studio_id: str,
    actor_id: str,
    action: str,
    entity_id: str,
    metadata: dict[str, Any],
) -> None:
    client.table("audit_logs").insert(
        {
            "studio_id": studio_id,
            "actor_id": actor_id,
            "action": action,
            "entity_type": "billing",
            "entity_id": entity_id,
            "metadata": metadata,
        }
    ).execute()
