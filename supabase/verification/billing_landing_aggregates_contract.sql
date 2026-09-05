BEGIN;
DO $$
DECLARE
 owner_id uuid := gen_random_uuid(); studio uuid := gen_random_uuid(); other uuid := gen_random_uuid(); payer uuid := gen_random_uuid();
 result jsonb; cohort jsonb; n integer; started timestamptz; durations numeric[]:=ARRAY[]::numeric[];
BEGIN
 INSERT INTO auth.users(id,aud,role,email) VALUES(owner_id,'authenticated','authenticated',owner_id||'@example.invalid');
 INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Billing fixture',studio::text,owner_id),(other,'Empty fixture',other::text,owner_id);
 INSERT INTO public.billing_payers(id,studio_id,display_name,billing_status) VALUES(payer,studio,'Same name','past_due');
 INSERT INTO public.billing_payers(studio_id,display_name,billing_status) VALUES(studio,'Same name','failed'),(other,'Same name','failed');
 INSERT INTO public.students(studio_id,legal_first_name,legal_last_name,status) VALUES(studio,'Same','Name','active'),(studio,'Same','Name','inactive'),(other,'Same','Name','active');
 INSERT INTO public.students(studio_id,legal_first_name,legal_last_name,status,deleted_at) VALUES(studio,'Deleted','Student','active',now());
 FOR n IN 1..201 LOOP
  INSERT INTO public.billing_invoices(studio_id,payer_id,status,amount_due_cents,amount_remaining_cents) VALUES(studio,payer,'open',100,100);
  IF n=200 THEN
   result := public.billing_landing_aggregates(studio,'2026-12-01Z','2027-01-01Z');
   ASSERT (result->>'open_invoice_amount_cents')::bigint=20000, '200 invoices';
  END IF;
 END LOOP;
 FOR n IN 1..1001 LOOP
  INSERT INTO public.billing_payments(studio_id,payer_id,status,amount_cents,net_collected_amount_cents,processed_at)
  VALUES(studio,payer,'succeeded',100,100,'2026-12-01Z');
  IF n=1000 THEN
   cohort := public.billing_payment_cohort(studio,'2026-12-01Z','2027-01-01Z');
   ASSERT (cohort->>'payment_count')::int=1000 AND (cohort->>'net_amount_cents')::bigint=100000, '1000 payments';
  END IF;
 END LOOP;
 INSERT INTO public.billing_payments(studio_id,payer_id,status,amount_cents,net_collected_amount_cents,processed_at) VALUES
 (studio,payer,'succeeded',0,0,'2026-12-31 23:59:59Z'),
 (studio,payer,'succeeded',999,999,'2027-01-01Z'),
 (studio,payer,'succeeded',999,999,NULL),
 (other,NULL,'succeeded',999,999,'2026-12-01Z');
 INSERT INTO public.billing_payments(studio_id,payer_id,status,amount_cents,net_collected_amount_cents,processed_at,idempotency_key,external_method) VALUES(studio,payer,'externally_recorded',500,500,'2026-12-31 23:59:59Z','landing-'||studio,'cash');
 result := public.billing_landing_aggregates(studio,'2026-12-01Z','2027-01-01Z');
 cohort := result->'payment_cohort';
 ASSERT (result->>'active_student_count')::int=1, 'active student count excludes soft-deleted, inactive, and other-tenant students';
 ASSERT (result->>'failed_payer_count')::int=2, 'failed payers not invoices';
 ASSERT (result->>'open_invoice_amount_cents')::bigint=20100, '201 invoices complete';
 ASSERT (cohort->>'payment_count')::int=1003, '1001 payments plus adjustment cases';
 ASSERT (cohort->>'stripe_net_amount_cents')::bigint=100100, 'explicit zero';
 ASSERT (cohort->>'external_net_amount_cents')::bigint=500, 'external separation';
 ASSERT (cohort->>'net_amount_cents')::bigint=100600, 'complete cohort';
 FOR n IN 0..20 LOOP
  started:=clock_timestamp();
  result:=public.billing_landing_aggregates(studio,'2026-12-01Z','2027-01-01Z');
  IF n>0 THEN durations:=array_append(durations,extract(epoch FROM clock_timestamp()-started)*1000); END IF;
 END LOOP;
 RAISE NOTICE 'billing_landing_sql_samples invoices=201 payments=1003 warmups=1 repetitions=20 milliseconds=%',durations;

 result := public.billing_landing_aggregates(gen_random_uuid(),'2026-12-01Z','2027-01-01Z');
 ASSERT (result->>'active_student_count')::int=0 AND (result->'payment_cohort'->>'net_amount_cents')::int=0, 'empty studio';
 -- Financial read compatibility with incomplete legacy projections. These schema
 -- changes exist only inside this rolled-back disposable fixture transaction.
 ALTER TABLE public.billing_payments ALTER COLUMN gross_paid_amount_cents DROP EXPRESSION;
 ALTER TABLE public.billing_payments ALTER COLUMN gross_paid_amount_cents DROP NOT NULL;
 ALTER TABLE public.billing_payments ALTER COLUMN net_collected_amount_cents DROP NOT NULL;
 ALTER TABLE public.billing_payments DROP CONSTRAINT billing_payments_adjustment_totals_check;
 DELETE FROM public.billing_payments WHERE studio_id=other;
 INSERT INTO public.billing_payments(studio_id,status,amount_cents,gross_paid_amount_cents,refunded_amount_cents,disputed_amount_cents,net_collected_amount_cents,processed_at) VALUES
 (other,'refunded',100,100,500,500,NULL,'2026-12-01Z'),
 (other,'disputed',200,NULL,50,500,NULL,'2026-12-01Z'),
 (other,'succeeded',300,NULL,10,20,NULL,'2026-12-01Z'),
 (other,'succeeded',400,0,0,0,0,'2026-12-01Z'),
 (other,'pending',999,999,0,0,999,'2026-12-01Z'),
 (other,'failed',999,999,0,0,999,'2026-12-01Z'),
 (other,'processing',999,999,0,0,999,'2026-12-01Z');
 cohort:=public.billing_payment_cohort(other,'2026-12-01Z','2027-01-01Z');
 ASSERT (cohort->>'payment_count')::int=4, 'accepted/excluded statuses';
 ASSERT (cohort->>'gross_paid_amount_cents')::int=600, 'null gross uses amount and explicit zero stays zero';
 ASSERT (cohort->>'refunded_amount_cents')::int=160, 'refund clamp';
 ASSERT (cohort->>'disputed_amount_cents')::int=170, 'dispute clamped to gross after refunds';
 ASSERT (cohort->>'net_amount_cents')::int=270, 'null net uses clamped adjustments';

 INSERT INTO public.stripe_events(stripe_event_id,stripe_account_id,type,payload,processing_status,livemode,processed_at,created_at,processing_started_at) VALUES
 ('landing-platform-'||studio,NULL,'platform.latest','{}','processed',false,'2026-12-04Z','2026-12-01Z',NULL),
 ('landing-account-latest-'||studio,'acct_'||studio,'connected.latest','{}','processed',false,'2026-12-05Z','2026-12-01Z',NULL),
 ('landing-account-older-'||studio,'acct_'||studio,'connected.older','{}','processed',false,'2026-12-02Z','2026-12-01Z',NULL),
 ('landing-account-pending-'||studio,'acct_'||studio,'pending','{}','pending',true,NULL,'2026-12-01Z',NULL),
 ('landing-account-processing-'||studio,'acct_'||studio,'processing','{}','processing',false,NULL,'2026-12-01Z','2026-12-01Z'),
 ('landing-account-null-start-'||studio,'acct_'||studio,'processing','{}','processing',false,NULL,'2026-12-01Z',NULL),
 ('landing-account-fresh-'||studio,'acct_'||studio,'processing','{}','processing',false,NULL,'2026-12-06Z','2026-12-06Z'),
 ('landing-other-failed-'||studio,'acct_other_'||studio,'failed','{}','failed',true,NULL,'2026-12-01Z',NULL);
 result:=public.billing_webhook_health('acct_'||studio,false,'2026-12-05Z');
 ASSERT result->('acct_'||studio)->>'latest_event_type'='connected.latest', 'connected latest event';
 ASSERT (result->('acct_'||studio)->>'pending_count')::int=1, 'pending count';
 ASSERT (result->('acct_'||studio)->>'processing_count')::int=3, 'processing count';
 ASSERT (result->('acct_'||studio)->>'stale_processing_count')::int=2, 'stale starts including null-start fallback';
 ASSERT (result->('acct_'||studio)->>'mode_mismatch_count')::int=1, 'wrong mode';
 ASSERT (result->('acct_'||studio)->>'failed_count')::int=0, 'other account excluded';
 ASSERT result->'platform'->>'latest_event_type'='platform.latest', 'platform separated';
 result:=public.billing_webhook_health(NULL,NULL,'2026-12-05Z');
 ASSERT (SELECT count(*) FROM jsonb_object_keys(result))=1, 'no connected account returns platform only';
 ASSERT (result->'platform'->>'mode_mismatch_count')::int=0, 'unknown mode';
 result:=public.billing_webhook_health('acct_empty_'||studio,false,'2026-12-05Z');
 ASSERT (result->('acct_empty_'||studio)->>'processing_count')::int=0, 'empty connected account';
 ASSERT NOT has_function_privilege('authenticated','public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','EXECUTE'), 'authenticated blocked';
 ASSERT NOT has_function_privilege('anon','public.billing_payment_cohort(uuid,timestamptz,timestamptz)','EXECUTE'), 'anon blocked';
 ASSERT has_function_privilege('service_role','public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','EXECUTE'), 'service role granted';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
 owner_id uuid:=gen_random_uuid(); studio uuid:=gen_random_uuid(); other uuid:=gen_random_uuid();
 dataset text; expected_ids uuid[]; actual_ids uuid[]; page_ids uuid[]; reference_ids uuid[];
 page_stamps timestamptz[]; anchor_stamp timestamptz; anchor_id uuid; predicate text; page_count integer;
