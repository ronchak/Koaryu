# Local plan write ownership

PR175 addresses ACS1-02, BB2-02, BB2-03 and BT3-05. Plan creation and the supported Admin PATCH API now call one service-role-only database command. The plan, program associations and original staff audit commit together. Invalid programs or a failed link/audit insert leave the original state intact. The response carries the committed plan and program snapshot without another association read.

Omitted fields remain unchanged; explicit null is rejected for the seven required columns. Nullable text can still be cleared. Program omission retains associations, an empty list clears them, and a supplied set replaces them while preserving retained link IDs. An unchanged save preserves status, timestamps, links and audit count. A genuine provider-related change still marks a non-archived plan pending. Existing provider IDs, price history and synchronization ownership checks remain.

New local definitions and actual financial-definition changes require USD. Historical non-USD identical saves and nonfinancial maintenance remain valid. This does not close PROGRAM-CURRENCY-01: new provider financial commands and misleading mixed-currency totals still require correction. BB2-01 listing round trips and BB2-04 unused legacy provider synchronization also remain pending.

## Database and lock boundaries

Forward migration `20260910135133_local_plan_write_ownership_v44.sql` requires the exact V43 predecessor and the independently checked prior demo-clear definition. The existing generator produces full readiness V25 and the V24 compatibility wrapper. All 138 historical migrations are byte-identical to main `9b4df618165146ef1f59472aa56e5e9266c27bd0`. The new migration SHA256 is `415a81f7f858edcaafbf1c5dd51ec13e19f179298abe636fa8425347889d729b`.

Plan writes take a shared studio advisory lock before the studio KEY SHARE lock, plan row and ordered program SHARE locks. Guarded clear takes the matching exclusive advisory lock first. Clear does not take a broad studio UPDATE lock, which would invert existing student and provider writer locks. Later reset/reseed requests remain separate operations. The new guarantee requires old split-write callers to drain during a separately authorized rollout.

The actual V43 dump/restore continuation passed on canonical and restored disposable databases. The permanent proof records dump SHA256 `41653bba3c885f36cfe5dd8ef05f0b4a5b7c642d348a5801d35f89171226d646`, twelve exact constraint normalization pairs, six historical billing replays and twenty-two default-ACL representations. It verifies no migration backfill, current and legacy no-op behavior, new/old caller continuation and guarded clear. These synthetic local results are not production backup evidence.

## Verification and test accounting

- Full backend: 1,890 passed. Focused adapter/schema/readiness/target checks: 88 passed with 58 subtests.
- Frontend build and generated API contract checks passed.
- Attestation generator: eight groups passed; eighteen SQL statements, ten historical shell restore scripts and four generated continuations reproduce the declared outputs.
- Rollout tests: 66 passed. Candidate workflow controls: 128 passed.
- Complete local PostgreSQL verification passed all 139 migrations, 52 SQL contracts, historical and V44 restore continuation, corruption checks, fifteen billing concurrency cases and the retained concurrency suites. The owned cluster was stopped and removed after proof capture.

The two owning Python test files grow from 1,491 to 1,555 lines. They remove the old split-write happy-path simulation, a redundant insert-default assertion and unused audit fixture. Literal adapter results and a consolidated omission/null/value matrix replace that coverage. Existing provider projection, recovery and ownership test bodies remain unchanged. This is a measured increase of 64 lines, not a claimed test reduction. The new 287-line SQL contract and eleven added concurrency cases cover previously missing high-consequence persistence boundaries through real PostgreSQL rather than a copied Python algorithm. The existing four payer/payment cases remain in the renamed billing runner. No new process framework is introduced.

The concurrency proof includes disjoint edits, archive in both orders, program deletion in both orders, plan/clear in both orders, a retained student writer completing its audit, unrelated plan progress and a narrow provider projection comparison. The latter checks SQL comparison semantics; the existing Python tests cover the actual provider workflow. The parent-lock case proves lock ordering, not a complete studio-deletion workflow.

Initial verification caught a missing contract-inventory entry, stale V43 rollout fixture expectations and insufficient temporary-helper permissions in the new SQL fixture. Those were corrected without weakening production permissions or existing acceptance rules. The complete local run passed after those corrections. All eleven implementation-head CI checks passed, and the automated review completed with no findings. Final-head CI remains required after this tracking update.

A fresh independent Astra reviewer inspected the complete implementation at `671ed359e32e0c85dcc8075d6ce3e17935f6a59e` and found no actionable defect or material blocker. The reviewer did not repeat the full suite. No production migration, deployment, financial backfill or provider mutation occurred.
