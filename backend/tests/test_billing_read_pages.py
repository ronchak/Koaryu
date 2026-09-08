import base64
import json
import re
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.endpoints import billing as endpoints
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.billing_read_pages import get_billing_page
from tests.fakes.supabase import FakeTableQuery, TableBackedSupabase


class _PageQuery(FakeTableQuery):
    def _matches_any_or_filter(self, row, value):
        match = re.fullmatch(r'created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.([0-9a-f-]+)\)', value)
        assert match and match[1] == match[2], 'Malformed PostgREST keyset predicate'
        return (row['created_at'], row['id']) < (match[1], match[3])


class _PageClient(TableBackedSupabase):
    def table(self, name):
        return _PageQuery(self,name)


@pytest.mark.parametrize('dataset', ['invoices', 'payments'])
def test_pages_cover_large_timestamp_ties_without_truncation_or_tenant_leak(dataset):
    rows=[dict(id=str(UUID(int=i)),studio_id='studio',status='paid' if dataset=='invoices' else 'succeeded',amount_cents=i,
               created_at='2026-12-01T00:00:00+00:00',updated_at='2026-12-01T00:00:00+00:00') for i in range(1,1006)]
    rows[0]['created_at']='2026-11-30T00:00:00+00:00'
    rows[-1]['created_at']='2026-12-02T00:00:00+00:00'
    client=_PageClient({f'billing_{dataset}': rows+[dict(rows[0],id=str(UUID(int=9999)),studio_id='other')]})
    seen=[]
    cursor=None
    for page_number in range(21):
        page=get_billing_page(client,'studio',dataset,cursor,50)
        seen.extend(p.id for p in page.items)
        assert page.complete == (page_number==20)
        cursor=page.next_cursor
    assert seen == [r['id'] for r in reversed(rows)]
    assert cursor is None
    assert len(client.query_log)==21, 'each page uses exactly one query'
    assert all(q['limit']==51 for q in client.query_log)
    assert client.query_log[0]['filters']==(('eq','studio_id','studio'),)
    assert client.query_log[0]['or_filters']==()
    for query in client.query_log[1:]:
        assert query['filters'][0]==('eq','studio_id','studio')
        operation, column, stamp=query['filters'][1]
        assert (operation,column)==('lte','created_at')
        assert query['or_filters'][0].startswith(f'created_at.lt.{stamp},and(created_at.eq.{stamp},id.lt.')


@pytest.mark.parametrize('cursor', ['not-base64','e30=',base64.urlsafe_b64encode(json.dumps(dict(studio_id='other',dataset='payments',created_at='2026-12-01T00:00:00+00:00',id=str(UUID(int=1)))).encode()).decode()])
def test_invalid_or_other_scope_cursor_is_rejected(cursor):
    with pytest.raises(HTTPException) as error:
        get_billing_page(_PageClient(),'studio','payments',cursor,50)
    assert error.value.status_code==400


@pytest.mark.parametrize('role,entitled,expected', [('admin', True, 200), ('front_desk', True, 200), ('instructor', True, 403), ('admin', False, 402)])
def test_exact_payment_read_obeys_existing_billing_access_and_tenant_boundaries(role, entitled, expected):
    own = dict(id='payment-1', studio_id='studio', status='succeeded', amount_cents=5000,
               stripe_charge_id='charge-1', refunded_amount_cents=1250,
               created_at='2026-09-01T00:00:00+00:00', updated_at='2026-09-08T00:00:00+00:00')
    provider = _PageClient({'staff_roles': [dict(user_id='reader', studio_id='studio', role=role, archived_at=None)],
                            'billing_payments': [own, dict(own, id='foreign', studio_id='other')]})
    app = FastAPI()
    app.include_router(endpoints.router)
    app.dependency_overrides[get_current_user_id] = lambda: 'reader'
    app.dependency_overrides[get_requested_studio_id] = lambda: 'studio'
    app.dependency_overrides[get_supabase] = lambda: provider
    client = TestClient(app)
    with patch('app.services.studio_scope.get_platform_subscription_access', return_value={'subscription_required': not entitled, 'status': 'active' if entitled else 'canceled', 'comped': False}):
        response = client.get('/billing/payments/payment-1')
        assert response.status_code == expected, response.text
        payment_queries = [query for query in provider.query_log if query['table'] == 'billing_payments']
        if expected != 200:
            assert payment_queries == [], 'access denial must precede reading financial data'
            return
        assert response.json()['refundable_amount_cents'] == 3750
        assert len(payment_queries) == 1 and payment_queries[0]['limit'] == 1
        assert client.get('/billing/payments/foreign').status_code == 404
        assert client.get('/billing/payments/missing').json() == {'detail': 'Payment not found.'}
        page = client.get('/billing/payments/page')
        assert page.status_code == 200 and [row['id'] for row in page.json()['items']] == ['payment-1']
        with patch.object(endpoints.BillingService, 'current_month_payment_cohort_summary', new=AsyncMock(return_value={'period_start':'2026-09-01T00:00:00Z','period_end':'2026-10-01T00:00:00Z','payment_count':1})):
            cohort = client.get('/billing/payments/current-month-cohort')
            assert cohort.status_code == 200 and cohort.json()['payment_count'] == 1
        app.dependency_overrides[get_requested_studio_id] = lambda: 'other'
        assert client.get('/billing/payments/foreign').status_code == 403
