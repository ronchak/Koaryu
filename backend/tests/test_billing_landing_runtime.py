"""Exercise landing deadlines with the real bounded, thread-affine runtime."""
import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Response

from app.api.v1.endpoints import billing as billing_endpoint
from app.core.provider_runtime import SupabaseLaneConfig, SupabaseProviderRuntime
from app.schemas.billing import PlatformBillingStatusResponse
from app.services import billing_landing
from tests.test_billing_landing import status


AGGREGATES = dict(
    active_student_count=1, active_subscription_count=2, failed_payer_count=3,
    open_invoice_amount_cents=20100, has_billing_plans=True, has_family_accounts=True,
    has_student_billing=True, has_collection_history=True,
    payment_cohort=dict(period_start='2026-12-01Z',period_end='2027-01-01Z',payment_count=1001),
)


class LandingRuntimeFixture:
    def __init__(self, monkeypatch, *, role='admin', required=False, membership_delay=0, budget=0.15, operation_timeout=20):
        self.started = threading.Event()
        self.release = threading.Event()
        self.events = []
        self.lock = threading.Lock()
        self.role = role
        self.rpc_calls = 0
        fixture = self
        monkeypatch.setattr(billing_landing, 'BILLING_LANDING_REQUEST_TIMEOUT_SECONDS', budget)

        class Resource:
            def __init__(self):
                self.owner = threading.get_ident()
                self.touch('created')

            def touch(self, operation):
                assert threading.get_ident() == self.owner, 'a client crossed its owning thread'
                with fixture.lock:
                    fixture.events.append((operation, id(self), self.owner))

        config = SupabaseLaneConfig(max_workers=3, max_queue=0, queue_wait_timeout=0.02, operation_wait_timeout=operation_timeout)
        self.runtime = SupabaseProviderRuntime(
            config, config, client_factory=Resource, client_closer=lambda client: client.touch('closed'),
            thread_name_prefix='landing-runtime-proof',
        )

        def membership(client, user, requested):
            client.touch('membership')
            assert (user, requested) == ('user', 'studio')
            if membership_delay:
                time.sleep(membership_delay)
            return {'studio_id': 'studio', 'role': role}

        def access(client, studio):
            client.touch('financial')
            assert studio == 'studio'
            assert fixture.started.wait(2), 'diagnostics must have its own worker'
            return {'subscription_required': required}

        def aggregates(client, name, params):
            client.touch('aggregates')
            assert name == 'billing_landing_aggregates'
            assert params['p_studio_id'] == 'studio'
            fixture.rpc_calls += 1
            return SimpleNamespace(data=AGGREGATES)

        class Billing:
            def __init__(self, client):
                self.client = client

            async def get_system_status(self, studio, actor_role):
                self.client.touch('diagnostics')
                assert (studio, actor_role) == ('studio', role)
                fixture.started.set()
                assert fixture.release.wait(10), 'test must release the retained provider work'
                self.client.touch('diagnostics-complete')
                return status()

            async def get_payment_account(self, studio):
                raise AssertionError('a timed-out caller must not start a duplicate Connect read')

        class Platform:
            def __init__(self, client):
                self.client = client

            async def get_status(self, studio):
                self.client.touch('platform')
                assert role == 'admin' and studio == 'studio'
                assert fixture.started.wait(2)
                return PlatformBillingStatusResponse(
                    studio_id=studio, status='active', comped=False,
                    email_usage={'period_start':'2026-12-01Z','period_end':'2027-01-01Z'},
                )

        monkeypatch.setattr(billing_endpoint, 'resolve_billing_manager_staff_role_for_user', membership)
        monkeypatch.setattr(billing_landing, 'BillingService', Billing)
        monkeypatch.setattr(billing_landing, 'PlatformBillingService', Platform)
        monkeypatch.setattr(billing_landing, 'get_platform_subscription_access', access)
        monkeypatch.setattr(billing_landing, 'execute_required_rpc', aggregates)

    async def call(self):
        response = Response()
        result = await billing_endpoint.get_billing_landing(response, 'user', 'studio', self.runtime)
        assert response.headers['Cache-Control'] == 'no-store'
        return result

    async def close(self):
        self.release.set()
        async with asyncio.timeout(2):
            while self.runtime.interactive_snapshot().admitted:
                await asyncio.sleep(0.001)
        await asyncio.to_thread(self.runtime.shutdown)
        created = {(client, thread) for operation, client, thread in self.events if operation == 'created'}
        closed = {(client, thread) for operation, client, thread in self.events if operation == 'closed'}
        assert created == closed, 'every client closes on its creating worker'


