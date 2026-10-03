#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 3 ]]; then
  psql_bin="$1"
  connection_args=(
    --host="$2"
    --port="$3"
    --username=postgres
    --dbname=postgres
    --no-password
  )
elif [[ $# -eq 0 ]]; then
  psql_bin="$(command -v psql || true)"
  if [[ -z "$psql_bin" ]]; then
    echo "PostgreSQL psql is required for the billing payment identity concurrency check." >&2
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
  echo "Usage: scripts/verify-billing-payment-identity-concurrency.sh [psql host port]" >&2
  exit 2
fi

owner_id="00000000-0000-4000-8000-000000009601"
studio_id="00000000-0000-4000-8000-000000009602"
payer_id="00000000-0000-4000-8000-000000009603"
parent_first_payment_id="00000000-0000-4000-8000-000000009604"
child_first_payment_id="00000000-0000-4000-8000-000000009605"
child_first_refund_id="00000000-0000-4000-8000-000000009606"
parent_log="$(mktemp /tmp/koaryu-payment-parent-lock.XXXXXX)"
child_log="$(mktemp /tmp/koaryu-payment-child-lock.XXXXXX)"
parent_pid=""
child_pid=""

psql_args=(
  "${connection_args[@]}"
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --quiet
)

cleanup() {
  if [[ -n "$parent_pid" ]] && kill -0 "$parent_pid" 2>/dev/null; then
    kill "$parent_pid" 2>/dev/null || true
    wait "$parent_pid" 2>/dev/null || true
  fi
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  "$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL || true
DELETE FROM public.studios WHERE id = '$studio_id'::UUID;
DELETE FROM auth.users WHERE id = '$owner_id'::UUID;
SQL
  rm -f "$parent_log" "$child_log"
}
trap cleanup EXIT HUP INT TERM

wait_for_transaction_marker() {
  local lock_id="$1"
  local held="f"
  local attempt
  for attempt in {1..80}; do
    held="$(
      "$psql_bin" "${psql_args[@]}" --tuples-only --no-align \
        --command="SELECT NOT pg_try_advisory_lock($lock_id);"
    )"
    if [[ "$held" == "t" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Billing identity transaction did not reach its lock marker." >&2
  return 1
}

"$psql_bin" "${psql_args[@]}" <<SQL
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '$owner_id'::UUID,
  'authenticated',
  'authenticated',
  'billing-identity-concurrency@example.invalid',
  '{}'::JSONB,
  '{}'::JSONB,
  now(),
  now()
);
INSERT INTO public.studios (id, name, slug, owner_id)
VALUES (
  '$studio_id'::UUID,
  'Billing Identity Concurrency Contract',
  'billing-identity-concurrency-contract',
  '$owner_id'::UUID
);
INSERT INTO public.billing_payers (id, studio_id, display_name)
VALUES ('$payer_id'::UUID, '$studio_id'::UUID, 'Concurrency Payer');
INSERT INTO public.billing_payments (
  id, studio_id, payer_id, status, amount_cents, currency,
  net_collected_amount_cents, refundable_amount_cents
) VALUES
  ('$parent_first_payment_id'::UUID, '$studio_id'::UUID, '$payer_id'::UUID, 'pending', 100, 'usd', 0, 0),
  ('$child_first_payment_id'::UUID, '$studio_id'::UUID, '$payer_id'::UUID, 'pending', 100, 'usd', 0, 0);
SQL

"$psql_bin" "${psql_args[@]}" >"$parent_log" 2>&1 <<SQL &
BEGIN;
UPDATE public.billing_payments
SET stripe_account_id = 'acct_ParentFirstIdentity',
    connect_account_generation = 1,
    stripe_payment_intent_id = 'pi_ParentFirstIdentity',
    stripe_charge_id = 'ch_ParentFirstIdentity'
WHERE id = '$parent_first_payment_id'::UUID;
SELECT pg_advisory_xact_lock(960100001);
SELECT pg_sleep(1);
COMMIT;
SQL
parent_pid="$!"
wait_for_transaction_marker 960100001

if "$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL
SET statement_timeout = '6s';
INSERT INTO public.billing_refunds (
  studio_id, payment_id, stripe_refund_id, amount_cents, status
) VALUES (
  '$studio_id'::UUID,
  '$parent_first_payment_id'::UUID,
  're_ParentFirstIdentity',
  0,
  'pending'
);
SQL
then
  echo "Child identity insert committed against a concurrently enriched parent." >&2
  exit 1
fi

if ! wait "$parent_pid"; then
  parent_pid=""
  echo "Parent-first identity update failed unexpectedly." >&2
  sed -n '1,120p' "$parent_log" >&2
  exit 1
fi
parent_pid=""

"$psql_bin" "${psql_args[@]}" >"$child_log" 2>&1 <<SQL &
BEGIN;
INSERT INTO public.billing_refunds (
  id, studio_id, payment_id, stripe_refund_id, amount_cents, status
) VALUES (
  '$child_first_refund_id'::UUID,
  '$studio_id'::UUID,
  '$child_first_payment_id'::UUID,
  're_ChildFirstIdentity',
  0,
  'pending'
);
SELECT pg_advisory_xact_lock(960100002);
SELECT pg_sleep(1);
COMMIT;
SQL
child_pid="$!"
wait_for_transaction_marker 960100002

if "$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL
SET statement_timeout = '6s';
UPDATE public.billing_payments
SET stripe_account_id = 'acct_ChildFirstIdentity',
    connect_account_generation = 1,
    stripe_payment_intent_id = 'pi_ChildFirstIdentity',
    stripe_charge_id = 'ch_ChildFirstIdentity'
WHERE id = '$child_first_payment_id'::UUID;
SQL
then
  echo "Parent identity enrichment committed against a concurrently linked child." >&2
  exit 1
fi

if ! wait "$child_pid"; then
  child_pid=""
  echo "Child-first identity insert failed unexpectedly." >&2
  sed -n '1,120p' "$child_log" >&2
  exit 1
fi
child_pid=""

final_state="$(
  "$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT
  count(*) FILTER (
    WHERE payment.id = '$parent_first_payment_id'::UUID
      AND payment.connect_account_generation = 1
      AND payment.stripe_charge_id = 'ch_ParentFirstIdentity'
  )::TEXT || ':' ||
  count(*) FILTER (
    WHERE payment.id = '$child_first_payment_id'::UUID
      AND payment.connect_account_generation IS NULL
      AND payment.stripe_charge_id IS NULL
      AND refund.id = '$child_first_refund_id'::UUID
  )::TEXT
FROM public.billing_payments AS payment
LEFT JOIN public.billing_refunds AS refund ON refund.payment_id = payment.id
WHERE payment.id IN (
  '$parent_first_payment_id'::UUID,
  '$child_first_payment_id'::UUID
);
"
)"
final_state="$(printf '%s' "$final_state" | tr -d '\r\n')"

if [[ "$final_state" != "1:1" ]]; then
  echo "Concurrent billing identity writes did not converge on the exact safe states: $final_state" >&2
  exit 1
fi

echo "PASS: billing payment parent/child identity writes serialized in both directions."
