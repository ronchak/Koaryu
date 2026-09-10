# Batch 07: frontend test fixtures and claims

IDs: `FT1-07`, `FT1-09`, `FT1-11`, `FT1-12`, `FT2-07`, `FT2-08`, `FT2-10`

Prerequisites: fresh Astra review is required before changing mixed billing, auth, workflow, mutation, or identity tests. Sol may edit only the low-risk fixture and presentation portions named here. The source-test inventory is advisory. Do not create production exports, fixtures, profilers, fingerprints, or mounted tests merely to replace greps.

## Change

- Consolidate duplicated existing module-packing code used by `frontend/tests/billing-data-mounted.test.mjs` and `frontend/tests/billing-enrollment-transition-model.test.mjs` into `frontend/tests/helpers/store-browser-harness.mjs`. Keep each suite's stubs and assertions local. Remove unused switches.
- In `frontend/e2e/preview-smoke.spec.ts` and `frontend/e2e/performance-navigation.spec.ts`, keep headings as shell smoke. Rename heading-only settlement claims to shell readiness. Preserve existing meaningful dataset-readiness checks; no new hosted execution is needed for that correction.
- When their owning subsystem changes, remove incidental source names, counts, JSX shape, exact copy, and statement order from `frontend/tests/dashboard-shell-home-contract.test.mjs`, `frontend/tests/appearance-navigation-contract.test.mjs`, `frontend/tests/legal-name-ui-contract.test.mjs`, `frontend/tests/operations-redesign-contract.test.mjs`, `frontend/tests/settings-access.test.mjs`, and `frontend/tests/reports-export-catalog-contract.test.mjs`. Preserve authorization, identity gates, lifecycle, mutation, role ordering, and forbidden-dependency checks. Do not attempt wholesale conversion in this batch.
- Reuse one small map-backed storage fake with explicit failure modes across `frontend/tests/billing-idempotency-lifecycle.test.mjs`, `frontend/tests/billing-invoice-action-model.test.mjs`, `frontend/tests/billing-payer-setup-model.test.mjs`, and `frontend/tests/billing-plan-sync-model.test.mjs`. Change no key lifecycle, scope, or serialized value.
- Remove `channel: "chrome"` from launches in `frontend/tests/operations-redesign-contract.test.mjs` unless a real Chrome-only difference exists. Do not add a new browser dependency.
- In `frontend/tests/workflow-stabilization-mounted.test.mjs`, `frontend/tests/store-initialization-mounted.test.mjs`, and `frontend/tests/helpers/store-browser-harness.mjs`, use small generated-contract-correct summary and guardian payloads. Keep ownership markers outside API payloads. Preserve every concurrency and identity assertion.

## Verify and deliver

```sh
(cd frontend && node --experimental-strip-types --test tests/billing-data-mounted.test.mjs tests/billing-enrollment-transition-model.test.mjs tests/billing-idempotency-lifecycle.test.mjs tests/billing-invoice-action-model.test.mjs tests/billing-payer-setup-model.test.mjs tests/billing-plan-sync-model.test.mjs tests/workflow-stabilization-mounted.test.mjs tests/store-initialization-mounted.test.mjs tests/operations-redesign-contract.test.mjs tests/settings-access.test.mjs tests/reports-export-catalog-contract.test.mjs)
(cd frontend && npx playwright test e2e/preview-smoke.spec.ts e2e/performance-navigation.spec.ts --list)
npm run check:api-types
```

The Playwright --list command checks discovery only; do not report it as browser execution. Use the repository's installed Playwright Chromium for mounted tests. Do not run live/stateful e2e against an ambient URL. Record before/after lines and every removed or retained test case. Start a short `codex/` branch from current `main`, use a fresh reviewer, and let root integrate. Require the exact-head `Release candidate gate` and guarded merge through `scripts/merge-release-pr.sh`.