BEGIN
 INSERT INTO auth.users(id,aud,role,email) VALUES(owner_id,'authenticated','authenticated',owner_id||'@example.invalid');
 INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'History fixture',studio::text,owner_id),(other,'Other history fixture',other::text,owner_id);
 -- A large import can give thousands of records the same creation timestamp.
 INSERT INTO public.billing_invoices(id,studio_id,status,amount_due_cents,amount_remaining_cents,created_at)
 SELECT md5(studio::text||n)::uuid,studio,'open',100,100,
  CASE WHEN n<=2 THEN '2026-11-30Z'::timestamptz WHEN n>5002 THEN '2026-12-02Z'::timestamptz ELSE '2026-12-01Z'::timestamptz END
 FROM generate_series(1,5004) n;
 INSERT INTO public.billing_payments(id,studio_id,status,amount_cents,net_collected_amount_cents,created_at)
 SELECT id,studio_id,'succeeded',100,100,created_at FROM public.billing_invoices WHERE studio_id=studio;
 INSERT INTO public.billing_invoices(studio_id,status) VALUES(other,'open');
 INSERT INTO public.billing_payments(studio_id,status,amount_cents) VALUES(other,'pending',100);
 FOREACH dataset IN ARRAY ARRAY['billing_invoices','billing_payments'] LOOP
  EXECUTE format('SELECT array_agg(id ORDER BY created_at DESC,id DESC) FROM public.%I WHERE studio_id=$1',dataset)
   INTO expected_ids USING studio;
  actual_ids:=ARRAY[]::uuid[]; anchor_stamp:=NULL; anchor_id:=NULL; page_count:=0;
  LOOP
   predicate:=CASE WHEN anchor_id IS NULL THEN '' ELSE ' AND created_at<=$2 AND (created_at<$2 OR (created_at=$2 AND id<$3))' END;
   EXECUTE format('SELECT array_agg(id ORDER BY created_at DESC,id DESC),array_agg(created_at ORDER BY created_at DESC,id DESC) FROM (SELECT id,created_at FROM public.%I WHERE studio_id=$1 %s ORDER BY created_at DESC,id DESC LIMIT 51) page',dataset,predicate)
    INTO page_ids,page_stamps USING studio,anchor_stamp,anchor_id;
   -- Compare every complete page with the original OR-only cursor query.
   EXECUTE format('SELECT array_agg(id ORDER BY created_at DESC,id DESC) FROM (SELECT id,created_at FROM public.%I WHERE studio_id=$1 %s ORDER BY created_at DESC,id DESC LIMIT 51) page',dataset,replace(predicate,' AND created_at<=$2',''))
    INTO reference_ids USING studio,anchor_stamp,anchor_id;
   ASSERT page_ids IS NOT DISTINCT FROM reference_ids, 'bounded history query preserves the original exact page IDs';
   actual_ids:=actual_ids||coalesce(page_ids[1:50],ARRAY[]::uuid[]);
   page_count:=page_count+1;
   EXIT WHEN coalesce(cardinality(page_ids),0)<=50;
   anchor_id:=page_ids[50]; anchor_stamp:=page_stamps[50];
   ASSERT page_count<=101, 'history cursor makes progress through timestamp ties';
  END LOOP;
  ASSERT cardinality(actual_ids)=5004 AND actual_ids=expected_ids, 'all invoice/payment IDs appear once, in order, within the studio';
  ASSERT page_count=101, '50-row history pages terminate after the final partial page';
 END LOOP;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE ready_row record; original_definition text; original_body text; index_name text;
