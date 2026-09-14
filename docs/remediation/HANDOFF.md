# Koaryu release handoff

The September 14 run completed the refund correction in PR207/PR209. PR208 contains the owner-authorization policy and tool change. Hosted execution is blocked on the per-migration execution-mode scope decision. No hosted migration, backup, backend deployment, frontend promotion or live billing activation has run.

## Main and budget

Main at this checkpoint is `63668a72d2b68542cfc1445884d7bb03a4b8b5dc`, the PR209 merge. Its API contracts run `34817798627` and Release candidate run `34817798590` both passed. Later documentation or governance merges will have their own SHA and CI; use Git and the closing task report for the final head.

The run began at 51% weekly usage, with authority to spend at most 35 percentage points. Stop new work and release execution at 81% used, reserving five points for verification/recovery; hard ceiling 86%. The read at 2026-09-14 07:19 UTC was 61% used, or 10 points spent. This is a preparation reading; the closing report records the final meter. The execution block, not budget exhaustion, prevents later phases. The window resets September 19 at 10:16:57 UTC. Do not reuse the prior run's 45% baseline or 55% ceiling.

The canonical checkout is `/Users/openclaw/Projects/Koaryu-Repo`. The coordinator's current journal is `.git/orchestrator/20260914-refund-release/state.md`; its usage helper reads the real weekly meter. Operator evidence belongs outside the repository in `/Users/openclaw/Koaryu Releases/20260914-refund-release`.

## What landed

