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
rm -f "$MARKER_PATH"

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
cleanup() {
  if [[ -n "$accept_pid" ]] && kill -0 "$accept_pid" 2>/dev/null; then
    kill "$accept_pid" 2>/dev/null || true
    wait "$accept_pid" 2>/dev/null || true
  fi
  "$PSQL_BINARY" "${psql_args[@]}" >/dev/null 2>&1 <<SQL || true
DELETE FROM public.studio_subscriptions WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.studios WHERE id = '$STUDIO_ID'::uuid;
DELETE FROM auth.users WHERE id = '$OWNER_ID'::uuid;
SQL
  rm -f "$MARKER_PATH" "$ACCEPT_LOG"
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
FROM public.reserve_core_checkout_atomic('$STUDIO_ID'::uuid);
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
  SELECT * FROM public.reserve_core_checkout_atomic('$STUDIO_ID'::uuid)
)
SELECT reservation.outcome || ':' ||
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
if [[ "$terminal_state" != "reserved:already_accepted:sub_concurrency" ]]; then
  echo "FAIL: terminal checkout did not retain append-only replay proof: $terminal_state" >&2
  exit 1
fi

echo "PASS: accepted checkout blocks concurrent reservation and remains replayable after a later epoch."
