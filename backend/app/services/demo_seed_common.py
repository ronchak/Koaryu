from __future__ import annotations

import uuid


DEMO_STUDIO_NAME = "River City Martial Arts"
DEMO_NAMESPACE = uuid.UUID("7d8a064e-135e-47b6-8c6b-c1c4d65b7f82")
DEMO_CONNECT_ACCOUNT_ID = "acct_demo_river_city"
OPTIONAL_SCHEMA_ERROR_CODES = {"42P01", "42703", "PGRST204", "PGRST205"}


def demo_seed_id(studio_id: str, key: str) -> str:
    return str(uuid.uuid5(DEMO_NAMESPACE, f"{studio_id}:{key}"))
