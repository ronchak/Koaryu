"""Nested provider clients retain bounded I/O and their own thread ownership."""
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException

from app.core.deps import run_supabase_operation
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas.auth import AuthResponse, UserProfile
from app.services.dashboard_bootstrap_service import DashboardBootstrapService
from app.services.stripe_mutation_policy import LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS
from app.services.stripe_service import StripeService


@pytest.fixture
def nested_provider():
    release = threading.Event()
    state = SimpleNamespace(stall=False, requests=0)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            with lock:
                state.requests += 1
            if state.stall:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.write(b"[")
                self.wfile.flush()
                release.wait(2)
                return
            table = self.path.split("?")[0].split("/")[-1]
            data = {"id": "studio-1", "name": "Fixture", "slug": "fixture", "timezone": "UTC"} if table == "studios" else []
            payload = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Range", "*/0")
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = SimpleNamespace(
        SUPABASE_URL=f"http://127.0.0.1:{server.server_port}",
        SUPABASE_SERVICE_ROLE_KEY="header.payload.signature",
        validate_supabase_service_role_configuration=lambda: None,
    )
    with patch("app.db.supabase.get_settings", return_value=settings):
        yield state
    release.set()
    server.shutdown()
    server.server_close()
    thread.join()


def lane(*, caller=2, transport=0.15):
    return SupabaseLaneConfig(1, 0, 0.02, caller, postgrest_client_timeout=transport)


def bootstrap_auth():
    return AuthResponse(
        user=UserProfile(id="user-1", email="fixture@example.invalid", full_name="Fixture"),
        staff_profiles_available=True, studio_id="studio-1", role="admin",
    )


@pytest.mark.parametrize("stalled", [False, True])
@pytest.mark.parametrize("allow_partial", [False, True])
def test_all_five_bootstrap_clients_inherit_budget_and_drain_before_capacity_returns(nested_provider, stalled, allow_partial):
    nested_provider.stall = stalled
    created = []
    closed = []
    clients = []
    lock = threading.Lock()

    def factory(**options):
        client = create_supabase_client(**options)
        with lock:
            clients.append(client)
            created.append((id(client), threading.get_ident(), client.postgrest.session.timeout.read))
        return client

    def closer(client):
        close_supabase_client(client)
        with lock:
            closed.append((id(client), threading.get_ident()))

    async def scenario():
        runtime = SupabaseProviderRuntime(lane(caller=0.04 if stalled else 2), lane())
        try:
            # Initialize the parent client independently of the nested fault.
            parent_id = await runtime.run_interactive(lambda client: id(client))
            completed_payloads = []
            async def operation(client):
                result = await DashboardBootstrapService(client).get_dashboard_bootstrap("user-1", provider_owned=True, allow_partial=allow_partial)
                completed_payloads.append(result[0])
                return result
            if stalled:
                started = time.monotonic()
                with pytest.raises(HTTPException) as error:
                    await run_supabase_operation(runtime, operation)
                assert error.value.status_code == 504
                snapshot = runtime.interactive_snapshot()
                assert snapshot.admitted == snapshot.active == 1
                assert snapshot.timed_out == 1
                with pytest.raises(HTTPException) as overloaded:
                    await run_supabase_operation(runtime, lambda _client: None)
                assert overloaded.value.status_code == 503
                while runtime.interactive_snapshot().admitted:
                    assert time.monotonic() - started < 2
                    await asyncio.sleep(0.005)
                assert runtime.interactive_snapshot().transport_timed_out == (0 if allow_partial else 1)
                if allow_partial:
                    assert len(completed_payloads) == 1
                    assert set(completed_payloads[0].dataset_errors.model_dump(exclude_none=True)) == {"studio", "students", "leads", "belts", "programs"}
                    assert completed_payloads[0].students_total is None
            else:
                response, _timings = await run_supabase_operation(runtime, operation)
                assert response.studio.id == "studio-1"
                assert response.students_total == 0
            assert len(created) == len(closed) == 5
            assert len({identity for identity, _thread, _timeout in created}) == 5
            assert all(identity != parent_id and timeout == 0.15 for identity, _thread, timeout in created)
            assert sorted(closed) == sorted((identity, thread) for identity, thread, _timeout in created)
            assert nested_provider.requests == 5
            assert runtime.interactive_snapshot().active == 0
            assert await runtime.run_interactive(lambda _client: "recovered") == "recovered"
        finally:
            await asyncio.to_thread(runtime.shutdown)

    with patch("app.services.dashboard_bootstrap_service.create_supabase_client", side_effect=factory), patch("app.services.dashboard_bootstrap_service.close_supabase_client", side_effect=closer), patch("app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync", return_value=bootstrap_auth()), patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"):
        asyncio.run(scenario())


def test_isolated_live_authorization_stall_fails_closed_before_stripe_can_run(nested_provider):
    assert LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS == 10.0
    nested_provider.stall = True
    settings = SimpleNamespace(STRIPE_MODE="live", STRIPE_SECRET_KEY="sk_live_fixture", LIVE_BILLING_ENABLED=True, CORE_SELF_CHECKOUT_ENABLED=False)
    created = []
    closed = []

    def factory(**options):
        client = create_supabase_client(**options)
        created.append(client.postgrest.session.timeout.read)
        return client

    def closer(client):
        close_supabase_client(client)
        closed.append(True)

    # Exercise the real isolated authorization owner and actual HTTP transport.
    # The store's policy body is replaced only to make its read predictably stall.
    def authorize(store, **_context):
        return store.supabase.table("authorization").select("*").execute()

    started = time.monotonic()
    with patch("app.services.stripe_mutation_policy.LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS", 0.1), patch("app.services.stripe_mutation_policy.create_supabase_client", side_effect=factory), patch("app.services.stripe_mutation_policy.close_supabase_client", side_effect=closer), patch("app.services.stripe_mutation_policy.StudioLiveBillingAuthorizationStore.authorize", authorize), patch("app.services.stripe_service.get_settings", return_value=settings), patch.object(StripeService, "_stripe") as stripe_provider:
        with pytest.raises(httpx.ReadTimeout):
            StripeService().cancel_core_subscription(subscription_id="sub-fixture", studio_id="studio-1")
        stripe_provider.assert_not_called()
    assert time.monotonic() - started < 1
    assert created == [0.1]
    assert closed == [True]
    assert nested_provider.requests == 1
