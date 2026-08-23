# Production PostgreSQL image patch

This is the operator packet for one managed Supabase PostgreSQL image patch. It
covers the production logical backup, a disposable exact-image restore, the
CTO-only provider request, and the post-upgrade readback.

Track the live gate in [GitHub issue #125](https://github.com/ronchak/Koaryu/issues/125).
The issue stays open until the CTO records live proof. Keep its public record
minimal; all credentials, dump details, provider responses, and customer data
remain in the private operator record.

The packet is valid only for these exact values:

| Item | Required value |
| --- | --- |
| Production Supabase project | mimguepumzsgmcaycdsh |
| Staging Supabase project | nxgsektqsgrtyfhawxbc |
| Supabase organization | eyvreliqyrztcbdmzrlv |
| Pre-upgrade production image | 17.6.1.105 |
| Target image | 17.6.1.155 |
| PostgreSQL major | 17 |
| Release channel | ga |
| Production migration count and head | 115 / 20260822193000 |
| Unchanged served application SHA | ae73361490a06a104fdd7ac4e0f9788b999f641b |
| Disposable restore image | docker.io/supabase/postgres:17.6.1.155 |

The target is an image-only patch. Do not change the organization plan, run an
application migration, deploy a new Render or Vercel build, invoke a crash
probe, or use production or staging as a restore target.

The CI evidence for public.ecr.aws/supabase/postgres:17.6.1.156 is a separate
local threshold proof. It is one patch newer than the hosted GA 17.6.1.155
target and is not byte-identical production evidence.

## Stop conditions and phase ownership

Stop immediately on a target, image, release-channel, plan, migration,
credential, client, archive, snapshot, OID, restore, role-cleanup, provider,
readiness, or served-SHA mismatch. A failed command, warning on dump or restore
stderr, nonzero exit, or incomplete private artifact is a failed gate.

The phases have different owners:

1. PM inspection is read-only. Re-read project identity, health, image, plan,
   backup/PITR state, migration head, served SHA, and the exact upgrade
   eligibility response.
2. The CTO owns the temporary production role, the raw dump, the disposable
   restore gate, and all cleanup. The role and its exact large-object grants
   are hosted writes.
3. The CTO owns the provider image request. Prepare the exact request body only
   after the backup and eligibility gates pass. Do not treat a tracking ID or
   HTTP acknowledgement as completion.
4. The CTO owns post-upgrade readback. Completion requires the authoritative
   project readback, unchanged migration history, unchanged served SHA, both
   readiness routes, and live API smoke checks.

Never save a provider response, password, connection string, dump content,
customer row, or private API response in the repository, a release comment, or
a shell trace.

## 1. Private shell and allowlist

Run the following in a private Bash shell. Keep set +x enabled for the whole
operation. The input values in this section come from a fresh private provider
read, not from an old runbook or a copied acknowledgement.

~~~bash
#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

readonly PRODUCTION_REF="mimguepumzsgmcaycdsh"
readonly STAGING_REF="nxgsektqsgrtyfhawxbc"
readonly ORGANIZATION_REF="eyvreliqyrztcbdmzrlv"
readonly PRE_UPGRADE_IMAGE="17.6.1.105"
readonly TARGET_IMAGE="17.6.1.155"
readonly TARGET_POSTGRES_MAJOR="17"
readonly TARGET_RELEASE_CHANNEL="ga"
readonly PRE_MIGRATION_COUNT="115"
readonly PRE_MIGRATION_HEAD="20260822193000"
readonly EXPECTED_SERVED_SHA="ae73361490a06a104fdd7ac4e0f9788b999f641b"
readonly RESTORE_IMAGE="docker.io/supabase/postgres:17.6.1.155"
readonly EXPECTED_RESTORE_DIGEST_SHA="sha256:3866d94d8426927e8db3f1c5d790752292bfbe27b5f1f46e199ae1b7d3c1710b"
readonly RESTORE_REF="disposable-local-postgres-17-6-1-155"

: "${OBSERVED_PROJECT_REF:?set from a fresh private get_project read}"
: "${OBSERVED_PROJECT_STATUS:?set from a fresh private get_project read}"
: "${OBSERVED_CURRENT_IMAGE:?set from a fresh private get_project read}"
: "${OBSERVED_RELEASE_CHANNEL:?set from a fresh private get_project read}"
: "${OBSERVED_MIGRATION_COUNT:?set from a fresh private migration read}"
: "${OBSERVED_MIGRATION_HEAD:?set from a fresh private migration read}"
: "${OBSERVED_SERVED_SHA:?set from a fresh private Render/readiness read}"
: "${OBSERVED_PLAN:?set from a fresh private organization read}"
: "${OBSERVED_PITR_ENABLED:?set from a fresh private backup/PITR read}"

test "$OBSERVED_PROJECT_REF" = "$PRODUCTION_REF"
test "$OBSERVED_PROJECT_REF" != "$STAGING_REF"
test "$OBSERVED_PROJECT_STATUS" = "ACTIVE_HEALTHY"
test "$OBSERVED_CURRENT_IMAGE" = "$PRE_UPGRADE_IMAGE"
test "$OBSERVED_RELEASE_CHANNEL" = "$TARGET_RELEASE_CHANNEL"
test "$OBSERVED_MIGRATION_COUNT" = "$PRE_MIGRATION_COUNT"
test "$OBSERVED_MIGRATION_HEAD" = "$PRE_MIGRATION_HEAD"
test "$OBSERVED_SERVED_SHA" = "$EXPECTED_SERVED_SHA"
test "$OBSERVED_PLAN" = "free"
test "$OBSERVED_PITR_ENABLED" = "false"

case "$RESTORE_REF" in
  "$PRODUCTION_REF"|"$STAGING_REF"|*.supabase.co|db.*.supabase.co)
    echo "Refusing a hosted restore target" >&2
    exit 1
    ;;
esac

: "${DB_HOST:?set the private production database host}"
: "${OBSERVED_DB_HOST:?set from the same fresh production connection readback as DB_HOST}"
: "${DB_PORT:?set the private production database port}"
: "${DB_NAME:?set the private production database name}"
: "${DB_ADMIN_USER:?set the private administrative database user}"
: "${PG17_CLIENT_DIR:?set an absolute directory containing validated PostgreSQL 17 clients}"
: "${RESTORE_PORT:?set a free localhost TCP port for the disposable target}"

