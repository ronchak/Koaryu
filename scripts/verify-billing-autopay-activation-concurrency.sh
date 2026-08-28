#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-billing-autopay-activation-concurrency.sh psql host port" >&2
  exit 2
fi

psql_bin="$1"
psql_args=(--host="$2" --port="$3" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
admin_id="00000000-0000-4000-8000-000000009801"
studio_id="00000000-0000-4000-8000-000000009802"
payer_id="00000000-0000-4000-8000-000000009803"
plan_id="00000000-0000-4000-8000-000000009804"
student_id="00000000-0000-4000-8000-000000009805"
enrollment_id="00000000-0000-4000-8000-000000009806"
operation_id="00000000-0000-4000-8000-000000009807"
request_id="00000000-0000-4000-8000-000000009808"
consent_id="00000000-0000-4000-8000-000000009809"
transition_group_id="00000000-0000-4000-8000-000000009810"
transition_worker_id="00000000-0000-4000-8000-000000009811"
sibling_student_id="00000000-0000-4000-8000-000000009820"
sibling_enrollment_id="00000000-0000-4000-8000-000000009821"
sibling_group_id="00000000-0000-4000-8000-000000009822"
sibling_transition_worker_id="00000000-0000-4000-8000-000000009823"
linked_student_one_id="00000000-0000-4000-8000-000000009830"
linked_enrollment_one_id="00000000-0000-4000-8000-000000009831"
linked_group_one_id="00000000-0000-4000-8000-000000009832"
linked_student_two_id="00000000-0000-4000-8000-000000009833"
linked_enrollment_two_id="00000000-0000-4000-8000-000000009834"
linked_group_two_id="00000000-0000-4000-8000-000000009835"
linked_plan_two_id="00000000-0000-4000-8000-000000009836"
reservation_phantom_group_id="00000000-0000-4000-8000-000000009840"
disable_phantom_group_id="00000000-0000-4000-8000-000000009841"
account_id="acct_ActivationConcurrency123"
activation_log="$(mktemp /tmp/koaryu-autopay-activation-first.XXXXXX)"
disable_log="$(mktemp /tmp/koaryu-autopay-disable-second.XXXXXX)"
disable_first_log="$(mktemp /tmp/koaryu-autopay-disable-first.XXXXXX)"
activation_second_log="$(mktemp /tmp/koaryu-autopay-activation-second.XXXXXX)"
transition_first_log="$(mktemp /tmp/koaryu-autopay-transition-first.XXXXXX)"
reservation_first_log="$(mktemp /tmp/koaryu-autopay-reservation-first.XXXXXX)"
sibling_transition_first_log="$(mktemp /tmp/koaryu-autopay-sibling-transition-first.XXXXXX)"
sibling_reservation_first_log="$(mktemp /tmp/koaryu-autopay-sibling-reservation-first.XXXXXX)"
linked_one_first_log="$(mktemp /tmp/koaryu-autopay-linked-one-first.XXXXXX)"
linked_two_first_log="$(mktemp /tmp/koaryu-autopay-linked-two-first.XXXXXX)"
reservation_phantom_gate_log="$(mktemp /tmp/koaryu-autopay-reservation-phantom-gate.XXXXXX)"
reservation_phantom_rpc_log="$(mktemp /tmp/koaryu-autopay-reservation-phantom-rpc.XXXXXX)"
disable_phantom_gate_log="$(mktemp /tmp/koaryu-autopay-disable-phantom-gate.XXXXXX)"
disable_phantom_rpc_log="$(mktemp /tmp/koaryu-autopay-disable-phantom-rpc.XXXXXX)"
first_pid=""
second_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "$first_pid" ]] && kill -0 "$first_pid" 2>/dev/null; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  if [[ -n "$second_pid" ]] && kill -0 "$second_pid" 2>/dev/null; then
    kill "$second_pid" 2>/dev/null || true
    wait "$second_pid" 2>/dev/null || true
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    for diagnostic_log in "$activation_log" "$disable_log" "$disable_first_log" "$activation_second_log" "$transition_first_log" "$reservation_first_log" "$sibling_transition_first_log" "$sibling_reservation_first_log" "$linked_one_first_log" "$linked_two_first_log" "$reservation_phantom_gate_log" "$reservation_phantom_rpc_log" "$disable_phantom_gate_log" "$disable_phantom_rpc_log"; do
      if [[ -s "$diagnostic_log" ]]; then
        echo "--- $(basename "$diagnostic_log")" >&2
        sed -n '1,160p' "$diagnostic_log" >&2
      fi
    done
  fi
  "$psql_bin" "${psql_args[@]}" >/dev/null <<SQL || exit_code=1
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.billing_enrollment_transition_aliases WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_enrollment_transition_intents WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.student_billing_enrollments WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_subscriptions WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_plans WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.students WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_payer_payment_consents WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_payer_setup_requests WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_provider_operations WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.billing_payers WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.studio_payment_accounts WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.staff_roles WHERE studio_id='$studio_id'::UUID;
DELETE FROM public.studios WHERE id='$studio_id'::UUID;
DELETE FROM auth.users WHERE id='$admin_id'::UUID;
SET LOCAL session_replication_role=origin;
COMMIT;
SQL
  rm -f "$activation_log" "$disable_log" "$disable_first_log" "$activation_second_log" "$transition_first_log" "$reservation_first_log" "$sibling_transition_first_log" "$sibling_reservation_first_log" "$linked_one_first_log" "$linked_two_first_log" "$reservation_phantom_gate_log" "$reservation_phantom_rpc_log" "$disable_phantom_gate_log" "$disable_phantom_rpc_log"
  trap - EXIT HUP INT TERM
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('$admin_id','authenticated','authenticated','activation-concurrency@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('$studio_id','Activation concurrency','activation-concurrency','$admin_id');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES ('$studio_id','$admin_id','admin');
INSERT INTO public.studio_payment_accounts(
  studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,
  details_submitted,requirements_due,platform_fee_bps,metadata
) VALUES (
  '$studio_id','$account_id','charges_enabled',true,true,true,ARRAY[]::TEXT[],50,
  '{"connect_account_generation":1}'::JSONB
);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,
  connect_account_generation,default_payment_method_id,autopay_status,
  autopay_authorized_at,autopay_terms_accepted_at
) VALUES (
  '$payer_id','$studio_id','Activation payer','$account_id','cus_activation_concurrency',
  1,'pm_activation_concurrency','enabled',now()-interval '20 seconds',
  now()-interval '30 seconds'
);
INSERT INTO public.billing_provider_operations(
  id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
  stripe_connected_account_id,connect_account_generation,state,
  provider_request_attempt_count,provider_object_id,provider_secondary_object_id,
  provider_succeeded_at,projected_at,completed_at
) VALUES (
  '$operation_id','$studio_id','$admin_id','payer.setup','activation-consent',
  repeat('a',64),'$account_id',1,'completed',1,'cs_activation_concurrency',
  'seti_activation_concurrency',now()-interval '25 seconds',
  now()-interval '22 seconds',now()-interval '20 seconds'
);
INSERT INTO public.billing_payer_setup_requests(
  id,operation_id,studio_id,payer_id,initiated_by,terms_version,
  stripe_checkout_session_id,stripe_setup_intent_id,stripe_connected_account_id,
  connect_account_generation,setup_request_expires_at,accepted_at,completed_at
) VALUES (
  '$request_id','$operation_id','$studio_id','$payer_id','$admin_id',
  'koaryu-autopay-v1','cs_activation_concurrency','seti_activation_concurrency',
  '$account_id',1,now()+interval '30 minutes',now()-interval '30 seconds',
  now()-interval '20 seconds'
);
INSERT INTO public.billing_payer_payment_consents(
  id,setup_request_id,studio_id,payer_id,terms_version,
  stripe_checkout_session_id,stripe_setup_intent_id,stripe_connected_account_id,
  connect_account_generation,acceptance_proof_sha256,accepted_at,completed_at,
  setup_request_expires_at
) VALUES (
  '$consent_id','$request_id','$studio_id','$payer_id','koaryu-autopay-v1',
  'cs_activation_concurrency','seti_activation_concurrency','$account_id',1,
  repeat('b',64),now()-interval '30 seconds',now()-interval '20 seconds',
  now()+interval '30 minutes'
);
UPDATE public.billing_payers
SET autopay_terms_accepted_at=(
      SELECT accepted_at FROM public.billing_payer_payment_consents
      WHERE id='$consent_id'::UUID
    ),
    autopay_authorized_at=(
      SELECT completed_at FROM public.billing_payer_payment_consents
      WHERE id='$consent_id'::UUID
    )
