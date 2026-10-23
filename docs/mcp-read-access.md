# Flexible read access for AI assistants

Koaryu exposes a read-only MCP server at the backend's `/mcp` endpoint. An assistant can discover the owner's authorized datasets, combine filters and relationship fields, group records, and calculate totals. It can answer new questions without adding a tool for each question.

V1 supports studio admins with an active Koaryu subscription or studio comp. The owner selects data permissions and an expiry of up to 90 days, and can disconnect in Settings → AI connections. No customer API key or personal access token is needed. The server defaults to disabled. This branch does not enable or deploy it on any hosted environment.

## Try the synthetic demo now

From the repository root, with Python 3.11+ and backend development dependencies installed:

```sh
python3 -m venv backend/venv
backend/venv/bin/pip install -r backend/requirements-dev.txt
npm run mcp:demo
```

Leave it running. In another terminal:

```sh
npm run mcp:check-demo
```

The check uses the official MCP client over HTTP. It verifies discovery, 12 students in the synthetic studio, two programs with six memberships each, a USD 450.00 open invoice balance, and refusal to return contact details without permission. A record belonging to another synthetic studio is deliberately present and must stay hidden.

For interactive testing, open `http://127.0.0.1:8101/demo`. Copy its public synthetic token into an MCP client's Bearer authorization header and connect to `http://127.0.0.1:8101/mcp`. This fixture runs on loopback only, uses no database or provider credentials, and cannot read a real studio. Its token is valid only for this demo. The demo is a development script, never part of the deployed application.

Example questions:

- How many students are active, and how many are on hold?
- Compare student membership counts by program.
- Which students attended Karate most often during October 1–14, 2026?
- What is the outstanding invoice balance by currency?
- Show the next two weeks of recurring classes.
- Show student email addresses. This should return a permission error.

A cloud assistant cannot reach this loopback demo directly. Use a local MCP client to test it. Testing ChatGPT requires the authorized HTTPS setup below.

## Tools and query examples

| Tool | Purpose |
| --- | --- |
| `get_context` | Connected studio, timezone, permissions and expiry |
| `describe_data` | Available datasets, fields, types, meanings and relationships |
| `query_data` | Filters, selection, grouping, aggregates, sorting and paging |
| `get_record` | One UUID record with an optional field selection |

The query language is structured JSON. It accepts AND filters, declared many-to-one relationships, and count, distinct count, sum, average, minimum and maximum. It does not accept arbitrary SQL, arbitrary table names, RPCs or expressions. The catalog covers students, memberships, guardians, programs, classes, attendance, ranks, promotions, belt tests, leads, activities, trials, stored billing facts and workflow metadata.

Examples of `query_data` arguments:

```json
{
  "query": {
    "dataset": "memberships",
    "where": [{"field": "status", "op": "eq", "value": "active"}],
    "group_by": [{"field": "program.name"}],
    "aggregates": [{"op": "count_distinct", "field": "student_id", "alias": "students"}],
    "order_by": [{"field": "students", "direction": "desc"}]
  }
}
```

```json
{
  "query": {
    "dataset": "attendance",
    "where": [
      {"field": "session.date", "op": "gte", "value": "2026-10-01"},
      {"field": "session.date", "op": "lt", "value": "2026-11-01"},
      {"field": "status", "op": "eq", "value": "present"}
    ],
    "group_by": [{"field": "student.legal_first_name"}, {"field": "student_id"}],
    "aggregates": [{"op": "count", "alias": "visits"}],
    "order_by": [{"field": "visits", "direction": "desc"}]
  }
}
```

Always use `describe_data` first. Counts describe the selected dataset's grain: two membership rows are not necessarily two students. Money is in integer minor units; sum/average requires a currency filter or grouping. Date buckets use the studio timezone. Financial results reflect stored Koaryu records without refreshing Stripe.

Pages contain at most 200 rows and expose `has_more`/`next_offset`. Responses are limited to 48 KB. Aggregation and related queries share a 20,000-row, 80-provider-call, 8 MB and 10-second budget. Queries exceeding a budget fail without partial totals. Results are live reads, not a frozen multi-request database snapshot. Narrow large queries by date or other filters.

`upcoming_classes` projects recurring classes without inserting sessions. It includes stored changes and cancellations, excludes deleted occurrences, and identifies projected rows. Its coverage defaults to today through 30 days ahead; explicitly requested windows may span up to 93 days. Read the returned `date_coverage`.

## Permission and authentication model

Owners grant dataset permissions independently: students, schedule, belts, leads, workflows and billing. Contacts, personal details and free-text notes require additional opt-in permission. The same field checks apply to schema discovery, selection, filtering, grouping, sorting and aggregation. Unavailable fields cannot be used as inference filters. Stored text is labeled as untrusted content.

The official Python MCP SDK supplies Streamable HTTP and protected-resource discovery. Supabase Auth owns OAuth registration, authorization codes, PKCE, signing and refresh rotation. Koaryu owns the consent screen and server-side grants. There is no separate auth vendor, database driver or MCP hosting service.

