#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 5 ]]; then
  psql_bin="$1"
  connection_args=(
    --host="$2"
    --port="$3"
    --username="$4"
    --dbname="$5"
    --no-password
  )
elif [[ $# -eq 0 ]]; then
  psql_bin="$(command -v psql || true)"
  if [[ -z "$psql_bin" ]]; then
    echo "PostgreSQL psql is required for the Connect identity concurrency check." >&2
    exit 127
  fi
  db_url="$({ supabase status -o json 2>/dev/null || true; } | python3 -c '
import json
import sys

try:
    value = json.load(sys.stdin)["DB_URL"]
except (KeyError, TypeError, ValueError, json.JSONDecodeError):
    raise SystemExit(1)
if not isinstance(value, str) or not value.startswith(("postgres://", "postgresql://")):
    raise SystemExit(1)
print(value)
')" || {
    echo "Unable to resolve the local Supabase database URL." >&2
    exit 1
  }
  connection_args=("$db_url")
else
  echo "Usage: scripts/verify-connect-identity-concurrency.sh [psql host port user database]" >&2
  exit 2
fi

common_args=(
  "${connection_args[@]}"
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --set=actor=00000000-0000-4000-8000-000000009101
  --set=owner=00000000-0000-4000-8000-000000009102
  --set=studio=00000000-0000-4000-8000-000000009103
)

cleanup_fixture() {
  "$psql_bin" "${common_args[@]}" --quiet >/dev/null 2>&1 <<'SQL' || true
DELETE FROM public.stripe_connect_account_dispositions
 WHERE stripe_connected_account_id IN ('acct_ConcurrentMappingFirst1', 'acct_ConcurrentExclusionFirst1');
DELETE FROM public.studio_payment_accounts WHERE studio_id = :'studio';
DELETE FROM public.studios WHERE id = :'studio';
DELETE FROM auth.users WHERE id IN (:'actor', :'owner');
DELETE FROM private.stripe_connect_account_identity_guards
 WHERE stripe_connected_account_id IN ('acct_ConcurrentMappingFirst1', 'acct_ConcurrentExclusionFirst1');
SQL
}
trap cleanup_fixture EXIT HUP INT TERM

"$psql_bin" "${common_args[@]}" --quiet <<'SQL'
INSERT INTO auth.users (
    id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
    (:'actor', 'authenticated', 'authenticated', 'guard-actor@example.invalid', '{}', '{}', now(), now()),
    (:'owner', 'authenticated', 'authenticated', 'guard-owner@example.invalid', '{}', '{}', now(), now());
INSERT INTO public.studios(id, name, slug, owner_id)
VALUES (:'studio', 'Concurrent Guard Contract', 'concurrent-guard-contract', :'owner');
INSERT INTO public.studio_payment_accounts(studio_id) VALUES (:'studio');
SQL

wait_for_transaction_marker() {
  local lock_id="$1"
  local held="f"
  local attempt
  for attempt in {1..80}; do
    held="$(
      "$psql_bin" "${common_args[@]}" --tuples-only --no-align --quiet \
        --command="SELECT NOT pg_try_advisory_lock($lock_id);"
    )"
    if [[ "$held" == "t" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Concurrent guard transaction did not reach its serialized state." >&2
  return 1
}

"$psql_bin" "${common_args[@]}" --quiet >/dev/null 2>&1 <<'SQL' &
BEGIN;
UPDATE public.studio_payment_accounts
   SET stripe_connected_account_id = 'acct_ConcurrentMappingFirst1'
 WHERE studio_id = :'studio';
SELECT pg_advisory_xact_lock(910090001);
SELECT pg_sleep(1);
COMMIT;
SQL
mapping_pid=$!
wait_for_transaction_marker 910090001

if "$psql_bin" "${common_args[@]}" --quiet >/dev/null 2>&1 <<'SQL'
INSERT INTO public.stripe_connect_account_dispositions (
    stripe_connected_account_id, excluded, reason, actor_id
) VALUES (
    'acct_ConcurrentMappingFirst1', true, 'Concurrent opposite-direction check', :'actor'
);
SQL
then
  echo "Concurrent exclusion succeeded after a mapping acquired the identity guard." >&2
  exit 1
fi
wait "$mapping_pid"

"$psql_bin" "${common_args[@]}" --quiet <<'SQL'
UPDATE public.studio_payment_accounts
   SET stripe_connected_account_id = NULL
 WHERE studio_id = :'studio';
SQL

"$psql_bin" "${common_args[@]}" --quiet >/dev/null 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.stripe_connect_account_dispositions (
    stripe_connected_account_id, excluded, reason, actor_id
) VALUES (
    'acct_ConcurrentExclusionFirst1', true, 'Concurrent opposite-direction check', :'actor'
);
SELECT pg_advisory_xact_lock(910090002);
SELECT pg_sleep(1);
COMMIT;
SQL
exclusion_pid=$!
wait_for_transaction_marker 910090002

if "$psql_bin" "${common_args[@]}" --quiet >/dev/null 2>&1 <<'SQL'
UPDATE public.studio_payment_accounts
   SET stripe_connected_account_id = 'acct_ConcurrentExclusionFirst1'
 WHERE studio_id = :'studio';
SQL
then
  echo "Concurrent mapping succeeded after an exclusion acquired the identity guard." >&2
  exit 1
fi
wait "$exclusion_pid"

state="$({
  "$psql_bin" "${common_args[@]}" --tuples-only --no-align --quiet <<'SQL'
SELECT
    count(*) FILTER (
        WHERE stripe_connected_account_id = 'acct_ConcurrentMappingFirst1'
          AND mapped_studio_id IS NULL
          AND NOT excluded
    )::TEXT || ':' ||
    count(*) FILTER (
        WHERE stripe_connected_account_id = 'acct_ConcurrentExclusionFirst1'
          AND mapped_studio_id IS NULL
          AND excluded
    )::TEXT
  FROM private.stripe_connect_account_identity_guards;
SQL
})"

if [[ "$state" != "1:1" ]]; then
  echo "Concurrent Connect identity guard final state was not exact." >&2
  exit 1
fi

echo "PASS: concurrent mapping/exclusion writes serialized in both directions."
