#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_DIR="$ROOT_DIR/supabase/migrations"
VERIFICATION_DIR="$ROOT_DIR/supabase/verification"
TEMP_DIR=""
DATA_DIR=""
SOCKET_DIR=""
POSTMASTER_LOG=""
PG_CTL=""
PG_PORT=5432

cleanup() {
  local original_status=$?
  local cleanup_failed=0

  trap - EXIT INT TERM
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
  echo "Interrupted by $signal; cleaning up the ephemeral PostgreSQL cluster." >&2
  if [[ "$signal" == "INT" ]]; then
    exit 130
  fi
  exit 143
}

trap cleanup EXIT
trap 'on_interrupt INT' INT
trap 'on_interrupt TERM' TERM

resolve_pg_binary() {
  local binary="$1"
  local pg_bindir="${2:-}"

  if [[ -n "$pg_bindir" && -x "$pg_bindir/$binary" ]]; then
    printf '%s\n' "$pg_bindir/$binary"
    return
  fi

  if command -v "$binary" >/dev/null 2>&1; then
    command -v "$binary"
    return
  fi

  echo "ERROR: PostgreSQL 17 binary '$binary' is required but was not found." >&2
  exit 127
}

pg_bindir=""
if command -v pg_config >/dev/null 2>&1; then
  pg_bindir="$(pg_config --bindir 2>/dev/null || true)"
fi

INITDB="$(resolve_pg_binary initdb "$pg_bindir")"
PG_CTL="$(resolve_pg_binary pg_ctl "$pg_bindir")"
PSQL="$(resolve_pg_binary psql "$pg_bindir")"

pg_version="$("$INITDB" --version)"
# `initdb --version` prints "initdb (PostgreSQL) 17.10 (Homebrew)" -- the closing
# paren sits between the product name and the number, so anchoring on
# "PostgreSQL 17." rejects every standard install.
if [[ ! "$pg_version" =~ (^|[^0-9])17\.[0-9] ]]; then
  echo "ERROR: PostgreSQL 17 is required; found: $pg_version" >&2
  exit 1
fi

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
if ! "$INITDB" \
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
if ! "$PG_CTL" \
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

echo "[bootstrap] RUN Supabase compatibility shim"
if "${PSQL}" "${psql_args[@]}" <<'SQL'
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
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN NOINHERIT CREATEROLE CREATEDB REPLICATION BYPASSRLS;
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
  if "$PSQL" "${psql_args[@]}" \
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

verification_total=${#verification_files[@]}
verification_index=0
for verification_file in "${verification_files[@]}"; do
  verification_index=$((verification_index + 1))
  verification_filename="$(basename "$verification_file")"

  echo "[contract $verification_index/$verification_total] RUN $verification_filename"
  if "$PSQL" "${psql_args[@]}" --file="$verification_file"; then
    echo "[contract $verification_index/$verification_total] PASS $verification_filename"
  else
    status=$?
    echo "[contract $verification_index/$verification_total] FAIL $verification_filename (psql exit $status)" >&2
    exit "$status"
  fi
done

echo "PASS: $migration_total migrations and $verification_total Supabase contracts verified on ephemeral PostgreSQL 17."
