#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 3 ]]; then
  PSQL_BINARY="$1"
  connection_args=(--host="$2" --port="$3" --username=postgres --dbname=postgres --no-password)
elif [[ $# -eq 0 ]]; then
  PSQL_BINARY="$(command -v psql || true)"
  if [[ -z "$PSQL_BINARY" ]]; then
    echo "PostgreSQL psql is required for the student bulk archive concurrency check." >&2
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
  echo "Usage: scripts/verify-student-bulk-archive-concurrency.sh [psql host port]" >&2
  exit 2
fi

STUDIO_ID="00000000-0000-4000-8000-000000009301"
ACTOR_ID="00000000-0000-4000-8000-000000009302"
SECOND_ACTOR_ID="00000000-0000-4000-8000-000000009305"
FIRST_STUDENT_ID="00000000-0000-4000-8000-000000009303"
SECOND_STUDENT_ID="00000000-0000-4000-8000-000000009304"
HARD_DELETE_LOCK=91009301
ORDER_LOCK=91009302
ARCHIVE_FIRST_LOCK=91009303
HARD_DELETE_MARKER="$(mktemp /tmp/koaryu-bulk-archive-hard-delete.XXXXXX)"
ORDER_MARKER="$(mktemp /tmp/koaryu-bulk-archive-order.XXXXXX)"
HARD_DELETE_LOG="$(mktemp /tmp/koaryu-bulk-archive-hard-delete-log.XXXXXX)"
HOLDER_LOG="$(mktemp /tmp/koaryu-bulk-archive-holder-log.XXXXXX)"
FIRST_RETRY_LOG="$(mktemp /tmp/koaryu-bulk-archive-retry-a.XXXXXX)"
SECOND_RETRY_LOG="$(mktemp /tmp/koaryu-bulk-archive-retry-b.XXXXXX)"
rm -f "$HARD_DELETE_MARKER" "$ORDER_MARKER"

psql_args=("${connection_args[@]}" --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
hard_delete_pid=""
archive_first_pid=""
holder_pid=""
first_retry_pid=""
second_retry_pid=""

cleanup() {
  if [[ -n "$hard_delete_pid" ]] && kill -0 "$hard_delete_pid" 2>/dev/null; then
    kill "$hard_delete_pid" 2>/dev/null || true
    wait "$hard_delete_pid" 2>/dev/null || true
  fi
  if [[ -n "$first_retry_pid" ]] && kill -0 "$first_retry_pid" 2>/dev/null; then
    kill "$first_retry_pid" 2>/dev/null || true
    wait "$first_retry_pid" 2>/dev/null || true
  fi
  if [[ -n "$archive_first_pid" ]] && kill -0 "$archive_first_pid" 2>/dev/null; then
    kill "$archive_first_pid" 2>/dev/null || true
    wait "$archive_first_pid" 2>/dev/null || true
  fi
  if [[ -n "$holder_pid" ]] && kill -0 "$holder_pid" 2>/dev/null; then
    kill "$holder_pid" 2>/dev/null || true
    wait "$holder_pid" 2>/dev/null || true
  fi
  if [[ -n "$second_retry_pid" ]] && kill -0 "$second_retry_pid" 2>/dev/null; then
    kill "$second_retry_pid" 2>/dev/null || true
    wait "$second_retry_pid" 2>/dev/null || true
  fi
  "$PSQL_BINARY" "${psql_args[@]}" >/dev/null 2>&1 <<SQL || true
DROP TRIGGER IF EXISTS koaryu_bulk_archive_pause_audit ON public.audit_logs;
DROP FUNCTION IF EXISTS public.koaryu_bulk_archive_pause_audit();
DELETE FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.students WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.staff_roles WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.studios WHERE id = '$STUDIO_ID'::uuid;
DELETE FROM auth.users WHERE id IN ('$ACTOR_ID'::uuid, '$SECOND_ACTOR_ID'::uuid);
SQL
  rm -f "$HARD_DELETE_MARKER" "$ORDER_MARKER" "$HARD_DELETE_LOG" "$HOLDER_LOG" "$FIRST_RETRY_LOG" "$SECOND_RETRY_LOG"
}
trap cleanup EXIT HUP INT TERM

wait_for_transaction_marker() {
  local lock_id="$1"
  local marker_path="$2"
  for _ in {1..120}; do
    if [[ -f "$marker_path" ]]; then
      return 0
    fi
    if [[ -n "$hard_delete_pid" ]] && ! kill -0 "$hard_delete_pid" 2>/dev/null; then
      wait "$hard_delete_pid" || true
      echo "FAIL: concurrent session exited before its synchronization point." >&2
      return 1
    fi
    if [[ "$lock_id" -ne 0 ]]; then
      "$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align \
        --command="SELECT NOT pg_try_advisory_lock($lock_id);" | tr -d '[:space:]' | grep -qx t && {
          :
        }
    fi
    sleep 0.05
  done
  echo "FAIL: concurrent session did not reach its synchronization point." >&2
  return 1
}

"$PSQL_BINARY" "${psql_args[@]}" <<SQL
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '$ACTOR_ID'::uuid, 'authenticated', 'authenticated',
  'bulk-archive-concurrency@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()
), (
  '$SECOND_ACTOR_ID'::uuid, 'authenticated', 'authenticated',
  'bulk-archive-concurrency-second@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()
);
INSERT INTO public.studios (id, name, slug, owner_id)
VALUES ('$STUDIO_ID'::uuid, 'Bulk Archive Concurrency', 'bulk-archive-concurrency', '$ACTOR_ID'::uuid);
INSERT INTO public.staff_roles (studio_id, user_id, role)
VALUES
  ('$STUDIO_ID'::uuid, '$ACTOR_ID'::uuid, 'admin'),
  ('$STUDIO_ID'::uuid, '$SECOND_ACTOR_ID'::uuid, 'front_desk');
INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, status)
VALUES
  ('$FIRST_STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'First', 'Concurrent', 'active'),
  ('$SECOND_STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'Second', 'Concurrent', 'active');
SQL

# The hard-delete session commits after the archive RPC has taken its initial
# existence snapshot but while the second target row is still locked. The RPC
# must re-count after its deterministic row locks and roll back the first row.
(
  "$PSQL_BINARY" "${psql_args[@]}" >"$HARD_DELETE_LOG" 2>&1 <<SQL
BEGIN;
DELETE FROM public.students WHERE id = '$SECOND_STUDENT_ID'::uuid;
SELECT pg_advisory_xact_lock($HARD_DELETE_LOCK);
\\! touch "$HARD_DELETE_MARKER"
SELECT pg_sleep(2);
COMMIT;
SQL
) &
hard_delete_pid=$!
wait_for_transaction_marker "$HARD_DELETE_LOCK" "$HARD_DELETE_MARKER"

set +e
hard_delete_result="$("$PSQL_BINARY" "${psql_args[@]}" 2>&1 <<SQL
\\set VERBOSITY verbose
SET statement_timeout = '8s';
SELECT public.archive_students_bulk_atomic(
  '$STUDIO_ID'::uuid,
  '$ACTOR_ID'::uuid,
  ARRAY['$FIRST_STUDENT_ID'::uuid, '$SECOND_STUDENT_ID'::uuid]
);
SQL
)"
hard_delete_status=$?
set -e
if [[ "$hard_delete_status" -eq 0 || "$hard_delete_result" != *"P0002"* ]]; then
  echo "FAIL: archive did not reject a target set that shrank during locking." >&2
  echo "$hard_delete_result" >&2
  exit 1
fi
if ! wait "$hard_delete_pid"; then
  echo "FAIL: hard-delete synchronization session failed." >&2
  sed -n '1,120p' "$HARD_DELETE_LOG" >&2
  exit 1
fi
hard_delete_pid=""

state="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SELECT
  (SELECT count(*) FROM public.students WHERE id = '$FIRST_STUDENT_ID'::uuid AND deleted_at IS NULL)::text || ':' ||
  (SELECT count(*) FROM public.students WHERE id = '$SECOND_STUDENT_ID'::uuid)::text || ':' ||
  (SELECT count(*) FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid AND action = 'student.deleted')::text;
SQL
)"
if [[ "$state" != "1:0:0" ]]; then
  echo "FAIL: hard-delete shrink was not all-or-nothing: $state" >&2
  exit 1