WHERE id='$payer_id'::UUID;
INSERT INTO public.billing_plans(
  id,studio_id,name,amount_cents,currency,billing_interval,status
) VALUES ('$plan_id','$studio_id','Activation plan',5000,'usd','monthly','active');
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
VALUES ('$student_id','$studio_id','Activation','Student');
INSERT INTO public.student_billing_enrollments(
  id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,metadata
) VALUES (
  '$enrollment_id','$studio_id','$student_id','$payer_id','$plan_id',
  'autopay','pending','{}'::JSONB
);
SQL

# Exercise the reservation contract without leaving a group behind for the
# existing activation-versus-disable races below.
"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
DO \$reservation_replay_contract\$
DECLARE
  v_first JSONB;
  v_replay JSONB;
  v_group_id UUID;
BEGIN
  v_first:=public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  );
  v_group_id:=(v_first->'subscription'->>'id')::UUID;
  v_replay:=public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  );
  IF v_first->>'outcome'<>'created'
     OR v_replay->>'outcome'<>'existing'
     OR (v_replay->'subscription'->>'id')::UUID IS DISTINCT FROM v_group_id
     OR (SELECT count(*) FROM public.billing_subscriptions
         WHERE studio_id='$studio_id'::UUID AND payer_id='$payer_id'::UUID)<>1 THEN
    RAISE EXCEPTION 'Autopay reservation create/replay contract drifted: %, %',
      v_first,v_replay;
  END IF;
  DELETE FROM public.billing_subscriptions WHERE id=v_group_id;
