# Import retry ownership verification

PR178 merged as `f942dad3509a2e2cc9b55d546c2d22e097f77abe`. OPS2-04/05/06/07 and BT5-02 are fixed. PROGRAM-IMPORT-01 remains a separate unanswered policy for a program-specific belt supplied without Program; the current refusal happens before student or membership writes and does not block the bounded retry correction.

The branch is based on main `7113d130a1523d5048cb9cb15529aed6277a4770`, after PR179. All eight import commits rebased without a patch change. Every Supabase and verifier input still matches the completed proof at `448b6e5e7fed45164bd0bbb32aaaf9a32eead869`. All eleven checks passed at final head `c762a480b0e8f7c198b678c0dfcfb5da04075995`. The dedicated reviewer approved that exact head; the guarded merge read production Render auto-deploy off twice.

## Result

Retries preload committed row and setup receipts, preserve subsequent staff edits/deletion, and write only unfinished rows. Existing program and rank selections are bound by identity, so a rename cannot create replacements. Unscoped ladders keep their ownership. Unknown execution failures retain the request identity; genuine invalid input remains a skipped row. Final audit warnings are stored with the completed result before the token is cleared.

Program facts load once. Setup includes only valid unfinished rows. The obsolete studio-wide ladder repair and its unused helpers are removed; ordinary single-program creation and renaming remain.

Completed legacy caches remain readable. New/incomplete work from retired callers, unreceipted row writes and legacy completion are refused. No historical result is inferred or backfilled. A separately authorized rollout must stop old import callers before the database/backend transition. Application rollback alone does not restore legacy writes.

## Evidence

- The complete local PostgreSQL 17 suite passed all 140 migrations, all 52 contracts, retained restore checks, negative checks and concurrency checks at `448b6e5`. All frozen inputs stayed unchanged and the cluster was removed.
- V44-to-V45 continuation passed on canonical and real logical-restored copies. Legacy students, guardians, independent program dates, historical EUR plan data and completed caches remain intact. Incomplete unreceipted work is refused.
- All 15 student-writer concurrency cases passed: five retained rank cases, clear/import and Auth deletion/import in both orders, first-rank setup against the rank-plan student lock, existing-rank selection against the real rank-plan writer in both orders, and row/program/belt commit-progress renewal. Auth deletion here is actual SQL cascades, not a GoTrue API test.
- Canonical/restored attestation preserves separate raw constraint fingerprints. New function contracts and receipt schema agree. The rank manifest has zero invalid entries. Only the guarded V31 operational-contract expectation changes; no nonzero manifest is accepted as a baseline.
- The combined backend after rebase passed 1,904 tests and 5,471 subtests. API types and historical attestation reproduction passed again. All ten historical restore scripts remain byte-identical.
- The two affected frontend files passed 40 tests. A negative control removed the live eligibility invalidation callback, caused the new mounted case to fail, and restored the runtime bytes.
- Release-tool tests passed all 66 cases. The dedicated fresh PR178 reviewer approved the implementation and subsequent corrections through `448b6e5`; exact-head CI was green there. Range-diff verifies the unchanged import patch after rebase.

The first reviewer found a missing existing-program binding. Root reproduced it and then found the equivalent existing-rank gap. Both were corrected and reviewed. Earlier full runs stopped before the contract loop and are not full-pass evidence. A stale V13 self-body expectation was also corrected: V45 now requires both internal readiness and the external catalog to reject that tampering. The final complete run passed those checks.

## Test maintenance and limits

The change removes the copied claim state machine, private setup-loop tests, retired-method traps, three frontend source assertions and duplicated operational release matrices. Payment business and authorization blocks remain byte-identical. Authored tests/local verifiers shrink by 159 lines; generated restore files grow by 265, for a combined increase of 106 lines. Generated output is not counted as reduced test volume.

The separate CSV policy decision remains open. No production migration, deployment, financial backfill, provider change, mail or DNS work occurred. Private logs, failed probes and final captures remain under `~/Koaryu Remediation/2026-09-07/import-ownership`, including `full-v13-result.json` and `rebase-currency-proof.json`.
