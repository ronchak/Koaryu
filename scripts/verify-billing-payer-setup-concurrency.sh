#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: scripts/verify-billing-payer-setup-concurrency.sh psql host port" >&2
  exit 2
fi

psql_bin="$1"
psql_args=(--host="$2" --port="$3" --username=postgres --dbname=postgres --no-password --no-psqlrc --set=ON_ERROR_STOP=1 --quiet)
owner_id="00000000-0000-4000-8000-000000009701"
studio_id="00000000-0000-4000-8000-000000009702"
payer_id="00000000-0000-4000-8000-000000009703"
operation_one="00000000-0000-4000-8000-000000009704"
operation_two="00000000-0000-4000-8000-000000009705"
operation_three="00000000-0000-4000-8000-000000009706"
request_one="00000000-0000-4000-8000-000000009707"
request_two="00000000-0000-4000-8000-000000009708"
request_three="00000000-0000-4000-8000-000000009709"
lease_one="00000000-0000-4000-8000-000000009710"
lease_two="00000000-0000-4000-8000-000000009711"
lease_three="00000000-0000-4000-8000-000000009712"
first_log="$(mktemp /tmp/koaryu-payer-setup-first.XXXXXX)"
first_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "$first_pid" ]] && kill -0 "$first_pid" 2>/dev/null; then
    kill "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  if ! "$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
BEGIN;
DELETE FROM public.billing_payer_payment_consents WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_payer_setup_requests WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_provider_operations WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.billing_payers WHERE studio_id = '$studio_id'::UUID;
SET LOCAL session_replication_role = replica;
DELETE FROM public.staff_roles WHERE studio_id = '$studio_id'::UUID;
DELETE FROM public.studios WHERE id = '$studio_id'::UUID;
DELETE FROM auth.users WHERE id = '$owner_id'::UUID;
SET LOCAL session_replication_role = origin;
COMMIT;
SQL
  then
    echo "Failed to clean up the payer setup concurrency fixture." >&2
    exit_code=1
  fi
  rm -f "$first_log"
  trap - EXIT HUP INT TERM
  exit "$exit_code"
}
trap cleanup EXIT HUP INT TERM

"$psql_bin" "${psql_args[@]}" <<SQL
INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('$owner_id','authenticated','authenticated','payer-setup-concurrency@example.invalid','{}','{}',now(),now());
INSERT INTO public.studios(id,name,slug,owner_id)
VALUES ('$studio_id','Payer setup concurrency','payer-setup-concurrency','$owner_id');
INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES ('$studio_id','$owner_id','admin');
INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id)
VALUES ('$payer_id','$studio_id','Concurrency payer','acct_setup_concurrency');
INSERT INTO public.billing_provider_operations(
  id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
  stripe_connected_account_id,connect_account_generation,lease_owner,
  lease_acquired_at,lease_expires_at
) VALUES
  ('$operation_one','$studio_id','$owner_id','payer.setup','setup-key-one',repeat('1',64),'acct_setup_concurrency',1,'$lease_one',now(),now()+interval '5 minutes'),
  ('$operation_two','$studio_id','$owner_id','payer.setup','setup-key-two',repeat('2',64),'acct_setup_concurrency',1,'$lease_two',now(),now()+interval '5 minutes'),
  ('$operation_three','$studio_id','$owner_id','payer.setup','setup-key-three',repeat('3',64),'acct_setup_concurrency',1,'$lease_three',now(),now()+interval '5 minutes');
SQL

"$psql_bin" "${psql_args[@]}" >"$first_log" 2>&1 <<SQL &
BEGIN;
SELECT public.prepare_billing_payer_setup_request_v1(
  '$operation_one','$request_one','$studio_id','$owner_id','$payer_id','terms-concurrency',
  'acct_setup_concurrency',1,'$lease_one',1,now()+interval '30 minutes'
);
SELECT pg_advisory_xact_lock(970100001);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(970100001);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "${held:-f}" == "t" ]]

"$psql_bin" "${psql_args[@]}" <<SQL
SET statement_timeout = '6s';
SELECT public.prepare_billing_payer_setup_request_v1(
  '$operation_two','$request_two','$studio_id','$owner_id','$payer_id','terms-concurrency',
  'acct_setup_concurrency',1,'$lease_two',1,now()+interval '30 minutes'
);
SQL
wait "$first_pid"
first_pid=""