fi
echo "PASS: concurrent hard-delete shrink rolled back the partial archive."

# Reset the fixture, then prove the opposite race: an archive that already owns
# both student locks commits before a concurrent hard delete proceeds. The
# remaining row must be archived and retain its audit; the deleted row is gone.
"$PSQL_BINARY" "${psql_args[@]}" <<SQL
DELETE FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.students WHERE studio_id = '$STUDIO_ID'::uuid;
INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, status)
VALUES
  ('$FIRST_STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'First', 'Archive First', 'active'),
  ('$SECOND_STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'Second', 'Archive First', 'active');
SQL
"$PSQL_BINARY" "${psql_args[@]}" <<SQL
CREATE OR REPLACE FUNCTION public.koaryu_bulk_archive_pause_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS \$pause\$
BEGIN
  IF current_setting('koaryu.bulk_archive_pause', true) = 'on' THEN
    PERFORM pg_advisory_xact_lock($ARCHIVE_FIRST_LOCK);
    PERFORM pg_sleep(2);
  END IF;
  RETURN NEW;
END;
\$pause\$;
CREATE TRIGGER koaryu_bulk_archive_pause_audit
BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.koaryu_bulk_archive_pause_audit();
SQL
(
  "$PSQL_BINARY" "${psql_args[@]}" >"$HOLDER_LOG" 2>&1 <<SQL
SET koaryu.bulk_archive_pause = 'on';
SELECT public.archive_students_bulk_atomic(
  '$STUDIO_ID'::uuid, '$ACTOR_ID'::uuid,
  ARRAY['$FIRST_STUDENT_ID'::uuid, '$SECOND_STUDENT_ID'::uuid]
);
SQL
) &
archive_first_pid=$!
archive_marker=""
for _ in {1..120}; do
  archive_marker="$($PSQL_BINARY "${psql_args[@]}" --tuples-only --no-align --command="SELECT NOT pg_try_advisory_lock($ARCHIVE_FIRST_LOCK);" | tr -d '[:space:]')"
  [[ "$archive_marker" == "t" ]] && break
  sleep 0.05
done
if [[ "$archive_marker" != "t" ]]; then
  echo "FAIL: archive-first session did not hold its student locks at the audit barrier." >&2
  exit 1
fi
set +e
archive_first_delete_result="$($PSQL_BINARY "${psql_args[@]}" 2>&1 <<SQL
SET statement_timeout = '8s';
DELETE FROM public.students WHERE id = '$SECOND_STUDENT_ID'::uuid;
SQL
)"
archive_first_delete_status=$?
set -e
if [[ "$archive_first_delete_status" -ne 0 ]]; then
  echo "FAIL: concurrent hard delete failed after archive acquired its locks." >&2
  echo "$archive_first_delete_result" >&2
  exit 1
fi
if ! wait "$archive_first_pid"; then
  echo "FAIL: archive-first session failed." >&2
  sed -n '1,120p' "$HOLDER_LOG" >&2
  exit 1
fi
archive_first_pid=""
if ! grep -Eq '^[[:space:]]*2[[:space:]]*$' "$HOLDER_LOG"; then
  echo "FAIL: archive-first RPC did not return updated=2." >&2
  sed -n '1,120p' "$HOLDER_LOG" >&2
  exit 1
fi
"$PSQL_BINARY" "${psql_args[@]}" <<SQL
DROP TRIGGER koaryu_bulk_archive_pause_audit ON public.audit_logs;
DROP FUNCTION public.koaryu_bulk_archive_pause_audit();
SQL
state="$($PSQL_BINARY "${psql_args[@]}" --tuples-only --no-align <<SQL
SELECT
  (SELECT count(*) FROM public.students WHERE id = '$FIRST_STUDENT_ID'::uuid AND deleted_at IS NOT NULL)::text || ':' ||
  (SELECT count(*) FROM public.students WHERE id = '$SECOND_STUDENT_ID'::uuid)::text || ':' ||
  (SELECT count(*) FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid AND action = 'student.deleted')::text;
SQL
)"
if [[ "$state" != "1:0:2" ]]; then
  echo "FAIL: archive-first race did not preserve the committed archive state: $state" >&2
  exit 1