END;
\$reservation_replay_contract\$;

DO \$legacy_generation_adoption_contract\$
DECLARE
  v_group_id UUID:=gen_random_uuid();
  v_result JSONB;
BEGIN
  INSERT INTO public.billing_subscriptions(
    id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
    stripe_subscription_id,collection_mode,billing_interval,currency,status,
    default_payment_method_id,application_fee_percent,current_period_end,metadata
  ) VALUES (
    v_group_id,'$studio_id','$payer_id','$account_id',
    'cus_activation_concurrency','sub_activation_legacy','autopay','monthly',
    'usd','active','pm_activation_concurrency',0.5,
    clock_timestamp()+interval '1 day','{}'::JSONB
  );
  v_result:=public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  );
  IF v_result->>'outcome'<>'existing'
     OR (v_result->'subscription'->>'id')::UUID IS DISTINCT FROM v_group_id
     OR (SELECT metadata->>'connect_account_generation'
         FROM public.billing_subscriptions WHERE id=v_group_id)<>'1' THEN
    RAISE EXCEPTION 'Legacy activation group did not adopt generation 1: %',v_result;
  END IF;
  DELETE FROM public.billing_subscriptions WHERE id=v_group_id;
END;
\$legacy_generation_adoption_contract\$;

DO \$malformed_generation_contract\$
DECLARE
  v_group_id UUID;
  v_metadata JSONB;
  v_before JSONB;
  v_after JSONB;
BEGIN
  FOR v_metadata IN
    SELECT candidate.metadata
    FROM (VALUES
      ('[]'::JSONB),
      ('{"connect_account_generation":"generation-one"}'::JSONB),
      ('{"connect_account_generation":2147483648}'::JSONB)
    ) AS candidate(metadata)
  LOOP
    v_group_id:=gen_random_uuid();
    INSERT INTO public.billing_subscriptions(
      id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
      stripe_subscription_id,collection_mode,billing_interval,currency,status,
      default_payment_method_id,application_fee_percent,current_period_end,metadata
    ) VALUES (
      v_group_id,'$studio_id','$payer_id','$account_id',
      'cus_activation_concurrency','sub_activation_invalid_'||replace(v_group_id::TEXT,'-',''),
      'autopay','monthly','usd','active','pm_activation_concurrency',0.5,
      clock_timestamp()+interval '1 day',v_metadata
    );
    SELECT to_jsonb(subscription) INTO v_before
    FROM public.billing_subscriptions AS subscription WHERE id=v_group_id;
    BEGIN
      PERFORM public.reserve_billing_autopay_activation_v31(
        '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
        '$account_id',1,'koaryu-autopay-v1',0.5
      );
      RAISE EXCEPTION 'Malformed group metadata was accepted: %',v_metadata;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      IF SQLERRM<>'billing_autopay_activation_group_invalid' THEN
        RAISE;
      END IF;
    END;
    SELECT to_jsonb(subscription) INTO v_after
    FROM public.billing_subscriptions AS subscription WHERE id=v_group_id;
    IF v_after IS DISTINCT FROM v_before THEN
      RAISE EXCEPTION 'Malformed group changed despite rejection: %',v_metadata;
    END IF;
    DELETE FROM public.billing_subscriptions WHERE id=v_group_id;
  END LOOP;
END;
\$malformed_generation_contract\$;
SQL

# Put the enrollment on an existing active group, then race the real V31
# schedule claim against reservation in both lock acquisition orders. Both
# functions must complete after waiting on group -> enrollment -> payer.
"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,
  default_payment_method_id,application_fee_percent,current_period_end,metadata
) VALUES (
  '$transition_group_id','$studio_id','$payer_id','$account_id',
  'cus_activation_concurrency','sub_activation_transition','autopay','monthly',
  'usd','active','pm_activation_concurrency',0.5,
  clock_timestamp()+interval '1 day',
  '{"connect_account_generation":1}'::JSONB
);
UPDATE public.student_billing_enrollments
SET billing_subscription_id='$transition_group_id'::UUID,
    status='active',
    stripe_subscription_id='sub_activation_transition',
    stripe_subscription_item_id='si_activation_transition'
WHERE id='$enrollment_id'::UUID AND studio_id='$studio_id'::UUID;
SQL

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$transition_first_log" 2>&1 <<SQL &
BEGIN;
SELECT public.claim_billing_enrollment_transition_v1(
  '$studio_id','$admin_id','schedule_period_end','activation-transition-race',
  repeat('c',64),'$enrollment_id','$payer_id','$transition_group_id',
  'sub_activation_transition','si_activation_transition','$account_id',1,
  (SELECT current_period_end FROM public.billing_subscriptions
   WHERE id='$transition_group_id'::UUID),
  0,1,1,1,'subscription_cancel_at_period_end',
  'concurrency.activation_transition','$transition_worker_id',30
)->>'outcome';
SELECT pg_advisory_xact_lock(980100003);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100003);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