state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT
  (SELECT state FROM public.billing_provider_operations WHERE id='$operation_one') || ':' ||
  (SELECT count(*) FROM public.billing_payer_setup_requests WHERE studio_id='$studio_id' AND completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL)::TEXT;
")"
state="$(printf '%s' "$state" | tr -d '\r\n')"
[[ "$state" == "definitive_rejected:1" ]]

"$psql_bin" "${psql_args[@]}" <<SQL
SELECT public.transition_billing_provider_operation_v1(
  p_operation_id => '$operation_two', p_studio_id => '$studio_id', p_actor_id => '$owner_id',
  p_operation_type => 'payer.setup', p_caller_request_key => 'setup-key-two',
  p_request_sha256 => repeat('2',64), p_stripe_connected_account_id => 'acct_setup_concurrency',
  p_connect_account_generation => 1, p_lease_owner => '$lease_two', p_expected_revision => 1,
  p_to_state => 'provider_request_in_flight'
);
SQL

if "$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL
SELECT public.prepare_billing_payer_setup_request_v1(
  '$operation_three','$request_three','$studio_id','$owner_id','$payer_id','terms-concurrency',
  'acct_setup_concurrency',1,'$lease_three',1,now()+interval '30 minutes'
);
SQL
then
  echo "A second setup request replaced an ambiguous provider attempt." >&2
  exit 1
fi

if "$psql_bin" "${psql_args[@]}" >/dev/null 2>&1 <<SQL
SELECT public.close_billing_payer_setup_request_v1(
  '$request_two','$operation_two','$studio_id','$payer_id','cs_setup_concurrency',
  'acct_setup_concurrency',1,'checkout_session_expired',repeat('4',64)
);
SQL
then
  echo "An in-flight setup operation was closed without definitive provider evidence." >&2
  exit 1
fi

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
SELECT public.transition_billing_provider_operation_v1(
  p_operation_id => '$operation_two', p_studio_id => '$studio_id', p_actor_id => '$owner_id',
  p_operation_type => 'payer.setup', p_caller_request_key => 'setup-key-two',
  p_request_sha256 => repeat('2',64), p_stripe_connected_account_id => 'acct_setup_concurrency',
  p_connect_account_generation => 1, p_lease_owner => '$lease_two', p_expected_revision => 2,
  p_to_state => 'provider_succeeded', p_provider_object_id => 'cs_setup_concurrency'
);
SELECT public.bind_billing_payer_setup_session_v1(
  '$request_two','$operation_two','$studio_id','$payer_id','cs_setup_concurrency',
  'acct_setup_concurrency',1,1
);
SQL

"$psql_bin" "${psql_args[@]}" >"$first_log" 2>&1 <<SQL &
BEGIN;
SELECT public.close_billing_payer_setup_request_v1(
  '$request_two','$operation_two','$studio_id','$payer_id','cs_setup_concurrency',
  'acct_setup_concurrency',1,'checkout_session_expired',repeat('4',64)
);
SELECT pg_advisory_xact_lock(970100002);
SELECT pg_sleep(1);
COMMIT;
SQL
first_pid="$!"

held="f"
for _attempt in {1..80}; do
  held="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command='SELECT NOT pg_try_advisory_lock(970100002);')"
  [[ "$held" == "t" ]] && break
  sleep 0.05
done
[[ "$held" == "t" ]]

"$psql_bin" "${psql_args[@]}" >/dev/null <<SQL
SET statement_timeout = '6s';
SELECT public.prepare_billing_payer_setup_request_v1(
  '$operation_three','$request_three','$studio_id','$owner_id','$payer_id','terms-concurrency',
  'acct_setup_concurrency',1,'$lease_three',1,now()+interval '30 minutes'
);
SQL
wait "$first_pid"
first_pid=""

state="$("$psql_bin" "${psql_args[@]}" --tuples-only --no-align --command="
SELECT
  (SELECT state FROM public.billing_provider_operations WHERE id='$operation_two') || ':' ||
  (SELECT close_reason_code FROM public.billing_payer_setup_requests WHERE id='$request_two') || ':' ||
  (SELECT count(*) FROM public.billing_payer_setup_requests WHERE studio_id='$studio_id' AND completed_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL)::TEXT;
")"
state="$(printf '%s' "$state" | tr -d '\r\n')"
[[ "$state" == "definitive_rejected:checkout_session_expired:1" ]]

echo "PASS: payer setup requests serialize, block ambiguous Sessions, and allow one new request only after proof-backed close."