`mcp_access_token_hook` preserves ordinary sign-in tokens. For native OAuth clients it requires a stored connection, sets `aud` to that connection's exact `/mcp` resource, adds the connection ID and binds the native session. Normal Koaryu API authentication rejects connector identities, including in development fallback mode. The MCP verifier validates signature, issuer and audience, and checks the grant, session, expiry, current admin membership and subscription on every request. Tool reads check authorization again before returning data.

The backend uses its existing service-role PostgREST access. Tenant scoping and field allowlists are enforced by the reader, not by a prompt. `student_guardians` checks ownership of both parent records. There are no customer-data write tools. Operational writes are limited to consent/session/revocation and latest-access metadata in `mcp_connections`; query text, values and results are not persisted there. Logs must not record Bearer tokens or MCP request/response bodies.

The connector has its own bounded provider lane and a per-process rate limit of 60 authenticated requests per minute per connection. It does not use the dashboard's provider capacity. Multi-process rate limits are independent; add a shared gateway limit if higher-scale deployment requires it.

## Enable on an authorized test environment

These are deployment prerequisites, not actions performed by this branch. Follow [services](services.md), [cutover gates](cutover-gates.md) and the private operator runbook. Use the migration's V59→V60 guarded rollout; never run verification SQL against production.

1. Apply `20261022233855_flexible_read_mcp.sql` through the approved migration process. It adds the connection table and two functions, advances readiness to preflight V41/V60, and preserves the predecessor compatibility check.
2. In that environment's existing Supabase Auth project, enable OAuth Server. Use asymmetric JWT signing. Configure its authorization path as `/connect/authorize`, with the environment's existing frontend as Site URL. Register a public PKCE client with exact callback URLs, or enable native dynamic registration for MCP clients that require it. Do not replace existing social identity-provider configuration.
3. Enable the custom access-token hook `public.mcp_access_token_hook`. If the project already has a custom access-token hook, review and compose its behavior before activation; Supabase exposes one hook of this type. The migration grants the native `supabase_auth_admin` role its required access.
4. Set backend `MCP_PUBLIC_URL` to the exact canonical HTTPS address ending in `/mcp`, without a trailing slash, query or fragment. Set `MCP_ENABLED=true` only after the schema and hook are ready. Keep the existing backend frontend-origin and Supabase settings. No new secret is required.
5. Verify `/.well-known/oauth-protected-resource/mcp`, its advertised authorization server, and the native server's OAuth discovery. An unauthenticated MCP request must return 401 with discovery information. A normal Koaryu user token must not read MCP data, and a connector token must not access normal app APIs.
6. Connect the MCP client, complete Koaryu login, approve a limited permission selection and run the prompts above against the intended synthetic test studio. Confirm contact/notes refusal, studio isolation, expiry, refresh, disconnect, and reconnect with changed permissions. Verify that an old session remains refused after reconnect.
7. Keep hosted activation disabled until a real native OAuth authorization-code exchange and refresh have passed on the intended environment. Local tests exercise the SQL hook and signed-token verifier separately; they do not claim a hosted Auth exchange has run.

Native setup references: [Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server/getting-started), [token security and custom audience](https://supabase.com/docs/guides/auth/oauth-server/token-security).

For ChatGPT, create a custom MCP connection in the account/workspace's developer settings and supply the HTTPS `/mcp` URL with OAuth. Follow the current [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Plan and workspace permissions control availability. A public ChatGPT listing requires a separate submission and review; deploying this endpoint alone does not create a listing or guarantee recommendations. The standard authenticated MCP server can serve that later app.

For Claude Code, add the HTTPS endpoint as a remote HTTP MCP server and complete its OAuth login. Use its MCP connection screen to retry authorization or remove the client. In Koaryu, Settings → AI connections controls access regardless of the assistant's local connection state.

## Verification

```sh
cd backend
venv/bin/python -m pytest tests/test_mcp_read_query.py tests/test_mcp_read_auth_transport.py tests/test_mcp_connections.py -q
```

```sh
cd frontend
node --experimental-strip-types --test tests/mcp-connections.test.mjs tests/auth-callback.test.mjs tests/google-auth.test.mjs
KOARYU_E2E_FRONTEND_URL=http://127.0.0.1:4100 npx playwright test e2e/mcp-consent.spec.ts --workers=1
```

The browser test expects a loopback frontend built with `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-key`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:8102/api/v1`, `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:4100`, and preview mode disabled. It intercepts synthetic Auth and API traffic and covers sign-in return paths, consent, sensitive-field opt-in, expiry, decline, failure and mobile layout.

Database verification uses `supabase/verification/mcp_read_connections_contract.sql` in the disposable local verifier, plus `scripts/verify-v59-v60-restore-contract.py` for the populated upgrade/restore continuation. Follow the database verification policy before choosing a local suite. Normal generation checks are `npm run check:api-types`, `npm run check:release-attestation`, `npm run check:release-workflow` and `npm run check:env-examples`.
