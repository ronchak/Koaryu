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
from tests.test_dashboard_bootstrap_service import METHOD_LABELS, patch_fetches


class BootstrapFixture:
    def __init__(self, *, blocked=()):
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
        config = SupabaseLaneConfig(3, 3, 0.1, 2.0)
        self.runtime = SupabaseProviderRuntime(
            config,
            config,
            client_factory=Client,
            client_closer=lambda client: client.touch("closed"),
            thread_name_prefix="bootstrap-owned-test",
        )

    async def warm(self):
        barrier = threading.Barrier(3)

        def operation(client):
            client.touch("warm")
            barrier.wait(2)

        await asyncio.gather(*(self.runtime.run_interactive(operation) for _ in range(3)))
        assert len(self.clients) == 3

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
