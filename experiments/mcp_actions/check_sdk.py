"""Exercise actual socket MCP and owner HTTP channels using synthetic lab credentials."""

import argparse
import asyncio
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


def origin(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or not parsed.port
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ValueError(
            "This check only accepts the actual loopback synthetic lab origin."
        )
    return value


async def check(base, credentials_path):
    fixtures = json.loads(credentials_path.read_text())
    fixture, other = fixtures
    passed = []
    async with httpx2.AsyncClient(trust_env=False, follow_redirects=False) as owner:
        health = await owner.get(base + "/health")
        assert health.json() == {
            "mode": "koaryu-synthetic-actions-v1",
            "scope": "synthetic-only",
        }
        async with (
            httpx2.AsyncClient(
                headers={"Authorization": "Bearer " + fixture["assistant_token"]},
                trust_env=False,
            ) as transport,
            streamable_http_client(base + "/mcp", http_client=transport) as streams,
            ClientSession(*streams) as session,
        ):
            initialized = await session.initialize()
            assert initialized.server_info.name == "Koaryu synthetic action lab"
            tools = await session.list_tools()
            assert {tool.name for tool in tools.tools} == {
                "preview_student_tag_add",
                "execute_student_tag_add",
                "preview_lead_followup_set",
                "execute_lead_followup_set",
            }
            passed.append("official SDK initialization and four explicit action tools")
            proposal = await session.call_tool(
                "preview_student_tag_add",
                {"student_id": fixture["student_id"], "tag": "competition"},
            )
            assert not proposal.is_error
            proposal = proposal.structured_content
            assert proposal["target_id"] == fixture["student_id"]
            arguments = {
                "proposal_id": proposal["proposal_id"],
                "idempotency_key": str(uuid4()),
            }
            blocked = await session.call_tool("execute_student_tag_add", arguments)
            assert blocked.is_error
            passed.append("execution refused without a separate owner decision")
            wrong_tenant = await session.call_tool(
                "preview_student_tag_add",
                {"student_id": other["student_id"], "tag": "competition"},
            )
            assert wrong_tenant.is_error
            passed.append("other studio target refused")
            login = await owner.post(
                base + "/owner/login",
                headers={"Origin": base},
                data={
                    "username": fixture["username"],
                    "password": fixture["password"],
                    "proposal_id": proposal["proposal_id"],
                },
            )
            assert login.status_code == 303

            async def decide(current, decision):
                page = await owner.get(
                    base + "/owner/proposals/" + current["proposal_id"]
                )
                assert page.status_code == 200
                csrf = re.search(r'name="csrf" value="([^\"]+)"', page.text).group(1)
                data = {"csrf": csrf, "digest": current["digest"], "decision": decision}
                if decision == "approve":
                    data["confirm"] = "reviewed"
                result = await owner.post(
                    base + "/owner/proposals/" + current["proposal_id"] + "/decision",
                    headers={"Origin": base},
                    data=data,
                )
                assert result.status_code == 303
                return csrf

            csrf = await decide(proposal, "approve")
            first = await session.call_tool("execute_student_tag_add", arguments)
            again = await session.call_tool("execute_student_tag_add", arguments)
            assert not first.is_error and not again.is_error
            first, again = first.structured_content, again.structured_content
            assert first["receipt_id"] == again["receipt_id"] and again["replayed"]
            assert "competition" in first["after"]["tags"] and set(
                first["before"]["tags"]
            ) <= set(first["after"]["tags"])
            passed.append(
                "real owner form approval, tag application and same-key receipt replay"
            )
            lead = await session.call_tool(
                "preview_lead_followup_set",
                {"lead_id": fixture["lead_id"], "follow_up_date": "2026-11-03"},
            )
            assert not lead.is_error
            lead = lead.structured_content
            await decide(lead, "approve")
            wrong_action = await session.call_tool(
                "execute_student_tag_add",
                {"proposal_id": lead["proposal_id"], "idempotency_key": str(uuid4())},
            )
            assert wrong_action.is_error
            changed = await session.call_tool(
                "execute_lead_followup_set",
                {"proposal_id": lead["proposal_id"], "idempotency_key": str(uuid4())},
            )
            assert not changed.is_error and changed.structured_content["after"] == {
                "follow_up_date": "2026-11-03"
            }
            passed.append("predefined lead date action and wrong-action refusal")
            denied = await session.call_tool(
                "preview_student_tag_add",
                {"student_id": fixture["student_id"], "tag": "denied-example"},
            )
            assert not denied.is_error
            denied = denied.structured_content
            await decide(denied, "deny")
            result = await session.call_tool(
                "execute_student_tag_add",
                {"proposal_id": denied["proposal_id"], "idempotency_key": str(uuid4())},
            )
            assert result.is_error
            passed.append("owner denial remains unexecutable")
        revoked = await owner.post(
            base + "/owner/connections/" + fixture["connection_id"] + "/revoke",
            headers={"Origin": base},
            data={"csrf": csrf},
        )
        assert revoked.status_code == 303
        result = await owner.post(
            base + "/mcp",
            headers={
                "Authorization": "Bearer " + fixture["assistant_token"],
                "Accept": "application/json, text/event-stream",
            },
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        )
        assert result.status_code == 401
        passed.append("owner revocation refuses subsequent MCP HTTP access")
    print(
        json.dumps(
            {
                "status": "passed",
                "scope": "synthetic fixed-bearer SDK and owner HTTP; not native OAuth or a ChatGPT host",
                "checks": passed,
            }
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", type=origin, default="http://127.0.0.1:8110")
    parser.add_argument("--credentials-file", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(check(args.origin, args.credentials_file))


if __name__ == "__main__":
    main()
