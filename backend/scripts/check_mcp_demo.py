#!/usr/bin/env python3
"""Exercise the real MCP Python client against the loopback synthetic demo."""

import argparse
import asyncio
from urllib.parse import urlparse

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def check(origin):
    parsed = urlparse(origin)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"localhost", "127.0.0.1"}
        or parsed.path not in {"", "/"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("This synthetic check only accepts a loopback HTTP origin.")
    async with httpx2.AsyncClient(trust_env=False) as bootstrap:
        response = await bootstrap.get(origin.rstrip("/") + "/demo")
        response.raise_for_status()
        demo = response.json()
    assert demo["mode"] == "synthetic-only"
    async with (
        httpx2.AsyncClient(
            headers={"Authorization": "Bearer " + demo["token"]}, trust_env=False
        ) as transport,
        streamable_http_client(demo["server_url"], http_client=transport) as streams,
        ClientSession(*streams) as session,
    ):
        initialized = await session.initialize()
        assert initialized.server_info.name == "Koaryu"
        tools = await session.list_tools()
        assert {t.name for t in tools.tools} == {
            "get_context",
            "describe_data",
            "query_data",
            "get_record",
        }
        assert all(t.annotations.read_only_hint for t in tools.tools)
        result = await session.call_tool(
            "query_data",
            {
                "query": {
                    "dataset": "students",
                    "aggregates": [{"op": "count", "alias": "students"}],
                }
            },
        )
        assert not result.is_error and result.structured_content["rows"] == [{"students": 12}], (
            result
        )
        result = await session.call_tool(
            "query_data",
            {
                "query": {
                    "dataset": "memberships",
                    "group_by": [{"field": "program.name"}],
                    "aggregates": [
                        {"op": "count_distinct", "field": "student_id", "alias": "students"}
                    ],
                }
            },
        )
        assert not result.is_error and sorted(
            r["students"] for r in result.structured_content["rows"]
        ) == [6, 6], result
        result = await session.call_tool(
            "query_data",
            {
                "query": {
                    "dataset": "invoices",
                    "group_by": [{"field": "currency"}],
                    "aggregates": [
                        {
                            "op": "sum",
                            "field": "amount_remaining_cents",
                            "alias": "balance_cents",
                        }
                    ],
                }
            },
        )
        assert not result.is_error and result.structured_content["rows"] == [
            {"currency": "usd", "balance_cents": 45000}
        ], result
        denied = await session.call_tool(
            "query_data", {"query": {"dataset": "students", "select": ["email"]}}
        )
        assert denied.is_error
        schema = await session.call_tool("describe_data", {"dataset": "students"})
        assert (
            not schema.is_error
            and "email" not in schema.structured_content["datasets"][0]["fields"]
        )
    print(
        "PASS: SDK connection, tool discovery, studio isolation, joins, complete totals and field-permission refusal."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8101")
    asyncio.run(check(parser.parse_args().origin))
