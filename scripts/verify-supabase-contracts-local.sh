#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
unset PGDATABASE PGHOST PGHOSTADDR PGPASSFILE PGPASSWORD PGPORT
unset PGSERVICE PGSERVICEFILE PGUSER PGOPTIONS

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_DIR="$ROOT_DIR/supabase/migrations"
VERIFICATION_DIR="$ROOT_DIR/supabase/verification"
TEMP_DIR=""
DATA_DIR=""
SOCKET_DIR=""
POSTMASTER_LOG=""
ACTIVE_CHILD_PID=""
PG_BIN_DIR=""
INITDB=""
PG_CTL=""
PSQL=""
PG_PORT=5432

cleanup() {
  local original_status=$?
  local cleanup_failed=0

  trap - EXIT
  trap '' INT TERM
  set +e

  if [[ -n "$PG_CTL" && -n "$DATA_DIR" && -s "$DATA_DIR/postmaster.pid" ]]; then
    echo "Stopping ephemeral PostgreSQL cluster..."
    "$PG_CTL" -D "$DATA_DIR" -m fast -t 10 -w stop >/dev/null 2>&1
    if [[ $? -ne 0 && -s "$DATA_DIR/postmaster.pid" ]]; then
      "$PG_CTL" -D "$DATA_DIR" -m immediate -t 10 -w stop >/dev/null 2>&1
    fi
    if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
      echo "ERROR: PostgreSQL did not stop; inspect $DATA_DIR before removing it." >&2
      cleanup_failed=1
    fi
  fi

  if [[ -n "$TEMP_DIR" ]]; then
    case "$TEMP_DIR" in
      /tmp/koaryu-pg.*)
        if [[ $cleanup_failed -eq 0 ]]; then
          rm -rf -- "$TEMP_DIR"
          if [[ -e "$TEMP_DIR" ]]; then
            echo "ERROR: Failed to remove ephemeral PostgreSQL directory: $TEMP_DIR" >&2
            cleanup_failed=1
          fi
        fi
        ;;
      *)
        echo "ERROR: Refusing to remove unexpected temporary path: $TEMP_DIR" >&2
        cleanup_failed=1
        ;;
    esac
  fi

  if [[ $original_status -eq 0 && $cleanup_failed -ne 0 ]]; then
    original_status=1
  fi
  exit "$original_status"
}

on_interrupt() {
  local signal="$1"
  local child_pid="$ACTIVE_CHILD_PID"

  trap - INT TERM
  echo "Interrupted by $signal; cleaning up the ephemeral PostgreSQL cluster." >&2

  if [[ -n "$child_pid" ]]; then
    kill -s "$signal" "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
    ACTIVE_CHILD_PID=""
  fi

  if [[ "$signal" == "INT" ]]; then
    exit 130
  fi
  exit 143
}

trap cleanup EXIT
trap 'on_interrupt INT' INT
trap 'on_interrupt TERM' TERM

run_interruptible() {
  local status=0

  (
    trap - INT TERM
    exec "$@"
  ) <&0 &
  ACTIVE_CHILD_PID=$!
  if wait "$ACTIVE_CHILD_PID"; then
    status=0
  else
    status=$?
  fi
  ACTIVE_CHILD_PID=""
  return "$status"
}

is_postgres_17_binary() {
  local binary_path="$1"
  local version_output=""

  if [[ ! -x "$binary_path" ]]; then
    return 1
  fi
  version_output="$("$binary_path" --version 2>/dev/null)" || return 1
  [[ "$version_output" =~ (^|[^0-9])17\.[0-9] ]]
}

is_postgres_17_bindir() {
  local bindir="$1"
  local binary=""

  for binary in initdb pg_ctl psql; do
    if ! is_postgres_17_binary "$bindir/$binary"; then
      return 1
    fi
  done
  return 0
}

append_candidate_bindir() {
  local candidate="$1"
  local existing=""

  if [[ -z "$candidate" ]]; then
    return
  fi
  for existing in "${candidate_bindirs[@]-}"; do
    if [[ "$existing" == "$candidate" ]]; then
      return
    fi
  done
  candidate_bindirs+=("$candidate")
}

if [[ "$(id -u)" -eq 0 ]]; then
  echo "ERROR: PostgreSQL refuses to initialize or run a cluster as root." >&2
  echo "Run this verifier as an unprivileged operating-system user." >&2
  exit 1
fi

candidate_bindirs=()
if [[ -n "${KOARYU_PG_BIN_DIR:-}" ]]; then
  append_candidate_bindir "$KOARYU_PG_BIN_DIR"
else
  if command -v initdb >/dev/null 2>&1; then
    append_candidate_bindir "$(dirname "$(command -v initdb)")"
  fi
  if command -v pg_config >/dev/null 2>&1; then
    append_candidate_bindir "$(pg_config --bindir 2>/dev/null || true)"
  fi
  append_candidate_bindir "/opt/homebrew/opt/postgresql@17/bin"
  append_candidate_bindir "/usr/local/opt/postgresql@17/bin"
  append_candidate_bindir "/usr/lib/postgresql/17/bin"
