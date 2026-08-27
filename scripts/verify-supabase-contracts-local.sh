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
PG_DUMP=""
PG_RESTORE=""
CREATEDB=""
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
PG_DUMP="$PG_BIN_DIR/pg_dump"
PG_RESTORE="$PG_BIN_DIR/pg_restore"
CREATEDB="$PG_BIN_DIR/createdb"

for restore_binary in "$PG_DUMP" "$PG_RESTORE" "$CREATEDB"; do
  if ! is_postgres_17_binary "$restore_binary"; then
    echo "ERROR: The PostgreSQL 17 dump/restore toolchain is incomplete: $restore_binary" >&2
    exit 127
  fi
done

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
if [[ ${#migration_files[@]} -ne 126 ]]; then
  echo "ERROR: Expected the canonical 126-migration chain, found ${#migration_files[@]}." >&2
  exit 1
fi
if [[ ${#verification_files[@]} -ne 44 ]]; then
  echo "ERROR: Expected the canonical 44-contract inventory, found ${#verification_files[@]}." >&2
  exit 1
fi
if [[ ! -f "$VERIFICATION_DIR/schedule_window_read_contract.sql" ]]; then
  echo "ERROR: The schedule-window contract is missing from the verified inventory." >&2
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
# Avoid consuming the host's finite SysV shared-memory identifier pool. Writing
# this through initdb makes the setting durable for the subsequent pg_ctl start.
if ! run_interruptible "$INITDB" \
  -D "$DATA_DIR" \
  --username=postgres \
  --encoding=UTF8 \
  --no-locale \
  --auth-local=trust \
  --auth-host=reject \
  -c shared_memory_type=mmap \
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

  if [[ "$migration_filename" == "20260825042838_schedule_window_read_rpc.sql" ]]; then
    echo "[restored Payments V25] RUN V24 dump/restore then schedule migrations 118-119 and Payments migration 120"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v24-v25-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored Payments V25] PASS exact V24, schedule V25, and Payments V25 compatibility chain"
    else
      status=$?
      echo "[restored Payments V25] FAIL V24 through Payments V25 combined restore chain (exit $status)" >&2
      exit "$status"
    fi
  fi

  if [[ "$migration_filename" == "20260826030249_payments_adjustment_convergence.sql" ]]; then
    echo "[historical generation backfill] RUN generation-2 predecessor fixture"
    if run_interruptible "$PSQL" "${psql_args[@]}" <<'SQL'
INSERT INTO auth.users (
    id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
    '00000000-0000-4000-8000-000000009501'::UUID,
    'authenticated',
    'authenticated',
    'historical-generation-owner@example.invalid',
    '{}'::JSONB,
    '{}'::JSONB,
    now(),
    now()
);

INSERT INTO public.studios (id, name, slug, owner_id)
VALUES (
    '00000000-0000-4000-8000-000000009502'::UUID,
    'Historical Generation Backfill Contract',
    'historical-generation-backfill-contract',
    '00000000-0000-4000-8000-000000009501'::UUID
);

INSERT INTO public.studio_payment_accounts (
    studio_id,
    stripe_connected_account_id,
    status,
    charges_enabled,
    payouts_enabled,
    details_submitted,
    metadata
) VALUES (
    '00000000-0000-4000-8000-000000009502'::UUID,
    'acct_HistoricalGenerationBackfill2',
    'charges_enabled',
    true,
    true,
    true,
    '{"connect_account_generation":2}'::JSONB
);

INSERT INTO public.billing_payers (id, studio_id, display_name)
VALUES (
    '00000000-0000-4000-8000-000000009503'::UUID,
    '00000000-0000-4000-8000-000000009502'::UUID,
    'Historical Generation Payer'
);

INSERT INTO public.billing_payments (
    id,
    studio_id,
    payer_id,
    stripe_payment_intent_id,
    stripe_charge_id,
    stripe_account_id,
    status,
    amount_cents,
    currency,
    processed_at
) VALUES (
    '00000000-0000-4000-8000-000000009504'::UUID,
    '00000000-0000-4000-8000-000000009502'::UUID,
    '00000000-0000-4000-8000-000000009503'::UUID,
    'pi_HistoricalGenerationBackfill2',
    'ch_HistoricalGenerationBackfill2',
    'acct_HistoricalGenerationBackfill2',
    'succeeded',
    100,
    'usd',
    now()
);

INSERT INTO public.billing_refunds (
    id,
    studio_id,
    payment_id,
    stripe_refund_id,
    stripe_charge_id,
    stripe_payment_intent_id,
    stripe_account_id,
    amount_cents,
    status
) VALUES (
    '00000000-0000-4000-8000-000000009505'::UUID,
    '00000000-0000-4000-8000-000000009502'::UUID,
    '00000000-0000-4000-8000-000000009504'::UUID,
    're_HistoricalGenerationBackfill2',
    'ch_HistoricalGenerationBackfill2',
    'pi_HistoricalGenerationBackfill2',
    'acct_HistoricalGenerationBackfill2',
    25,
    'succeeded'
);

INSERT INTO public.billing_disputes (
    id,
    studio_id,
    payment_id,
    stripe_dispute_id,
    stripe_charge_id,
    stripe_payment_intent_id,
    stripe_account_id,
    amount_cents,
    status
) VALUES (
    '00000000-0000-4000-8000-000000009506'::UUID,
    '00000000-0000-4000-8000-000000009502'::UUID,
    '00000000-0000-4000-8000-000000009504'::UUID,
    'dp_HistoricalGenerationBackfill2',
    'ch_HistoricalGenerationBackfill2',
    'pi_HistoricalGenerationBackfill2',
    'acct_HistoricalGenerationBackfill2',
    100,
    'needs_response'
);
SQL
    then
      echo "[historical generation backfill] PASS generation-2 predecessor fixture"
    else
      status=$?
      echo "[historical generation backfill] FAIL generation-2 predecessor fixture (psql exit $status)" >&2
      exit "$status"
    fi

    echo "[restored V26] RUN V25 dump/restore then migration 121"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v25-v26-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored V26] PASS V25 dump/restore then migration 121"
    else
      status=$?
      echo "[restored V26] FAIL V25 dump/restore then migration 121 (exit $status)" >&2
      exit "$status"
    fi
  fi

  if [[ "$migration_filename" == "20260826051527_billing_provider_operations_and_payer_consent.sql" ]]; then
    echo "[restored V27] RUN V26 dump/restore then migration 122"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v26-v27-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored V27] PASS V26 dump/restore then migration 122"
    else
      status=$?
      echo "[restored V27] FAIL V26 dump/restore then migration 122 (exit $status)" >&2
      exit "$status"
    fi
  fi

  if [[ "$migration_filename" == "20260826073728_billing_provider_operation_steps.sql" ]]; then
    echo "[restored V28] RUN V27 dump/restore then migration 123"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v27-v28-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored V28] PASS V27 dump/restore then migration 123"
    else
      status=$?
      echo "[restored V28] FAIL V27 dump/restore then migration 123 (exit $status)" >&2
      exit "$status"
    fi
  fi

  if [[ "$migration_filename" == "20260826102840_enrollment_period_safe_transitions.sql" ]]; then
    echo "[restored V29] RUN V28 dump/restore then migration 124"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v28-v29-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored V29] PASS V28 dump/restore then migration 124"
    else
      status=$?
      echo "[restored V29] FAIL V28 dump/restore then migration 124 (exit $status)" >&2
      exit "$status"
    fi
  fi

  if [[ "$migration_filename" == "20260826155911_payments_workflow_catalog_and_replay_repairs.sql" ]]; then
    echo "[restored V30] RUN V29 dump/restore then migration 125"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v29-v30-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored V30] PASS V29 dump/restore then migration 125"
    else
      status=$?
      echo "[restored V30] FAIL V29 dump/restore then migration 125 (exit $status)" >&2
      exit "$status"
    fi
  fi

  if [[ "$migration_filename" == "20260826185651_payment_refund_payer_sync_resource_ownership.sql" ]]; then
    echo "[restored V31] RUN V30 dump/restore then migration 126"
    if run_interruptible bash \
      "$ROOT_DIR/scripts/verify-v30-v31-restore-contract.sh" \
      "$PG_DUMP" "$PG_RESTORE" "$CREATEDB" "$PSQL" \
      "$SOCKET_DIR" "$PG_PORT" "$TEMP_DIR" "$ROOT_DIR"; then
      echo "[restored V31] PASS V30 dump/restore then migration 126"
    else
      status=$?
      echo "[restored V31] FAIL V30 dump/restore then migration 126 (exit $status)" >&2
      exit "$status"
    fi
  fi

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

  if [[ "$migration_filename" == "20260826155911_payments_workflow_catalog_and_replay_repairs.sql" ]]; then
    echo "[V30 focused contract] RUN replay and invoice closeout behavior"
    if run_interruptible "$PSQL" "${psql_args[@]}" \
      --file="$ROOT_DIR/supabase/verification/payments_workflow_replay_repairs.sql"; then
      echo "[V30 focused contract] PASS replay and invoice closeout behavior"
    else
      status=$?
      echo "[V30 focused contract] FAIL replay and invoice closeout behavior (exit $status)" >&2
      exit "$status"
    fi
    v30_readiness="$("$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' ||
       cardinality(security_failures)::TEXT || '|' || manifest_version
