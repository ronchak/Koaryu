import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import HTTPException, Response

from app.api.v1.endpoints.billing import get_billing_landing as endpoint
from app.schemas.billing import BillingSystemStatusResponse, StudioPaymentAccountResponse, BillingWebhookHealthResponse
from app.services.billing_landing import get_billing_landing, payment_cohort_period
from datetime import datetime, timezone


def status():
    return BillingSystemStatusResponse(
        studio_id='studio', configured_stripe_mode='test', ready_for_configured_mode=True,
        live_payments_authorized=False, ready_for_live_payments=False, checked_at='2026-12-31T00:00:00Z',
        payment_account=StudioPaymentAccountResponse(studio_id='studio'), mutation_capabilities={},
        platform_webhooks=BillingWebhookHealthResponse(), connect_webhooks=BillingWebhookHealthResponse(), checks=[])


@pytest.mark.parametrize('role', ['admin', 'front_desk'])
@pytest.mark.parametrize('required', [True, False])
def test_landing_authorizes_fields_independently(role, required):
    aggregates = dict(active_student_count=1, active_subscription_count=2, failed_payer_count=3,
                      open_invoice_amount_cents=20100, has_billing_plans=True, has_family_accounts=True,
                      has_student_billing=True, has_collection_history=True,
                      payment_cohort=dict(period_start='2026-12-01Z',period_end='2027-01-01Z',payment_count=1001))
    with patch('app.services.billing_landing.BillingService') as billing, patch('app.services.billing_landing.PlatformBillingService') as platform, patch('app.services.billing_landing.get_platform_subscription_access', return_value={'subscription_required': required}), patch('app.services.billing_landing.execute_required_rpc', return_value=SimpleNamespace(data=aggregates)) as rpc:
        billing.return_value.get_system_status = AsyncMock(return_value=status())
        platform.return_value.get_status = AsyncMock(return_value=None)
        result = asyncio.run(get_billing_landing(Mock(), {'studio_id':'studio','role':role}))
        assert result.system_status.payment_account.studio_id == 'studio'
        assert result.financial_access == ('subscription_required' if required else 'available')
        assert (result.aggregates is None) == required
        assert rpc.call_count == (0 if required else 1)
        assert platform.call_count == (1 if role=='admin' else 0)
        billing.return_value.get_system_status.assert_awaited_once_with('studio',role)


def test_unverifiable_subscription_preserves_diagnostics_without_financial_query():
    with patch('app.services.billing_landing.BillingService') as billing, patch('app.services.billing_landing.get_platform_subscription_access', side_effect=HTTPException(503,'unavailable')), patch('app.services.billing_landing.execute_required_rpc') as rpc:
        billing.return_value.get_system_status = AsyncMock(return_value=status())
        result = asyncio.run(get_billing_landing(Mock(), {'studio_id':'studio','role':'front_desk'}))
        assert result.financial_access=='unavailable'
        assert result.aggregates is None
        assert result.system_status is not None
        rpc.assert_not_called()


def test_endpoint_resolves_membership_once_and_does_not_blanket_gate_subscription():
    async def run(provider, operation, **kwargs): return await operation(provider)
    with patch('app.api.v1.endpoints.billing.run_supabase_operation', side_effect=run), patch('app.api.v1.endpoints.billing.resolve_billing_manager_staff_role_for_user', return_value={'studio_id':'studio','role':'front_desk'}) as resolver, patch('app.services.billing_landing.get_billing_landing', new=AsyncMock(return_value='landing')):
        response=Response()
        assert asyncio.run(endpoint(response,'user','studio',Mock()))=='landing'
        assert resolver.call_count==1
        assert 'require_platform_subscription' not in resolver.call_args.kwargs
        assert response.headers['Cache-Control']=='no-store'


def test_utc_period_rollover_and_naive_compatibility():
    assert payment_cohort_period(datetime(2026,12,31)) == (datetime(2026,12,1,tzinfo=timezone.utc),datetime(2027,1,1,tzinfo=timezone.utc))


def test_system_failure_does_not_erase_admin_platform_recovery():
    with patch('app.services.billing_landing.BillingService') as billing, patch('app.services.billing_landing.PlatformBillingService') as platform, patch('app.services.billing_landing.get_platform_subscription_access', return_value={'subscription_required':True}):
        billing.return_value.get_system_status = AsyncMock(side_effect=RuntimeError('failed diagnostic read'))
        billing.return_value.get_payment_account = AsyncMock(return_value=StudioPaymentAccountResponse(studio_id='studio'))
        platform.return_value.get_status = AsyncMock(return_value=None)
        result = asyncio.run(get_billing_landing(Mock(),{'studio_id':'studio','role':'admin'}))
        platform.return_value.get_status.assert_awaited_once_with('studio')
        assert result.system_status is None
        assert result.payment_account.studio_id=='studio'
        assert result.financial_access=='subscription_required'
        assert result.errors==['Billing system diagnostics are unavailable.']