BEGIN
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
 ASSERT ready_row.ready, 'V38 ready before negative checks';
 GRANT EXECUTE ON FUNCTION public.billing_landing_aggregates(uuid,timestamptz,timestamptz) TO authenticated;
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
 ASSERT NOT ready_row.ready AND 'billing_landing_reads_v38'=ANY(ready_row.security_failures), 'V38 detects browser grant drift';
 REVOKE EXECUTE ON FUNCTION public.billing_landing_aggregates(uuid,timestamptz,timestamptz) FROM authenticated;
 SELECT pg_get_functiondef(oid),prosrc INTO original_definition,original_body FROM pg_catalog.pg_proc WHERE oid='public.billing_payment_cohort(uuid,timestamptz,timestamptz)'::regprocedure;
 EXECUTE replace(original_definition,original_body,'SELECT NULL::jsonb;');
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
 ASSERT NOT ready_row.ready AND 'billing_landing_reads_v38'=ANY(ready_row.security_failures), 'V38 detects financial formula drift';
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v18();
 ASSERT NOT ready_row.ready, 'V37 compatibility cannot bless V38 drift';
 EXECUTE original_definition;
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
 ASSERT ready_row.ready, 'V38 ready after restoring exact definition';
 SELECT pg_get_functiondef(oid) INTO original_definition FROM pg_catalog.pg_proc WHERE oid='public.billing_landing_aggregates(uuid,timestamptz,timestamptz)'::regprocedure;
 EXECUTE replace(original_definition,' AND deleted_at IS NULL','');
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
 ASSERT NOT ready_row.ready AND 'billing_landing_reads_v38'=ANY(ready_row.security_failures), 'V38 detects loss of the student soft-delete filter';
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v18();
 ASSERT NOT ready_row.ready, 'V37 compatibility cannot bless a regressed student count';
 EXECUTE original_definition;
 SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
 ASSERT ready_row.ready, 'V38 ready after restoring student soft-delete filter';
 FOREACH index_name IN ARRAY ARRAY['idx_billing_invoices_studio_history','idx_billing_payments_studio_history'] LOOP
  SELECT pg_get_indexdef(to_regclass('public.'||index_name)) INTO original_definition;
  EXECUTE format('DROP INDEX public.%I',index_name);
  SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
  ASSERT NOT ready_row.ready AND 'billing_history_indexes_v38'=ANY(ready_row.security_failures), 'V38 detects a missing history index';
  SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v18();
  ASSERT NOT ready_row.ready, 'V37 compatibility cannot bless a missing history index';
  EXECUTE replace(original_definition,'created_at DESC, id DESC','id DESC, created_at DESC');
  SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
  ASSERT NOT ready_row.ready AND 'billing_history_indexes_v38'=ANY(ready_row.security_failures), 'V38 detects the wrong history index order';
  EXECUTE format('DROP INDEX public.%I',index_name);
  EXECUTE original_definition;
  -- Supabase's postgres owner cannot update pg_index. The dedicated ephemeral
  -- verifier corrupts all three flags for both indexes and checks raw/V38/V37 rejection.
  ASSERT (SELECT indisvalid AND indisready AND indislive FROM pg_catalog.pg_index
   WHERE indexrelid=to_regclass('public.'||index_name)) IS TRUE, 'restored history index is valid, ready, and live';
  SELECT * INTO ready_row FROM public.koaryu_release_schema_preflight_v19();
  ASSERT ready_row.ready, 'V38 ready after restoring the valid history index';
 END LOOP;
END $$;
ROLLBACK;
