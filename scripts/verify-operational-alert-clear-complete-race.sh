#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-operational-alert-clear-complete-race.sh <psql> <socket-dir> <port>" >&2
  exit 2
fi

PSQL_BINARY="$1"
SOCKET_DIR="$2"
DB_PORT="$3"
RACE_ENVIRONMENT="activation-concurrency-contract"
RACE_LEASE_TOKEN="activation-concurrency-lease"
RACE_ATTEMPT_ID="89a32f7d-e43d-4c12-9f65-8c13ce1fe7b4"
RACE_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
MARKER_PATH="$(mktemp /tmp/koaryu-alert-complete.XXXXXX)"
SESSION_LOG="$(mktemp /tmp/koaryu-alert-complete-log.XXXXXX)"
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

completion_pid=""
cleanup() {
  if [[ -n "$completion_pid" ]] && kill -0 "$completion_pid" 2>/dev/null; then
    kill "$completion_pid" 2>/dev/null || true
    wait "$completion_pid" 2>/dev/null || true
  fi
  rm -f "$MARKER_PATH" "$SESSION_LOG"
}
trap cleanup EXIT

"$PSQL_BINARY" "${psql_args[@]}" <<SQL
SELECT * FROM public.evaluate_operational_alert(
  '$RACE_ENVIRONMENT', 'support-urgent-untriaged', 1, 1, 30,
  'primary-owner', 'backup-owner', 60, 'high', '$RACE_SHA',
  'concurrency-contract'
);
SQL

attempt_id="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SELECT attempt_id
  FROM public.claim_operational_alert_delivery(
    '$RACE_ENVIRONMENT', '$RACE_LEASE_TOKEN', '$RACE_ATTEMPT_ID'::uuid, 300
  );
SQL
)"

if [[ ! "$attempt_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "FAIL: concurrency contract could not claim the trigger delivery" >&2
  exit 1
fi

# Session one completes the delivery but deliberately holds its transaction
# open. The completion function must retain the episode row lock until COMMIT.
"$PSQL_BINARY" "${psql_args[@]}" >"$SESSION_LOG" 2>&1 <<SQL &
BEGIN;
SELECT public.complete_operational_alert_delivery(
  '$attempt_id'::uuid, '$RACE_LEASE_TOKEN', 'concurrency-trigger-receipt'
) AS complete_ok \gset
\if :complete_ok
\else
  \quit 1
\endif
\! touch "$MARKER_PATH"
SELECT pg_sleep(3);
COMMIT;
SQL
completion_pid="$!"

for _ in {1..100}; do
  if [[ -f "$MARKER_PATH" ]]; then
    break
  fi
  if ! kill -0 "$completion_pid" 2>/dev/null; then
    wait "$completion_pid" || true
    echo "FAIL: completion session exited before reaching the synchronization point" >&2
    sed -n '1,120p' "$SESSION_LOG" >&2
    exit 1
  fi
  sleep 0.05
done

if [[ ! -f "$MARKER_PATH" ]]; then
  echo "FAIL: completion session did not reach the synchronization point" >&2
  exit 1
fi

# Session two must block on the episode lock. Before the fix it clears the
# episode immediately, sees only the leased delivery, and permanently misses
# the resolution enqueue.
set +e
clear_output="$("$PSQL_BINARY" "${psql_args[@]}" 2>&1 <<SQL
SET statement_timeout = '750ms';
SELECT * FROM public.evaluate_operational_alert(
  '$RACE_ENVIRONMENT', 'support-urgent-untriaged', 0, 1, 30,
  'primary-owner', 'backup-owner', 60, 'high', '$RACE_SHA',
  'concurrency-contract'
);
SQL
)"
clear_status=$?
set -e

if [[ $clear_status -eq 0 ]]; then
  echo "FAIL: clear did not serialize behind receipt completion" >&2
  exit 1
fi
if [[ "$clear_output" != *"canceling statement due to statement timeout"* ]]; then
  echo "FAIL: clear failed for an unexpected reason" >&2
  echo "$clear_output" >&2
  exit 1
fi

wait "$completion_pid"
completion_pid=""

"$PSQL_BINARY" "${psql_args[@]}" <<SQL
SELECT * FROM public.evaluate_operational_alert(
  '$RACE_ENVIRONMENT', 'support-urgent-untriaged', 0, 1, 30,
  'primary-owner', 'backup-owner', 60, 'high', '$RACE_SHA',
  'concurrency-contract'
);

DO \$\$
BEGIN
  IF (
    SELECT COUNT(*)
      FROM public.operational_alert_outbox outbox
      JOIN public.operational_alert_episodes episode ON episode.id = outbox.episode_id
     WHERE episode.environment = '$RACE_ENVIRONMENT'
       AND outbox.event_kind = 'resolved'
       AND outbox.destination_role = 'primary'
       AND outbox.status = 'pending'
  ) <> 1 THEN
    RAISE EXCEPTION 'Serialized clear must queue exactly one primary resolution.';
  END IF;
END
\$\$;
SQL

echo "PASS: concurrent clear serialized behind receipt completion and queued one resolution."
