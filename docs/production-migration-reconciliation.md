# Production Migration Reconciliation

Status: **approved and executed successfully at 2026-07-12T19:08:05Z**

Release gate: [#20](https://github.com/ronchak/Koaryu/issues/20)
Inspected migration-source baseline: `49feb90f98c0b83ef6b3f38f43cb85e8e76ceb68`
Execution repository base: `692f13a4c7543a937c6fcabd257e05b9ab0b1210`
Production Supabase project: `mimguepumzsgmcaycdsh`

## Executive Conclusion

The last two production migrations are the repository migrations under different
timestamps. Their SQL, resulting function definitions, security mode, search
path, privileges, and focused data-dependent behavior are equivalent. The
divergence is confined to migration-history identity and statement segmentation.

The recommended production action is a history-only repair. First add the two
repository identities, verify the safe four-row intermediate state, and only then
remove the two production-only identities. Do not re-run either migration's SQL,
use `db push`, or change application data.

This matches Supabase's documented [`migration repair` behavior](https://supabase.com/docs/reference/cli/supabase-migration-repair):
`applied` inserts a migration-history record and `reverted` deletes one without
running the migration SQL.

Repairing production migration history is a reserved action. Ronak explicitly
approved this exact package on 2026-07-12 before execution, including the strictly
bounded contingency-recovery scope stated in the Approval Decision.

## Executed Result — 2026-07-12

The documented `forward` block ran verbatim with Supabase CLI `2.95.4`. Every
target, source-hash, stable-history, function-state, and exact-state assertion
passed. The script added the two repository identities, verified the exact
four-row additive state, removed the two production-only aliases, and completed
with a matching local/remote migration list.

An independent aggregate-only provider readback after execution returned:

- reconciliation history: `20260710001153:atomic_recurring_session_materialization|20260710010500:fix_first_occurrence_series_delete`;
- stable earlier-history digest: `78:b97b56e3c883c1538cf1a85bd4dfc2ae`;
- function/owner/security/search-path/ACL digest: `2:7890f9aa36bb200f08153351f9ae98ab`.

No migration SQL ran. No application, Auth, Storage, tenant, billing, or Stripe
record changed. The `restore-initial` contingency was not needed.

## Observed Identities

| Logical migration | Repository/staging identity | Production identity | Name match |
| --- | --- | --- | --- |
| Recurring-session materialization | `20260710001153` | `20260710010051` | yes |
| First-occurrence series delete | `20260710010500` | `20260710010735` | yes |

All 78 earlier migration identities match. The guarded production and staging
migration reads were performed on 2026-07-11, and the production identities plus
the pinned earlier-history digest were reconfirmed read-only on 2026-07-12. No
production mutation occurred.

## SQL Equivalence

Production stores each migration as one history statement. Repository replay in
staging stores the function body, `REVOKE`, and `GRANT` as three statements. Manual
inspection found that each production statement is byte-for-byte identical to its
pinned repository migration file. Database-side SHA-256 and byte counts match the
local file evidence exactly:

| Migration | Repository and production bytes | Repository and production SHA-256 | Staging corroborating normalized MD5 |
| --- | --- | --- | --- |
| Recurring-session materialization | `3145` | `26ba57fb498237153d749b51a16783802808b6e83d92b59f460c7fd297cd24a1` | `6edcbc98ab7ba77cffc09b001bdb2e0a` |
| First-occurrence series delete | `2936` | `de8a83f71a14b25559009189ff95e15529e7231fdbc3a952364ff0ae40408370` | `1561294b1ad66f9f6b4469deb1307626` |

Staging's three-statement representation cannot have the same raw history hash as
the one-statement repository/production representation. Its matching lossy
whitespace/semicolon-normalized MD5 is corroboration only; the exact production
byte count and SHA-256 equality are the primary SQL-equivalence proof.

## Resulting Schema and Privileges

Production and staging returned the same `pg_get_functiondef` MD5 values:

| Function | Definition MD5 | Owner and security/search path | Execute privileges |
| --- | --- | --- | --- |
| `materialize_recurring_class_sessions` | `90c8f995341dc874e7a802fadc47d433` | `postgres`; invoker; `public, pg_temp` | owner and `service_role`; no `PUBLIC`, `anon`, or `authenticated` grant |
| `delete_recurring_class_series_atomic` | `09c98fbad56bc46f44ec2e9153a70068` | `postgres`; invoker; `public, pg_temp` | owner and `service_role`; no `PUBLIC`, `anon`, or `authenticated` grant |

Production and staging have the same `postgres` owner and ACL
`{postgres=X/postgres,service_role=X/postgres}`. `anon` and `authenticated` cannot
execute either function, and `PUBLIC` has no grant. Both migrations only replace a
function and set its grants; they do not alter tables or stored product records.
The matching definitions, owners, and ACLs therefore establish equivalent schema
state for the complete change surface of these migrations.

## Data-Dependent Behavior

The following transaction-wrapped synthetic contracts passed against staging and
again against the fresh local repository replay before and after history repair:

- `recurring_class_series_delete_atomic_contract.sql`
- `recurring_session_materialization_atomic_contract.sql`

They prove `service_role`-only execution among non-owner application roles,
template locking, idempotent recurring
materialization, same-tenant series deletion, preservation of past and other-tenant
sessions, audit creation, safe first-occurrence closure, and no resurrection after
deletion. Every synthetic row is rolled back.

## Isolated Rehearsal

Supabase CLI `2.95.4` replayed all repository migrations into a fresh disposable
local PostgreSQL 17.6 database. The history table was then changed locally to the
two production identities without re-running SQL. `supabase migration list
--local` reproduced the exact two-pair divergence.

The recommended order was rehearsed:

1. Mark `20260710001153` and `20260710010500` applied.
2. Observe four history rows: both repository and both production identities.
3. Mark `20260710010051` and `20260710010735` reverted.
4. Observe only the two repository identities and a fully matching migration list.
5. Recheck both function-definition hashes, ACLs, and focused behavior contracts.

The intermediate rollback was also rehearsed: after step 1, reverting the two
repository identities restored the original production-shaped two-row history.
The repair commands changed migration metadata only; both function hashes and
ACLs remained unchanged throughout.

## Exact Approved Action

Run from a private, non-traced shell. The detached worktree pins the two migration
files to the inspected repository baseline and prevents unrelated working-tree
state from entering the action.

```bash
set -euo pipefail
set +x

EXPECTED_PRODUCTION_REF=mimguepumzsgmcaycdsh
MIGRATION_SOURCE_SHA=49feb90f98c0b83ef6b3f38f43cb85e8e76ceb68
REPAIR_MODE="${REPAIR_MODE:-forward}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
INITIAL_HISTORY='20260710010051:atomic_recurring_session_materialization|20260710010735:fix_first_occurrence_series_delete'
ADDITIVE_HISTORY='20260710001153:atomic_recurring_session_materialization|20260710010051:atomic_recurring_session_materialization|20260710010500:fix_first_occurrence_series_delete|20260710010735:fix_first_occurrence_series_delete'
FINAL_HISTORY='20260710001153:atomic_recurring_session_materialization|20260710010500:fix_first_occurrence_series_delete'
STABLE_HISTORY='78:b97b56e3c883c1538cf1a85bd4dfc2ae'
EXPECTED_FUNCTION_STATE='2:7890f9aa36bb200f08153351f9ae98ab'

case "$REPAIR_MODE" in
  forward|restore-initial) ;;
  *)
    printf 'Refusing migration repair: unsupported REPAIR_MODE=%s.\n' "$REPAIR_MODE" >&2
    exit 1
    ;;
esac

REPAIR_PARENT="$(mktemp -d)"
REPAIR_WORKTREE="$REPAIR_PARENT/worktree"

cleanup_repair_worktree() {
  cd "$REPO_ROOT"
  git worktree remove --force "$REPAIR_WORKTREE" >/dev/null 2>&1 || true
  rmdir "$REPAIR_PARENT" >/dev/null 2>&1 || true
}

read_reconciliation_history() {
  supabase db query --linked --agent=no --output csv \
    "select string_agg(version || ':' || name, '|' order by version) as history
       from supabase_migrations.schema_migrations
      where version >= '20260710000000'" \
    | tail -n 1
}

read_stable_history() {
  supabase db query --linked --agent=no --output csv \
    "select count(*)::text || ':' ||
            md5(string_agg(version || ':' || name, '|' order by version)) as history
       from supabase_migrations.schema_migrations
      where version < '20260710000000'" \
    | tail -n 1
}

read_function_state() {
  supabase db query --linked --agent=no --output csv \
    "select count(*)::text || ':' ||
            md5(string_agg(
              p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' ||
              r.rolname || ':' || p.prosecdef::text || ':' ||
              coalesce(array_to_string(p.proconfig, ','), '') || ':' ||
              coalesce(array_to_string(p.proacl, ','), ''),
              '|' order by p.proname
            )) as state
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_roles r on r.oid = p.proowner
      where n.nspname = 'public'
        and p.proname in (
          'materialize_recurring_class_sessions',
          'delete_recurring_class_series_atomic'
        )" \
    | tail -n 1
}

assert_stable_history() {
  local actual
  actual="$(read_stable_history)"
  if [ "$actual" != "$STABLE_HISTORY" ]; then
    printf 'Refusing migration repair: earlier history changed.\nExpected: %s\nActual:   %s\n' \
      "$STABLE_HISTORY" "$actual" >&2
    return 1
  fi
}

assert_function_state() {
  local actual
  actual="$(read_function_state)"
  if [ "$actual" != "$EXPECTED_FUNCTION_STATE" ]; then
    printf 'Refusing migration repair: function definition, owner, security, search path, or ACL changed.\nExpected: %s\nActual:   %s\n' \
      "$EXPECTED_FUNCTION_STATE" "$actual" >&2
    return 1
  fi
}

assert_reconciliation_history() {
  local expected="$1"
  local actual
  actual="$(read_reconciliation_history)"
  if [ "$actual" != "$expected" ]; then
    printf 'Refusing migration repair: unexpected history.\nExpected: %s\nActual:   %s\n' \
      "$expected" "$actual" >&2
    return 1
  fi
}

trap cleanup_repair_worktree EXIT HUP INT TERM

git worktree add --detach "$REPAIR_WORKTREE" "$MIGRATION_SOURCE_SHA"
cd "$REPAIR_WORKTREE"
test -z "$(git status --porcelain)"

test "$(shasum -a 256 \
  supabase/migrations/20260710001153_atomic_recurring_session_materialization.sql \
  | awk '{print $1}')" \
  = 26ba57fb498237153d749b51a16783802808b6e83d92b59f460c7fd297cd24a1
test "$(shasum -a 256 \
  supabase/migrations/20260710010500_fix_first_occurrence_series_delete.sql \
  | awk '{print $1}')" \
  = de8a83f71a14b25559009189ff95e15529e7231fdbc3a952364ff0ae40408370

supabase link --project-ref "$EXPECTED_PRODUCTION_REF"
test "$(tr -d '\n' < supabase/.temp/project-ref)" \
  = "$EXPECTED_PRODUCTION_REF"

test "$(supabase --version | head -n 1)" = 2.95.4
assert_stable_history
assert_function_state

if [ "$REPAIR_MODE" = restore-initial ]; then
  # Guarded recovery is valid only from the exact four-row additive state.
  # It recreates and rechecks the same pinned target before changing history.
  assert_reconciliation_history "$ADDITIVE_HISTORY"
  supabase migration repair --linked --status reverted \
    20260710001153 20260710010500
  assert_stable_history
  assert_function_state
  assert_reconciliation_history "$INITIAL_HISTORY"
  supabase migration list --linked
  cleanup_repair_worktree
  trap - EXIT HUP INT TERM
  exit 0
fi

assert_reconciliation_history "$INITIAL_HISTORY"
supabase migration list --linked

# Safe additive step. If execution stops here, production retains its original
# identities and also has the repository identities; no history is missing.
supabase migration repair --linked --status applied \
  20260710001153 20260710010500
assert_stable_history
assert_function_state
assert_reconciliation_history "$ADDITIVE_HISTORY"
supabase migration list --linked

# Removal step only after the four-row intermediate state is confirmed.
supabase migration repair --linked --status reverted \
  20260710010051 20260710010735
assert_stable_history
assert_function_state
assert_reconciliation_history "$FINAL_HISTORY"
supabase migration list --linked

cleanup_repair_worktree
trap - EXIT HUP INT TERM
```

The machine assertions fail closed unless the 78 earlier rows retain their pinned
count and ordered-history digest and the two reconciled rows match the exact
initial, additive, and final states in this package. Together they cover the full
migration history at every checkpoint. The final list must also show no other
local/remote mismatch. Stop on any unexpected row or CLI version behavior.

## Failure and Recovery Modes

- **Target guard fails:** stop. Do not relink or substitute another project.
- **Source hash fails:** stop. Re-review the changed migration source before any
  production action.
- **Initial migration list differs from this package:** stop and rebuild the
  comparison; do not repair a moving target.
- **Adding repository identities fails:** the original production identities were
  not removed. Read the migration list and investigate.
- **Interrupted after the additive step:** leaving four rows is safe. Either retry
  the removal after reviewing the interruption evidence or use this package's
  explicitly approved contingency to rerun the complete guarded block above from
  a private, non-traced shell in recovery mode:

  ```bash
  export REPAIR_MODE=restore-initial
  # Then execute the complete pinned script in "Exact Approved Action" without modification.
  ```

  Do not run a standalone `migration repair` command from another working
  directory. Recovery fails closed unless the pinned production target, CLI,
  source hashes, 78-row digest, function/ACL digest, and exact four-row additive
  state all match before it removes either repository identity.

- **Removing production identities fails:** read the list and retry only the
  remaining production-only identity after confirming both repository identities
  are present. Do not re-run migration SQL.
- **Unexpected post-repair schema or privilege result:** stop releases. The repair
  itself cannot change function definitions, so investigate concurrent or
  unrelated database change. Keep the repository identities present and use a
  separately approved history recovery only if evidence requires it.

There is no application-data rollback because the proposed action does not touch
application tables. The production backup and restore plan remains the recovery
path for an unrelated database failure, not the normal response to this metadata
repair.

## Blast Radius and Expected Locks

`migration repair` changes rows only in `supabase_migrations.schema_migrations`.
It does not execute the stored migration SQL, replace functions, lock Koaryu
application tables, or modify tenant, attendance, schedule, tuition, billing, auth,
or Storage records. The action should be scheduled during a quiet operational
window so an unexpected control-plane or database connectivity failure can be
investigated without release pressure.

## Post-Action Evidence

After explicit approval and execution:

1. Record the full final migration list and timestamp in the release ledger.
2. Re-read both function-definition hashes, invoker/search-path state, and ACLs.
3. Re-run the two transaction-wrapped behavior contracts against isolated staging,
   not production.
4. Run database lint and the exact-candidate contract suite. Candidate-wide CI and
   merge controls are already enforced by closed gate #35; a failure here blocks
   further release work even though the history repair itself executes no schema SQL.
5. Attach the exact operator, CLI version, approval link, and result to #20.

## Adjacent Control Status

Candidate-wide CI and merge controls are complete under #35. Exact protected-main
run [29177478089](https://github.com/ronchak/Koaryu/actions/runs/29177478089)
passed a fresh disposable Supabase replay, database lint, all contract scripts,
frontend/backend suites, dependency audits, full-history secret scanning, Bandit,
CodeQL, and the aggregate release gate at
`d396f26552914d913125cccae5eeb247b4ff83b7`. The earlier local prepared-query and
container crash/tooling blocker is resolved and is not a remaining waiver.

## Approval Decision

Recommendation: **approve the exact history-only action above** after this package
and its PR receive skeptical and Codex review. Approval authorizes:

1. `forward` mode: add the two repository identities, verify the exact four-row
   additive state, then remove the two production-only identities.
2. `restore-initial` contingency mode only if the forward action is interrupted
   in that exact four-row additive state: recreate every target/source/history/
   function guard, remove the two repository identities, and verify restoration
   of the exact initial two-row production history.

Approval does not authorize recovery from any other history state, any standalone
or modified repair command, migration SQL execution, production-data change, live
Stripe change, paid-infrastructure change, or broader release.
