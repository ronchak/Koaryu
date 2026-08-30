#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-billing-enrollment-transition-concurrency.sh psql host port" >&2
  exit 2
fi

psql_bin="$1"
psql_args=(--host="$2" --port="$3" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
admin_id="00000000-0000-4000-8000-000000009901"
front_desk_id="00000000-0000-4000-8000-000000009902"
studio_id="00000000-0000-4000-8000-000000009903"
plan_id="00000000-0000-4000-8000-000000009904"
payer_due_id="00000000-0000-4000-8000-000000009905"
payer_revoke_id="00000000-0000-4000-8000-000000009906"
group_due_id="00000000-0000-4000-8000-000000009907"
group_revoke_id="00000000-0000-4000-8000-000000009908"
schedule_due_id="00000000-0000-4000-8000-000000009909"
schedule_revoke_id="00000000-0000-4000-8000-000000009910"
enrollment_due_id="00000000-0000-4000-8000-000000009911"
enrollment_due_peer_id="00000000-0000-4000-8000-000000009912"
enrollment_revoke_id="00000000-0000-4000-8000-000000009913"
enrollment_revoke_peer_id="00000000-0000-4000-8000-000000009914"
worker_one="00000000-0000-4000-8000-000000009915"
worker_two="00000000-0000-4000-8000-000000009916"
account_id="acct_transitionconcurrency"
first_log="$(mktemp /tmp/koaryu-transition-due-first.XXXXXX)"
second_log="$(mktemp /tmp/koaryu-transition-due-second.XXXXXX)"
revoke_log="$(mktemp /tmp/koaryu-transition-revoke.XXXXXX)"
revoke_due_log="$(mktemp /tmp/koaryu-transition-revoke-due.XXXXXX)"
first_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "$first_pid" ]] && kill -0 "$first_pid" 2>/dev/null; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    for diagnostic_log in "$first_log" "$second_log" "$revoke_log" "$revoke_due_log"; do
      if [[ -s "$diagnostic_log" ]]; then
        echo "--- $(basename "$diagnostic_log")" >&2
        sed -n '1,160p' "$diagnostic_log" >&2
      fi
    done
  fi
  if ! "$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.billing_enrollment_transition_aliases WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_enrollment_transition_intents WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_provider_operations WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.student_billing_enrollments WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_subscriptions WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_plans WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.students WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_payers WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.studio_payment_accounts WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.staff_roles WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.studios WHERE id='$studio_id'::UUID;
DELETE FROM auth.users WHERE id IN ('$admin_id'::UUID,'$front_desk_id'::UUID);
SET LOCAL session_replication_role=origin;
COMMIT;
SQL
  then
    echo "Failed to clean up the enrollment-transition concurrency fixture." >&2
    exit_code=1
  fi
  rm -f "$first_log" "$second_log" "$revoke_log" "$revoke_due_log"
  trap - EXIT HUP INT TERM
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES
  ('$admin_id','authenticated','authenticated','transition-concurrency-admin@example.invalid','{}','{}',now(),now()),
  ('$front_desk_id','authenticated','authenticated','transition-concurrency-front@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('$studio_id','Transition concurrency','transition-concurrency','$admin_id');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES ('$studio_id','$admin_id','admin'),('$studio_id','$front_desk_id','front_desk');
INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
VALUES ('$studio_id','$account_id','{"connect_account_generation":1}'::JSONB);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation
) VALUES
  ('$payer_due_id','$studio_id','Due payer','$account_id','cus_transition_due',1),
  ('$payer_revoke_id','$studio_id','Revoke payer','$account_id','cus_transition_revoke',1);
INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,billing_interval,status)
VALUES ('$plan_id','$studio_id','Transition plan',5000,'monthly','active');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES
  (gen_random_uuid(),'$studio_id','Due','Target'),
  (gen_random_uuid(),'$studio_id','Due','Peer'),
  (gen_random_uuid(),'$studio_id','Revoke','Target'),
  (gen_random_uuid(),'$studio_id','Revoke','Peer');
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,stripe_subscription_id,
  collection_mode,billing_interval,currency,status,current_period_end,metadata
) VALUES
  ('$group_due_id','$studio_id','$payer_due_id','$account_id','cus_transition_due',
   'sub_transition_due','invoice_link','monthly','usd','active',now()-interval '1 second',
   '{"connect_account_generation":1}'::JSONB),
  ('$group_revoke_id','$studio_id','$payer_revoke_id','$account_id','cus_transition_revoke',
   'sub_transition_revoke','invoice_link','monthly','usd','active',now()+interval '2 seconds',
   '{"connect_account_generation":1}'::JSONB);
WITH ordered_students AS (
  SELECT id,row_number() OVER (ORDER BY legal_first_name,legal_last_name,id) AS ordinal
  FROM public.students WHERE studio_id='$studio_id'::UUID
)
INSERT INTO public.student_billing_enrollments(
  id,studio_id,student_id,payer_id,billing_plan_id,billing_subscription_id,
  collection_mode,status,stripe_subscription_id,stripe_subscription_item_id,metadata
)
SELECT
  CASE ordinal
    WHEN 1 THEN '$enrollment_due_peer_id'::UUID
    WHEN 2 THEN '$enrollment_due_id'::UUID
    WHEN 3 THEN '$enrollment_revoke_peer_id'::UUID
    ELSE '$enrollment_revoke_id'::UUID
  END,
  '$studio_id'::UUID,id,
  CASE WHEN ordinal<=2 THEN '$payer_due_id'::UUID ELSE '$payer_revoke_id'::UUID END,
  '$plan_id'::UUID,
  CASE WHEN ordinal<=2 THEN '$group_due_id'::UUID ELSE '$group_revoke_id'::UUID END,
  'invoice_link','active',
  CASE WHEN ordinal<=2 THEN 'sub_transition_due' ELSE 'sub_transition_revoke' END,
  CASE ordinal
    WHEN 1 THEN 'si_transition_due_peer'
    WHEN 2 THEN 'si_transition_due'
    WHEN 3 THEN 'si_transition_revoke_peer'
    ELSE 'si_transition_revoke'
  END,
  '{}'::JSONB
FROM ordered_students;
INSERT INTO public.billing_enrollment_transition_intents(
  id,studio_id,enrollment_id,payer_id,billing_subscription_id,transition_kind,
  mutation_strategy,request_sha256,stripe_connected_account_id,
  connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
  period_boundary,expected_quantity,expected_subscription_item_count,
  same_item_active_count,provider_quantity,initiated_by,reason_code,state,scheduled_at
) VALUES
  ('$schedule_due_id','$studio_id','$enrollment_due_id','$payer_due_id','$group_due_id',
   'schedule_period_end','subscription_item_delete_at_period_end',repeat('a',64),
   '$account_id',1,'sub_transition_due','si_transition_due',now()-interval '1 second',
   0,2,1,1,'$front_desk_id','concurrency.due','scheduled',now()-interval '1 minute'),
  ('$schedule_revoke_id','$studio_id','$enrollment_revoke_id','$payer_revoke_id','$group_revoke_id',
   'schedule_period_end','subscription_item_delete_at_period_end',repeat('b',64),
   '$account_id',1,'sub_transition_revoke','si_transition_revoke',now()+interval '2 seconds',
   0,2,1,1,'$front_desk_id','concurrency.revoke','scheduled',now());
SQL

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$first_log" 2>&1 <<SQL &
BEGIN;
SELECT count(*) FROM public.claim_due_billing_enrollment_transitions_v1('$worker_one',30,1);
SELECT pg_advisory_xact_lock(990100001);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(990100001);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$second_log" 2>&1 <<SQL
SET statement_timeout='6s';
SELECT count(*) FROM public.claim_due_billing_enrollment_transitions_v1('$worker_two',30,1);
SQL
wait "$first_pid"
first_pid=""

