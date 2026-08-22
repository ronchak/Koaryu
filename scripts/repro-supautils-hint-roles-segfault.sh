#!/usr/bin/env bash
# Reproduction for issue #113.
#
# Calling a function the current role lacks EXECUTE on terminates the PostgreSQL
# backend with SIGSEGV instead of raising insufficient_privilege. The cause is
# supautils, loaded through session_preload_libraries, combined with a non-empty
# supautils.hint_roles. That setting makes supautils rewrite permission-denied
# errors to add a GRANT hint. It handles tables correctly and crashes on functions.
#
# The PostgreSQL build is not involved. Every Supabase image we run reproduces the
# crash with hint_roles set and behaves correctly with it empty.
#
# Usage: scripts/repro-supautils-hint-roles-segfault.sh [image-tag]
set -uo pipefail

IMAGE="${1:-public.ecr.aws/supabase/postgres:17.6.1.106}"
PRELOAD="pg_stat_statements,pgaudit,plpgsql,plpgsql_check,pg_cron,pg_net,pgsodium,auto_explain,pg_tle,plan_filter,supabase_vault"

setup_sql() {
  cat <<'EOF'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
END $$;
GRANT anon TO postgres WITH ADMIN OPTION;
CREATE SCHEMA IF NOT EXISTS r113;
CREATE OR REPLACE FUNCTION r113.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
CREATE TABLE IF NOT EXISTS r113.t(id int);
REVOKE ALL ON FUNCTION r113.f() FROM PUBLIC, anon;
REVOKE ALL ON r113.t FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA r113 TO anon, postgres;
EOF
}

# probe <container> <sql> -> prints CRASH / clean error / other
probe() {
  local name="$1" sql="$2" out
  out="$(docker exec "$name" psql -U postgres -d postgres -Atc \
    "BEGIN; SET LOCAL ROLE anon; $sql; ROLLBACK;" 2>&1 | tr '\n' ' ')"
  case "$out" in
    *"server closed the connection"*) echo "CRASH (SIGSEGV)" ;;
    *"permission denied"*)            echo "clean error (correct)" ;;
    *)                                echo "other: ${out:0:70}" ;;
  esac
}

CASE_N=0

run_case() {
  local label="$1"; shift
  CASE_N=$((CASE_N + 1))
  local name="r113-probe-$$-$CASE_N"
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" -e POSTGRES_PASSWORD=postgres "$IMAGE" postgres \
    -c shared_preload_libraries="$PRELOAD" -c cron.database_name=postgres "$@" >/dev/null 2>&1 \
    || { echo "$label: container failed to start"; return 1; }

  # The image runs a temporary server for initdb before starting the real one,
  # so pg_isready alone races. Wait for the entrypoint marker first.
  local i ready=""
  for i in $(seq 1 90); do
    docker logs "$name" 2>&1 | grep -q "PostgreSQL init process complete" && break
    sleep 1
  done
  for i in $(seq 1 90); do
    if docker exec "$name" psql -U supabase_admin -d postgres -Atc "SELECT 1" >/dev/null 2>&1; then
      ready=yes; break
    fi
    sleep 1
  done
  if [ -z "$ready" ]; then
    printf '  %-38s SERVER NEVER BECAME READY\n' "$label"
    docker logs --tail 5 "$name" 2>&1 | sed 's/^/      /'
    docker rm -f "$name" >/dev/null 2>&1
    return 1
  fi

  setup_sql | docker exec -i "$name" psql -U supabase_admin -d postgres -q >/dev/null 2>&1

  printf '  %-38s table=%-22s function=%s\n' \
    "$label" \
    "$(probe "$name" 'SELECT * FROM r113.t')" \
    "$(probe "$name" 'SELECT r113.f()')"

  docker rm -f "$name" >/dev/null 2>&1
}

echo "Image: $IMAGE"
run_case "supautils + hint_roles set"   -c session_preload_libraries=supautils \
                                        -c supautils.hint_roles='anon, authenticated, service_role'
run_case "supautils + hint_roles empty" -c session_preload_libraries=supautils
run_case "no supautils"
