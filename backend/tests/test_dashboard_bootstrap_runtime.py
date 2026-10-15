"""Bootstrap orchestration uses the ASGI loop and persistent lane-owned clients."""

import asyncio
import threading
import time
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException, Response

from app.api.v1.endpoints.dashboard import get_dashboard_bootstrap
from app.core.deps import run_supabase_operation
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.core.request_deadline import request_deadline
from app.schemas.auth import AuthResponse, UserProfile
from app.services.dashboard_bootstrap_service import BOOTSTRAP_VIEW_DATASETS
from tests.fakes.supabase import TableBackedSupabase
from tests.test_dashboard_bootstrap_service import (
    METHOD_LABELS,
    SyntheticPostgrestClient,
    TrainingProvider,
    patch_fetches,
    training_profile,
)


class BootstrapFixture:
    def __init__(self, *, blocked=(), config=None):
        self.clients = []
        self.events = []
        self.blocked = blocked
        self.started = {label: threading.Event() for label in blocked}
        self.release = threading.Event()
        self.profile = AuthResponse(
            user=UserProfile(id="user-1", email="fixture@example.invalid"),
            staff_profiles_available=True,
            membership_status="active",
            studio_id="studio-1",
            role="admin",
        )
        fixture = self

        class Client(TableBackedSupabase):
            def __init__(self):
                super().__init__({"student_program_memberships": []})
                self.owner = threading.get_ident()
                fixture.clients.append(self)

            def touch(self, label):
                assert threading.get_ident() == self.owner
                fixture.events.append((label, id(self), self.owner, request_deadline.get()))

            def table(self, name):
                self.touch(name)
                return super().table(name)

        self.factory = Client
        config = config or SupabaseLaneConfig(3, 3, 0.1, 2.0)
        self.workers = config.max_workers
        self.runtime = SupabaseProviderRuntime(
            config,
            config,
            client_factory=Client,
            client_closer=lambda client: client.touch("closed"),
            thread_name_prefix="bootstrap-owned-test",
        )

    async def warm(self):
        barrier = threading.Barrier(self.workers)

        def operation(client):
            client.touch("warm")
            barrier.wait(2)

        await asyncio.gather(
            *(self.runtime.run_interactive(operation) for _ in range(self.workers))
        )
        assert len(self.clients) == self.workers

    def auth(self, service, *_args):
        service.supabase.touch("auth")
        return self.profile

    def fetch(self, service, method_name, studio_id):
        assert studio_id == "studio-1"
        label = METHOD_LABELS[method_name]
        service.supabase.touch(label)
        if label in self.blocked:
            self.started[label].set()
            assert self.release.wait(2), "test must release retained provider work"
        if label == "studio":
            return SimpleNamespace(
                data={
                    "id": studio_id,
                    "name": "Fixture",
                    "slug": "fixture",
                    "timezone": "UTC",
                }
            )
        if label == "students":
            return SimpleNamespace(
                data=[
                    {
                        "id": "student-1",
                        "studio_id": studio_id,
                        "legal_first_name": "Fixture",
                        "legal_last_name": "Student",
                        "date_of_birth": "2008-09-20",
                        "status": "active",
                        "tags": [],
                        "created_at": "2026-01-01T00:00:00Z",
                        "updated_at": "2026-01-01T00:00:00Z",
                    }
                ],
                count=1,
            )
        if label == "programs":
            return []
        return SimpleNamespace(data=[])

    def call(self, *, view="home", allow_partial=False):
        return get_dashboard_bootstrap(
            Response(),
            user_id="user-1",
            requested_studio_id="studio-1",
            supabase=self.runtime,
            view=view,
            allow_partial=allow_partial,
        )

    async def drain(self):
        async with asyncio.timeout(2):
            while self.runtime.interactive_snapshot().admitted:
                await asyncio.sleep(0.005)

    async def close(self):
        self.release.set()
        await asyncio.to_thread(self.runtime.shutdown)


@pytest.fixture
def bootstrap_fixture():
    def fixture_context(fixture):
        from contextlib import ExitStack

        stack = ExitStack()
        stack.enter_context(
            patch(
                "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
                new=lambda service, *args: fixture.auth(service, *args),
            )
        )
        stack.enter_context(
            patch(
                "app.services.dashboard_bootstrap_service.ensure_platform_subscription_access",
                side_effect=lambda client, _studio: client.touch("access"),
            )
        )
        stack.enter_context(
            patch(
                "app.services.dashboard_bootstrap_service.studio_today",
                return_value=(date(2026, 9, 20), "UTC"),
            )
        )
        stack.enter_context(patch_fetches(fixture.fetch))
        return stack

    return fixture_context


