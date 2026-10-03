#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/run-supabase-sql.sh <sql-file>" >&2
  exit 2
fi

sql_file="$1"
db_target="${SUPABASE_DB_TARGET:-local}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$sql_file" ]]; then
  echo "Supabase SQL file not found: $sql_file" >&2
  exit 2
fi

case "$db_target" in
  local)
    if ! command -v supabase >/dev/null 2>&1 || ! command -v docker >/dev/null 2>&1; then
      echo "Supabase CLI and Docker are required for local contract checks." >&2
      exit 127
    fi

    status_args=(status -o json)
    if [[ -n "${SUPABASE_WORKDIR:-}" ]]; then
      status_args+=(--workdir "$SUPABASE_WORKDIR")
    fi

    db_port="$({ supabase "${status_args[@]}" 2>/dev/null || true; } | python3 "$script_dir/supabase-sql-target.py" local-port)" || {
      echo "Unable to resolve the local Supabase database URL. Start the local database first." >&2
      exit 1
    }

    db_container="$(docker ps \
      --filter label=com.supabase.cli.project \
      --format '{{.Names}}\t{{.Ports}}' \
      | awk -F '\t' -v port=":${db_port}->5432/tcp" 'index($2, port) { print $1 }')"

    if [[ -z "$db_container" || "$db_container" == *$'\n'* ]]; then
      echo "Unable to identify exactly one local Supabase database container." >&2
      exit 1
    fi

    docker exec -i "$db_container" psql \
      -U postgres \
      -d postgres \
      --no-psqlrc \
      --set=ON_ERROR_STOP=1 \
      < "$sql_file"
    exit 0
    ;;
  linked)
    if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
      echo "SUPABASE_DB_URL is required for linked multi-statement contract checks." >&2
      exit 2
    fi

    if ! command -v psql >/dev/null 2>&1; then
      echo "PostgreSQL psql is required for linked contract checks." >&2
      exit 127
    fi
    exec python3 "$script_dir/supabase-sql-target.py" linked "$sql_file"
    ;;
  *)
    echo "SUPABASE_DB_TARGET must be 'linked' or 'local'." >&2
    exit 2
    ;;
esac
