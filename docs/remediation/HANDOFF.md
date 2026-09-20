# Koaryu handoff, September 20, 2026

## Current state

This bounded run is complete; the wider remediation program remains open. Production and staging databases are V49: 144 migrations, head `20260920052705`, manifest `release-db-attestation-v49`. Both frontend/backend pairs serve `591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5`. Production readiness, frontend proxy, production environment and Vercel `pdx1` all passed. Both web services are active; staging billing cron remains suspended and production billing scheduler remains disabled. Production auto-deploy stays off.

Current code main is `c1e1c27c4a3071556958352207da2a435887276b`, PR220 merge, with a tree identical to the deployed head. Its exact-head CI `35494772358` passed, as did candidate CI `35494455293`. This documentation closeout advances main without redeploying; obtain its final merge SHA from Git and the run's final report. Do not confuse that documentation SHA with the immutable deployed candidate.

PR216 closed V47 bookkeeping. PR217 corrected seven obsolete service paths; ten other matching references were valid test paths. PR218 patched AnyIO to 4.14.2. PR219 fixed activation retry quantity ownership, including first-attempt concurrency, independent post-write count checks and the next cancellation. PR220 fixed invented subscription terms and the overlapping-event null-fill race. [Release verification](production-release-verification.md) records exact tests, deployment IDs and timestamps.

## Verification and recovery

- All 1,913 backend tests and the final frontend/security/API-contract checks passed. The full local gate passed 144 migrations, 54 contracts, restore continuations, tamper checks and concurrency proofs. All 54 hosted staging contracts passed.
- Each production migration had a separate 30-second announcement, one-file invocation, successor check and row comparison. All 2,684 original rows across 69 tables remained unchanged after each apply. This covers public/private customer tables plus Auth users and Storage metadata, excluding release-attestation expectation tables and provider session/operational tables.
- Fresh pre-V48 backup: `/Users/openclaw/Koaryu Backups/production-20260920T071743Z`. Disposable restore verified at `2026-09-20T07:18:45.637373+00:00`; all 16 comparisons, source V47 readiness and temporary role/container cleanup passed. Image `17.6.1.155`, digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`.
- The reviewed private helper mapping is installed through V49. No post-V49 backup has been taken. Recheck actual count/head/image before a future backup; current V49 would use count 144 and head `20260920052705`, not the historical V38 or V47 commands.
- There is no approved down-migration or automated hosted restore. Once version-2 receipts or null subscription terms are written, an older backend is not an approved rollback. Use a reviewed forward correction or an owner-directed recovery from the verified snapshot, accepting loss of later writes. The helper restores only disposable containers. See [the completed packet](PRODUCTION-RELEASE.md).

## Budget and scope left out

The current allocation was 40 additional weekly percentage points from a 5%-used baseline. At `2026-09-20T07:41:06Z`, the meter was 17% used: 12 points spent, 28 remaining in this allocation. The final report gives the last reading after closeout. The old 51% baseline and 45-point cap belong to a previous weekly window and must not be reused.

Production contained only USD in seven invoices, five payments and five plans. The owner's rule therefore left mixed-currency totals and decimal formatting deferred; only invented subscription facts were fixed. No currency conversion, historical financial backfill, live billing activation, mail or DNS work occurred.

[Measurement](live-measurement-20260920.md) records 171 Render requests: 165 HTTP 200, three 401, two 404 and one unclassified 502; 12 memory warnings; and one retained Vercel HTTP 200. Retention and plan limits prevent a complete launch-wide error/latency assessment. FCP/LCP and the four-route navigation latency/request counts remain unmeasured. Approved production browser state was unavailable, and the existing four-route tool permits staging writes. No synthetic load, new instrumentation, credential hunt or fabricated green result was used. The conditional performance reserve was left unspent. Five active production enrollments had no provider subscription links, so the verified activation bug was not evidence of current production undercharging.

## Ledger

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 24 | 108 | 132 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 27 | 103 | 130 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Obsolete | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

The seven separate program findings are fixed Astra 3/Sol 2, pending Astra 1 and intentionally deferred Astra 1. PROGRAM-IMPORT-01 remains pending; PROGRAM-CURRENCY-01 is deliberately deferred. This run closed two audit observations, BB1-06 and BB2-08, plus PROGRAM-ACTIVATION-01. No other pending finding was silently closed.

Delegated batches 01, 02, 03, 05, 08, 09, 10, 12 and 13, plus recipes 14/15, are complete. Batches 04, 06 and 11 retain BT4-06, BT3-07 and FC3-08 behind database prerequisites; batch 07 retains FT1-11/FT2-08. The original 55-observation cohort remains 49 fixed, one obsolete and five pending. None of those remaining batches was started in this release. See [the index](delegated/README.md).

## Next work and traps

Complete the missing read-only live measurement with approved browser state before choosing performance work. The next bounded code proposal should reconcile PROGRAM-IMPORT-01's valid preview with execution's safe rejection of a program-specific belt when Program is omitted. Its product policy is still unsettled; do not infer a program from a belt or weaken the execution boundary just to align the preview.

- Completed migration scripts and tokens are historical. All files through V49 are applied. The preflight's `pending_versions` is a declared historical contract list, not an unapplied count.
- Vercel READY did not assign the staging alias. The explicit assignment and final pair/proxy check passed. Never promote a preview to production; create a production-target Git build.
- Private operator runbook V38 examples remain historical. The helper itself is updated, and the current repository packet governs source/image checks and recovery limits. A mapping entry is not restore evidence.
- The production application-test password remains unavailable. It was not sought or changed. Authenticated write/UI rehearsal was not performed or claimed.
- Both task-owned local PostgreSQL clusters were stopped and removed. Do not reuse prototype database names or assume a previous local history. Credentials, dumps and operator evidence remain outside Git under `/Users/openclaw/Koaryu Releases/20260919-live-corrections`.
- DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` limitation and remaining restore-script duplication were not started. Formatter and clock-test fixes landed in earlier runs. Recompute historical line counts before reusing them; an older refund-refresh test race remains an unverified concern despite passing current CI.

Canonical checkout: `/Users/openclaw/Projects/Koaryu-Repo`. The single closeout PR contains documentation and ledger changes only. Its final verification must leave the canonical checkout and task worktrees clean and pushed, no remediation PR mid-verification, and main green. Unrelated older audit PRs are outside this run.
