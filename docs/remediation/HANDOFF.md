# Koaryu remediation handoff

This budgeted run stopped implementation on September 12 Pacific time, September 13 UTC. The remediation program remains incomplete. No production release was executed.

## Main, budget and clean stopping point

- Main at handoff preparation, after PR200: `74cd8f4862ffeb669c36bb03603d820fd95a512f`. Its own exact-head Release candidate run `34738008373` passed. The closing documentation PR has a later merge SHA; fetch origin/main for that SHA, and use the closing task report for its final CI result. A committed handoff cannot contain its own final merge hash.
- Usage at preparation: 43 percentage points from a 0 baseline. Stop-new-work threshold 45, hard cap 50; seven authorized points remain at this snapshot. The remaining headroom is reserved for review, CI and cleanup. Final usage is recorded in the closing report. This is the account-wide weekly meter, not accumulated/cache token totals. Window resets 2026-09-19 10:16:57 UTC.
- Implementation stopped before another broad batch because the eight selected remainders are prerequisite-blocked or require a larger test-ownership review than the remaining new-work allowance. No new migration or half-finished application change was started.
- The pre-handoff sweep found all 29 implementation worktrees clean and every reachable task commit published. PR180 is now merged; it is no longer parked. Repeat the sweep after the documentation merge. There must be no uncommitted/unpushed work or open non-draft remediation PR mid-verification. Older unrelated PRs 63-74 are outside this run.

## What landed

PR182 through PR200 and PR180 merged through the guarded script. Each implementation batch used a fresh Sol thread, coordinator review and a separate fresh PR reviewer. Corrections reused a thread only within the same batch/PR. Every final implementation head passed its required CI.

