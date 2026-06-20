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

## Production Smoke

After Render and Vercel deploy the same commit:

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
