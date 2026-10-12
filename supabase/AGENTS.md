# Supabase agent guide

Use the root verification rules and [verification matrix](../docs/pr-verification-matrix.md).
This directory holds ordered migrations and SQL verification files. Do not edit
generated `.temp/` state.

## Authoring

- Add a narrow timestamped migration; do not rewrite applied history unless the
  owner explicitly requests migration repair.
- Update the nearest contract when changing a table, policy, RPC or trigger.
  Check its backend callers and related permissions/indexes.
- Keep meaningful permission, tenant, transaction, payment, retry and concurrency
  assertions. Negative SQL tests must verify the expected error and raise their own
  failure outside its handler; use `IS DISTINCT FROM` for nullable assertions.
- Use synthetic fixtures. Do not skip an assertion because an unrelated fixture is
  missing, and do not use production data for local contract proofs.
- For a new release version, update exact readiness fixtures in
  `verification/release_ui_atomic_contract.sql`; unknown states must remain refused.
  Use the shared generator for declarations, not manual edits to generated files.
  See [attestation authoring](../scripts/release-attestation/README.md).

## Verification

Start with inventory/source/setup checks, then exercise affected contracts and
races on a confirmed disposable database. For a new migration, prove the supported
predecessor upgrade, intended row preservation/change, current readiness and restore
continuation. Reuse unchanged historical proof; broaden when shared history,
restore machinery, database versions or dependencies invalidate it.

- Apply unapplied files with `supabase migration up --local`. If changed files are
  already recorded, reset only a confirmed disposable database with
  `supabase db reset --local`. Then run `supabase db lint --local --fail-on error`.
- Run the focused local helper or relevant SQL with `psql` and `ON_ERROR_STOP=1`.
  Policy/tenant changes use `SUPABASE_DB_TARGET=local scripts/verify-supabase-rls.sh`;
  account/support changes use `SUPABASE_DB_TARGET=local scripts/verify-supabase-account-support.sh`.
- `npm run check:supabase-contracts-local` is the exhaustive PostgreSQL 17 runner.
  It includes migration replay, historical restores, contracts and real-session
  races. It has no selective mode: if a needed proof cannot be exercised separately,
  use it once or rely on its required CI run. Do not invent skip flags.
- Use assembled Supabase checks when behavior depends on the platform. Do not
  repeat all ordinary PostgreSQL checks locally merely for a second environment.
  Database checks remain mandatory for database/code/tooling changes; CI selection is described in [release controls](../docs/release-candidate-controls.md#current-ci-and-the-transition).

## Hosted boundaries

Read [services](../docs/services.md), [cutover gates](../docs/cutover-gates.md) and
the private operator policy before hosted database work. Linked contract checks
require explicit inspection intent, applied migrations and the runner's exact
staging/TLS connection guard. Never weaken that guard or run contracts on production.
Restore/concurrency tools accept only their validated disposable local target.
Keep credentials, dumps and customer/support details out of Git and summaries.

The scripts and their contracts contain the detailed historical proof inventory;
their presence is not an instruction to rerun every proof on every edit.
