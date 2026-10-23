# Flexible read access for AI assistants

Koaryu exposes a read-only MCP server at the backend's `/mcp` endpoint. An assistant can discover the owner's authorized datasets, combine filters and relationship fields, group records, and calculate totals. It can answer new questions without adding a tool for each question.

V1 supports studio admins with an active Koaryu subscription or studio comp. The owner selects data permissions and an expiry of up to 90 days. In Settings → AI connections they can edit permissions, explicitly renew access or disconnect. Permission-only edits preserve the existing expiration. Revoked connections cannot be revived by editing them. No customer API key or personal access token is needed. The server defaults to disabled. This branch does not enable or deploy it on any hosted environment.

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

Always use `describe_data` first. Counts describe the selected dataset's grain: two membership rows are not necessarily two students. Money is in integer minor units; sum/average requires a currency filter or grouping. Payer balances have no declared currency field, so they can be read individually but cannot be summed through this query contract. Date buckets use the studio timezone. Financial results reflect stored Koaryu records without refreshing Stripe.

Pages contain at most 200 rows and expose `has_more`/`next_offset`. Responses are limited to 48 KB. Aggregation and related queries share a 20,000-row, 80-provider-call, 8 MB and 10-second budget. Queries exceeding a budget fail without partial totals. Results are live reads, not a frozen multi-request database snapshot. Narrow large queries by date or other filters.

`upcoming_classes` projects recurring classes without inserting sessions. It includes stored changes and cancellations, excludes deleted occurrences, and identifies projected rows. Its coverage defaults to today through 30 days ahead; explicitly requested windows may span up to 93 days. Read the returned `date_coverage`.

## Permission and authentication model

Owners grant dataset permissions independently: students, schedule, belts, leads, workflows and billing. Contacts, personal details and free-text notes require additional opt-in permission. The same field checks apply to schema discovery, selection, filtering, grouping, sorting and aggregation. Unavailable fields cannot be used as inference filters. Stored text is labeled as untrusted content.

The official Python MCP SDK supplies Streamable HTTP and protected-resource discovery. Supabase Auth owns OAuth registration, authorization codes, PKCE, signing and refresh rotation. Koaryu owns the consent screen and server-side grants. Python’s first-party `tzdata` package supplies timezone data when a slim runtime lacks an IANA name or alias; it adds no hosted service. There is no separate auth vendor, database driver or MCP hosting service.

`mcp_access_token_hook` preserves ordinary sign-in tokens. For native OAuth clients it requires a stored connection, sets `aud` to that connection's exact `/mcp` resource, adds the connection ID and binds the native session. Supabase browser authorization request IDs are opaque strings. Koaryu validates them as bounded URL-safe identifiers and maps them to a deterministic internal UUID for consent replay; it does not treat the native browser identifier as an Auth database UUID. The access-token subject is `urn:koaryu:mcp:<connection-id>`, a connection principal that cannot resolve to a Supabase Auth user UUID. The hook removes account metadata, email and phone from connector access tokens. It only accepts `offline_access`; it refuses OpenID and identity scopes so native Auth cannot issue a separate owner ID token outside the hook. Normal Koaryu API authentication rejects connector identities, including in development fallback mode. The MCP verifier validates signature, issuer and audience, and checks the grant, session, expiry, current admin membership and subscription on every request. Tool reads check authorization again before returning data.

The backend uses its existing service-role PostgREST access. Tenant scoping and field allowlists are enforced by the reader, not by a prompt. `student_guardians` checks ownership of both parent records. There are no customer-data write tools. Operational writes are limited to consent/session/revocation and latest-access metadata in `mcp_connections`; query text, values and results are not persisted there. Logs must not record Bearer tokens or MCP request/response bodies.

The connector has separate bounded authentication and read lanes, independent of dashboard capacity. Authentication has two workers and eight queued slots; reads have two workers and two queued slots. Slow or cancelled reads retain their actual worker capacity but cannot occupy authentication workers. Saturated work fails with a retryable error. A per-process limit allows 60 authenticated requests per minute per connection. Multi-process rate limits are independent; load-test the intended deployment and use a shared gateway limit where required.

## Enable on an authorized test environment