case "$DB_HOST" in
  ""|127.0.0.1|localhost|/private/tmp/*|/tmp/*)
    echo "Refusing a local source host" >&2
    exit 1
    ;;
esac
test "$DB_HOST" = "$OBSERVED_DB_HOST"
case "$DB_HOST" in
  "db.${PRODUCTION_REF}.supabase.co"|*.pooler.supabase.com) ;;
  *) echo "Refusing an unrecognized production connection host" >&2; exit 1 ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel)"
BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/koaryu-pg-image-patch.XXXXXX")"
chmod 700 "$BACKUP_DIR"
case "$BACKUP_DIR" in
  "$REPO_ROOT"|"$REPO_ROOT"/*)
    echo "Refusing a backup directory inside the repository" >&2
    exit 1
    ;;
esac

DUMP_FILE="$BACKUP_DIR/production.custom.dump"
DUMP_STDERR="$BACKUP_DIR/pg_dump.stderr"
DUMP_SHA256="$BACKUP_DIR/production.custom.dump.sha256"
TOC_FILE="$BACKUP_DIR/production.toc"
TOC_STDERR="$BACKUP_DIR/production.toc.stderr"
SNAPSHOT_FILE="$BACKUP_DIR/source.snapshot"
SNAPSHOT_STDERR="$BACKUP_DIR/source.snapshot.stderr"
SOURCE_SCHEMAS="$BACKUP_DIR/source.schemas"
SOURCE_TABLES="$BACKUP_DIR/source.tables"
SOURCE_COUNTS="$BACKUP_DIR/source.table-counts"
SOURCE_SEQUENCES="$BACKUP_DIR/source.sequences"
SOURCE_LARGE_OBJECTS="$BACKUP_DIR/source.large-object-oids"
SOURCE_MIGRATIONS="$BACKUP_DIR/source.migration-history"
SOURCE_MIGRATION_STATE="$BACKUP_DIR/source.migration-state"
SOURCE_EXTENSIONS="$BACKUP_DIR/source.extensions"
SOURCE_ROLES="$BACKUP_DIR/source.role-names"
SOURCE_OWNER_ACL="$BACKUP_DIR/source.owner-acl"
TARGET_SCHEMAS="$BACKUP_DIR/target.schemas"
TARGET_TABLES="$BACKUP_DIR/target.tables"
TARGET_COUNTS="$BACKUP_DIR/target.table-counts"
TARGET_SEQUENCES="$BACKUP_DIR/target.sequences"
TARGET_LARGE_OBJECTS="$BACKUP_DIR/target.large-object-oids"
TARGET_MIGRATIONS="$BACKUP_DIR/target.migration-history"
TARGET_MIGRATION_STATE="$BACKUP_DIR/target.migration-state"
TARGET_EXTENSIONS="$BACKUP_DIR/target.extensions"
TARGET_AVAILABLE_EXTENSIONS="$BACKUP_DIR/target.available-extensions"
TARGET_OWNER_ACL="$BACKUP_DIR/target.owner-acl"
RELEASE_RECORD="$BACKUP_DIR/release-record"
ROLE_PASSWORD_FILE="$BACKUP_DIR/backup-role.password"
ROLE_SQL_FILE="$BACKUP_DIR/backup-role.sql"
RESTORE_PASSWORD_FILE="$BACKUP_DIR/restore.password"
RESTORE_ENV_FILE="$BACKUP_DIR/restore.env"
RESTORE_CONTAINER_ID="$BACKUP_DIR/restore.container-id"
RESTORE_IMAGE_READBACK="$BACKUP_DIR/restore.image-readback"
RESTORE_IMAGE_DIGEST="$BACKUP_DIR/restore.image-digest"
RESTORE_INIT_LOG="$BACKUP_DIR/restore.init.log"
RESTORE_INIT_STDERR="$BACKUP_DIR/restore.init.stderr"
RESTORE_PULL_STDOUT="$BACKUP_DIR/restore.pull.stdout"
RESTORE_PULL_STDERR="$BACKUP_DIR/restore.pull.stderr"
RESTORE_STDERR="$BACKUP_DIR/pg_restore.stderr"
PROVIDER_AUTH_HEADER="$BACKUP_DIR/provider.auth.header"

readonly BACKUP_ROLE="koaryu_prod_image_patch_backup"
ROLE_CREATED=false
RESTORE_PLACEHOLDER_CREATED=false
RESTORE_CONTAINER_STARTED=false
SNAPSHOT_OPEN=false
BACKUP_COMPLETE=false
RESTORE_HOST="127.0.0.1"
RESTORE_DB_NAME="postgres"
RESTORE_ADMIN_DB_NAME="postgres"
RESTORE_DB_USER="supabase_admin"
DOCKER_BIN="${DOCKER_BIN:-docker}"

read -r -s -p "Production administrative password: " DB_ADMIN_PASSWORD
printf '\n' >&2

case "$BACKUP_ROLE" in
  ''|*[!a-z0-9_]*|[0-9]*)
    echo "Refusing an unsafe temporary role name" >&2
    exit 1
    ;;
esac
~~~

The source is production only. The restore label is local only. Never set
RESTORE_HOST to a Supabase hostname, and never set RESTORE_REF to either
hosted project.

## 2. Client and shell helpers

Do not use the default psql from ~/.local. This host has a broken libpq binary
that exits with _PQbackendPID. The three clients below must report PostgreSQL
17 before any database credential is used.

The helper functions keep passwords out of command arguments and logs. The
temporary backup password is generated into a mode-600 file and removed after
the source role is dropped.

~~~bash
PG_DUMP_BIN="$PG17_CLIENT_DIR/pg_dump"
PG_RESTORE_BIN="$PG17_CLIENT_DIR/pg_restore"
PSQL_BIN="$PG17_CLIENT_DIR/psql"

for binary in "$PG_DUMP_BIN" "$PG_RESTORE_BIN" "$PSQL_BIN"; do
  test -x "$binary"
  version="$("$binary" --version 2>/dev/null)"
  case "$version" in
    *"PostgreSQL) 17."*) ;;
    *)
      echo "Refusing a missing, broken, or non-PostgreSQL-17 client: $binary" >&2
      exit 1
      ;;
  esac
done

openssl rand -hex 32 > "$ROLE_PASSWORD_FILE"
chmod 600 "$ROLE_PASSWORD_FILE"
ROLE_PASSWORD="$(tr -d '\n' < "$ROLE_PASSWORD_FILE")"
test "${#ROLE_PASSWORD}" -ge 32

psql_admin() {
  PGPASSWORD="$DB_ADMIN_PASSWORD" "$PSQL_BIN" \
    --host="$DB_HOST" --port="$DB_PORT" --username="$DB_ADMIN_USER" \
    --dbname="$DB_NAME" --no-password --no-psqlrc \
    --set=ON_ERROR_STOP=1 --quiet "$@"
}

psql_admin_query() {
  psql_admin --tuples-only --no-align "$@"
}

psql_backup() {
  PGPASSWORD="$ROLE_PASSWORD" "$PSQL_BIN" \
    --host="$DB_HOST" --port="$DB_PORT" --username="$BACKUP_ROLE" \
    --dbname="$DB_NAME" --no-password --no-psqlrc \
    --set=ON_ERROR_STOP=1 --quiet "$@"
}

psql_backup_query() {
  psql_backup --tuples-only --no-align "$@"
}

write_owner_acl() {
  local output="$1"
  shift
  "$@" > "$output" <<'SQL'
WITH records AS (
  SELECT 'schema' AS kind, n.nspname AS object_name,
         pg_get_userbyid(n.nspowner) AS owner_name,
         coalesce(n.nspacl::text, '') AS acl
  FROM pg_catalog.pg_namespace AS n
  WHERE n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_depend AS d
      WHERE d.classid = 'pg_namespace'::regclass
        AND d.objid = n.oid
        AND d.refclassid = 'pg_extension'::regclass
        AND d.deptype = 'e'
    )
  UNION ALL
  SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'relation' END,
         n.nspname || '.' || c.relname,
         pg_get_userbyid(c.relowner),
         coalesce(c.relacl::text, '')
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_depend AS d
      WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid
        AND d.refclassid = 'pg_extension'::regclass
        AND d.deptype = 'e'
    )
  UNION ALL
  SELECT 'routine',
         n.nspname || '.' || p.proname || ':' ||
           pg_get_function_identity_arguments(p.oid),
         pg_get_userbyid(p.proowner),
         coalesce(p.proacl::text, '')
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname <> 'pg_catalog'
    AND n.nspname <> 'information_schema'
    AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_depend AS d
      WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid
        AND d.refclassid = 'pg_extension'::regclass
        AND d.deptype = 'e'
    )
  UNION ALL
  SELECT 'large-object', lom.oid::text,
         pg_get_userbyid(lom.lomowner),
         coalesce(lom.lomacl::text, '')
  FROM pg_catalog.pg_largeobject_metadata AS lom
)
SELECT kind || '|' || object_name || '|' || owner_name || '|' || acl
FROM records
ORDER BY kind, object_name;
SQL
  chmod 600 "$output"
}

cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  set +e

  if [[ "$SNAPSHOT_OPEN" = true ]]; then
    printf 'ROLLBACK;\n' >&9 2>/dev/null
    exec 9>&- 2>/dev/null
    SNAPSHOT_OPEN=false
  fi
  if [[ -n "${SNAPSHOT_PID:-}" ]]; then
    wait "$SNAPSHOT_PID" 2>/dev/null
  fi
  if [[ -n "${SNAPSHOT_STDERR:-}" && -s "$SNAPSHOT_STDERR" ]]; then
    exit_code=1
  fi

  if [[ "$ROLE_CREATED" = true ]]; then
    psql_admin --command \
      "REVOKE pg_read_all_data FROM \"$BACKUP_ROLE\";
       DROP OWNED BY \"$BACKUP_ROLE\";
       DROP ROLE \"$BACKUP_ROLE\";" >/dev/null 2>/dev/null
    role_exists="$(psql_admin_query --command \
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                      WHERE rolname = '$BACKUP_ROLE');" 2>/dev/null |
      tr -d '[:space:]')"
    if [[ "$role_exists" = f ]]; then
      ROLE_CREATED=false
    else
      exit_code=1
    fi
  fi

  if [[ "$RESTORE_PLACEHOLDER_CREATED" = true && -n "${RESTORE_DB_PASSWORD:-}" ]]; then
    PGPASSWORD="$RESTORE_DB_PASSWORD" "$PSQL_BIN" \
      --host="$RESTORE_HOST" --port="$RESTORE_PORT" \
      --username="$RESTORE_DB_USER" --dbname="$RESTORE_DB_NAME" \
      --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet \
      --command "DROP OWNED BY \"$BACKUP_ROLE\"; DROP ROLE \"$BACKUP_ROLE\";" \
      >/dev/null 2>/dev/null
    RESTORE_PLACEHOLDER_CREATED=false
  elif [[ "$RESTORE_PLACEHOLDER_CREATED" = true ]]; then
    exit_code=1
  fi

  if [[ "$RESTORE_CONTAINER_STARTED" = true ]]; then
    if ! "$DOCKER_BIN" stop "$RESTORE_CONTAINER" >/dev/null 2>/dev/null; then
      exit_code=1
    fi
    for remove_attempt in 1 2 3 4 5 6 7 8 9 10; do
      "$DOCKER_BIN" inspect "$RESTORE_CONTAINER" >/dev/null 2>&1 || break
      sleep 1
    done
    "$DOCKER_BIN" inspect "$RESTORE_CONTAINER" >/dev/null 2>&1 && exit_code=1
    RESTORE_CONTAINER_STARTED=false
  fi

  rm -f "${ROLE_PASSWORD_FILE:-}" "${ROLE_SQL_FILE:-}" \
    "${RESTORE_PASSWORD_FILE:-}" "${RESTORE_ENV_FILE:-}" \
    "${PROVIDER_AUTH_HEADER:-}"
  unset ROLE_PASSWORD DB_ADMIN_PASSWORD RESTORE_DB_PASSWORD RESTORE_PASSWORD \
    SUPABASE_ACCESS_TOKEN
  if [[ "$BACKUP_COMPLETE" != true ]]; then
    case "${BACKUP_DIR:-}" in
      ""|/|"$REPO_ROOT"|"$REPO_ROOT"/*) exit_code=1 ;;
      *) rm -rf -- "$BACKUP_DIR" ;;
    esac
  fi
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM
~~~

The owner/ACL file contains role names, object names, and ACL metadata only.
It never contains passwords or table rows.

## 3. Read-only source preflight

Run these checks before creating the temporary role. They are source metadata
checks, not a substitute for the dump gate.

~~~bash
SOURCE_DEPENDENCIES="$BACKUP_DIR/source.undumpable-dependencies"
psql_admin_query --command "
  SELECT 'foreign_table|' || n.nspname || '.' || c.relname
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE c.relkind = 'f'
  ORDER BY n.nspname, c.relname;
  SELECT 'subscription|' || subname
  FROM pg_catalog.pg_subscription
  ORDER BY subname;
" > "$SOURCE_DEPENDENCIES"
chmod 600 "$SOURCE_DEPENDENCIES"
if [[ -s "$SOURCE_DEPENDENCIES" ]]; then
  echo "Refusing foreign tables or subscriptions. They are not silently omitted." >&2
  exit 1
fi

psql_admin_query --command "
  SELECT rolname
  FROM pg_catalog.pg_roles
  WHERE rolname !~ '^pg_'
  ORDER BY rolname;
" > "$SOURCE_ROLES"
chmod 600 "$SOURCE_ROLES"

psql_admin_query --command "
  SELECT extname
  FROM pg_catalog.pg_extension
  ORDER BY extname;
" > "$SOURCE_EXTENSIONS"
chmod 600 "$SOURCE_EXTENSIONS"

write_owner_acl "$SOURCE_OWNER_ACL" psql_admin_query

unsafe_names="$(awk -F'|' '
  $1 ~ /[[:space:]|]/ || $2 ~ /[[:space:]|]/ { bad = 1 }
  END { print bad + 0 }
' "$SOURCE_ROLES" 2>/dev/null || true)"
test "$unsafe_names" = 0 || {
  echo "Refusing role names that cannot be passed through the private packet" >&2
  exit 1
}
~~~

The source role list intentionally contains every non-predefined role name. It
does not contain passwords. The restore creates only missing NOLOGIN
placeholders, so ownership and ACL commands have named targets without
recreating login credentials.

The packet stops for foreign tables and subscriptions. Other undumpable
dependencies must also stop the packet when pg_dump, the provider eligibility
response, or the restore reports them. Do not add an exclude flag to make the
command pass.

## 4. Temporary role and large-object preflight

The role has LOGIN, BYPASSRLS, and pg_read_all_data. PostgreSQL documents that
pg_read_all_data reads tables, views, and sequences and provides schema USAGE,
but it does not set BYPASSRLS. Large objects have their own ACLs, so the packet
grants SELECT to the exact OIDs found in the preflight. It never grants a broad
large-object privilege.

~~~bash
printf 'CREATE ROLE "%s" LOGIN BYPASSRLS PASSWORD '\''%s'\'';\n' \
  "$BACKUP_ROLE" "$ROLE_PASSWORD" > "$ROLE_SQL_FILE"
chmod 600 "$ROLE_SQL_FILE"
psql_admin --file="$ROLE_SQL_FILE" >/dev/null
ROLE_CREATED=true
psql_admin --command "GRANT pg_read_all_data TO \"$BACKUP_ROLE\";" >/dev/null
rm -f "$ROLE_SQL_FILE"

ROLE_PROBE="$BACKUP_DIR/backup-role.probe"
psql_admin_query --command "
  SELECT rolcanlogin::text || '|' ||
         rolbypassrls::text || '|' ||
         pg_has_role(rolname, 'pg_read_all_data', 'member')::text
  FROM pg_catalog.pg_roles
  WHERE rolname = '$BACKUP_ROLE';
" > "$ROLE_PROBE"
chmod 600 "$ROLE_PROBE"
test "$(tr -d '[:space:]' < "$ROLE_PROBE")" = "t|t|t"

capture_source_oids() {
  local output="$1"
  psql_admin_query --command \
    'SELECT oid::text FROM pg_catalog.pg_largeobject_metadata ORDER BY oid;' \
    > "$output"
  chmod 600 "$output"
}

SOURCE_OIDS_1="$BACKUP_DIR/source.large-object-oids.1"
SOURCE_OIDS_2="$BACKUP_DIR/source.large-object-oids.2"
SOURCE_OIDS_BEFORE_DUMP="$BACKUP_DIR/source.large-object-oids.before-dump"
capture_source_oids "$SOURCE_OIDS_1"
capture_source_oids "$SOURCE_OIDS_2"
cmp -s "$SOURCE_OIDS_1" "$SOURCE_OIDS_2"

if [[ -s "$SOURCE_OIDS_2" ]]; then
  while IFS= read -r loid; do
    [[ "$loid" =~ ^[0-9]+$ ]] || {
      echo "Refusing a malformed large-object OID" >&2
      exit 1
    }
    psql_admin --command \
      "GRANT SELECT ON LARGE OBJECT $loid TO \"$BACKUP_ROLE\";" >/dev/null
  done < "$SOURCE_OIDS_2"
fi

capture_source_oids "$SOURCE_OIDS_BEFORE_DUMP"
cmp -s "$SOURCE_OIDS_2" "$SOURCE_OIDS_BEFORE_DUMP"
~~~

The two initial inventories must match before any grant. The third inventory
must still match after the exact grants. If the inventory moves later, the
post-dump comparison fails and the archive is rejected.

## 5. One exported snapshot, complete raw dump, and source state

The exporter is one open read-only PostgreSQL transaction. It stays open while
the raw dump and every source reconciliation query import the same snapshot.
The snapshot token is private. Do not print it.

~~~bash
SNAPSHOT_PIPE="$BACKUP_DIR/source.snapshot.pipe"
SNAPSHOT_OUTPUT="$BACKUP_DIR/source.snapshot.output"
mkfifo "$SNAPSHOT_PIPE"
chmod 600 "$SNAPSHOT_PIPE"
psql_admin_query < "$SNAPSHOT_PIPE" > "$SNAPSHOT_OUTPUT" \
  2> "$SNAPSHOT_STDERR" &
SNAPSHOT_PID="$!"
exec 9> "$SNAPSHOT_PIPE"
SNAPSHOT_OPEN=true

printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&9
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  [[ -s "$SNAPSHOT_OUTPUT" ]] && break
  sleep 1
done
IFS= read -r SNAPSHOT_TOKEN < "$SNAPSHOT_OUTPUT"
[[ "$SNAPSHOT_TOKEN" =~ ^[[:xdigit:]-]+$ ]]
printf '%s\n' "$SNAPSHOT_TOKEN" > "$SNAPSHOT_FILE"
chmod 600 "$SNAPSHOT_FILE"

DUMP_EXIT=0
if PGPASSWORD="$ROLE_PASSWORD" "$PG_DUMP_BIN" \
  --format=custom \
  --large-objects \
  --file="$DUMP_FILE" \
  --dbname="$DB_NAME" \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$BACKUP_ROLE" \
  --no-password \
  --snapshot="$SNAPSHOT_TOKEN" \
  2> "$DUMP_STDERR"; then
  DUMP_EXIT=0
else
  DUMP_EXIT=$?
fi
chmod 600 "$DUMP_FILE" "$DUMP_STDERR"
test "$DUMP_EXIT" -eq 0
test ! -s "$DUMP_STDERR"
shasum -a 256 "$DUMP_FILE" > "$DUMP_SHA256"
chmod 600 "$DUMP_SHA256"
~~~

The dump command is deliberately a complete custom-format dump. Do not add
--schema, --exclude-schema, --table, --exclude-table, --filter,
--exclude-table-data, --no-publications, or --no-subscriptions. Do not
substitute supabase db dump. The current CLI intentionally excludes
managed/internal schemas such as auth and storage, so it cannot serve as this
complete archive.

Capture every source state through the exported snapshot. The table-count file
contains counts only, never rows.

~~~bash
psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" <<'SQL' > "$SOURCE_SCHEMAS"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SELECT nspname
FROM pg_catalog.pg_namespace
WHERE nspname <> 'information_schema'
  AND nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY nspname;
COMMIT;
SQL

psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" <<'SQL' > "$SOURCE_TABLES"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SELECT n.nspname || '|' || c.relname || '|' || c.relkind
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY n.nspname, c.relname;
COMMIT;
SQL

psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" <<'SQL' > "$SOURCE_COUNTS"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SELECT format(
  'SELECT %L || ''|'' || count(*)::text FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY n.nspname, c.relname;
\gexec
COMMIT;
SQL

psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" <<'SQL' > "$SOURCE_SEQUENCES"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'snapshot';
SELECT format(
  'SELECT %L || ''|'' || last_value::text || ''|'' || is_called::text FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind = 'S'
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY n.nspname, c.relname;
\gexec
COMMIT;
SQL

psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" --command '
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'\'snapshot'\'';
SELECT oid::text FROM pg_catalog.pg_largeobject_metadata ORDER BY oid;
COMMIT;
' > "$SOURCE_LARGE_OBJECTS"

psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" --command '
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'\'snapshot'\'';
SELECT coalesce(string_agg(version || '':'' || name, ''|'' ORDER BY version), '''')
FROM supabase_migrations.schema_migrations;
COMMIT;
' > "$SOURCE_MIGRATIONS"

psql_backup_query -v snapshot="$SNAPSHOT_TOKEN" --command '
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT :'\'snapshot'\'';
SELECT count(*)::text || ''|'' || coalesce(max(version), '''')
FROM supabase_migrations.schema_migrations;
COMMIT;
' > "$SOURCE_MIGRATION_STATE"

for file in "$SOURCE_SCHEMAS" "$SOURCE_TABLES" "$SOURCE_COUNTS" \
            "$SOURCE_SEQUENCES" "$SOURCE_LARGE_OBJECTS" \
            "$SOURCE_MIGRATIONS" "$SOURCE_MIGRATION_STATE"; do
  chmod 600 "$file"
done
~~~

Close the exporter only after the dump and all source state files have been
written.

~~~bash
printf 'ROLLBACK;\n' >&9
exec 9>&-
SNAPSHOT_OPEN=false
wait "$SNAPSHOT_PID"
SNAPSHOT_PID=""
chmod 600 "$SNAPSHOT_OUTPUT" "$SNAPSHOT_STDERR"
test ! -s "$SNAPSHOT_STDERR"
capture_source_oids "$BACKUP_DIR/source.large-object-oids.after-dump"
cmp -s "$SOURCE_OIDS_2" "$BACKUP_DIR/source.large-object-oids.after-dump"

SOURCE_ROLES_AFTER="$BACKUP_DIR/source.role-names.after-dump"
SOURCE_EXTENSIONS_AFTER="$BACKUP_DIR/source.extensions.after-dump"
SOURCE_DEPENDENCIES_AFTER="$BACKUP_DIR/source.undumpable-dependencies.after-dump"
SOURCE_SCHEMAS_AFTER="$BACKUP_DIR/source.schemas.after-dump"
SOURCE_TABLES_AFTER="$BACKUP_DIR/source.tables.after-dump"
SOURCE_OWNER_ACL_AFTER="$BACKUP_DIR/source.owner-acl.after-dump"
psql_admin_query --command \
  "SELECT rolname FROM pg_catalog.pg_roles
   WHERE rolname !~ '^pg_' AND rolname <> '$BACKUP_ROLE'
   ORDER BY rolname;" > "$SOURCE_ROLES_AFTER"
psql_admin_query --command \
  'SELECT extname FROM pg_catalog.pg_extension ORDER BY extname;' \
  > "$SOURCE_EXTENSIONS_AFTER"
psql_admin_query --command \
  "SELECT 'foreign_table|' || n.nspname || '.' || c.relname
   FROM pg_catalog.pg_class AS c
   JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
   WHERE c.relkind = 'f'
   UNION ALL
   SELECT 'subscription|' || subname
   FROM pg_catalog.pg_subscription
   ORDER BY 1;" > "$SOURCE_DEPENDENCIES_AFTER"
psql_admin_query --command \
  "SELECT nspname FROM pg_catalog.pg_namespace
   WHERE nspname <> 'information_schema'
     AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
   ORDER BY nspname;" > "$SOURCE_SCHEMAS_AFTER"
psql_admin_query --command \
  "SELECT n.nspname || '|' || c.relname || '|' || c.relkind
   FROM pg_catalog.pg_class AS c
   JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname <> 'information_schema'
     AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
   ORDER BY n.nspname, c.relname;" > "$SOURCE_TABLES_AFTER"
psql_admin --command \
  "DROP OWNED BY \"$BACKUP_ROLE\";" >/dev/null
write_owner_acl "$SOURCE_OWNER_ACL_AFTER" psql_admin_query
for file in "$SOURCE_ROLES_AFTER" "$SOURCE_EXTENSIONS_AFTER" \
            "$SOURCE_DEPENDENCIES_AFTER" "$SOURCE_SCHEMAS_AFTER" \
            "$SOURCE_TABLES_AFTER" "$SOURCE_OWNER_ACL_AFTER"; do
  chmod 600 "$file"
done
cmp -s "$SOURCE_ROLES" "$SOURCE_ROLES_AFTER"
cmp -s "$SOURCE_EXTENSIONS" "$SOURCE_EXTENSIONS_AFTER"
cmp -s "$SOURCE_DEPENDENCIES" "$SOURCE_DEPENDENCIES_AFTER"
cmp -s "$SOURCE_SCHEMAS" "$SOURCE_SCHEMAS_AFTER"
cmp -s "$SOURCE_TABLES" "$SOURCE_TABLES_AFTER"
cmp -s "$SOURCE_OWNER_ACL" "$SOURCE_OWNER_ACL_AFTER"
~~~

A moved OID inventory fails the backup gate even if pg_dump returned zero.

## 6. Archive completeness gate

The TOC is metadata, not dump content. Save it mode 600 and never print it.

~~~bash
TOC_EXIT=0
if "$PG_RESTORE_BIN" --list "$DUMP_FILE" > "$TOC_FILE" 2> "$TOC_STDERR"; then
  TOC_EXIT=0
else
  TOC_EXIT=$?
fi
chmod 600 "$TOC_FILE" "$TOC_STDERR"
test "$TOC_EXIT" -eq 0
test ! -s "$TOC_STDERR"

require_toc() {
  grep -Fq -- "$1" "$TOC_FILE"
}

for schema in auth extensions private storage supabase_migrations; do
  require_toc "SCHEMA - $schema " || {
    echo "Refusing an archive missing schema $schema" >&2
    exit 1
  }
done

require_toc_table() {
  local schema="$1"
  local table="$2"
  grep -Fq -- "TABLE $schema $table " "$TOC_FILE" ||
    grep -Fq -- "TABLE \"$schema\" \"$table\" " "$TOC_FILE"
}

require_toc_table auth users
require_toc_table storage objects
require_toc_table public studios
require_toc_table supabase_migrations schema_migrations

PUBLIC_TABLE_FOUND=false
PRIVATE_TABLE_FOUND=false
while IFS='|' read -r schema table relkind; do
  [[ -n "$schema" && -n "$table" ]] || continue
  require_toc_table "$schema" "$table" || {
    echo "Refusing an archive missing source table $schema.$table" >&2
    exit 1
  }
  [[ "$schema" = public ]] && PUBLIC_TABLE_FOUND=true
  [[ "$schema" = private ]] && PRIVATE_TABLE_FOUND=true
done < "$SOURCE_TABLES"
test "$PUBLIC_TABLE_FOUND" = true
test "$PRIVATE_TABLE_FOUND" = true

grep -Fq -- "BLOB METADATA" "$TOC_FILE" || {
  [[ ! -s "$SOURCE_LARGE_OBJECTS" ]] || {
    echo "Refusing an archive missing large-object metadata" >&2
    exit 1
  }
}
~~~

The default public schema may not have a SCHEMA - public TOC line. That is
expected when the source uses PostgreSQL's default public schema. The archive
proves public coverage through the required public.studios sentinel and the
table-by-table source inventory. A dump containing only public tables still
fails because the Auth, Storage, private, and migration sentinels are required.

## 7. Source role cleanup

Drop the hosted temporary role before touching the restore target. The cleanup
must run on success, failure, signal, or operator abort.

~~~bash
drop_source_role() {
  if [[ "$ROLE_CREATED" != true ]]; then
    return 0
  fi
  psql_admin --command \
    "REVOKE pg_read_all_data FROM \"$BACKUP_ROLE\";
     DROP OWNED BY \"$BACKUP_ROLE\";
     DROP ROLE \"$BACKUP_ROLE\";" >/dev/null
  role_exists="$(psql_admin_query --command \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                    WHERE rolname = '$BACKUP_ROLE');" |
    tr -d '[:space:]')"
  test "$role_exists" = f
  ROLE_CREATED=false
  rm -f "$ROLE_PASSWORD_FILE"
  unset ROLE_PASSWORD
}
drop_source_role
~~~

The DROP OWNED BY step removes the exact large-object grants as well as any
other privileges the temporary role acquired. A failed role cleanup is a hard
stop. Do not continue to restore or patch until the role is absent.

## 8. Fresh exact-image restore

The restore target is a new local container. It is never production, staging,
or a Supabase project. The Supabase image uses supabase_admin as its initial
superuser and reads POSTGRES_PASSWORD on first boot. Use a new container name
and a new local port every time. The image pre-seeds its postgres database with
managed roles, extensions, event triggers, and an extensions schema. Wait for
the full init marker, then create koaryu_restore from template0. Never restore
the archive into the pre-seeded postgres database.

~~~bash
DOCKER_BIN="${DOCKER_BIN:-docker}"
: "${RESTORE_PORT:?set a free localhost port}"

case "$RESTORE_HOST" in
  127.0.0.1|localhost) ;;
  *) echo "Refusing a non-local restore host" >&2; exit 1 ;;
esac
test "$RESTORE_IMAGE" = "docker.io/supabase/postgres:17.6.1.155"
test "$RESTORE_REF" != "$PRODUCTION_REF"
test "$RESTORE_REF" != "$STAGING_REF"

RESTORE_CONTAINER="koaryu-pg-restore-$$"
RESTORE_PASSWORD="$(openssl rand -hex 32)"
printf '%s\n' "$RESTORE_PASSWORD" > "$RESTORE_PASSWORD_FILE"
chmod 600 "$RESTORE_PASSWORD_FILE"
printf 'POSTGRES_PASSWORD=%s\n' "$RESTORE_PASSWORD" > "$RESTORE_ENV_FILE"
chmod 600 "$RESTORE_ENV_FILE"

"$DOCKER_BIN" pull "$RESTORE_IMAGE" \
  > "$RESTORE_PULL_STDOUT" 2> "$RESTORE_PULL_STDERR"
chmod 600 "$RESTORE_PULL_STDOUT" "$RESTORE_PULL_STDERR"
"$DOCKER_BIN" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$RESTORE_IMAGE" \
  > "$RESTORE_IMAGE_DIGEST"
chmod 600 "$RESTORE_IMAGE_DIGEST"
test -s "$RESTORE_IMAGE_DIGEST"
grep -Fq "$EXPECTED_RESTORE_DIGEST_SHA" "$RESTORE_IMAGE_DIGEST"
"$DOCKER_BIN" run --detach --rm \
  --name "$RESTORE_CONTAINER" \
  --env-file "$RESTORE_ENV_FILE" \
  --publish "127.0.0.1:$RESTORE_PORT:5432" \
  "$RESTORE_IMAGE" > "$RESTORE_CONTAINER_ID"
chmod 600 "$RESTORE_CONTAINER_ID"
RESTORE_CONTAINER_STARTED=true
"$DOCKER_BIN" inspect --format '{{.Config.Image}}' "$RESTORE_CONTAINER" \
  > "$RESTORE_IMAGE_READBACK"
chmod 600 "$RESTORE_IMAGE_READBACK"
grep -Fxq "$RESTORE_IMAGE" "$RESTORE_IMAGE_READBACK"

for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 \
             16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 \
             31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60; do
  "$DOCKER_BIN" logs "$RESTORE_CONTAINER" > "$RESTORE_INIT_LOG" \
    2> "$RESTORE_INIT_STDERR"
  if grep -Fq -- \
      'PostgreSQL init process complete; ready for start up.' \
      "$RESTORE_INIT_LOG"; then
    break
  fi
  sleep 1
done
chmod 600 "$RESTORE_INIT_LOG" "$RESTORE_INIT_STDERR"
grep -Fq -- 'PostgreSQL init process complete; ready for start up.' \
  "$RESTORE_INIT_LOG"

RESTORE_DB_PASSWORD="$(tr -d '\n' < "$RESTORE_PASSWORD_FILE")"
psql_restore() {
  PGPASSWORD="$RESTORE_DB_PASSWORD" "$PSQL_BIN" \
    --host="$RESTORE_HOST" --port="$RESTORE_PORT" \
    --username="$RESTORE_DB_USER" --dbname="$RESTORE_DB_NAME" \
    --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet "$@"
}
psql_restore_query() {
  psql_restore --tuples-only --no-align "$@"
}

RESTORE_READY=false
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 \
             16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if psql_restore_query --command 'SELECT version();' \
      > "$BACKUP_DIR/restore.version" \
      2> "$BACKUP_DIR/restore.version.stderr"; then
    RESTORE_READY=true
    break
  fi
  sleep 1
done
chmod 600 "$BACKUP_DIR/restore.version" "$BACKUP_DIR/restore.version.stderr"
test "$RESTORE_READY" = true
grep -Eq 'PostgreSQL 17\.' "$BACKUP_DIR/restore.version"
psql_restore_query --command \
  'SELECT current_user || ''|'' || rolsuper::text
   FROM pg_catalog.pg_roles WHERE rolname = current_user;' \
  > "$BACKUP_DIR/restore.superuser"
chmod 600 "$BACKUP_DIR/restore.superuser"
grep -Eq '^supabase_admin\|t$' "$BACKUP_DIR/restore.superuser"

test "$(psql_restore_query --command \
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database
                  WHERE datname = 'koaryu_restore');" |
  tr -d '[:space:]')" = f
psql_restore --command \
  'CREATE DATABASE koaryu_restore TEMPLATE template0;' >/dev/null
RESTORE_DB_NAME="koaryu_restore"
test "$RESTORE_DB_NAME" = "koaryu_restore"

psql_restore_query --command \
  'SELECT name FROM pg_catalog.pg_available_extensions ORDER BY name;' \
  > "$TARGET_AVAILABLE_EXTENSIONS"
chmod 600 "$TARGET_AVAILABLE_EXTENSIONS"
comm -23 "$SOURCE_EXTENSIONS" "$TARGET_AVAILABLE_EXTENSIONS" \
  > "$BACKUP_DIR/missing-extensions"
chmod 600 "$BACKUP_DIR/missing-extensions"
test ! -s "$BACKUP_DIR/missing-extensions"
~~~

If the image pull, image digest, container identity, PostgreSQL version, or
required extension package check fails, stop. Do not substitute
public.ecr.aws/supabase/postgres:17.6.1.156 for this target. That image is
valid only as separate CI/local threshold evidence. Docker may print the
observed digest under supabase/postgres or public.ecr.aws/supabase/postgres;
the expected SHA-256 suffix is the exact .155 gate.

Create only missing NOLOGIN placeholders. Do not copy role passwords or create
login roles in the disposable target.

~~~bash
while IFS= read -r role_name; do
  [[ -n "$role_name" ]] || continue
  role_exists="$(psql_restore_query -v role_name="$role_name" --command \
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                    WHERE rolname = :'role_name');" |
    tr -d '[:space:]')"
  if [[ "$role_exists" = f ]]; then
    psql_restore -v role_name="$role_name" --command \
      'CREATE ROLE :"role_name" NOLOGIN;' >/dev/null
  fi
done < "$SOURCE_ROLES"

psql_restore --command "CREATE ROLE \"$BACKUP_ROLE\" NOLOGIN;" >/dev/null
RESTORE_PLACEHOLDER_CREATED=true
~~~

## 9. Owner-preserving restore and reconciliation

Restore with the archive's ownership and ACL commands. Do not add
--no-owner or --no-privileges. The placeholders make those commands replayable
without recreating login credentials.

~~~bash
RESTORE_EXIT=0
if PGPASSWORD="$RESTORE_DB_PASSWORD" "$PG_RESTORE_BIN" \
  --exit-on-error \
  --single-transaction \
  --dbname="$RESTORE_DB_NAME" \
  --host="$RESTORE_HOST" \
  --port="$RESTORE_PORT" \
  --username="$RESTORE_DB_USER" \
  --no-password \
  "$DUMP_FILE" 2> "$RESTORE_STDERR"; then
  RESTORE_EXIT=0
else
  RESTORE_EXIT=$?
fi
chmod 600 "$RESTORE_STDERR"
test "$RESTORE_EXIT" -eq 0
test ! -s "$RESTORE_STDERR"

psql_restore_query --command \
  "SELECT nspname
   FROM pg_catalog.pg_namespace
   WHERE nspname <> 'information_schema'
     AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
   ORDER BY nspname;" > "$TARGET_SCHEMAS"

psql_restore_query --command \
  "SELECT n.nspname || '|' || c.relname || '|' || c.relkind
   FROM pg_catalog.pg_class AS c
   JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname <> 'information_schema'
     AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
   ORDER BY n.nspname, c.relname;" > "$TARGET_TABLES"

psql_restore_query <<'SQL' > "$TARGET_COUNTS"
SELECT format(
  'SELECT %L || ''|'' || count(*)::text FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p')
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY n.nspname, c.relname;
\gexec
SQL

psql_restore_query <<'SQL' > "$TARGET_SEQUENCES"
SELECT format(
  'SELECT %L || ''|'' || last_value::text || ''|'' || is_called::text FROM %I.%I;',
  n.nspname || '.' || c.relname,
  n.nspname,
  c.relname
)
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind = 'S'
  AND n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
ORDER BY n.nspname, c.relname;
\gexec
SQL

psql_restore_query --command \
  'SELECT oid::text FROM pg_catalog.pg_largeobject_metadata ORDER BY oid;' \
  > "$TARGET_LARGE_OBJECTS"
psql_restore_query --command \
  'SELECT coalesce(string_agg(version || '':'' || name, ''|'' ORDER BY version), '''')
   FROM supabase_migrations.schema_migrations;' > "$TARGET_MIGRATIONS"
psql_restore_query --command \
  'SELECT count(*)::text || ''|'' || coalesce(max(version), '''')
   FROM supabase_migrations.schema_migrations;' > "$TARGET_MIGRATION_STATE"
psql_restore_query --command \
  'SELECT extname FROM pg_catalog.pg_extension ORDER BY extname;' \
  > "$TARGET_EXTENSIONS"

for file in "$TARGET_SCHEMAS" "$TARGET_TABLES" "$TARGET_COUNTS" \
            "$TARGET_SEQUENCES" "$TARGET_LARGE_OBJECTS" \
            "$TARGET_MIGRATIONS" "$TARGET_MIGRATION_STATE" "$TARGET_EXTENSIONS"; do
  chmod 600 "$file"
done

cmp -s "$SOURCE_SCHEMAS" "$TARGET_SCHEMAS"
cmp -s "$SOURCE_TABLES" "$TARGET_TABLES"
cmp -s "$SOURCE_COUNTS" "$TARGET_COUNTS"
cmp -s "$SOURCE_SEQUENCES" "$TARGET_SEQUENCES"
cmp -s "$SOURCE_LARGE_OBJECTS" "$TARGET_LARGE_OBJECTS"
cmp -s "$SOURCE_MIGRATIONS" "$TARGET_MIGRATIONS"
cmp -s "$SOURCE_MIGRATION_STATE" "$TARGET_MIGRATION_STATE"
comm -23 "$SOURCE_EXTENSIONS" "$TARGET_EXTENSIONS" \
  > "$BACKUP_DIR/missing-restored-extensions"
chmod 600 "$BACKUP_DIR/missing-restored-extensions"
test ! -s "$BACKUP_DIR/missing-restored-extensions"

psql_restore --command \
  "DROP OWNED BY \"$BACKUP_ROLE\"; DROP ROLE \"$BACKUP_ROLE\";" >/dev/null
restore_role_exists="$(psql_restore_query --command \
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = '$BACKUP_ROLE');" |
  tr -d '[:space:]')"
test "$restore_role_exists" = f
RESTORE_PLACEHOLDER_CREATED=false
write_owner_acl "$TARGET_OWNER_ACL" psql_restore_query
cmp -s "$SOURCE_OWNER_ACL" "$TARGET_OWNER_ACL"
rm -f "$RESTORE_PASSWORD_FILE" "$RESTORE_ENV_FILE"
unset RESTORE_DB_PASSWORD
~~~

The reconciliation covers every ordinary table row count, every sequence's
last_value and is_called state, the large-object OID set and count, the full
non-system schema/table inventory, installed extensions, normalized migration
history, and owner/ACL metadata. The normalized migration history is a private
byte sequence of version:name entries. A mismatch is a stop gate.

The restore is strict. single-transaction rolls the target back on any restore
error, and exit-on-error refuses the default behavior of continuing after an
error. Any nonempty restore stderr also blocks acceptance.

Stop the disposable container after the proof. Its rm flag removes the
container. Verify that no restore target remains.

~~~bash
"$DOCKER_BIN" stop "$RESTORE_CONTAINER" > "$BACKUP_DIR/restore.stop"
chmod 600 "$BACKUP_DIR/restore.stop"
for remove_attempt in 1 2 3 4 5 6 7 8 9 10; do
  "$DOCKER_BIN" inspect "$RESTORE_CONTAINER" >/dev/null 2>&1 || break
  sleep 1
done
if "$DOCKER_BIN" inspect "$RESTORE_CONTAINER" >/dev/null 2>&1; then
  echo "Refusing completion because the task-owned restore container remains" >&2
  exit 1
fi
RESTORE_CONTAINER_STARTED=false
~~~

## 10. Backup release record

This is the hard gate before the provider request. The release record contains
only pass/fail values, exact non-secret identifiers, and hashes. Keep the
aggregate values, role names, owner/ACL files, migration history, and provider
responses private in the mode-700 backup directory.

~~~bash
for file in "$DUMP_FILE" "$DUMP_SHA256" "$TOC_FILE" "$SNAPSHOT_FILE" \
            "$SOURCE_SCHEMAS" "$SOURCE_TABLES" "$SOURCE_COUNTS" \
            "$SOURCE_SEQUENCES" "$SOURCE_LARGE_OBJECTS" \
            "$SOURCE_MIGRATIONS" "$SOURCE_OWNER_ACL"; do
  test -s "$file"
  chmod 600 "$file"
done

{
  printf 'source_ref=%s\n' "$PRODUCTION_REF"
  printf 'restore_ref=%s\n' "$RESTORE_REF"
  printf 'restore_image=%s\n' "$RESTORE_IMAGE"
  printf 'restore_image_digest=%s\n' "$EXPECTED_RESTORE_DIGEST_SHA"
  printf 'target_image=%s\n' "$TARGET_IMAGE"
  printf 'release_channel=%s\n' "$TARGET_RELEASE_CHANNEL"
  printf 'plan_change=DENIED\n'
  printf 'application_migration=DENIED\n'
  printf 'dump=PASS\n'
  printf 'dump_sha256=%s\n' "$(awk '{print $1}' "$DUMP_SHA256")"
  printf 'dump_stderr=EMPTY\n'
  printf 'toc=PASS\n'
  printf 'snapshot=PASS\n'
  printf 'snapshot_stderr=EMPTY\n'
  printf 'post_dump_catalog_reread=PASS\n'
  printf 'large_object_oid_stability=PASS\n'
  printf 'schema_table_inventory=PASS\n'
  printf 'all_ordinary_table_counts=PASS\n'
  printf 'all_sequence_state=PASS\n'
  printf 'large_object_reconciliation=PASS\n'
  printf 'migration_history=PASS\n'
  printf 'owner_acl_reconciliation=PASS\n'
  printf 'restore=PASS\n'
  printf 'restore_stderr=EMPTY\n'
  printf 'temporary_role=ABSENT\n'
  printf 'restore_placeholder=ABSENT\n'
} > "$RELEASE_RECORD"
chmod 600 "$RELEASE_RECORD"
BACKUP_COMPLETE=true
~~~

Do not delete the backup directory after this point. Move or copy the complete
mode-600 archive to the approved private backup location according to the
organization's retention policy. Keep the private release record and hashes
with the archive. The logical dump includes Storage metadata only. It does not
include Storage object bytes or provider settings. Handle those separate
artifacts using [the staging and recovery runbook](staging-recovery-runbook.md#encrypted-logical-backup).

## 11. Read-only eligibility and the staged CTO request

The current official Management API exposes:

- GET /v1/projects/{ref}/upgrade/eligibility, which returns
  target_upgrade_versions with app_version, postgres_version, and
  release_channel.
- POST /v1/projects/{ref}/upgrade, which accepts target_version and
  release_channel.
- GET /v1/projects/{ref}/upgrade/status, which reports the latest provider
  status for a returned tracking ID.
- GET /v1/projects/{ref}, which is the authoritative project readback.

Use the exact project ref in every URL. Save responses privately.

~~~bash
: "${SUPABASE_ACCESS_TOKEN:?load the Management API token without printing it}"
printf 'Authorization: Bearer %s\nAccept: application/json\n' \
  "$SUPABASE_ACCESS_TOKEN" > "$PROVIDER_AUTH_HEADER"
chmod 600 "$PROVIDER_AUTH_HEADER"
unset SUPABASE_ACCESS_TOKEN

management_get() {
  local name="$1"
  local path="$2"
  local body="$BACKUP_DIR/provider.$name.json"
  local code="$BACKUP_DIR/provider.$name.http-code"
  curl -sS --request GET \
    --header "@$PROVIDER_AUTH_HEADER" \
    --output "$body" \
    --write-out '%{http_code}\n' \
    "https://api.supabase.com$path" > "$code"
  chmod 600 "$body" "$code"
  test "$(tr -d '[:space:]' < "$code")" = 200
}

management_get project-before "/v1/projects/$PRODUCTION_REF"
management_get upgrade-eligibility "/v1/projects/$PRODUCTION_REF/upgrade/eligibility"

jq -e \
  --arg ref "$PRODUCTION_REF" \
  --arg major "$TARGET_POSTGRES_MAJOR" \
  --arg channel "$TARGET_RELEASE_CHANNEL" '
    (.ref == $ref)
    and (.status == "ACTIVE_HEALTHY")
    and (.database.postgres_engine == $major)
    and (.database.release_channel == $channel)
    and (.database.version == "17.6.1.105")
  ' "$BACKUP_DIR/provider.project-before.json" > /dev/null

jq -e \
  --arg image "$TARGET_IMAGE" \
  --arg major "$TARGET_POSTGRES_MAJOR" \
  --arg channel "$TARGET_RELEASE_CHANNEL" '
    (.eligible == true)
    and (([.target_upgrade_versions[]?
             | select(.app_version == $image
                      and .postgres_version == $major
                      and .release_channel == $channel)] | length) == 1)
    and (((.validation_errors // []) | length) == 0)
    and (((.objects_to_be_dropped // []) | length) == 0)
    and (((.unsupported_extensions // []) | length) == 0)
    and (((.user_defined_objects_in_internal_schemas // []) | length) == 0)
  ' "$BACKUP_DIR/provider.upgrade-eligibility.json" > /dev/null
~~~

If eligibility lists a warning, unsupported extension, object to drop, internal
schema object, or validation error, stop and resolve it through the provider.
Do not bypass the response by clicking a dashboard control.

Only after the exact eligibility object passes, stage the CTO-only request body.
This writes a private file but does not call the provider.

~~~bash
UPGRADE_BODY="$BACKUP_DIR/provider.upgrade.body.json"
printf '{"target_version":"%s","release_channel":"%s"}\n' \
  "$TARGET_IMAGE" "$TARGET_RELEASE_CHANNEL" > "$UPGRADE_BODY"
chmod 600 "$UPGRADE_BODY"
~~~

The following mutation belongs to the registered CTO task. DB-W03 must not
execute it. The CTO task may run it only after the complete backup release
record, the exact fresh eligibility response, the no-plan-change check, and the
named human approval are recorded.

~~~bash
# CTO task only. DB-W03 must not execute this request.
curl -sS --request POST \
  --header "@$PROVIDER_AUTH_HEADER" \
  --header 'Content-Type: application/json' \
  --data-binary "@$UPGRADE_BODY" \
  --output "$BACKUP_DIR/provider.upgrade-response.json" \
  --write-out '%{http_code}\n' \
  "https://api.supabase.com/v1/projects/$PRODUCTION_REF/upgrade" \
  > "$BACKUP_DIR/provider.upgrade-response.http-code"
chmod 600 "$BACKUP_DIR/provider.upgrade-response.json" \
  "$BACKUP_DIR/provider.upgrade-response.http-code"
test "$(tr -d '[:space:]' < "$BACKUP_DIR/provider.upgrade-response.http-code")" = 201
~~~

Save the response privately. A 201 and tracking ID mean that the provider
accepted the request. They do not mean the image patch completed.

## 12. Post-upgrade provider and database readback

Poll the read-only upgrade status and project readback until the provider
reports the exact target. Never issue a second POST because a status response
is slow.

~~~bash
TRACKING_ID="$(jq -er '.tracking_id' "$BACKUP_DIR/provider.upgrade-response.json")"
printf '%s\n' "$TRACKING_ID" > "$BACKUP_DIR/provider.tracking-id"
chmod 600 "$BACKUP_DIR/provider.tracking-id"

attempt=0
while (( attempt < 40 )); do
  attempt=$((attempt + 1))
  management_get upgrade-status-$attempt \
    "/v1/projects/$PRODUCTION_REF/upgrade/status?tracking_id=$TRACKING_ID"
  management_get project-after-$attempt "/v1/projects/$PRODUCTION_REF"
  if jq -e \
      --arg ref "$PRODUCTION_REF" \
      --arg image "$TARGET_IMAGE" \
      --arg major "$TARGET_POSTGRES_MAJOR" \
      --arg channel "$TARGET_RELEASE_CHANNEL" '
        (.ref == $ref)
        and (.status == "ACTIVE_HEALTHY")
        and (.database.postgres_engine == $major)
        and (.database.release_channel == $channel)
        and (.database.version == $image)
      ' "$BACKUP_DIR/provider.project-after-$attempt.json" > /dev/null; then
    cp "$BACKUP_DIR/provider.project-after-$attempt.json" \
      "$BACKUP_DIR/provider.project-after.json"
    chmod 600 "$BACKUP_DIR/provider.project-after.json"
    break
  fi
  if jq -e '
      ((.databaseUpgradeStatus.error // "") | length) > 0
    ' "$BACKUP_DIR/provider.upgrade-status-$attempt.json" > /dev/null; then
    echo "Provider reported an upgrade error. Stop." >&2
    exit 1
  fi
  sleep 15
done

test -s "$BACKUP_DIR/provider.project-after.json"
jq -e \
  --arg ref "$PRODUCTION_REF" \
  --arg image "$TARGET_IMAGE" '
    (.ref == $ref)
    and (.status == "ACTIVE_HEALTHY")
    and (.database.postgres_engine == "17")
    and (.database.release_channel == "ga")
    and (.database.version == $image)
  ' "$BACKUP_DIR/provider.project-after.json" > /dev/null
~~~

Capture the normalized migration history with a read-only administrative
connection. Do not create another temporary role. The bytes must match the
pre-upgrade snapshot exactly.

~~~bash
POST_MIGRATIONS="$BACKUP_DIR/post.migration-history"
POST_MIGRATION_STATE="$BACKUP_DIR/post.migration-state"
psql_admin_query --command '
  SELECT coalesce(string_agg(version || '':'' || name, ''|'' ORDER BY version), '''')
  FROM supabase_migrations.schema_migrations;
' > "$POST_MIGRATIONS"
psql_admin_query --command '
  SELECT count(*)::text || ''|'' || coalesce(max(version), '''')
  FROM supabase_migrations.schema_migrations;
' > "$POST_MIGRATION_STATE"
chmod 600 "$POST_MIGRATIONS" "$POST_MIGRATION_STATE"
cmp -s "$SOURCE_MIGRATIONS" "$POST_MIGRATIONS"
cmp -s "$SOURCE_MIGRATION_STATE" "$POST_MIGRATION_STATE"
~~~

A migration-history mismatch means the image-only patch did not preserve the
database contract. Stop. Do not deploy current main, run migration 116, or
repair history.

## 13. Unchanged application and ordinary API checks

Run the repository's exact-SHA verifier. For production, omit
expected-stripe-mode. That option is staging-only.

~~~bash
RELEASE_VERIFIER="$BACKUP_DIR/deployed-release.json"
RELEASE_VERIFIER_STDERR="$BACKUP_DIR/deployed-release.stderr"
node scripts/verify-deployed-release.mjs \
  --environment production \
  --expected-sha "$EXPECTED_SERVED_SHA" \
  --frontend-origin https://koaryu.app \
  --backend-api https://koaryu.onrender.com/api/v1 \
  > "$RELEASE_VERIFIER" 2> "$RELEASE_VERIFIER_STDERR"
chmod 600 "$RELEASE_VERIFIER" "$RELEASE_VERIFIER_STDERR"
jq -e \
  --arg sha "$EXPECTED_SERVED_SHA" '
    (.verified == true)
    and (.expected_sha == $sha)
    and (.frontend.commit_sha == $sha)
    and (.backend.commit_sha == $sha)
  ' "$RELEASE_VERIFIER" > /dev/null
~~~

The verifier checks these three read-only routes:

- https://koaryu.app/api/version
- https://koaryu.onrender.com/health/ready
- https://koaryu.onrender.com/api/v1/health/ready

The readiness body must report status ready, production environment, the
unchanged served SHA, and the service identity. The readiness endpoint checks
the exact release-schema contract; it does not echo the manifest string.

Then run ordinary safe and unauthenticated API checks without credentials.
Save only status codes.

~~~bash
API_SMOKE_CODES="$BACKUP_DIR/api-smoke.http-codes"
{
  printf 'health='
  curl -sS --max-time 15 --output /dev/null --write-out '%{http_code}\n' \
    https://koaryu.onrender.com/api/v1/health
  printf 'auth_me='
  curl -sS --max-time 15 --output /dev/null --write-out '%{http_code}\n' \
    https://koaryu.onrender.com/api/v1/auth/me
  printf 'students='
  curl -sS --max-time 15 --output /dev/null --write-out '%{http_code}\n' \
    https://koaryu.onrender.com/api/v1/students
} > "$API_SMOKE_CODES"
chmod 600 "$API_SMOKE_CODES"
grep -Fxq 'health=200' "$API_SMOKE_CODES"
grep -Fxq 'auth_me=401' "$API_SMOKE_CODES"
grep -Fxq 'students=401' "$API_SMOKE_CODES"
~~~

Do not call any suspected crash function, invoke a PostgREST routine, create an
Auth actor, create a Storage object, run SQL mutation, or run a migration as
part of this image-only check.

## 14. Failure, rollback, and completion

If the provider request fails, times out, or returns an error:

- do not issue a second upgrade request;
- save the private status and project responses;
- read back the project identity and health;
- keep the unchanged application serving SHA in place;
- stop if the provider does not restore ACTIVE_HEALTHY on the exact
  pre-upgrade image or if any readiness/API check fails;
- use the provider's documented recovery/support path with the named human
  authority.

Do not restore the logical archive over production as an ordinary rollback.
The archive is a verified recovery artifact, not an automatic provider rollback
mechanism. Do not run application migrations to repair an image patch.

The image patch is complete only when all of the following pass:

- project ref is mimguepumzsgmcaycdsh;
- provider state is ACTIVE_HEALTHY;
- PostgreSQL engine is 17, GA release channel is ga, and image is exactly
  17.6.1.155;
- normalized migration history is byte-identical to the pre-upgrade file;
- migration count remains 115 and head remains 20260822193000;
- both readiness routes are green;
- frontend and backend report the unchanged SHA
  ae73361490a06a104fdd7ac4e0f9788b999f641b;
- safe health returns 200 and unauthenticated protected reads return 401;
- no plan change, application migration, crash probe, or deployment occurred.

## 15. CTO-only issue closure handoff

After every live gate passes, the CTO closes issue 125. DB-W03 must not read or
write GitHub as part of this worker task. Keep the issue comment redacted. It
may contain only pass/fail statements and a note that detailed proof is held
privately. Never put credentials, dump details, customer data, target
connection fields, or provider response bodies in the issue.

First re-read the issue and require its approved title, OPEN state, and current
body before commenting. Save the readback privately and hash the body so the
post-close readback can prove the body did not change during the handoff.

~~~bash
ISSUE_BEFORE="$BACKUP_DIR/issue-125.before.json"
ISSUE_AFTER="$BACKUP_DIR/issue-125.after.json"
ISSUE_COMMENT="$BACKUP_DIR/issue-125.redacted-comment.md"
gh issue view 125 --repo ronchak/Koaryu \
  --json number,state,title,body,url > "$ISSUE_BEFORE"
chmod 600 "$ISSUE_BEFORE"
jq -e '
  (.number == 125)
  and (.state == "OPEN")
  and (.title == "Patch production database image after verified logical restore")
  and (.url == "https://github.com/ronchak/Koaryu/issues/125")
' "$ISSUE_BEFORE" > /dev/null
jq -r .body "$ISSUE_BEFORE" | shasum -a 256 > "$BACKUP_DIR/issue-125.body.before.sha256"
chmod 600 "$BACKUP_DIR/issue-125.body.before.sha256"

printf '%s\n' \
  'Production image patch gate: PASS' \
  'Complete logical backup and disposable exact-image restore: PASS' \
  'Schema, table-count, sequence, large-object, owner/ACL reconciliation: PASS' \
  'Temporary role and restore-placeholder cleanup: PASS' \
  'Provider readback, readiness, served-SHA, and safe-behavior gates: PASS' \
  'Detailed proof is retained in the private CTO release record.' \
  > "$ISSUE_COMMENT"
chmod 600 "$ISSUE_COMMENT"

# CTO task only. This is the approved GitHub write after the private live proof.
gh issue comment 125 --repo ronchak/Koaryu --body-file "$ISSUE_COMMENT"
gh issue close 125 --repo ronchak/Koaryu --reason completed

gh issue view 125 --repo ronchak/Koaryu \
  --json number,state,title,body,url > "$ISSUE_AFTER"
chmod 600 "$ISSUE_AFTER"
jq -e '
  (.number == 125)
  and (.state == "CLOSED")
  and (.title == "Patch production database image after verified logical restore")
  and (.url == "https://github.com/ronchak/Koaryu/issues/125")
' "$ISSUE_AFTER" > /dev/null
jq -r .body "$ISSUE_AFTER" | shasum -a 256 > "$BACKUP_DIR/issue-125.body.after.sha256"
chmod 600 "$BACKUP_DIR/issue-125.body.after.sha256"
cmp -s "$BACKUP_DIR/issue-125.body.before.sha256" \
  "$BACKUP_DIR/issue-125.body.after.sha256"
~~~

Issue closure is not a substitute for the live project, database, readiness,
or application proof. If the issue is not OPEN and unchanged before the handoff,
or not CLOSED with the same body afterward, stop and leave it open.

## Official references

Checked 2026-08-23. These links supplied the command, snapshot, privilege,
backup, and Management API contracts used above.

- [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase Upgrading](https://supabase.com/docs/guides/platform/upgrading)
- [Supabase get PostgreSQL upgrade eligibility](https://supabase.com/docs/reference/api/v1-get-postgres-upgrade-eligibility)
- [Supabase upgrade PostgreSQL version](https://supabase.com/docs/reference/api/v1-upgrade-postgres-version)
- [Supabase Postgres image configuration](https://github.com/supabase/supabase/blob/master/docker/CONFIG.md)
- [Supabase CLI database dump](https://supabase.com/docs/reference/cli/supabase-db-dump)
- [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
- [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
- [PostgreSQL 17 snapshot synchronization](https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
- [PostgreSQL 17 predefined roles](https://www.postgresql.org/docs/17/predefined-roles.html)
- [PostgreSQL 17 GRANT](https://www.postgresql.org/docs/17/sql-grant.html)
- [PostgreSQL 17 large objects](https://www.postgresql.org/docs/17/lo-implementation.html)
- [PostgreSQL 17 DROP OWNED](https://www.postgresql.org/docs/17/sql-drop-owned.html)