reservation_wait_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT public.reserve_billing_autopay_activation_v31(
  '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
  '$account_id',1,'koaryu-autopay-v1',0.5
)->>'outcome';
SQL
)"
wait "$first_pid"
first_pid=""
grep -q '^claimed$' "$transition_first_log"
[[ "$reservation_wait_outcome" == "existing" ]]

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$reservation_first_log" 2>&1 <<SQL &
BEGIN;
SELECT public.reserve_billing_autopay_activation_v31(
  '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
  '$account_id',1,'koaryu-autopay-v1',0.5
)->>'outcome';
SELECT pg_advisory_xact_lock(980100004);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100004);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

transition_wait_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT public.claim_billing_enrollment_transition_v1(
  '$studio_id','$admin_id','schedule_period_end','activation-transition-race',
  repeat('c',64),'$enrollment_id','$payer_id','$transition_group_id',
  'sub_activation_transition','si_activation_transition','$account_id',1,
  (SELECT current_period_end FROM public.billing_subscriptions
   WHERE id='$transition_group_id'::UUID),
  0,1,1,1,'subscription_cancel_at_period_end',
  'concurrency.activation_transition','$transition_worker_id',30
)->>'outcome';
SQL
)"
wait "$first_pid"
first_pid=""
grep -q '^existing$' "$reservation_first_log"
[[ "$transition_wait_outcome" == "replay" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.billing_enrollment_transition_aliases
WHERE studio_id='$studio_id'::UUID
  AND caller_request_key='activation-transition-race';
DELETE FROM public.billing_enrollment_transition_intents
WHERE studio_id='$studio_id'::UUID
  AND enrollment_id='$enrollment_id'::UUID;
DELETE FROM public.billing_provider_operations
WHERE studio_id='$studio_id'::UUID
  AND caller_request_key='activation-transition-race';
UPDATE public.student_billing_enrollments
SET billing_subscription_id=NULL,
    status='pending',
    stripe_subscription_id=NULL,
    stripe_subscription_item_id=NULL
WHERE id='$enrollment_id'::UUID AND studio_id='$studio_id'::UUID;
DELETE FROM public.billing_subscriptions
WHERE id='$transition_group_id'::UUID AND studio_id='$studio_id'::UUID;
SET LOCAL session_replication_role=origin;
COMMIT;
SQL

# An unlinked sibling reservation must prelock the payer's existing group
# before it locks the sibling or payer. Pause a real transition after the group
# lock so the old payer-first reservation order would deadlock here.
"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
VALUES ('$sibling_student_id','$studio_id','Activation','Sibling');
INSERT INTO public.student_billing_enrollments(
  id,studio_id,student_id,payer_id,billing_plan_id,collection_mode,status,metadata
) VALUES (
  '$sibling_enrollment_id','$studio_id','$sibling_student_id','$payer_id','$plan_id',
  'autopay','pending','{}'::JSONB
);
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,
  default_payment_method_id,application_fee_percent,current_period_end,metadata
) VALUES (
  '$sibling_group_id','$studio_id','$payer_id','$account_id',
  'cus_activation_concurrency','sub_activation_sibling','autopay','monthly',
  'usd','active','pm_activation_concurrency',0.5,
  clock_timestamp()+interval '1 day',
  '{"connect_account_generation":1}'::JSONB
);
UPDATE public.student_billing_enrollments
SET billing_subscription_id='$sibling_group_id'::UUID,
    status='active',
    stripe_subscription_id='sub_activation_sibling',
    stripe_subscription_item_id='si_activation_sibling_target'
WHERE id='$enrollment_id'::UUID AND studio_id='$studio_id'::UUID;
SQL

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$sibling_transition_first_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='6s';
SELECT id FROM public.billing_subscriptions
WHERE id='$sibling_group_id'::UUID FOR UPDATE;
SELECT pg_advisory_xact_lock(980100005);
SELECT pg_sleep(1);
SELECT public.claim_billing_enrollment_transition_v1(
  '$studio_id','$admin_id','schedule_period_end','activation-sibling-transition-race',
  repeat('d',64),'$enrollment_id','$payer_id','$sibling_group_id',
  'sub_activation_sibling','si_activation_sibling_target','$account_id',1,
  (SELECT current_period_end FROM public.billing_subscriptions
   WHERE id='$sibling_group_id'::UUID),
  0,1,1,1,'subscription_cancel_at_period_end',
  'concurrency.activation_sibling_transition','$sibling_transition_worker_id',30
)->>'outcome';
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100005);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

sibling_reservation_wait_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT (result->>'outcome')||':'||(result->'subscription'->>'id')
FROM (
  SELECT public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$sibling_enrollment_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  ) AS result
) AS reservation;
SQL
)"
wait "$first_pid"
first_pid=""
grep -q '^claimed$' "$sibling_transition_first_log"
[[ "$sibling_reservation_wait_outcome" == "existing:$sibling_group_id" ]]

