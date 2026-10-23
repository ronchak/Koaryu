#!/usr/bin/env python3
"""Loopback-only synthetic MCP demo. Uses the real transport/query/auth code.

The public demo credential is not a Koaryu account token. The source is an
in-memory test fixture; no Supabase, Stripe, mail or customer data is accessed.
"""

from __future__ import annotations

import argparse
import os
import sys
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]
os.environ["ENVIRONMENT"] = "test"
os.environ["SUPABASE_URL"] = "https://placeholder.supabase.co"
os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "placeholder-key"
os.environ["STRIPE_SECRET_KEY"] = ""

import uvicorn
from fastapi import FastAPI
from starlette.responses import JSONResponse
from test_mcp_read_auth_transport import (
    CLIENT,
    CONNECTION,
    SECRET,
    SESSION,
    USER,
    FixtureRuntime,
    StateDatabase,
    token,
)
from test_mcp_read_query import A, B

from app.core.config import Settings
from app.mcp_read.catalog import DEFAULT_PERMISSIONS
from app.mcp_read.server import build_server

# Avoid loading the caller's .env even indirectly through subscription helpers.
Settings.model_config["env_file"] = None


def fixture(resource):
    rows = {
        "mcp_connections": [
            {
                "id": CONNECTION,
                "user_id": USER,
                "studio_id": A,
                "client_id": CLIENT,
                "client_name": "Synthetic local demo",
                "permissions": list(DEFAULT_PERMISSIONS) + ["billing", "workflows"],
                "resource": resource,
                "session_id": SESSION,
                "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                "revoked_at": None,
            }
        ],
        "staff_roles": [{"user_id": USER, "studio_id": A, "role": "admin", "archived_at": None}],
        "studios": [{"id": A, "name": "Synthetic Cedar Dojo", "timezone": "America/Los_Angeles"}],
        "studio_subscriptions": [
            {
                "studio_id": A,
                "status": "active",
                "comped": True,
                "trial_end": None,
                "stripe_subscription_id": None,
                "stripe_customer_id": None,
                "current_period_start": None,
                "current_period_end": None,
            }
        ],
        "students": [],
        "programs": [],
        "student_program_memberships": [],
        "class_templates": [],
        "class_sessions": [],
        "attendance": [],
        "leads": [],
        "lead_trial_appointments": [],
        "billing_invoices": [],
    }

    def uid(kind, n):
        return f"{kind:08d}-0000-4000-8000-{n:012d}"

    for n, name in enumerate(["Karate", "Jiu-Jitsu"], 1):
        rows["programs"].append(
            {"id": uid(10, n), "studio_id": A, "name": name, "created_at": "2026-01-01T00:00:00Z"}
        )
        rows["class_templates"].append(
            {
                "id": uid(11, n),
                "studio_id": A,
                "name": name + " fundamentals",
                "program_id": uid(10, n),
                "day_of_week": n + 1,
                "start_time": "16:00:00",
                "end_time": "17:00:00",
                "start_date": "2026-01-01",
                "end_date": None,
                "capacity": 20,
                "is_active": True,
            }
        )
    for n, name in enumerate(
        [
            "Ari",
            "Blake",
            "Casey",
            "Devon",
            "Ellis",
            "Finley",
            "Gray",
            "Harper",
            "Indigo",
            "Jules",
            "Kai",
            "Lane",
        ],
        1,
    ):
        rows["students"].append(
            {
                "id": uid(20, n),
                "studio_id": A,
                "legal_first_name": name,
                "legal_last_name": "Example",
                "preferred_name": name,
                "status": "active" if n < 10 else "on_hold",
                "program_id": uid(10, 1 if n % 2 else 2),
                "email": f"student{n}@example.invalid",
                "notes": "Synthetic sample only",
                "tags": ["competition"] if n % 3 == 0 else [],
                "membership_start_date": "2026-01-01",
                "is_minor": True,
                "created_at": "2026-01-01T00:00:00Z",
            }
        )
        rows["student_program_memberships"].append(
            {
                "id": uid(21, n),
                "studio_id": A,
                "student_id": uid(20, n),
                "program_id": uid(10, 1 if n % 2 else 2),
                "status": "active",
                "started_at": "2026-01-01",
            }
        )
    rows["students"].append(
        {
            "id": uid(20, 999),
            "studio_id": B,
            "legal_first_name": "Other studio private student",
            "status": "active",
        }
    )
    for day in range(1, 15):
        rows["class_sessions"].append(
            {
                "id": uid(30, day),
                "studio_id": A,
                "program_id": uid(10, 1),
                "name": "Karate fundamentals",
                "date": f"2026-10-{day:02d}",
                "start_time": "16:00:00",
                "end_time": "17:00:00",
                "status": "completed",
                "capacity": 20,
            }
        )
        for student in range(1, 9):
            if (day + student) % 4:
                rows["attendance"].append(
                    {
                        "id": uid(31, day * 100 + student),
                        "studio_id": A,
                        "student_id": uid(20, student),
                        "session_id": uid(30, day),
                        "status": "present",
                        "checked_in_at": f"2026-10-{day:02d}T23:00:00Z",
                        "counts_toward_eligibility": True,
                        "is_cross_program": False,
                    }
                )
    for n in range(1, 4):
        rows["leads"].append(
            {
                "id": uid(40, n),
                "studio_id": A,
                "first_name": f"Trial {n}",
                "last_name": "Example",
                "stage": "inquiry",
                "source": "website",
                "follow_up_date": "2026-10-20",
            }
        )
        rows["billing_invoices"].append(
            {
                "id": uid(50, n),
                "studio_id": A,
                "status": "open",
                "currency": "usd",
                "amount_due_cents": 15000,
                "amount_remaining_cents": 15000,
                "amount_paid_cents": 0,
                "created_at": "2026-10-01T00:00:00Z",
            }
        )
    return StateDatabase(rows)


def create_demo(port=8101):
    resource = f"http://127.0.0.1:{port}/mcp"
    settings = Settings(
        _env_file=None,
        ENVIRONMENT="test",
        MCP_ENABLED=True,
        MCP_PUBLIC_URL=resource,
        SUPABASE_ALLOW_LEGACY_HS256=True,
        SUPABASE_JWT_SECRET=SECRET,
    )
    encoded, _ = token(settings, exp=int((datetime.now(UTC) + timedelta(days=1)).timestamp()))
    database = fixture(resource)
    server, transport = build_server(settings, FixtureRuntime(database))

    @asynccontextmanager
    async def lifespan(app):
        async with server.session_manager.run():
            yield

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def synthetic_credential_only(request, call_next):
        # Refuse every other token before the native verifier could try JWKS.
        if (
            request.url.path == "/mcp"
            and request.headers.get("authorization") != "Bearer " + encoded
        ):
            return JSONResponse(
                {
                    "error": "Use the public synthetic token from /demo. No real account credentials."
                },
                status_code=401,
            )
        return await call_next(request)

    @app.get("/demo")
    def demo():
        return {
            "mode": "synthetic-only",
            "server_url": resource,
            "token": encoded,
            "expected_students": 12,
            "instructions": "Use this demo credential only with this local synthetic server. Contacts and notes are intentionally not granted.",
        }

    app.mount("/", transport)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8101)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Use a port from 1024 through 65535.")
    print(f"Synthetic Koaryu MCP: http://127.0.0.1:{args.port}/mcp", flush=True)
    print(
        f"Public demo credential and expected results: http://127.0.0.1:{args.port}/demo",
        flush=True,
    )
    uvicorn.run(create_demo(args.port), host="127.0.0.1", port=args.port, access_log=False)
