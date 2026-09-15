# Hosted staging rehearsal, September 14

Initial migration candidate: `c1e933f5ddac862ce24387d45609052b8d0baad1`, PR210 merge. Its own Release candidate CI `34839365373` passed. This record describes hosted execution against that immutable candidate, not the later documentation merge.

**Current status: complete hosted database gate; authenticated write/UI rehearsal explicitly waived.** All 53 contracts passed, the staging alias was repaired and the matching staging pair verified. Production subsequently completed V47 and application deployment. See [the production verification](production-release-verification.md). The sections below preserve the earlier failures and stop points as historical evidence.

## Database execution

All nine files were applied separately through the guarded `--one-migration` mode to staging `nxgsektqsgrtyfhawxbc`. Each had fresh inspection, full-suffix and singleton dry-runs, exact-body PR138 OWNER approval, a separate command announcement and 60-second pause, and a verified successor. Production `mimguepumzsgmcaycdsh` was not an execution target.

| Release | Applied version | Verified completion UTC | Provider invocation seconds | Approval |
| --- | --- | --- | ---: | --- |
| V39 | `20260908080420` | 2026-09-14T12:07:45.547Z | 6.291 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5663584807) |
| V40 | `20260908133504` | 2026-09-14T12:19:02.006Z | 7.483 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5663724271) |
| V41 | `20260908183744` | 2026-09-14T12:33:49.597Z | 7.174 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5663936983) |
| V42 | `20260910084231` | 2026-09-14T12:43:32.971Z | 7.270 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5664076583) |
| V43 | `20260910093958` | 2026-09-14T12:55:33.225Z | 7.208 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5664237206) |
| V44 | `20260910135133` | 2026-09-14T13:12:17.451Z | 9.572 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5664455337) |
| V45 | `20260910185031` | 2026-09-14T13:24:33.283Z | 11.404 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5664620947) |
| V46 | `20260914033337` | 2026-09-14T13:35:51.623Z | 9.517 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5664774040) |
| V47 | `20260914055301` | 2026-09-14T13:47:26.020Z | 9.882 | [approval](https://github.com/ronchak/Koaryu/pull/138#issuecomment-5664928323) |

Provider invocation time includes connection and apply. It is an upper bound on lock wait, not a measured lock-wait sample. No migration failed. Final independent inspection reports `state=post`, history `142:d3bab5f085e1c46ce72ab43046b1ca8b`, head `20260914055301`, full V47 provider fingerprint and zero attestation failures.

Each migration preserved the original row hashes in ten tracked tables: 38 students, 40 memberships, 14 payers, 13 invoices, 9 payments, 1 refund, 6 provider operations, 5 operation resources, 5 aliases and 67 audit rows. Every comparison reported zero changed/deleted originals and zero additions. This is scoped retained-row evidence, not a claim to have hashed every database table.

The staging billing cron `crn-da9k78m7bikc739ijglg` was suspended at 11:57:24 UTC. The old staging web service `srv-d98g4kutrd3s73ek0elg` was suspended at 13:15:21 UTC before V45. Read-only checks found zero import runs and zero active import queries, including after the drain. Both remain suspended at the stop. Auto-deploy remains off. Neither application nor the staging branch was promoted.

## Failed contract gate

The hosted runner completed 19 of 53 contract files. File 20, `dashboard_summary_facts_contract.sql`, failed; 33 files were not started. The failure occurred in the small-profile schedule-plan bound at line 618 of the DO block, reported at file line 701.

The captured plan used one attendance Index Only Scan, once, with two actual rows and a studio-only index condition. The test permits one row of attendance work for that fixture. It reported no correlated subplans; recorded query execution was 0.111 ms. The observed two-row scan exceeds the test's one-row bound. This does not establish whether the defect is in the planner-sensitive assertion or the production query. Do not increase the bound, force a planner setting or edit the fixture merely to pass.

The failed DO block was inside `BEGIN`; the connection exited on the error. A fresh retained-row comparison afterward again found no changes or additions in the ten tracked tables. A separate read-only check found zero fixture studios and zero fixture Auth users, confirming the synthetic fixture rollback. The failure remains unresolved. No hosted test retry or repair was attempted.

Next, reproduce the captured plan on a disposable database with representative statistics and inspect the intended work bound. If a correction is justified, make it a separately reviewed PR with behavioral/performance evidence. Then repeat the complete hosted contract gate before resuming application rehearsal. The approved staging-owner password also lacks a confirmed account email; that earlier question remains unanswered. Do not guess among accounts or bypass authentication.

## Evidence and release prerequisites

Private evidence is under `/Users/openclaw/Koaryu Releases/20260914-refund-release`, mode 0700 with files 0600. Per-step files use the predecessor version: `staging-v38-...` through `staging-v46-...` contain inspections, dry-runs, exact approval JSON/API responses and apply audit records. `staging-post.txt` contains the final independent inspection. `staging-retained-paused.json` is the original comparison baseline; `staging-v39-rows.json` through `staging-v47-rows.json` and `staging-after-contracts-rows.json` contain comparisons. `staging-contracts.log` retains the complete failure and query plan. Do not commit these operator files.

The written per-migration recovery plan remains in [PRODUCTION-RELEASE.md](PRODUCTION-RELEASE.md#per-migration-recovery-checkpoints). Fresh production backup/verified restore, authenticated staging application rehearsal and the controlled production write window remain unfulfilled. Closing read-only inspection confirmed production at V38 with all nine files still pending; the deployed-release verifier confirmed both production applications at `c5742fe393a8bfb3a1faddb1f488e46a00bd5091`. Evidence is `production-stopped-inspect.txt` and `production-stopped-pair.txt`. Production has not started, so no production completion-cost estimate or approval has been asserted. The budget amendment never waives these technical gates.

## Closeout validation

This closeout changes only documentation and release tracking. Product, migration and test files are unchanged, so source/test line and case counts stay flat. Local release-workflow checks passed all 131 cases; attestation checks passed all eight cases and reproduced 25 SQL statement bodies, ten historical restore scripts and seven generated continuations identically. All 278 audit entries and all seven program dispositions were compared with the candidate; none changed. Fresh independent review and the closing PR/main exact-head CI are recorded in GitHub and the closing report. They validate the documentation candidate, not the failed hosted gate.


## Resumed execution and alias stop, September 14

PR212 corrected the planner-sensitive dashboard contract. On its merge `7209e2a...`, all 53 hosted files were attempted: 51 passed; reconciliation inventory and profile-backfill fixtures failed against existing staging data. PR213 fixes those test inputs without runtime or migration changes. Its final head `c0d7559542cd4887aea9a48b10b528fe5726f0bd` passed fresh independent review and exact-head CI `34902266976`; guarded merge produced `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`. That main commit passed its own CI `34903006341`.

The final fixture probe reproduced both original failures on disposable PostgreSQL 17, passed the corrected files on empty/populated targets, and passed all 53 files with retained background rows unchanged. On the merged candidate, the complete hosted suite then passed all 53 files in order. Pre/post inspection reports exact V47 and an identical provider fingerprint. All original hashes in the ten tracked tables remained unchanged, with no additions. The initial failed attempts remain failures, not substituted evidence for this complete pass. SQL fixture transactions can advance sequence counters despite rollback; the row comparison does not claim sequence values stayed fixed.

The owner-authorized Sol recovery on the MacBook Air found the original staging-owner credential pairing. A read-only Auth lookup verified that account; the correctly paired login and later refresh succeeded. The earlier failed login used another account and was not retried. Twelve release credential entries were copied into the Home Server login Keychain and read back byte-for-byte. The historical production application-test password was not recovered; provider/backup credentials are available. No password, account or access grant was changed.

After the contract and catalog checks passed, the coordinator resumed only staging web at 22:23 UTC. Readback at 22:24:01 confirmed web active, cron suspended and both auto-deploy settings off. Backend deployment `dep-dak78k5g1s2s738gbivg` completed at 22:26:20 UTC. Both backend readiness URLs report `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`, staging and Stripe test. The owner session's read-only program/ladder API requests returned 200.

The explicit-lease staging-branch push moved `f35395a5700876f6490336ae400c09849a368204` to `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`. Vercel built staging deployment `dpl_Cm7wLHQTo3SdqLH8RvrM9iszGE5j`, whose unique URL reports the new candidate. The build is READY and lists the expected automatic alias, but its assigned alias list is empty. At 22:31:18 UTC the normal staging `/api/version` still reported `f35395a5700876f6490336ae400c09849a368204`, while the backend and unique frontend URL reported `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`. Both frontend responses were cache MISS. The exact-pair verifier failed, so application write rehearsal stopped before its first mutation. No alias reassignment or replacement deployment was attempted.

The proposed next step is a bounded staging-alias repair, followed by the exact-pair verifier. See [HANDOFF.md](HANDOFF.md). Production remains V38 with the previously verified `c5742fe...` pair. Fresh backup/verified restore, the controlled production write window and authenticated workflow rehearsal remain outstanding. No production chain was started, and no completion-cost estimate or production approval was asserted.

Private evidence: `hosted-fixture-final-probe.log`, `hosted-fixture-review-result.md`, `merge-213.log`, `staging-138f-contracts.log`, `staging-138f-pre.txt`, `staging-138f-post.txt`, `staging-138f-before-contracts.json`, `staging-138f-after-contracts.json`, `staging-138f-backend-deploy.json`, `staging-138f-backend-readiness.json`, `staging-138f-branch-push.txt`, `staging-138f-vercel-state.json`, `staging-138f-pair.txt` and `staging-138f-pair-failure-readback.json`. Credentials and session files stay private. The browser connection was prepared, but no application page interaction or browser login was performed.

Closing read-only checks confirmed production at exact V38 with all nine files pending and its unchanged `c5742fe...` application pair. Evidence: `production-138f-stop-inspect.txt` and `production-138f-stop-pair.txt`. A separate alias readback at 22:37:28 UTC still returned `f35395a`; the mismatch persisted after the build completed.

## Owner-authorized completion

On September15, Astra repaired the staging alias and the exact staging pair passed at `138f8ca`. The owner waived authenticated staging write/UI rehearsal; none was performed. Production then completed the nine separate V39–V47 applies and application deployment at `a4ef259`. The previous alias stop is resolved. The final production verification record is authoritative for current release state.
