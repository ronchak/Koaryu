# Batch 14: retire unused frontend interfaces

Finding IDs: FT1-01, FT1-02, CTA2-02, FC1-11, FC1-12, FC1-13.
Revalidated base: main `bb7a0ae57e6d9947b5ed73fc2147d2cdc1211331`, after PR195. The saved draft was rebased onto the pinned formatter baseline.
Branch/worktree: `codex/remediation-dead-ui-interfaces`, `/Users/openclaw/Projects/Koaryu-Worktrees/remediation-dead-ui-interfaces`.

This is the six-finding execution subset of batch08. Root and Sol both verified the current callers. Do not include its calendar-date, dashboard-analytics or store/lead-state tasks. Root owns the ledger, integration, review and merge. Sol owns the frontend edits below.

## Recipe

1. Delete `frontend/e2e/atomic-belt-ladder.spec.ts`. It expects obsolete onboarding/navigation/editor controls and never edits a persisted rank. Remove only `test:e2e:live-belt` from `frontend/package.json`. Replace its section in `frontend/README.md` with the existing mounted editor check and `npm run check:supabase-contracts-local` as separate browser-payload and database-persistence proofs. Never claim joined end-to-end coverage. Do not run the retired live spec.
2. Delete only the unused `StaffRole` interface and `BillingActionRequest` intersection in `frontend/src/types/index.ts`. Keep `StaffRoleName`, every specific request alias, `ExportJob`, and generated contracts. Confirm exact identifier references before deletion.
3. In `frontend/src/components/account-menu.tsx`, narrow `billingLabel` to `Pick<PlatformBillingStatus, "status" | "comped"> | null`. Its preview object needs only those two fields. In `frontend/src/components/belt-tracker/rank-visuals.tsx`, narrow `BeltVisual.rank` to the three fields `color_hex`, `is_tip`, `tip_color_hex`. Remove the fabricated identity/order/date fields from its preview in `rank-form-modal.tsx`. Preserve all display conditions, colors, copy and active form/save logic.
4. Delete `frontend/src/components/billing/billing-invoices-section.tsx`. Its sole caller in `billing-tab-content.tsx` should render `BillingInvoicesTab` directly, preserving all eight current props verbatim: invoices, payers, reconciliation permission, workflow capability predicate, aggregate loading, per-action loading, preview flag and invoice-action callback. Keep their existing prop names. `billing-page-content.tsx` owns framing/pagination and needs no new abstraction or prop refactor.
5. Remove only the never-populated billing export-history section from `billing-reports-tab.tsx`, then its dead plumbing through `billing-tab-content.tsx`, `billing-page-controller.ts`, `billing-action-controller.ts`, `billing-data-controller.ts`, and `billing-report-actions.ts`. Remove `exportJobs`, `setExportJobs`, unused `handleCreateExport`/`onCreateExport`, and exclusively unused imports. The state is initialized empty, only cleared, and never loaded. Preserve UTC cohort metrics, real report downloads, all loaders/pagination and the complete external-payment workflow/storage/identity/notice behavior. Do not modify `reports-data-exports-panel.tsx` or substitute Reports catalog data.

## Tests and checks

- In `frontend/tests/e2e-safety.test.mjs`, remove the obsolete live-belt file load, its safety case and its README assertion. Retain the unrelated Core UI loopback guard.
- Remove only the stale deleted-export-message assertion in `frontend/tests/operations-redesign-contract.test.mjs`; preserve the surrounding capability, callback and admin-reset checks.
- Remove the `exportJobs: []` fixture prop from `frontend/tests/billing-data-mounted.test.mjs` and any other now-invalid billing-only fixture plumbing. Do not alter the real Reports export catalog fixtures or authorization.
- Assess wrapper-specific assertions in `billing-invoice-action-model.test.mjs`. Remove redundant implementation-wording checks when existing mounted behavior proves the same contract; otherwise retain the permission/callback assurance with the smallest behavioral check. Do not merely replace one component-name grep with another.
- Keep mounted repeat-save rank IDs, SQL in-place rank updates, invoice idempotency, payment recovery and authorization coverage. Add no test merely for deleting a dead type.

Run existing files only:

```sh
cd frontend
node --experimental-strip-types --test tests/e2e-safety.test.mjs tests/account-menu-state.test.mjs tests/belt-editor-mounted.test.mjs tests/belt-ladder-sync-operation.test.mjs tests/belt-store-model.test.mjs tests/billing-invoice-action-model.test.mjs tests/billing-idempotency-lifecycle.test.mjs tests/billing-data-mounted.test.mjs tests/reports-export-catalog-contract.test.mjs
npm run lint -- <changed-source-paths>
npm run build
```

The old batch08 command named nonexistent `billing-report-actions.test.mjs`; do not use it. If CLI sandboxing prevents Chromium from starting, record that exact failure and let root run the mounted check. Do not weaken tests or request broader permissions. Existing dependencies may be reused; no installs or lockfile changes are needed for script removal.

## Do not touch

Backend, Supabase, generated API types, provider/release settings, money rules, dates, authorization/tenant gates, idempotency, persistence or callback ownership. No new dependencies, UI framework, replacement feature, production access or deployment. Leave root-owned `REMEDIATION.md` and `docs/remediation/ledger.json` alone. Do not commit, push or open a PR; root will integrate the completed diff with a fresh independent reviewer and exact-head CI.

Deliver a concise file/change list, checks with actual outcomes, caller evidence, and test additions/deletions with honest line and byte accounting. Preserve unrelated changes.
