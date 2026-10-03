# External-payment recovery verification

PR172 addresses FSH1-05, FT1-04, BB1-05 and BT3-02 together. The browser retains the exact pending payload, including its normalized note, and request key under the signed-in staff member and studio. The existing report hook owns its draft, pending operation, confirmation and refresh. Token renewal keeps ownership; identity changes and stale completions cannot retire or release a new owner's work.

V43 adds one service-role-only payer-payment RPC. It commits a new payment and its original-actor audit in one transaction, uses existing studio/key uniqueness and request hashing, and returns the original row on matching replay. Balance completion uses the existing repeatable V41 RPC after that transaction. New non-USD external payments are rejected; confirmed historical non-USD replay returns unchanged records without inventing an audit. PROGRAM-CURRENCY-01 remains pending for tuition and truthful aggregates.

The HTTP invoice-target rejection remains. Repository callers and private operator entrypoints had no use of the removed Python invoice-recording branch. Its exclusive unit simulations and copied invoice-total algorithm are removed; historical invoice, tenant and overpayment SQL checks remain. The request hash uses the existing canonical helper, with a literal legacy hash checked for Unicode and an apostrophe.

## Verification

- Full backend on the combined PR171/V43 tree: 1,879 tests passed. The earlier pre-rebase run passed 1,889; PR171 removed ten obsolete tests.
- Full frontend: 915 tests passed. The production build passed, including TypeScript and static page generation.
- Focused mounted/form/workflow coverage: 27 cases passed. Six mounted cases exercise the actual page controller, report hook, form, action claims and billing loader with synthetic browser storage and transport. They cover loss and remount, immutable retry payload, invalid drafts before capture, storage failures, mismatched confirmation, failed retirement, refresh failure, session lifetime and capability gates. This is browser-to-transport proof, not a live API integration test.
- Rollout classification: 66 cases passed. The shared one-function catalog query retains byte-identical V41 output, with explicit new V43 facts. Generator checks and eight generator test groups passed. Ten historical restore scripts retain committed bytes and modes; historical migrations remain immutable.
- Full disposable PostgreSQL verification passed all 138 migrations, 51 contracts, historical restore checks, deliberate catalog/privilege drift cases and concurrency checks. The first full run exposed three legacy contract branches that recognized V42 but not exact V43. They now include only the exact 138/head20260910093958 pair while retaining the V42 semantic expectations; no hash check was weakened.

## Test reduction and limits

The five touched frontend test paths grow from 1,042 to 1,249 lines and 25 to 27 top-level cases. Six behavioral cases replace four forwarding, key-format, normalization and source-wiring cases. Fourteen existing mounted cases remain byte-identical, including refund coverage. The deleted capability source-check file is now covered by actual front-desk request traces. Other billing source checks remain owned by their future workflow changes.

Backend payment/lifecycle tests lose 384 lines and eight test cases, including the unused invoice branch's simulations. The local-target guard adds one line for the new generated restore script. Across changed application tests the net reduction is 176 lines. Required SQL rollback, tenant, replay and concurrency proof plus generated restore continuation are additional assurance, not copies of the production algorithm.

LocalStorage is not a cross-tab lock. Distinct independently initiated keys are not deduplicated by business similarity. Database-first rollout preserves older backend readiness, but atomic audit guarantees require all callers to use the new RPC and old split operations to drain. A browser rollback must retain pending-request recovery or block new recording until saved attempts are confirmed. No production migration, deployment, provider charge or historical backfill is part of this PR.

## Candidate and restore evidence

The implementation is `0abd5b57e7edbc81602921bf5d8023717d4d988d`, rebased onto PR171 main `cb897e2d35a8a75c71c5c1fec1a0b3907eb0ba1e`. The sole conflict was the lifecycle test import cleanup; the merged file keeps the direct owner imports and removes the obsolete external-payment test/import. All 25 changed database/release proof inputs remain byte-identical after rebase. The full backend suite passed on this combined tree.

The actual synthetic V42 dump SHA256 is `993cff995ab8fc2a92d6e4e193a823a1801cee1cdd303c63760fb096c297f0f3`. Canonical and restored V43 checks passed with 138 migration hashes, 12 exact constraint-normalization pairs, six billing-repair replays and 22 default-ACL representations. All ten declared semantic manifests remain unchanged. Independent current raw facts also match. The four payer/payment concurrency cases cover commit, rollback, invoice-to-payer ordering and same-key original-actor audit ownership. Private evidence is retained outside the repository.

A fresh Astra reviewer assessed only the implementation diff and its plan at `1f048cb32c6ff4bf4231d2d194e69c5140f4283e` and found no material defect. Rebased/final-head review and exact-head CI remain merge gates; this record does not treat an earlier head's checks as approval of a later one. No production operation was performed.

The pre-merge review then identified stale success feedback after a new invalid draft. Commit `09e1674b168c0d94fc5a4f35653e22bb153c0de5` clears that earlier success only on the invalid-draft path; valid submits already clear feedback when they claim the action. The existing mounted loss/retry case now continues through confirmed success into a new invalid draft, requiring no success banner, no extra POST and no saved attempt. It failed before the one-line correction and all 27 targeted cases passed afterward, with ESLint green. No new test case or database input was added. The earlier exact-head CI passed at `e87d36e`, after one unchanged backend rerun for the existing instrumented export benchmark deadline; the corrected head requires fresh CI and review before merge.
