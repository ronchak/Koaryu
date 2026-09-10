# Batch 10: schedule rendering and operations tests

IDs: `FC2-01`, `FC2-06`, `FC2-17`, `FT2-02`, `FT2-03`

Prerequisites: none for these Sol changes. Do not absorb Astra-owned schedule mutation, tenant, or business-date work beyond passing the existing `businessDate` into display components.

## Change

- In `frontend/src/components/schedule/schedule-page-section.tsx`, use the existing per-date entry builder from `frontend/src/lib/schedule-calendar.ts` for month, week, and day. Base day empty state on those entries. Preserve placeholder/session distinction, template applicability, program filtering, and attendance records.
- Pass the controller's existing `businessDate` from `frontend/src/lib/schedule-page-controller.ts` into the section. Use it for every Today comparison and the month-view date. Do not change session wall-clock times, range loading, or mutation commands.
- Memoize layouts by date from `entriesByDate` and reuse them for width, screen, and print. Keep overlap lanes, minimum widths, print order, and target sizes.
- In `frontend/tests/operations-redesign-contract.test.mjs`, delete copied hit-testing and routing algorithms. Mount the actual schedule handler and observe `onOpenSession`. Reuse existing overlap scenarios. Render the actual program/calendar form and observe its submitted payload through mocked existing store actions. Do not move copied test hit-testing into production and do not add a parallel form model.

## Verify and deliver

```sh
(cd frontend && node --experimental-strip-types --test tests/operations-redesign-contract.test.mjs tests/date.test.mjs)
(cd frontend && npm run lint -- src/components/schedule/schedule-page-section.tsx src/lib/schedule-calendar.ts src/lib/schedule-page-controller.ts tests/operations-redesign-contract.test.mjs)
```

Cover generated and missing recurring occurrences in all views, placeholders-only and no-entry dates, browser/studio date disagreement, adjacent days, enlarged short-session targets, overlaps, keyboard activation, 390px form containment, selected-color payload, screen/print geometry, and both themes. Record before/after lines and test cases. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root integrate. Require the exact-head `Release candidate gate` and guarded merge.
