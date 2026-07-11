# Release Ledger

This ledger ties every environment change to an exact commit, database migration head, operator, verification record, and rollback target. Update it in the same PR as release-affecting work; never include secrets or production PII.

## Wave 0 Evidence — 2026-07-10

Operator: `Ronak Chakraborty / Codex session`

### Production Baseline

- Environment: production (`koaryu.app`, Vercel frontend, Render backend, Supabase `mimguepumzsgmcaycdsh`).
- Application commit: `c9cc18a4d021662c46f0b76fadb7266503db21cb` on both Vercel and Render.
- Repository migration head: `20260710010500_fix_first_occurrence_series_delete.sql`.
- Production migration head: `20260710010735 fix_first_occurrence_series_delete`.
- Migration status: **diverged** at the final two identities, even though schema behavior may match:
  - Repository `20260710001153_atomic_recurring_session_materialization.sql`; production `20260710010051 atomic_recurring_session_materialization`.
  - Repository `20260710010500_fix_first_occurrence_series_delete.sql`; production `20260710010735 fix_first_occurrence_series_delete`.
- Deploy time: Vercel created the current production deployment at `2026-07-10T06:11:06Z`; Render started its automatic deploy at `2026-07-10T06:11Z` and marked it live at `2026-07-10T06:12Z`.
- Verification: exact Vercel and Render SHA recorded; production migration list compared with the repository.
- Rollback: no production deploy occurred during this evidence step. The next production release must name a previously verified application SHA and a schema-compatible recovery action before deploy.
- Gate: closed to further production migrations until the divergence is understood, rehearsed in staging, explicitly approved, and reconciled.

### Current Staging Baseline

- Environment: `koaryu-staging`, Supabase `nxgsektqsgrtyfhawxbc`.
- Migration/application baseline commit: `c9cc18a4d021662c46f0b76fadb7266503db21cb`.
- Sanitized-seed repair revision: `bca10d223ae0594d1bb6d659d2ede8606caa9c66` on `codex/production-remediation-wave0`; this repair is not present in the migration/application baseline `c9cc18a`.
- Migration state: all 80 repository migrations replayed into a fresh project.
- Billing: test Stripe only; production Supabase, live Stripe keys, and production webhook destinations are prohibited.
- Data status: production-derived rows do not remain in this project. The only tenant is the synthetic `River City Martial Arts` fixture: 32 students, 20 guardians, 296 attendance rows, 36 class sessions, 9 leads, 1 staff role, and 7 billing payments.
- Created at: `2026-07-10T02:33:20Z`. A branch-scoped Vercel preview is isolated to this staging Supabase project and test Stripe configuration. No staging backend exists yet, so the application-isolation deploy gate remains blocked until the dedicated backend is created and verified.
- Verification: migration replay completed against the staging ref; database lint returned no errors and the two previously audited warnings; the sanitized seed completed, including an idempotency-protected external-payment fixture.
- Rollback: delete only the confirmed staging project, recreate it, and replay repository migrations. Do not restore the production logical backup into ordinary staging.

### Restore Drill Evidence

- Temporary target: hosted Supabase project `zmmacdleiaohvxdubrav` (deleted after validation).
- Backup: `$HOME/Koaryu Backups/production-20260710T070020Z`.
- Encrypted artifact hashes:
  - `data.sql.gpg`: `5ab64aaf4b9e3e95c83fe025e15ab8e6638bd6c3e47e86e9dc26cf8bb9e56163`
  - `roles.sql.gpg`: `0748bc19b318551cb1db16617d2c7b16a2ab2423e0bdfb5950c243e82fbc4cdc`
  - `schema.sql.gpg`: `22fe1b7612f84dbc40c8c196dedbbf9280adbc55fb1b4e8174ea072d9e9a0f8e`
  - `record-classification-manifest.json.gpg`: `83854854d34387a73777e8f80c7cddb9940b7ae62c8012d87dc89b1560e0b167`
  - `storage-objects.tar.gpg`: `f3d10e37ba2735eec46f7d21399323e6ad7ef3276ba8b580203b568531c9ab7e`
