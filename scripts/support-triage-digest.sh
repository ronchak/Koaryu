#!/usr/bin/env bash
set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo '{"ok":false,"error":"Supabase CLI is required for support triage digest."}'
  exit 0
fi

supabase db query --linked "SELECT public.support_triage_digest(50) AS digest;"
