# Production Migration Reconciliation

Status: **approval package prepared; production action not authorized or executed**

Release gate: [#20](https://github.com/ronchak/Koaryu/issues/20)
Repository baseline: `49feb90f98c0b83ef6b3f38f43cb85e8e76ceb68`
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

Repairing production migration history is a reserved action. The commands below
must not run until Ronak explicitly approves this exact package.

## Observed Identities

| Logical migration | Repository/staging identity | Production identity | Name match |
| --- | --- | --- | --- |
| Recurring-session materialization | `20260710001153` | `20260710010051` | yes |
| First-occurrence series delete | `20260710010500` | `20260710010735` | yes |

All 78 earlier migration identities match. The guarded production and staging
migration reads were performed on 2026-07-11. No production mutation occurred.

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
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPAIR_PARENT="$(mktemp -d)"
REPAIR_WORKTREE="$REPAIR_PARENT/worktree"
INITIAL_HISTORY='20260710010051:atomic_recurring_session_materialization|20260710010735:fix_first_occurrence_series_delete'
ADDITIVE_HISTORY='20260710001153:atomic_recurring_session_materialization|20260710010051:atomic_recurring_session_materialization|20260710010500:fix_first_occurrence_series_delete|20260710010735:fix_first_occurrence_series_delete'
FINAL_HISTORY='20260710001153:atomic_recurring_session_materialization|20260710010500:fix_first_occurrence_series_delete'
STABLE_HISTORY='78:b97b56e3c883c1538cf1a85bd4dfc2ae'

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

assert_stable_history() {
  local actual
  actual="$(read_stable_history)"
  if [ "$actual" != "$STABLE_HISTORY" ]; then
    printf 'Refusing migration repair: earlier history changed.\nExpected: %s\nActual:   %s\n' \
      "$STABLE_HISTORY" "$actual" >&2
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
assert_reconciliation_history "$INITIAL_HISTORY"
supabase migration list --linked

# Safe additive step. If execution stops here, production retains its original
# identities and also has the repository identities; no history is missing.
supabase migration repair --linked --status applied \
  20260710001153 20260710010500
assert_stable_history
assert_reconciliation_history "$ADDITIVE_HISTORY"
supabase migration list --linked

# Removal step only after the four-row intermediate state is confirmed.
supabase migration repair --linked --status reverted \
  20260710010051 20260710010735
assert_stable_history
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
  the removal after review or restore the original history with the rehearsed
  command below:

  ```bash
  supabase migration repair --linked --status reverted \
    20260710001153 20260710010500
  ```

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
4. Run database lint and the candidate contract suite after the separate #35 local
   PostgreSQL crash/tooling blocker is resolved.
5. Attach the exact operator, CLI version, approval link, and result to #20.

## Known Adjacent Blocker

The migration-focused checks pass, but the candidate-wide local contract run is
not green. Supabase CLI 2.95.4 cannot execute several multi-statement verification
files through its prepared-query path, and container `psql` deterministically
triggered a PostgreSQL 17.6 backend segmentation fault in
`studio_onboarding_atomic_smoke.sql`. PostgreSQL recovered automatically. This is
tracked in #35 with #24 security coordination and is not waived by this package.

## Approval Decision

Recommendation: **approve the exact history-only action above** after this package
and its PR receive skeptical and Codex review. Approval authorizes only adding the
two repository identities and removing the two production-only identities. It does
not authorize migration SQL execution, any production-data change, live Stripe
change, or broader release.
