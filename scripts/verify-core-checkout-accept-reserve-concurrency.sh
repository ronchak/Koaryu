#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-core-checkout-accept-reserve-concurrency.sh <psql> <socket-dir> <port>" >&2
  exit 2
fi

PSQL_BINARY="$1"
SOCKET_DIR="$2"
DB_PORT="$3"
OWNER_ID="00000000-0000-4000-8000-000000009301"
STUDIO_ID="00000000-0000-4000-8000-000000009302"
TOKEN="00000000-0000-4000-8000-000000009303"
MARKER_PATH="$(mktemp /tmp/koaryu-checkout-accept.XXXXXX)"
ACCEPT_LOG="$(mktemp /tmp/koaryu-checkout-accept-log.XXXXXX)"
COMP_MARKER_PATH="$(mktemp /tmp/koaryu-checkout-comp.XXXXXX)"
COMP_LOG="$(mktemp /tmp/koaryu-checkout-comp-log.XXXXXX)"
rm -f "$MARKER_PATH"
rm -f "$COMP_MARKER_PATH"

psql_args=(
  --host="$SOCKET_DIR"
  --port="$DB_PORT"
  --username=postgres
  --dbname=postgres
  --no-password
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --quiet
)

accept_pid=""
comp_pid=""
cleanup() {
  if [[ -n "$accept_pid" ]] && kill -0 "$accept_pid" 2>/dev/null; then
    kill "$accept_pid" 2>/dev/null || true
    wait "$accept_pid" 2>/dev/null || true
  fi
  if [[ -n "$comp_pid" ]] && kill -0 "$comp_pid" 2>/dev/null; then
    kill "$comp_pid" 2>/dev/null || true
    wait "$comp_pid" 2>/dev/null || true
  fi
  "$PSQL_BINARY" "${psql_args[@]}" >/dev/null 2>&1 <<SQL || true
DELETE FROM public.studio_subscriptions WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.studios WHERE id = '$STUDIO_ID'::uuid;
DELETE FROM auth.users WHERE id = '$OWNER_ID'::uuid;
SQL
  rm -f "$MARKER_PATH" "$ACCEPT_LOG" "$COMP_MARKER_PATH" "$COMP_LOG"
}
trap cleanup EXIT

"$PSQL_BINARY" "${psql_args[@]}" <<SQL
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '$OWNER_ID'::uuid, 'authenticated', 'authenticated',
  'checkout-accept-race@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()
);
INSERT INTO public.studios (id, name, slug, owner_id)
VALUES ('$STUDIO_ID'::uuid, 'Checkout Accept Race', 'checkout-accept-race', '$OWNER_ID'::uuid);
INSERT INTO public.studio_subscriptions (
  studio_id, status, comped, stripe_customer_id, metadata
) VALUES (
  '$STUDIO_ID'::uuid,
  'incomplete',
  false,
  'cus_concurrency',
  jsonb_build_object(
    'core_checkout_epoch', 1,
    'core_checkout_session', jsonb_build_object(
      'state', 'published',
      'token', '$TOKEN',
      'epoch', 1,
      'id', 'cs_concurrency',
      'url', 'https://checkout.stripe.example/concurrency',
      'expires_at', 4102444800
    )
  )
);
SQL

# Hold the subscription row after acceptance commits its logical transition but
# before the transaction commits. The second session must wait, then observe
# `completed` and return active without deleting the binding or opening a trial.
"$PSQL_BINARY" "${psql_args[@]}" >"$ACCEPT_LOG" 2>&1 <<SQL &
BEGIN;
SELECT public.accept_core_checkout_subscription_atomic(
  '$STUDIO_ID'::uuid,
  '$TOKEN'::uuid,
  1,
  'cs_concurrency',
  'sub_concurrency',
  100
);
\! touch "$MARKER_PATH"
SELECT pg_sleep(2);
COMMIT;
SQL
accept_pid="$!"

