# Everyday correctness release, September 29, 2026

This historical release completed on September 29. At closeout, production and staging frontend/backend pairs served `55a652a6e4f368b07286181ffa8e2401f4b9c467` on V53, 148 migrations, head `20260929152445`, manifest `release-db-attestation-v53`. Both web services were active with auto-deploy off. The staging billing cron had its original branch and five-minute schedule restored and was suspended. The later [October 1 release record](october-1-release-verification.md) records the V55 rollout and PR258 application release.

[PR253](https://github.com/ronchak/Koaryu/pull/253) merged as this release SHA. Its tree equals tested head `da27f15ed404b682d6f5bc2da759f87e04d0c74a`. [Exact-head CI](https://github.com/ronchak/Koaryu/actions/runs/36602895637) passed all jobs. The closeout's proposed dependency update was separate from this deployment and was later superseded as described below.

## Delivered behavior and proof

[Implementation verification](everyday-correctness-verification.md) maps the 16 original audit observations and PROGRAM-IMPORT-01 to their fixes. The audit ledger now has 165 fixed and 97 pending observations; program findings are separate, with six fixed and one intentionally deferred. Other pending observations were not closed by association.

The combined frontend passed 1,033 tests, build, lint and formatting. The backend passed 2,052 tests, formatting and generated API contracts. Independent Opus reviews passed for the frontend, backend/business SQL and release metadata. Sol managed the streams and implemented bounded backend/tooling work.

The complete strict local run passed on unchanged head `da27f15`: all 148 migrations, 56 SQL contracts, historical canonical/logical restores, attestation tampering and concurrency checks, including 67 lead-command cases. The disposable cluster was removed. CI caught an obsolete-readiness fixture whose exact-history list ended at V52; adding V53 preserved every refusal assertion. The corrected head passed the entire local run and new CI.

## Staging release

V52 and V53 were separately inspected, dry-run, authorized with fresh state-bound records and applied through the guarded tool. All 940 original rows across the recorded 69-table scope were unchanged after each migration and again after all 56 hosted staging contracts. Six real PostgREST role/schema checks passed, including service-only V34 readiness and lead-receipt access.

- Backend `dep-dau16rvlk1mc73d9r6rg` serves the release SHA.
- Frontend `dpl_E58SdixVikXPJyP27FvH1qGvCSAj` is READY in `pdx1`. The branch push left the stable staging alias on an older artifact. Provider and unique-URL readbacks identified the correct new build, the alias was explicitly assigned, and the literal pinned-pair verifier then passed in test mode.
- Cron artifact `dep-dau18jgu01pc73asc980` matches the release. Exactly one manual run, `crn-da9k78m7bikc739ijglg-1790710949`, succeeded with claimed, completed, reconciliation-required and failed counts all zero. The temporary pinned branch was removed; original cron settings were restored while suspended.
- Ten authenticated workflow checks passed: dashboard/roster inactivity parity at 14/30/90 days, missing/explicit Program import preview, atomic follow-up, identical-key replay, replay preserving a newer lead row, changed-payload refusal and absent-lead HTTP 404. The uniquely marked lead and its cascaded activities/receipt were removed. The task session was signed out locally and its token file deleted.

The first private smoke assertion expected one total history row for an advancing follow-up. The intended command records one stage change and one follow-up. The checker was corrected to require exactly those two events; both attempts' fixtures were cleaned. No application code changed for this correction. Hosted workflow proof used API calls; mounted UI proof is recorded separately above.

## Production release and recovery

Owner ronchak authorized the root coordinator to execute the release autonomously. The stale human-only migration restriction was removed from the global/private guidance. Every technical gate remained. Each of V51, V52 and V53 had its own inspection, dry-run, exact authorization/confirmation, 30-second announcement pause, guarded apply and verified successor.

The API was suspended at `2026-09-29T20:07:08Z`; provider readback confirmed auto-deploy off and zero in-flight API transactions. A fresh V50 backup was created under `/Users/openclaw/Koaryu Backups/production-20260929T200939Z`. Its restore proof was verified at `2026-09-29T20:10:46.996045+00:00`: all 16 comparisons, original V50 readiness, encrypted archive, temporary-role cleanup and disposable-container cleanup passed. The exact source image was `17.6.1.155`, digest `sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b`.

All 2,685 original rows across the recorded 69-table scope remained unchanged after each production migration. The new receipt table was empty before application release. The final raw production fingerprint matched the approved staging contract. No contract SQL ran against production, no financial history was backfilled and no billing activation or secret changed. The row scope includes public/private customer tables, Auth users and Storage metadata; it excludes release expectation rows and provider session/operational tables.

The API resume was accepted at `2026-09-29T20:49:41Z`. Render built current `main` on resume despite auto-deploy being off, creating `dep-dau28p942hec73di3bu0` with trigger `service_resumed`. The probe expecting the previous SHA stopped. Read-only diagnosis confirmed the exact intended release SHA, active service, auto-deploy off, production environment and live Stripe mode on both readiness URLs. No redundant explicit backend deployment was issued.

A fresh production-target Git build created frontend `dpl_AtSRDMutB91JprFhUFDShqn81Qf9` in `pdx1`, with production variables and both `koaryu.app` and `www.koaryu.app`. No preview was promoted. The literal production pair verifier passed at the exact release SHA. Home and login returned 200, signed-out dashboard returned 307 to login, and the sitemap returned valid XML with 14 canonical URLs.

The pre-chain snapshot is a verified recovery point, not an approved down-migration or automated hosted restore. Restoring it can lose later writes. The database archive contains Storage metadata, not object bytes. At this closeout the private backup helper had reviewed source mappings through V50. The subsequent V53 backup and recovery proof belong to the [October 1 release record](october-1-release-verification.md). Future backups require a reviewed mapping for their actual source and provider image. Do not reuse this release's tokens or proof as authority for a later state.

Private operator commands, raw fingerprints, row hashes, credentials and provider responses remain outside the repository under `/Users/openclaw/Koaryu Releases/20260929-everyday-correctness`. The final usage meter and organization record are in the private run closeout.

## Historical dependency-maintenance proposal

The original closeout audit detected CVE-2026-102274 in PyJWT 2.13.0 after the application candidate's earlier audit had passed. The initial [PR254](https://github.com/ronchak/Koaryu/pull/254) proposal updated the PyJWT input pin and both hash locks to 2.14.0. The [upstream advisory](https://github.com/jpadilla/pyjwt/security/advisories/GHSA-w6j9-cwv2-h6wq) concerned malformed keys aborting whole-JWK-set parsing. The recorded independent review found no demonstrated application path through Koaryu's single-key selection and normalized construction errors.

The original isolated Python 3.11 environment passed installation, dependency consistency, reproducible lock generation, both dependency audits, 32 direct security tests, 11 authentication tests and all 2,052 backend tests. Those results describe that earlier proposal. Main subsequently moved to PyJWT 2.15.0 in [PR256](https://github.com/ronchak/Koaryu/pull/256), which was included in the completed October 1 release. The refreshed PR254 preserves main's dependency files exactly and contains documentation only.
