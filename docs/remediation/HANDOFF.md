# Koaryu release handoff

## Current stop

Phase 3 is paused at a staging frontend alias mismatch. All nine V39–V47 migrations and the complete 53-file hosted contract suite passed. The staging backend and unique frontend build serve `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`; the normal staging URL still serves `f35395a5700876f6490336ae400c09849a368204`. The pair verifier failed. No synthetic application writes, production backup/restore, production deployment or live billing activation followed it.

Staging web is active. Its billing cron remains suspended. Production remains V38, with the previously verified frontend/backend pair `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`. Nothing was applied to production in this run. Read [the execution record](staging-rehearsal-verification.md) and [release packet](PRODUCTION-RELEASE.md) before continuing.

## Source and budget

Main at preparation of this documentation closeout and the frozen release candidate are `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`, PR213 merge. Its own exact-head CI `34903006341` passed. The final report and Git identify the subsequent documentation-only merge and its own CI; do not mistake that later SHA for the deployed candidate.

Original weekly baseline remains 51% used. At September 14 22:36 UTC the meter was 80% used, or 29 points spent. This is a technical-gate stop, not budget exhaustion. Check the live meter before resuming. At 30 points, do not start a production chain. Before the first apply, estimate the whole remaining release and verification: do not start if projected total exceeds 35. Once started, finish the chain past 30 unless a technical safety stop occurs. Hard ceiling is 40 points, or 91% used. Weekly reset is September 19 10:16:57 UTC. Never reset the baseline on continuation.

Canonical repo: `/Users/openclaw/Projects/Koaryu-Repo`. Private evidence: `/Users/openclaw/Koaryu Releases/20260914-refund-release`. Usage helper: `.git/orchestrator/20260914-refund-release/usage.py`. Credentials, dumps, sessions and operator evidence stay outside Git.

## Next action

No new product PR is needed before diagnosing and resolving the stopped alias assignment. Vercel deployment `dpl_Cm7wLHQTo3SdqLH8RvrM9iszGE5j` is READY and its unique URL reports the correct staging identity. Its `automaticAliases` lists the expected staging URL, but its assigned `alias` list is empty. The readback at 22:31:18 UTC found the old SHA at the normal alias and the new SHA at the unique URL, both cache MISS.

The bounded proposed repair, **not executed**, is:

```bash
vercel alias set koaryu-6pcxf6i1r-ronakchak2569-8303s-projects.vercel.app \
  koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app \
  --scope team_gLZEwMI0jgTr9zGABNt3Rude
```

Resolve the owner's stop condition before executing recovery. Re-read the deployment's exact SHA, environment and current alias first; announce the exact assignment, wait 60 seconds, then verify the pinned pair with the existing `verify:deployed-release` command from the packet. Do not substitute the unique URL to waive that gate, promote a preview to production, or redeploy blindly. The alias change is reversible, but neither reassignment nor rollback was attempted here.

After a matching pair: finish authenticated student edit/program-date independence, rank replay/history, CSV import replay, external-payment replay and unchanged local-plan save checks on synthetic records. The private `staging-api-rehearsal-recipe.md` describes the payloads. Use `staging-request.py` so tokens stay out of argv/logs; one mutation and verification at a time. `request-student-create.json` and `rehearsal-run.json` are prepared but unexecuted. Program/ladder GETs already returned 200. No synthetic student, payer, payment, plan or import was created.

Then establish the controlled production write window, fresh backup and verified disposable restore. The helper's V38 source/image mapping must match fresh production readback. No backup exists for this release yet. Re-estimate cost before any production apply, then use the separate guarded one-file invocations and stop conditions in the packet.

## What landed

- PR207/209: V46 refund recovery and V47 completion locking, with real database, restore and concurrency proofs. Stored fingerprints and historical financial rows remain unchanged.
- PR208/210: owner-authorized execution audit trail and approved one-migration mode. Technical gates remain intact; the private runbook policy diff is still proposed, not applied.
- PR212: evidence-based removal of the copied dashboard query-plan/source assertions. Actual RPC/security checks and fixture rows remain. DC1-03 is fixed.
- PR213: reconciliation inventory and owned-profile fixtures now work on populated staging. Final head `c0d7559542cd4887aea9a48b10b528fe5726f0bd` passed fresh review and exact-head CI `34902266976`. All 53 hosted contracts then passed on its merge, with unchanged tracked rows and V47 fingerprint. Runtime/migration bytes are unchanged from PR210.

The 53-file pass supersedes neither earlier failed attempt: the first stopped after 19 files, and the second attempted all 53 with two failures. Keep those logs. The final complete pass is `staging-138f-contracts.log`; the post-run fingerprint is `staging-138f-post.txt`. Fixture rollbacks can advance sequences, so retained-row preservation is not a claim that sequence counters are unchanged.

## Credentials

The explicitly authorized fresh Sol tasks on the MacBook Air recovered the original staging-owner pairing. Read-only Auth verification, one correctly paired login and a later session refresh succeeded. The earlier failed attempt used a different account; do not retry that pairing. No account/password was changed or provisioned. Twelve provider/staging/backup credential entries are now in this Mac's login Keychain and were read back byte-for-byte. The original operator files and CLI logins remain available.

The historical production application-test password was not recovered. Provider and backup credentials are available, but do not claim production browser authentication. Exact account/session references and Keychain inventory are private. The refreshed staging session expires; refresh it through the existing helper rather than printing credentials or guessing passwords. Browser connection was prepared only; no UI rehearsal occurred.

## Exact ledger counts

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

Seven separate program findings: fixed Astra 2/Sol 2; pending Astra 3/Sol 0. PROGRAM-CURRENCY-01, PROGRAM-IMPORT-01 and PROGRAM-ACTIVATION-01 remain pending. No risk was newly accepted. PR213 and this closeout change no dispositions.

Audit batches are outside this release. Batches 01, 02, 03, 05, 08, 09, 10, 12 and 13 are complete. Batches 04, 06 and 11 retain BT4-06, BT3-07 and FC3-08 behind database prerequisites. Batch07 retains FT1-11/FT2-08. Recipes14/15 are complete. The original 55-finding cohort remains 49 fixed, one obsolete and five pending. Use [the batch index](delegated/README.md).

## Traps

- No task migration or contract process remains running. Disposable PostgreSQL probes were removed; do not infer a reusable local schema. Confirm clean worktrees, pushed commits and exact-head main CI before resuming.
- READY does not prove a staging alias moved. Do not cite a branch build or superseded green CI as deployed-pair evidence.
- Production is still V38. New backend RPCs require V47. Database first, backend second, frontend last; no historical backfill or live activation. The chain has no approved down-migration or automatic hosted recovery.
- The private backup helper supports the current V38 source, not post-V47 backups. A complete verified restore and current provider image are mandatory. The September6 backup is historical.
- Production auto-deploy remains off. Staging cron remains suspended. No mail, DNS, new grants or worker activation is authorized.
- DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` issue and restore-script duplication remain unstarted. Formatter and three timing-sensitive tests were fixed earlier; the stale import 870-line claim was already removed.
- The prior refund-refresh test failure at `frontend/tests/billing-data-mounted.test.mjs:935` remains an unverified React cursor-settling concern. Subsequent CI passed; do not weaken billing assertions to hide it.