for _ in {1..100}; do
  if [[ -f "$MARKER_PATH" ]]; then
    break
  fi
  if ! kill -0 "$accept_pid" 2>/dev/null; then
    wait "$accept_pid" || true
    echo "FAIL: checkout acceptance exited before the synchronization point" >&2
    sed -n '1,120p' "$ACCEPT_LOG" >&2
    exit 1
  fi
  sleep 0.05
done

if [[ ! -f "$MARKER_PATH" ]]; then
  echo "FAIL: checkout acceptance did not reach the synchronization point" >&2
  exit 1
fi

reserve_outcome="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SET statement_timeout = '6s';
SELECT outcome
FROM public.reserve_core_checkout_v2_atomic('$STUDIO_ID'::uuid);
SQL
)"

if ! wait "$accept_pid"; then
  accept_pid=""
  echo "FAIL: checkout acceptance failed while reservation was waiting" >&2
  sed -n '1,120p' "$ACCEPT_LOG" >&2
  exit 1
fi
accept_pid=""

if [[ "$reserve_outcome" != "SET
active" && "$reserve_outcome" != "active" ]]; then
  echo "FAIL: reservation did not observe accepted checkout as terminal: $reserve_outcome" >&2
  exit 1
fi

binding_state="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SELECT (metadata->'core_checkout_session'->>'state') || ':' ||
       (metadata->'core_checkout_session'->>'accepted_subscription_id') || ':' ||
       (metadata->>'core_trial_consumed')
FROM public.studio_subscriptions
WHERE studio_id = '$STUDIO_ID'::uuid;
SQL
)"
if [[ "$binding_state" != "completed:sub_concurrency:true" ]]; then
  echo "FAIL: concurrent reservation changed the accepted binding: $binding_state" >&2
  exit 1
fi

"$PSQL_BINARY" "${psql_args[@]}" >/dev/null <<SQL
UPDATE public.studio_subscriptions
SET stripe_subscription_id = 'sub_concurrency', status = 'canceled'
WHERE studio_id = '$STUDIO_ID'::uuid;
SQL

terminal_state="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
WITH reservation AS (
  SELECT * FROM public.reserve_core_checkout_v2_atomic('$STUDIO_ID'::uuid)
)
SELECT reservation.outcome || ':' ||
       COALESCE(reservation.trial_period_days::TEXT, 'none') || ':' ||
       public.accept_core_checkout_subscription_atomic(
         '$STUDIO_ID'::uuid,
         '$TOKEN'::uuid,
         1,
         'cs_concurrency',
         'sub_concurrency',
         100
       ) || ':' ||
       (subscription.metadata->'core_checkout_acceptances'->'sub_concurrency'
          ->>'accepted_subscription_id')
FROM reservation
CROSS JOIN public.studio_subscriptions subscription
WHERE subscription.studio_id = '$STUDIO_ID'::uuid;
SQL
)"
if [[ "$terminal_state" != "reserved:none:already_accepted:sub_concurrency" ]]; then
  echo "FAIL: terminal checkout did not retain append-only replay proof: $terminal_state" >&2
  exit 1
fi

# Accept-first: while the row still projects an older terminal subscription,
# a newly accepted subscription must make the waiting comp grant fail closed.
rm -f "$MARKER_PATH"
"$PSQL_BINARY" "${psql_args[@]}" >/dev/null <<SQL
UPDATE public.studio_subscriptions
SET stripe_subscription_id = 'sub_old', status = 'canceled', comped = false,
    metadata = jsonb_build_object(
      'core_trial_consumed', true,
      'core_checkout_epoch', 2,
      'core_checkout_session', jsonb_build_object(
        'state', 'published', 'token', '$TOKEN', 'epoch', 2,
        'id', 'cs_accept_first', 'url', 'https://checkout.stripe.example/accept-first',
        'expires_at', 4102444800
      )
    )
