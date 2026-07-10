# Staging and Recovery Runbook

Use this runbook to rebuild Koaryu staging, prove that it is isolated from production, create an encrypted logical backup, and rehearse a restore. Production changes are out of scope unless they have the explicit approvals listed in [the release ledger](release-ledger.md).

## Environment Boundaries

| Environment | Supabase project ref | Stripe mode | Rule |
| --- | --- | --- | --- |
| Production | `mimguepumzsgmcaycdsh` | Live configuration is production-only | Never use as a staging, replay, or restore target |
| Current staging | `nxgsektqsgrtyfhawxbc` | Test only | May contain sanitized fixtures; must not contain production-derived rows |

The current `koaryu-staging` project is isolated: all 80 repository migrations were replayed, the production backup was **not** restored into it, and it contains only the synthetic `River City Martial Arts` fixture. The temporary hosted restore target used for the July 10 drill was `zmmacdleiaohvxdubrav`; it was deleted after validation.

Staging frontend and backend configuration must point only to `nxgsektqsgrtyfhawxbc`. They must not contain the production Supabase ref, any `sk_live_`/`rk_live_`/`pk_live_` Stripe value, the production frontend origin, or a production backend destination. Never print secret values while checking this.

Run this guard in a private shell before any staging migration, seed, restore, or deploy command:

```bash
set -euo pipefail
set +x
export EXPECTED_STAGING_REF=nxgsektqsgrtyfhawxbc
export PRODUCTION_REF=mimguepumzsgmcaycdsh

test "$SUPABASE_PROJECT_REF" = "$EXPECTED_STAGING_REF"
test "$SUPABASE_PROJECT_REF" != "$PRODUCTION_REF"
test "$SUPABASE_URL" = "https://${EXPECTED_STAGING_REF}.supabase.co"

case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *) echo "Refusing: staging Stripe secret key is absent or not test mode" >&2; exit 1 ;;
esac
case "${STRIPE_RESTRICTED_KEY:-}" in
  ""|rk_test_*) ;;
  *) echo "Refusing: staging restricted key is not test mode" >&2; exit 1 ;;
esac
```

Before a frontend or backend staging deploy, also run the application guard below. It intentionally fails while the expected staging origins are unknown. Assign dedicated staging URLs first; do not substitute production URLs to make the guard pass.

```bash
set -euo pipefail
set +x
: "${EXPECTED_STAGING_FRONTEND_ORIGIN:?set the dedicated staging frontend origin}"
: "${EXPECTED_STAGING_BACKEND_API:?set the dedicated staging backend /api/v1 URL}"

normalize_url() {
  local value="$1"
  while [ "${value%/}" != "$value" ]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

EXPECTED_STAGING_FRONTEND_ORIGIN="$(normalize_url "$EXPECTED_STAGING_FRONTEND_ORIGIN")"
EXPECTED_STAGING_BACKEND_API="$(normalize_url "$EXPECTED_STAGING_BACKEND_API")"
CONFIGURED_STAGING_FRONTEND_ORIGIN="$(normalize_url "$NEXT_PUBLIC_SITE_URL")"
CONFIGURED_STAGING_PUBLIC_API="$(normalize_url "$NEXT_PUBLIC_API_URL")"
CONFIGURED_STAGING_BACKEND_API="$(normalize_url "$BACKEND_API_URL")"

case "$EXPECTED_STAGING_FRONTEND_ORIGIN" in
  https://koaryu.app|https://www.koaryu.app)
    echo "Refusing: staging frontend origin resolves to production" >&2; exit 1 ;;
esac
case "$EXPECTED_STAGING_BACKEND_API" in
  https://koaryu.onrender.com|https://koaryu.onrender.com/*)
    echo "Refusing: staging backend API resolves to production" >&2; exit 1 ;;
esac
test "$NEXT_PUBLIC_SUPABASE_URL" = "https://${EXPECTED_STAGING_REF}.supabase.co"
test "$NEXT_PUBLIC_SUPABASE_URL" != "https://${PRODUCTION_REF}.supabase.co"
test "$CONFIGURED_STAGING_FRONTEND_ORIGIN" = "$EXPECTED_STAGING_FRONTEND_ORIGIN"
test "$CONFIGURED_STAGING_PUBLIC_API" = "$EXPECTED_STAGING_BACKEND_API"
test "$CONFIGURED_STAGING_BACKEND_API" = "$EXPECTED_STAGING_BACKEND_API"

case "${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:-}" in
  pk_test_*) ;;
  *) echo "Refusing: staging publishable key is absent or not test mode" >&2; exit 1 ;;
esac
case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *) echo "Refusing: staging secret key is absent or not test mode" >&2; exit 1 ;;
esac
case "${STRIPE_RESTRICTED_KEY:-}" in
  ""|rk_test_*) ;;
  *) echo "Refusing: staging restricted key is not test mode" >&2; exit 1 ;;
esac
```

Webhook signing secrets do not encode test/live mode in their prefix. Confirm both configured endpoint URLs in the Stripe dashboard are the dedicated staging backend before installing those secrets. The current gate remains blocked because no staging frontend or backend URL has been assigned or deployed.