- Record classification: 384 identifiers inventoried with conservative explicit-marker rules. Unknown remains preserved: 60 auth users, 39 studios, 39 subscriptions, 1 payment account, and 49 live-mode Stripe events remain `unknown`; no record is approved for deletion or anonymization.
- Encryption: GnuPG 2.5 AES-256/OCB authenticated encryption; the AEAD migration was verified plaintext-equivalent before the older CBC artifacts were removed.
- Restore method: PostgreSQL 17 `psql`, single transaction, `ON_ERROR_STOP=1`, roles then schema then data with replication triggers disabled for the data load.
- Authentication coverage: the encrypted data dump contains 22 `auth` table copy blocks and 61 `auth.users` rows; the restore count matched.
- Storage coverage: the encrypted data dump contains five Storage metadata table copy blocks, with zero `storage.objects` rows in this capture. Future dumps exclude object and transient multipart rows so the Storage API can recreate metadata without duplicate conflicts. The private `student-photos` bucket was independently listed through both the Storage REST API and linked CLI and contained zero objects/zero object bytes; the authenticated storage archive records that complete one-bucket inventory for future restore comparison. A temporary second staging bucket with a nested synthetic image proved all-bucket enumeration, per-bucket counts, backup and restore CLI copy directions, exact bucket-set comparison, and byte-for-byte recovery; the object and temporary bucket were deleted afterward.
- Verification: 37 `public` tables, 61 authentication users, and 52 studios. An authenticated tenant-safe application read was not completed against the temporary restore target and remains required in the next drill.
- Cleanup: temporary restore project deleted; fresh current staging recreated separately from repository migrations.
- Off-site copy: pending; the encrypted backup currently has only the local path above, so off-site recovery is not yet proven.
- Production impact: none. No production record was deleted or anonymized.

## Production-Readiness Orchestration Reconciliation — 2026-07-11

Operator: `Ronak Chakraborty / Codex session`

- Repository baseline: `main` is `49feb90f98c0b83ef6b3f38f43cb85e8e76ceb68`. The Wave 0 staging and recovery foundation merged as `cebf7bef15e142e395e7e42c127a9c7daecdfab6`; `49feb90` subsequently removed generated Supabase CLI state from version control without adding a database migration.
- Deployment evidence: GitHub records a successful Vercel Production deployment for `49feb90` created at `2026-07-10T23:31:24Z`. This proves the deployment record succeeded, not that the production alias still targets it. Render's exact currently deployed SHA has not yet been captured for `49feb90`, so frontend/backend application alignment remains unverified and this entry does not supersede the last exact two-provider verification recorded above at `c9cc18a`.
- Migration evidence: a guarded read-only `supabase migration list --linked` against production reconfirmed the same two divergent identity pairs recorded above. No production migration or migration-history mutation was performed:
  - repository `20260710001153`; production `20260710010051`
  - repository `20260710010500`; production `20260710010735`