These are deployment prerequisites, not actions performed by this branch. Follow [services](services.md), [cutover gates](cutover-gates.md) and the private operator runbook. Use the migration's V60→V61 guarded rollout; never run verification SQL against production.

1. Apply `20261022233855_flexible_read_mcp.sql` through the approved migration process. It adds the connection table and two functions, advances readiness to preflight V42/V61, and preserves the predecessor compatibility check.
2. In that environment's existing Supabase Auth project, enable OAuth Server. Use asymmetric JWT signing. Clients must request exactly `offline_access`, without `openid`, `profile`, `email` or `phone`. Configure its authorization path as `/connect/authorize`, with the environment's existing frontend as Site URL. Register a public PKCE client with exact callback URLs, or enable native dynamic registration for MCP clients that require it. Allow the frontend `/auth/callback` URL with its validated `next` return path in the Auth redirect allowlist. Do not replace existing social identity-provider configuration.
3. Enable the custom access-token hook `public.mcp_access_token_hook`. If the project already has a custom access-token hook, review and compose its behavior before activation; Supabase exposes one hook of this type. The migration explicitly grants `supabase_auth_admin` public-schema usage and function/table access. The connection table also retains the standard restrictive ambiguous-membership guard, without granting client table or column access. Immediately verify ordinary email, Google and Microsoft sign-in and refresh. If any fails, disable the hook before continuing.
4. Set backend `MCP_PUBLIC_URL` to the exact canonical HTTPS address ending in `/mcp`, without a trailing slash, query or fragment. Set `MCP_ENABLED=true` only after the schema and hook are ready. Keep the existing backend frontend-origin and Supabase settings. No new secret is required.
5. Verify `/.well-known/oauth-protected-resource/mcp`, its advertised authorization server, and the native server's OAuth discovery. An unauthenticated MCP request must return 401 with discovery information. A normal Koaryu user token must not read MCP data, and a connector token must not access normal app APIs. Using a disposable test account, verify connector tokens are refused on Supabase Auth's `GET/PUT /auth/v1/user`, `/factors`, `/logout` and `/user/oauth/grants`, including account mutation attempts. Verify the ordinary `/auth/v1/token?grant_type=refresh_token` endpoint refuses the connector refresh token without matching OAuth client authentication, and that `/oauth/token` returns no owner user object or ID token. A read-only connector must not inherit account-management authority. If those checks fail, keep activation disabled and resolve that boundary before offering the connector. Pre-register clients during evaluation; do not enable public dynamic registration until this proof passes.
6. Connect the MCP client, complete Koaryu login, approve a limited permission selection and run the prompts above against the intended synthetic test studio. Confirm contact/notes refusal, studio isolation, expiry, refresh, disconnect, and reconnect with changed permissions. Verify that an old session remains refused after reconnect. Capture the hook's authentication-method value for a real refresh and confirm it cannot enter the fresh authorization-code branch. Exercise an expired connection, native auto-approval, refused refresh, and the client's re-authentication prompt. For an expired connection, choose Renew access in Koaryu settings and explicitly select a duration. If you want a fresh sign-in or native consent skips a needed screen, Disconnect in Koaryu first, then start a new connection.
7. Keep hosted activation disabled until a real native OAuth authorization-code exchange and refresh have passed on the intended environment. Local verification has exercised a real disposable native Auth authorization-code exchange and refresh with the actual backend and PostgREST, including the official MCP OAuth client. This does not claim an exchange has run against the intended hosted Auth version.

