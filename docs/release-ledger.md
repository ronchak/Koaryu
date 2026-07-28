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
- Migration state: all 82 repository migrations replayed into a fresh project.
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

## Staging Isolation Control Audit — 2026-07-11

Operator: `Codex release orchestrator`

- Repository baseline: protected `main` is `54e42d570a7dfdafd11268213c7232a788410002`; its repository migration head is `20260711215000_harden_function_execution_boundaries.sql`. The isolation-control candidate is tracked by PR [#49](https://github.com/ronchak/Koaryu/pull/49), whose exact immutable head and CI run are the durable record for this self-modifying ledger change.
- Staging resources: Supabase `nxgsektqsgrtyfhawxbc` is `ACTIVE_HEALTHY`; the dedicated backend API is `https://koaryu-staging.onrender.com/api/v1`; the protected Vercel alias is `https://koaryu-git-codex-production-eb9d24-ronakchak2569-8303s-projects.vercel.app`.
- Proven checks: backend `/api/v1/health` returned `200`; unauthenticated auth/profile and students requests returned `401`; exact staging-origin CORS preflight returned `200`; production-origin preflight returned `400` without an allow-origin header. Branch-scoped Vercel metadata points to staging Supabase and matching non-production backend/site destinations without exposing values marked sensitive.
- Application alignment gap: Vercel deployment `dpl_AXrjgCKzsFr6q3V2AKTU3hJjgYTa` is `READY` but was built from `b78cb9863e226d17dc242259cf7099e62c6ccfd5`, not current `main`. Render's exact deployed SHA is not captured. The current application and migration candidate is therefore not proven aligned or deployed to staging.
- Isolation control: `scripts/verify-staging-isolation.mjs` fails closed on production Supabase/origin/backend destinations, live Stripe key prefixes, mismatched application URLs, incorrect platform/Connect webhook destinations, preview mode, and demo-reset configuration. The guard prints no secret values; webhook signing-secret prefixes cannot prove Stripe mode, so dashboard destination and delivery evidence remain required.
- Gate status: #21 remains **open** pending authenticated Render environment/SHA evidence, Stripe test-mode endpoint and delivery evidence for both webhooks, an exact-current-SHA deploy on both providers, protected frontend/API-proxy smoke, authenticated representative application smoke, and cost/ownership/cleanup records.
- Recovery status: the five local AEAD artifacts retain their recorded hashes and mode `0600`, decrypt with the Keychain-held key, and reject a deliberately wrong key. No approved off-site destination or provider-downloaded copy exists, so #22 remains **open** and #23 remains blocked. No upload, restore, plaintext write, production mutation, or production-derived staging load occurred.

## Durable Staging Branch Transition — 2026-07-12

Operator: `Codex release orchestrator`

- The durable protected frontend origin is `https://koaryu-git-staging-ronakchak2569-8303s-projects.vercel.app`; current runtime and isolation guards pin that exact origin.
- Authenticated `vercel env run` readback confirmed the `staging` branch public configuration now uses the dedicated staging backend for both API variables, Supabase `nxgsektqsgrtyfhawxbc`, the durable staging site origin, `NEXT_PUBLIC_PREVIEW_MODE=false`, `NEXT_PUBLIC_USE_API_PROXY=true`, `NEXT_PUBLIC_KOARYU_PERFORMANCE_DEBUG=false`, and the paged roster. Three values that had contained copied encrypted payload text were replaced with their canonical plaintext URLs. Sensitive values were neither printed nor changed.
- At the 2026-07-12 17:20 UTC evidence probe, the durable alias pointed to `READY` preview deployment `dpl_5fW7LGhrUUXv1pDXC71azn4XT6YV`. Its safe `/api/version` response reported PR [#53](https://github.com/ronchak/Koaryu/pull/53) runtime-control head `9cfd5123b3e1e28a274432a1fccdbf446739c89b`; the protected API proxy returned backend health and preserved unauthenticated `401` denial. This is a timestamped observation, not a perpetual assertion about the mutable alias; later exact-head evidence belongs on the PR and Gate #21.
- Direct CORS recheck found Render staging stale: the durable origin is rejected with `400`, while the retired temporary Vercel origin is still accepted. The exact candidate's staging startup validator will reject this configuration. Authenticated Render access must update the staging frontend-origin value, deploy the same candidate, and prove `/health/ready`, CORS, exact provider SHA, and authenticated application behavior before Gate #21 can close.
- PR #53 is the immutable record for the current staging/runtime-control candidate and exact-head CI. Exact-candidate Render staging deployment, corrected CORS/readiness checks, authenticated provider SHA readback, Stripe test webhook evidence, and authenticated application smoke remain open.
- Production provider state was not changed. Production Render auto-deploy disable and authenticated readback remain a hard pre-merge gate.

## Staging Gate #21 Acceptance — 2026-07-12

Operator: `Codex release orchestrator`

- Runtime-control code head: PR [#53](https://github.com/ronchak/Koaryu/pull/53) commit `d687621eec40c50236b7a0d6ef3ec1d0cdcb59d7`. Every GitHub release-candidate, API-contract, CodeQL, secret-analysis, database, frontend/backend, and Vercel check passed for that exact head. The PR and Gate #21 comments hold the later immutable evidence-commit SHA because a commit cannot truthfully contain its own SHA.
- Frontend: authenticated Vercel readback identified preview deployment `dpl_8kgoNDw8erQqzWTHB9sUSxFzdPtK` as `READY` for the `staging` branch. The generated durable branch alias had remained on the prior candidate after the new deployment became ready, so it was explicitly reassigned to that staging deployment. `/api/version` then reported exact head `d687621eec40c50236b7a0d6ef3ec1d0cdcb59d7`; protected proxy health returned `200`, and unauthenticated proxy auth returned `401`.
- Backend: authenticated Render deployment `dep-d99unqt7vvec7389u6eg` was `Live` for the same exact head on service `srv-d98g4kutrd3s73ek0elg`. Both `/health/live` and `/health/ready` returned staging status and the exact SHA. Durable-origin preflight returned `200`; `https://koaryu.app` remained rejected with `400`.
- Supabase: the runtime remains pinned to isolated project `nxgsektqsgrtyfhawxbc`. A disposable, confirmed synthetic user was attached to the synthetic `River City Martial Arts` tenant, signed in through Supabase password Auth, and passed direct and protected-proxy `/auth/me`. A synthetic lead was created through the protected proxy, read and updated through the direct API, then the lead, activities, audit record, membership, and Auth user were verified removed.
- Stripe: the canonical test account is `acct_1TQCSiEP9oWvMODq`; the secret, restricted, and publishable test keys were independently verified to belong to that same account without printing them. The active Koaryu Core Price is test-mode recurring USD `$27/month`. The staging platform endpoint has the exact six-event contract and the connected-accounts endpoint has the exact nineteen-event contract. Real test `customer.subscription.created` and connected-account `account.updated` events reached Render and cleared Stripe's pending-webhook count; their synthetic customer, subscription, and connected account were cleaned up. An initially selected noncanonical test-account credential was rejected by account-identity verification and removed before acceptance; no live-mode Stripe resource was touched.
- Production release control: Render production service `srv-d7mogk1kh4rs73aq6hqg` remains pinned to `ronchak/Koaryu`, branch `main`, root `backend`, URL `https://koaryu.onrender.com`, and health path `/health`. Auto-deploy was disabled and read back as `Off` twice in the authenticated dashboard. The pre-merge script performs two additional authenticated API readbacks and refuses any moved PR head/base or incomplete check before merge. The exposed production deploy hook was rotated; no production deploy was triggered.
- Ownership, cost, rollback, and cleanup: Ronak Chakraborty owns the persistent staging resources; Codex release orchestration executes the checks. Existing free-tier Render staging, the existing Vercel/Supabase staging resources, and Stripe test mode add no approved recurring purchase in this step. Synthetic smoke data was removed. To retire staging, confirm the three pinned non-production provider identities, delete the Vercel staging alias/deployments and Render staging service, remove the two Stripe test endpoints, and delete only the dedicated staging Supabase project. To roll back an application-only regression, restore the prior verified staging SHA without changing production or migration history.
- Gate decision: the staging-isolation evidence required by [#21](https://github.com/ronchak/Koaryu/issues/21) is satisfied. The final PR head must still pass the guarded merge's exact-head CI and provider readbacks; those results belong on the PR/issue rather than in this self-modifying ledger.

## Production Migration Reconciliation Audit — 2026-07-12

Operator: `Codex release orchestrator`

- Execution repository base: protected `main` `692f13a4c7543a937c6fcabd257e05b9ab0b1210`; repository migration head: `20260711215000_harden_function_execution_boundaries.sql`.
- Ronak explicitly approved the exact bounded package on 2026-07-12. At `2026-07-12T19:08:05Z`, the documented `forward` block ran verbatim with Supabase CLI `2.95.4`: it added both repository identities, verified the exact four-row additive state, removed both production-only aliases, and completed with a matching local/remote list. The contingency path was not needed.
- The [history-only reconciliation package](production-migration-reconciliation.md) pins the exact inspected migration-source commit and file hashes, schema/function/ACL equivalence, PostgreSQL 17 rehearsal, additive-first repair order, full-history guards, failure recovery, and exact approval scope under issue [#20](https://github.com/ronchak/Koaryu/issues/20).
- Independent aggregate-only provider readback confirmed final reconciliation history `20260710001153:atomic_recurring_session_materialization|20260710010500:fix_first_occurrence_series_delete`, unchanged earlier-history digest `78:b97b56e3c883c1538cf1a85bd4dfc2ae`, and unchanged function/owner/security/search-path/ACL digest `2:7890f9aa36bb200f08153351f9ae98ab`.
- Gate #20's history divergence is resolved. This action ran no migration SQL and changed no application, Auth, Storage, tenant, billing, or Stripe record. Live billing remains closed and unknown production records remain untouched.

## Koaryu MVP Candidate Rollback Contract — 2026-07-12

- Candidate identity: the deployable artifact is the exact full PR-head SHA recorded in the implementation PR and provider readbacks. Do not substitute a merge commit or rebuild from a moving branch.
- Previous production application: Vercel is verified at `692f13a4c7543a937c6fcabd257e05b9ab0b1210`; the same SHA is the latest recorded Render production deployment, but Render must be read back before release because the historical runtime does not expose a commit SHA.
- Schema compatibility: this candidate adds no migration and requires no database rollback. It uses the existing authoritative `staff_roles` table and existing atomic lead-conversion, promotion, and recurring-session contracts. Removing `status` from the generic billing-enrollment PATCH request is backward compatible for valid callers; lifecycle clients must use the existing named transition routes.
- Rollback trigger: roll back both applications if exact SHA alignment fails, health/readiness fails, an approved role can no longer complete a supported MVP workflow, a denied role reaches a restricted mutation, generic billing status is accepted, live Stripe mutation is not fail-closed, or an immediate new relevant production error appears.
- Application rollback: stop promotion, redeploy Render and Vercel to the previous verified application SHA, read both provider SHAs back, then repeat health plus read-only/non-financial authentication, dashboard, roster, schedule, attendance, leads, and billing-page smoke checks.
- Database action: none. Do not reset, restore, rewrite migration history, delete records, or apply a compensating migration for this application-only rollback.
- Data and payment boundary: production records, Auth identities, Stripe objects, webhook configuration, and live billing state are not rollback targets and must remain untouched. The verified encrypted copy is recovery evidence, not an application-rollback input.

## Friendly Pilot Core Candidate Preparation — 2026-07-12

- Baseline application identity: Phase 0 read-only provider reconciliation found Vercel production and both Render readiness endpoints at `931ed2fb732e51b84a53258d994bc4cc4f6d3231`. Vercel/Render must be read back again immediately before any approved release because provider aliases and deployments are mutable.
- Candidate identity: pending freeze. The only deployable artifact will be the exact reviewed full candidate SHA recorded after a clean commit; staging, CI, and both application providers must report that same SHA.
- Schema change: one additive migration, `20260713010426_friendly_pilot_authorization_guards.sql`, is included. It preserves all existing rows, rejects only prospective cross-studio membership links, revokes browser-role direct `students` table reads, and exposes the service-role-only atomic demotion RPC. Record its SHA-256 at candidate freeze.
- Application rollback: stop promotion and redeploy both Render and Vercel to `931ed2fb732e51b84a53258d994bc4cc4f6d3231`, then verify both provider SHAs, health/readiness, authentication, roster, schedule, attendance, Instructor denial, and the read-only billing page. Do not change Supabase or Stripe as part of application rollback.
- Database recovery: after the additive migration is released, do not rewrite or mark down migration history. Preserve the authorization guards and use a separately reviewed forward-only corrective migration if a defect is found. A production restore is disaster recovery, not ordinary release rollback.
- Approval boundary: application deployment, production migration, and live Stripe activation are three independent approvals. This candidate has no approval for any of them yet and does not request live Stripe activation. `LIVE_BILLING_ENABLED` remains `false`.
- Data boundary: candidate preparation performed no production write. Production tenant records, demo data, Auth identities, Storage objects, historical memberships, Stripe objects, webhook configuration, and payment state remain preservation targets.

### Recovery copy evidence

- The five encrypted artifacts from `$HOME/Koaryu Backups/production-20260710T070020Z` were independently verified on a second machine with identical filenames, sizes, mode `0600`, and the SHA-256 hashes recorded in Wave 0.
- This proves a second-machine encrypted copy. It does **not** prove geographic separation, provider-independent off-site storage, a current 24-hour RPO, or a full application recovery.
- The restore drill still lacks an authenticated tenant-safe application read. The current Supabase Free plan has no proven native daily-backup or PITR entitlement, so the provisional RPO of 24 hours and RTO of 4 hours remain unproven planning targets.
- The backup key remains in macOS Keychain. Copying it to a physically controlled recovery flash drive remains a human-only action; no key material belongs in this repository or release evidence.

## Studio-Comp Migration Rollout Packet — 2026-07-31

- Phase: A tooling and documentation only; provider mutation remains locked.
- Inspected source baseline: `da2e02c250643d9d39be0bb0c76764ad4ba48605` with 86 migrations and 29 local SQL contracts.
- Fixed production pre-state: 84 ordered migration identities, digest `57ae4269ef4d75c249d59ef297661a3a`, through `20260713173000_fail_closed_ambiguous_staff_rls`.
- Provisional source packet: `84 -> 86`; pending pair `20260727100000_atomic_studio_comp_management.sql`, `20260727110000_order_billing_events_after_studio_comps.sql`; manifest SHA-256 `ab6dfd24935124f825fe578d063789f2db40900afa52d7f49240b49d3d390fe0`.
- Identity limitation: Supabase migration history has `version`, `name`, and parsed `statements`, but no intrinsic content hash; the packet does not claim that remote version rows prove source-file identity. Final proof requires exact version sequence plus staging/production function, trigger, ownership, security, search-path, and ACL equality.
- Regeneration rule: after Owner 3/4 migrations integrate, regenerate the exact `84 -> N` packet from the immutable final candidate. Do not reuse the provisional 86-migration post-state.
- Compatibility boundary: both July files are transaction-compatible additive/replacement DDL, but the pair is not atomic across files. It is schema-compatible with reported production application `6596cc5`; the comp feature is not operationally compatible because that application still clears `comped` directly and never calls the new ordering RPC.
- Staging state: provider health was read-only confirmed separately; the latest migration-list attempt returned `INVALID_ARGUMENT`, and a prior direct SQL attempt reportedly timed out. Staging inspection must succeed once before any dry-run or application. No retry loop, provider write, contract execution, or Auth fixture occurred in Phase A.
- Production gate: agents never execute production migration or contract SQL. Human application remains blocked on staging rehearsal/fingerprint, exact final candidate and pending set, explicit approval, confirmed PITR/restore window, and a named restore decision authority.
- Recovery: preserve partial forward state, reinspect, and complete with the pending immutable migration or a new reviewed corrective migration. Do not revert history or drop objects.
- Runbook: [studio-comp migration rollout](studio-comp-migration-rollout.md).

## Database-Parity Remediation Candidate — historical V17 predecessor (2026-08-15)

The V17 values below are retained as historical evidence. The current
archive/RLS candidate is recorded in the Migration-111 section that follows.

- Read-only inspection confirmed both staging and production at the healthy
  100-migration V7 state, digest `359058cc127e57a47e429f6271453acf`,
  through `20260801131844_finalize_release_database_attestation_v7.sql`.
- Staging rehearsal: guarded applies advanced migrations 101 through 104. The 102
  post-check found one hosted-only historical `service_role` EXECUTE grant on a
  trigger-only function, so the release halted and added forward-only migration
  103. Exact-head review then identified writer-path and return-contract gaps, so
  forward-only migrations 104 and 105 were added. A final exact-head review then
  found retained multi-program ranks could be erased when changing the primary
  program, so forward-only migration 106 was added. Further exact-head reviews
  added migration 107 for tokenized checkout acceptance and secondary-program
  lock ordering, then migration 108 to preserve accepted checkout history and
  attest the promotion columns themselves. A final review found the trial
  duration was still derived before the reservation lock, so migration 109
  moved that decision into a versioned row-locked RPC and made accepted checkout
  versus operator comp grants fail closed in either lock order. Exact-head
  review then required mixed-version service-role compatibility, historical
  replay isolation, exact live-comp provenance, and atomic idempotent belt-ladder
  audit plus atomic student write responses; migration 109 now carries those
  contracts while the candidate uses the versioned writers and V3 readiness.
  Migration 110 appends the reviewed staff identity name model and updates only
  the V2 compatibility guard and release-readiness definitions to the exact V17
  count, head, sequence, and V7 compatibility contract. Staging remains at exact 108; production
  remained at the V7 pre-state.
- Final required database identity: 110 migrations, head
  `20260815220402_staff_identity_name_model.sql`. Production has migrations 101
  through 110 pending; staging has migrations 109 and 110 pending. No migration
  109 or 110 is claimed as applied to either environment.
  The V17 readiness response attests the complete historical 85-through-110 sequence,
  the starting-belt function/trigger invariant, and the converged trigger-only
  function ACLs plus the bodies, ACLs, and normalized return contracts of both
  public/private student profile and import writer pairs.
- Security repair: revoke browser/PUBLIC access to the new identity sequences;
  serialize Connect mapping/exclusion identities through one private guard row
  and database constraint; prove both opposite-direction races with concurrent
  transactions.
- Promotion guard: Render health uses `/health/ready`; hosted readiness calls a
  service-role-only exact-head/object preflight and fails closed on provider
  errors. Schema 100 cannot receive healthy traffic from the new backend.
- Catalog proof: deterministic sorted identities and security-relevant catalog
  properties cover the currently integrated pending tables/RLS, policies,
  exact ACLs and stored function bodies, complete trigger/index definitions,
  sequences, columns, and scoped CHECK/UNIQUE/FK definitions. PostgreSQL catalog
  rendering, not provider UI pretty-printing, is pinned. The policy manifest rejects
  missing, extra, permissive, role/command, and canonical predicate drift.
- Integration gate: migrations `20260801070000` (billing), `20260801080000`
  (alerts), `20260801090000` (parity), `20260801091000` (Connect bootstrap),
  `20260801092000` (semantic attestation), `20260801093000` (Connect recovery),
  `20260801094000` (ACL/readiness attestation), `20260801105313` (Connect
  delivery retirement), `20260801112153` (V4 attestation), `20260801115044`
  (V5 column-ACL attestation), `20260801123112` (alert-delivery lint repair
  and V6 attestation), and `20260801131844` (runtime-invariant V7 and explicit
  least-privilege ACL convergence) are ordered 89-100; `20260814043325`
  adds the starting-belt membership invariant and advances readiness to V8 at
  migration 101; `20260814103046` repairs whole-statement belt replacement and
  advances readiness to V9 at migration 102; `20260814105424` preserves
  deliberately unranked memberships across plan edits and unrelated deletes,
  replaces carried ranks when a student changes primary programs, removes
  historical direct grants from trigger-only functions, and advances exact-head
  readiness to V10 at migration 103; `20260814114500` reconciles rankless CSV
  imports after their final compatibility-field write, attests both public/private
  student writer pairs, and advances readiness to V11 at migration 104;
  `20260814152000` normalizes and attests all four writer return contracts and
  advances readiness to V12 at migration 105; `20260814170000` preserves ranked
  retained memberships when the primary program changes and advances readiness
  to V13 at migration 106; `20260814183000` adds tokenized, replayable checkout
  acceptance and secondary-program lock ordering at V14; `20260814200000`
  preserves every accepted binding across later checkout epochs and attests the
  six promotion rank/snapshot column identities at V15; `20260814213000`
  atomically decides trial eligibility under the checkout-reservation lock,
  serializes checkout acceptance against operator comps, preserves the
  predecessor reservation (V1) and V2 readiness signatures for database-first cutover, isolates
  historical replay, binds explicit live-comp provenance, makes belt-ladder
  sync/audit idempotent, and advances candidate readiness to V3/V16;
  `20260815220402` adds the staff legal-name source-of-truth and audit actor-name
  snapshot schema and updates only the V2 compatibility guard and readiness
  definitions to V3/V17. The packet reports
  `integration_complete=true` only for
  the exact 84-to-110 history and twenty-six
  expected pending versions. The semantic catalog and hosted preflight include
  the security-relevant billing and alert tables/RLS, grants, functions,
  triggers, indexes, sequences, columns, and constraints. Complete sorted
  table/sequence ACL grantor, grantee, privilege, and grantability rows reject
  custom-role and grant-option drift, including on `studio_payment_accounts`
  and `stripe_events`. A separate column-ACL manifest covers every ordinary,
  non-dropped column across all fourteen scoped tables, including empty
  `attacl`, and rejects explicit custom/browser grants and grant-option drift.
  Apparent-post linked inspection also requires exact V17 output before
  certification. Hosted exposed-schema and schema-ACL readback remain a
  separate provider/operator gate that local PostgreSQL cannot certify. The exact 33-file SQL
  contract inventory fails CI on missing or unexpected verification files.
- Recovery: any partial history, catalog mismatch, readiness failure, or guard
  conflict halts. Preserve applied state and recover only with reviewed
  forward-only migration work; production restore remains disaster recovery.

## Migration-111 Archive/RLS/Readiness Pilot — 2026-08-15

- Worker: `worker-002`, single database writer. Branch:
  `codex/staff-identity-pr2-archive-delete`. Starting head:
  `105090af4820f268afac4a0842fc35dbe839a992`.
- Current dirty-worktree base after CTO rejection:
  `c38bc2f6c004c2ca2379d71ed72393499f682736`.
- Candidate database identity: 111 migrations, head
  `20260816012723_archive_staff_access_and_readiness.sql`, with the exact
  27-version pending sequence and V18 release string
  `release-db-attestation-v18`.
- Current-worktree source packet derivation used:

  ```bash
  node --input-type=module --eval 'import { verifySourceTree } from "./scripts/studio-comp-migration-rollout.mjs"; const packet = verifySourceTree(".", "c38bc2f6c004c2ca2379d71ed72393499f682736"); console.log(JSON.stringify({ candidateSha: packet.candidateSha, migrationCount: packet.migrationCount, postHistory: packet.postHistory, sourceManifestSha256: packet.sourceManifestSha256, migration111: packet.pendingManifest.at(-1) }, null, 2));'
  ```

  It returned
  post-history `111:f23ff28f995f7a5401f7a9580481a365`, source manifest SHA-256
  `45091bba2938a1f8a42ce93fadc18f0431b326acf662f1846a12b79a035dd14b`, and
  migration-111 SHA-256
  `7fd9b371de08d2d098ac8a913b5e248123f356302b400ffbc033e51b671ea31c`.
  This is a dirty-worktree derivation for review evidence, not a claim that an
  immutable release commit exists.
- Migration 111 adds nullable `public.staff_roles.archived_at`; makes the
  central restrictive guard, role helpers, and staff-profile helper active-only;
  preserves zero-membership onboarding and any-row single-studio reservation;
  keeps staff-role writes service-role-only; and guards owner, last-active-admin,
  and active account-deletion survivor invariants, including linked identity
  replacement and clearing while preserving nullable pending invite linking.
- The V17 semantic archive-critical manifest is pinned to the PM-observed
  zero-invalid value
  `0:05a77426d6e3e1864fe4d1a6beea708cc501b228e670a0309d1420808d2feab8`.
  The post-111 V16 compatibility assertion is pinned to
  `0:48995afbdd6519a199db44c6b947bf629a87569530ba73c81c25b00f72944239`.
  The raw PostgreSQL 17 catalog state is pinned to
  `column_acls=205:32ad7f660d40de1c75de0e9d50e4c23f3588124e67f3665159f8f2f027617414:0;columns=43:c2f9560d4d2d9742f22edeeb3386b2fce9def1e90290e7986f406d9f7dd0451b:0;constraints=24:d8ae028684234bb1c69447c97e87fc8561ce18f03b7ec10f81a880ba5d813c5c:0;functions=68:164af3cd98d7f26bc74994b4f16529ea988ba0e760aa34d3cebddc4f97c4b625:0;indexes=12:c78635a18852d4cbe8be1bc34861848ba904b06639038c292f84d56ca7be50a7:0;policies=16:259cc99c295d80442450cea438a462efd44748f2ace47456fca13133b52d17b8:0;scoped_constraints=149:a1555af1e8eacb8f03b04c2109dc6966293705307d737e5601996cf81acc06b9:0;scoped_indexes=33:4d401ee4a7e7f104957cb8cc84ad45164d57938ced0c2609259310aa980895f2:0;sequences=3:27451af3027130cfb193bd4eb9f59221773a89e46bcb855a7a809df1b54a7574:0;table_acls=14:d34439755bc5f66626a1626c81f72d583a1b847b70ec02bc07ad127b2a270ddb:0;tables=12:f56508ae1d3c712e7b239a1fe965adf88cec4e7f41f8d6b6db9ffce95f1bb76b:0;triggers=12:61039a9e58e55b3aba5e7e2a40088fd492352560123bc5df30c7966cfd6d9efc:0`.
- The rollout source packet is derived by
  `node scripts/studio-comp-migration-rollout.mjs --mode packet --candidate-sha <full-sha>`.
  The operator raw catalog fingerprint is pinned to the same observed
  PostgreSQL 17 value; archive-specific column/helper/trigger/policy coverage
  remains in the V17 semantic catalog manifest rather than being copied into a
  separate stale hash.
- Sandbox verification stop: `npm run check:supabase-contracts-local` could not
  initialize PostgreSQL because the host denied the shared-memory `shmget`
  operation. The PM-owned PostgreSQL 17 run supplied the current V16 and raw
  catalog values above; no linked or network fallback was used.
- No commit, push, deployment, linked-project mutation, or external action was
  performed by this worker.
## Supabase Authentication and Backup Control Inventory — 2026-07-28

- Scope: read-only/provider-safe production and staging project, organization-plan, backup, public Auth, and controlled synthetic staging evidence. No production Auth record, session, backup content, or credential was read, and no provider configuration was changed.
- Ownership: Ronak Chakraborty is the named control owner, evidence custodian, approval owner, incident recipient, and current restore operator. A second recoverable owner path is unverified and remains approval-gated.
- Provider baseline: both pinned projects reported `ACTIVE_HEALTHY` on PostgreSQL 17. The organization reported the Free plan. Production and staging each returned zero listed backups, `pitr_enabled=false`, and `walg_enabled=true`; WAL-G plumbing is not treated as a restore entitlement or point.
- Public staging Auth baseline: email/password is the only exposed provider, sign-up is enabled, email confirmation is required, and phone, anonymous, social, SAML, and passkeys are disabled. Production public Auth settings and both projects' protected Auth configuration remain unverified.
- Synthetic staging evidence: a disposable identity established two independent sessions with one-hour JWTs and `session_id`; global sign-out rejected both refresh tokens and the Auth user endpoint rejected the issued access token before expiry. The user was hard-deleted and absence was confirmed. No identifier, email, password, token, or response body was printed or recorded.
- Revocation caveat: Koaryu production validates JWTs locally and does not check active `auth.sessions` state on each request. Do not infer immediate production backend revocation from the staging Auth endpoint result. Production JWT lifetime, refresh rotation/reuse, session limits, password policy, MFA, CAPTCHA/attack protection, rate limits, audit access, and restore roles remain approval-gated evidence gaps.
- Recovery posture: the July 10 encrypted logical artifact set remains outside the provisional 24-hour RPO, lacks approved provider-independent off-site evidence, and the restore drill still lacks an authenticated tenant-safe application read. The provisional four-hour RTO is not proven.
- Repository controls: `npm run check:supabase-controls` validates the 17-control-per-environment inventory, owner/evidence fields, review freshness, gap approvals, safe Auth allowlisting, and synthetic-test safety. The exact-head release-candidate workflow runs it without provider credentials.
- Approval packet: [authentication and backup control inventory](audit-notes/authentication-backup-controls.md#approval-packet). Paid plan/PITR, session-policy changes, active-session checks, restore access, off-site retention, and recovery-key custody remain unapproved.
- Provider mutation: none. The only provider write was the bounded create/sign-out/delete lifecycle of one disposable staging identity; cleanup was confirmed.

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
- After the strict `main` ruleset is active, merge through `scripts/merge-release-pr.sh` with the recorded exact head and base SHAs.
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
