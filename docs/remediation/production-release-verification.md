# V50 release verification, September 20, 2026

All seven queued findings are released. Production and staging are V50, 145 migrations, head `20260920154441`, manifest `release-db-attestation-v50`. Both frontend/backend pairs serve `dce52efff1d28358eca421769d00791b60045c6c`. Production readiness, frontend proxy, production environment and Vercel `pdx1` passed. The earlier [V48–V49 release](production-v48-v49-verification.md) and [V47 release](production-v47-verification.md) are historical.

## Reviewed candidate

PR227 head `dce52efff1d28358eca421769d00791b60045c6c` passed independent review and exact-head CI `35531096941`, including 1,930 backend tests and 904 frontend tests. Main merge `7d7308afe8c77578094db8ffb81ee0c9a9e37fe2` has an identical tree and passed CI `35531485667`. [The queued-finding record](queued-findings-verification.md) gives each PR, finding, test change and review boundary.

The complete local replay passed all 145 migrations, 54 SQL contracts, historical canonical/restored continuations, negative attestation checks and concurrency proofs. It used PR226 head `f9683f1acbfda3d5dd485c8851032fc6a2c94006`; database and verification source are byte-identical in the final candidate. The focused tamper proof passed 99 routine mutations; the complete gate also passed four subscription-term mutations. Both task-owned local clusters were removed.

## Staging

The guarded single V50 apply started at `19:14:14.722Z` and verified its exact successor at `19:16:19.815Z`. All 909 original rows across 69 tables remained unchanged after the apply and again after all 54 hosted contracts passed. The staging backend was paused during these checks, then resumed.

Backend deployment `dep-dao356tg1s2s7398p0q0` became live at `19:24:07.085484Z`. Both readiness paths reported the candidate, staging and Stripe test configuration. The staging Git ref advanced from the observed predecessor with a lease. Frontend deployment `dpl_2oeiQEwyThyNcL9RJweUPbENNhff` was a staging-ref build, READY in `pdx1`; its stable alias was explicitly assigned. Final exact-pair verification passed. No authenticated application-write rehearsal was performed or claimed.

## Production recovery proof

Production was paused at `19:30:16.448945Z`. Readback confirmed suspension, auto-deploy off and zero in-flight API transactions before the snapshot.

- Fresh source V49 backup: `/Users/openclaw/Koaryu Backups/production-20260920T193053Z`.
- Disposable restore verified at `2026-09-20T19:31:54.106814+00:00`.
- All 16 source comparisons, original V49 readiness, encryption and temporary-role/container cleanup passed.
- Image `docker.io/supabase/postgres:17.6.1.155`, digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b` matched the provider and local image.
- Reviewed helper SHA-256: `b41804434187298caef90b8d1730c5ec14ffb64238b03b5faa9fee06bc81016c`. The isolated [mapping patch](operator-backup-v50.patch) adds V50 support without changing earlier mappings, comparisons or cleanup.

`backup.json` retains the creation-time `BACKUP_COMPLETE_RESTORE_PENDING` label. The subsequent `restore-proof.json`, restored-readiness result and cleanup records are the completed proof. A mapping or copied label alone is not proof. The database archive does not include Storage object bytes; the [retained Storage procedure](../staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure) still applies.

## Production apply and deployment

The coordinating Astra executed the owner-authorized command after a separate 30-second announcement. It selected only V50. The tool recorded owner `ronchak`, executor `Astra-queued-release-20260920`, exact candidate, inspection token, immutable source manifest, actual provider output and verified successor.

| Step | UTC result | Evidence |
| --- | --- | --- |
| V50 apply started | `19:35:52.639Z` | One migration selected |
| Provider apply returned | `19:36:02.057Z` | Exit 0 |
| Exact successor verified | `19:38:27.753Z` | V50 and expected raw fingerprint |
| Original-row comparison | After verified apply | All 2,684 rows across 69 tables unchanged |
| Backend resumed | `19:40:17.113432Z` | Active, auto-deploy off |
| Backend candidate live | `19:41:50.236708Z` | `dep-dao3ddaeshcs738t8e10` |
| Frontend candidate READY | Production-target Git build | `dpl_Cwdw9kVZvqNhTFNDefaBn336EyXA` |

The tracked row scope includes public/private customer tables, Auth users and Storage metadata. It excludes attestation expectation tables and provider session/operational tables. The independent final preflight returned ready, count 145, head `20260920154441`, V50 manifest and no security failures. No customer data or financial history was backfilled.

Both production backend readiness paths report the candidate and production. The frontend was built with production variables, is READY in `pdx1`, and owns `koaryu.app` and `www.koaryu.app`. The exact deployed-pair verifier and `/api/proxy/health/ready` passed. The planned old-frontend/new-backend overlap ended with matching SHAs.

Both web services are active with auto-deploy off; the staging billing cron is still suspended. The production scheduler has no explicit Render override in the paginated environment read and defaults to false in the reviewed application, matching the manifest. No provider configuration, live billing activation, currency conversion, historical financial backfill, mail or DNS was changed.

Private commands, fingerprints, row hashes and provider responses are under `/Users/openclaw/Koaryu Releases/20260920-queued-findings`. [The completed packet](PRODUCTION-RELEASE.md) records ordering and recovery limits. No post-V50 backup has been taken; a future release needs fresh evidence. There is no approved down-migration or automated hosted restore.
