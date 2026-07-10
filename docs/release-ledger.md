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
- Created at: `2026-07-10T02:33:20Z`. No staging frontend or backend deployment exists yet; the application-isolation deploy gate is blocked until dedicated staging URLs are assigned and verified.
- Verification: migration replay completed against the staging ref; database lint returned no errors and the two previously audited warnings; the sanitized seed completed, including an idempotency-protected external-payment fixture.
- Rollback: delete only the confirmed staging project, recreate it, and replay repository migrations. Do not restore the production logical backup into ordinary staging.

### Restore Drill Evidence

- Temporary target: hosted Supabase project `zmmacdleiaohvxdubrav` (deleted after validation).
- Backup: `/Users/ronakchak/Koaryu Backups/production-20260710T070020Z`.
- Encrypted artifact hashes:
  - `data.sql.enc`: `8be3e1087a2ebe1ab6306ca93e1489cb70666be4ca6e850d495c75d1a5a2e948`
  - `roles.sql.enc`: `040e6904f8cf7934fca3b0463503d4e887637b84fd419927d58e929c57e133a4`
  - `schema.sql.enc`: `e894ecea0723d1a9d5e07c8e9635993d42625d7acd52ae7a324bd702d231ff3e`
  - `record-classification-manifest.json.enc`: `c919a4ab5475b02ffc0ff2228673b81ed5ebadb67b9f4143bbaa4fea1ff4847b`
- Record classification: 384 identifiers inventoried with conservative explicit-marker rules. Unknown remains preserved: 60 auth users, 39 studios, 39 subscriptions, 1 payment account, and 49 live-mode Stripe events remain `unknown`; no record is approved for deletion or anonymization.
- Restore method: PostgreSQL 17 `psql`, single transaction, `ON_ERROR_STOP=1`, roles then schema then data with replication triggers disabled for the data load.
- Verification: 37 `public` tables, 61 authentication users, and 52 studios. An authenticated tenant-safe application read was not completed against the temporary restore target and remains required in the next drill.
- Cleanup: temporary restore project deleted; fresh current staging recreated separately from repository migrations.
- Off-site copy: pending; the encrypted backup currently has only the local path above, so off-site recovery is not yet proven.
- Production impact: none. No production record was deleted or anonymized.

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
