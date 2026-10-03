from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from app.services.lead_reads import fetch_lead_rows


class Provider:
    def __init__(self, count, cap=500):
        self.rows = [
            {"id": f"{i:06}", "studio_id": "one", "created_at": f"{i:06}"} for i in range(count)
        ]
        self.cap = cap
        self.calls = []

    def table(self, name):
        assert name == "leads"
        provider = self

        class Query:
            cursor = ""
            filters = None

            def select(self, _columns, **_options):
                return self

            def eq(self, key, value):
                self.filters = {**(self.filters or {}), key: value}
                return self

            def order(self, field):
                assert field == "id"
                return self

            def limit(self, value):
                assert value == 500
                return self

            def gt(self, field, value):
                assert field == "id"
                self.cursor = value
                return self

            def execute(self):
                assert self.filters["studio_id"] == "one"
                provider.calls.append(self.filters)
                return SimpleNamespace(
                    count=len(provider.rows),
                    data=[r for r in provider.rows if r["id"] > self.cursor][: provider.cap],
                )

        return Query()


@pytest.mark.parametrize("count,cap", [(0, 500), (20, 500), (1001, 500), (601, 200), (5001, 200)])
def test_reads_all_rows_even_when_provider_cap_is_smaller_than_requested_page(count, cap):
    client = Provider(count, cap)
    rows = fetch_lead_rows(client, "one", "inquiry", "walk_in")
    assert len(rows) == count
    assert len({r["id"] for r in rows}) == count
    assert rows == sorted(rows, key=lambda r: r["created_at"], reverse=True)
    assert all(c["stage"] == "inquiry" and c["source"] == "walk_in" for c in client.calls)


def test_oversized_collection_fails_before_unbounded_download():
    client = Provider(10001)
    with pytest.raises(HTTPException) as error:
        fetch_lead_rows(client, "one")
    assert error.value.status_code == 422
    assert len(client.calls) == 1
