import asyncio
import base64
import json
import re
from unittest.mock import patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.v1.endpoints import billing as endpoints
from app.core.deps import get_current_user_id, get_requested_studio_id, get_supabase
from app.services.billing_service import BillingService
from tests.fakes.supabase import FakeTableQuery, RpcBackedSupabase

# Hosted PostgREST silently caps any single response at this many rows.
HOSTED_MAX_ROWS = 1000


class _PageQuery(FakeTableQuery):
    def _matches_any_or_filter(self, row, value):
        match = re.fullmatch(
            r"created_at\.lt\.(.+),and\(created_at\.eq\.(.+),id\.lt\.([0-9a-f-]+)\)", value
        )
        assert match and match[1] == match[2], "Malformed PostgREST keyset predicate"
        return (row["created_at"], row["id"]) < (match[1], match[3])

    def execute(self):
        result = super().execute()
        if isinstance(result.data, list) and len(result.data) > HOSTED_MAX_ROWS:
            result.data = result.data[:HOSTED_MAX_ROWS]
        return result


class _EnrollmentClient(RpcBackedSupabase):
    def __init__(self, tables=None, scheduled=()):
        super().__init__(tables)
        self.scheduled = set(scheduled)
        self.transition_batches = []

    def table(self, name):
        return _PageQuery(self, name)

    def _rpc_list_billing_enrollment_scheduled_transitions_v1(self, params):
        ids = list(params["p_enrollment_ids"])
        self.transition_batches.append(ids)
        return [
            dict(enrollment_id=enrollment_id, intent_id=f"intent-{enrollment_id}", revision=2)
            for enrollment_id in ids
            if enrollment_id in self.scheduled
        ]


def _enrollment(index, studio="studio", created_at="2026-12-01T00:00:00+00:00"):
    return dict(
        id=str(UUID(int=index)),
        studio_id=studio,
        student_id=f"student-{index}",
        payer_id=f"payer-{index % 7}",
        billing_plan_id="plan-1",
        collection_mode="external",
        status="active",
        billing_status="current",
        start_date="2026-09-01",
        created_at=created_at,
        updated_at=created_at,
    )


def _subscription(index, studio="studio"):
    return dict(
        id=str(UUID(int=index)),
        studio_id=studio,
        payer_id=f"payer-{index}",
        status="active",
        created_at="2026-12-01T00:00:00+00:00",
        updated_at="2026-12-01T00:00:00+00:00",
    )


def _studio_enrollments(count):
    rows = [_enrollment(i) for i in range(1, count + 1)]
    rows[0]["created_at"] = "2026-11-30T00:00:00+00:00"
    rows[-1]["created_at"] = "2026-12-02T00:00:00+00:00"
    return rows


def _traverse(client, limit):
    seen, pages, cursor = [], [], None
    while True:
        page = asyncio.run(BillingService(client).list_enrollments_page("studio", cursor, limit))
        pages.append(page)
        seen.extend(page.items)
        cursor = page.next_cursor
        if page.complete:
            assert cursor is None
            return seen, pages
        assert cursor and len(pages) < 50, "traversal must terminate"


@pytest.mark.parametrize("count", [301, 1005])
def test_enrollment_pages_reach_every_row_beyond_the_legacy_and_hosted_caps(count):
    rows = _studio_enrollments(count)
    scheduled = {rows[5]["id"], rows[count - 50]["id"]}
    client = _EnrollmentClient(
        {"student_billing_enrollments": rows + [_enrollment(99999, studio="other")]},
        scheduled=scheduled,
    )
    seen, pages = _traverse(client, 100)
    expected_ids = [row["id"] for row in reversed(rows)]
    assert [item.id for item in seen] == expected_ids, "complete, ordered, no tenant leak"
    assert [page.complete for page in pages] == [False] * (len(pages) - 1) + [True]
    assert all(len(page.items) <= 100 for page in pages)
    # Each page enriches exactly its own rows with scheduled period-end transitions.
    assert client.transition_batches == [[item.id for item in page.items] for page in pages]
    enriched = {
        item.id: item.scheduled_period_end_transition
        for item in seen
        if item.scheduled_period_end_transition
    }
    assert set(enriched) == scheduled
    assert all(transition.revision == 2 for transition in enriched.values())
    enrollment_queries = [
        query for query in client.query_log if query["table"] == "student_billing_enrollments"
    ]
    assert all(query["limit"] == 101 for query in enrollment_queries)
    assert all(query["filters"][0] == ("eq", "studio_id", "studio") for query in enrollment_queries)