first_count="$(sed -n '1p' "$first_log" | tr -d '\r')"
second_count="$(sed -n '1p' "$second_log" | tr -d '\r')"
[[ "$first_count" == "1" ]]
[[ "$second_count" == "0" ]]
execute_count="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT count(*)::TEXT FROM public.billing_enrollment_transition_intents
WHERE source_intent_id='$schedule_due_id'::UUID AND transition_kind='execute_due';
" | tr -d '\r\n')"
[[ "$execute_count" == "1" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null --command="SELECT pg_sleep(2.1);"

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$revoke_log" 2>&1 <<SQL &
BEGIN;
SELECT public.revoke_billing_enrollment_transition_v1(
  '$schedule_revoke_id','$studio_id','$front_desk_id',1,
  'revoke-concurrency',repeat('c',64),'concurrency.revoke',gen_random_uuid(),30
)->>'outcome';
SELECT pg_advisory_xact_lock(990100002);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(990100002);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$revoke_due_log" 2>&1 <<SQL
SET statement_timeout='6s';
SELECT count(*) FROM public.claim_due_billing_enrollment_transitions_v1('$worker_two',30,10)
WHERE source_intent_id='$schedule_revoke_id'::UUID;
SQL
wait "$first_pid"
first_pid=""

revoke_outcome="$(sed -n '1p' "$revoke_log" | tr -d '\r')"
revoke_due_count="$(sed -n '1p' "$revoke_due_log" | tr -d '\r')"
[[ "$revoke_outcome" == "revoked" ]]
[[ "$revoke_due_count" == "0" ]]
revoke_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT source.state || ':' || count(child.id)::TEXT || ':' ||
       count(*) FILTER (
         WHERE revoke.state='due_claimed'
           AND operation.operation_type='enrollment.cancel.period_end.revoke'
           AND operation.state='started'
       )::TEXT
FROM public.billing_enrollment_transition_intents source
LEFT JOIN public.billing_enrollment_transition_intents child
  ON child.source_intent_id=source.id AND child.transition_kind='execute_due'
LEFT JOIN public.billing_enrollment_transition_intents revoke
  ON revoke.source_intent_id=source.id AND revoke.transition_kind='revoke_scheduled'
LEFT JOIN public.billing_provider_operations operation
  ON operation.id=revoke.provider_operation_id
WHERE source.id='$schedule_revoke_id'::UUID
GROUP BY source.state;
" | tr -d '\r\n')"
[[ "$revoke_state" == "revoked:0:0" ]]

# The V31 schedule wrapper must take the subscription-group lock before its
# target enrollment. This reproduces the due CAS group->all-peers sequence,
# pauses between the two locks, and races a schedule request for the peer. The
# old target->group wrapper deadlocked here; the V31 order waits at the group.
"$psql_bin" "${psql_args[@]}" >/dev/null --command="
UPDATE public.billing_subscriptions
SET current_period_end=clock_timestamp()+interval '1 day'
WHERE id='$group_revoke_id'::UUID;
"
"$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL &
BEGIN;
SELECT id FROM public.billing_subscriptions
WHERE id='$group_revoke_id'::UUID FOR UPDATE;
SELECT pg_advisory_xact_lock(990100003);
SELECT pg_sleep(1);
DO \$\$
BEGIN
  PERFORM 1
  FROM public.student_billing_enrollments
  WHERE studio_id='$studio_id'::UUID
    AND billing_subscription_id='$group_revoke_id'::UUID
    AND status IN ('pending','active')
  ORDER BY id
  FOR UPDATE;
END;
\$\$;
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(990100003);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

peer_schedule_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT public.claim_billing_enrollment_transition_v1(
  '$studio_id','$front_desk_id','schedule_period_end','peer-lock-order',
  repeat('d',64),'$enrollment_revoke_peer_id','$payer_revoke_id',
  '$group_revoke_id','sub_transition_revoke','si_transition_revoke_peer',
  '$account_id',1,
  (SELECT current_period_end FROM public.billing_subscriptions
   WHERE id='$group_revoke_id'::UUID),
  0,2,1,1,'subscription_item_delete_at_period_end',
  'concurrency.peer_lock_order',gen_random_uuid(),30
)->>'outcome';
SQL
)"
wait "$first_pid"
first_pid=""
[[ "$peer_schedule_outcome" == "claimed" ]]

echo "PASS: enrollment transition due claims, legacy revoke, and group/peer lock ordering serialize across sessions."
