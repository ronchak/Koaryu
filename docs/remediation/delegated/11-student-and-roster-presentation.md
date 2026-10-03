# Batch 11: student and roster presentation

IDs: `FC1-02`, `FC2-05`, `FC2-07`, `FC2-14`, `FC3-02`, `FC3-03`, `FC3-05`, `FC3-08`

Prerequisites: `FC3-08` waits for Astra's `FC3-01` bulk-roster owner. Hold only that interface-consolidation chunk. `FC2-14` mirrors the already-verified backend header rule in preview only; backend parsing remains unchanged. Do not change live import writes or tenant scope.

## Change

- In `frontend/src/components/belt-tracker/eligibility-panel.tsx`, render unavailable before successful-empty and expose Retry through the existing forced eligibility read. Dismissal must not certify emptiness.
- In `frontend/src/components/schedule/session-detail-modal.tsx` and `frontend/src/components/students/student-detail-sidebar.tsx`, gate empty claims and derived metrics on existing readiness/error inputs. Keep retained data visible during refresh where current state supports it.
- Calculate displayed age in `frontend/src/components/students/student-detail-sidebar.tsx` with calendar year/month/day comparison against an explicitly supplied `businessDate`. Do not add guardian, timezone, minor-status, billing, or program-date behavior.
- In `frontend/src/components/students/student-import-mapping-step.tsx`, use a component-instance prefix plus column index for control IDs. In `frontend/src/lib/student-import-page-model.ts`, reject normalized duplicate headers in preview parsing, matching the existing read-only rule in `backend/app/services/student_import_csv.py` and `backend/app/services/student_import_headers.py`. Preserve mapping payload keys and live import rules.
- Add a labeled mobile sort selector to `frontend/src/components/students/student-roster-controls.tsx` and `frontend/src/components/students/student-roster-sections.tsx`, with styles in `frontend/src/components/students/student-records.module.css`. Use the existing sort key and direction controller.
- Share one luminance-aware color treatment between `frontend/src/components/students/student-rank-badge.tsx` and `frontend/src/components/belt-tracker/rank-visuals.tsx`; use `frontend/src/lib/mock-data.ts` only as an input caller. Preserve rank and promotion semantics.
- Avoid quick-view state updates while the rail is hidden. Keep hover ownership near the rail in `frontend/src/components/students/student-roster-page-content.tsx` and `frontend/src/components/students/student-roster-sections.tsx`; preserve focus, selection, and row opening. Use the existing breakpoint.
- After `FC3-01`, reuse existing pagination/forwarding types across the three roster components only where declarations are truly identical. No context, parallel roster model, new component layer, or monolith.

## Verify and deliver

```sh
(cd frontend && node --experimental-strip-types --test tests/preview-belt-eligibility.test.mjs tests/csv-import-mapping.test.mjs tests/csv-import.test.mjs tests/records-workspace-contract.test.mjs tests/belt-tracker-page-model.test.mjs)
(cd frontend && npm run lint -- src/components/belt-tracker/eligibility-panel.tsx src/components/schedule/session-detail-modal.tsx src/components/students src/components/belt-tracker/rank-visuals.tsx)
```

Cover loading, failure, dismissed failure, successful empty, retained refresh, and populated states; birthday eve/day, `2008-09-07`, leap day, and absent DOB; colliding headers and two mounted component instances; mobile sorts at 820px; rank colors white, yellow, black, malformed, three-digit, and tip; narrow and wide hover/keyboard behavior. Record before/after lines and cases. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root integrate. Require the exact-head gate and guarded merge.