# Reverse start order: reservation owns every visible payer group first, so the
# exact transition replay waits at the group and completes after reservation.
"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$sibling_reservation_first_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='6s';
SELECT (result->>'outcome')||':'||(result->'subscription'->>'id')
FROM (
  SELECT public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$sibling_enrollment_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  ) AS result
) AS reservation;
SELECT pg_advisory_xact_lock(980100006);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100006);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

sibling_transition_wait_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT public.claim_billing_enrollment_transition_v1(
  '$studio_id','$admin_id','schedule_period_end','activation-sibling-transition-race',
  repeat('d',64),'$enrollment_id','$payer_id','$sibling_group_id',
  'sub_activation_sibling','si_activation_sibling_target','$account_id',1,
  (SELECT current_period_end FROM public.billing_subscriptions
   WHERE id='$sibling_group_id'::UUID),
  0,1,1,1,'subscription_cancel_at_period_end',
  'concurrency.activation_sibling_transition','$sibling_transition_worker_id',30
)->>'outcome';
SQL
)"
wait "$first_pid"
first_pid=""
grep -q "^existing:$sibling_group_id$" "$sibling_reservation_first_log"
[[ "$sibling_transition_wait_outcome" == "replay" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.billing_enrollment_transition_aliases
WHERE studio_id='$studio_id'::UUID
  AND caller_request_key='activation-sibling-transition-race';
DELETE FROM public.billing_enrollment_transition_intents
WHERE studio_id='$studio_id'::UUID
  AND enrollment_id='$enrollment_id'::UUID;
DELETE FROM public.billing_provider_operations
WHERE studio_id='$studio_id'::UUID
  AND caller_request_key='activation-sibling-transition-race';
UPDATE public.student_billing_enrollments
SET billing_subscription_id=NULL,
    status='pending',
    stripe_subscription_id=NULL,
    stripe_subscription_item_id=NULL
WHERE id='$enrollment_id'::UUID AND studio_id='$studio_id'::UUID;
DELETE FROM public.student_billing_enrollments
WHERE id='$sibling_enrollment_id'::UUID AND studio_id='$studio_id'::UUID;
DELETE FROM public.billing_subscriptions
WHERE id='$sibling_group_id'::UUID AND studio_id='$studio_id'::UUID;
DELETE FROM public.students
WHERE id='$sibling_student_id'::UUID AND studio_id='$studio_id'::UUID;
SET LOCAL session_replication_role=origin;
COMMIT;
SQL

# Two linked enrollments on two live payer groups expose target-group-first
# inversion. Hold the lower UUID group, start the higher-group reservation, and
# then reserve the lower-group enrollment. UUID-ordered prelocking lets the
# higher target wait before it owns its group.
"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name) VALUES
  ('$linked_student_one_id','$studio_id','Linked','One'),
  ('$linked_student_two_id','$studio_id','Linked','Two');
INSERT INTO public.billing_plans(
  id,studio_id,name,amount_cents,currency,billing_interval,status
) VALUES (
  '$linked_plan_two_id','$studio_id','Activation yearly plan',50000,
  'usd','annual','active'
);
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,
  default_payment_method_id,application_fee_percent,current_period_end,metadata
) VALUES
  ('$linked_group_one_id','$studio_id','$payer_id','$account_id',
   'cus_activation_concurrency','sub_activation_linked_one','autopay','monthly',
   'usd','active','pm_activation_concurrency',0.5,
   clock_timestamp()+interval '1 day','{"connect_account_generation":1}'::JSONB),
  ('$linked_group_two_id','$studio_id','$payer_id','$account_id',
   'cus_activation_concurrency','sub_activation_linked_two','autopay','annual',
   'usd','active','pm_activation_concurrency',0.5,
   clock_timestamp()+interval '1 day','{"connect_account_generation":1}'::JSONB);
INSERT INTO public.student_billing_enrollments(
  id,studio_id,student_id,payer_id,billing_plan_id,billing_subscription_id,
  collection_mode,status,stripe_subscription_id,stripe_subscription_item_id,metadata
) VALUES
  ('$linked_enrollment_one_id','$studio_id','$linked_student_one_id','$payer_id',
   '$plan_id','$linked_group_one_id','autopay','active',
   'sub_activation_linked_one','si_activation_linked_one','{}'::JSONB),
  ('$linked_enrollment_two_id','$studio_id','$linked_student_two_id','$payer_id',
   '$linked_plan_two_id','$linked_group_two_id','autopay','active',
   'sub_activation_linked_two','si_activation_linked_two','{}'::JSONB);
SQL

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$linked_one_first_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='6s';
SELECT id FROM public.billing_subscriptions
WHERE id='$linked_group_one_id'::UUID FOR UPDATE;
SELECT pg_advisory_xact_lock(980100007);
SELECT pg_sleep(1);
SELECT (result->>'outcome')||':'||(result->'subscription'->>'id')
FROM (
  SELECT public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$linked_enrollment_one_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  ) AS result
) AS reservation;
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100007);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