FROM public.koaryu_release_schema_preflight_v11();
" | tr -d '\r\n')"
    if [[ "$v30_readiness" != "true|125|20260826155911|0|release-db-attestation-v30" ]]; then
      v30_failures="$("$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT COALESCE(array_to_string(security_failures, ','), '')
FROM public.koaryu_release_schema_preflight_v11();
" | tr -d '\r\n')"
      echo "[V30 readiness] FAIL exact release state: $v30_readiness failures=$v30_failures" >&2
      exit 1
    fi
    v29_compat_readiness="$("$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' ||
       cardinality(security_failures)::TEXT || '|' || manifest_version
FROM public.koaryu_release_schema_preflight_v10();
" | tr -d '\r\n')"
    if [[ "$v29_compat_readiness" != "true|124|20260826102840|0|release-db-attestation-v29" ]]; then
      echo "[V29 compatibility] FAIL exact predecessor state: $v29_compat_readiness" >&2
      exit 1
    fi
    echo "[V30 readiness] PASS exact release and V29 compatibility states"
  fi

  if [[ "$migration_filename" == "20260826185651_payment_refund_payer_sync_resource_ownership.sql" ]]; then
    v31_readiness="$("$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' ||
       cardinality(security_failures)::TEXT || '|' || manifest_version
FROM public.koaryu_release_schema_preflight_v12();
" | tr -d '\r\n')"
    if [[ "$v31_readiness" != "true|126|20260826185651|0|release-db-attestation-v31" ]]; then
      v31_failures="$("$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT COALESCE(array_to_string(security_failures, ','), '')
FROM public.koaryu_release_schema_preflight_v12();
" | tr -d '\r\n')"
      echo "[V31 readiness] FAIL exact release state: $v31_readiness failures=$v31_failures" >&2
      exit 1
    fi
    v30_compat_readiness="$("$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT ready::TEXT || '|' || migration_count::TEXT || '|' || migration_head || '|' ||
       cardinality(security_failures)::TEXT || '|' || manifest_version
