import asyncio
import json
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.dashboard_summary import DashboardSummaryLeadFollowUps
from app.services.dashboard_summary_cache import DashboardSummaryFactCache
from app.services.dashboard_summary_service import (
    DashboardSummaryRequestContext,
    DashboardSummaryService,
)
from app.services.lead_reads import fetch_lead_rows
from tests.fakes.supabase import FakeTableQuery, RpcBackedSupabase
from tests.test_dashboard_summary_fact_adapter import auth, facts_for, key


class MeasuredLeadQuery(FakeTableQuery):
    def gt(self, field, value):
        self.filters.append(("gt", field, value))
        return self

    def _matches(self, row, op, field, value):
        if op == "gt":
            return self._compare(row.get(field), value, lambda left, right: left > right)
        return super()._matches(row, op, field, value)

    def execute(self):
        result = super().execute()
        # Model PostgREST's wire projection instead of returning every fixture field.
        if self.columns != "*":
            columns = [column.strip() for column in self.columns.split(",")]
            result.data = [{column: row[column] for column in columns} for row in result.data]
        self.supabase.response_bytes += len(
            json.dumps({"data": result.data, "count": result.count}, separators=(",", ":")).encode()
        )
        self.supabase.exact_counts += self.count_mode == "exact"
        return result


class LeadFixture(RpcBackedSupabase):
    def __init__(self, rows):
        super().__init__({"leads": rows})
        self.response_bytes = 0
        self.exact_counts = 0
        self.required_eq_filters["leads"] = {"studio_id"}
        self._rpc_dashboard_summary_facts = lambda _params: facts_for(key())

    def table(self, name):
        assert name == "leads"
        return MeasuredLeadQuery(self, name)


def lead(index, **overrides):
    return {
        "id": f"{index:08}",
        "studio_id": "studio-1",
        "first_name": "Synthetic",
        "last_name": f"Lead {index:08}",
        "stage": "inquiry",
        "follow_up_date": "2026-05-20",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "email": "fixture@example.invalid",
        "phone": "555-0100",
        "source": "walk_in",
        "is_minor": False,
        "notes": "Synthetic history " * 20,
        **overrides,
    }


@pytest.mark.parametrize("count", [501, 1000, 10000])
def test_bounded_projection_matches_full_reader_across_pages_and_ties(count):
    # Due rows include IDs beyond the first page. Equal dates exercise ID ties.
    rows = [lead(index, stage="closed_lost") for index in range(count - 8)]
    rows += [lead(index) for index in range(count - 8, count)]
    full_client, bounded_client = LeadFixture(rows), LeadFixture(rows)
    full = fetch_lead_rows(full_client, "studio-1")
    expected = [
        row
        for row in full
        if row["stage"] not in {"enrolled", "closed_lost"}
        and row["follow_up_date"]
        and row["follow_up_date"] <= "2026-05-20"
    ][:5]
    result = DashboardSummaryService(bounded_client).fetch_lead_follow_ups_sync(key())
    assert result.available
    assert [row.id for row in result.rows] == [row["id"] for row in expected]
    assert len(full_client.query_log) == (count + 499) // 500
    assert full_client.exact_counts == 1  # Included in the first data query, not a separate call.
    assert len(bounded_client.query_log) == 1
    assert bounded_client.exact_counts == 0
    assert bounded_client.query_log[0]["limit"] == 5
    assert bounded_client.query_log[0]["orders"] == (("created_at", True), ("id", True))
    assert bounded_client.response_bytes < 800
    assert full_client.response_bytes > count * 500
    assert all(
        set(row.model_dump()) == {"id", "first_name", "last_name", "follow_up_date"}
        for row in result.rows
    )


def test_eligibility_tenant_business_date_and_created_order_are_preserved():
    rows = [
        lead(1, stage="enrolled"),
        lead(2, stage="closed_lost"),
        lead(3, follow_up_date=None),
        lead(4, follow_up_date="2026-05-21"),
        lead(5, studio_id="other-studio"),
        lead(6, follow_up_date="2026-05-19", created_at="2026-05-19T00:00:00Z"),
        lead(7, follow_up_date="2026-05-20", created_at="2026-05-18T00:00:00Z"),
    ]
    client = LeadFixture(rows)
    result = DashboardSummaryService(client).fetch_lead_follow_ups_sync(key())
    assert [row.id for row in result.rows] == ["00000006", "00000007"]
    assert ("lte", "follow_up_date", "2026-05-20") in client.query_log[0]["filters"]


