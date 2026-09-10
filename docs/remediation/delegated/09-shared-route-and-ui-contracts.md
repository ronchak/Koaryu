# Batch 09: shared route and UI contracts

IDs: `FR1-12`, `FR1-14`, `FC2-15`, `FC2-16`, `FC3-06`, `FC3-07`

Prerequisites: none. Keep auth, report authorization, schedule behavior, and navigation unchanged.

## Change

- Extract only the identical role-label formatter used by `frontend/src/app/(dashboard)/layout.tsx`, `frontend/src/app/account-archived/page.tsx`, `frontend/src/app/(dashboard)/account/settings/page.tsx`, and `frontend/src/app/(dashboard)/account/page.tsx`. No sign-out consolidation and no role directory or API.
- Extract one shared 404 view for `frontend/src/app/not-found.tsx` and `frontend/src/app/(errors)/404/page.tsx`. Extract one narrow legal-document renderer for `frontend/src/app/privacy/page.tsx` and `frontend/src/app/terms/page.tsx`. Keep route files, metadata, page content, labels, notices, and actions.
- In `frontend/src/components/reports/reports-data-exports-panel.tsx`, remove unused `ExportReport.minimumRole`. Reuse `PanelHeader` and `StatBadge` from `frontend/src/components/reports/reports-page-sections.tsx`. Keep `frontend/src/lib/report-metrics.ts` and backend authorization as the role authorities.
- Remove the no-op overflow prop and redundant class from `frontend/src/components/operations/operations-surface.tsx` and `.module.css`, plus schedule callers. Preserve horizontal schedule containment and vertical overflow.
- In `frontend/src/components/ui/button.tsx`, either forward the currently advertised common DOM attributes and ref through `asChild`, composing child and wrapper click handlers, or narrow the contract to what callers use. Preserve disabled-link prevention, variants, sizing, and navigation. Do not add Slot or a polymorphic framework.
- In `frontend/src/components/theme-provider.tsx`, let the media listener read the in-memory preference through an effect dependency or synchronized ref. Storage remains persistence and cross-tab transport, not runtime truth.

## Verify and deliver

```sh
(cd frontend && node --experimental-strip-types --test tests/account-menu-state.test.mjs tests/public-navigation.test.mjs tests/marketing-public-route-contract.test.mjs tests/reports-export-catalog-contract.test.mjs tests/report-metrics.test.mjs tests/operations-redesign-contract.test.mjs tests/appearance-navigation-contract.test.mjs)
(cd frontend && npm run lint -- 'src/app/(dashboard)/layout.tsx' src/app/account-archived/page.tsx 'src/app/(dashboard)/account/settings/page.tsx' 'src/app/(dashboard)/account/page.tsx' src/app/not-found.tsx 'src/app/(errors)/404/page.tsx' src/app/privacy/page.tsx src/app/terms/page.tsx src/components/reports src/components/operations src/components/ui/button.tsx src/components/theme-provider.tsx)
```

Add the smallest focused mounted checks only if existing suites do not cover `Button asChild` handlers/ref or storage-throwing System theme changes. Test role labels for admin, front desk, instructor, unknown, and null. Record before/after lines and cases. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root integrate. Require the exact-head `Release candidate gate` and guarded merge.