@pytest.mark.parametrize('role', ['admin', 'front_desk'])
@pytest.mark.parametrize('required', [False, True])
def test_stalled_diagnostics_preserve_healthy_fields_affinity_and_capacity(monkeypatch, role, required):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, role=role, required=required)
        ticks = 0
        stop = asyncio.Event()

        async def heartbeat():
            nonlocal ticks
            while not stop.is_set():
                ticks += 1
                await asyncio.sleep(0.002)

        heartbeat_task = asyncio.create_task(heartbeat())
        try:
            result = await fixture.call()
            assert result.financial_access == ('subscription_required' if required else 'available')
            assert (result.aggregates is None) == required
            assert fixture.rpc_calls == (0 if required else 1)
            assert (result.platform_status is not None) == (role == 'admin')
            assert result.system_status is None
            assert 'Billing system diagnostics are unavailable.' in result.errors
            assert not fixture.release.is_set(), 'response must not depend on the stalled provider returning'
            snapshot = fixture.runtime.interactive_snapshot()
            assert (snapshot.admitted, snapshot.active) == (1, 1), 'timed-out work still owns its capacity'
            assert snapshot.submitted == (4 if role == 'admin' else 3), 'one membership read and role-allowed projections only'
            assert snapshot.cancelled >= 1
            assert snapshot.timed_out == 1, 'only the stalled projection exhausts its owned deadline'
            assert ticks >= 5, 'blocking provider work must not block the ASGI loop'
            owners = {operation: client for operation, client, _ in fixture.events if operation in {'financial','platform','diagnostics'}}
            assert owners['diagnostics'] != owners['financial']
            if role == 'admin':
                assert len(set(owners.values())) == 3
            else:
                assert 'platform' not in owners
            assert await fixture.runtime.run_interactive(lambda client: client.touch('unrelated-request') or 'healthy') == 'healthy'
        finally:
            stop.set()
            await heartbeat_task
            await fixture.close()
        assert fixture.runtime.interactive_snapshot().admitted == 0

    asyncio.run(scenario())


def test_membership_and_projections_share_one_total_budget(monkeypatch):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, membership_delay=0.18, budget=0.3)
        started = time.monotonic()
        try:
            result = await fixture.call()
            elapsed = time.monotonic() - started
            assert result.financial_access == 'available'
            assert result.platform_status is not None
            assert result.system_status is None
            assert elapsed < 0.4, 'membership cannot be followed by a fresh full projection budget'
        finally:
            await fixture.close()
    asyncio.run(scenario())


def test_six_second_diagnostics_within_total_budget_are_preserved(monkeypatch):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, budget=8)
        async def finish_provider():
            await asyncio.sleep(6)
            fixture.release.set()
        finisher = asyncio.create_task(finish_provider())
        try:
            result = await fixture.call()
            assert result.system_status is not None, 'no new short cutoff for previously supported slow reads'
            assert result.payment_account.studio_id == 'studio'
            assert result.financial_access == 'available'
            assert result.platform_status is not None
            assert result.errors == []
        finally:
            fixture.release.set()
            await finisher
            await fixture.close()
    asyncio.run(scenario())


def test_request_cancellation_retains_provider_ownership_until_completion(monkeypatch):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, budget=1)
        request = asyncio.create_task(fixture.call())
        try:
            async with asyncio.timeout(1):
                while not fixture.started.is_set():
                    await asyncio.sleep(0.001)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            assert fixture.runtime.interactive_snapshot().admitted >= 1
            assert fixture.runtime.interactive_snapshot().timed_out == 0, 'caller cancellation is not a deadline'
            assert not fixture.release.is_set()
        finally:
            await fixture.close()
    asyncio.run(scenario())


