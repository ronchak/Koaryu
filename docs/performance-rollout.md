# Koaryu Rendering Performance Rollout

This runbook covers the v0.1.1 rendering and roster-performance changes. It is intentionally conservative: FastAPI remains the authorization wall, authenticated CRM data remains uncached, and every rollback switch favors correctness over speed.

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

The canonical local gate measures the real `dashboard-summary` service against
the synthetic fixture, not a browser or a hosted database. It runs the three
fixed profiles in `performance/dashboard-summary-budget.json`: `small` (25
students), `medium` (250 students), and `large` (2,500 students). Each profile
uses the same fixed request, route, role, and supporting table cardinalities.

The versioned budget manifest is the owner of the profile ceilings and metric
semantics. Its `dashboard-summary-performance-v1` manifest version and
`dashboard-summary-fixture-v1` fixture revision must remain bound to emitted
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
checked-out SHA differs from `--expected-sha`, a profile or route is missing,
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
is elapsed time until the dashboard shell/layout marker appears after identity
and persisted layout resolution; it does not prove that the owner data is present.
`dashboard_ready_ms` is elapsed time until the true-data marker appears after
layout resolution and the controller's complete required-dataset aggregate is
ready: students, programs, leads, schedule, dashboard summary, and
selected-ladder belt eligibility. Preview semantics remain owned by the same
resolver. Treat the latter as the true-data readiness measure. The optional
network-idle wait happens afterward and is excluded from both metrics.
Separately, evidence validation requires successful `/dashboard/bootstrap` and
`/dashboard/summary` responses, resource timings, and at least one allowlisted
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
validation requires successful 2xx `/dashboard/bootstrap` and
`/dashboard/summary` responses, resource timings, and allowlisted
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
- Derived Students views still use the full roster because inactivity and new-student filters depend on schedule/attendance-derived accuracy.
- Dashboard summary is fail-soft in bootstrap. If it fails, the route should still load and later client data can fill in.
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
