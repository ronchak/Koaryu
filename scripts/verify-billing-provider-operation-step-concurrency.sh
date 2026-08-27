#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-billing-provider-operation-step-concurrency.sh psql host port" >&2
  exit 2
fi

psql_bin="$1"
psql_args=(--host="$2" --port="$3" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
owner_id="00000000-0000-4000-8000-000000009801"
studio_id="00000000-0000-4000-8000-000000009802"
operation_id="00000000-0000-4000-8000-000000009803"
step_id="00000000-0000-4000-8000-000000009804"
lease_id="00000000-0000-4000-8000-000000009805"
payer_id="00000000-0000-4000-8000-000000009806"
resource_invoice_id="00000000-0000-4000-8000-000000009807"
resource_student_id="00000000-0000-4000-8000-000000009808"
resource_plan_id="00000000-0000-4000-8000-000000009809"
resource_enrollment_id="00000000-0000-4000-8000-000000009810"
connect_account_id="acct_PayerIdentityConcurrency"
first_log="$(mktemp /tmp/koaryu-provider-step-first.XXXXXX)"
stale_log="$(mktemp /tmp/koaryu-payer-identity-stale.XXXXXX)"
resource_log="$(mktemp /tmp/koaryu-provider-resource-first.XXXXXX)"
first_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "$first_pid" ]] && kill -0 "$first_pid" 2>/dev/null; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  if ! "$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
BEGIN;
DELETE FROM public.billing_provider_operation_steps WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_invoice_mutation_owners WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_provider_operation_resource_aliases WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_provider_operation_resources WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_provider_operations WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_invoices WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.student_billing_enrollments WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_plans WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.students WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_payers WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.studio_payment_accounts WHERE studio_id = '$studio_id'::UUID;
DELETE FROM private.stripe_connect_account_identity_guards
WHERE stripe_connected_account_id = '$connect_account_id';
SET LOCAL session_replication_role = replica;
DELETE FROM public.staff_roles WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.studios WHERE id = '$studio_id'::UUID;
DELETE FROM auth.users WHERE id = '$owner_id'::UUID;
SET LOCAL session_replication_role = origin;
COMMIT;
SQL
  then
    echo "Failed to clean up the provider-step concurrency fixture." >&2
    exit_code=1
  fi
  rm -f "$first_log" "$stale_log" "$resource_log"
  trap - EXIT HUP INT TERM
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('$owner_id','authenticated','authenticated','provider-step-concurrency@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('$studio_id','Provider step concurrency','provider-step-concurrency','$owner_id');
INSERT INTO public.staff_roles(studio_id,user_id,role)
VALUES ('$studio_id','$owner_id','admin');
INSERT INTO public.billing_provider_operations(
  id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
  stripe_connected_account_id,connect_account_generation,
  provider_step_plan_sha256,provider_step_expected_count,provider_step_plan_registered_at,
  lease_owner,lease_acquired_at,lease_expires_at
) VALUES (
  '$operation_id','$studio_id','$owner_id','plan.sync','step-concurrency-parent',repeat('a',64),
  'acct_step_concurrency',1,repeat('b',64),2,now(),
  '$lease_id',now(),now()+interval '5 minutes'
);
INSERT INTO public.billing_provider_operation_steps(
  id,operation_id,studio_id,stripe_connected_account_id,connect_account_generation,
  step_order,step_name,provider_operation,request_sha256,stripe_idempotency_key
) VALUES
  ('$step_id','$operation_id','$studio_id','acct_step_concurrency',1,
   1,'customer.create','stripe.customers.create',repeat('1',64),'step-concurrency-customer'),
  (gen_random_uuid(),'$operation_id','$studio_id','acct_step_concurrency',1,
   2,'subscription.create','stripe.subscriptions.create',repeat('2',64),'step-concurrency-subscription');
SELECT public.claim_billing_provider_operation_step_v1(
  '$operation_id','$studio_id','$owner_id','plan.sync','step-concurrency-parent',repeat('a',64),
  'acct_step_concurrency',1,repeat('b',64),1,'customer.create','stripe.customers.create',
  repeat('1',64),'step-concurrency-customer','$lease_id',30
);
SQL

"$psql_bin" "${psql_args[@]}" >"$first_log" 2>&1 <<SQL &
BEGIN;
SELECT public.transition_billing_provider_operation_step_v1(
  '$operation_id','$studio_id','$owner_id','plan.sync','step-concurrency-parent',repeat('a',64),
  'acct_step_concurrency',1,repeat('b',64),1,'customer.create','stripe.customers.create',
  repeat('1',64),'step-concurrency-customer','$lease_id',2,'provider_request_in_flight'
);
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

if "$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL
SET statement_timeout = '6s';
SELECT public.transition_billing_provider_operation_step_v1(
  '$operation_id','$studio_id','$owner_id','plan.sync','step-concurrency-parent',repeat('a',64),
  'acct_step_concurrency',1,repeat('b',64),1,'customer.create','stripe.customers.create',
  repeat('1',64),'step-concurrency-customer','$lease_id',2,'provider_request_in_flight'
);
SQL
then
  echo "Concurrent sessions recorded the same provider step call twice." >&2
  exit 1
fi

wait "$first_pid"
first_pid=""

state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT state || ':' || provider_request_attempt_count::TEXT
FROM public.billing_provider_operation_steps WHERE id='$step_id';
")"
state="$(printf '%s' "$state" | tr -d '\r\n')"
[[ "$state" == "provider_request_in_flight:1" ]]

outcome="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT public.claim_billing_provider_operation_step_v1(
  '$operation_id','$studio_id','$owner_id','plan.sync','step-concurrency-parent',repeat('a',64),
  'acct_step_concurrency',1,repeat('b',64),1,'customer.create','stripe.customers.create',
  repeat('1',64),'step-concurrency-customer',gen_random_uuid(),30
)->>'outcome';
")"
outcome="$(printf '%s' "$outcome" | tr -d '\r\n')"
[[ "$outcome" == "provider_request_in_flight" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO public.studio_payment_accounts(
  studio_id,stripe_connected_account_id,metadata
) VALUES (
  '$studio_id','$connect_account_id','{"connect_account_generation":2}'::JSONB
);
INSERT INTO public.billing_payers(
  id,studio_id,display_name,stripe_account_id,stripe_customer_id,
  connect_account_generation
) VALUES (
  '$payer_id','$studio_id','Payer identity concurrency',
  '$connect_account_id','cus_payer_identity_concurrency',1
);
SQL

"$psql_bin" "${psql_args[@]}" >"$first_log" 2>&1 <<SQL &
BEGIN;
UPDATE public.billing_payers
SET connect_account_generation = 2
WHERE id = '$payer_id'::UUID;
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

if "$psql_bin" "${psql_args[@]}" >"$stale_log" 2>&1 <<SQL
SET statement_timeout = '6s';
UPDATE public.billing_payers
SET connect_account_generation = 1
WHERE id = '$payer_id'::UUID;
SQL
then
  echo "A delayed stale payer generation overwrote the current mapping." >&2
  exit 1
fi

wait "$first_pid"
first_pid=""
grep -q 'billing_payer_connect_identity_not_current' "$stale_log"

payer_generation="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT connect_account_generation::TEXT
FROM public.billing_payers WHERE id='$payer_id';
")"
payer_generation="$(printf '%s' "$payer_generation" | tr -d '\r\n')"
[[ "$payer_generation" == "2" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO public.billing_invoices(
  id,studio_id,payer_id,stripe_invoice_id,stripe_account_id,status
) VALUES (
  '$resource_invoice_id','$studio_id','$payer_id','in_resource_concurrency',
  '$connect_account_id','open'
);
SQL

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$resource_log" 2>&1 <<SQL &
BEGIN;
SELECT public.claim_billing_provider_operation_resource_v1(
  '$studio_id','$owner_id','invoice.retry','invoice','$resource_invoice_id',
  '$payer_id',
  'resource-concurrency-a',repeat('c',64),'$connect_account_id',2,
  gen_random_uuid(),30
)->'operation'->>'id';
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

second_resource_result="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
WITH claimed AS (
  SELECT public.claim_billing_provider_operation_resource_v1(
    '$studio_id','$owner_id','invoice.retry','invoice','$resource_invoice_id',
    '$payer_id',
    'resource-concurrency-b',repeat('c',64),'$connect_account_id',2,
    gen_random_uuid(),30
  ) AS result
)
SELECT (result->'operation'->>'id') || '|' || (result->>'outcome') FROM claimed;
")"
second_resource_result="$(printf '%s' "$second_resource_result" | tr -d '\r\n')"

wait "$first_pid"
first_pid=""
first_resource_operation="$(grep -E '^[0-9a-f]{8}-[0-9a-f-]{27}$' "$resource_log" | head -1 | tr -d '\r\n')"
[[ "$second_resource_result" == "$first_resource_operation|adopted" ]]

resource_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT
  (SELECT count(*) FROM public.billing_provider_operations
   WHERE studio_id='$studio_id' AND operation_type='invoice.retry')::TEXT || ':' ||
  (SELECT count(*) FROM public.billing_provider_operation_resource_aliases
   WHERE studio_id='$studio_id')::TEXT || ':' ||
  (public.claim_billing_provider_operation_resource_v1(
    '$studio_id','$owner_id','invoice.retry','invoice','$resource_invoice_id',
    '$payer_id',
    'resource-concurrency-b',repeat('c',64),'$connect_account_id',2,
    gen_random_uuid(),30
  )->>'outcome');
")"
resource_state="$(printf '%s' "$resource_state" | tr -d '\r\n')"
[[ "$resource_state" == "1:2:replay" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name)
VALUES ('$resource_student_id','$studio_id','Enrollment','Concurrency');
INSERT INTO public.billing_plans(id,studio_id,name,amount_cents,status)
VALUES ('$resource_plan_id','$studio_id','Enrollment concurrency plan',1000,'active');
INSERT INTO public.student_billing_enrollments(
  id,studio_id,student_id,payer_id,billing_plan_id,status
) VALUES (
  '$resource_enrollment_id','$studio_id','$resource_student_id','$payer_id',
  '$resource_plan_id','pending'
);
SQL

"$psql_bin" "${psql_args[@]}" --tuples-only --no-align >"$resource_log" 2>&1 <<SQL &
BEGIN;
SELECT public.claim_billing_provider_operation_resource_v1(
  '$studio_id','$owner_id','enrollment.activate.autopay','enrollment',
  '$resource_enrollment_id','$payer_id',
  'enrollment-concurrency-a',repeat('d',64),'$connect_account_id',2,
  gen_random_uuid(),30
)->'operation'->>'id';
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

second_resource_result="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
WITH claimed AS (
  SELECT public.claim_billing_provider_operation_resource_v1(
    '$studio_id','$owner_id','enrollment.activate.autopay','enrollment',
    '$resource_enrollment_id','$payer_id',
    'enrollment-concurrency-b',repeat('d',64),'$connect_account_id',2,
    gen_random_uuid(),30
  ) AS result
)
SELECT (result->'operation'->>'id') || '|' || (result->>'outcome') FROM claimed;
")"
second_resource_result="$(printf '%s' "$second_resource_result" | tr -d '\r\n')"

wait "$first_pid"
first_pid=""
first_resource_operation="$(grep -E '^[0-9a-f]{8}-[0-9a-f-]{27}$' "$resource_log" | head -1 | tr -d '\r\n')"
[[ "$second_resource_result" == "$first_resource_operation|adopted" ]]

resource_state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT
  (SELECT count(*) FROM public.billing_provider_operations
   WHERE studio_id='$studio_id'
     AND operation_type='enrollment.activate.autopay')::TEXT || ':' ||
  (SELECT count(*) FROM public.billing_provider_operation_resource_aliases
   WHERE studio_id='$studio_id'
     AND resource_id='$resource_enrollment_id'::UUID)::TEXT || ':' ||
  (public.claim_billing_provider_operation_resource_v1(
    '$studio_id','$owner_id','enrollment.activate.autopay','enrollment',
    '$resource_enrollment_id','$payer_id',
    'enrollment-concurrency-b',repeat('d',64),'$connect_account_id',2,
    gen_random_uuid(),30
  )->>'outcome');
")"
resource_state="$(printf '%s' "$resource_state" | tr -d '\r\n')"
[[ "$resource_state" == "1:2:replay" ]]

echo "PASS: provider-step ambiguity, payer rollback, invoice aliases, and enrollment aliases fail closed."
