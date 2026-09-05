# Koaryu Rendering Performance Rollout

This runbook covers Dashboard, roster, Schedule and Billing performance changes. FastAPI remains the authorization boundary. Private reads retain their scope and access checks, with rollback paths that preserve correctness.

## Read-path architecture decision

Koaryu will keep FastAPI in front of Supabase and use page-specific RPCs for
critical read projections. The first optimization is fewer database round
trips, not a second persistence layer.

Direct PostgreSQL access remains out of scope. Reconsider it only if realistic
250-student and 2,500-student load tests show that the RPC path misses a stated
user-facing latency target.

Dashboard summary facts already use one `dashboard_summary_facts` RPC. The
server-paginated Students roster already uses one `list_student_roster` RPC.
Those paths remain unchanged.

Schedule now loads one bounded page projection from `GET /schedule/window`.
After FastAPI resolves the authorized studio, the endpoint calls the
service-role-only `schedule_window_read` RPC once and returns active templates,
sessions in the requested range, and attendance for those sessions. The read is
limited to 93 days and never materializes recurring sessions.

Authorized calendar workflows still materialize recurring sessions through a
POST. `POST /schedule/window/materialize` performs the existing write RPC, then
calls the same read RPC. The two database operations are deliberate: the write
commits recurring occurrences, and the read returns one validated page model.

Billing Overview uses one `/billing/landing` request for diagnostic status and
complete database aggregates. It does not load the full student roster or invoice
list. Financial tab reads start on activation. See
[billing-landing-contract.md](billing-landing-contract.md) for the field access
matrix, retention, aggregate formulas, deployment order and rollback window.

### Release order and rollback

For the performance candidate, apply `20260905022339_billing_landing_aggregates.sql`
through the guarded rollout workflow, verify V19 readiness at 133 migrations,
then deploy the backend before the frontend. The V18 compatibility bridge keeps
the previous V37 backend healthy during database-first rollout. Existing Billing
and Schedule endpoints remain available for frontend rollback. Keep the new
backend while the additive RPCs remain installed unless the older backend passes
its exact compatibility readiness checks.

The earlier Schedule migration `20260825043911` keeps `koaryu_release_schema_preflight_v4` returning
the exact V24-shaped row after V25 lands, so the currently deployed backend
stays healthy during database-first rollout. The new backend uses
`koaryu_release_schema_preflight_v5`. Remove the V24 bridge in a later additive
migration only after both hosted backends have deployed the V25-aware release
and exact hosted readback is recorded.

## Rollout Switches

Backend:

- `/dashboard/bootstrap` returns only the critical studio shell data. The compact owner summary loads afterward from `/dashboard/summary` so large-studio summary work cannot block the first Dashboard render.
- If `/dashboard/summary` has production latency or correctness issues, keep the endpoint deployed but triage it separately; the Dashboard will continue rendering from the bootstrap slice while the summary request fails soft.

Frontend:

- `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER=true` keeps the normal Students route on backend pagination, search, status filter, program filter, and sort.
- Set `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER=false` if the Students roster has a blocking production regression. This restores the full-roster client path.
- `NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG=false` should stay false in production. Set it to true only during a short diagnostic window to log Web Vitals and Koaryu performance marks to the browser console.

Local user diagnostic:

- In production, a single browser can enable console performance logs with `localStorage.setItem("koaryu:debug-performance", "true")`, then disable them with `localStorage.removeItem("koaryu:debug-performance")`.

## Pre-Deploy Checks

Run from the repo root:

```bash
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
PYTHONPATH=backend backend/venv/bin/pytest backend/tests
backend/venv/bin/python -m compileall backend/app backend/tests
git diff --check
```

Optional bundle check:

```bash
npm --prefix frontend run analyze
```

## Deterministic Regression Gate

