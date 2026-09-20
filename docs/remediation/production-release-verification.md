# Production release, September 20, 2026

Production and staging are V49, 144 migrations, head `20260920052705`. Both application pairs serve `591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5`. Production's two backend readiness URLs and frontend proxy passed; its frontend is a new production-target Git build in `pdx1`. The [September 15 V47 record](production-v47-verification.md) is historical.

## Source and verification

PR216 closed the earlier release record. PR217 corrected seven obsolete service references; the other ten matching references name valid tests. PR218 patched AnyIO to 4.14.2 after new security advisories blocked CI. PR219 fixes activation retry quantities and closes BB1-06 / PROGRAM-ACTIVATION-01. PR220 records only confirmed subscription facts and closes BB2-08.

Final reviewed head `591e6299a5d56dcd2623bdc144f5cd5e1dabc9c5` passed independent review and exact-head CI `35494455293`, including 1,913 backend tests, frontend checks, security audits and the database suite. Main merge `c1e1c27c4a3071556958352207da2a435887276b` has an identical tree and passed CI `35494772358`. The complete local gate passed all 144 migrations, 54 SQL contracts, restore continuations, tamper checks and concurrency proofs. All 54 hosted staging contracts also passed, with 909 original rows unchanged across 69 tables.

The fresh subscription reviewer caught a null-fill race before release. Conditional null checks now protect the actual update. A lost race enters the existing durable webhook retry path; replay preserves the winner and applies the remaining term and status. The two subscription test files grew from 938 to 1,210 lines and 19 to 23 methods, including 15 new parameterized subcases. Activation added five backend cases; its five measured test files grew from 7,477 to 7,787 lines. These are financial/retry contracts, not source-text assertions. The activation database proof grew from 23 to 27 cases.

## Backup and production applies

Owner `ronchak` authorized coordinating executor `Astra-release-20260920` under the standing PR215 process. Each apply received a separate exact-command announcement and 30-second interruption window. There was no production approval-comment requirement and no bulk apply.

The API was suspended at `2026-09-20T07:17:11.442168+00:00`; a fresh read found zero in-flight API transactions. The verified pre-chain backup is `/Users/openclaw/Koaryu Backups/production-20260920T071743Z`, restored at `2026-09-20T07:18:45.637373+00:00`. All 16 comparisons, source V47 readiness, encryption, temporary-role removal and disposable-container cleanup passed. Proof SHA-256: `0c752cc6db339f147ecc0495a903903281503200347dcc1334060ee6a86a0b32`. Image: PostgreSQL `17.6.1.155`, digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`.

| Apply | Started UTC | Verified UTC | Original rows |
| --- | --- | --- | --- |
| V48, `20260920035023` | 07:23:25.059 | 07:25:34.742 | All 2,684 unchanged |
| V49, `20260920052705` | 07:32:37.662 | 07:34:51.970 | All 2,684 unchanged |

The comparison covered every public table, private tables except release-attestation expectation tables, `auth.users`, `storage.buckets` and `storage.objects`: 69 tables. Both comparisons found zero changed/deleted rows; final row hashes exactly equal the pre-chain hashes. Provider operational/session tables were outside this comparison. The complete backup separately covered the database.

The final production preflight independently returned ready, count 144, head `20260920052705` and no security failures. The guarded tool accepted its reviewed restored-production fingerprint. No expectations were loosened or historical financial records backfilled.

## Applications and remaining limits

The API resumed at `2026-09-20T07:35:57.029065+00:00`. Render deployment `dep-danopu98h0ls7388uqrg` became live at `2026-09-20T07:37:22.428905Z`. Both backend readiness paths then reported the exact candidate, production and the existing Stripe live configuration.

Vercel deployment `dpl_6gsv6BmcXYzQ3tFTQvSPFGiZBBfK` reached READY at `2026-09-20T07:39:22.784000+00:00`, using production variables and region `pdx1`. It assigned `koaryu.app`, `www.koaryu.app` and `koaryu.vercel.app`. The exact-pair verifier and frontend proxy check passed. No preview was promoted. The temporary old-frontend/new-backend pair existed only during the authorized deployment transition.

Staging backend `dep-dano4p6gekts739k0f5g` and frontend `dpl_Fmz3gcrAbzY3x7uQrdxhQx4g6uwx` serve the same candidate. Vercel did not assign the staging alias automatically; the separately authorized alias assignment completed before pair verification. Both web services are active. The staging billing cron stays suspended and production's billing scheduler stays disabled. No live billing activation or synthetic production application write was performed.

[The live measurement record](live-measurement-20260920.md) reports the available provider numbers and the unmeasured navigation/FCP/LCP results. The USD-only production query deliberately leaves mixed-currency totals and decimal formatting deferred. Authenticated write/UI rehearsal was not performed or claimed; no production test password was hunted or changed.

Private commands, approvals, backup proof, row hashes and provider records are in `/Users/openclaw/Koaryu Releases/20260919-live-corrections`. Do not reuse completed apply scripts or inspection tokens. [The packet](PRODUCTION-RELEASE.md) records recovery limits; [HANDOFF](HANDOFF.md) records the remaining program and budget.