fi
echo "PASS: archive-first commit serialized before the concurrent hard delete."

# Recreate the two-row target and hold both rows in sorted order. Two retries
# with opposite input order and independent managers then queue behind that
# same deterministic lock set; one archives both rows and the other is an
# idempotent zero-row retry.
"$PSQL_BINARY" "${psql_args[@]}" <<SQL
DELETE FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.students WHERE studio_id = '$STUDIO_ID'::uuid;
INSERT INTO public.students (id, studio_id, legal_first_name, legal_last_name, status)
VALUES
  ('$FIRST_STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'First', 'Retry', 'active'),
  ('$SECOND_STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'Second', 'Retry', 'active');
SQL
(
  "$PSQL_BINARY" "${psql_args[@]}" >"$HOLDER_LOG" 2>&1 <<SQL
BEGIN;
SELECT id FROM public.students
 WHERE studio_id = '$STUDIO_ID'::uuid
   AND id IN ('$FIRST_STUDENT_ID'::uuid, '$SECOND_STUDENT_ID'::uuid)
 ORDER BY id FOR UPDATE;
SELECT pg_advisory_xact_lock($ORDER_LOCK);
\\! touch "$ORDER_MARKER"
SELECT pg_sleep(2);
COMMIT;
SQL
) &
holder_pid=$!
for _ in {1..120}; do
  [[ -f "$ORDER_MARKER" ]] && break
  sleep 0.05
done
if [[ ! -f "$ORDER_MARKER" ]]; then
  echo "FAIL: sorted lock holder did not reach its synchronization point." >&2
  exit 1
fi
(
  "$PSQL_BINARY" "${psql_args[@]}" >"$FIRST_RETRY_LOG" 2>&1 <<SQL
SET statement_timeout = '8s';
SELECT public.archive_students_bulk_atomic(
  '$STUDIO_ID'::uuid, '$ACTOR_ID'::uuid,
  ARRAY['$SECOND_STUDENT_ID'::uuid, '$FIRST_STUDENT_ID'::uuid]
);
SQL
) &
first_retry_pid=$!
(
  "$PSQL_BINARY" "${psql_args[@]}" >"$SECOND_RETRY_LOG" 2>&1 <<SQL
SET statement_timeout = '8s';
SELECT public.archive_students_bulk_atomic(
  '$STUDIO_ID'::uuid, '$SECOND_ACTOR_ID'::uuid,
  ARRAY['$FIRST_STUDENT_ID'::uuid, '$SECOND_STUDENT_ID'::uuid]
);
SQL
) &
second_retry_pid=$!
if ! wait "$holder_pid"; then
  echo "FAIL: sorted lock holder failed." >&2
  sed -n '1,120p' "$HOLDER_LOG" >&2
  exit 1
fi
if ! wait "$first_retry_pid" || ! wait "$second_retry_pid"; then
  echo "FAIL: opposite-order concurrent archive retries deadlocked or failed." >&2
  sed -n '1,120p' "$FIRST_RETRY_LOG" >&2
  sed -n '1,120p' "$SECOND_RETRY_LOG" >&2
  exit 1
fi
first_retry_pid=""
second_retry_pid=""
holder_pid=""

state="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SELECT
  (SELECT count(*) FROM public.students WHERE studio_id = '$STUDIO_ID'::uuid AND deleted_at IS NOT NULL)::text || ':' ||
  (SELECT count(*) FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid AND action = 'student.deleted')::text;
SQL
)"
if [[ "$state" != "2:2" ]]; then
  echo "FAIL: opposite-order retries did not converge atomically: $state" >&2
  exit 1
fi
first_retry_count="$(grep -E '^[[:space:]]*[0-9]+[[:space:]]*$' "$FIRST_RETRY_LOG" | tail -1 | tr -d '[:space:]')"
second_retry_count="$(grep -E '^[[:space:]]*[0-9]+[[:space:]]*$' "$SECOND_RETRY_LOG" | tail -1 | tr -d '[:space:]')"
if ! { [[ "$first_retry_count" == "2" && "$second_retry_count" == "0" ]] ||
       [[ "$first_retry_count" == "0" && "$second_retry_count" == "2" ]]; }; then
  echo "FAIL: opposite-order retries did not return the expected 2/0 update counts." >&2
  sed -n '1,120p' "$FIRST_RETRY_LOG" >&2
  sed -n '1,120p' "$SECOND_RETRY_LOG" >&2
  exit 1
fi
echo "PASS: opposite-order concurrent archive retries serialized without duplicate audits."