## Rebuild Clean Staging

1. Create or select a Supabase project that is separate from production. Set `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, and test-mode Stripe variables, then run the guard above.
2. Link the repository only after the guard passes. Confirm the saved ref before continuing:

   ```bash
   supabase link --project-ref "$SUPABASE_PROJECT_REF"
   test "$(tr -d '\n' < supabase/.temp/project-ref)" = "$EXPECTED_STAGING_REF"
   supabase migration list --linked
   ```

3. Preview the replay, then apply all repository migrations to the clean target:

   ```bash
   supabase db push --linked --include-all --dry-run
   supabase db push --linked --include-all
   supabase migration list --linked
   supabase db lint --linked --fail-on error
   SUPABASE_DB_TARGET=linked scripts/verify-supabase-contracts.sh
   ```

   These linked checks are appropriate only because this procedure deliberately targets staging after its migrations have been applied. Never substitute the production project ref.

4. Load only reviewed, sanitized fixtures. The seed studio should cover authentication, students, guardians, attendance, schedules, ranks, leads, staff roles, and billing-readiness tests without production PII.
5. Before deploying staging applications, rerun the target guard and verify that both application environments reference the staging Supabase URL, test Stripe mode, and staging webhook endpoints.

## Encrypted Logical Backup

The validated Wave 0 backup is stored at:

`/Users/ronakchak/Koaryu Backups/production-20260710T070020Z`

It contains encrypted role, schema, and data dumps. For a new backup, first confirm that the Supabase CLI is linked to production and that the operation is dump-only. This target check is intentionally the inverse of the staging guard:

```bash
set -euo pipefail
set +x
export EXPECTED_PRODUCTION_REF=mimguepumzsgmcaycdsh
test "$(tr -d '\n' < supabase/.temp/project-ref)" = "$EXPECTED_PRODUCTION_REF"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/Users/ronakchak/Koaryu Backups/production-${STAMP}"
DUMP_DIR=""
BACKUP_PASSWORD=""
BACKUP_COMPLETE=false
cleanup_backup() {
  unset BACKUP_PASSWORD
  if [ -n "${DUMP_DIR:-}" ] && [ -d "$DUMP_DIR" ]; then
    rm -rf -- "$DUMP_DIR"
  fi
  if [ "${BACKUP_COMPLETE:-false}" != true ] && [ -n "${BACKUP_DIR:-}" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf -- "$BACKUP_DIR"
  fi
}
trap cleanup_backup EXIT HUP INT TERM

DUMP_DIR="$(mktemp -d)"
test ! -e "$BACKUP_DIR"
mkdir -m 700 "$BACKUP_DIR"

supabase db dump --linked --role-only --file "$DUMP_DIR/roles.sql"
supabase db dump --linked --file "$DUMP_DIR/schema.sql"
supabase db dump --linked --data-only --use-copy \
  --exclude storage.buckets_vectors \
  --exclude storage.vector_indexes \
  --file "$DUMP_DIR/data.sql"

BACKUP_PASSWORD="$(security find-generic-password \
  -s com.koaryu.backup.encryption -w)"
export BACKUP_PASSWORD

openssl enc -aes-256-cbc -salt -pbkdf2 \
  -pass env:BACKUP_PASSWORD \
  -in "$DUMP_DIR/roles.sql" -out "$BACKUP_DIR/roles.sql.enc"
openssl enc -aes-256-cbc -salt -pbkdf2 \
  -pass env:BACKUP_PASSWORD \
  -in "$DUMP_DIR/schema.sql" -out "$BACKUP_DIR/schema.sql.enc"
openssl enc -aes-256-cbc -salt -pbkdf2 \
  -pass env:BACKUP_PASSWORD \
  -in "$DUMP_DIR/data.sql" -out "$BACKUP_DIR/data.sql.enc"

(cd "$BACKUP_DIR" && shasum -a 256 *.enc)
BACKUP_COMPLETE=true
cleanup_backup
trap - EXIT HUP INT TERM
```

Do not place the password in a command argument, repository file, shell trace, or release record. The key is held in macOS Keychain under service `com.koaryu.backup.encryption`. Record the hashes and backup path in the release ledger, then move the encrypted artifacts to the approved off-site location. No plaintext dump may remain after verification.

The July 10 backup used PostgreSQL 17 on the host because the local container runtime could not resolve Supabase's direct IPv6-only database hostname. If the normal CLI command fails for the same reason, use `supabase db dump --dry-run` only inside a private, non-traced shell, capture its generated script without printing it, replace the generated `pg_dump` or `pg_dumpall` executable with the trusted PostgreSQL 17 host binary, and pipe its output directly into the encryption command. The generated script contains a short-lived database password and must never be logged, saved, or pasted into a release record.

Verify the validated artifacts before a restore:

```bash
cd "/Users/ronakchak/Koaryu Backups/production-20260710T070020Z"
shasum -a 256 -c <<'EOF'
8be3e1087a2ebe1ab6306ca93e1489cb70666be4ca6e850d495c75d1a5a2e948  data.sql.enc
040e6904f8cf7934fca3b0463503d4e887637b84fd419927d58e929c57e133a4  roles.sql.enc
e894ecea0723d1a9d5e07c8e9635993d42625d7acd52ae7a324bd702d231ff3e  schema.sql.enc
c919a4ab5475b02ffc0ff2228673b81ed5ebadb67b9f4143bbaa4fea1ff4847b  record-classification-manifest.json.enc
EOF
```

## Restore Drill

A restore target is disposable and isolated. Never use current staging, production, or any project containing records that must be retained.

1. Create a temporary hosted Supabase project. Record its new ref as `RESTORE_REF`, then explicitly reject every durable target:

   ```bash
   set -euo pipefail
   test -n "$RESTORE_REF"
   test "$RESTORE_REF" != mimguepumzsgmcaycdsh
   test "$RESTORE_REF" != nxgsektqsgrtyfhawxbc
   test "$RESTORE_REF" != zmmacdleiaohvxdubrav
   export PGHOST="db.${RESTORE_REF}.supabase.co"
   export PGPORT=5432
   export PGSSLMODE=require
   test "$PGHOST" = "db.${RESTORE_REF}.supabase.co"
   ```

   Set `PGUSER`, `PGDATABASE`, and `PGPASSWORD` from the temporary project's transient connection details in a private shell. Do not record them.

2. Verify the encrypted checksums, decrypt into a locked temporary directory, restore, and validate in one failure-safe shell:

   ```bash
   set -euo pipefail
   set +x
   umask 077
   BACKUP_DIR="/Users/ronakchak/Koaryu Backups/production-20260710T070020Z"
   RESTORE_DIR=""
   BACKUP_PASSWORD=""
   cleanup_restore() {
     unset BACKUP_PASSWORD PGPASSWORD PGUSER PGDATABASE PGHOST PGPORT PGSSLMODE
     if [ -n "${RESTORE_DIR:-}" ] && [ -d "$RESTORE_DIR" ]; then
       rm -rf -- "$RESTORE_DIR"
     fi
   }
   trap cleanup_restore EXIT HUP INT TERM

   (cd "$BACKUP_DIR" && shasum -a 256 -c <<'EOF'
   8be3e1087a2ebe1ab6306ca93e1489cb70666be4ca6e850d495c75d1a5a2e948  data.sql.enc
   040e6904f8cf7934fca3b0463503d4e887637b84fd419927d58e929c57e133a4  roles.sql.enc
   e894ecea0723d1a9d5e07c8e9635993d42625d7acd52ae7a324bd702d231ff3e  schema.sql.enc
   c919a4ab5475b02ffc0ff2228673b81ed5ebadb67b9f4143bbaa4fea1ff4847b  record-classification-manifest.json.enc
   EOF
   )

   RESTORE_DIR="$(mktemp -d)"
   BACKUP_PASSWORD="$(security find-generic-password \
     -s com.koaryu.backup.encryption -w)"
   export BACKUP_PASSWORD

   for name in roles schema data; do
     openssl enc -d -aes-256-cbc -pbkdf2 \
       -pass env:BACKUP_PASSWORD \
       -in "$BACKUP_DIR/${name}.sql.enc" -out "$RESTORE_DIR/${name}.sql"
   done
   unset BACKUP_PASSWORD

   psql --no-psqlrc --single-transaction --set ON_ERROR_STOP=1 \
     --file "$RESTORE_DIR/roles.sql" \
     --file "$RESTORE_DIR/schema.sql" \
     --command 'SET session_replication_role = replica' \
     --file "$RESTORE_DIR/data.sql"

   psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align <<'SQL'
   select 'public_tables=' || count(*)
     from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE';
   select 'auth_users=' || count(*) from auth.users;
   select 'studios=' || count(*) from public.studios;
   select 'onboarding_rpc=' || (to_regprocedure('public.create_studio_onboarding(uuid,text,text,text)') is not null);
   SQL

   cleanup_restore
   trap - EXIT HUP INT TERM
   ```

3. Validate only aggregate, non-PII evidence. The July 10 drill produced 37 `public` tables, 61 `auth.users` rows, and 52 `public.studios` rows. A future drill must also run an authenticated tenant-safe application read before it is considered a full application recovery exercise.
4. Delete the temporary hosted target through the Supabase control plane only after the operator reconfirms `RESTORE_REF`. Unset `RESTORE_REF` and `BACKUP_DIR` afterward. Recreate ordinary staging from repository migrations, not from the production backup.

## Recovery Decision

- For application-only regression, redeploy the release ledger's named application rollback SHA; do not change database history.
- For a forward-compatible schema regression, prefer a reviewed forward-only corrective migration.
- Do not use `supabase migration repair`, rewrite old migrations, restore over production, or delete production data without an approved recovery plan and the explicit approval required by the release ledger.
- If credentials, target identity, or approval is uncertain, stop. Record the blocked check instead of treating it as passed.