FROM public.koaryu_release_schema_preflight_v11();
" | tr -d '\r\n')"
    if [[ "$v30_compat_readiness" != "true|125|20260826155911|0|release-db-attestation-v30" ]]; then
      echo "[V30 compatibility] FAIL exact predecessor state: $v30_compat_readiness" >&2
      exit 1
    fi
    echo "[V31 readiness] PASS exact release and V30 compatibility states"
  fi

  if [[ "$migration_filename" == "20260826030249_payments_adjustment_convergence.sql" ]]; then
    echo "[historical generation backfill] RUN fail-closed result"
    historical_generation_state="$(
      "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT
    COALESCE(payment.connect_account_generation::TEXT, '') || ':' ||
    payment.adjustment_reconciliation_required::TEXT || ':' ||
    payment.adjustment_reconciliation_reason_code || ':' ||
    COALESCE(refund.connect_account_generation::TEXT, '') || ':' ||
    refund.reconciliation_required::TEXT || ':' ||
    refund.reconciliation_reason_code || ':' ||
    COALESCE(dispute.connect_account_generation::TEXT, '') || ':' ||
    dispute.reconciliation_required::TEXT || ':' ||
    dispute.reconciliation_reason_code
FROM public.billing_payments AS payment
JOIN public.billing_refunds AS refund
  ON refund.payment_id = payment.id
JOIN public.billing_disputes AS dispute
  ON dispute.payment_id = payment.id
WHERE payment.id = '00000000-0000-4000-8000-000000009504'::UUID;
"
    )"
    historical_generation_state="$(printf '%s' "$historical_generation_state" | tr -d '\r\n')"
    expected_historical_generation_state=":true:historical_connect_generation_unknown::true:historical_connect_generation_unknown::true:historical_connect_generation_unknown"
    if [[ "$historical_generation_state" != "$expected_historical_generation_state" ]]; then
      echo "[historical generation backfill] FAIL fail-closed result: $historical_generation_state" >&2
      exit 1
    fi
    "$PSQL" "${psql_args[@]}" --quiet --command="
DELETE FROM public.studios
WHERE id = '00000000-0000-4000-8000-000000009502'::UUID;
DELETE FROM auth.users
WHERE id = '00000000-0000-4000-8000-000000009501'::UUID;
"
    echo "[historical generation backfill] PASS fail-closed result"
  fi

  if [[ "$migration_filename" == "20260823193155_revoke_public_function_execute.sql" ]]; then
    echo "[restored V23 recovery] RUN exact migration-116 failure tuple"
    if restored_v23_readiness="$(
      "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet <<'SQL'
BEGIN;

CREATE OR REPLACE FUNCTION private.koaryu_release_operational_manifest_v7()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
SET "TimeZone" = 'UTC'
AS $restored_manifest_fixture$
SELECT 'f9ce359c0ebf12039e8dfcb5308cd193ac18aa05cea23dad5b9f5208b0c51233'::TEXT
$restored_manifest_fixture$;

SELECT ready::text || '|' || migration_count::text || '|' || migration_head || '|' ||
       array_to_string(pending_versions, ',') || '|' ||
       cardinality(security_failures)::text || '|' ||
       coalesce(array_to_string(security_failures, ','), '') || '|' ||
       manifest_version
FROM public.koaryu_release_schema_preflight_v4();

ROLLBACK;
SQL
    )"; then
      restored_v23_readiness="$(printf '%s' "$restored_v23_readiness" | tr -d '\r\n')"
    else
      status=$?
      echo "[restored V23 recovery] FAIL tuple acquisition (psql exit $status)" >&2
      exit "$status"
    fi
    if (
      cd "$ROOT_DIR"
      node --input-type=module --eval '
        import { EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS } from "./scripts/studio-comp-migration-rollout.mjs";
        if (process.argv[1] !== EXPECTED_RESTORED_V23_PENDING_V24_OPERATIONAL_READINESS) process.exit(1);
      ' "$restored_v23_readiness"
    ); then
      echo "[restored V23 recovery] PASS exact migration-116 failure tuple"
    else
      echo "[restored V23 recovery] FAIL exact migration-116 failure tuple" >&2
      exit 1
    fi
  fi
done

echo "[operational manifest] RUN database-observable semantic and ACL signal"
operational_manifest="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT private.koaryu_release_operational_manifest_v7();
"
)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateOperationalManifest } from './scripts/studio-comp-migration-rollout.mjs'; validateOperationalManifest(process.argv[1]);" \
    "$operational_manifest"
); then
  echo "[operational manifest] PASS database-observable semantic and ACL signal"
else
  status=$?
  echo "[operational manifest] FAIL database-observable semantic and ACL signal (exit $status)" >&2
  exit "$status"
fi

echo "[starting-belt manifest] RUN database-observable invariant signal"
starting_belt_manifest="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT private.koaryu_release_starting_belt_manifest_v9();
"
)"
if [[ "$starting_belt_manifest" != "0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9" ]]; then
  echo "[starting-belt manifest] FAIL database-observable invariant signal: $starting_belt_manifest" >&2
  exit 1
fi
echo "[starting-belt manifest] PASS database-observable invariant signal"

echo "[student-rank manifest] RUN database-observable writer signal"
student_rank_manifest="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT private.koaryu_release_student_rank_writer_manifest_v13();
"
)"
if [[ "$student_rank_manifest" != "0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7" ]]; then
  echo "[student-rank manifest] FAIL database-observable writer signal: $student_rank_manifest" >&2
  exit 1
fi
echo "[student-rank manifest] PASS database-observable writer signal"

echo "[critical-surface manifest] RUN archive, checkout, and promotion identity signal"
critical_surface_manifest="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT private.koaryu_release_critical_surface_manifest_v18();
"
)"
if [[ "$critical_surface_manifest" != "0:31bec59b620eaa151c33cae2da08f533087e888216017247329e7cc517d98a0d" ]]; then
  echo "[critical-surface manifest] FAIL archive, checkout, and promotion identity signal: $critical_surface_manifest" >&2
  exit 1
