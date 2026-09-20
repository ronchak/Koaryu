# Koaryu release handoff

## Live state

The production release completed September15, 2026. Both `https://koaryu.app` and the production backend report `a4ef25910e76ed4b4111699f7b61ff02c30a67a0`, environment production. Both backend readiness paths and the frontend's `/api/proxy/health/ready` passed. Vercel built a new production-target artifact in `pdx1`; no preview was promoted.

Production database is V47: 142 migrations, head `20260914055301`, manifest `release-db-attestation-v47`, zero security failures. Nine separate guarded applies completed, each after its own 30-second announcement and followed by a row comparison. All 1,163 tracked original business rows across ten tables remained unchanged, with no additions. The final fingerprint matches the existing reviewed restored-production variant; no expectation was relaxed. See [verification](production-release-verification.md).

Staging database is also V47, with both applications at `138f8ca75b20fe9c3d233a6c5bacfe7fe597ecd3`. Its normal alias was repaired and the exact pair passed. Both web services are active. Staging billing cron stays suspended; production billing scheduler stays disabled. Production auto-deploy stays off. No live billing activation, financial backfill or synthetic production write occurred.

## Source, PRs and budget

Deployed candidate: `a4ef25910e76ed4b4111699f7b61ff02c30a67a0`, PR215 head, independent review and exact-head CI `34922721974` passed. Main before the single bookkeeping closeout: `5e22ef6cddf226e80054d18981860bbd4313742d`, PR215 merge, own CI `34923265249` passed. The final report identifies the bookkeeping PR/merge; it does not change the deployed candidate.

PR207/209 delivered V46 refund recovery and V47 completion locking. PR208/210 delivered owner-authorized single-file execution. PR212/213 repaired the hosted contracts; all 53 staging files passed before production. PR215 allowed the owner's direct production authorization without a per-migration GitHub comment, preserving target/source, inspection, restore, one-file, confirmation and successor guards. Staging comments remain required; supplied production comments still receive full validation.

Original weekly baseline remains 51% used. At 04:19 UTC the meter was 86% used, or 35 of the authorized 45 points. Read the live meter before new work; the final report records the last reading. Earlier 30/35/40 limits are superseded for this run. The helper `.git/orchestrator/20260914-refund-release/usage.py` still prints old stop labels: use its raw meter and the current owner's budget, not those old labels. Weekly reset is September 19 at 10:16:57 UTC.

Canonical repo: `/Users/openclaw/Projects/Koaryu-Repo`. Current execution evidence: `/Users/openclaw/Koaryu Releases/20260915-astra-production`. Older staging evidence: `/Users/openclaw/Koaryu Releases/20260914-refund-release`. Credentials, dumps, sessions and raw operator records stay outside Git.

## Backup and recovery

Fresh pre-V47 snapshot: `/Users/openclaw/Koaryu Backups/production-20260915T030226Z`. Disposable restore verified at 03:03:28 UTC. All 16 comparisons, source V38 readiness, archive/helper/image hashes, backup-role removal and restore-container cleanup passed. Production web was paused from 03:01:04 until 04:09:56 UTC, covering the snapshot and migration row comparisons.

The private helper supports the old V38 source, not a new V47 backup. Do not run `backup --count 133` against current production. The next bounded maintenance change should add reviewed V47 source/readiness support with a disposable proof, because future backups must attest today's schema. This was not started during release. Keep the verified pre-V47 recovery snapshot; a restore can lose later writes. There is no approved down-migration or automatic hosted-restore command. Do not improvise recovery.

## Deliberately skipped

The owner explicitly waived authenticated staging write/UI rehearsal after all 53 hosted contracts passed, removed the go/no-go approval checkpoint and per-migration production GitHub comments, and removed mandatory pauses on staging/non-migration actions. Only production applies retained 30-second windows. Documentation-only closeout does not require waiting for full CI; branch protections and auto-deploy checks remain.

The production application-test password is still missing. It was not hunted, reset or provisioned. Existing provider/backup credentials are available, with 12 verified Keychain entries. Staging owner authentication was recovered and verified earlier; no authenticated write rehearsal was claimed. The fresh Sol task refused on an instruction-role misclassification before any external mutation; the owner explicitly returned execution to Astra. Private/global human-only policy text was not edited to force a model to proceed.

## Exact ledger counts

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

Seven separate program findings: fixed Astra 3/Sol 2; pending Astra 1/Sol 0; deferred intentionally Astra 1/Sol 0. PROGRAM-IMPORT-01 remains pending. PROGRAM-CURRENCY-01 is intentionally deferred after the USD-only production query; BB2-08 is corrected in V49. PROGRAM-ACTIVATION-01 is corrected in V48 code and awaits the current combined production release. No new audit risk was accepted or closed in this production run.

Audit batches remain outside this release. Batches 01, 02, 03, 05, 08, 09, 10, 12, 13 and recipes 14/15 are complete. Batches 04, 06, 11 retain BT4-06, BT3-07 and FC3-08 behind database prerequisites. Batch 07 retains FT1-11/FT2-08. The original 55-finding cohort remains 49 fixed, one obsolete and five pending. Use [the batch index](delegated/README.md).

## Traps

- Do not reuse completed apply scripts or inspection tokens. All nine files are applied. `pending_versions` in the preflight is a declared historical list, not an unapplied count; compare it with generated readiness metadata.
- The known restored-production constraint fingerprint differs from canonical staging. Use the existing reviewed variants; never normalize an unexpected mismatch away.
- A provider READY state does not prove a domain moved. Verify the durable URL, exact SHA and environment. Staging needed explicit alias assignment; production assigned its domains correctly.
- Old V38 readiness compatibility does not restore legacy import writes or give old split writers the new guarantees. Use the packet's recovery limits.
- The private backup helper's disposable target must never become a hosted restore target. Future post-V47 backup support remains unimplemented.
- No task migration, database proof or deployment process remains active after completion. Confirm refs and worktree state before a new run; do not infer local database state from old disposable probes.
- DOC1-05 remains owner action. The plain-HTTP `crypto.randomUUID` issue and restore-script duplication remain unstarted. Formatter and timing-test fixes landed earlier. The old refund-refresh test race remains an unverified concern despite passing subsequent CI; do not weaken financial assertions to hide it.