The canonical local gate calls the real Dashboard summary endpoint, including
fresh context resolution, cached RPC facts and response assembly, against fake
provider I/O. It is not a browser or hosted database latency measurement. It runs the three
fixed profiles in `performance/dashboard-summary-budget.json`: `small` (25
students), `medium` (250 students), and `large` (2,500 students). Each profile
uses the same fixed request, route and role. Supporting cardinalities vary
independently, including attendance, memberships, leads, invoices, payments and
Stripe events.

The versioned budget manifest is the owner of the profile ceilings and metric
semantics. Its `dashboard-summary-performance-v2` manifest version and
`dashboard-summary-endpoint-fixture-v2` fixture revision must remain bound to emitted
evidence. The gate emits one aggregate-only JSON object to stdout. It never
emits fixture rows, names, payloads, tenant identifiers, or other privacy-
bearing data; the stdout result is run evidence and is ephemeral, not a
tracked source artifact.

Run it from the repository root with the candidate's full SHA:

```bash
npm run check:performance-regression -- --expected-sha <full-sha>
```

The runner uses `backend/venv/bin/python` when that interpreter exists. Set
`KOARYU_PERFORMANCE_PYTHON` to an explicit compatible interpreter only when a
worktree lacks that venv, for example a shared local checkout. Do not use the
override to point the gate at a hosted service. The command fails when the
worktree has tracked or untracked changes, the checked-out SHA differs from
`--expected-sha`, a profile or route is missing,
the manifest/fixture/privacy bindings differ, a metric is non-finite or over
budget, or any privacy-bearing field appears in the aggregate evidence.

Release CI runs this same gate in a separate, bounded `performance-regression`
job after establishing Node 22.13.0 and Python 3.11. It checks out and asserts
the exact pull-request head or push SHA, installs only the pinned backend
runtime lock needed by the fixture, binds `KOARYU_PERFORMANCE_PYTHON` to the
Actions interpreter, and passes that exact SHA to the command. The job is a
fail-closed dependency of `Release candidate gate`; it uses no services,
browsers, databases, secrets, or hosted targets.

## Production Smoke

After Render and Vercel deploy the same commit, verify the public release identity before capturing any performance data:

```bash
npm run verify:deployed-release -- \
  --environment production \
  --expected-sha "$RELEASE_SHA" \
  --frontend-origin https://koaryu.app \
  --backend-api https://koaryu.onrender.com/api/v1
```

The verifier performs GET-only probes against pinned Koaryu targets, rejects redirects, and requires the frontend plus both Render readiness paths to report the same full SHA. A mismatch invalidates subsequent performance evidence.

The browser harness records two separate readiness metrics. `dashboard_shell_ready_ms`
comes from a committed visible shell mark scoped to the current route and identity
generation. It does not prove that identity or owner data is present. The legacy
shell/layout DOM attribute still requires identity and persisted layout resolution.
`dashboard_ready_ms` comes from a committed complete-data mark after
layout resolution and the controller's complete required-dataset aggregate is
ready: students, programs, leads, schedule, dashboard summary, and
selected-ladder belt eligibility. Preview semantics remain owned by the same
resolver. Treat the latter as the true-data readiness measure. Identity and first-useful content have separate committed marks. Marks are written
after a paint opportunity and retain only fixed route labels and numeric
generations. The optional network-idle wait happens afterward and is excluded
from readiness timings.
Separately, evidence validation requires HTTP 200 responses from
`/dashboard/bootstrap` and `/dashboard/summary`, resource timings, and at least one allowlisted
finite, nonnegative `Server-Timing` duration for each response; those two
responses alone do not prove the full true-data marker.

For a privacy-safe authenticated dashboard capture, create a Playwright storage-state file through the existing approved sign-in workflow, then run:

```bash
npm run capture:dashboard-performance -- \
  --environment production \
  --expected-sha "$RELEASE_SHA" \
  --frontend-origin https://koaryu.app \
  --backend-api https://koaryu.onrender.com/api/v1 \
  --storage-state /absolute/private/path/storage-state.json
```

