import base64
import json
import re
from uuid import UUID

import pytest
from fastapi import HTTPException

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


def test_pages_cover_equal_timestamps_without_truncation_or_tenant_leak():
    rows=[dict(id=str(UUID(int=i)),studio_id='studio',status='succeeded',amount_cents=i,
               created_at='2026-12-01T00:00:00+00:00',updated_at='2026-12-01T00:00:00+00:00') for i in range(1,106)]
    client=_PageClient({'billing_payments': rows+[dict(rows[0],id=str(UUID(int=999)),studio_id='other')]})
    seen=[]
    cursor=None
    for page_number in range(3):
        page=get_billing_page(client,'studio','payments',cursor,50)
        seen.extend(p.id for p in page.items)
        assert page.complete == (page_number==2)
        cursor=page.next_cursor
    assert seen == [r['id'] for r in reversed(rows)]
    assert cursor is None
    assert all(q['limit']==51 for q in client.query_log)


@pytest.mark.parametrize('cursor', ['not-base64','e30=',base64.urlsafe_b64encode(json.dumps(dict(studio_id='other',dataset='payments',created_at='2026-12-01T00:00:00+00:00',id=str(UUID(int=1)))).encode()).decode()])
def test_invalid_or_other_scope_cursor_is_rejected(cursor):
    with pytest.raises(HTTPException) as error:
        get_billing_page(_PageClient(),'studio','payments',cursor,50)
    assert error.value.status_code==400