WHERE studio_id = '$STUDIO_ID'::uuid;
SQL
"$PSQL_BINARY" "${psql_args[@]}" >"$ACCEPT_LOG" 2>&1 <<SQL &
BEGIN;
SELECT public.accept_core_checkout_subscription_atomic(
  '$STUDIO_ID'::uuid, '$TOKEN'::uuid, 2, 'cs_accept_first', 'sub_new', 200
);
\! touch "$MARKER_PATH"
SELECT pg_sleep(2);
COMMIT;
SQL
accept_pid="$!"
for _ in {1..100}; do
  [[ -f "$MARKER_PATH" ]] && break
  sleep 0.05
done
if [[ ! -f "$MARKER_PATH" ]]; then
  echo "FAIL: accept-first session did not reach the synchronization point" >&2
  exit 1
fi
set +e
accept_first_comp_output="$("$PSQL_BINARY" "${psql_args[@]}" 2>&1 <<SQL
SET statement_timeout = '6s';
UPDATE public.studio_subscriptions SET comped = true
WHERE studio_id = '$STUDIO_ID'::uuid;
SQL
)"
accept_first_comp_status=$?
set -e
if ! wait "$accept_pid"; then
  accept_pid=""
  echo "FAIL: accept-first transaction failed" >&2
  sed -n '1,120p' "$ACCEPT_LOG" >&2
  exit 1
fi
accept_pid=""
if [[ $accept_first_comp_status -eq 0 ]] || [[ "$accept_first_comp_output" != *"reconcile the subscription"* ]]; then
  echo "FAIL: comp grant crossed an accepted but unprojected subscription" >&2
  echo "$accept_first_comp_output" >&2
  exit 1
fi

# Comp-first: once the operator comp owns and commits the row, a waiting
# checkout acceptance must return invalid so either webhook family cancels it.
rm -f "$COMP_MARKER_PATH"
"$PSQL_BINARY" "${psql_args[@]}" >/dev/null <<SQL
UPDATE public.studio_subscriptions
SET stripe_subscription_id = 'sub_old', status = 'canceled', comped = false,
    metadata = jsonb_build_object(
      'core_trial_consumed', true,
      'core_checkout_epoch', 3,
      'core_checkout_session', jsonb_build_object(
        'state', 'published', 'token', '$TOKEN', 'epoch', 3,
        'id', 'cs_comp_first', 'url', 'https://checkout.stripe.example/comp-first',
        'expires_at', 4102444800
      )
    )
WHERE studio_id = '$STUDIO_ID'::uuid;
SQL
"$PSQL_BINARY" "${psql_args[@]}" >"$COMP_LOG" 2>&1 <<SQL &
BEGIN;
UPDATE public.studio_subscriptions SET comped = true
WHERE studio_id = '$STUDIO_ID'::uuid;
\! touch "$COMP_MARKER_PATH"
SELECT pg_sleep(2);
COMMIT;
SQL
comp_pid="$!"
for _ in {1..100}; do
  [[ -f "$COMP_MARKER_PATH" ]] && break
  sleep 0.05
done
if [[ ! -f "$COMP_MARKER_PATH" ]]; then
  echo "FAIL: comp-first session did not reach the synchronization point" >&2
  exit 1
fi
comp_first_acceptance="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SET statement_timeout = '6s';
SELECT public.accept_core_checkout_subscription_atomic(
  '$STUDIO_ID'::uuid, '$TOKEN'::uuid, 3, 'cs_comp_first', 'sub_newer', 300
);
SQL
)"
if ! wait "$comp_pid"; then
  comp_pid=""
  echo "FAIL: comp-first transaction failed" >&2
  sed -n '1,120p' "$COMP_LOG" >&2
  exit 1
fi
comp_pid=""
if [[ "$comp_first_acceptance" != "SET
invalid" && "$comp_first_acceptance" != "invalid" ]]; then
  echo "FAIL: comp-first acceptance did not fail closed: $comp_first_acceptance" >&2
  exit 1
fi

echo "PASS: checkout reservation, acceptance, and comp grants serialize in both lock orders."
