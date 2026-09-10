# Batch 08: display and dead interfaces

IDs: `FT1-01`, `FT1-02`, `CTA2-02`, `FC1-11`, `FC1-12`, `FC1-13`, `FSH1-04`, `FSH1-08`, `FSH2-10`

Prerequisites: none. Sol may remove proven dead financial interfaces and change display-only contracts. Astra retains every money decision, provider fact, authorization gate, tenant boundary, idempotency rule, and command.

## Change

- Delete `frontend/e2e/atomic-belt-ladder.spec.ts`, remove `test:e2e:live-belt` from `frontend/package.json`, and retire its instructions in `frontend/README.md`. Point to existing `frontend/tests/belt-editor-mounted.test.mjs` for browser save behavior and existing local SQL contract checks for persistence. Do not claim joined browser-to-database coverage.
- Delete only `StaffRole` and `BillingActionRequest` from `frontend/src/types/index.ts` after a reference search. Keep generated aliases.
- Narrow `billingLabel` in `frontend/src/components/account-menu.tsx` to the status fields it reads. Narrow `BeltVisual` in `frontend/src/components/belt-tracker/rank-form-modal.tsx` and `frontend/src/components/belt-tracker/rank-visuals.tsx` to color and tip fields, or pass display-ready values. Preserve actual billing decisions and belt promotion logic.
- Remove the pure `frontend/src/components/billing/billing-invoices-section.tsx` wrapper and render `BillingInvoicesTab` from `frontend/src/components/billing/billing-tab-content.tsx`; reuse its explicit prop type in `frontend/src/components/billing/billing-page-content.tsx` only if it removes duplication. Keep callback ownership, capability props, loading, preview, and pagination.
- Remove the dead export-history panel and its `exportJobs` state/setter/disabled creation plumbing from `frontend/src/components/billing/billing-reports-tab.tsx`, `frontend/src/lib/billing-data-controller.ts`, and `frontend/src/lib/billing-report-actions.ts`. Do not use the Reports catalog as replacement data.
- Add an explicit date-only formatter in `frontend/src/lib/billing-page-utils.ts` or reuse the date-only owner in `frontend/src/lib/billing-period.ts`. Use it for calendar fields in `frontend/src/components/billing/billing-enrollments-tab.tsx` and `frontend/src/components/billing/billing-invoices-tab.tsx`; keep timestamp formatting separate.
- Remove unconsumed analytics from `frontend/src/lib/dashboard-page-controller.ts`, `frontend/src/lib/dashboard-page-composition.ts`, and `frontend/src/lib/dashboard-widget-view-models.ts`, including exclusive types and dependencies. Keep preview, consumed widgets, partial loading, and billing visibility.
- Remove unused lead drag state/handlers and public belt setters through `frontend/src/lib/leads-page-controller.ts`, `frontend/src/lib/store-belt-actions.ts`, and `frontend/src/lib/store-contexts.ts`. Keep `useStore`, active internal setters, `setBeltRanks`, idempotency, recovery, and keyboard behavior.

## Verify and deliver

```sh
rg -n "atomic-belt-ladder|test:e2e:live-belt|StaffRole|BillingActionRequest|exportJobs|minimumRole|setBelt|drag" frontend
(cd frontend && node --experimental-strip-types --test tests/belt-editor-mounted.test.mjs tests/account-menu-state.test.mjs tests/billing-period.test.mjs tests/billing-report-actions.test.mjs tests/dashboard-widget-composition.test.mjs tests/dashboard-widget-view-models.test.mjs tests/leads-page-model.test.mjs tests/belt-store-model.test.mjs)
(cd frontend && npm run lint -- src/types/index.ts src/components/account-menu.tsx src/components/belt-tracker src/components/billing src/lib/billing-data-controller.ts src/lib/billing-report-actions.ts src/lib/dashboard-page-controller.ts src/lib/dashboard-page-composition.ts src/lib/dashboard-widget-view-models.ts src/lib/leads-page-controller.ts src/lib/store-belt-actions.ts src/lib/store-contexts.ts)
```

Record before/after lines and tests. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root integrate. Require the exact-head `Release candidate gate` and `scripts/merge-release-pr.sh`.
