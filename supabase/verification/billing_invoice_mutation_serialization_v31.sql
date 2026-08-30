BEGIN;

DO $invoice_mutation_contract$
DECLARE
    v_admin UUID:=gen_random_uuid();
    v_other_admin UUID:=gen_random_uuid();
    v_front_desk UUID:=gen_random_uuid();
    v_studio UUID:=gen_random_uuid();
    v_payer UUID:=gen_random_uuid();
    v_invoice UUID:=gen_random_uuid();
    v_finalize UUID;
    v_void UUID;
    v_result JSONB;
    v_case RECORD;
    v_terminal_invoice UUID;
    v_terminal_first UUID;
    v_terminal_second UUID;
    v_terminal_resource UUID;
    v_retry_invoice UUID:=gen_random_uuid();
    v_retry UUID;
    v_setup_operation UUID:=gen_random_uuid();
    v_setup_request UUID:=gen_random_uuid();
    v_consent UUID:=gen_random_uuid();
    v_finalize_consent_operation UUID:=gen_random_uuid();
    v_finalize_consent_request UUID:=gen_random_uuid();
    v_finalize_consent UUID:=gen_random_uuid();
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF has_table_privilege(
        'service_role','public.billing_invoice_mutation_owners','SELECT'
    ) OR has_table_privilege(
        'authenticated','public.billing_invoice_mutation_owners','SELECT'
    ) OR has_table_privilege(
        'anon','public.billing_invoice_mutation_owners','SELECT'
    ) OR has_function_privilege(
        'authenticated',
        'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'V31 invoice mutation owner ACLs are not fail-closed.';
    END IF;

    INSERT INTO auth.users(
        id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES
        (v_admin,'authenticated','authenticated','v31-invoice-admin@example.invalid','{}','{}',now(),now()),
        (v_other_admin,'authenticated','authenticated','v31-invoice-other@example.invalid','{}','{}',now(),now()),
        (v_front_desk,'authenticated','authenticated','v31-invoice-front@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id)
    VALUES(v_studio,'V31 invoice serialization',
           'v31-invoice-'||replace(v_studio::TEXT,'-',''),v_admin);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES
        (v_studio,v_admin,'admin'),
        (v_studio,v_other_admin,'admin'),
        (v_studio,v_front_desk,'front_desk');
    INSERT INTO public.studio_payment_accounts(
        studio_id,stripe_connected_account_id,metadata
    ) VALUES(v_studio,'acct_v31invoice',jsonb_build_object('connect_account_generation',1));
    INSERT INTO public.billing_payers(
        id,studio_id,display_name,stripe_account_id,stripe_customer_id,
        connect_account_generation
    ) VALUES(v_payer,v_studio,'V31 invoice payer','acct_v31invoice','cus_v31invoice',1);
    INSERT INTO public.billing_invoices(
        id,studio_id,payer_id,invoice_type,status,amount_due_cents,
        amount_paid_cents,amount_remaining_cents,currency,stripe_invoice_id,
        stripe_account_id,stripe_customer_id,collection_method,external,metadata
    ) VALUES(v_invoice,v_studio,v_payer,'manual','draft',5000,0,5000,'usd',
             'in_v31invoice','acct_v31invoice','cus_v31invoice','charge_automatically',false,
             jsonb_build_object('connect_account_generation',1));

    v_result:=public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
        'v31-finalize-owner',repeat('a',64),'acct_v31invoice',1,gen_random_uuid(),30
    );
    v_finalize:=(v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome'<>'claimed' THEN
        RAISE EXCEPTION 'V31 finalize owner was not claimed.';
    END IF;
    BEGIN
        UPDATE public.billing_payers SET
            default_payment_method_id='pm_finalize_blocked',
            autopay_status='disabled',updated_at=clock_timestamp()
        WHERE id=v_payer;
        RAISE EXCEPTION 'Charge-automatic finalize allowed payer autopay mutation.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    BEGIN
        INSERT INTO public.billing_payer_payment_consents(
            setup_request_id,studio_id,payer_id,terms_version,
            stripe_checkout_session_id,stripe_connected_account_id,
            connect_account_generation,acceptance_proof_sha256,accepted_at,
            setup_request_expires_at
        ) VALUES(gen_random_uuid(),v_studio,v_payer,'terms-v1','cs_finalize_blocked',
            'acct_v31invoice',1,repeat('f',64),clock_timestamp(),
            clock_timestamp()+interval '1 hour');
        RAISE EXCEPTION 'Charge-automatic finalize allowed consent insert.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
        'v31-finalize-alias',repeat('a',64),'acct_v31invoice',1,gen_random_uuid(),30
    );
    IF v_result->>'outcome'<>'adopted'
       OR (v_result->'operation'->>'id')::UUID<>v_finalize THEN
        RAISE EXCEPTION 'V31 same-operation alias did not adopt one owner.';
    END IF;
    BEGIN
        PERFORM public.claim_billing_invoice_closeout_operation_v1(
            v_studio,v_other_admin,'invoice.finalize','invoice_finalize',
            v_invoice,v_payer,'v31-finalize-cross-actor',repeat('a',64),
            'acct_v31invoice',1,gen_random_uuid(),30
        );
        RAISE EXCEPTION 'V31 cross-actor mutation adoption was accepted.';
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM<>'billing_invoice_closeout_request_conflict' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_invoice_closeout_operation_v1(
            v_studio,v_admin,'invoice.void','invoice_void',v_invoice,v_payer,
            'v31-void-blocked',repeat('b',64),'acct_v31invoice',1,gen_random_uuid(),30
        );
        RAISE EXCEPTION 'V31 finalize and void acquired concurrent owners.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
            'v31-retry-blocked-by-finalize',repeat('c',64),
            'acct_v31invoice',1,gen_random_uuid(),30
        );
        RAISE EXCEPTION 'V31 finalize and retry acquired concurrent owners.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    IF (SELECT count(*) FROM public.billing_provider_operation_resources
        WHERE studio_id=v_studio AND resource_id=v_invoice)<>1 THEN
        RAISE EXCEPTION 'Blocked V31 invoice mutations created resources.';
    END IF;
    IF (SELECT default_payment_method_id FROM public.billing_payers WHERE id=v_payer)
       IS NOT NULL OR EXISTS(SELECT 1 FROM public.billing_payer_payment_consents
         WHERE stripe_checkout_session_id='cs_finalize_blocked') THEN
        RAISE EXCEPTION 'Blocked finalize consent/autopay mutation persisted.';
    END IF;

    UPDATE public.billing_provider_operations SET
        state='definitive_rejected',error_code='provider_mutation_blocked',
        definitive_rejected_at=clock_timestamp(),lease_owner=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,
        revision=revision+1,updated_at=clock_timestamp()
    WHERE id=v_finalize;
    UPDATE public.billing_payers SET
        default_payment_method_id='pm_finalize_terminal',
        autopay_status='disabled',updated_at=clock_timestamp()
    WHERE id=v_payer;
    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,provider_object_id,provider_succeeded_at,
        projected_at,completed_at,started_at,created_at,updated_at
    ) VALUES(
        v_finalize_consent_operation,v_studio,v_admin,'payer.setup',
        'finalize-terminal-consent',repeat('7',64),'acct_v31invoice',1,
        'completed',1,'cs_finalize_terminal',clock_timestamp(),clock_timestamp(),
        clock_timestamp(),clock_timestamp(),clock_timestamp(),clock_timestamp()
    );
    INSERT INTO public.billing_payer_setup_requests(
        id,operation_id,studio_id,payer_id,initiated_by,terms_version,
        stripe_connected_account_id,connect_account_generation,
        setup_request_expires_at,created_at,updated_at
    ) VALUES(
        v_finalize_consent_request,v_finalize_consent_operation,v_studio,v_payer,
        v_admin,'terms-v1','acct_v31invoice',1,clock_timestamp()+interval '1 hour',
        clock_timestamp(),clock_timestamp()
    );
    INSERT INTO public.billing_payer_payment_consents(
        id,setup_request_id,studio_id,payer_id,terms_version,
        stripe_checkout_session_id,stripe_connected_account_id,
        connect_account_generation,acceptance_proof_sha256,accepted_at,
        setup_request_expires_at
    ) VALUES(
        v_finalize_consent,v_finalize_consent_request,v_studio,v_payer,'terms-v1',
        'cs_finalize_terminal','acct_v31invoice',1,repeat('8',64),
        clock_timestamp(),clock_timestamp()+interval '1 hour'
    );
    IF NOT EXISTS(SELECT 1 FROM public.billing_payer_payment_consents
       WHERE id=v_finalize_consent) THEN
        RAISE EXCEPTION 'Consent insert did not recover after finalize terminalization.';
    END IF;
    DELETE FROM public.billing_payer_payment_consents WHERE id=v_finalize_consent;
    DELETE FROM public.billing_payer_setup_requests WHERE id=v_finalize_consent_request;
    DELETE FROM public.billing_provider_operations WHERE id=v_finalize_consent_operation;
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,'invoice.void','invoice_void',v_invoice,v_payer,
        'v31-void-owner',repeat('b',64),'acct_v31invoice',1,gen_random_uuid(),30
    );
    v_void:=(v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome'<>'claimed'
       OR v_void=v_finalize
       OR (SELECT operation_id FROM public.billing_invoice_mutation_owners
           WHERE studio_id=v_studio AND invoice_id=v_invoice)<>v_void THEN
        RAISE EXCEPTION 'V31 terminal owner did not advance to void.';
    END IF;
    v_result:=public.claim_billing_invoice_closeout_operation_v1(
        v_studio,v_admin,'invoice.finalize','invoice_finalize',v_invoice,v_payer,
        'v31-finalize-owner',repeat('a',64),'acct_v31invoice',1,gen_random_uuid(),30
    );
    IF v_result->>'outcome'<>'replay'
       OR (v_result->'operation'->>'id')::UUID<>v_finalize THEN
        RAISE EXCEPTION 'V31 historical exact mutation key did not replay.';
    END IF;

    UPDATE public.billing_provider_operations SET
        state='reconciliation_required',provider_request_attempt_count=1,
        reconciliation_reason_code='invoice_void_outcome_ambiguous',
        provider_request_in_flight_at=clock_timestamp(),
        reconciliation_required_at=clock_timestamp(),lease_owner=NULL,
        lease_acquired_at=NULL,lease_expires_at=NULL,
        revision=revision+1,updated_at=clock_timestamp()
    WHERE id=v_void;
    BEGIN
        PERFORM public.claim_billing_provider_operation_resource_v1(
            v_studio,v_admin,'invoice.retry','invoice',v_invoice,v_payer,
            'v31-retry-blocked-by-void',repeat('c',64),
            'acct_v31invoice',1,gen_random_uuid(),30
        );
        RAISE EXCEPTION 'V31 retry and void acquired concurrent owners.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.claim_billing_invoice_closeout_operation_v1(
            v_studio,v_front_desk,'invoice.void','invoice_void',v_invoice,v_payer,
            'v31-front-desk-void',repeat('b',64),'acct_v31invoice',1,gen_random_uuid(),30
        );
        RAISE EXCEPTION 'V31 Front Desk invoice mutation was accepted.';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM<>'billing_invoice_mutation_actor_forbidden' THEN RAISE; END IF;
    END;

    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,provider_object_id,
        provider_secondary_object_id,result_code,started_at,
        provider_request_in_flight_at,provider_succeeded_at,projected_at,
        completed_at,created_at,updated_at
    ) VALUES(
        v_setup_operation,v_studio,v_admin,'payer.setup','v31-retry-guard-setup',
        repeat('e',64),'acct_v31invoice',1,'completed',1,
        'cs_v31_retry_guard','seti_v31_retry_guard','payer_setup_completed',
        v_now-interval '2 minutes',v_now-interval '90 seconds',
        v_now-interval '60 seconds',v_now-interval '30 seconds',v_now,
        v_now-interval '2 minutes',v_now
    );
    INSERT INTO public.billing_payer_setup_requests(
        id,operation_id,studio_id,payer_id,initiated_by,terms_version,
        stripe_checkout_session_id,stripe_setup_intent_id,
        stripe_connected_account_id,connect_account_generation,
        setup_request_expires_at,accepted_at,completed_at,created_at,updated_at
    ) VALUES(
        v_setup_request,v_setup_operation,v_studio,v_payer,v_admin,
        'autopay_terms_v1','cs_v31_retry_guard','seti_v31_retry_guard',
        'acct_v31invoice',1,v_now+interval '1 hour',
        v_now-interval '45 seconds',v_now-interval '30 seconds',
        v_now-interval '2 minutes',v_now
    );
    INSERT INTO public.billing_payer_payment_consents(
        id,setup_request_id,studio_id,payer_id,terms_version,
        stripe_checkout_session_id,stripe_setup_intent_id,
        stripe_connected_account_id,connect_account_generation,
        acceptance_proof_sha256,accepted_at,completed_at,
        setup_request_expires_at,created_at,updated_at
    ) VALUES(
        v_consent,v_setup_request,v_studio,v_payer,'autopay_terms_v1',
        'cs_v31_retry_guard','seti_v31_retry_guard','acct_v31invoice',1,
        repeat('f',64),v_now-interval '45 seconds',
        v_now-interval '30 seconds',v_now+interval '1 hour',
        v_now-interval '2 minutes',v_now
    );
    UPDATE public.billing_payers
    SET default_payment_method_id='pm_v31_retry_guard',
        autopay_status='enabled',
        autopay_authorized_at=v_now-interval '30 seconds',
        autopay_terms_accepted_at=v_now-interval '45 seconds'
    WHERE id=v_payer AND studio_id=v_studio;
    INSERT INTO public.billing_invoices(
        id,studio_id,payer_id,invoice_type,status,amount_due_cents,
        amount_paid_cents,amount_remaining_cents,currency,stripe_invoice_id,
        stripe_account_id,stripe_customer_id,collection_method,external,metadata
    ) VALUES(
        v_retry_invoice,v_studio,v_payer,'manual','open',5000,0,5000,'usd',
        'in_v31_retry_guard','acct_v31invoice','cus_v31invoice',
        'charge_automatically',false,
        jsonb_build_object('connect_account_generation',1)
    );
    v_result:=public.claim_billing_provider_operation_resource_v1(
        v_studio,v_admin,'invoice.retry','invoice',v_retry_invoice,v_payer,
        'v31-retry-consent-owner',repeat('1',64),
        'acct_v31invoice',1,gen_random_uuid(),30
    );
    v_retry:=(v_result->'operation'->>'id')::UUID;
    UPDATE public.billing_provider_operations
    SET state='provider_request_in_flight',provider_request_attempt_count=1,
        provider_request_in_flight_at=clock_timestamp(),revision=revision+1,
        updated_at=clock_timestamp()
    WHERE id=v_retry;
    BEGIN
        UPDATE public.billing_payer_payment_consents
        SET revoked_at=clock_timestamp(),revoked_by=v_admin,
            revocation_reason_code='staff_disabled_autopay',
            revision=revision+1,updated_at=clock_timestamp()
        WHERE id=v_consent;
        RAISE EXCEPTION 'V31 consent revoked inside invoice retry mutation boundary.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    BEGIN
        UPDATE public.billing_payers
        SET autopay_status='disabled',updated_at=clock_timestamp()
        WHERE id=v_payer AND studio_id=v_studio;
        RAISE EXCEPTION 'V31 payer changed inside invoice retry mutation boundary.';
    EXCEPTION WHEN lock_not_available THEN
        IF SQLERRM<>'billing_invoice_mutation_in_progress' THEN RAISE; END IF;
    END;
    IF (SELECT revoked_at FROM public.billing_payer_payment_consents
        WHERE id=v_consent) IS NOT NULL
       OR (SELECT autopay_status FROM public.billing_payers WHERE id=v_payer)
            IS DISTINCT FROM 'enabled' THEN
        RAISE EXCEPTION 'V31 blocked payer or consent mutation persisted.';
    END IF;
    UPDATE public.billing_provider_operations
    SET state='provider_succeeded',provider_object_id='in_v31_retry_guard',
        provider_succeeded_at=clock_timestamp(),revision=revision+1,
        updated_at=clock_timestamp()
    WHERE id=v_retry;
    UPDATE public.billing_payer_payment_consents
    SET revoked_at=clock_timestamp(),revoked_by=v_admin,
        revocation_reason_code='staff_disabled_autopay',
        revision=revision+1,updated_at=clock_timestamp()
    WHERE id=v_consent;
    UPDATE public.billing_payers
    SET autopay_status='disabled',updated_at=clock_timestamp()
    WHERE id=v_payer AND studio_id=v_studio;
    IF (SELECT revoked_at FROM public.billing_payer_payment_consents
        WHERE id=v_consent) IS NULL
       OR (SELECT autopay_status FROM public.billing_payers WHERE id=v_payer)
            IS DISTINCT FROM 'disabled' THEN
        RAISE EXCEPTION 'V31 payer or consent mutation stayed blocked after provider success.';
    END IF;

    FOR v_case IN
        SELECT * FROM (VALUES
            ('invoice.finalize','invoice_finalize','draft'),
            ('invoice.void','invoice_void','open'),
            ('invoice.retry','invoice','open')
        ) AS mutation(operation_type,resource_type,invoice_status)
    LOOP
        v_terminal_invoice:=gen_random_uuid();
        INSERT INTO public.billing_invoices(
            id,studio_id,payer_id,invoice_type,status,amount_due_cents,
            amount_paid_cents,amount_remaining_cents,currency,stripe_invoice_id,
            stripe_account_id,stripe_customer_id,collection_method,external,metadata
        ) VALUES(
            v_terminal_invoice,v_studio,v_payer,'manual',v_case.invoice_status,
            900,0,900,'usd','in_'||replace(v_terminal_invoice::TEXT,'-',''),
            'acct_v31invoice','cus_v31invoice','send_invoice',false,
            jsonb_build_object('connect_account_generation',1)
        );
        IF v_case.operation_type='invoice.retry' THEN
            v_result:=public.claim_billing_provider_operation_resource_v1(
                v_studio,v_admin,v_case.operation_type,v_case.resource_type,
                v_terminal_invoice,v_payer,
                'v31-terminal-'||replace(v_case.operation_type,'.','-')||'-k1',
                repeat('d',64),'acct_v31invoice',1,gen_random_uuid(),30
            );
        ELSE
            v_result:=public.claim_billing_invoice_closeout_operation_v1(
                v_studio,v_admin,v_case.operation_type,v_case.resource_type,
                v_terminal_invoice,v_payer,
                'v31-terminal-'||replace(v_case.operation_type,'.','-')||'-k1',
                repeat('d',64),'acct_v31invoice',1,gen_random_uuid(),30
            );
        END IF;
        v_terminal_first:=(v_result->'operation'->>'id')::UUID;
        v_terminal_resource:=(v_result->'resource'->>'id')::UUID;
        UPDATE public.billing_provider_operations SET
            state='definitive_rejected',error_code='provider_mutation_blocked',
            definitive_rejected_at=clock_timestamp(),lease_owner=NULL,
            lease_acquired_at=NULL,lease_expires_at=NULL,
            revision=revision+1,updated_at=clock_timestamp()
        WHERE id=v_terminal_first;
        IF v_case.operation_type='invoice.retry' THEN
            v_result:=public.claim_billing_provider_operation_resource_v1(
                v_studio,v_admin,v_case.operation_type,v_case.resource_type,
                v_terminal_invoice,v_payer,
                'v31-terminal-'||replace(v_case.operation_type,'.','-')||'-k2',
                repeat('d',64),'acct_v31invoice',1,gen_random_uuid(),30
            );
        ELSE
            v_result:=public.claim_billing_invoice_closeout_operation_v1(
                v_studio,v_admin,v_case.operation_type,v_case.resource_type,
                v_terminal_invoice,v_payer,
                'v31-terminal-'||replace(v_case.operation_type,'.','-')||'-k2',
                repeat('d',64),'acct_v31invoice',1,gen_random_uuid(),30
            );
        END IF;
        v_terminal_second:=(v_result->'operation'->>'id')::UUID;
        IF v_result->>'outcome'<>'replaced'
           OR v_terminal_second=v_terminal_first
           OR (v_result->'resource'->>'id')::UUID<>v_terminal_resource
           OR (SELECT operation_id FROM public.billing_invoice_mutation_owners
               WHERE studio_id=v_studio AND invoice_id=v_terminal_invoice)
                <>v_terminal_second THEN
            RAISE EXCEPTION 'V31 same-operation terminal owner did not replace: %',
                v_case.operation_type;
        END IF;
        IF v_case.operation_type='invoice.retry' THEN
            v_result:=public.claim_billing_provider_operation_resource_v1(
                v_studio,v_admin,v_case.operation_type,v_case.resource_type,
                v_terminal_invoice,v_payer,
                'v31-terminal-'||replace(v_case.operation_type,'.','-')||'-k1',
                repeat('d',64),'acct_v31invoice',1,gen_random_uuid(),30
            );
        ELSE
            v_result:=public.claim_billing_invoice_closeout_operation_v1(
                v_studio,v_admin,v_case.operation_type,v_case.resource_type,
                v_terminal_invoice,v_payer,
                'v31-terminal-'||replace(v_case.operation_type,'.','-')||'-k1',
                repeat('d',64),'acct_v31invoice',1,gen_random_uuid(),30
            );
        END IF;
        IF v_result->>'outcome'<>'replay'
           OR (v_result->'operation'->>'id')::UUID<>v_terminal_first
           OR (SELECT operation_id FROM public.billing_invoice_mutation_owners
               WHERE studio_id=v_studio AND invoice_id=v_terminal_invoice)
                <>v_terminal_second THEN
            RAISE EXCEPTION 'V31 historical terminal key replay stole ownership: %',
                v_case.operation_type;
        END IF;
    END LOOP;
END;
$invoice_mutation_contract$;

ROLLBACK;
