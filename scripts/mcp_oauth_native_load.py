"""Bounded large-studio reads on NativeStack's already owned synthetic database."""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import AsyncExitStack
from uuid import uuid4

import httpx2
from local_postgres_verification import require
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp_oauth_native_stack import private_json


async def read_workload(proof, owners, tokens, owner_headers):
    before = proof.business_snapshot()
    checks, durations = [], {}
    async with AsyncExitStack() as stack:
        sessions = []
        for token in tokens:
            http = await stack.enter_async_context(
                httpx2.AsyncClient(
                    headers={"Authorization": "Bearer " + token}, trust_env=False
                )
            )
            streams = await stack.enter_async_context(
                streamable_http_client(proof.resource, http_client=http)
            )
            session = await stack.enter_async_context(ClientSession(*streams))
            await session.initialize()
            sessions.append(session)
        for index, session in enumerate(sessions):
            context = await session.call_tool("get_context", {})
            require(
                not context.is_error
                and context.structured_content["studio"]["id"]
                == owners[index]["studio_id"],
                "Large fixture context crossed studios",
            )
        grouped = {
            "query": {
                "dataset": "students",
                "group_by": [{"field": "program.name"}],
                "aggregates": [{"op": "count", "alias": "students"}],
            }
        }
        started = time.monotonic()
        results = await asyncio.gather(
            *(session.call_tool("query_data", grouped) for session in sessions)
        )
        for index, result in enumerate(results):
            require(
                not result.is_error
                and result.structured_content["rows"]
                == [
                    {"program.name": f"Large fixture program {index}", "students": 1000}
                ],
                "Large fixture grouped totals or tenant isolation differ",
            )
        durations["two_studio_groups_seconds"] = round(time.monotonic() - started, 3)
        checks.append(
            "concurrent related-program groups are complete and studio-scoped"
        )
        bounded = {
            "query": {
                "dataset": "attendance",
                "where": [
                    {"field": "session.date", "op": "gte", "value": "2026-03-01"},
                    {"field": "session.date", "op": "lt", "value": "2026-04-01"},
                ],
                "group_by": [{"field": "session.date", "interval": "month"}],
                "aggregates": [{"op": "count", "alias": "visits"}],
            }
        }
        started = time.monotonic()
        results = await asyncio.gather(
            *(session.call_tool("query_data", bounded) for session in sessions)
        )
        for result in results:
            require(
                not result.is_error
                and result.structured_content["rows"]
                == [{"session.date": "2026-03-01", "visits": 775}],
                "Related date filtering did not narrow large attendance history to the exact complete month",
            )
        durations["two_studio_months_seconds"] = round(time.monotonic() - started, 3)
        checks.append(
            "related date filters narrow 25000-row histories before complete monthly totals"
        )
        denied = await sessions[0].call_tool(
            "query_data", {"query": {"dataset": "students", "select": ["email"]}}
        )
        require(
            denied.is_error and denied.structured_content is None,
            "Large fixture contact fields escaped their grant",
        )
        checks.append("contacts stay denied with a larger data population")
        print(
            "PASS large fixture concurrent groups, monthly totals and field grants",
            flush=True,
        )

        # Block the actual table reads, not an in-memory callback. Authentication
        # touches grant/membership/subscription tables and must remain available.
        local = proof.local
        holder = await asyncio.create_subprocess_exec(
            *[
                local.psql,
                *local.connection,
                "--dbname=postgres",
                "--no-psqlrc",
                "--quiet",
                "--tuples-only",
                "--no-align",
                "--set=ON_ERROR_STOP=1",
            ],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=local.env,
        )
        heavy = []
        independent_checks_completed = False
        try:
            holder.stdin.write(
                b"BEGIN; SET LOCAL statement_timeout='5s'; LOCK TABLE public.attendance IN ACCESS EXCLUSIVE MODE; SELECT 'LOCK_READY';\n"
            )
            await holder.stdin.drain()
            ready = await asyncio.wait_for(holder.stdout.readline(), 3)
            require(
                ready.strip() == b"LOCK_READY",
                "Could not hold the owned attendance fixture lock",
            )
            all_time = {
                "query": {
                    "dataset": "attendance",
                    "aggregates": [{"op": "count", "alias": "visits"}],
                }
            }
            # Distinct client sessions exercise two physical read workers for A.
            http = await stack.enter_async_context(
                httpx2.AsyncClient(
                    headers={"Authorization": "Bearer " + tokens[0]}, trust_env=False
                )
            )
            streams = await stack.enter_async_context(
                streamable_http_client(proof.resource, http_client=http)
            )
            second_a = await stack.enter_async_context(ClientSession(*streams))
            await second_a.initialize()
            heavy = [
                asyncio.create_task(sessions[0].call_tool("query_data", all_time)),
                asyncio.create_task(second_a.call_tool("query_data", all_time)),
            ]
            deadline = time.monotonic() + 1.5
            waiters = 0
            while time.monotonic() < deadline:
                waiters = int(
                    await asyncio.to_thread(
                        local.sql,
                        "postgres",
                        "SELECT count(DISTINCT pid) FROM pg_locks WHERE relation='public.attendance'::regclass AND NOT granted AND mode='AccessShareLock';",
                    )
                )
                if waiters >= 2:
                    break
                await asyncio.sleep(0.01)
            require(
                waiters >= 2,
                "The real read workers did not both wait on the fixture table",
            )
            started = time.monotonic()
            # Each protocol POST passes through the real bearer verifier. Ping
            # has no data read, so it must not wait for an occupied read worker.
            await asyncio.wait_for(sessions[1].send_ping(), 1.5)
            durations["authentication_while_reads_blocked_seconds"] = round(
                time.monotonic() - started, 3
            )
            async with httpx2.AsyncClient(trust_env=False, timeout=2) as client:
                started = time.monotonic()
                owner = await client.get(
                    proof.backend + "/api/v1/mcp/connections", headers=owner_headers[1]
                )
                require(
                    owner.status_code == 200 and owner.json()["enabled"],
                    "MCP read load blocked ordinary owner connection management",
                )
                durations["owner_api_while_reads_blocked_seconds"] = round(
                    time.monotonic() - started, 3
                )
            require(
                all(not task.done() for task in heavy),
                "Read workers were not still occupied during the independent authorization checks",
            )
            checks.append(
                "real blocked reads cannot occupy another studio's authentication or owner API lanes"
            )
            independent_checks_completed = True
        finally:
            if holder.returncode is None:
                holder.stdin.write(b"ROLLBACK;\n")
                await holder.stdin.drain()
                holder.stdin.close()
                try:
                    await asyncio.wait_for(holder.wait(), 3)
                except TimeoutError:
                    holder.terminate()
                    await asyncio.wait_for(holder.wait(), 3)
            await holder.stdout.read()
            await holder.stderr.read()
            if not independent_checks_completed:
                for task in heavy:
                    task.cancel()
                await asyncio.gather(*heavy, return_exceptions=True)
        results = await asyncio.gather(*heavy)
        for result in results:
            require(
                result.is_error
                and result.structured_content is None
                and "Query data limit reached" in str(result.content),
                "Oversized all-time history returned partial totals or an unrelated failure",
            )
        checks.append(
            "over-budget all-time queries fail without partial totals after releasing the real table lock"
        )
    require(
        proof.business_snapshot() == before,
        "Large read workload changed business records",
    )
    checks.append("business-row hashes remain unchanged around all large reads")
    return {
        "status": "passed",
        "studios": 2,
        "students_per_studio": 1000,
        "sessions_per_studio": 1000,
        "attendance_per_studio": 25000,
        "checks": checks,
        "durations": durations,
        "limit": "local native fixture evidence; not a hosted SLA or a ChatGPT host test",
    }


