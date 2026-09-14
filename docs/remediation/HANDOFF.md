# Koaryu release handoff

The September 14 four-phase run is active. Phase one has merged. Phase two is preparing the owner-authorization policy and tool change. No hosted migration, backup, backend deployment, frontend promotion or live billing activation has run.

## Main and budget

Main at this checkpoint is `1c10a193e66861fd3e2a8174251910798199eeca`, the PR207 merge. Its exact-head Release candidate run `34806541899` and API contracts run `34806541788` passed. Later documentation or governance merges will have their own SHA and CI; use Git and the closing task report for the final head.

The run began at 51% weekly usage, with authority to spend at most 35 percentage points. Stop new work and release execution at 81% used, reserving five points for verification/recovery; hard ceiling 86%. The read at 2026-09-14 04:51 UTC was 56% used, or 5 points spent. The window resets September 19 at 10:16:57 UTC. Do not reuse the prior run's 45% baseline or 55% ceiling.

The canonical checkout is `/Users/openclaw/Projects/Koaryu-Repo`. The coordinator's current journal is `.git/orchestrator/20260914-refund-release/state.md`; its usage helper reads the real weekly meter. Operator evidence belongs outside the repository in `/Users/openclaw/Koaryu Releases/20260914-refund-release`.

## What landed

[PR207](https://github.com/ronchak/Koaryu/pull/207) fixes PROGRAM-REFUND-01 with V46. A receipt's own verified succeeded refund no longer invalidates its original resource version before completion. Stored fingerprints and production refund Python remain unchanged. There is no new business table or public RPC, and no financial backfill.

Reviewed head: `e94f57ea4a5893d7282e26c9b172d7438c79ff55`. Exact-head Release candidate CI `34805662065` passed. The full disposable 141-migration/53-contract suite passed, including canonical/logical restore continuation and all 21 billing concurrency cases. All 1,904 backend tests passed. See [the plan](refund-recovery-plan.md) and [risk disposition](refund-completion-risk.md).

One new payment recovery test replaced a redundant readiness-constant inventory test, keeping backend case count flat. The fake plus payment/readiness test files changed from 4,419 to 4,516 lines. Historical migration bytes remain unchanged; the generator reproduces all ten historical restore scripts. The first PR head's CI failed an existing SQL test's stale V45 version list; the final one-line V46 correction received fresh review and CI. Do not cite that superseded head's green jobs as approval of the final head.

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

Finish phase two before hosted execution. Replace terminal detection with exact owner/release authorization, a named executor and deliberate confirmation phrase. Retain all technical gates and the documented announce-and-pause protocol. Private operator files are unchanged; [the proposed policy diff](operator-governance-proposal.patch) requires separate owner application. The owner's explicit authorization governs this run while those notes await alignment.

The current rollout implementation applies the entire pending chain in one command. The owner has been asked whether phase two may also add a per-migration mode to satisfy the required pause before each migration. That scope answer is pending. Do not run a bulk apply as a substitute for the per-migration protocol.

After governance, the next work is the hosted staging rehearsal, fresh production backup and verified disposable restore, plus a written recovery action for every forward-only migration. Only after all four exist may production proceed database first, backend second, frontend last. The owner explicitly allows the recorded old-frontend/new-backend pair only during that planned transition; every unexpected SHA mismatch still halts.

A fresh read-only production inspection during governance preparation confirmed `v38` for candidate `1c10a193...`, with exactly eight remaining migrations V39–V46. That token is bound to the earlier candidate and must be regenerated for the final governance SHA. Last application-pair and provider-image evidence remains the September 11 observation of `c5742fe393a8bfb3a1faddb1f488e46a00bd5091` and image `17.6.1.155`; re-read both before release. The private runbook's older `69eacb...` application claim is stale.

## Traps and retained work

- Applying V46 locally is not a hosted rehearsal or production backup. All task databases were disposable and cleaned up; never infer a reusable local migration state.
- The chain has no approved down-migration. An application rollback does not undo database semantics. Never invent a hosted restore command or repair migration history after an unexpected apply.
- The private backup helper knows the V38 source mapping and image. Verify the actual source and provider image before use. A future post-V46 backup needs reviewed mapping support; do not claim it already exists.
- Current backend readiness and RPCs require V46. Do not promote either application before the database chain is applied and verified. Never promote a preview build with staging variables to production.
- Production auto-deploy stays off. PR207's guarded merge read it back off twice. No new grants, worker activation, historical financial backfill, mail or DNS work is authorized.
- The support-address task DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` external-payment issue and restore-script duplication remain unstarted. The formatter and three timing-sensitive tests were already fixed in earlier PRs.
- Do not reopen the old import line-count claim: the stale 870 text was already removed. Preserve pending import-policy and activation/currency decisions in their existing plans; none belongs in this release patch.