fi

for candidate_bindir in "${candidate_bindirs[@]-}"; do
  if is_postgres_17_bindir "$candidate_bindir"; then
    PG_BIN_DIR="$candidate_bindir"
    break
  fi
done

if [[ -z "$PG_BIN_DIR" ]]; then
  echo "ERROR: A complete PostgreSQL 17 toolchain (initdb, pg_ctl, and psql) was not found." >&2
  if [[ -n "${KOARYU_PG_BIN_DIR:-}" ]]; then
    echo "KOARYU_PG_BIN_DIR does not contain three working PostgreSQL 17 binaries: $KOARYU_PG_BIN_DIR" >&2
  else
    echo "Put PostgreSQL 17 first on PATH or set KOARYU_PG_BIN_DIR to its bin directory." >&2
  fi
  exit 127
fi

INITDB="$PG_BIN_DIR/initdb"
PG_CTL="$PG_BIN_DIR/pg_ctl"
PSQL="$PG_BIN_DIR/psql"

node "$ROOT_DIR/scripts/check-supabase-contract-inventory.mjs"

shopt -s nullglob
migration_files=("$MIGRATION_DIR"/*.sql)
verification_files=("$VERIFICATION_DIR"/*.sql)
shopt -u nullglob

if [[ ${#migration_files[@]} -eq 0 ]]; then
  echo "ERROR: No migration files found in $MIGRATION_DIR" >&2
  exit 1
fi
if [[ ${#verification_files[@]} -eq 0 ]]; then
  echo "ERROR: No contract files found in $VERIFICATION_DIR" >&2
  exit 1
fi

# PostgreSQL rejects long Unix socket paths, so this must not inherit a long
# workspace-specific TMPDIR.
umask 077
TEMP_DIR="$(mktemp -d /tmp/koaryu-pg.XXXXXX)"
DATA_DIR="$TEMP_DIR/data"
SOCKET_DIR="$TEMP_DIR/socket"
POSTMASTER_LOG="$TEMP_DIR/postmaster.log"
mkdir -p "$SOCKET_DIR"

echo "Initializing ephemeral PostgreSQL 17 cluster..."
if ! run_interruptible "$INITDB" \
  -D "$DATA_DIR" \
  --username=postgres \
  --encoding=UTF8 \
  --no-locale \
  --auth-local=trust \
  --auth-host=reject \
  --no-instructions; then
  echo "ERROR: initdb failed for the ephemeral cluster at $DATA_DIR" >&2
  exit 1
fi

echo "Starting PostgreSQL on private socket $SOCKET_DIR..."
if ! run_interruptible "$PG_CTL" \
  -D "$DATA_DIR" \
  -l "$POSTMASTER_LOG" \
  -o "-F -c listen_addresses= -c unix_socket_directories=$SOCKET_DIR -c port=$PG_PORT" \
  -t 15 \
  -w start; then
  echo "ERROR: PostgreSQL failed to start. Postmaster log follows:" >&2
  if [[ -f "$POSTMASTER_LOG" ]]; then
    sed -n '1,240p' "$POSTMASTER_LOG" >&2
  else
    echo "(no postmaster log was created)" >&2
  fi
  exit 1
fi

psql_args=(
  --host="$SOCKET_DIR"
  --port="$PG_PORT"
  --username=postgres
  --dbname=postgres
  --no-password
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --echo-errors
  --quiet
)

echo "[bootstrap] CHECK pgcrypto availability"
if run_interruptible "$PSQL" "${psql_args[@]}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'pgcrypto'
  ) THEN
    RAISE EXCEPTION 'PostgreSQL 17 pgcrypto extension files are unavailable';
  END IF;
END
$$;
SQL
then
  echo "[bootstrap] PASS pgcrypto availability"
else
  status=$?
  echo "[bootstrap] FAIL pgcrypto availability (psql exit $status)" >&2
  echo "ERROR: Install the PostgreSQL 17 contrib/pgcrypto package for this toolchain." >&2
  exit "$status"
fi

echo "[bootstrap] RUN Supabase compatibility shim"
if run_interruptible "$PSQL" "${psql_args[@]}" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN NOINHERIT;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- Supabase installs extensions into a dedicated `extensions` schema and puts it
-- on the database search_path. `gen_random_uuid()` is native from PostgreSQL 13
-- so the migrations pass without this, but `digest()` is pgcrypto-only and the
-- student-import contract calls it.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
-- Takes effect for the subsequent psql invocations that run the migrations
-- and contracts, which is where digest() is actually resolved.
ALTER DATABASE postgres SET search_path TO "$user", public, extensions;

-- This ACL profile deliberately matches no Supabase project exactly. Older
-- projects grant ALL on tables, functions and sequences; newly provisioned
-- ones can have automatic Data API grants switched off altogether. CRUD is
-- the middle ground that lets this repository's contracts run, which means
-- privilege assertions are the one class of contract this harness cannot
-- settle -- in either direction. See docs/operator-tooling.md.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
  TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES
  TO anon, authenticated, service_role;

CREATE SCHEMA auth AUTHORIZATION supabase_admin;
CREATE TABLE auth.users (
  id UUID PRIMARY KEY,
  aud VARCHAR(255),
  role VARCHAR(255),
  email VARCHAR(255),
  raw_app_meta_data JSONB,
  raw_user_meta_data JSONB,
  email_confirmed_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID
$$;

CREATE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;

CREATE FUNCTION auth.email()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.email', true), '')
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;

CREATE SCHEMA storage AUTHORIZATION supabase_admin;
CREATE TABLE storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  public BOOLEAN NOT NULL DEFAULT false,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[]
);

CREATE SCHEMA supabase_migrations AUTHORIZATION supabase_admin;
CREATE TABLE supabase_migrations.schema_migrations (
  version TEXT PRIMARY KEY,
  statements TEXT[] NOT NULL DEFAULT '{}',
  name TEXT
);
SQL
then
  echo "[bootstrap] PASS Supabase compatibility shim"
else
  status=$?
  echo "[bootstrap] FAIL Supabase compatibility shim (psql exit $status)" >&2
  exit "$status"
fi

migration_total=${#migration_files[@]}
migration_index=0
for migration_file in "${migration_files[@]}"; do
  migration_index=$((migration_index + 1))
  migration_filename="$(basename "$migration_file")"
  if [[ ! "$migration_filename" =~ ^([0-9]{14})_([A-Za-z0-9_]+)\.sql$ ]]; then
    echo "[migration $migration_index/$migration_total] FAIL invalid migration filename: $migration_filename" >&2
    exit 1
  fi
  migration_version="${BASH_REMATCH[1]}"
  migration_name="${BASH_REMATCH[2]}"

  echo "[migration $migration_index/$migration_total] RUN $migration_filename"
  if run_interruptible "$PSQL" "${psql_args[@]}" \
    --single-transaction \
    --file="$migration_file" \
    --command="INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$migration_version', '$migration_name');"; then
    echo "[migration $migration_index/$migration_total] PASS $migration_filename"
  else
    status=$?
    echo "[migration $migration_index/$migration_total] FAIL $migration_filename (psql exit $status)" >&2
    exit "$status"
  fi
done

echo "[catalog] RUN deterministic pending-object security fingerprint"
catalog_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
    "$catalog_state"
); then
  echo "[catalog] PASS deterministic pending-object security fingerprint"
else
  status=$?
  echo "[catalog] FAIL deterministic pending-object security fingerprint (exit $status)" >&2
  exit "$status"
fi

echo "[catalog negative] RUN unmanifested permissive-policy rejection"
"$PSQL" "${psql_args[@]}" --quiet --command="
CREATE POLICY koaryu_harness_forbidden_permissive_policy
    ON public.studio_live_billing_authorizations
    AS PERMISSIVE FOR SELECT TO anon USING (true);
"
drifted_catalog_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
    "$drifted_catalog_state" >/dev/null 2>&1
); then
  echo "[catalog negative] FAIL catalog accepted an unmanifested permissive policy" >&2
  exit 1
fi
preflight_policy_rejected="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet --command="
SELECT 'policy_manifest' = ANY(security_failures)
  FROM public.koaryu_release_schema_preflight();
"
)"
if [[ "$preflight_policy_rejected" != "t" ]]; then
  echo "[catalog negative] FAIL readiness accepted an unmanifested permissive policy" >&2
  exit 1
fi
"$PSQL" "${psql_args[@]}" --quiet --command="
DROP POLICY koaryu_harness_forbidden_permissive_policy
    ON public.studio_live_billing_authorizations;
"
echo "[catalog negative] PASS unmanifested permissive-policy rejection"

echo "[concurrency] RUN Connect identity mapping/exclusion invariant"
if bash "$ROOT_DIR/scripts/verify-connect-identity-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT" postgres postgres; then
  echo "[concurrency] PASS Connect identity mapping/exclusion invariant"
else
  status=$?
  echo "[concurrency] FAIL Connect identity mapping/exclusion invariant (exit $status)" >&2
  exit "$status"
fi

verification_total=${#verification_files[@]}
verification_index=0
for verification_file in "${verification_files[@]}"; do
  verification_index=$((verification_index + 1))
  verification_filename="$(basename "$verification_file")"

  echo "[contract $verification_index/$verification_total] RUN $verification_filename"
  if run_interruptible "$PSQL" "${psql_args[@]}" --file="$verification_file"; then
    echo "[contract $verification_index/$verification_total] PASS $verification_filename"
  else
    status=$?
    echo "[contract $verification_index/$verification_total] FAIL $verification_filename (psql exit $status)" >&2
    exit "$status"
  fi
done

echo "[concurrency] RUN operational alert clear/completion serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-operational-alert-clear-complete-race.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS operational alert clear/completion serialization"
else
  status=$?
  echo "[concurrency] FAIL operational alert clear/completion serialization (exit $status)" >&2
  exit "$status"
fi

echo "PASS: $migration_total migrations and $verification_total Supabase contracts verified on ephemeral PostgreSQL 17."
