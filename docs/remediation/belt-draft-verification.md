# Belt draft ownership verification

Base: `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`.

The new mounted test reproduced the original defect before the source change. Open empty program A, switch to populated B, edit B's sub-rank term and save. The actual controller/store request targeted B but submitted an empty rank array. The assertion expected B's two existing rank IDs and failed with `actual: []`.

The repair binds ranks, term and ladder ID in one draft. The store validates that target before any asynchronous work. Native controls and the controller guard prevent editing during a save. Add Belt offers only a full belt; Add Tip remains the sub-rank action. Existing durable operation receipts and committed-save warnings remain in place.

## Evidence

- Baseline: `cd frontend && node --experimental-strip-types --test tests/belt-tracker-page-model.test.mjs tests/belt-ladder-sync-operation.test.mjs tests/belt-store-model.test.mjs`, 25 passed.
- Regression before fix: `cd frontend && node --experimental-strip-types --test --test-name-pattern='production' tests/belt-editor-mounted.test.mjs`, failed on the empty rank payload described above.
- Focused after fix: `cd frontend && node --experimental-strip-types --test tests/belt-editor-mounted.test.mjs tests/belt-tracker-page-model.test.mjs tests/belt-ladder-sync-operation.test.mjs tests/belt-store-model.test.mjs tests/records-workspace-contract.test.mjs`, 42 passed.
- Full frontend: `cd frontend && npm test`, 917 passed, no failures or skips.
- Added review case: `cd frontend && node --experimental-strip-types --test --test-name-pattern='pending rank save' tests/belt-editor-mounted.test.mjs`, passed after adding held-save sign-out to the existing renewal scenario.
- Targeted lint on the six changed source files passed; `cd frontend && npm run lint` also passed.
- Production build passed using the same checked-in example environment as CI: `cd frontend`, `set -a`, `source .env.example`, `set +a`, then `npm run build`.
- Independent reviewer inspected the actual diff, new tests, receipt and identity contracts, and full test log. Source review received `GREEN LIGHT`.

The fixture mounts the real page, controller, store actions, picker, rank panel and dialogs in Chromium, including production React and development Strict Mode. Auth and network responses are synthetic; CSS, decorative icons, the unrelated header and eligibility presentation are stubbed. It proves request identity and edit behavior, not hosted persistence or visual layout. All browser network traffic is intercepted locally. No hosted or database mutation was performed.

The cases cover both contamination directions, repeated saves preserving rank IDs, delayed-save control locks and a queued drop, confirmed settlement through token renewal, sign-out rejecting old private state, rejected saves retaining drafts, committed refresh failures suppressing another Save, and stale-target rejection before transport.

## Test assessment and audit scope

FSH1-01, FSH1-02 and FC1-01 are directly addressed. Only the belt-save portion of FSH2-02 is addressed; program, staff and promotion paths remain pending. FT1-01 and FT1-02 remain pending because the obsolete opt-in hosted test itself has not been repaired. This mounted test adds the missing behavior proof without treating that older test as valid evidence.

The 25 existing pure rank and receipt cases protect distinct transformations, request serialization and recovery storage, so they remain. No test was added merely for the type change or fieldset markup. Existing source-composition checks are not used as proof of save ownership. Broader test-harness cleanup and the old hosted test are separate work; this PR adds one real-editor mode to the existing bundler instead of creating another bundler.

No API or database schema changes are required. The frontend change is compatible with the current V38 backend. Reverting the application change restores the previous editor behavior and its known defect; no data rollback is required. Production deployment is separate from merging this PR.
