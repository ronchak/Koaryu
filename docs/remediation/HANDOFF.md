# Koaryu release handoff

The September 14 release stopped during phase 3 at a failed hosted SQL contract. All nine staging migrations V39–V47 applied and verified, preserving every tracked pre-existing business row. The dashboard schedule-plan contract then failed. Production remains unmodified at V38; no backup, restore, backend deployment, frontend promotion or live billing activation occurred. See [the execution and failure record](staging-rehearsal-verification.md).

The owner subsequently authorized an evidence-based correction of the query-plan test and continuation of phase 3. See [the correction plan](dashboard-plan-contract-plan.md). The original staging-owner credential mapping has been recovered and authenticated; release credentials are now also stored in the Home Server login Keychain. The failed hosted suite still requires a complete rerun after the reviewed correction.

## Main and budget

Reviewed release candidate and main before this documentation closeout: `c1e933f5ddac862ce24387d45609052b8d0baad1`, PR210 merge. Its own exact-head Release candidate run `34839365373` passed. The closing documentation PR has a later main SHA and its own CI, recorded in the closing report and Git. It does not change the frozen release candidate.

Original weekly baseline remains 51% used. The owner's amendment applies the 30-point threshold only to starting a chain. Before the first production apply, estimate the entire remaining release and verification; do not start if projected total exceeds 35 points. Once started, finish the chain and verification past30 unless a technical safety stop occurs. The hard ceiling is40 points. Thus the meter thresholds are 81% used to stop starting, 86% planned completion, 91% absolute ceiling. Do not reset the baseline on continuation. The latest preparation read, September 14 13:56 UTC, was 71% used, 20 points spent; the closing report records the final meter. This stop is a failed verification gate, not budget exhaustion. Weekly reset is September 19 10:16:57 UTC.

Canonical checkout: `/Users/openclaw/Projects/Koaryu-Repo`. Private journal: `.git/orchestrator/20260914-refund-release/state.md`. Operator evidence: `/Users/openclaw/Koaryu Releases/20260914-refund-release`. Never commit credentials, dumps or raw operator evidence.

## What landed

