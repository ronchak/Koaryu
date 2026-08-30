BEGIN;

DO $contract$
DECLARE
    v_actor UUID := gen_random_uuid();
    v_other UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_operation UUID := gen_random_uuid();
    v_owner UUID := gen_random_uuid();
    v_other_owner UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_invoice UUID := gen_random_uuid();
    v_sequence_owner_a UUID := gen_random_uuid();
    v_sequence_owner_b UUID := gen_random_uuid();
    v_sequence_operation UUID;
    v_before JSONB;
    v_after JSONB;
    v_result JSONB;
    v_case RECORD;
    v_definition TEXT;
    v_preflight RECORD;
BEGIN
    IF NOT has_function_privilege(
        'service_role',
        'public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'V32 preread release ACL is not service-role-only.';
    END IF;

    SELECT pg_get_functiondef(
        'public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)'::REGPROCEDURE
    ) INTO v_definition;
    REVOKE EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) FROM service_role;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v13();
    IF private.koaryu_release_invoice_retry_preread_manifest_v32() NOT LIKE '1:%'
       OR v_preflight.ready OR NOT ('invoice_retry_preread_manifest_v32'=ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'V13 accepted V32 RPC ACL drift.';
    END IF;
    GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) TO service_role;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v13();
    IF private.koaryu_release_invoice_retry_preread_manifest_v32() NOT LIKE '0:%'
       OR NOT v_preflight.ready THEN
        RAISE EXCEPTION 'V13 did not recover after restoring the V32 RPC ACL.';
    END IF;
    CREATE ROLE koaryu_v32_acl_tamper;
    GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) TO koaryu_v32_acl_tamper;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v13();
    IF private.koaryu_release_invoice_retry_preread_manifest_v32() NOT LIKE '1:%'
       OR v_preflight.ready
       OR NOT ('invoice_retry_preread_manifest_v32'=ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'V13 accepted custom-role V32 RPC EXECUTE.';
    END IF;
    REVOKE EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) FROM koaryu_v32_acl_tamper;
    DROP ROLE koaryu_v32_acl_tamper;
    GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) TO service_role WITH GRANT OPTION;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v13();
    IF private.koaryu_release_invoice_retry_preread_manifest_v32() NOT LIKE '1:%'
       OR v_preflight.ready
       OR NOT ('invoice_retry_preread_manifest_v32'=ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'V13 accepted V32 service-role GRANT OPTION.';
    END IF;
    REVOKE ALL ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) FROM service_role;
    GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) TO service_role;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v13();
    IF private.koaryu_release_invoice_retry_preread_manifest_v32() NOT LIKE '0:%'
       OR NOT v_preflight.ready THEN
        RAISE EXCEPTION 'V13 did not recover after removing V32 GRANT OPTION.';
    END IF;
    ALTER FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) RENAME TO release_billing_invoice_retry_preread_lease_v32_tampered;
    IF private.koaryu_release_invoice_retry_preread_manifest_v32() NOT LIKE '1:%' THEN
        RAISE EXCEPTION 'V32 manifest accepted signature removal.';
    END IF;
    ALTER FUNCTION public.release_billing_invoice_retry_preread_lease_v32_tampered(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) RENAME TO release_billing_invoice_retry_preread_lease_v32;
    EXECUTE replace(v_definition, 'FOR UPDATE;', 'FOR NO KEY UPDATE;');
    IF private.koaryu_release_invoice_retry_preread_manifest_v32()
       = '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
        RAISE EXCEPTION 'V32 manifest accepted RPC body drift.';
    END IF;
    EXECUTE v_definition;
    REVOKE ALL ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) FROM PUBLIC,anon,authenticated,service_role;
    GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
        UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
    ) TO service_role;

    INSERT INTO auth.users(
        id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) VALUES
        (v_actor,'authenticated','authenticated','v32-release@example.invalid','{}','{}',now(),now()),
        (v_other,'authenticated','authenticated','v32-release-other@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES
        (v_studio,'V32 preread release','v32-release-'||replace(v_studio::TEXT,'-',''),v_actor),
        (v_other_studio,'V32 preread other','v32-other-'||replace(v_other_studio::TEXT,'-',''),v_other);
    INSERT INTO public.staff_roles(studio_id,user_id,role)
    VALUES(v_studio,v_actor,'admin'),(v_other_studio,v_other,'admin');
    INSERT INTO public.studio_payment_accounts(
        studio_id,stripe_connected_account_id,metadata
    ) VALUES
        (v_studio,'acct_v32release',jsonb_build_object('connect_account_generation',1)),
        (v_other_studio,'acct_v32other',jsonb_build_object('connect_account_generation',2));
    INSERT INTO public.billing_provider_operations(
        id,studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        provider_request_attempt_count,lease_owner,lease_acquired_at,lease_expires_at,
        revision,started_at,created_at,updated_at
    ) VALUES (
        v_operation,v_studio,v_actor,'invoice.retry','v32-preread',repeat('a',64),
        'acct_v32release',1,'started',0,v_owner,
        clock_timestamp()-interval '1 second',clock_timestamp()+interval '5 minutes',
        7,clock_timestamp(),clock_timestamp(),clock_timestamp()
    );

    FOR v_case IN SELECT * FROM (VALUES
        ('studio',v_other_studio,v_actor,'v32-preread',repeat('a',64),'acct_v32release',1,v_owner,7),
        ('actor',v_studio,v_other,'v32-preread',repeat('a',64),'acct_v32release',1,v_owner,7),
        ('request_key',v_studio,v_actor,'wrong',repeat('a',64),'acct_v32release',1,v_owner,7),
        ('request_hash',v_studio,v_actor,'v32-preread',repeat('b',64),'acct_v32release',1,v_owner,7),
        ('account',v_studio,v_actor,'v32-preread',repeat('a',64),'acct_v32other',1,v_owner,7),
        ('generation',v_studio,v_actor,'v32-preread',repeat('a',64),'acct_v32release',2,v_owner,7)
    ) AS cases(label,studio_id,actor_id,request_key,request_hash,account_id,generation,owner_id,revision)
    LOOP
        BEGIN
            PERFORM public.release_billing_invoice_retry_preread_lease_v32(
                v_operation,v_case.studio_id,v_case.actor_id,v_case.request_key,
                v_case.request_hash,v_case.account_id,v_case.generation,
                v_case.owner_id,v_case.revision
            );
            RAISE EXCEPTION 'V32 preread release accepted wrong %.',v_case.label;
        EXCEPTION WHEN check_violation THEN
            IF SQLERRM <> 'billing_invoice_retry_preread_release_identity_mismatch' THEN RAISE; END IF;
        END;
    END LOOP;

    BEGIN
        PERFORM public.release_billing_invoice_retry_preread_lease_v32(
            v_operation,v_studio,v_actor,'v32-preread',repeat('a',64),
            'acct_v32release',1,v_owner,6
        );
        RAISE EXCEPTION 'V32 preread release accepted a stale revision.';
    EXCEPTION WHEN serialization_failure THEN
        IF SQLERRM <> 'billing_invoice_retry_preread_release_stale_revision' THEN RAISE; END IF;
    END;
    BEGIN
        PERFORM public.release_billing_invoice_retry_preread_lease_v32(
            v_operation,v_studio,v_actor,'v32-preread',repeat('a',64),
            'acct_v32release',1,v_other_owner,7
        );
        RAISE EXCEPTION 'V32 preread release accepted a wrong owner.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM <> 'billing_invoice_retry_preread_release_lease_not_current' THEN RAISE; END IF;
    END;

    FOR v_case IN SELECT * FROM (VALUES
        ('state_and_attempt','provider_request_in_flight',1,NULL::TEXT),
        ('provider_id','started',0,'provider')
    ) AS cases(label,state_value,attempt_count,provider_id)
    LOOP
        BEGIN
            UPDATE public.billing_provider_operations SET
                state=v_case.state_value,
                provider_request_attempt_count=v_case.attempt_count,
                provider_object_id=v_case.provider_id,
                provider_request_in_flight_at=CASE WHEN v_case.state_value='provider_request_in_flight' THEN clock_timestamp() END,
                revision=revision+1,
                updated_at=clock_timestamp()
            WHERE id=v_operation;
            PERFORM public.release_billing_invoice_retry_preread_lease_v32(
                v_operation,v_studio,v_actor,'v32-preread',repeat('a',64),
                'acct_v32release',1,v_owner,8
            );
            RAISE EXCEPTION 'V32 preread release accepted % evidence.',v_case.label;
        EXCEPTION WHEN object_not_in_prerequisite_state THEN
            IF SQLERRM <> 'billing_invoice_retry_preread_release_mutation_evidence' THEN RAISE; END IF;
        END;
    END LOOP;

    SELECT to_jsonb(operation) - ARRAY[
        'lease_owner','lease_acquired_at','lease_expires_at','revision','updated_at'
    ]::TEXT[] INTO v_before
    FROM public.billing_provider_operations AS operation WHERE id=v_operation;
    v_result := public.release_billing_invoice_retry_preread_lease_v32(
        v_operation,v_studio,v_actor,'v32-preread',repeat('a',64),
        'acct_v32release',1,v_owner,7
    );
    SELECT to_jsonb(operation) - ARRAY[
        'lease_owner','lease_acquired_at','lease_expires_at','revision','updated_at'
    ]::TEXT[] INTO v_after
    FROM public.billing_provider_operations AS operation WHERE id=v_operation;
    IF v_result->>'outcome' <> 'released'
       OR (v_result->'operation'->>'revision')::BIGINT <> 8
       OR v_result->'operation'->>'operation_type' <> 'invoice.retry'
       OR (v_result->'operation'->>'actor_id')::UUID <> v_actor
       OR v_result->'operation'->>'caller_request_key' <> 'v32-preread'
       OR v_result->'operation'->>'request_sha256' <> repeat('a',64)
       OR v_result->'operation'->>'stripe_connected_account_id' <> 'acct_v32release'
       OR (v_result->'operation'->>'connect_account_generation')::INTEGER <> 1
       OR v_result->'operation'->'provider_object_id' <> 'null'::JSONB
       OR v_result->'operation'->'provider_secondary_object_id' <> 'null'::JSONB
       OR v_result->'operation'->'provider_request_id' <> 'null'::JSONB
       OR (v_result->'operation'->'lease_owner') <> 'null'::JSONB
       OR v_before IS DISTINCT FROM v_after
       OR EXISTS (
            SELECT 1 FROM public.billing_provider_operations
            WHERE id=v_operation AND (
                revision<>8 OR lease_owner IS NOT NULL OR lease_acquired_at IS NOT NULL
                OR lease_expires_at IS NOT NULL OR state<>'started'
                OR provider_request_attempt_count<>0
            )
       ) THEN
        RAISE EXCEPTION 'V32 preread release changed fields outside the lease handoff.';
    END IF;

    BEGIN
        PERFORM public.release_billing_invoice_retry_preread_lease_v32(
            v_operation,v_studio,v_actor,'v32-preread',repeat('a',64),
            'acct_v32release',1,v_owner,8
        );
        RAISE EXCEPTION 'V32 preread release replay was accepted.';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM <> 'billing_invoice_retry_preread_release_lease_not_current' THEN RAISE; END IF;
    END;

    INSERT INTO public.billing_payers(
        id,studio_id,display_name,stripe_account_id,stripe_customer_id,
        connect_account_generation
    ) VALUES(
        v_payer,v_studio,'V32 sequence payer','acct_v32release','cus_v32release',1
    );
    INSERT INTO public.billing_invoices(
        id,studio_id,payer_id,invoice_type,status,amount_due_cents,
        amount_paid_cents,amount_remaining_cents,currency,stripe_invoice_id,
        stripe_account_id,stripe_customer_id,collection_method,external,metadata
    ) VALUES(
        v_invoice,v_studio,v_payer,'manual','open',5000,0,5000,'usd',
        'in_v32release','acct_v32release','cus_v32release','send_invoice',false,
        jsonb_build_object('connect_account_generation',1)
    );
    v_result := public.claim_billing_provider_operation_resource_v30(
        v_studio,v_actor,'invoice.retry','invoice',v_invoice,v_payer,
        'v32-sequence',repeat('c',64),'acct_v32release',1,v_sequence_owner_a,300
    );
    v_sequence_operation := (v_result->'operation'->>'id')::UUID;
    IF v_result->>'outcome' <> 'claimed'
       OR (v_result->'operation'->>'lease_owner')::UUID <> v_sequence_owner_a THEN
        RAISE EXCEPTION 'V30 sequence owner A claim failed.';
    END IF;
    v_result := public.release_billing_invoice_retry_preread_lease_v32(
        v_sequence_operation,v_studio,v_actor,'v32-sequence',repeat('c',64),
        'acct_v32release',1,v_sequence_owner_a,
        (v_result->'operation'->>'revision')::BIGINT
    );
    IF v_result->>'outcome' <> 'released' THEN
        RAISE EXCEPTION 'V32 sequence release failed.';
    END IF;
    v_result := public.claim_billing_provider_operation_resource_v30(
        v_studio,v_actor,'invoice.retry','invoice',v_invoice,v_payer,
        'v32-sequence',repeat('c',64),'acct_v32release',1,v_sequence_owner_b,300
    );
    IF (v_result->'operation'->>'id')::UUID <> v_sequence_operation
       OR (v_result->'operation'->>'lease_owner')::UUID <> v_sequence_owner_b
       OR (v_result->'operation'->>'revision')::BIGINT < 3 THEN
        RAISE EXCEPTION 'V30 sequence owner B did not reclaim the released operation.';
    END IF;
    v_result := public.transition_billing_provider_operation_v1(
        v_sequence_operation,v_studio,v_actor,'invoice.retry','v32-sequence',
        repeat('c',64),'acct_v32release',1,v_sequence_owner_b,
        (v_result->'operation'->>'revision')::BIGINT,'provider_request_in_flight'
    );
    IF v_result->'operation'->>'state' <> 'provider_request_in_flight'
       OR (v_result->'operation'->>'provider_request_attempt_count')::INTEGER <> 1
       OR (v_result->'operation'->>'lease_owner')::UUID <> v_sequence_owner_b THEN
        RAISE EXCEPTION 'V30 sequence owner B provider transition failed.';
    END IF;
END;
$contract$;

ROLLBACK;