- Billing's implicit owner graph is gone. Sixteen components taking whole-service/manager owners become zero, including all four opaque workflow families. All 71 private-facade methods and the facade file are removed. Concrete collaborators replace callbacks through BillingService; the reverse import cycle is gone. Backend AGENTS.md records this boundary. Billing modules 29→27, lines 20,760→20,085, bytes 834,268→806,569. See [ownership verification](enrollment-ownership-verification.md).
- Pinned Ruff/Prettier and isolated the mechanical baseline; fixed the six prioritized display/recovery defects; corrected backup/operator guidance, product promises, fake error diagnostics and the cursor-error contract; retired unused UI/state and ineffective test/evidence claims.
- Relative to the formatter baseline `d6bab29209d2ee4650b8f01e0ece474ff519f422`, non-generated backend/frontend application Python/TypeScript source is 1,179 lines smaller. Frontend collected cases 912→902; backend remains 1,904. Test source did not shrink overall. Source/JSON fixtures under frontend/tests+e2e grew 31,816→31,936 lines, backend/tests 69,465→69,499, and root scripts/*.test.mjs fell 5,385→5,384: net +153 lines. Stronger real contract/mounted fixtures offset deletions. Broader test cleanup remains open.

[REMEDIATION.md](../../REMEDIATION.md) lists every merged PR and its verification document. This run fixed 47 original audit observations and reconciled one as obsolete. It did not close the financial/database program.

## Exact ledger counts

Original 278 observations; current execution tracks, not historical authorship:

| Disposition | Astra | Sol | Total |
| --- | ---: | ---: | ---: |
| Fixed | 22 | 103 | 125 |
| Resolved indirectly | 1 | 1 | 2 |
| Pending | 29 | 108 | 137 |
| Deferred intentionally | 4 | 7 | 11 |
| Deferred pending owner action | 0 | 1 | 1 |
| Rejected after verification | 0 | 1 | 1 |
| Obsolete | 0 | 1 | 1 |
| Total | 56 | 222 | 278 |

Seven program findings are separate: three fixed and four pending. Fixed tracks: Astra 1/Sol 2. Pending tracks: Astra 4/Sol 0. Fixed are PROGRAM-SECURITY-01, PROGRAM-ATTESTATION-01 and PROGRAM-DEPENDENCIES-02. Pending are PROGRAM-CURRENCY-01, PROGRAM-IMPORT-01, PROGRAM-ACTIVATION-01 and PROGRAM-REFUND-01. Mixed future work still needs Sol for application files and Astra for database work.

## Delegated batches and unfinished work

| Batch | Status | Remaining |
| --- | --- | --- |
| 01 billing product truth | Done, PR195 | 0 |
| 02 operator/release docs | Done, PR194 | 0 |
| 03 customer copy/setup | Done, PR193/198 | 0 |
| 04 backend contract/copy | Eligible work done, PR199 | BT4-06→ACS1-04; BT5-05→OPS1-09 |
| 05 backend dead code/fixtures | Done, PR171 | 0 |
| 06 performance evidence | Eligible work done, PR174/200 | BT3-07→OPS1-06 |
| 07 frontend fixtures/claims | Partial, PR177/196; FT2-07 obsolete after PR169 | FT1-07, FT1-11, FT1-12, FT2-08 |
| 08 display/dead interfaces | Done, PR180/192/197 | 0 |
| 09 shared route/UI | Done, PR169 | 0 |
| 10 schedule rendering | Done, PR173 | 0 |
| 11 student/roster presentation | Eligible work done, PR176/191 | FC3-08→FC3-01 |
| 12 marketing scene | Done, PR165 | 0 |
| 13 dependency advisories | Done, PR166; program finding | 0 |

Of the 55 selected findings, 46 are fixed, one obsolete and eight pending. Recipe14 is the completed six-finding subset of batch08, not an additional batch. The four prerequisite-dependent items were explicitly excluded by the owner. The four test items were not started or expanded during wind-down: shared packer/storage reuse needs a bounded design that reduces indirection, and the umbrella source-test work crosses multiple safety-sensitive suites. Do not close them by adding a generic fixture layer or replacing each grep with a new test. The broader ledger includes application findings outside these original recipes.

## Recommended next PR

After a new budget/scope is established, prioritize [PROGRAM-REFUND-01](refund-completion-risk.md). A succeeded refund can project its own changed refunded amount, then fail receipt completion; its same-key retry is rejected 409 by the stored resource-version check. The reproduction used the actual billing service/projector with existing synthetic provider/database fixtures: one provider refund, receipt still projected, persisted refunded amount 500, and same-key retry 409 after the lease window. SQL source supports the mechanism, but no new database proof or fix was implemented in this run. Do not bypass claims/leases, forge resource hashes or move completion ahead of projection. Astra must own the database proof and any forward correction; Sol owns application changes.

Next after that, revisit PROGRAM-ACTIVATION-01 with BB1-06/BT1-02. A transient pre-provider failure can freeze derived quantity: three active enrollments with provider quantity 2 after retry. A catch-only patch is insufficient; preserve already-attempted provider operations and their idempotency.

Unknown/mixed currency reporting, family attribution, overdue/date semantics, worker/lock behavior and token-renewal settlement also remain pending. No new high-consequence risk was accepted here. PROGRAM-IMPORT-01 still needs a product decision about an omitted Program with a program-specific belt; retain its safe refusal. Settled product decisions in REMEDIATION.md remain authoritative. DOC1-05 remains support-address owner action, with no mail/DNS work.

## Production release stays blocked

[PRODUCTION-RELEASE.md](PRODUCTION-RELEASE.md) is still pinned to `f942dad3509a2e2cc9b55d546c2d22e097f77abe`, not current main. Choosing current main requires a fresh candidate packet, approvals, rehearsal, backup/restore evidence and deployment requests. Do not silently replace its SHA or use the old green checks.

The repository has 140 migrations through V45. Supabase files are byte-unchanged during this run; the packet's seven V39-V45 migration hashes match current files. The last actual hosted database inspection was September 11 UTC: V38/133 migrations. The last observed production application pair was `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`. These are historical observations, not a fresh readback in this run.

The chain is forward-only with no approved down-migration. Fresh pre-apply backup/restore proof and hosted V45 staging rehearsal still do not exist. The private backup helper knows V37/V38 mappings and needs reviewed support for a future post-V45 backup. Its disposable restores are not hosted recovery. Database first, backend second, frontend last: current backend RPCs are absent from the last-observed production V38. Do not promote either application before migration and verification. No packet step was executed here.

Every merge re-read Render production auto-deploy off; Vercel's main deployment setting remains false in source. Production migration apply remains human-only in a real interactive terminal, never an agent PTY or piped confirmation. Keep tenant/auth/payment/idempotency gates, no historical financial backfill, and no live billing activation. No local migration or database state was created in this run; CI used disposable verification. Start any future database work from a clean full ephemeral verifier, not assumed local state.

## Traps and log-only follow-ups

- CI belongs to one full SHA. PR198's first green head was superseded after real review findings; only its corrected final head was merged. PR197's first two merge requests returned GitHub errors; readback proved no commit before a successful guarded retry. Never infer persistence from a transport error alone.
- The formatter recommendation is completed by PR182. Keep behavior changes free of unrelated formatting. Root scripts are outside the frontend formatter baseline. An older copied backend venv lacked Ruff; the existing pinned 0.16.7 binary was reused from the formatter worktree without changing dependencies.
- `frontend/src/lib/billing-report-actions-model.ts` still relies on `crypto.randomUUID`, so plain-HTTP external-payment recording remains a logged issue. No fix was started.
- The reported 35ms deadline test and two real 15s export-budget tests remain wall-clock-sensitive concerns. Do not weaken production deadlines or CI to hide them; no stabilization work was started.
- The old import-verification 870-line claim was already absent when rechecked. Do not manufacture a replacement 884 count. Keep line accounting tied to an exact revision.
- Seven restore-contract scripts reportedly retain 56-65% duplication. This run did not rewrite them or historical migrations.
- CTA1-04 remains rejected after verification: CHANGELOG.md is a 21-byte Git symlink; its frontend/CHANGELOG.md target matches the audited 3,535 bytes/68 lines and `83ad742c…` hash. There is no missing changelog evidence to recreate.
- Use physical dependency copies in worktrees; a node_modules symlink previously failed Turbopack's outside-root check. Builds in this run used only public synthetic .env.example values.
- Private orchestration/review/local-test records are under `/Users/openclaw/Projects/Koaryu-Repo/.git/orchestrator/20260912-budget-refactor/`. Credentials, dumps and hosted operator evidence remain in their existing private operator/backup locations. Do not publish their contents.

Read current AGENTS.md, backend/frontend guidance, the ledger and private operator runbooks before resuming. Check usage before selecting work. Keep one coherent branch per PR, fresh Sol and reviewer threads, exact-head CI and `scripts/merge-release-pr.sh`. Finish the next bounded change safely before starting another.