fi
echo "[critical-surface manifest] PASS archive, checkout, and promotion identity signal"

echo "[schedule-window manifest] RUN read RPC definition and ACL signal"
schedule_window_manifest="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT private.koaryu_release_schedule_window_manifest_v1();
"
)"
if [[ "$schedule_window_manifest" != "0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7" ]]; then
  echo "[schedule-window manifest] FAIL read RPC definition and ACL signal: $schedule_window_manifest" >&2
  exit 1
fi
echo "[schedule-window manifest] PASS read RPC definition and ACL signal"

echo "[V25 readiness] RUN exact final migration and manifest signal"
operational_readiness="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { FINAL_OPERATIONAL_READINESS_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(FINAL_OPERATIONAL_READINESS_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateOperationalReadiness } from './scripts/studio-comp-migration-rollout.mjs'; validateOperationalReadiness(process.argv[1]);" \
    "$operational_readiness"
); then
  echo "[V25 readiness] PASS exact final migration and manifest signal"
else
  status=$?
  echo "[V25 readiness] FAIL exact final migration and manifest signal (exit $status)" >&2
  exit "$status"
fi

echo "[catalog] RUN deterministic raw catalog security fingerprint"
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
  echo "[catalog] PASS deterministic raw catalog security fingerprint"
else
  status=$?
  echo "[catalog] actual=$catalog_state" >&2
  echo "[catalog] FAIL deterministic raw catalog security fingerprint (exit $status)" >&2
  exit "$status"
fi

echo "[V30 compatibility] RUN re-pinned V26 singleton expectation"
v26_expectation_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { V26_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V26_EXPECTATION_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateV30CompatV26ExpectationState } from './scripts/studio-comp-migration-rollout.mjs'; validateV30CompatV26ExpectationState(process.argv[1]);" \
    "$v26_expectation_state"
); then
echo "[V30 compatibility] PASS re-pinned V26 singleton expectation"

echo "[V27 expectation] RUN private singleton release expectation"
v27_expectation_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { V27_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V27_EXPECTATION_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateV30CompatV27ExpectationState } from './scripts/studio-comp-migration-rollout.mjs'; validateV30CompatV27ExpectationState(process.argv[1]);" \
    "$v27_expectation_state"
); then
  echo "[V27 expectation] PASS private singleton release expectation"
else
  status=$?
  echo "[V27 expectation] FAIL private singleton release expectation (exit $status)" >&2
  exit "$status"
fi

echo "[V28 expectation] RUN private singleton release expectation"
v28_expectation_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { V28_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V28_EXPECTATION_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateV30CompatV28ExpectationState } from './scripts/studio-comp-migration-rollout.mjs'; validateV30CompatV28ExpectationState(process.argv[1]);" \
    "$v28_expectation_state"
); then
  echo "[V28 expectation] PASS private singleton release expectation"
else
  status=$?
  echo "[V28 expectation] FAIL private singleton release expectation (exit $status)" >&2
  exit "$status"
fi

echo "[V29 expectation] RUN V30-compatible private singleton expectation"
v29_expectation_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { V29_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V29_EXPECTATION_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateV30CompatV29ExpectationState } from './scripts/studio-comp-migration-rollout.mjs'; validateV30CompatV29ExpectationState(process.argv[1]);" \
    "$v29_expectation_state"
); then
  echo "[V29 expectation] PASS V30-compatible private singleton expectation"
else
  status=$?
  echo "[V29 expectation] FAIL V30-compatible private singleton expectation (exit $status)" >&2
  exit "$status"
fi

echo "[V30 expectation] RUN exact private singleton expectation"
v30_expectation_state="$({
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { V30_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V30_EXPECTATION_STATE_SQL);"
} | "$PSQL" "${psql_args[@]}" --tuples-only --no-align)"
if (
  cd "$ROOT_DIR"
  node --input-type=module --eval \
    "import { validateV30ExpectationState } from './scripts/studio-comp-migration-rollout.mjs'; validateV30ExpectationState(process.argv[1]);" \
    "$v30_expectation_state"
); then
  echo "[V30 expectation] PASS exact private singleton expectation"
else
  status=$?
  echo "[V30 expectation] FAIL exact private singleton expectation (exit $status)" >&2
  exit "$status"
fi
else
  status=$?
  echo "[V30 compatibility] FAIL re-pinned V26 singleton expectation (exit $status)" >&2
  exit "$status"
fi

assert_attestation_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local expected_v31_ready="$3"
  local result=""
  local drifted_catalog_state=""
  local actual_v31_ready=""

  echo "[attestation negative] RUN $label"
  result="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    (
      cd "$ROOT_DIR"
      node --input-type=module --eval \
        "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);"
    )
    printf ';\nSELECT ready FROM public.koaryu_release_schema_preflight_v12();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  drifted_catalog_state="$(printf '%s\n' "$result" | sed -n '1p')"
  actual_v31_ready="$(printf '%s\n' "$result" | sed -n '2p')"

  if (
    cd "$ROOT_DIR"
    node --input-type=module --eval \
      "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
      "$drifted_catalog_state" >/dev/null 2>&1
  ); then
    echo "[attestation negative] FAIL raw catalog accepted $label" >&2
    exit 1
  fi
  if [[ "$actual_v31_ready" != "$expected_v31_ready" ]]; then
    echo "[attestation negative] FAIL V31 readiness result for $label: $actual_v31_ready" >&2
    exit 1
  fi
  echo "[attestation negative] PASS $label"
}

