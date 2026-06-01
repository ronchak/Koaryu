#!/usr/bin/env bash
set -euo pipefail

LIMIT=50
CONFIRMED=false

usage() {
  cat <<'USAGE'
Usage: scripts/support-triage-digest.sh --confirm-sanitized-linked-query [--limit N]

Calls the sanitized public.support_triage_digest(N) RPC against the linked
Supabase project. The confirmation flag is required because this reads private
support-ticket metadata from the currently linked project and prints it locally.

Options:
  --confirm-sanitized-linked-query  Confirm the linked project is intended.
  --limit N                         Number of digest entries to request (1-100, default 50).
  -h, --help                        Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm-sanitized-linked-query)
      CONFIRMED=true
      ;;
    --limit)
      shift
      if [ "$#" -eq 0 ]; then
        echo '{"ok":false,"error":"--limit requires a value."}' >&2
        exit 2
      fi
      LIMIT="$1"
      ;;
    --limit=*)
      LIMIT=${1#--limit=}
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo '{"ok":false,"error":"Unknown option."}' >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$LIMIT" in
  ''|*[!0-9]*)
    echo '{"ok":false,"error":"--limit must be an integer from 1 to 100."}' >&2
    exit 2
    ;;
esac

if [ "$LIMIT" -lt 1 ] || [ "$LIMIT" -gt 100 ]; then
  echo '{"ok":false,"error":"--limit must be an integer from 1 to 100."}' >&2
  exit 2
fi

if [ "$CONFIRMED" != true ]; then
  echo '{"ok":false,"error":"Refusing to query the linked Supabase project without --confirm-sanitized-linked-query."}' >&2
  exit 2
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo '{"ok":false,"error":"Supabase CLI is required for support triage digest."}'
  exit 0
fi

supabase db query --linked "SELECT public.support_triage_digest(${LIMIT}) AS digest;"