@pytest.mark.parametrize(
    "role,expected_reads", [("admin", 1), ("front_desk", 1), ("instructor", 0)]
)
def test_role_visibility_and_summary_counts_do_not_depend_on_row_sample(role, expected_reads):
    requested_key = key(visibility="billing_hidden" if role == "instructor" else "billing_visible")
    client = LeadFixture([lead(index) for index in range(20)])
    client._rpc_dashboard_summary_facts = lambda _params: {
        **facts_for(requested_key),
        "leads": {"active_leads": 20, "enrolled_leads": 0, "due_today_leads": 20},
    }
    response, timings = asyncio.run(
        DashboardSummaryService.get_dashboard_summary_from_fact_context(
            client,
            DashboardSummaryRequestContext(auth=auth("user-1", role), key=requested_key),
            cache=DashboardSummaryFactCache(),
            include_follow_ups=True,
        )
    )
    assert len(client.query_log) == expected_reads
    assert response.leads.due_today_leads == 20
    assert response.lead_follow_ups.available is bool(expected_reads)
    assert len(response.lead_follow_ups.rows) == (5 if expected_reads else 0)
    assert ("lead_follow_ups" in timings) is bool(expected_reads)


def test_empty_failure_and_retry_are_distinct_even_when_facts_are_cached():
    client = LeadFixture([])
    context = DashboardSummaryRequestContext(auth=auth("user-1"), key=key())
    cache = DashboardSummaryFactCache()

    async def request():
        return await DashboardSummaryService.get_dashboard_summary_from_fact_context(
            client, context, cache=cache, include_follow_ups=True
        )

    async def exercise():
        empty, _ = await request()
        client.table_failures["leads"] = TimeoutError("private provider details")
        failed, _ = await request()
        del client.table_failures["leads"]
        client.tables["leads"] = [lead(1)]
        retried, _ = await request()
        return empty, failed, retried

    empty, failed, retried = asyncio.run(exercise())
    assert empty.lead_follow_ups == DashboardSummaryLeadFollowUps(available=True)
    assert failed.lead_follow_ups == DashboardSummaryLeadFollowUps(available=False)
    assert "private" not in failed.model_dump_json()
    assert retried.lead_follow_ups.available and len(retried.lead_follow_ups.rows) == 1
    assert empty.leads == failed.leads == retried.leads
    assert len(client.rpc_calls) == 1


@pytest.mark.parametrize("status_code", [401, 402, 403])
def test_follow_up_access_failure_does_not_become_partial_success(status_code):
    client = LeadFixture([])
    client.table_failures["leads"] = HTTPException(status_code)
    with pytest.raises(HTTPException) as error:
        asyncio.run(
            DashboardSummaryService.get_dashboard_summary_from_fact_context(
                client,
                DashboardSummaryRequestContext(auth=auth("user-1"), key=key()),
                cache=DashboardSummaryFactCache(),
                include_follow_ups=True,
            )
        )
    assert error.value.status_code == status_code


def test_follow_ups_do_not_enter_shared_fact_cache_or_legacy_response():
    client = LeadFixture([lead(1)])
    facts = {**facts_for(key()), "lead_follow_ups": {"available": True, "rows": []}}
    assert "lead_follow_ups" not in DashboardSummaryService._validate_dashboard_facts(facts, key())
    response, _ = asyncio.run(
        DashboardSummaryService.get_dashboard_summary_from_fact_context(
            client,
            DashboardSummaryRequestContext(auth=auth("user-1"), key=key()),
            cache=DashboardSummaryFactCache(),
        )
    )
    assert client.query_log == []
    assert "lead_follow_ups" not in response.model_dump()


def test_fact_and_follow_up_reads_are_scheduled_concurrently():
    client = LeadFixture([lead(1)])
    context = DashboardSummaryRequestContext(auth=auth("user-1"), key=key())
    started = []

    async def exercise():
        both_started = asyncio.Event()

        async def operation(_provider, run, *, lane):
            assert lane == "interactive"
            started.append(run)
            if len(started) == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=1)
            return run(client)

        with patch("app.services.dashboard_summary_service.run_supabase_operation", operation):
            return await DashboardSummaryService.get_dashboard_summary_from_fact_context(
                client, context, cache=DashboardSummaryFactCache(), include_follow_ups=True
            )

    response, _ = asyncio.run(exercise())
    assert len(started) == 2 and response.lead_follow_ups.available


def test_schema_enforces_five_row_budget():
    with pytest.raises(ValidationError):
        DashboardSummaryLeadFollowUps(available=True, rows=[lead(index) for index in range(6)])