- Migration reconciliation package: [the history-only comparison, rehearsal, failure analysis, exact action, and approval scope](production-migration-reconciliation.md) is prepared under issue [#20](https://github.com/ronchak/Koaryu/issues/20). Production execution remains unapproved and the gate remains closed.
- Application work: PR #13 and PR #14 are both draft, conflict with current `main`, and are not release candidates. PR #13 has four unresolved actionable review threads; PR #14 requires the recorded per-dataset readiness redesign.
- Managed release program: GitHub epic [#19](https://github.com/ronchak/Koaryu/issues/19) tracks focused gates [#20](https://github.com/ronchak/Koaryu/issues/20) through [#35](https://github.com/ronchak/Koaryu/issues/35), including candidate-wide CI/merge controls, evidence required to close each gate, explicit execution ownership, dependencies, and reserved production-action boundaries.
- Release status: **blocked**. Further production migrations remain prohibited; live billing remains closed; unknown production records remain untouched. No production configuration, data, Stripe, or infrastructure mutation occurred during this reconciliation.

## Staging and Recovery Gate Audit — 2026-07-11

Operator: `Codex release orchestrator`

- Gate [#21](https://github.com/ronchak/Koaryu/issues/21) staging resources: Supabase `nxgsektqsgrtyfhawxbc` is `ACTIVE_HEALTHY`; the dedicated backend API is `https://koaryu-staging.onrender.com/api/v1`; the protected Vercel alias is `https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app`.
- Proven checks: backend `/api/v1/health` returned `200`; unauthenticated auth/profile and students requests returned `401`; exact staging-origin CORS preflight returned `200`; production-origin preflight returned `400` without an allow-origin header. Branch-scoped Vercel metadata points to staging Supabase and matching non-production backend/site destinations without exposing values marked sensitive.
- Application alignment gap: Vercel deployment `dpl_AXrjgCKzsFr6q3V2AKTU3hJjgYTa` is `READY` but built from `b78cb9863e226d17dc242259cf7099e62c6ccfd5`, while the audited repository head was `714ce8aec87ec33300181c7fc5a933c3ad5e05fc`. Render's exact deployed SHA is not captured. The current candidate is therefore not aligned or deployed to staging.
- Isolation-control change: `scripts/verify-staging-isolation.mjs` now fails closed on production Supabase/origin/backend destinations, live Stripe key prefixes, mismatched application URLs, incorrect platform/Connect webhook destinations, preview mode, and demo-reset configuration. Its automated negative tests are part of `npm run check:env-examples`.
- Gate #21 remains **open** pending authenticated Render/Stripe metadata, both test-mode webhook destinations and delivery evidence, exact current SHA on both providers, an authenticated frontend/API proxy and representative application smoke, and cost/ownership/cleanup records. Vercel SSO blocks anonymous frontend smoke by design.
- Gates [#22](https://github.com/ronchak/Koaryu/issues/22) and [#23](https://github.com/ronchak/Koaryu/issues/23): the five local AEAD artifacts still match their recorded SHA-256 hashes, have mode `0600`, decrypt with the Keychain-held key, and reject a deliberately wrong key. No off-site copy was found or created, so #22 remains **open** and #23 remains blocked. No restore target was created, no production-derived data was restored, and no plaintext artifact was written.
- Recovery next action: select and document the approved off-site provider/access/retention policy, upload only encrypted artifacts, download and verify that provider copy, then create a separate disposable restore target for authenticated tenant-safe recovery. Ordinary staging must never receive the production backup.

## Release Entry Template

Copy this section for each staging or production release. Use ISO 8601 UTC timestamps and link durable CI/PR/deployment evidence when available.

```markdown
### <release name> — <YYYY-MM-DD>

- Environment: <staging|production and provider/service identifiers>
- Application commit: <full 40-character SHA>
- Repository migration head: <timestamp_name.sql>
- Applied migration head: <remote timestamp and name>
- Migration comparison: <match|known divergence with approval/evidence link>
- Deployed at: <ISO 8601 timestamp>
- Operator: <name>
- Approval/review: <skeptical reviewer green light, Codex review, CI, human approval if required>
- Verification:
  - <exact command or durable check and result>
  - <post-deploy smoke and result>
- Known gaps: <none or explicit blocked/unverified checks>
- Application rollback target: <previous verified full SHA>
- Database recovery action: <none|forward-only corrective migration|approved restore plan>
- Rollback trigger: <observable failure condition>
- Rollback verification: <health, contract, and data-integrity checks>
- Outcome: <successful|rolled back|blocked>
```

An entry is incomplete if deploy time, operator, verification, or rollback is blank. Use `not captured` or `blocked` for historical evidence gaps; never invent evidence.

## Approval and Release Gates

Before merging any remediation PR:

- A skeptical reviewer must explicitly return `GREEN LIGHT` with no unresolved blocker.
- The GitHub Codex reviewer must have no actionable unresolved finding.
- Required CI must be green, the branch current, rollback defined, and all verification evidence recorded.
- After merge, verify the exact deployed commit and run post-deployment smoke checks.

Explicit Ronak approval is required before:

- Upgrading paid infrastructure plans.
- Repairing remote migration history.
- Deleting or anonymizing production records.
- Changing live Stripe configuration or webhooks.
- Initiating, refunding, or otherwise manipulating a real payment.
- Enabling live billing for additional studios.

Wave 6 production mutation or financial activity also requires explicit approval. Preserve unknown production records. If credentials or approval block a live check, record the exact outstanding action and leave the gate closed.

Koaryu is not broadly production-ready until all broad-production release conditions are met, including matching application and migration state, no unresolved high/critical vulnerability, proven tenant isolation and staff permissions, enabled authentication/backup controls, evidenced recovery drills, an approved production-data audit trail, a reconciled live tuition lifecycle, gated billing, and alerts reaching a named human.
