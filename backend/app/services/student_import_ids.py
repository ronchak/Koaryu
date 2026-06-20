from __future__ import annotations

import uuid


def deterministic_import_uuid(import_run_id: str, namespace: str, value: str) -> str:
    return str(uuid.uuid5(uuid.UUID(import_run_id), f"{namespace}:{value}"))
