#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT_SQL_FILE="$ROOT_DIR/supabase/verification/account_support_controls.sql"
BELT_SYNC_SQL_FILE="$ROOT_DIR/supabase/verification/belt_ladder_sync_smoke.sql"

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is required to run this check." >&2
  exit 127
fi

supabase db query --linked "$(cat "$CONTRACT_SQL_FILE")"
supabase db query --linked "$(cat "$BELT_SYNC_SQL_FILE")"