def test_legacy_lists_keep_their_capped_contract_for_old_clients_only():
    client = _EnrollmentClient(
        {
            "student_billing_enrollments": _studio_enrollments(350),
            "billing_subscriptions": [_subscription(i) for i in range(1, 251)],
        }
    )
    service = BillingService(client)
    assert len(asyncio.run(service.list_enrollments("studio"))) == 300
    assert len(asyncio.run(service.list_subscriptions("studio"))) == 200
    app = FastAPI()
    app.include_router(endpoints.router)
    paths = app.openapi()["paths"]
    assert paths["/billing/enrollments"]["get"].get("deprecated") is True
    assert paths["/billing/subscriptions"]["get"].get("deprecated") is True
    assert "deprecated" not in paths["/billing/enrollments/page"]["get"]


def _cursor(**fields):
    return base64.urlsafe_b64encode(json.dumps(fields).encode()).decode()


@pytest.mark.parametrize(
    "cursor",
    [
        "not-base64",
        "e30=",
        _cursor(
            studio_id="other",
            dataset="enrollments",
            created_at="2026-12-01T00:00:00+00:00",
            id=str(UUID(int=1)),
        ),
        _cursor(
            studio_id="studio",
            dataset="invoices",
            created_at="2026-12-01T00:00:00+00:00",
            id=str(UUID(int=1)),
        ),
    ],
)
def test_foreign_scope_or_dataset_cursor_is_rejected(cursor):
    with pytest.raises(HTTPException) as error:
        asyncio.run(BillingService(_EnrollmentClient()).list_enrollments_page("studio", cursor, 50))
    assert error.value.status_code == 400


def test_page_size_is_bounded():
    for limit in (0, 101):
        with pytest.raises(HTTPException) as error:
            asyncio.run(
                BillingService(_EnrollmentClient()).list_enrollments_page("studio", None, limit)
            )
        assert error.value.status_code == 400


@pytest.mark.parametrize(
    "role,entitled,expected",
    [
        ("admin", True, 200),
        ("front_desk", True, 200),
        ("instructor", True, 403),
        ("admin", False, 402),
    ],
)
def test_enrollment_page_endpoint_obeys_billing_access_before_reading(role, entitled, expected):
    provider = _EnrollmentClient(
        {
            "staff_roles": [
                dict(user_id="reader", studio_id="studio", role=role, archived_at=None)
            ],
            "student_billing_enrollments": _studio_enrollments(3)
            + [_enrollment(99999, studio="other")],
        }
    )
    app = FastAPI()
    app.include_router(endpoints.router)
    app.dependency_overrides[get_current_user_id] = lambda: "reader"
    app.dependency_overrides[get_requested_studio_id] = lambda: "studio"
    app.dependency_overrides[get_supabase] = lambda: provider
    client = TestClient(app)
    with patch(
        "app.services.studio_scope.get_platform_subscription_access",
        return_value={
            "subscription_required": not entitled,
            "status": "active" if entitled else "canceled",
            "comped": False,
        },
    ):
        response = client.get("/billing/enrollments/page?limit=2")
        enrollment_queries = [
            query for query in provider.query_log if query["table"] == "student_billing_enrollments"
        ]
        assert response.status_code == expected, response.text
        if expected != 200:
            assert enrollment_queries == [], "access denial must precede reading billing data"
            return
        body = response.json()
        assert body["complete"] is False and body["next_cursor"]
        assert [item["id"] for item in body["items"]] == [str(UUID(int=3)), str(UUID(int=2))]
        rest = client.get(
            "/billing/enrollments/page", params={"cursor": body["next_cursor"], "limit": 2}
        ).json()
        assert rest["complete"] is True and rest["next_cursor"] is None
        assert [item["id"] for item in rest["items"]] == [str(UUID(int=1))]
        assert client.get("/billing/enrollments/page?limit=101").status_code == 422