[PR207](https://github.com/ronchak/Koaryu/pull/207) fixes PROGRAM-REFUND-01 with V46. A receipt's own verified succeeded refund no longer invalidates its original resource version before completion. Stored fingerprints and production refund Python remain unchanged. There is no new business table or public RPC, and no financial backfill.

Reviewed head: `e94f57ea4a5893d7282e26c9b172d7438c79ff55`. Exact-head Release candidate CI `34805662065` passed. The full disposable 141-migration/53-contract suite passed, including canonical/logical restore continuation and all 21 billing concurrency cases. All 1,904 backend tests passed. See [the plan](refund-recovery-plan.md) and [risk disposition](refund-completion-risk.md).

One new payment recovery test replaced a redundant readiness-constant inventory test, keeping backend case count flat. The fake plus payment/readiness test files changed from 4,419 to 4,516 lines. Historical migration bytes remain unchanged; the generator reproduces all ten historical restore scripts. The first PR head's CI failed an existing SQL test's stale V45 version list; the final one-line V46 correction received fresh review and CI. Do not cite that superseded head's green jobs as approval of the final head.

[PR209](https://github.com/ronchak/Koaryu/pull/209) corrects the different-key overlap identified by late automated review on PR207. V47 recalculates the refund comparison under the operation lock and starts the next lease after the refund lock. Final head `9905be40fc8e8ef50e8dd87e99c9647bdf0f7d70` passed independent review, completed automated review, Release candidate CI `34817037645` and API CI `34817037609`. The first candidate passed all 142 migrations and 53 contracts locally. After the lease correction, the amended canonical/logical restore, all 23 concurrency cases and the refund contract passed again; the final CI reran the full suite. No historical migration bytes or financial rows were rewritten.

The stronger lease assertions failed before the one-line correction without timed sleeps. Independent review also caught a stale raw V28 body pin; the local restore verifier rejected it. The corrected final pin passed. Earlier heads `1dcf89d` and `24b6da6` are superseded evidence, despite the former's green CI.

PR208 replaces terminal detection with owner/release authorization, a named executor, exact confirmation phrase and started/provider-response/success/failed-or-unknown audit records. Executor attribution is caller-reported; GitHub verifies the owner approval and release scope, not the process identity. All pre-apply checks remain. Tests change 66→67 cases and 3,468→3,702 lines; tool source changes 5,527→5,612 lines. The added table-driven behavior check proves success and failure evidence, rather than inspecting source wording. Workflow checks change 127→128. Private operator files are untouched; their policy diff is proposed for owner application only.

## Exact ledger counts

The original audit observations are unchanged by this release run:

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 22 | 107 | 129 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 29 | 104 | 133 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Obsolete | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

Seven program findings are separate: fixed Astra 2/Sol 2; pending Astra 3/Sol 0. PROGRAM-REFUND-01 joins PROGRAM-ATTESTATION-01, PROGRAM-SECURITY-01 and PROGRAM-DEPENDENCIES-02 as fixed. PROGRAM-CURRENCY-01, PROGRAM-IMPORT-01 and PROGRAM-ACTIVATION-01 remain pending. No other high-consequence risk was accepted or closed.

The delegated audit batches are outside this run. Batches 01, 02, 03, 05, 08, 09, 10, 12 and 13 are complete. Batches 04, 06 and 11 retain only BT4-06, BT3-07 and FC3-08, blocked on their database prerequisites. Batch07 retains FT1-11/FT2-08 after the completed fixture work. Recipes14/15 are complete. The original 55-finding cohort remains 49 fixed, one obsolete and five pending. Use [the batch index](delegated/README.md), not a fresh union of recipe IDs, to count that cohort.

## Next change and release boundary

PR208 provides owner-authorized release execution through the existing guarded tool. Its closing report supplies the final main SHA and CI; this document cannot embed its own eventual merge SHA. Retain all technical gates and the documented announce-and-pause protocol. Private operator files are unchanged; [the proposed policy diff](operator-governance-proposal.patch) requires separate owner application. The owner's explicit authorization governs this run while those notes await alignment.

The next PR should add one-migration-per-invocation execution only if the owner confirms that scope extension. The underlying CLI applies the whole pending chain in one call; the guarded tool now rejects production remainders with multiple migrations. The brief limits phase two to documentation and its authorization gate, while requiring a separate pause before each migration. The owner has been asked to resolve that conflict; the answer is pending. Do not infer permission from the separately approved backend/frontend transition, and do not use a bulk apply as a substitute. No selection mode, migration prerequisite or partial implementation is left on disk.

After governance, the next work is the hosted staging rehearsal, fresh production backup and verified disposable restore, plus a written recovery action for every forward-only migration. Only after all four exist may production proceed database first, backend second, frontend last. The owner explicitly allows the recorded old-frontend/new-backend pair only during that planned transition; every unexpected SHA mismatch still halts.

A fresh read-only production inspection during governance preparation confirmed `v38` for candidate `1c10a193...`, with eight remaining migrations V39–V46 at that earlier head. V47 now adds the ninth file, so the final source packet requires V39–V47. That token is bound to the earlier candidate and must be regenerated for the final governance SHA. The September14 closeout pair verifier freshly confirmed both production applications at `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`. Evidence is `production-pair-closeout.txt` in the private release directory. The image observation remains September11, `17.6.1.155`; re-read it before release. The private runbook's older `69eacb...` application claim is stale.

## Traps and retained work

- Applying V47 locally is not a hosted rehearsal or production backup. All task databases were disposable and cleaned up; never infer a reusable local migration state.
- The chain has no approved down-migration. An application rollback does not undo database semantics. Never invent a hosted restore command or repair migration history after an unexpected apply.
- The private backup helper knows the V38 source mapping and image. Verify the actual source and provider image before use. A future post-V47 backup needs reviewed mapping support; do not claim it already exists.
- Current backend readiness and RPCs require V47. Do not promote either application before the database chain is applied and verified. Never promote a preview build with staging variables to production.
- Production auto-deploy stays off. PR207 and PR209 each read it back off twice; PR209 readbacks were 07:25:27 and 07:25:28 UTC on September14. No new grants, worker activation, historical financial backfill, mail or DNS work is authorized.
- The support-address task DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` external-payment issue and restore-script duplication remain unstarted. The formatter and three timing-sensitive tests were already fixed in earlier PRs.
- Do not reopen the old import line-count claim: the stale 870 text was already removed. Preserve pending import-policy and activation/currency decisions in their existing plans; none belongs in this release patch.

## Resume checks

Confirm local and remote main agree, every task worktree is clean and every task commit is pushed. PR208 was rebased after PR209; its former `f79c8e2` CI cannot approve the new head. Require the final main's own exact-head CI and no non-draft PR left mid-verification. Read the closing report and Git before using any checkpoint SHA here.

All local databases in this run were disposable; the verifier removes its clusters and owned restore databases. Do not reuse a prior local apply state. Private evidence is in the run directory named above. No new production backup or restore proof exists, no new apply authorization record was posted to PR138, and no deployment request was submitted. Production was freshly inspected at V38 during this run; the application pair was freshly verified unchanged, while the provider image must still be re-read before execution. Do not run the packet until its missing scope decision and all phase-three evidence are complete.