def test_membership_denial_and_unrelated_timeout_start_no_projections(monkeypatch):
    for failure in (HTTPException(403, 'not a billing manager'), TimeoutError('unrelated application failure')):
        def reject(*_args):
            raise failure
        monkeypatch.setattr(billing_endpoint, 'resolve_billing_manager_staff_role_for_user', reject)
        compose = AsyncMock()
        monkeypatch.setattr(billing_landing, 'get_billing_landing', compose)
        with pytest.raises(type(failure)) as raised:
            asyncio.run(billing_endpoint.get_billing_landing(Response(), 'user', 'studio', object()))
        assert raised.value is failure
        compose.assert_not_called()


def test_membership_deadline_rejects_without_starting_unauthorized_projections(monkeypatch):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, membership_delay=0.15, budget=0.05)
        try:
            with pytest.raises(HTTPException) as raised:
                await fixture.call()
            assert raised.value.status_code == 504
            assert fixture.runtime.interactive_snapshot().submitted == 1
            assert fixture.runtime.interactive_snapshot().admitted == 1
            assert fixture.runtime.interactive_snapshot().timed_out == 1
            assert not fixture.started.is_set()
            assert fixture.rpc_calls == 0
        finally:
            await fixture.close()
    asyncio.run(scenario())


@pytest.mark.parametrize('role, projection_count', [('admin', 3), ('front_desk', 2)])
def test_preexpired_projection_deadlines_count_without_submitting_work(monkeypatch, role, projection_count):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, role=role)
        try:
            result = await billing_landing.get_billing_landing(
                fixture.runtime, {'studio_id':'studio','role':role},
                deadline=asyncio.get_running_loop().time()-1,
            )
            assert result.financial_access == 'unavailable'
            assert result.aggregates is None and result.system_status is None
            assert result.platform_status is None and result.errors
            snapshot = fixture.runtime.interactive_snapshot()
            assert snapshot.timed_out == projection_count
            assert (snapshot.submitted, snapshot.admitted, snapshot.cancelled) == (0, 0, 0)
        finally:
            await fixture.close()
    asyncio.run(scenario())


@pytest.mark.parametrize('deadline_owner', ['request_boundary', 'provider_lane'])
def test_inner_deadline_is_counted_once_and_still_retains_capacity(monkeypatch, deadline_owner):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch, budget=1, operation_timeout=0.15)
        if deadline_owner == 'provider_lane':
            # Let the real lane's shorter timer fire before the request boundary.
            monkeypatch.setattr(fixture.runtime, 'operation_wait_timeout', lambda _lane: 0.75)
        try:
            result = await fixture.call()
            assert result.financial_access == 'available'
            assert result.platform_status is not None and result.system_status is None
            snapshot = fixture.runtime.interactive_snapshot()
            assert snapshot.timed_out == 1, 'landing must not recount an inner provider expiry'
            assert (snapshot.admitted, snapshot.active) == (1, 1)
            assert snapshot.cancelled == (0 if deadline_owner == 'provider_lane' else 1)
        finally:
            await fixture.close()
        assert fixture.runtime.interactive_snapshot().timed_out == 1
    asyncio.run(scenario())


@pytest.mark.parametrize('failure_scope', ['membership', 'projection'])
def test_unrelated_timeout_error_is_not_a_runtime_deadline(monkeypatch, failure_scope):
    async def scenario():
        fixture = LandingRuntimeFixture(monkeypatch)
        failure = TimeoutError('application failure unrelated to a deadline')
        def fail(client, *_args):
            client.touch('unrelated-timeout')
            raise failure
        fixture.release.set()
        try:
            if failure_scope == 'membership':
                monkeypatch.setattr(billing_endpoint, 'resolve_billing_manager_staff_role_for_user', fail)
                with pytest.raises(TimeoutError) as raised:
                    await fixture.call()
                # asyncio.wrap_future reconstructs concurrent TimeoutError values.
                assert type(raised.value) is TimeoutError
                assert raised.value.args == failure.args
            else:
                monkeypatch.setattr(billing_landing, 'get_platform_subscription_access', fail)
                result = await fixture.call()
                assert result.financial_access == 'unavailable'
                assert result.system_status is not None and result.platform_status is not None
            assert fixture.runtime.interactive_snapshot().timed_out == 0
        finally:
            await fixture.close()
    asyncio.run(scenario())