@pytest.mark.parametrize("view", list(BOOTSTRAP_VIEW_DATASETS))
def test_bootstrap_uses_no_new_clients_after_warmup_and_keeps_mapping_on_worker(
    bootstrap_fixture, view
):
    fixture = BootstrapFixture()

    async def scenario():
        try:
            await fixture.warm()
            token = request_deadline.set(time.monotonic() + 2)
            try:
                before = fixture.runtime.interactive_snapshot().submitted
                loop = asyncio.get_running_loop()
                deadline = request_deadline.get()
                boundary_calls = []

                async def run(provider, operation, **kwargs):
                    assert asyncio.get_running_loop() is loop
                    assert request_deadline.get() == deadline
                    boundary_calls.append(kwargs["lane"])
                    return await run_supabase_operation(provider, operation, **kwargs)

                with (
                    patch("app.api.v1.endpoints.dashboard.run_supabase_operation", side_effect=run),
                    patch(
                        "app.services.dashboard_bootstrap_service.run_supabase_operation",
                        side_effect=run,
                    ),
                ):
                    for _ in range(2):
                        payload = await fixture.call(view=view)
                        assert payload.auth.studio_id == "studio-1"
                        if view == "students":
                            assert payload.students_total == 1
                            assert not payload.students[0].is_minor
                assert len(fixture.clients) == 3  # Zero constructions per warm bootstrap.
                assert fixture.runtime.interactive_snapshot().submitted - before == 2 * (
                    1 + len(BOOTSTRAP_VIEW_DATASETS[view])
                )
                work = [event for event in fixture.events if event[0] != "warm"]
                assert boundary_calls == ["interactive"] * 2 * (
                    1 + len(BOOTSTRAP_VIEW_DATASETS[view])
                )
                assert sum(event[0] == "auth" for event in work) == 2
                if view == "students":
                    assert sum(event[0] == "student_program_memberships" for event in work) == 2
            finally:
                request_deadline.reset(token)
        finally:
            await fixture.close()

    with bootstrap_fixture(fixture):
        asyncio.run(scenario())


def test_fake_client_bootstrap_operations_run_inline(bootstrap_fixture):
    fixture = BootstrapFixture()
    fake = fixture.factory()
    fixture.runtime.shutdown()
    fixture.runtime = fake
    with bootstrap_fixture(fixture):
        result = asyncio.run(fixture.call(view="students"))
    assert result.students_total == 1
    assert len(fixture.clients) == 1
    assert all(event[2] == threading.get_ident() for event in fixture.events)


def test_training_sdk_reads_run_on_the_worker_owning_each_client():
    provider = TrainingProvider()
    owners = []

    def client_factory():
        owner = threading.get_ident()
        owners.append(owner)

        def handler(request):
            assert threading.get_ident() == owner
            return provider(request)

        return SyntheticPostgrestClient(handler)

    async def scenario():
        config = SupabaseLaneConfig(3, 3, 0.1, 2.0)
        runtime = SupabaseProviderRuntime(
            config,
            config,
            client_factory=client_factory,
            client_closer=lambda client: client.session.close(),
            thread_name_prefix="bootstrap-sdk-test",
        )
        try:
            return await get_dashboard_bootstrap(
                Response(),
                user_id="user-1",
                requested_studio_id="studio-1",
                supabase=runtime,
                view="training",
                allow_partial=False,
            )
        finally:
            await asyncio.to_thread(runtime.shutdown)

    with (
        patch(
            "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
            return_value=training_profile(),
        ),
        patch("app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"),
    ):
        payload = asyncio.run(scenario())
    assert payload.primary_belt_ladder.id == "ladder-early"
    assert sorted(table for _, table, *_ in provider.requests) == [
        "belt_ladders",
        "programs",
        "studios",
    ]
    assert threading.get_ident() not in owners
    assert {request[3] for request in provider.requests} <= set(owners)


def test_bootstrap_cancellation_accounts_for_each_retained_dataset(bootstrap_fixture):
    fixture = BootstrapFixture(blocked=("studio", "programs"))

    async def scenario():
        try:
            await fixture.warm()
            request = asyncio.create_task(fixture.call())
            for event in fixture.started.values():
                assert await asyncio.to_thread(event.wait, 1)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            snapshot = fixture.runtime.interactive_snapshot()
            assert snapshot.active == snapshot.admitted == 2
            assert snapshot.cancelled == 2
            assert snapshot.timed_out == 0
            fixture.release.set()
            await fixture.drain()
            assert fixture.runtime.interactive_snapshot().active == 0
        finally:
            await fixture.close()

    with bootstrap_fixture(fixture):
        asyncio.run(scenario())