linked_two_wait_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT (result->>'outcome')||':'||(result->'subscription'->>'id')
FROM (
  SELECT public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$linked_enrollment_two_id','$payer_id','$linked_plan_two_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  ) AS result
) AS reservation;
SQL
)"
wait "$first_pid"
first_pid=""
grep -q "^existing:$linked_group_one_id$" "$linked_one_first_log"
[[ "$linked_two_wait_outcome" == "existing:$linked_group_two_id" ]]

# Reverse which target reservation starts first. It owns both ordered group
# locks, and the lower-target reservation waits without forming a cycle.
"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$linked_two_first_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='6s';
SELECT (result->>'outcome')||':'||(result->'subscription'->>'id')
FROM (
  SELECT public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$linked_enrollment_two_id','$payer_id','$linked_plan_two_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  ) AS result
) AS reservation;
SELECT pg_advisory_xact_lock(980100008);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100008);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

linked_one_wait_outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align <<SQL | tr -d '\r\n'
SET statement_timeout='6s';
SELECT (result->>'outcome')||':'||(result->'subscription'->>'id')
FROM (
  SELECT public.reserve_billing_autopay_activation_v31(
    '$studio_id','$admin_id','$linked_enrollment_one_id','$payer_id','$plan_id',
    '$account_id',1,'koaryu-autopay-v1',0.5
  ) AS result
) AS reservation;
SQL
)"
wait "$first_pid"
first_pid=""
grep -q "^existing:$linked_group_two_id$" "$linked_two_first_log"
[[ "$linked_one_wait_outcome" == "existing:$linked_group_one_id" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
BEGIN;
SET LOCAL session_replication_role=replica;
DELETE FROM public.student_billing_enrollments
WHERE studio_id='$studio_id'::UUID
  AND id IN ('$linked_enrollment_one_id'::UUID,'$linked_enrollment_two_id'::UUID);
DELETE FROM public.billing_subscriptions
WHERE studio_id='$studio_id'::UUID
  AND id IN ('$linked_group_one_id'::UUID,'$linked_group_two_id'::UUID);
DELETE FROM public.students
WHERE studio_id='$studio_id'::UUID
  AND id IN ('$linked_student_one_id'::UUID,'$linked_student_two_id'::UUID);
DELETE FROM public.billing_plans
WHERE id='$linked_plan_two_id'::UUID AND studio_id='$studio_id'::UUID;
SET LOCAL session_replication_role=origin;
COMMIT;
SQL

# Stage a reservation phantom after its first ordered group scan but before it
# acquires payer. The fresh UUID-set scan must reject the changed group set
# before reservation locks or mutates the newly committed row.
reservation_phantom_payer_before="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(payer)::TEXT)
FROM public.billing_payers AS payer WHERE id='$payer_id'::UUID;
" | tr -d '\r\n')"
reservation_phantom_consent_before="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(consent)::TEXT)
FROM public.billing_payer_payment_consents AS consent WHERE id='$consent_id'::UUID;
" | tr -d '\r\n')"

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$reservation_phantom_gate_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='12s';
SELECT id FROM public.billing_payers WHERE id='$payer_id'::UUID FOR UPDATE;
SELECT pg_advisory_xact_lock(980100009);
SELECT pg_sleep(5);
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,
  default_payment_method_id,application_fee_percent,current_period_end,metadata
) VALUES (
  '$reservation_phantom_group_id','$studio_id','$payer_id','$account_id',
  'cus_activation_concurrency','sub_activation_reservation_phantom',
  'autopay','annual','usd','active','pm_activation_concurrency',0.5,
  clock_timestamp()+interval '1 year',
  '{"connect_account_generation":1,"fixture":"reservation_phantom"}'::JSONB
);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100009);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

PGAPPNAME="koaryu_reservation_phantom_rpc" \
  "$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$reservation_phantom_rpc_log" 2>&1 <<SQL &
SET statement_timeout='10s';
DO \$reservation_phantom_contract\$
BEGIN
  BEGIN
    PERFORM public.reserve_billing_autopay_activation_v31(
      '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
      '$account_id',1,'koaryu-autopay-v1',0.5
    );
    RAISE EXCEPTION 'Reservation accepted a phantom payer group.';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM<>'billing_autopay_activation_group_changed' THEN
      RAISE;
    END IF;
  END;
END;
\$reservation_phantom_contract\$;
SELECT 'reservation-serialization-rejected';
SQL
second_pid="$!"

rpc_wait_state=""
for _attempt in {1..80}; do
  rpc_wait_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT COALESCE(wait_event_type,'')||':'||COALESCE(wait_event,'')
FROM pg_stat_activity
WHERE application_name='koaryu_reservation_phantom_rpc'
  AND state='active';
" | tr -d '\r\n')"
  [[ "$rpc_wait_state" == Lock:* ]] && break
  sleep 0.05
done
[[ "$rpc_wait_state" == Lock:* ]]

wait "$first_pid"
first_pid=""
wait "$second_pid"
second_pid=""
grep -q '^reservation-serialization-rejected$' "$reservation_phantom_rpc_log"