assert_preflight_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local actual_v31_ready=""

  echo "[attestation negative] RUN $label"
  actual_v31_ready="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    printf 'SELECT ready FROM public.koaryu_release_schema_preflight_v12();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  if [[ "$actual_v31_ready" != "f" ]]; then
    echo "[attestation negative] FAIL V31 readiness result for $label: $actual_v31_ready" >&2
    exit 1
  fi
  echo "[attestation negative] PASS $label"
}

assert_v29_preflight_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local actual_v29_ready=""

  echo "[V29 attestation negative] RUN $label"
  actual_v29_ready="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    printf 'SELECT ready FROM public.koaryu_release_schema_preflight_v10();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  if [[ "$actual_v29_ready" != "f" ]]; then
    echo "[V29 attestation negative] FAIL $label: $actual_v29_ready" >&2
    exit 1
  fi
  echo "[V29 attestation negative] PASS $label"
}

assert_v30_preflight_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local actual_v30_ready=""

  echo "[V30 attestation negative] RUN $label"
  actual_v30_ready="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    printf 'SELECT ready FROM public.koaryu_release_schema_preflight_v11();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  if [[ "$actual_v30_ready" != "f" ]]; then
    echo "[V30 attestation negative] FAIL $label: $actual_v30_ready" >&2
    exit 1
  fi
  echo "[V30 attestation negative] PASS $label"
}

assert_v27_compat_v26_release_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local result=""
  local drifted_catalog_state=""
  local drifted_expectation_state=""
  local actual_v26_ready=""
  local catalog_accepted=false
  local expectation_accepted=false

  echo "[V26 negative] RUN $label"
  result="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    (
      cd "$ROOT_DIR"
      node --input-type=module --eval \
        "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);"
    )
    printf ';\n'
    (
      cd "$ROOT_DIR"
      node --input-type=module --eval \
        "import { V26_EXPECTATION_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(V26_EXPECTATION_STATE_SQL);"
    )
    printf ';\nSELECT ready FROM public.koaryu_release_schema_preflight_v7();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  drifted_catalog_state="$(printf '%s\n' "$result" | sed -n '1p')"
  drifted_expectation_state="$(printf '%s\n' "$result" | sed -n '2p')"
  actual_v26_ready="$(printf '%s\n' "$result" | sed -n '3p')"

  if (
    cd "$ROOT_DIR"
    node --input-type=module --eval \
      "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
      "$drifted_catalog_state" >/dev/null 2>&1
  ); then
    catalog_accepted=true
  fi
  if (
    cd "$ROOT_DIR"
    node --input-type=module --eval \
      "import { validateV30CompatV26ExpectationState } from './scripts/studio-comp-migration-rollout.mjs'; validateV30CompatV26ExpectationState(process.argv[1]);" \
      "$drifted_expectation_state" >/dev/null 2>&1
  ); then
    expectation_accepted=true
  fi

  if [[ "$catalog_accepted" == true && "$expectation_accepted" == true ]]; then
    echo "[V26 negative] FAIL release fingerprints accepted $label" >&2
    exit 1
  fi
  if [[ "$actual_v26_ready" != "f" ]]; then
    echo "[V26 negative] FAIL V26 readiness result for $label: $actual_v26_ready" >&2
    exit 1
  fi
  echo "[V26 negative] PASS $label"
}

assert_v27_compat_v26_release_rejects \
  "missing V26 expectation row" \
  "DELETE FROM private.koaryu_release_v26_expectations;"
assert_v27_compat_v26_release_rejects \
  "mutated V26 expectation row" \
  "UPDATE private.koaryu_release_v26_expectations SET expected_sha256 = repeat('0', 64);"
assert_v27_compat_v26_release_rejects \
  "extra V26 expectation row" \
  "ALTER TABLE private.koaryu_release_v26_expectations DROP CONSTRAINT koaryu_release_v26_expectation_key_exact; INSERT INTO private.koaryu_release_v26_expectations(expectation_key, expected_sha256) VALUES ('unexpected', repeat('0', 64));"
assert_v27_compat_v26_release_rejects \
  "V26 expectation ACL broadening" \
  "GRANT SELECT ON private.koaryu_release_v26_expectations TO service_role;"
assert_preflight_rejects \
  "V7 preflight body tamper" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::regprocedure;"
assert_preflight_rejects \
  "V8 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::regprocedure;"
assert_preflight_rejects \
  "V9 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::regprocedure;"
assert_preflight_rejects \
  "V10 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::regprocedure;"
assert_preflight_rejects \
  "V11 compatibility preflight body tamper" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::regprocedure;"

assert_preflight_rejects \
  "V27 expectation service-role ACL broadening" \
  "GRANT SELECT ON private.koaryu_release_v27_expectations TO service_role;"
assert_preflight_rejects \
  "V28 expectation browser-role ACL broadening" \
  "GRANT UPDATE ON private.koaryu_release_v28_expectations TO authenticated;"
assert_preflight_rejects \
  "V29 expectation custom-role ACL broadening" \
  "CREATE ROLE koaryu_v29_expectation_acl_probe NOLOGIN; GRANT SELECT ON private.koaryu_release_v29_expectations TO koaryu_v29_expectation_acl_probe;"
assert_preflight_rejects \
  "V30 expectation service-role GRANT OPTION drift" \
  "GRANT UPDATE ON private.koaryu_release_v30_expectations TO service_role WITH GRANT OPTION;"

assert_preflight_rejects \
  "due-transition claim custom-role EXECUTE drift" \
  "CREATE ROLE koaryu_due_claim_acl_probe NOLOGIN; GRANT EXECUTE ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer) TO koaryu_due_claim_acl_probe;"
assert_preflight_rejects \
  "due-transition claim service-role GRANT OPTION drift" \
  "GRANT EXECUTE ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer) TO service_role WITH GRANT OPTION;"
