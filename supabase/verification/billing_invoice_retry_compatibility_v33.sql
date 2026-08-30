BEGIN;

DO $contract$
DECLARE
 v_admin UUID:=gen_random_uuid(); v_other UUID:=gen_random_uuid();
 v_studio UUID:=gen_random_uuid(); v_payer UUID:=gen_random_uuid();
 v_invoice UUID:=gen_random_uuid(); v_invoice_two UUID:=gen_random_uuid();
 v_owner_a UUID:=gen_random_uuid();
 v_owner_b UUID:=gen_random_uuid(); v_operation UUID; v_revision BIGINT;
 v_base TEXT; v_result JSONB; v_ledger_count INTEGER;
 v_operation_row public.billing_provider_operations%ROWTYPE;
BEGIN
 IF private.billing_invoice_retry_base_hash_v33(
   '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',
   'in_v33','acct_v33',1)
   <> 'dcd80bb09de6446f4200bb177677a626986134020c6aa296a87b6fac4d4e7dd9' THEN
   RAISE EXCEPTION 'V33 Python hash vector one drifted.';
 END IF;
 IF private.billing_invoice_retry_base_hash_v33(
   '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
   E'in_escaped\\quote"',E'acct_escaped\\quote"',27)
   <> 'daefff3c53d776e2cd7197905f80cf860ffb37329bdceef3f642406217e0893c' THEN
   RAISE EXCEPTION 'V33 Python escaping hash vector drifted.';
 END IF;
 IF has_table_privilege('service_role','private.billing_invoice_retry_hash_ledger_v33','SELECT')
    OR has_table_privilege('service_role','private.billing_invoice_retry_hash_ledger_v33','UPDATE')
    OR has_table_privilege('service_role','private.billing_invoice_retry_hash_ledger_v33','DELETE')
    OR has_table_privilege('service_role','private.billing_invoice_retry_hash_capture_control_v33','SELECT')
    OR has_function_privilege('authenticated',
      'public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)','EXECUTE') THEN
   RAISE EXCEPTION 'V33 ACL contract is not fail closed.';
 END IF;
 INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 VALUES(v_admin,'authenticated','authenticated','v33-admin@example.invalid','{}','{}',now(),now()),
       (v_other,'authenticated','authenticated','v33-other@example.invalid','{}','{}',now(),now());
 INSERT INTO public.studios(id,name,slug,owner_id)
 VALUES(v_studio,'V33 compatibility','v33-'||replace(v_studio::text,'-',''),v_admin);
 INSERT INTO public.staff_roles(studio_id,user_id,role)
 VALUES(v_studio,v_admin,'admin'),(v_studio,v_other,'admin');
 INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata)
 VALUES(v_studio,'acct_v33contract',jsonb_build_object('connect_account_generation',1));
 INSERT INTO public.billing_payers(id,studio_id,display_name,stripe_account_id,stripe_customer_id,connect_account_generation)
 VALUES(v_payer,v_studio,'V33 payer','acct_v33contract','cus_v33contract',1);
 INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,
   amount_due_cents,amount_paid_cents,amount_remaining_cents,currency,
   stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,external,metadata)
 VALUES(v_invoice,v_studio,v_payer,'manual','open',5000,0,5000,'usd',
   'in_v33contract','acct_v33contract','cus_v33contract','send_invoice',false,
   jsonb_build_object('connect_account_generation',1));
 v_base:=private.billing_invoice_retry_base_hash_v33(
   v_studio,v_invoice,'in_v33contract','acct_v33contract',1);
 v_result:=public.claim_billing_provider_operation_resource_v30(
   v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
   'v33-legacy-key',repeat('a',64),'acct_v33contract',1,v_owner_a,300);
 v_operation:=(v_result->'operation'->>'id')::UUID;
 v_revision:=(v_result->'operation'->>'revision')::BIGINT;
 SELECT count(*) INTO v_ledger_count FROM private.billing_invoice_retry_hash_ledger_v33
 WHERE operation_id=v_operation AND caller_request_key='v33-legacy-key'
   AND persisted_request_sha256=repeat('a',64) AND base_request_sha256=v_base;
 IF v_ledger_count<>1 THEN RAISE EXCEPTION 'V33 old-writer capture failed.'; END IF;
 UPDATE public.billing_invoices SET metadata=COALESCE(metadata,'{}'::JSONB)
   -'connect_account_generation' WHERE id=v_invoice;
 PERFORM private.resolve_billing_invoice_retry_identity_v33(
   v_operation,v_studio,v_invoice,v_payer);
 UPDATE public.billing_invoices SET metadata=jsonb_set(
   COALESCE(metadata,'{}'::JSONB),'{connect_account_generation}','1'::JSONB,true)
 WHERE id=v_invoice;
 FOR v_result IN SELECT value FROM (VALUES
   ('null'::JSONB),('""'::JSONB),('"malformed"'::JSONB),('0'::JSONB),('-1'::JSONB),('2'::JSONB)
 ) AS cases(value)
 LOOP
   BEGIN
     UPDATE public.billing_invoices SET metadata=jsonb_set(
       COALESCE(metadata,'{}'::JSONB),'{connect_account_generation}',v_result,true)
     WHERE id=v_invoice;
     PERFORM private.resolve_billing_invoice_retry_identity_v33(
       v_operation,v_studio,v_invoice,v_payer);
     RAISE EXCEPTION 'V33 invalid invoice generation metadata was accepted.';
   EXCEPTION WHEN check_violation THEN
     IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
   END;
 END LOOP;
 BEGIN
   UPDATE public.billing_invoices SET stripe_customer_id='cus_wrong' WHERE id=v_invoice;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 invoice customer mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 BEGIN
   UPDATE public.billing_invoices SET stripe_account_id='acct_wrong' WHERE id=v_invoice;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 invoice account mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 BEGIN
   ALTER TABLE public.billing_payers DISABLE TRIGGER USER;
   UPDATE public.billing_payers SET stripe_customer_id='cus_wrong' WHERE id=v_payer;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 payer customer mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 BEGIN
   ALTER TABLE public.billing_payers DISABLE TRIGGER USER;
   UPDATE public.billing_payers SET stripe_account_id='acct_wrong' WHERE id=v_payer;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 payer account mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 BEGIN
   ALTER TABLE public.billing_payers DISABLE TRIGGER USER;
   UPDATE public.billing_payers SET connect_account_generation=2 WHERE id=v_payer;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 payer generation mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 BEGIN
   ALTER TABLE public.studio_payment_accounts DISABLE TRIGGER USER;
   UPDATE public.studio_payment_accounts SET stripe_connected_account_id='acct_wrong'
   WHERE studio_id=v_studio;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 current studio account mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 BEGIN
   UPDATE public.studio_payment_accounts SET metadata=jsonb_build_object('connect_account_generation',2)
   WHERE studio_id=v_studio;
   PERFORM private.resolve_billing_invoice_retry_identity_v33(v_operation,v_studio,v_invoice,v_payer);
   RAISE EXCEPTION 'V33 current studio generation mismatch was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 SELECT * INTO v_operation_row FROM public.billing_provider_operations WHERE id=v_operation;
 IF NOT private.billing_invoice_retry_preread_zero_evidence_v33(
    v_operation_row,'absent') THEN
   RAISE EXCEPTION 'V33 shared preread helper rejected clean release state.';
 END IF;
 BEGIN
   UPDATE public.billing_provider_operations SET result_code='unexpected_evidence',
    revision=revision+1,updated_at=clock_timestamp() WHERE id=v_operation;
   SELECT * INTO v_operation_row FROM public.billing_provider_operations WHERE id=v_operation;
   IF private.billing_invoice_retry_preread_zero_evidence_v33(
      v_operation_row,'absent') THEN
     RAISE EXCEPTION 'V33 shared helper accepted parent result evidence.';
   END IF;
   RAISE EXCEPTION 'v33_parent_evidence_rollback';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>'v33_parent_evidence_rollback' THEN RAISE; END IF;
 END;
 BEGIN
   UPDATE private.billing_invoice_retry_hash_ledger_v33 SET actor_id=v_other
   WHERE operation_id=v_operation;
   RAISE EXCEPTION 'V33 ledger mutation was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_hash_ledger_immutable' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_other,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,v_owner_a,v_revision,'provider_preread_failed');
   RAISE EXCEPTION 'V33 wrong actor release accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_identity_mismatch' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,gen_random_uuid(),v_revision,'provider_preread_failed');
   RAISE EXCEPTION 'V33 wrong lease owner accepted.';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_lease_not_current' THEN RAISE; END IF;
 END;
 BEGIN
   ALTER TABLE public.billing_invoice_mutation_owners
    DROP CONSTRAINT billing_invoice_mutation_owners_pair_exact,
    DROP CONSTRAINT billing_invoice_mutation_owners_resource_fkey;
   ALTER TABLE public.billing_invoice_mutation_owners DISABLE TRIGGER USER;
   UPDATE public.billing_invoice_mutation_owners SET resource_type='invoice_void'
   WHERE studio_id=v_studio AND invoice_id=v_invoice;
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,v_owner_a,v_revision,'provider_preread_failed');
   RAISE EXCEPTION 'V33 tampered owner tuple was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_identity_mismatch' THEN RAISE; END IF;
 END;
 BEGIN
   ALTER TABLE public.billing_invoice_mutation_owners
    DROP CONSTRAINT billing_invoice_mutation_owners_resource_fkey;
   ALTER TABLE public.billing_provider_operation_resource_aliases
    DROP CONSTRAINT billing_provider_operation_resource_aliases_resource_fkey,
    DROP CONSTRAINT billing_provider_operation_resource_aliases_resource_v31_fkey;
   ALTER TABLE public.billing_provider_operation_resources
    DROP CONSTRAINT billing_provider_operation_resources_pair_exact;
   ALTER TABLE public.billing_provider_operation_resources DISABLE TRIGGER USER;
   UPDATE public.billing_provider_operation_resources SET resource_type='invoice_void'
   WHERE operation_id=v_operation;
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,v_owner_a,v_revision,'provider_preread_failed');
   RAISE EXCEPTION 'V33 tampered resource tuple was accepted.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_identity_mismatch' THEN RAISE; END IF;
 END;
 BEGIN
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,v_owner_a,v_revision,'arbitrary_reason');
   RAISE EXCEPTION 'V33 arbitrary release reason accepted.';
 EXCEPTION WHEN invalid_parameter_value THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_reason_invalid' THEN RAISE; END IF;
 END;
 BEGIN
   UPDATE public.billing_provider_operations SET lease_acquired_at=NULL,
    revision=revision+1,updated_at=clock_timestamp() WHERE id=v_operation;
   RAISE EXCEPTION 'V33 null lease acquisition persisted.';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
   UPDATE public.billing_provider_operations SET lease_expires_at=NULL,
    revision=revision+1,updated_at=clock_timestamp() WHERE id=v_operation;
   RAISE EXCEPTION 'V33 null lease expiry persisted.';
 EXCEPTION WHEN check_violation THEN NULL;
 END;
 BEGIN
   UPDATE public.billing_provider_operations SET
    lease_acquired_at=clock_timestamp()+interval '1 minute',
    lease_expires_at=clock_timestamp()+interval '2 minutes',
    revision=revision+1,updated_at=clock_timestamp() WHERE id=v_operation;
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,v_owner_a,v_revision+1,'provider_preread_failed');
   RAISE EXCEPTION 'V33 future lease acquisition accepted.';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_lease_not_current' THEN RAISE; END IF;
 END;
 BEGIN
   UPDATE public.billing_provider_operations SET
    lease_acquired_at=clock_timestamp()-interval '2 minutes',
    lease_expires_at=clock_timestamp()-interval '1 minute',
    revision=revision+1,updated_at=clock_timestamp() WHERE id=v_operation;
   PERFORM public.release_billing_invoice_retry_preread_lease_v33(
    v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
    'acct_v33contract',1,v_owner_a,v_revision+1,'provider_preread_failed');
   RAISE EXCEPTION 'V33 expired lease accepted.';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'billing_invoice_retry_preread_release_v33_lease_not_current' THEN RAISE; END IF;
 END;
 v_result:=public.release_billing_invoice_retry_preread_lease_v33(
   v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
   'acct_v33contract',1,v_owner_a,v_revision,'provider_preread_failed');
 IF v_result->'operation'->>'invoice_retry_preread_release_reason'<>'provider_preread_failed'
    OR v_result->'operation'->>'lease_owner' IS NOT NULL THEN
   RAISE EXCEPTION 'V33 release marker or lease state invalid.';
 END IF;
 BEGIN
   PERFORM public.claim_billing_invoice_closeout_operation_v1(
    v_studio,v_other,'invoice.void','invoice_void',v_invoice,v_payer,
    'v33-void-blocked',repeat('b',64),'acct_v33contract',1,gen_random_uuid(),30);
   RAISE EXCEPTION 'V33 released retry lost mutation ownership.';
 EXCEPTION WHEN lock_not_available THEN
   IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
 END;
 BEGIN
 v_result:=public.claim_billing_provider_operation_resource_v1(
   v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
   'v33-legacy-key',repeat('a',64),'acct_v33contract',1,v_owner_b,300);
 IF v_result->>'compatibility_outcome'<>'ledger_legacy_hash_replay'
    OR (v_result->'operation'->>'lease_owner')::UUID<>v_owner_b THEN
   RAISE EXCEPTION 'V33 old-writer persisted resume failed.';
 END IF;
 v_result:=public.transition_billing_provider_operation_v1(
   v_operation,v_studio,v_admin,'invoice.retry','v33-legacy-key',repeat('a',64),
   'acct_v33contract',1,v_owner_b,
   (v_result->'operation'->>'revision')::BIGINT,'provider_request_in_flight');
 IF v_result->'operation'->>'state'<>'provider_request_in_flight'
    OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER<>1 THEN
   RAISE EXCEPTION 'V33 old-writer transition failed.';
 END IF;
 RAISE EXCEPTION 'v33_old_writer_sequence_rollback';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM<>'v33_old_writer_sequence_rollback' THEN RAISE; END IF;
 END;
 v_result:=public.claim_billing_provider_operation_resource_v1(
   v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
   'v33-legacy-key',v_base,'acct_v33contract',1,v_owner_b,300);
 IF v_result->>'compatibility_outcome'<>'ledger_legacy_hash_accepted'
    OR v_result->>'effective_persisted_sha256'<>repeat('a',64)
    OR (v_result->'operation'->>'lease_owner')::UUID<>v_owner_b THEN
   RAISE EXCEPTION 'V33 compatibility reclaim failed.';
 END IF;
 INSERT INTO private.billing_invoice_retry_hash_ledger_v33(
   operation_id,resource_claim_id,studio_id,invoice_id,payer_id,actor_id,
   operation_caller_request_key,caller_request_key,
   stripe_connected_account_id,connect_account_generation,
   stripe_invoice_id,persisted_request_sha256,base_request_sha256)
 VALUES(gen_random_uuid(),gen_random_uuid(),v_studio,v_invoice,v_payer,v_admin,
   'v33-dangling','v33-dangling','acct_v33contract',1,'in_v33contract',repeat('f',64),v_base);
 BEGIN
   PERFORM public.claim_billing_provider_operation_resource_v1(
    v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
    'v33-dangling',v_base,'acct_v33contract',1,gen_random_uuid(),30);
   RAISE EXCEPTION 'V33 dangling ledger row was active.';
 EXCEPTION WHEN check_violation THEN
   IF SQLERRM<>'billing_invoice_retry_identity_resolution_failed' THEN RAISE; END IF;
 END;
 PERFORM public.finalize_billing_invoice_retry_hash_capture_v33(
   1,repeat('c',40),repeat('d',64));
 BEGIN
   PERFORM public.claim_billing_provider_operation_resource_v1(
    v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
    'v33-legacy-key',repeat('a',64),'acct_v33contract',1,v_owner_b,300);
   RAISE EXCEPTION 'V33 persisted-form caller survived finalization.';
 EXCEPTION WHEN unique_violation THEN
   IF SQLERRM<>'billing_invoice_retry_v33_base_hash_mismatch' THEN RAISE; END IF;
 END;
 v_result:=public.claim_billing_provider_operation_resource_v1(
   v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
   'v33-legacy-key',v_base,'acct_v33contract',1,v_owner_b,300);
 IF v_result->>'compatibility_outcome'<>'ledger_legacy_hash_accepted' THEN
   RAISE EXCEPTION 'V33 base-form replay failed after finalization.';
 END IF;
 INSERT INTO public.billing_invoices(id,studio_id,payer_id,invoice_type,status,
   amount_due_cents,amount_paid_cents,amount_remaining_cents,currency,
   stripe_invoice_id,stripe_account_id,stripe_customer_id,collection_method,external,metadata)
 VALUES(v_invoice_two,v_studio,v_payer,'manual','open',1000,0,1000,'usd',
   'in_v33contract_two','acct_v33contract','cus_v33contract','send_invoice',false,
   jsonb_build_object('connect_account_generation',1));
 BEGIN
   PERFORM public.claim_billing_provider_operation_resource_v30(
    v_studio,v_admin,'invoice.retry','invoice',v_invoice_two,v_payer,
    'v33-disabled-legacy',repeat('e',64),'acct_v33contract',1,gen_random_uuid(),30);
   RAISE EXCEPTION 'V33 legacy creation survived capture disable.';
 EXCEPTION WHEN unique_violation THEN
   IF SQLERRM<>'billing_provider_operation_resource_alias_conflict' THEN RAISE; END IF;
 END;
 IF EXISTS(SELECT 1 FROM public.billing_provider_operations
    WHERE studio_id=v_studio AND caller_request_key='v33-disabled-legacy')
    OR EXISTS(SELECT 1 FROM private.billing_invoice_retry_hash_ledger_v33
    WHERE studio_id=v_studio AND caller_request_key='v33-disabled-legacy') THEN
   RAISE EXCEPTION 'V33 disabled legacy failure was not atomic.';
 END IF;
 v_revision:=(v_result->'operation'->>'revision')::BIGINT;
 v_result:=public.release_billing_invoice_retry_preread_lease_v33(
   v_operation,v_studio,v_admin,'v33-legacy-key',repeat('a',64),
   'acct_v33contract',1,v_owner_b,v_revision,'local_consent_preread_unavailable');
 IF v_result->'operation'->>'invoice_retry_preread_release_reason'
    <>'local_consent_preread_unavailable' THEN
   RAISE EXCEPTION 'V33 local consent preread reason was not recorded.';
 END IF;
 UPDATE public.billing_payers SET autopay_status='disabled' WHERE id=v_payer;
 IF NOT EXISTS(SELECT 1 FROM public.billing_provider_operations
   WHERE id=v_operation AND state='definitive_rejected'
    AND error_code='invoice_retry_consent_changed_before_provider'
    AND invoice_retry_preread_released_at IS NULL) THEN
   RAISE EXCEPTION 'V33 consent-first terminalization failed.';
 END IF;
 v_result:=public.claim_billing_invoice_closeout_operation_v1(
   v_studio,v_other,'invoice.void','invoice_void',v_invoice,v_payer,
   'v33-void-after-consent',repeat('b',64),'acct_v33contract',1,gen_random_uuid(),30);
 IF v_result->'operation'->>'operation_type'<>'invoice.void' THEN
   RAISE EXCEPTION 'V33 terminal owner did not advance.';
 END IF;
END;
$contract$;

ROLLBACK;