[PR207](https://github.com/ronchak/Koaryu/pull/207) fixes PROGRAM-REFUND-01 with V46. A receipt's own verified succeeded refund no longer invalidates its original resource version before completion. Stored fingerprints and production refund Python remain unchanged. There is no new business table or public RPC, and no financial backfill.

Reviewed head: `e94f57ea4a5893d7282e26c9b172d7438c79ff55`. Exact-head Release candidate CI `34805662065` passed. The full disposable 141-migration/53-contract suite passed, including canonical/logical restore continuation and all 21 billing concurrency cases. All 1,904 backend tests passed. See [the plan](refund-recovery-plan.md) and [risk disposition](refund-completion-risk.md).

One new payment recovery test replaced a redundant readiness-constant inventory test, keeping backend case count flat. The fake plus payment/readiness test files changed from 4,419 to 4,516 lines. Historical migration bytes remain unchanged; the generator reproduces all ten historical restore scripts. The first PR head's CI failed an existing SQL test's stale V45 version list; the final one-line V46 correction received fresh review and CI. Do not cite that superseded head's green jobs as approval of the final head.

[PR209](https://github.com/ronchak/Koaryu/pull/209) corrects the different-key overlap identified by late automated review on PR207. V47 recalculates the refund comparison under the operation lock and starts the next lease after the refund lock. Final head `9905be40fc8e8ef50e8dd87e99c9647bdf0f7d70` passed independent review, completed automated review, Release candidate CI `34817037645` and API CI `34817037609`. The first candidate passed all 142 migrations and 53 contracts locally. After the lease correction, the amended canonical/logical restore, all 23 concurrency cases and the refund contract passed again; the final CI reran the full suite. No historical migration bytes or financial rows were rewritten.

The stronger lease assertions failed before the one-line correction without timed sleeps. Independent review also caught a stale raw V28 body pin; the local restore verifier rejected it. The corrected final pin passed. Earlier heads `1dcf89d` and `24b6da6` are superseded evidence, despite the former's green CI.

PR208 replaces terminal detection with owner/release authorization, a named executor, exact confirmation phrase and started/provider-response/success/failed-or-unknown audit records. Executor attribution is caller-reported; GitHub verifies the owner approval and release scope, not the process identity. All pre-apply checks remain. Tests change 66→67 cases and 3,468→3,702 lines; tool source changes 5,527→5,612 lines. The added table-driven behavior check proves success and failure evidence, rather than inspecting source wording. Workflow checks change 127→128. Private operator files are untouched; their policy diff is proposed for owner application only.

[PR210](https://github.com/ronchak/Koaryu/pull/210) adds the approved one-migration mode. Final head `499155c5f8f38ebfc8d216a6d5b6cb2f3d72735e` passed fresh review and exact-head CI `34838646831`; merge `c1e933f5ddac862ce24387d45609052b8d0baad1` passed its own CI. All nine real CLI invocations passed on disposable PostgreSQL before the hosted rehearsal. No migration file bytes changed. See [verification](one-migration-verification.md).

## Exact ledger counts

The authorized dashboard contract correction also fixes DC1-03. The counts after that change are:

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 23 | 107 | 130 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 28 | 104 | 132 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Obsolete | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

Seven program findings are separate: fixed Astra 2/Sol 2; pending Astra 3/Sol 0. PROGRAM-REFUND-01 joins PROGRAM-ATTESTATION-01, PROGRAM-SECURITY-01 and PROGRAM-DEPENDENCIES-02 as fixed. PROGRAM-CURRENCY-01, PROGRAM-IMPORT-01 and PROGRAM-ACTIVATION-01 remain pending. No other high-consequence risk was accepted or closed.

The delegated audit batches are outside this run. Batches 01, 02, 03, 05, 08, 09, 10, 12 and 13 are complete. Batches 04, 06 and 11 retain only BT4-06, BT3-07 and FC3-08, blocked on their database prerequisites. Batch07 retains FT1-11/FT2-08 after the completed fixture work. Recipes14/15 are complete. The original 55-finding cohort remains 49 fixed, one obsolete and five pending. Use [the batch index](delegated/README.md), not a fresh union of recipe IDs, to count that cohort.

## Next change and release boundary

PR212 resolves the copied-plan assertion issue as recorded in [the correction plan](dashboard-plan-contract-plan.md). After its reviewed merge, repin the candidate and rerun every hosted contract from a clean state. The historical 19-pass/one-failure result does not count as a complete gate. Then complete authenticated application rehearsal and the production backup/restore prerequisites. DM3-04 and OPS1-06 remain separate pending runtime/ownership work; this test correction does not establish a general database I/O budget.

Staging is exact V47, 142 migrations, head `20260914055301`. Its web service and billing cron remain suspended. No application deployment or staging branch move occurred. Restoring staging service is a separate announced release action after the failed gate is resolved; deploy the reviewed candidate and keep the cron paused. Complete all 53 hosted contracts and authenticated application rehearsal before production. The existing staging-owner account now authenticates with the approved stored password. The exact account, verified session and Keychain inventory are recorded privately in the release directory.

Production's last verified application pair is `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`; its database is V38. Fresh closing readbacks are retained privately. Both Supabase projects were read at image 17.6.1.155 during this rehearsal. The fresh production backup/verified restore and controlled write window remain unfulfilled. Never reuse an old token or claim the failed staging suite passed.

The owner authorizes coordinating Astra, not subagents, to execute the eventual release. Keep every technical gate and separate announce/60-second-pause before each outward release action. The exact old-frontend/new-backend pair is allowed only between backend verification and frontend deployment; any unexpected SHA mismatch stops. Private operator files remain unchanged; [their proposed policy diff](operator-governance-proposal.patch) still awaits owner application. No production chain was started or approved in this rehearsal.

## Traps and retained work

- Applying V47 locally is not a hosted rehearsal or production backup. All task databases were disposable and cleaned up; never infer a reusable local migration state.
- The chain has no approved down-migration. An application rollback does not undo database semantics. Never invent a hosted restore command or repair migration history after an unexpected apply.
- The private backup helper knows the V38 source mapping and image. Verify the actual source and provider image before use. A future post-V47 backup needs reviewed mapping support; do not claim it already exists.
- Current backend readiness and RPCs require V47. Do not promote either application before the database chain is applied and verified. Never promote a preview build with staging variables to production.
- Production auto-deploy stays off. PR207 and PR209 each read it back off twice; PR209 readbacks were 07:25:27 and 07:25:28 UTC on September 14. No new grants, worker activation, historical financial backfill, mail or DNS work is authorized.
- The support-address task DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` external-payment issue and restore-script duplication remain unstarted. The formatter and three timing-sensitive tests were already fixed in earlier PRs.
- Do not reopen the old import line-count claim: the stale 870 text was already removed. Preserve pending import-policy and activation/currency decisions in their existing plans; none belongs in this release patch.

- Closeout CI on `0b5c871...` failed the existing refund refresh test at `frontend/tests/billing-data-mounted.test.mjs:935`: it saw only `newer-payment`, without `payment-1`. The focused local case passed. The test calls `loadMoreHistory()` immediately after refresh, while its callback depends on a React-rendered cursor; a render-settling race is a hypothesis, not a verified fix. Application/test bytes are unchanged. Retain this investigation even if subsequent CI passes; do not weaken billing assertions to close documentation.

## Resume checks

Read the closing report and Git for the final documentation merge SHA; require its own exact-head CI. Confirm local/remote main agree and task worktrees are clean and pushed. PR210's source candidate is frozen at `c1e933f...`; earlier PR208/PR209 green heads do not approve later code.

Keep staging web and cron suspension explicit. No process is applying a migration. All nine staging migration transactions succeeded; the hosted contract suite is incomplete, not green. Failed contract fixtures rolled back, and retained-row comparison passed afterward. Local verifier databases were disposable; do not infer a reusable local schema from earlier proofs. Production has no new backup/restore evidence and no apply/deployment occurred. Rerun the complete hosted contract gate after the reviewed correction, then use the verified staging login to resume application rehearsal. Re-estimate the production chain against the amended budget before its first apply.