assert_preflight_rejects \
  "payer-autopay disable custom-role EXECUTE drift" \
  "CREATE ROLE koaryu_disable_autopay_acl_probe NOLOGIN; GRANT EXECUTE ON FUNCTION public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text) TO koaryu_disable_autopay_acl_probe;"
assert_preflight_rejects \
  "payer-autopay disable service-role GRANT OPTION drift" \
  "GRANT EXECUTE ON FUNCTION public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text) TO service_role WITH GRANT OPTION;"
assert_preflight_rejects \
  "payer-setup projection custom-role EXECUTE drift" \
  "CREATE ROLE koaryu_finalize_payer_acl_probe NOLOGIN; GRANT EXECUTE ON FUNCTION public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer) TO koaryu_finalize_payer_acl_probe;"
assert_preflight_rejects \
  "payer-setup projection service-role GRANT OPTION drift" \
  "GRANT EXECUTE ON FUNCTION public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer) TO service_role WITH GRANT OPTION;"

assert_attestation_rejects \
  "stored function-body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN false; END;' WHERE oid = 'private.live_billing_event_is_in_scope(text,text)'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "Connect delivery response RPC body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN; END;' WHERE oid = 'public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "V4 helper self-body drift" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_operational_manifest_v4()'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "V5 helper self-body drift" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_operational_manifest_v5()'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "V6 helper self-body drift" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_operational_manifest_v6()'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "V7 helper self-body drift under V29 readiness" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_operational_manifest_v7()'::regprocedure;" \
  "f"
assert_v29_preflight_rejects \
  "post-V29 operational manifest includes V7 body authority" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected V29 authority drift' WHERE oid = 'private.koaryu_release_operational_manifest_v7()'::regprocedure;"
assert_v30_preflight_rejects \
  "operation-aware authorization writer body drift" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected V30 writer drift' WHERE oid = 'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::regprocedure;"
assert_v30_preflight_rejects \
  "legacy authorization scope regained service execution" \
  "GRANT EXECUTE ON FUNCTION public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text) TO service_role;"
assert_v30_preflight_rejects \
  "operation allowlist constraint missing" \
  "ALTER TABLE public.studio_live_billing_authorizations DROP CONSTRAINT studio_live_billing_authorizations_operation_set_exact;"
assert_v30_preflight_rejects \
  "operation allowlist column nullability drift" \
  "ALTER TABLE public.studio_live_billing_authorizations ALTER COLUMN allowed_operations DROP NOT NULL;"
assert_v30_preflight_rejects \
  "operation allowlist default drift" \
  "ALTER TABLE public.studio_live_billing_authorizations ALTER COLUMN allowed_operations DROP DEFAULT;"
assert_preflight_rejects \
  "starting-belt function-body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN NULL; END;' WHERE oid = 'public.backfill_starting_belt_after_rank_delete()'::regprocedure;"
assert_preflight_rejects \
  "starting-belt trigger-definition drift" \
  "ALTER TABLE public.belt_ranks DISABLE TRIGGER backfill_starting_belt_after_rank_delete_trigger;"
assert_preflight_rejects \
  "student profile wrapper body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN NULL; END;' WHERE oid = 'public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'::regprocedure;"
assert_preflight_rejects \
  "student import private writer body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN; END;' WHERE oid = 'private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'::regprocedure;"
assert_preflight_rejects \
  "promotion snapshot column type drift" \
  "ALTER TABLE public.promotions ALTER COLUMN from_rank_name_snapshot TYPE varchar(200);"
assert_preflight_rejects \
  "promotion snapshot column nullability drift" \
  "ALTER TABLE public.promotions ALTER COLUMN from_rank_color_snapshot SET NOT NULL;"
assert_preflight_rejects \
  "promotion snapshot column default drift" \
  "ALTER TABLE public.promotions ALTER COLUMN to_rank_name_snapshot SET DEFAULT '';"
assert_preflight_rejects \
  "promotion snapshot column missing" \
  "ALTER TABLE public.promotions DROP COLUMN to_rank_color_snapshot CASCADE;"
assert_preflight_rejects \
  "promotion target rank nullability drift" \
  "ALTER TABLE public.promotions ALTER COLUMN to_rank_id SET NOT NULL;"
assert_attestation_rejects \
  "V9 helper self-body drift (external authority only)" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_starting_belt_manifest_v9()'::regprocedure;" \
  "t"
assert_attestation_rejects \
  "V11 helper self-body drift (external authority only)" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_student_rank_writer_manifest_v11()'::regprocedure;" \
  "t"
assert_attestation_rejects \
  "V13 helper self-body drift (external authority only)" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_student_rank_writer_manifest_v13()'::regprocedure;" \
  "t"
assert_attestation_rejects \
  "V16 helper self-body drift (external authority only)" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_critical_surface_manifest_v16()'::regprocedure;" \
  "t"
assert_preflight_rejects \
  "dashboard RPC service-role grant drift" \
  "REVOKE EXECUTE ON FUNCTION public.dashboard_summary_facts(uuid, text, text, date, text) FROM service_role;"
assert_attestation_rejects \
  "schedule-window RPC body drift" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.schedule_window_read(uuid,date,date,text)'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "schedule-window RPC service-role grant drift" \
  "REVOKE EXECUTE ON FUNCTION public.schedule_window_read(uuid,date,date,text) FROM service_role;" \
  "f"
assert_attestation_rejects \
  "schedule-window manifest helper self-body drift" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_schedule_window_manifest_v1()'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "promotion operation receipt column drift" \
  "ALTER TABLE public.promotions ALTER COLUMN operation_id TYPE text USING operation_id::text;" \
  "f"
assert_attestation_rejects \
  "promotion operation receipt index drift" \
  "DROP INDEX public.promotions_studio_operation_once;" \
  "f"
assert_attestation_rejects \
  "promotion transition kind constraint drift" \
  "ALTER TABLE public.promotions DROP CONSTRAINT promotions_transition_kind_check;" \
  "f"
