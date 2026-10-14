"""Bootstrap lanes and isolated live authorization retain bounded owned I/O."""

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
from app.api.v1.endpoints.dashboard import get_dashboard_bootstrap
from fastapi import Response
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.db.supabase import close_supabase_client, create_supabase_client
from app.schemas.auth import AuthResponse, UserProfile
from app.services.dashboard_bootstrap_service import (
    BOOTSTRAP_VIEW_DATASETS,
    DashboardBootstrapService,
)
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
            data = (
                {"id": "studio-1", "name": "Fixture", "slug": "fixture", "timezone": "UTC"}
                if table == "studios"
                else []
            )
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
        staff_profiles_available=True,
        studio_id="studio-1",
        role="admin",
    )


# These views still load three datasets each, using one persistent lane client.
@pytest.mark.parametrize("view", ["students", "leads", "training"])
@pytest.mark.parametrize("stalled", [False, True])
@pytest.mark.parametrize("allow_partial", [False, True])
def test_bootstrap_reuses_owned_transport_and_drains_before_capacity_returns(
    nested_provider, stalled, allow_partial, view
):
    nested_provider.stall = stalled
    created = []
    closed = []

    def factory():
        client = create_supabase_client(postgrest_client_timeout=0.15)
        created.append((id(client), threading.get_ident(), client.postgrest.session.timeout.read))
        return client

    def closer(client):
        close_supabase_client(client)
        closed.append((id(client), threading.get_ident()))

    async def scenario():
        config = SupabaseLaneConfig(
            1, 3, 0.02, 0.04 if stalled else 2, postgrest_client_timeout=0.15
        )
        runtime = SupabaseProviderRuntime(
            config, config, client_factory=factory, client_closer=closer
        )
        try:
            loop = asyncio.get_running_loop()
            warm_clock = loop.time()
            # Cold SDK construction is setup, outside the short fault budget.
            with patch.object(loop, "time", return_value=warm_clock):
                parent_id = await runtime.run_interactive(lambda client: id(client))
            before = len(created)
            response = Response()
            call = get_dashboard_bootstrap(
                response,
                user_id="user-1",
                requested_studio_id="studio-1",
                supabase=runtime,
                view=view,
                allow_partial=allow_partial,
            )
            if stalled and not allow_partial:
                with pytest.raises(HTTPException) as error:
                    await call
                assert error.value.status_code == 504
            else:
                payload = await call
                if stalled:
                    assert (
                        set(payload.dataset_errors.model_dump(exclude_none=True))
                        == BOOTSTRAP_VIEW_DATASETS[view]
                    )
                    assert payload.students_total is None
                else:
                    assert payload.studio.id == "studio-1"
                    assert payload.students_total == (0 if view == "students" else None)
            assert len(created) - before == 0
            assert len(created) == 1
            assert created[0][0] == parent_id and created[0][2] == 0.15
            assert closed == []  # Persistent transports close at runtime shutdown.
            if stalled:
                snapshot = runtime.interactive_snapshot()
                assert snapshot.active == 1 and snapshot.admitted >= 1
                assert snapshot.timed_out >= 1
            started = time.monotonic()
            while runtime.interactive_snapshot().admitted:
                assert time.monotonic() - started < 2
                await asyncio.sleep(0.005)
            snapshot = runtime.interactive_snapshot()
            assert snapshot.active == 0
            assert snapshot.transport_timed_out == (nested_provider.requests if stalled else 0)
            assert nested_provider.requests >= 2 if stalled else nested_provider.requests == 3
            assert await runtime.run_interactive(lambda _client: "recovered") == "recovered"
            assert len(created) == 1
        finally:
            await asyncio.to_thread(runtime.shutdown)
        assert closed == [(identity, thread) for identity, thread, _timeout in created]

    with (
        patch(
            "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
            return_value=bootstrap_auth(),
        ),
        patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"),
    ):
        asyncio.run(scenario())


def test_isolated_live_authorization_stall_fails_closed_before_stripe_can_run(nested_provider):
    assert LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS == 10.0
    nested_provider.stall = True
    settings = SimpleNamespace(
        STRIPE_MODE="live",
        STRIPE_SECRET_KEY="sk_live_fixture",
        LIVE_BILLING_ENABLED=True,
        CORE_SELF_CHECKOUT_ENABLED=False,
    )
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
    with (
        patch(
            "app.services.stripe_mutation_policy.LIVE_AUTHORIZATION_POSTGREST_TIMEOUT_SECONDS", 0.1
        ),
        patch("app.services.stripe_mutation_policy.create_supabase_client", side_effect=factory),
        patch("app.services.stripe_mutation_policy.close_supabase_client", side_effect=closer),
        patch(
            "app.services.stripe_mutation_policy.StudioLiveBillingAuthorizationStore.authorize",
            authorize,
        ),
        patch("app.services.stripe_service.get_settings", return_value=settings),
        patch.object(StripeService, "_stripe") as stripe_provider,
    ):
        with pytest.raises(httpx.ReadTimeout):
            StripeService().cancel_core_subscription(
                subscription_id="sub-fixture", studio_id="studio-1"
            )
        stripe_provider.assert_not_called()
    assert time.monotonic() - started < 1
    assert created == [0.1]
    assert closed == [True]
    assert nested_provider.requests == 1


@pytest.mark.parametrize("view", ["students", "leads", "training"])
@pytest.mark.parametrize("transport", [0.08, 0.23])
def test_each_bootstrap_dataset_uses_configured_lane_transport(nested_provider, view, transport):
    # Leave the runtime's default factory intact: it must pass the lane's
    # timeout into the actual Supabase SDK client, independently of this test.
    original_factory = create_supabase_client
    constructed = []
    observed = {}

    def factory(**options):
        constructed.append(options)
        return original_factory(**options)

    methods = {
        "studio": "_fetch_studio_summary",
        "students": "_fetch_students",
        "programs": "_fetch_programs",
        "leads": "_fetch_leads",
        "belts": "_fetch_belt_ladders",
    }
    originals = {label: getattr(DashboardBootstrapService, name) for label, name in methods.items()}

    def fetch(service, label, studio_id):
        observed[label] = service.supabase.postgrest.session.timeout.read
        return originals[label](service, studio_id)

    async def scenario():
        config = SupabaseLaneConfig(1, 3, 0.1, 2, postgrest_client_timeout=transport)
        runtime = SupabaseProviderRuntime(config, lane())
        try:
            await get_dashboard_bootstrap(
                Response(),
                user_id="user-1",
                supabase=runtime,
                view=view,
            )
            assert observed == {label: transport for label in BOOTSTRAP_VIEW_DATASETS[view]}
            assert constructed == [{"postgrest_client_timeout": transport}]
        finally:
            await asyncio.to_thread(runtime.shutdown)

    from contextlib import ExitStack

    with ExitStack() as stack:
        stack.enter_context(
            patch("app.core.provider_runtime.create_supabase_client", side_effect=factory)
        )
        stack.enter_context(
            patch(
                "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
                return_value=bootstrap_auth(),
            )
        )
        stack.enter_context(
            patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access")
        )
        for label, name in methods.items():
            stack.enter_context(
                patch.object(
                    DashboardBootstrapService,
                    name,
                    new=lambda service, studio_id, label=label: fetch(service, label, studio_id),
                )
            )
        asyncio.run(scenario())
