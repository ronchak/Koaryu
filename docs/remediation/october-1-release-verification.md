# Completed releases, October 1, 2026 Pacific

This record summarizes the completed operator closeouts for PR255/256/257 and the later PR258 release. It records verification at those release checkpoints. The October 3 documentation refresh did not repeat hosted checks or deploy an application. A later merge to `main` alone does not change the recorded deployed release because production auto-deploy is off.

## Last verified application release, PR258

At `2026-10-02T00:35:25.796398+00:00`, October 1 Pacific, production and staging frontend/backend pairs were verified at `0cf345be94f31eefbfa80be80bed3a8670680bf2`. [PR258](https://github.com/ronchak/Koaryu/pull/258) fixes recurring calendar-slot identity when parallel templates share a program, date and time. Its merged tree equals reviewed head `eec5bf0a4bf5770ba3fdcc3072fee319ed659ab5`; the required [exact-head release gate](https://github.com/ronchak/Koaryu/actions/runs/36899834559/attempts/2) passed.

Both databases remained exact V55, 150 migrations, head `20260930192626`, manifest `release-db-attestation-v55`. Fresh guarded inspections classified both targets as `post`. This application-only release applied no database migration and took no backup.

| Surface | Recorded production deployment | Recorded staging deployment |
| --- | --- | --- |
| Render backend | `dep-davflo1srm7s73bqsdr0` | `dep-davfi9egekts73dsg49g` |
| Vercel frontend | `dpl_GmgxVJLU8B9G56soSfJb7w299Jy9` | `dpl_7EZk2UibZiV5HDghrLP4aTKx2c9Q` |

The served-pair verifier and proxy readiness passed in production/live and staging/test modes. Both production backend readiness routes reported the exact release SHA. The production-target frontend was READY in `pdx1`, with both production domains assigned. The staging frontend required explicit assignment to its stable alias before that alias passed verification.

The staging cron artifact `dep-davfjn6gekts73dsk73g` matched the release. One manual run, `crn-da9k78m7bikc739ijglg-1790900744`, succeeded with claimed, completed, reconciliation-required and failed counters all zero. Its original `staging` branch and five-minute schedule were restored while suspended; the temporary release ref was removed with an exact-SHA lease and verified absent.

At final provider readback, both web services were active with automatic deployments off; production tracked `main` and staging tracked `staging`. Homepage and login HTTP checks, the canonical-domain redirect and browser smoke passed. The recorded browser check found no console errors or warnings. No error patterns appeared in 78 sampled backend log entries, and the frontend error-log query returned no entries in that window.

The browser Sign In link followed an existing session to onboarding. No production studio or calendar records were created. Calendar behavior was covered by exact-head mounted CI regressions; the browser smoke was limited to the public homepage and existing-session navigation. The duplicate main CI run was still running at closeout; the required reviewed-head gate had already passed.

## Preceding V54/V55 rollout

[PR255](https://github.com/ronchak/Koaryu/pull/255), [PR256](https://github.com/ronchak/Koaryu/pull/256) and the supplemental [PR257](https://github.com/ronchak/Koaryu/pull/257) completed at `2026-10-01T08:43:37.364501+00:00`, October 1 Pacific. Production and staging frontend/backend pairs were verified at `bc4f6f8e697acb57406a48ed49f5c61639892448` on exact V55. This application identity was subsequently replaced by PR258.

The [V54 repair record](pr255-pr256-v54-repair.md) preserves the first-attempt incident, full rollback to V53 and missing legacy trigger repair. Staging's already-applied V54/V55 history was not rewritten or replayed. Fresh inspection confirmed its unchanged complete catalog; the maintained hosted contract proof and fresh role checks were reviewed against the final candidate.

Root, Opus 5.5 and GPT 6 Astra approved the final code. The required [PR257 exact-head CI](https://github.com/ronchak/Koaryu/actions/runs/36825293393) passed on `f7c446b9476369f91e04905abc3772d5238b37d7`, and the merged tree matched the tested and reviewed tree. The full proofs covered 150 migrations, 56 SQL contracts, 29 billing concurrency cases, 75 lead-command concurrency cases and the required restore/refusal checks.

A fresh encrypted V53 backup passed disposable exact-image restore, all 16 source comparisons, original V53 readiness and temporary-role/container cleanup at `2026-10-01T08:05:43.135220+00:00`. It is recovery evidence for that completed chain, not fresh proof for another release. The database archive excludes Storage object bytes.

Guarded V54 apply verified at `2026-10-01T08:21:12.333Z`. Its retained-data comparison allowed exactly one intended same-studio source-lead minor-status and update-timestamp correction. V55 verified at `2026-10-01T08:36:25.277Z` and left all 70 retained tables unchanged against its fresh V54 baseline. The complete production fingerprint matched the repository's explicitly approved restored CHECK-constraint representation; staging retained the canonical representation. No production contract SQL, ad hoc repair SQL or historical financial backfill ran. No production billing cron was activated.

Both application pairs, production-target Vercel region and domains, browser homepage smoke and the single zero-work staging cron run passed. Both web services remained active with auto-deploy off; the cron was restored and suspended, and the temporary release/recovery refs were removed with exact-SHA leases. Provider notification email delivery remained unverified.

The recorded review left two moderate development-only ESLint brace-expansion alerts open and documented synthetic birthday-boundary performance limits. Those observations were not dismissed or represented as production measurements.

## Evidence and future releases

The preceding [September 29 release record](everyday-correctness-release.md) remains historical. Credentials, dumps, raw fingerprints, retained-row hashes, provider responses and the original operator closeouts remain in owner-only storage outside the repository. This summary contains release identities and verification results only.

Before another release, derive the exact candidate, live state, inspection tokens, authorization and applicable recovery evidence again. A future backup from V55 requires a reviewed V55/provider-image mapping and a fresh verified restore. Neither completed backup proves a later source state. Follow [Cutover Gates](../cutover-gates.md), including the separate production migration announcements and pauses. Documentation closeout does not authorize another deployment or migration.
