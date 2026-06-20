#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_SQL_FILE="$ROOT_DIR/supabase/verification/account_support_controls.sql"
BELT_SYNC_SQL_FILE="$ROOT_DIR/supabase/verification/belt_ladder_sync_smoke.sql"
SUPPORT_TRIAGE_SQL_FILE="$ROOT_DIR/supabase/verification/support_triage_smoke.sql"
SUPABASE_DB_TARGET="${SUPABASE_DB_TARGET:-local}"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required to run this check." >&2
  exit 127
fi

case "$SUPABASE_DB_TARGET" in
  linked)
    db_target_flag="--linked"
    ;;
  local)
    db_target_flag="--local"
    ;;
  *)
    echo "SUPABASE_DB_TARGET must be 'linked' or 'local'." >&2
    exit 2
    ;;
esac

supabase db query "$db_target_flag" --file "$CONTRACT_SQL_FILE"
supabase db query "$db_target_flag" --file "$BELT_SYNC_SQL_FILE"
supabase db query "$db_target_flag" --file "$SUPPORT_TRIAGE_SQL_FILE"
