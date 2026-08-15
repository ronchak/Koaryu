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

echo "[critical-surface manifest] RUN checkout and promotion identity signal"
critical_surface_manifest="$(
  "$PSQL" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT private.koaryu_release_critical_surface_manifest_v16();
"
)"
if [[ "$critical_surface_manifest" != "0:554eb9e9f8317929a8f13322fa7ad961defbcfe641b689e46640d9fba83a30ca" ]]; then
  echo "[critical-surface manifest] FAIL checkout and promotion identity signal: $critical_surface_manifest" >&2
  exit 1
fi
echo "[critical-surface manifest] PASS checkout and promotion identity signal"

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

assert_attestation_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local expected_v2_ready="$3"
  local result=""
  local drifted_catalog_state=""
  local actual_v2_ready=""

  echo "[attestation negative] RUN $label"
  result="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    (
      cd "$ROOT_DIR"
      node --input-type=module --eval \
        "import { CATALOG_STATE_SQL } from './scripts/studio-comp-migration-rollout.mjs'; process.stdout.write(CATALOG_STATE_SQL);"
    )
    printf ';\nSELECT ready FROM public.koaryu_release_schema_preflight_v3();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  drifted_catalog_state="$(printf '%s\n' "$result" | sed -n '1p')"
  actual_v2_ready="$(printf '%s\n' "$result" | sed -n '2p')"

  if (
    cd "$ROOT_DIR"
    node --input-type=module --eval \
      "import { validateCatalogState } from './scripts/studio-comp-migration-rollout.mjs'; validateCatalogState(process.argv[1]);" \
      "$drifted_catalog_state" >/dev/null 2>&1
  ); then
    echo "[attestation negative] FAIL raw catalog accepted $label" >&2
    exit 1
  fi
  if [[ "$actual_v2_ready" != "$expected_v2_ready" ]]; then
    echo "[attestation negative] FAIL V2 readiness result for $label" >&2
    exit 1
  fi
  echo "[attestation negative] PASS $label"
}

assert_preflight_rejects() {
  local label="$1"
  local mutation_sql="$2"
  local actual_v2_ready=""

  echo "[attestation negative] RUN $label"
  actual_v2_ready="$({
    printf 'BEGIN;\n%s\n' "$mutation_sql"
    printf 'SELECT ready FROM public.koaryu_release_schema_preflight_v3();\nROLLBACK;\n'
  } | "$PSQL" "${psql_args[@]}" --tuples-only --no-align --quiet)"
  if [[ "$actual_v2_ready" != "f" ]]; then
    echo "[attestation negative] FAIL V2 readiness result for $label" >&2
    exit 1
  fi
  echo "[attestation negative] PASS $label"
}

assert_attestation_rejects \
  "stored function-body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN false; END;' WHERE oid = 'private.live_billing_event_is_in_scope(text,text)'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "Connect delivery response RPC body drift" \
  "UPDATE pg_proc SET prosrc = 'BEGIN RETURN; END;' WHERE oid = 'public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)'::regprocedure;" \
  "f"
assert_attestation_rejects \
  "V2 self-body drift (external authority only)" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'public.koaryu_release_schema_preflight_v3()'::regprocedure;" \
  "t"
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
  "V7 helper self-body drift (external authority only)" \
  "UPDATE pg_proc SET prosrc = prosrc || chr(10) || '-- injected drift' WHERE oid = 'private.koaryu_release_operational_manifest_v7()'::regprocedure;" \
  "t"
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