The harness requires a prior exact-SHA deployed-release verification before
Chromium starts and a second exact-SHA verification after the browser closes.
An alias move, frontend/backend SHA mismatch, failed readiness probe, missing
resource timing, missing allowlisted server timing, non-finite metric, blocked
write, or unknown-origin request invalidates the capture. It waits for the
dashboard's explicit true-data marker, which requires layout resolution plus
the controller's complete required-dataset aggregate: students, programs,
leads, schedule, dashboard summary, and selected-ladder belt eligibility.
Preview semantics remain owned by the same resolver. Separately, evidence
validation requires HTTP 200 responses from `/dashboard/bootstrap` and
`/dashboard/summary`, resource timings, and allowlisted
`Server-Timing`; those two responses alone do not prove the full data marker.
It emits only aggregate timing labels. It does not emit URLs, query strings,
response bodies, tenant/user identifiers, credentials, or storage state. Keep
the storage-state file private and delete it through the approved local
secret-handling workflow after capture.

Then complete the functional smoke:

1. Visit `/health` on the deployed backend and `/api/v1/health` through the configured API base.
2. Sign in as a studio user with Koaryu Core access.
3. Open `/dashboard` and confirm the owner metrics render without console errors.
4. Check the dashboard network response for `/dashboard/bootstrap`: it should include `Cache-Control: no-store, private`, `Vary: Authorization, X-Studio-Id`, and `Server-Timing`.
5. Open `/students`; confirm the first page renders without a full-roster wait.
6. Search a normal name, an accented name if present, and a no-match term. The page should show loading or updating copy while waiting and an action-oriented empty state when no results match.
7. Use status and program filters, sort by name/status/member date, and move between pages if the studio has more than 50 students.
8. Open a derived roster link such as `/students?inactiveDays=14`; it should not show partial bootstrap results as final data.
9. Run one harmless bulk tag/status rehearsal in a disposable or demo studio and confirm the current page reloads without hydrating the full roster.
10. Open `/billing`, `/belt-tracker`, `/reports`, `/settings`, and `/automations` once to confirm disabled auto-prefetch did not hide route-level errors.

## What To Watch

Expected improvements:

- Faster dashboard useful paint because the first render consumes the bounded bootstrap payload while compact owner metrics load afterward.
- Less client CPU on dashboard and Students.
- Less bandwidth and backend work from route prefetching heavy CRM areas.
- Normal Students search/filter/sort should scale beyond the bootstrap student cap.

Known tradeoffs:

- The normal Students roster now depends on backend round trips for search/filter/sort. Debounce and stable loading states should keep small studios feeling responsive.
- Derived Students views retain the existing bounded roster RPC, query-bound cursors, exact totals and page-only enrichment. Bootstrap rows do not establish roster-page authority.
- Summary-backed widgets, schedule widgets and optional eligibility report their own readiness. Required errors remain visible. First-useful content never substitutes for the complete-data metric.
- Production console performance logging is intentionally manual. There is no third-party telemetry sink in this pass.
- The evidence harness is an operator-run point-in-time capture, not durable telemetry or an SLO monitor. Speed Insights and other retained/paid sinks remain uninstalled pending destination, sampling, retention, privacy, and cost decisions.

## Rollback Steps

If dashboard summary causes issues:

1. Confirm `/dashboard/bootstrap` still returns `200` quickly and `summary` is absent or null.
2. Inspect `/dashboard/summary` server timing and backend logs for the slow or failing section.
3. Confirm `/dashboard` still renders from the bootstrap roster slice while the summary request fails soft.

If the Students roster causes issues:

1. Set `NEXT_PUBLIC_STUDENTS_PAGED_ROSTER=false` on Vercel.
2. Redeploy the frontend, because `NEXT_PUBLIC_` values are build-time inputs.
3. Confirm `/students` uses the legacy full-roster behavior and derived roster links still refresh.

If production needs temporary performance debugging:

1. Prefer the local-storage flag for one browser.
2. If a deployed build-level flag is needed, set `NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG=true`, redeploy, capture logs, then set it back to false and redeploy.

