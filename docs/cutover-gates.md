# Cutover gates

Use this checklist before merging a release, migrating a hosted database or
promoting an application. Test selection is in [the verification matrix](pr-verification-matrix.md);
tool mechanics are in [migration rollout](studio-comp-migration-rollout.md),
[Render deployment](render-backend-deployment.md) and the private operator runbook.
Earlier version-specific details are in [the historical reference](release-history-reference.md).
Do not read or replay that history for a routine application release.

## Before merging

1. Pin the PR head and base. Require the actual exact-head GitHub gate to pass and
   resolve material review findings. Document any deferred thread before resolving
   it. One focused review is enough unless a risk remains or the owner requests more.
2. Verify production auto-deploy is off and use `scripts/merge-release-pr.sh` with
   the pinned SHAs. Do not bypass required checks. See [release controls](release-candidate-controls.md).
3. Keep merge and deployment authority separate. Stop after the authorized task.

## Before a hosted release

Read [services](services.md) and explicitly source the private `release-env.sh`
with tracing disabled. Check live identities, served SHAs, readiness and deployment
controls; a previous plan or release record is not proof of current state. Derive
candidate database requirements from the candidate's generated packet, not a
copied version/count/fingerprint. Confirm the rollback target and its data-format
limits; a ready health endpoint alone does not prove a safe rollback.

For an application-only release, use current readiness/schema evidence. Do not
start a migration backup or historical restore sweep when there is no migration.
For hosted schema/security changes, also verify the approved exposed-schema and
schema-ACL configuration; local PostgreSQL proof does not establish provider settings.

## Database changes

- Run the rollout tool from the exact candidate implementation and pass its full
  SHA. Complete its inspection and dry-run gates before apply. Do not merge just
  to obtain a newer rollout script.
- Staging apply retains its exact project confirmation and owner approval comment
  on PR138, binding the candidate, target, inspected state and remaining migration
  set/manifest. A code, state or remainder change invalidates that approval.
- Production apply requires explicit owner authorization for the named coordinator,
  `--release-authorization ronchak:<candidate-sha>`, `--release-operator <executor>`
  and the exact state-bound `--confirmation-phrase`. CLI labels record attribution;
  they do not create authorization. Subagents have no production authority.
- Require the current staging fingerprint and a fresh production backup with a
  verified disposable restore. The backup helper's source/image mappings must match
  the current candidate/provider. A typed restore claim is not evidence.
- Use `--one-migration` for production inspection, dry-run and apply. Verify each
  successor and reinspect before the next step. Do not automate past checkpoints.
- Never run contract SQL on production, including inside a rollback transaction.
  Only the authorized guarded apply and temporary backup role may perform these
  production database writes. No ad hoc financial backfills or repairs.
- Preserve existing rows except explicitly intended transformations. Stop on
  ambiguous failure, unexpected state or row changes, or invalid restore evidence.
  Do not improvise recovery or claim an incomplete check passed.
- Keep retry-hash capture enabled during rolling deployment. Finalizing it requires
  a separately authorized operation with the new backend SHA and drain proof.
  Schema compatibility does not eliminate races in old callers still running.

The backup does not include Storage object bytes. Follow the
[retained Storage procedure](staging-recovery-runbook.md#current-backup-owner-and-retained-storage-procedure)
when applicable. Keep dumps, credentials and private evidence outside the repo.

## Owner-authorized release execution

Production migrations and deployments require explicit owner authorization for a
named coordinator. Billing activation and customer sending require separate scope.
Existing script-specific terminal/approval gates still apply.

For each release mutation, including the backup role, migration, backend deploy
and frontend promotion:

1. Announce the exact command, effect, reversibility and immediate verification.
2. Pause at least 30 seconds before each production migration apply. Other actions
   have no mandatory pause. A user interruption stops execution.
3. Execute that action alone and verify it before the next action. Keep one private
   record of owner, executor, candidate, commands, timestamps and results.

For a schema release, migrate the database, then deploy the backend, then the
frontend. The old application must remain compatible during the transition. An
explicitly approved temporary frontend/backend mismatch must be recorded; any
unexpected mismatch is a stop. For application-only releases, skip the database
step and deploy backend then frontend unless the owner explicitly authorizes a
different order. Always verify the final pair reports the intended full SHA.

Estimate a migration chain before starting and respect the current session's
explicit budget. Do not begin a chain that cannot finish within it. Once a chain
starts, technical failures still stop it; do not abandon it merely on budget.
Retain evidence and report recovery options when blocked.

## Frontend and billing checks

- Never promote a Vercel preview build to production. Public settings are baked
  into the build; reassignment does not replace staging/test settings. Create a
  production-target Git build at the exact release SHA, then verify its environment,
  API routing and provider metadata.
- Verify the final pinned pair with `npm run verify:deployed-release -- --environment
  <staging|production> --expected-sha <full-sha> --frontend-origin <pinned-origin>
  --backend-api <pinned-api-v1>` before browser smoke or performance capture.
- `--expected-stripe-mode test` is staging-only. For production, omit it and verify
  `configured_stripe_mode` from backend readiness.

Fix material failures, finish the authorized release and stop. Optional refactoring,
extra reviewers and repeated full-suite runs are not release prerequisites.