assert_attestation_rejects \
  "promotion transition kind column drift" \
  "ALTER TABLE public.promotions DROP COLUMN transition_kind CASCADE;" \
  "f"
assert_attestation_rejects \
  "checkpoint trigger-definition drift" \
  "ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints DISABLE TRIGGER enforce_live_billing_checkpoint_processed_events;" \
  "f"
assert_attestation_rejects \
  "bootstrap index-definition drift" \
  "DROP INDEX public.idx_stripe_connect_onboarding_bootstraps_generation_once;" \
  "f"
assert_attestation_rejects \
  "bootstrap CHECK-expression drift" \
  "DO \$koaryu\$ DECLARE v_constraint name; BEGIN SELECT conname INTO v_constraint FROM pg_constraint WHERE conrelid = 'public.stripe_connect_onboarding_bootstraps'::regclass AND contype = 'c' ORDER BY conname LIMIT 1; EXECUTE format('ALTER TABLE public.stripe_connect_onboarding_bootstraps DROP CONSTRAINT %I', v_constraint); END \$koaryu\$;" \
  "f"
assert_attestation_rejects \
  "UTC-normalized reconciliation window CHECK drift" \
  "ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints DROP CONSTRAINT stripe_live_checkpoint_window_contract; ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints ADD CONSTRAINT stripe_live_checkpoint_window_contract CHECK (event_window_started_at IS NULL OR event_window_ended_at IS NOT NULL);" \
  "f"
assert_attestation_rejects \
  "Connect delivery column drift" \
  "ALTER TABLE public.stripe_connect_onboarding_bootstraps DROP COLUMN initial_link_support_required_at CASCADE;" \
  "f"
assert_attestation_rejects \
  "Connect delivery CHECK drift" \
  "ALTER TABLE public.stripe_connect_onboarding_bootstraps DROP CONSTRAINT stripe_connect_onboarding_bootstraps_receipt_expiry;" \
  "f"
assert_attestation_rejects \
  "Connect delivery index drift" \
  "DROP INDEX public.idx_stripe_connect_onboarding_bootstraps_delivery_receipt;" \
  "f"
assert_attestation_rejects \
  "private identity UNIQUE drift" \
  "ALTER TABLE private.stripe_connect_account_identity_guards DROP CONSTRAINT stripe_connect_account_identity_guards_mapped_studio_id_key;" \
  "f"
assert_attestation_rejects \
  "private identity FK drift" \
  "ALTER TABLE private.stripe_connect_account_identity_guards DROP CONSTRAINT stripe_connect_account_identity_guards_mapped_studio_id_fkey;" \
  "f"
assert_attestation_rejects \
  "private identity CHECK drift" \
  "DO \$koaryu\$ DECLARE v_constraint name; BEGIN SELECT conname INTO v_constraint FROM pg_constraint WHERE conrelid = 'private.stripe_connect_account_identity_guards'::regclass AND contype = 'c' ORDER BY conname LIMIT 1; EXECUTE format('ALTER TABLE private.stripe_connect_account_identity_guards DROP CONSTRAINT %I', v_constraint); END \$koaryu\$;" \
  "f"
assert_attestation_rejects \
  "public Connect mapping FK drift" \
  "DO \$koaryu\$ DECLARE v_constraint name; BEGIN SELECT conname INTO v_constraint FROM pg_constraint WHERE conrelid = 'public.studio_payment_accounts'::regclass AND contype = 'f' ORDER BY conname LIMIT 1; EXECUTE format('ALTER TABLE public.studio_payment_accounts DROP CONSTRAINT %I', v_constraint); END \$koaryu\$;" \
  "f"
assert_attestation_rejects \
  "public Connect exclusion CHECK drift" \
  "DO \$koaryu\$ DECLARE v_constraint name; BEGIN SELECT conname INTO v_constraint FROM pg_constraint WHERE conrelid = 'public.stripe_connect_account_dispositions'::regclass AND contype = 'c' ORDER BY conname LIMIT 1; EXECUTE format('ALTER TABLE public.stripe_connect_account_dispositions DROP CONSTRAINT %I', v_constraint); END \$koaryu\$;" \
  "f"
assert_attestation_rejects \
  "required service-role table ACL drift" \
  "REVOKE SELECT ON TABLE public.stripe_live_billing_reconciliation_account_evidence FROM service_role;" \
  "f"
assert_attestation_rejects \
  "unexpected custom-role table ACL drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; GRANT SELECT ON TABLE public.stripe_live_billing_reconciliation_account_evidence TO koaryu_attestation_custom_role;" \
  "f"
assert_attestation_rejects \
  "service-role table GRANT OPTION drift" \
  "GRANT SELECT ON TABLE public.stripe_live_billing_reconciliation_account_evidence TO service_role WITH GRANT OPTION;" \
  "f"
assert_attestation_rejects \
  "anon private-column ACL drift" \
  "GRANT SELECT (stripe_connected_account_id) ON TABLE private.stripe_connect_account_identity_guards TO anon;" \
  "f"
assert_attestation_rejects \
  "authenticated private-column ACL drift" \
  "GRANT UPDATE (mapped_studio_id) ON TABLE private.stripe_connect_account_identity_guards TO authenticated;" \
  "f"
assert_attestation_rejects \
  "unexpected custom-role private-column ACL drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; GRANT SELECT (excluded) ON TABLE private.stripe_connect_account_identity_guards TO koaryu_attestation_custom_role;" \
  "f"
assert_attestation_rejects \
  "service-role public-column GRANT OPTION drift" \
  "GRANT UPDATE (grant_reason) ON TABLE public.studio_live_billing_authorizations TO service_role WITH GRANT OPTION;" \
  "f"
