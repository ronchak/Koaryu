#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_SQL_FILE="$ROOT_DIR/supabase/verification/account_support_controls.sql"
BELT_SYNC_SQL_FILE="$ROOT_DIR/supabase/verification/belt_ladder_sync_smoke.sql"
SUPPORT_TRIAGE_SQL_FILE="$ROOT_DIR/supabase/verification/support_triage_smoke.sql"
SUPABASE_DB_TARGET="${SUPABASE_DB_TARGET:-local}"
SQL_RUNNER="$ROOT_DIR/scripts/run-supabase-sql.sh"

"$SQL_RUNNER" "$CONTRACT_SQL_FILE"
"$SQL_RUNNER" "$BELT_SYNC_SQL_FILE"
"$SQL_RUNNER" "$SUPPORT_TRIAGE_SQL_FILE"