reservation_phantom_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT count(*)::TEXT||':'||
       bool_and(subscription.id='$reservation_phantom_group_id'::UUID)::TEXT||':'||
       bool_and(subscription.status='active')::TEXT||':'||
       bool_and(subscription.billing_interval='annual')::TEXT||':'||
       bool_and(subscription.metadata->>'connect_account_generation'='1')::TEXT||':'||
       bool_and(subscription.metadata->>'fixture'='reservation_phantom')::TEXT
FROM public.billing_subscriptions AS subscription
WHERE subscription.studio_id='$studio_id'::UUID
  AND subscription.payer_id='$payer_id'::UUID;
" | tr -d '\r\n')"
reservation_phantom_payer_after="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(payer)::TEXT)
FROM public.billing_payers AS payer WHERE id='$payer_id'::UUID;
" | tr -d '\r\n')"
reservation_phantom_consent_after="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(consent)::TEXT)
FROM public.billing_payer_payment_consents AS consent WHERE id='$consent_id'::UUID;
" | tr -d '\r\n')"
[[ "$reservation_phantom_state" == "1:true:true:true:true:true" ]]
[[ "$reservation_phantom_payer_after" == "$reservation_phantom_payer_before" ]]
[[ "$reservation_phantom_consent_after" == "$reservation_phantom_consent_before" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null --command="
DELETE FROM public.billing_subscriptions
WHERE id='$reservation_phantom_group_id'::UUID
  AND studio_id='$studio_id'::UUID;
"

# Repeat the same staged phantom for disable. The new group is deliberately
# live, so set-change detection must win before active-subscription rejection
# and before payer or consent revocation.
disable_phantom_payer_before="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(payer)::TEXT)
FROM public.billing_payers AS payer WHERE id='$payer_id'::UUID;
" | tr -d '\r\n')"
disable_phantom_consent_before="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(consent)::TEXT)
FROM public.billing_payer_payment_consents AS consent WHERE id='$consent_id'::UUID;
" | tr -d '\r\n')"

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$disable_phantom_gate_log" 2>&1 <<SQL &
BEGIN;
SET LOCAL statement_timeout='12s';
SELECT id FROM public.billing_payers WHERE id='$payer_id'::UUID FOR UPDATE;
SELECT pg_advisory_xact_lock(980100010);
SELECT pg_sleep(5);
INSERT INTO public.billing_subscriptions(
  id,studio_id,payer_id,stripe_account_id,stripe_customer_id,
  stripe_subscription_id,collection_mode,billing_interval,currency,status,
  default_payment_method_id,application_fee_percent,current_period_end,metadata
) VALUES (
  '$disable_phantom_group_id','$studio_id','$payer_id','$account_id',
  'cus_activation_concurrency','sub_activation_disable_phantom',
  'autopay','annual','usd','active','pm_activation_concurrency',0.5,
  clock_timestamp()+interval '1 year',
  '{"connect_account_generation":1,"fixture":"disable_phantom"}'::JSONB
);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100010);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

PGAPPNAME="koaryu_disable_phantom_rpc" \
  "$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$disable_phantom_rpc_log" 2>&1 <<SQL &
SET statement_timeout='10s';
DO \$disable_phantom_contract\$
BEGIN
  BEGIN
    PERFORM public.disable_billing_payer_autopay_v1(
      '$studio_id','$payer_id','$admin_id',clock_timestamp(),
      'staff_disabled_autopay'
    );
    RAISE EXCEPTION 'Disable accepted a phantom payer group.';
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM<>'billing_payer_autopay_disable_group_changed' THEN
      RAISE;
    END IF;
  END;
END;
\$disable_phantom_contract\$;
SELECT 'disable-serialization-rejected';
SQL
second_pid="$!"

rpc_wait_state=""
for _attempt in {1..80}; do
  rpc_wait_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT COALESCE(wait_event_type,'')||':'||COALESCE(wait_event,'')
FROM pg_stat_activity
WHERE application_name='koaryu_disable_phantom_rpc'
  AND state='active';
" | tr -d '\r\n')"
  [[ "$rpc_wait_state" == Lock:* ]] && break
  sleep 0.05
done
[[ "$rpc_wait_state" == Lock:* ]]

wait "$first_pid"
first_pid=""
wait "$second_pid"
second_pid=""
grep -q '^disable-serialization-rejected$' "$disable_phantom_rpc_log"

disable_phantom_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT count(*)::TEXT||':'||
       bool_and(subscription.id='$disable_phantom_group_id'::UUID)::TEXT||':'||
       bool_and(subscription.status='active')::TEXT||':'||
       bool_and(subscription.billing_interval='annual')::TEXT||':'||
       bool_and(subscription.metadata->>'connect_account_generation'='1')::TEXT||':'||
       bool_and(subscription.metadata->>'fixture'='disable_phantom')::TEXT
FROM public.billing_subscriptions AS subscription
WHERE subscription.studio_id='$studio_id'::UUID
  AND subscription.payer_id='$payer_id'::UUID;
" | tr -d '\r\n')"
disable_phantom_payer_after="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(payer)::TEXT)
FROM public.billing_payers AS payer WHERE id='$payer_id'::UUID;
" | tr -d '\r\n')"
disable_phantom_consent_after="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT md5(to_jsonb(consent)::TEXT)
FROM public.billing_payer_payment_consents AS consent WHERE id='$consent_id'::UUID;
" | tr -d '\r\n')"
[[ "$disable_phantom_state" == "1:true:true:true:true:true" ]]
[[ "$disable_phantom_payer_after" == "$disable_phantom_payer_before" ]]
[[ "$disable_phantom_consent_after" == "$disable_phantom_consent_before" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null --command="
DELETE FROM public.billing_subscriptions
WHERE id='$disable_phantom_group_id'::UUID
  AND studio_id='$studio_id'::UUID;
"

# Activation reservation wins: disable's first snapshot cannot see the
# uncommitted group, so it must serialize-fail after payer acquisition. A clean
# retry then observes the pending group and rejects without revoking consent.
"$psql_bin" "${psql_args[@]}" >"$activation_log" 2>&1 <<SQL &
BEGIN;
SELECT public.reserve_billing_autopay_activation_v31(
  '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
  '$account_id',1,'koaryu-autopay-v1',0.5
)->>'outcome';
SELECT pg_advisory_xact_lock(980100001);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100001);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

set +e
"$psql_bin" "${psql_args[@]}" >"$disable_log" 2>&1 <<SQL
SET statement_timeout='6s';
SELECT public.disable_billing_payer_autopay_v1(
  '$studio_id','$payer_id','$admin_id',clock_timestamp(),
  'staff_disabled_autopay'
);
SQL
disable_rc=$?
set -e
wait "$first_pid"
first_pid=""
[[ "$disable_rc" -ne 0 ]]
grep -q 'billing_payer_autopay_disable_group_changed' "$disable_log"

set +e
"$psql_bin" "${psql_args[@]}" >"$disable_log" 2>&1 <<SQL
SET statement_timeout='6s';
SELECT public.disable_billing_payer_autopay_v1(
  '$studio_id','$payer_id','$admin_id',clock_timestamp(),
  'staff_disabled_autopay'
);
SQL
disable_retry_rc=$?
set -e
[[ "$disable_retry_rc" -ne 0 ]]
grep -q 'billing_payer_autopay_disable_subscription_active' "$disable_log"

activation_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT payer.autopay_status||':'||subscription.status||':'||
       (consent.revoked_at IS NULL)::TEXT
FROM public.billing_payers payer
JOIN public.billing_subscriptions subscription ON subscription.payer_id=payer.id
JOIN public.billing_payer_payment_consents consent ON consent.payer_id=payer.id
WHERE payer.id='$payer_id'::UUID;
" | tr -d '\r\n')"
[[ "$activation_state" == "enabled:pending:true" ]]

# Reset only the race-owned group. Consent is still active because disable lost.
"$psql_bin" "${psql_args[@]}" >/dev/null --command="
DELETE FROM public.billing_subscriptions
WHERE studio_id='$studio_id'::UUID AND payer_id='$payer_id'::UUID;
"

# Disable wins: activation waits on the payer, then sees revoked consent and
# fails without inserting a stale pending group.
"$psql_bin" "${psql_args[@]}" >"$disable_first_log" 2>&1 <<SQL &
BEGIN;
SELECT public.disable_billing_payer_autopay_v1(
  '$studio_id','$payer_id','$admin_id',clock_timestamp(),
  'staff_disabled_autopay'
)->>'outcome';
SELECT pg_advisory_xact_lock(980100002);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(980100002);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

set +e
"$psql_bin" "${psql_args[@]}" >"$activation_second_log" 2>&1 <<SQL
SET statement_timeout='6s';
SELECT public.reserve_billing_autopay_activation_v31(
  '$studio_id','$admin_id','$enrollment_id','$payer_id','$plan_id',
  '$account_id',1,'koaryu-autopay-v1',0.5
);
SQL
activation_rc=$?
set -e
wait "$first_pid"
first_pid=""
[[ "$activation_rc" -ne 0 ]]
grep -q 'billing_autopay_activation_consent_invalid' "$activation_second_log"

disable_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT payer.autopay_status||':'||count(subscription.id)::TEXT||':'||
       (consent.revoked_at IS NOT NULL)::TEXT
FROM public.billing_payers payer
LEFT JOIN public.billing_subscriptions subscription ON subscription.payer_id=payer.id
JOIN public.billing_payer_payment_consents consent ON consent.payer_id=payer.id
WHERE payer.id='$payer_id'::UUID
GROUP BY payer.autopay_status,consent.revoked_at;
" | tr -d '\r\n')"
[[ "$disable_state" == "disabled:0:true" ]]

echo "PASS: autopay replay, metadata, transition, multi-group, phantom-group, and disable races are exact and deadlock-free."