def test_bootstrap_dataset_wait_uses_original_request_deadline(bootstrap_fixture):
    fixture = BootstrapFixture(blocked=("studio",))

    async def scenario():
        try:
            await fixture.warm()
            token = request_deadline.set(time.monotonic() + 0.1)
            try:
                with pytest.raises(HTTPException) as error:
                    await fixture.call()
                assert error.value.status_code == 504
                snapshot = fixture.runtime.interactive_snapshot()
                assert snapshot.active == snapshot.admitted == 1
                assert snapshot.timed_out == snapshot.cancelled == 1
                fixture.release.set()
                await fixture.drain()
            finally:
                request_deadline.reset(token)
        finally:
            await fixture.close()

    with bootstrap_fixture(fixture):
        asyncio.run(scenario())


def test_bootstrap_burst_saturates_production_lane_and_drains(bootstrap_fixture):
    from app.main import INTERACTIVE_PROVIDER_CONFIG

    assert (INTERACTIVE_PROVIDER_CONFIG.max_workers, INTERACTIVE_PROVIDER_CONFIG.max_queue) == (
        4,
        16,
    )
    fixture = BootstrapFixture(blocked=("studio", "programs"), config=INTERACTIVE_PROVIDER_CONFIG)

    async def scenario():
        requests = []
        try:
            await fixture.warm()
            token = request_deadline.set(time.monotonic() + 0.5)
            try:
                requests.append(asyncio.create_task(fixture.call()))
                for event in fixture.started.values():
                    assert await asyncio.to_thread(event.wait, 1)
                requests.extend(asyncio.create_task(fixture.call()) for _ in range(30))
                results = await asyncio.gather(*requests, return_exceptions=True)
                assert all(isinstance(result, HTTPException) for result in results)
                statuses = {result.status_code for result in results}
                assert statuses == {503, 504}
                assert all(
                    result.detail
                    in {
                        "Provider capacity is temporarily unavailable.",
                        "Provider operation timed out.",
                    }
                    for result in results
                )
                assert all(result.headers == {"Retry-After": "1"} for result in results)
                held = fixture.runtime.interactive_snapshot()
                assert held.active == 4 and held.admitted == 20 and held.waiting == 0
                assert held.saturated > 0 and held.timed_out > 0
                fixture.release.set()
                await fixture.drain()
                drained = fixture.runtime.interactive_snapshot()
                assert drained.active == drained.admitted == drained.waiting == 0
            finally:
                request_deadline.reset(token)
        finally:
            for request in requests:
                request.cancel()
            await asyncio.gather(*requests, return_exceptions=True)
            await fixture.close()

    with bootstrap_fixture(fixture):
        asyncio.run(scenario())


def test_bootstrap_cancelled_before_dataset_admission_never_runs_it(bootstrap_fixture):
    from app.main import INTERACTIVE_PROVIDER_CONFIG

    fixture = BootstrapFixture(config=INTERACTIVE_PROVIDER_CONFIG)

    async def context_boundary(provider, operation, **kwargs):
        result = await run_supabase_operation(provider, operation, **kwargs)
        # Let the older admission waiter fill the context's released slot
        # before the endpoint can submit either dataset.
        async with asyncio.timeout(1):
            while fixture.runtime.interactive_snapshot().admitted != 20:
                await asyncio.sleep(0.001)
        return result

    async def scenario():
        context_entered = threading.Event()
        context_release = threading.Event()
        blockers_release = threading.Event()
        blockers = []
        request = None
        original_auth = fixture.auth

        def auth(service, *args):
            context_entered.set()
            assert context_release.wait(2)
            return original_auth(service, *args)

        try:
            await fixture.warm()
            fixture.auth = auth
            request = asyncio.create_task(fixture.call())
            assert await asyncio.to_thread(context_entered.wait, 1)

            # The context owns one admission; fill all 19 remaining admissions
            # with unrelated work, then use the context's released slot too.
            def block(_client):
                assert blockers_release.wait(2)

            blockers = [
                asyncio.create_task(fixture.runtime.run_interactive(block)) for _ in range(20)
            ]
            async with asyncio.timeout(1):
                while fixture.runtime.interactive_snapshot().waiting != 1:
                    await asyncio.sleep(0.001)
            context_release.set()
            async with asyncio.timeout(1):
                while fixture.runtime.interactive_snapshot().waiting != 2:
                    await asyncio.sleep(0.001)
            assert not any(event[0] in {"studio", "programs"} for event in fixture.events)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert fixture.runtime.interactive_snapshot().waiting == 0
            blockers_release.set()
            await asyncio.gather(*blockers)
            await fixture.drain()
            assert not any(event[0] in {"studio", "programs"} for event in fixture.events)
            drained = fixture.runtime.interactive_snapshot()
            assert drained.admitted == drained.active == drained.waiting == 0
        finally:
            context_release.set()
            blockers_release.set()
            if request is not None:
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)
            await asyncio.gather(*blockers, return_exceptions=True)
            await fixture.close()

    with (
        bootstrap_fixture(fixture),
        patch(
            "app.api.v1.endpoints.dashboard.run_supabase_operation", side_effect=context_boundary
        ),
    ):
        asyncio.run(scenario())