assert_attestation_rejects \
  "unexpected custom-role public-column GRANT OPTION drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; GRANT SELECT (error_reference) ON TABLE public.stripe_events TO koaryu_attestation_custom_role WITH GRANT OPTION;" \
  "f"
assert_attestation_rejects \
  "studio payment account custom-role ACL drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; GRANT SELECT ON TABLE public.studio_payment_accounts TO koaryu_attestation_custom_role;" \
  "f"
assert_attestation_rejects \
  "studio payment account service-role GRANT OPTION drift" \
  "GRANT SELECT ON TABLE public.studio_payment_accounts TO service_role WITH GRANT OPTION;" \
  "f"
assert_attestation_rejects \
  "studio payment account browser structural ACL drift" \
  "GRANT TRIGGER ON TABLE public.studio_payment_accounts TO authenticated;" \
  "f"
assert_attestation_rejects \
  "Stripe event custom-role ACL drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; GRANT SELECT ON TABLE public.stripe_events TO koaryu_attestation_custom_role;" \
  "f"
assert_attestation_rejects \
  "Stripe event service-role GRANT OPTION drift" \
  "GRANT SELECT ON TABLE public.stripe_events TO service_role WITH GRANT OPTION;" \
  "f"
assert_attestation_rejects \
  "Stripe event excessive service-role ACL drift" \
  "GRANT TRUNCATE ON TABLE public.stripe_events TO service_role;" \
  "f"
assert_attestation_rejects \
  "required service-role RPC ACL drift" \
  "REVOKE EXECUTE ON FUNCTION public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text) FROM service_role;" \
  "f"
assert_attestation_rejects \
  "Connect delivery required service-role RPC ACL drift" \
  "REVOKE EXECUTE ON FUNCTION public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text) FROM service_role;" \
  "f"
assert_attestation_rejects \
  "Connect delivery unexpected custom-role RPC GRANT OPTION drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; GRANT EXECUTE ON FUNCTION public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text) TO koaryu_attestation_custom_role WITH GRANT OPTION;" \
  "f"
assert_attestation_rejects \
  "forbidden browser/PUBLIC ACL drift" \
  "GRANT SELECT ON TABLE public.stripe_connect_onboarding_bootstraps TO anon;" \
  "f"
assert_attestation_rejects \
  "unexpected custom-role sequence ACL drift" \
  "CREATE ROLE koaryu_attestation_custom_role NOLOGIN; DO \$koaryu\$ BEGIN EXECUTE format('GRANT SELECT ON SEQUENCE %s TO koaryu_attestation_custom_role', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence')::REGCLASS); END \$koaryu\$;" \
  "f"
assert_attestation_rejects \
  "service-role sequence GRANT OPTION drift" \
  "DO \$koaryu\$ BEGIN EXECUTE format('GRANT USAGE ON SEQUENCE %s TO service_role WITH GRANT OPTION', pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence')::REGCLASS); END \$koaryu\$;" \
  "f"
assert_attestation_rejects \
  "unmanifested permissive policy drift" \
  "CREATE POLICY koaryu_harness_forbidden_permissive_policy ON public.studio_live_billing_authorizations AS PERMISSIVE FOR SELECT TO anon USING (true);" \
  "f"

echo "[concurrency] RUN Core checkout acceptance/reservation serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-core-checkout-accept-reserve-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS Core checkout acceptance/reservation serialization"
else
  status=$?
  echo "[concurrency] FAIL Core checkout acceptance/reservation serialization (exit $status)" >&2
  exit "$status"
fi

echo "[concurrency] RUN Connect identity mapping/exclusion invariant"
if bash "$ROOT_DIR/scripts/verify-connect-identity-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT" postgres postgres; then
  echo "[concurrency] PASS Connect identity mapping/exclusion invariant"
else
  status=$?
  echo "[concurrency] FAIL Connect identity mapping/exclusion invariant (exit $status)" >&2
  exit "$status"
fi

echo "[concurrency] RUN student profile/rank-plan lock ordering"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-student-profile-rank-plan-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS student profile/rank-plan lock ordering"
else
  status=$?
  echo "[concurrency] FAIL student profile/rank-plan lock ordering (exit $status)" >&2
  exit "$status"
fi

echo "[concurrency] RUN billing payment parent/child identity serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-billing-payment-identity-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS billing payment parent/child identity serialization"
else
  status=$?
  echo "[concurrency] FAIL billing payment parent/child identity serialization (exit $status)" >&2
  exit "$status"
fi

echo "[concurrency] RUN payer setup single-owner serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-billing-payer-setup-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS payer setup single-owner serialization"
else
  status=$?
  echo "[concurrency] FAIL payer setup single-owner serialization (exit $status)" >&2
  exit "$status"
fi

echo "[concurrency] RUN provider operation step single-attempt serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-billing-provider-operation-step-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS provider operation step single-attempt serialization"
else
  status=$?
  echo "[concurrency] FAIL provider operation step single-attempt serialization (exit $status)" >&2
  exit "$status"
fi

echo "[concurrency] RUN enrollment period transition serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-billing-enrollment-transition-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS enrollment period transition serialization"
else
  status=$?
  echo "[concurrency] FAIL enrollment period transition serialization (exit $status)" >&2
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

echo "[concurrency] RUN student bulk archive hard-delete/lock-order serialization"
if run_interruptible bash \
  "$ROOT_DIR/scripts/verify-student-bulk-archive-concurrency.sh" \
  "$PSQL" "$SOCKET_DIR" "$PG_PORT"; then
  echo "[concurrency] PASS student bulk archive hard-delete/lock-order serialization"
else
  status=$?
  echo "[concurrency] FAIL student bulk archive hard-delete/lock-order serialization (exit $status)" >&2
  exit "$status"
fi

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