The native behavior was inspected in [Supabase Auth source c3348e8](https://github.com/supabase/auth/tree/c3348e8f1cb31454e9783e4eb9eab1e71ad9652f). Its Auth middleware loads subjects as user UUIDs, while its custom-hook schema permits a string subject. Its OAuth refresh path uses `token_refresh` and binds refreshes to the OAuth client. These source checks explain the connection-principal design; they do not replace smoke tests against the deployed Auth version.

Native setup references: [Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server/getting-started), [token security and custom audience](https://supabase.com/docs/guides/auth/oauth-server/token-security).

For ChatGPT, create a custom MCP connection in the account/workspace's developer settings and supply the HTTPS `/mcp` URL with OAuth. Follow the current [OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Plan and workspace permissions control availability. A public ChatGPT listing requires a separate submission and review; deploying this endpoint alone does not create a listing or guarantee recommendations. The standard authenticated MCP server can serve that later app.

For Claude Code, add the HTTPS endpoint as a remote HTTP MCP server and complete its OAuth login. Use its MCP connection screen to retry authorization or remove the client. In Koaryu, Settings → AI connections controls access regardless of the assistant's local connection state.

## Real native OAuth proof

For a repeatable assembled check without Docker, supply trusted native Supabase Auth and PostgREST binaries plus PostgreSQL17. Use the existing backend development environment. The check accepts no hosted database URL or real account credentials, reserves the local Supabase port exclusively through server startup, creates a fresh Unix-only database and synthetic ES256 keys, applies native Auth and Koaryu migrations, and runs the actual backend. It cleans up its own servers and cluster on completion.

```sh
backend/venv/bin/python scripts/verify-mcp-oauth-native.py \
  --auth-binary /absolute/path/to/auth \
  --postgrest-binary /absolute/path/to/postgrest \
  --postgres-bin /absolute/path/to/postgresql17/bin \
  --evidence-dir /absolute/private/path/to/new-evidence
```

The initial implementation was exercised with native Auth source `c3348e8f1cb31454e9783e4eb9eab1e71ad9652f`, PostgREST14.18 and PostgreSQL17.11. The tool records binary hashes and the candidate. Build native Auth from the [official source instructions](https://github.com/supabase/auth#quick-start); use a verified [official PostgREST binary](https://github.com/PostgREST/postgrest/releases). These are optional development tools, not additional Koaryu runtime services.

The proof covers discovery, DCR, PKCE and a wrong verifier, native consent, ordinary login/refresh, connector account-endpoint refusal, identity-token bypass refusal, real MCP reads and field grants, unchanged business records, expiry, access editing, explicit renewal, disconnect and reconnect. Native hook rejection currently surfaces as a native500 for some refused token exchanges; this is recorded as a refusal, not a successful token response. Activation still requires checking the deployed Auth version and a real ChatGPT/Claude client.

Append `--large-fixture` to also create two fresh studios with 1,000 students, 1,000 sessions and 25,000 attendance records each. This mode checks concurrent studio-scoped groups, exact monthly totals through related-date filters, denied contact fields and oversized-query refusal. It holds actual attendance reads at the database while checking another studio’s authentication and the owner API, then verifies business-row hashes are unchanged. Durations go into private `large-fixture.json` evidence. This is a bounded local capacity check, not a hosted service-level guarantee.

## Verification

```sh
cd backend
venv/bin/python -m pytest tests/test_mcp_read_query.py tests/test_mcp_read_auth_transport.py tests/test_mcp_connections.py tests/test_mcp_connection_access.py tests/test_mcp_read_capacity.py -q
```

```sh
cd frontend
node --experimental-strip-types --test tests/mcp-connections.test.mjs tests/mcp-connections-mounted.test.mjs tests/auth-callback.test.mjs tests/google-auth.test.mjs
KOARYU_E2E_FRONTEND_URL=http://127.0.0.1:4100 npx playwright test e2e/mcp-consent.spec.ts --workers=1
```

The browser test expects a loopback frontend built with `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-key`, `NEXT_PUBLIC_API_URL=http://127.0.0.1:8102/api/v1`, `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:4100`, and preview mode disabled. It intercepts synthetic Auth and API traffic and covers sign-in return paths, consent, sensitive-field opt-in, expiry, decline, failure and mobile layout.

The Supabase CLI runs the MCP SQL contract as its disposable local bootstrap administrator so the contract can switch to the actual Auth role; it adds no role memberships or production grants. Other local contracts keep their existing runner role.

Database verification uses `supabase/verification/mcp_read_connections_contract.sql` in the disposable local verifier, plus `scripts/verify-v60-v61-restore-contract.py` for the populated upgrade/restore continuation. Follow the database verification policy before choosing a local suite. Normal generation checks are `npm run check:api-types`, `npm run check:release-attestation`, `npm run check:release-workflow` and `npm run check:env-examples`.
