# Koaryu handoff, September 20, 2026

## Current state

The seven queued findings are fixed and live. The bounded run is complete; the wider remediation program remains open. Production and staging are V50, 145 migrations, head `20260920154441`, manifest `release-db-attestation-v50`. Both frontend/backend pairs serve `dce52efff1d28358eca421769d00791b60045c6c`. Production readiness, frontend proxy, environment and `pdx1` checks passed. Both web services are active; production auto-deploy stays off and the staging billing cron remains suspended. No billing activation changed.

Code main at closeout is `7d7308afe8c77578094db8ffb81ee0c9a9e37fe2`, PR227 merge, with a tree identical to the deployed candidate. Exact-main CI `35531485667` and candidate CI `35531096941` passed. The documentation-only closeout advances main without redeploying; read its final merge SHA from Git and the final report. Do not deploy the documentation SHA merely to match main.

PR222 fixes FC1-04. PR223 fixes FSH2-02/FC2-02 together. PR224 fixes OPS1-02; PR225 fixes OPS2-03; PR226 fixes BB1-03; PR227 fixes DM1-01. No queued finding was dropped or left half-implemented. [Verification](queued-findings-verification.md) records each reviewed head, merge and test change. The earlier V48–V49 release is [archived separately](production-v48-v49-verification.md).

## Verification and recovery

- Final candidate CI passed 1,930 backend tests, 904 frontend tests, build/lint/security/API checks and the database gate. The complete local replay passed 145 migrations, 54 contracts, restore continuations, tamper checks and concurrency proofs. All 54 hosted staging contracts passed.
- One production migration invocation followed its own 30-second announcement. All 2,684 original rows across 69 tables remained unchanged after apply. Staging preserved 909 original rows after both apply and contracts. The scope includes public/private customer data, Auth users and Storage metadata, excluding attestation expectation tables and provider session/operational tables.
- Fresh pre-V50 backup: `/Users/openclaw/Koaryu Backups/production-20260920T193053Z`. Restore verified at `2026-09-20T19:31:54.106814+00:00`. All 16 comparisons, original V49 readiness, encryption and temporary role/container cleanup passed. Image `17.6.1.155`, digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`.
- The reviewed helper supports exact mappings through V50. No post-V50 backup has been taken. A future V50 backup starts from count 145/head `20260920154441` only after fresh provider checks. Historical V38/V47/V49 commands are not current approval.
- No approved down-migration or automated hosted restore exists. The previous V49 app remains schema/readiness-compatible through V50, but compatibility alone does not authorize rollback. Older apps are not approved after V48 receipts or V49 unknown terms exist. See the [completed packet](PRODUCTION-RELEASE.md) and [release proof](production-release-verification.md).

## Budget and limits

The allocation is 40 additional weekly percentage points from a 5%-used baseline, including the initial V48–V49 release and this queued follow-up. At the closeout check on September 20, the meter was 35% used: 30 points spent, 10 left. No further implementation is being started. The final report supplies the last meter after closeout; unused allocation remains unspent. Do not reuse the old 51% baseline or 45-point cap.

The earlier read-only production query found USD only in seven invoices, five payments and five plans. Mixed-currency reporting remains intentionally deferred; no conversion or financial backfill occurred. [Measurement](live-measurement-20260920.md) retains 171 Render requests: 165 HTTP 200, three 401, two 404, one unclassified 502, plus 12 memory warnings and one retained Vercel HTTP 200. Retention/plan limits prevent a complete launch-wide assessment. FCP/LCP and four-route navigation latency/request counts remain unmeasured. No synthetic production load or fabricated green result was used. Five active enrollments had no provider subscription links; the earlier activation reproduction was not proof of live undercharging.

## Ledger

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 26 | 113 | 139 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 25 | 98 | 123 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Obsolete | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

The separate seven program findings remain fixed Astra 3/Sol 2, pending Astra 1 and intentionally deferred Astra 1. PROGRAM-IMPORT-01 is pending; PROGRAM-CURRENCY-01 is deferred. BT4-05 remains pending despite its legacy date-boundary portion now being covered. FR1-02 and FC1-06 cover other forms and remain pending.

Delegated batches 01, 02, 03, 05, 08, 09, 10, 12 and 13, plus recipes 14/15, are complete. Batches 04, 06 and 11 retain BT4-06, BT3-07 and FC3-08 behind database prerequisites; batch 07 retains FT1-11/FT2-08. The original 55-observation cohort remains 49 fixed, one obsolete and five pending. These remainders were not started in this follow-up. See [the index](delegated/README.md).

## Next work and traps

The next bounded code proposal should address PROGRAM-IMPORT-01: preview accepts a program-specific belt with Program omitted, while execution safely rejects it. Reconcile that ownership before implementation; do not infer a program or weaken execution merely to match preview. Obtain the still-missing read-only live navigation measurements before choosing performance work.

- Every migration through V50 is applied. Completed apply scripts, tokens and prior green CI are historical. The preflight's `pending_versions` is a declared compatibility list, not the unapplied count.
- Staging Vercel READY did not assign the stable alias; explicit assignment and final pair verification passed. Never promote a preview build to production. Use a production-target Git build.
- Private operator runbook V38 examples remain stale. The repository packet and explicit release authorization governed this run. The helper itself is updated. `backup.json` retains its creation-time pending label; the later `restore-proof.json`, readiness and cleanup records establish completion.
- Render does not explicitly override `BILLING_TRANSITION_SCHEDULER_ENABLED` for production. The reviewed application defaults it to false, matching the manifest. Do not treat an absent provider field as an explicit stored value.
- All task-owned local PostgreSQL clusters were stopped and removed. Do not reuse prototype histories. Credentials, dumps and private evidence remain outside Git under `/Users/openclaw/Koaryu Releases/20260920-queued-findings` and the earlier release directory.
- The production application-test password remains unavailable. No password was hunted, reset or provisioned. Authenticated application-write rehearsal was not performed or claimed.
- DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` limitation and remaining restore-script duplication were not started. Formatter and clock-test fixes landed earlier. Recompute historical line counts before citing them; the older refund-refresh test race remains an unverified concern despite passing CI.

Canonical checkout: `/Users/openclaw/Projects/Koaryu-Repo`. The closeout contains documentation and ledger changes only. Final verification must leave this checkout and task worktrees clean and pushed, no remediation PR mid-verification, and main green. Unrelated older audit PRs are outside this run.
