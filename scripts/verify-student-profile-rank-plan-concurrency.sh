#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-student-profile-rank-plan-concurrency.sh <psql> <socket-dir> <port>" >&2
  exit 2
fi

PSQL_BINARY="$1"
SOCKET_DIR="$2"
DB_PORT="$3"
OWNER_ID="00000000-0000-4000-8000-000000009201"
STUDIO_ID="00000000-0000-4000-8000-000000009202"
PROGRAM_ID="00000000-0000-4000-8000-000000009203"
LADDER_ID="00000000-0000-4000-8000-000000009204"
STUDENT_ID="00000000-0000-4000-8000-000000009205"
FIRST_RANK_ID="00000000-0000-4000-8000-000000009206"
SECOND_RANK_ID="00000000-0000-4000-8000-000000009207"
MARKER_PATH="$(mktemp /tmp/koaryu-student-lock-order.XXXXXX)"
RANK_PLAN_LOG="$(mktemp /tmp/koaryu-rank-plan-lock-order.XXXXXX)"
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

rank_plan_pid=""
cleanup() {
  if [[ -n "$rank_plan_pid" ]] && kill -0 "$rank_plan_pid" 2>/dev/null; then
    kill "$rank_plan_pid" 2>/dev/null || true
    wait "$rank_plan_pid" 2>/dev/null || true
  fi
  "$PSQL_BINARY" "${psql_args[@]}" >/dev/null 2>&1 <<SQL || true
DELETE FROM public.audit_logs WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.student_program_memberships WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.students WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.belt_ranks WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.belt_ladders WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.programs WHERE studio_id = '$STUDIO_ID'::uuid;
DELETE FROM public.studios WHERE id = '$STUDIO_ID'::uuid;
DELETE FROM auth.users WHERE id = '$OWNER_ID'::uuid;
SQL
  rm -f "$MARKER_PATH" "$RANK_PLAN_LOG"
}
trap cleanup EXIT

"$PSQL_BINARY" "${psql_args[@]}" <<SQL
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '$OWNER_ID'::uuid, 'authenticated', 'authenticated',
  'student-lock-order@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()
);
INSERT INTO public.studios (id, name, slug, owner_id)
VALUES ('$STUDIO_ID'::uuid, 'Student Lock Order Contract', 'student-lock-order-contract', '$OWNER_ID'::uuid);
INSERT INTO public.programs (id, studio_id, name)
VALUES ('$PROGRAM_ID'::uuid, '$STUDIO_ID'::uuid, 'Lock Order Program');
INSERT INTO public.belt_ladders (id, studio_id, name, program_id)
VALUES ('$LADDER_ID'::uuid, '$STUDIO_ID'::uuid, 'Lock Order Ladder', '$PROGRAM_ID'::uuid);
INSERT INTO public.belt_ranks (
  id, ladder_id, studio_id, name, color_hex, display_order, min_classes,
  min_months, requires_approval, is_tip
) VALUES
  ('$FIRST_RANK_ID'::uuid, '$LADDER_ID'::uuid, '$STUDIO_ID'::uuid, 'White', '#ffffff', 1, 0, 0, false, false),
  ('$SECOND_RANK_ID'::uuid, '$LADDER_ID'::uuid, '$STUDIO_ID'::uuid, 'Yellow', '#facc15', 2, 10, 2, false, false);
INSERT INTO public.students (
  id, studio_id, legal_first_name, legal_last_name, status, program_id, current_belt_rank_id
) VALUES (
  '$STUDENT_ID'::uuid, '$STUDIO_ID'::uuid, 'Lock', 'Order', 'active',
  '$PROGRAM_ID'::uuid, '$FIRST_RANK_ID'::uuid
);
INSERT INTO public.student_program_memberships (
  studio_id, student_id, program_id, status, current_belt_rank_id
) VALUES (
  '$STUDIO_ID'::uuid, '$STUDENT_ID'::uuid, '$PROGRAM_ID'::uuid, 'active', '$FIRST_RANK_ID'::uuid
);
SQL

# Hold the student lock in the same transaction that runs the real rank-plan
# writer. A concurrent profile write must wait there without holding membership
# locks; otherwise the rank-plan writer and profile writer form an AB-BA cycle.
"$PSQL_BINARY" "${psql_args[@]}" >"$RANK_PLAN_LOG" 2>&1 <<SQL &
BEGIN;
SELECT 1 FROM public.students WHERE id = '$STUDENT_ID'::uuid FOR UPDATE;
\! touch "$MARKER_PATH"
SELECT pg_sleep(2);
SELECT count(*)
FROM public.sync_belt_ladder_ranks(
  '$LADDER_ID'::uuid,
  '$STUDIO_ID'::uuid,
  'Tip',
  jsonb_build_array(jsonb_build_object(
    'id', '$SECOND_RANK_ID'::uuid,
    'name', 'Yellow',
    'color_hex', '#facc15',
    'min_classes', 10,
    'min_months', 2,
    'requires_approval', false,
    'is_tip', false
  ))
);
COMMIT;
SQL
rank_plan_pid="$!"

for _ in {1..100}; do
  if [[ -f "$MARKER_PATH" ]]; then
    break
  fi
  if ! kill -0 "$rank_plan_pid" 2>/dev/null; then
    wait "$rank_plan_pid" || true
    echo "FAIL: rank-plan session exited before taking the student lock" >&2
    sed -n '1,120p' "$RANK_PLAN_LOG" >&2
    exit 1
  fi
  sleep 0.05
done

if [[ ! -f "$MARKER_PATH" ]]; then
  echo "FAIL: rank-plan session did not reach the student-lock synchronization point" >&2
  exit 1
fi

set +e
profile_output="$("$PSQL_BINARY" "${psql_args[@]}" 2>&1 <<SQL
SET statement_timeout = '6s';
SELECT (public.write_student_profile_atomic(
  '$STUDENT_ID'::uuid,
  '$STUDIO_ID'::uuid,
  '$OWNER_ID'::uuid,
  jsonb_build_object('notes', 'concurrency contract'),
  ARRAY['$PROGRAM_ID'::uuid],
  '[]'::jsonb,
  true,
  'student.updated'
)).id;
SQL
)"
profile_status=$?
set -e

if [[ $profile_status -ne 0 ]]; then
  echo "FAIL: profile write did not serialize behind the concurrent rank-plan save" >&2
  echo "$profile_output" >&2
  exit 1
fi

if ! wait "$rank_plan_pid"; then
  rank_plan_pid=""
  echo "FAIL: rank-plan save failed while the profile write was waiting" >&2
  sed -n '1,120p' "$RANK_PLAN_LOG" >&2
  exit 1
fi
rank_plan_pid=""

final_state="$("$PSQL_BINARY" "${psql_args[@]}" --tuples-only --no-align <<SQL
SELECT student.current_belt_rank_id::text || ':' ||
       membership.current_belt_rank_id::text || ':' ||
       (SELECT count(*) FROM public.belt_ranks WHERE id = '$FIRST_RANK_ID'::uuid)::text
FROM public.students student
JOIN public.student_program_memberships membership
  ON membership.student_id = student.id
 AND membership.studio_id = student.studio_id
 AND membership.program_id = student.program_id
WHERE student.id = '$STUDENT_ID'::uuid;
SQL
)"

if [[ "$final_state" != "$SECOND_RANK_ID:$SECOND_RANK_ID:0" ]]; then
  echo "FAIL: serialized profile/rank-plan writes did not converge on the surviving rank" >&2
  exit 1
fi

echo "PASS: profile writes serialize behind rank-plan saves with students-before-memberships lock order."
