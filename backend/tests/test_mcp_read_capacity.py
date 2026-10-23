"""Competing studio reads must not consume live authorization capacity."""

import asyncio
import threading
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from test_mcp_read_auth_transport import CLIENT, CONNECTION, SESSION, USER, StateDatabase, token
from test_mcp_read_query import A, B

from app.core.config import Settings
from app.core.provider_lane import ProviderLaneSaturatedError
from app.core.provider_runtime import SupabaseProviderRuntime
from app.mcp_read.server import READ_LANE, Runtime, Verifier

OTHER_USER = "50000000-0000-0000-0000-000000000002"
OTHER_CLIENT = "60000000-0000-0000-0000-000000000002"
OTHER_CONNECTION = "70000000-0000-0000-0000-000000000002"
OTHER_SESSION = "80000000-0000-0000-0000-000000000002"


def setup():
    settings = Settings(
        _env_file=None,
        ENVIRONMENT="test",
        MCP_ENABLED=True,
        MCP_PUBLIC_URL="http://localhost:8001/mcp",
        SUPABASE_ALLOW_LEGACY_HS256=True,
        SUPABASE_JWT_SECRET="synthetic-test-signing-key-only-never-used-for-real-data",
    )
    grants, memberships, subscriptions = [], [], []
    for studio, user, client, connection, session in [
        (A, USER, CLIENT, CONNECTION, SESSION),
        (B, OTHER_USER, OTHER_CLIENT, OTHER_CONNECTION, OTHER_SESSION),
    ]:
        grants.append(
            {
                "id": connection,
                "user_id": user,
                "studio_id": studio,
                "client_id": client,
                "session_id": session,
                "permissions": ["students"],
                "resource": settings.MCP_PUBLIC_URL,
                "revoked_at": None,
                "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            }
        )
        memberships.append(
            {"user_id": user, "studio_id": studio, "role": "admin", "archived_at": None}
        )
        subscriptions.append(
            {
                "studio_id": studio,
                "status": "active",
                "comped": True,
                "trial_end": None,
                "stripe_subscription_id": None,
                "stripe_customer_id": None,
                "current_period_start": None,
                "current_period_end": None,
            }
        )
    database = StateDatabase(
        {
            "mcp_connections": grants,
            "staff_roles": memberships,
            "studio_subscriptions": subscriptions,
        }
    )
    runtime = Runtime()

    def provider(interactive, bulk, **kwargs):
        return SupabaseProviderRuntime(
            interactive,
            bulk,
            client_factory=lambda: database,
            client_closer=lambda _: None,
            **kwargs,
        )

    with patch("app.mcp_read.server.SupabaseProviderRuntime", side_effect=provider):
        runtime.start()
    encoded, _ = token(
        settings,
        sub="urn:koaryu:mcp:" + OTHER_CONNECTION,
        client_id=OTHER_CLIENT,
        koaryu_connection_id=OTHER_CONNECTION,
        session_id=OTHER_SESSION,
    )
    return settings, database, runtime, encoded


async def wait_for(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.005)


def blocking_reads(runtime, release):
    started = [threading.Event() for _ in range(READ_LANE.max_workers)]

    def operation(index):
        def read(_client):
            started[index].set()
            if not release.wait(5):
                raise RuntimeError("Synthetic blocked read was not released")
            return index

        return read

    tasks = [asyncio.create_task(runtime.run(operation(index))) for index in range(len(started))]
    return started, tasks


def test_slow_reads_do_not_block_another_studio_authentication():
    async def scenario():
        settings, _database, runtime, encoded = setup()
        release = threading.Event()
        started, tasks = blocking_reads(runtime, release)
        try:
            await wait_for(lambda: all(event.is_set() for event in started))
            verified = await asyncio.wait_for(
                Verifier(settings, runtime).verify_token(encoded), timeout=2
            )
            assert verified is not None and verified.subject == "urn:koaryu:mcp:" + OTHER_CONNECTION
            assert runtime.provider.bulk_snapshot().active == READ_LANE.max_workers
            assert runtime.provider.interactive_snapshot().completed == 1
        finally:
            release.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            await runtime.close()
        assert runtime.provider is None

    asyncio.run(scenario())


def test_cancelled_read_cannot_hide_revocation_or_release_physical_capacity_early():
    async def scenario():
        settings, database, runtime, _encoded = setup()
        release = threading.Event()
        started, tasks = blocking_reads(runtime, release)
        try:
            await wait_for(lambda: all(event.is_set() for event in started))
            tasks[0].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[0]
            assert runtime.provider.bulk_snapshot().active == READ_LANE.max_workers
            database.data["mcp_connections"][0]["revoked_at"] = datetime.now(UTC).isoformat()
            encoded, _ = token(settings)
            assert (
                await asyncio.wait_for(Verifier(settings, runtime).verify_token(encoded), timeout=2)
                is None
            )
            assert runtime.provider.bulk_snapshot().cancelled == 1
        finally:
            release.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            await runtime.close()

    asyncio.run(scenario())


def test_read_overload_is_bounded_while_authentication_keeps_working():
    async def scenario():
        settings, _database, runtime, encoded = setup()
        release = threading.Event()
        started, tasks = blocking_reads(runtime, release)
        queued = []
        try:
            await wait_for(lambda: all(event.is_set() for event in started))
            queued = [
                asyncio.create_task(runtime.run(lambda _client: "queued"))
                for _ in range(READ_LANE.max_queue)
            ]
            await wait_for(
                lambda: (
                    runtime.provider.bulk_snapshot().admitted
                    == READ_LANE.max_workers + READ_LANE.max_queue
                )
            )
            with pytest.raises(ProviderLaneSaturatedError):
                await runtime.run(lambda _client: "must not be admitted")
            verified = await asyncio.wait_for(
                Verifier(settings, runtime).verify_token(encoded), timeout=2
            )
            assert verified is not None
            snapshot = runtime.provider.bulk_snapshot()
            assert snapshot.submitted == READ_LANE.max_workers + READ_LANE.max_queue
            assert snapshot.saturated == 1
        finally:
            release.set()
            await asyncio.gather(*tasks, *queued, return_exceptions=True)
            await runtime.close()

    asyncio.run(scenario())