## Risk Register

- Tenant leakage: all CRM reads still go through FastAPI endpoints or backend services with user/studio/subscription checks. Do not move service-role access to Next.
- Incorrect dashboard counts: summary queries must use full-studio aggregate or scoped backend logic, not the 200-student bootstrap page.
- Partial roster accuracy: local student mutations must preserve `studentsMayBePartial` unless a real full roster refresh succeeds.
- Search grammar injection: backend Students search strips PostgREST delimiter and wildcard characters before building the raw `or` filter.
- Hidden route errors: heavy/admin routes have reduced auto-prefetch, so route-level loading screens and direct smoke checks are part of release verification.
- Misleading metrics: loading skeletons should never display zero as a placeholder.


## Initialization, loading and stalled requests

The live session initialization and Auth subscription have a stable owner. Role
resolution does not restart bootstrap. Signout and identity changes clear old
scope data; token renewal preserves the identity while outstanding requests keep
the existing generation checks. A bootstrap outage shows a retryable identity
error instead of launching the legacy dataset fan-out.

Before authoritative identity, the layout renders neutral geometry. Tenant
labels, role actions and page content wait for the profile and legal-name gate.
Program metadata and usage have separate readiness. Settings requests enriched
usage when mounted and preserves valid counts during refresh. Dashboard loads
eligibility only for selected panels that consume it; Belt Tracker owns its read.
Students continues using the existing roster contract.

Navigation links expose pending feedback through Next's `useLinkStatus`. There is
no global Router Cache `staleTimes` override. Middleware retains `getUser()`;
changing document admission to `getClaims()` remains conditional on the hosted
revocation and refresh checks in the implementation plan. SSR refresh cookies
and cache-prevention headers are copied together on ordinary and redirect responses.

Browser API deadlines now cover headers and the complete JSON, error or download
body. The default remains 12 seconds; call-specific overrides and null deadlines
remain supported. Caller cancellation stays distinguishable from timeout. Proxy
responses keep streaming, with a 150-second upstream deadline and cancellation
when the caller or response consumer stops.

The interactive PostgREST transport uses a 10-second per-I/O timeout and the bulk
transport uses 30 seconds. Bootstrap’s five short-lived clients inherit their
parent client’s budget; the isolated Stripe authorization read has a 10-second
budget. These are not total multi-query deadlines. Existing
caller waits and worker/queue capacity remain unchanged at 30 seconds with 4+16
interactive slots and 120 seconds with 1+2 bulk slots. Capacity returns only when
provider work ends, even after a caller stops waiting. No automatic money retry
or rollback-on-abort assumption was added.

The lane emits bounded aggregate metrics at most once a minute while work is
active. Queue wait, operation duration, active work, saturation, caller timeout
and transport timeout remain distinct. Records carry no studio, user, query or
operation payload.

## Measurement environments

See [performance-measurement.md](performance-measurement.md) for the fixture
contract, fixed routes and functional capture command.

`capture-dashboard-performance.mjs` remains fail-closed and read-only from the
browser. Known Billing provider-refresh reads are blocked as well as write
methods. HTTP GET alone does not establish that server-side provider state is
unchanged. Auth/context reads can still resolve provider state according to
existing backend rules.

`frontend/scripts/capture-functional-performance.mjs` is a separate disposable
staging workflow. It permits only the expected token refresh and schedule
materialization writes, retains pinned origins and verifies the exact deployed
pair before and after capture. Both intercepted workflows explicitly report
that Playwright routing disables the HTTP cache. A normal-cache measurement
needs equivalent traffic restrictions outside Playwright routing; it cannot be
inferred from those runs.

Local preview browser measurements exercise rendering with synthetic data only.
They cannot validate live authorization, provider latency, billing correctness,
refresh-token endurance or hosted latency targets. The local SQL contract runner
is the database correctness and query-plan check. Deployment validation and the
30% median/1.5-second targets require a separately verified deployed candidate.