def run_large_fixture(proof):
    owners = [proof.new_owner("large-" + uuid4().hex[:10]) for _ in range(2)]
    tokens, headers = [], []
    for index, owner in enumerate(owners):
        actor, studio, program = owner["user_id"], owner["studio_id"], str(uuid4())
        # IDs are generated locally; no caller SQL or existing studio is accepted.
        proof.local.sql(
            "postgres",
            f"""
BEGIN;
INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES('{studio}','Large native studio {index}','native-large-{studio}','{actor}','America/Los_Angeles');
INSERT INTO public.staff_roles(user_id,studio_id,role) VALUES('{actor}','{studio}','admin') ON CONFLICT DO NOTHING;
INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES('{studio}','active',true) ON CONFLICT(studio_id) DO UPDATE SET status='active',comped=true;
INSERT INTO public.programs(id,studio_id,name) VALUES('{program}','{studio}','Large fixture program {index}');
CREATE TEMP TABLE load_students(seq integer,id uuid) ON COMMIT DROP;
INSERT INTO load_students SELECT n,gen_random_uuid() FROM generate_series(0,999) n;
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,program_id,email,notes)
SELECT id,'{studio}','Large {index} '||seq,'Synthetic','active','{program}','large-{index}-'||seq||'@example.invalid','Synthetic notes not granted' FROM load_students;
CREATE TEMP TABLE load_sessions(seq integer,id uuid,date date) ON COMMIT DROP;
INSERT INTO load_sessions SELECT n,gen_random_uuid(),DATE '2024-01-01'+n FROM generate_series(0,999) n;
INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time,program_id,status)
SELECT id,'{studio}','Large synthetic class',date,TIME '16:00',TIME '17:00','{program}','completed' FROM load_sessions;
INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at,counts_toward_eligibility)
SELECT '{studio}',session.id,student.id,'present',(session.date+TIME '16:00') AT TIME ZONE 'America/Los_Angeles',false
FROM load_sessions session CROSS JOIN generate_series(0,24) visitor JOIN load_students student ON student.seq=(session.seq*25+visitor)%1000;
COMMIT;
""",
            timeout=120,
        )
        proof.owners = [owner, owners[1 - index]]
        proof.owner_headers = {
            "Authorization": "Bearer " + proof.login(owner)["access_token"]
        }
        headers.append(proof.owner_headers)
        registered = proof.register()
        flow = proof.begin(registered["client_id"])
        code = proof.approve(flow, ["students", "schedule"])
        issued = proof.expect(
            proof.exchange(flow, code), {200}, "large fixture native exchange"
        ).json()
        tokens.append(issued["access_token"])
    result = asyncio.run(read_workload(proof, owners, tokens, headers))
    private_json(proof.stack.evidence / "large-fixture.json", result)
    proof.cases.append(
        {
            "case": "large fixture reads, budgets and independent authorization",
            "status": "passed",
        }
    )
    print("PASS large fixture workload: " + json.dumps(result), flush=True)
    return result
