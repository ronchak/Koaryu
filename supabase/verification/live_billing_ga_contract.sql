-- Current GA policy: no pilot grant/checkpoint enrollment, exact provider authority.
BEGIN;
DO $ga$
DECLARE
    owner_id UUID := gen_random_uuid();
    studios UUID[] := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
    studio UUID;
    op TEXT;
    role_name TEXT;
    bootstrap UUID;
    result RECORD;
    request JSONB := '{"business_name":"GA fixture","contact_email":null,"business_entity_type":"company","refresh_url":"https://example.invalid/refresh","return_url":"https://example.invalid/return"}';
    account_key TEXT;
    link_key TEXT;
    event_id UUID;
    legacy_checkpoint UUID;
BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        IF has_function_privilege(role_name, 'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)', 'EXECUTE')
           OR has_function_privilege(role_name, 'public.studio_live_billing_supported_operations_v58(uuid,text)', 'EXECUTE')
           OR has_function_privilege(role_name, 'private.live_billing_ga_events_clear_v58()', 'EXECUTE')
           OR has_function_privilege(role_name, 'private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)', 'EXECUTE') THEN
            RAISE EXCEPTION 'GA authority exposed to %', role_name;
        END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', 'public.studio_live_billing_supported_operations_v58(uuid,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'Missing service capability RPC privilege';
    END IF;
    INSERT INTO auth.users(id,aud,role,email) VALUES(owner_id,'authenticated','authenticated','ga-'||owner_id||'@example.invalid');
    FOREACH studio IN ARRAY studios LOOP
        INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'GA fixture','ga-'||studio,owner_id);
    END LOOP;
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,status,charges_enabled,payouts_enabled,details_submitted,requirements_due,metadata)
    VALUES (studios[1],'acct_GaOne','charges_enabled',true,true,true,ARRAY[]::TEXT[],'{"connect_account_generation":1}'),
           (studios[2],'acct_GaTwo','charges_enabled',true,true,true,ARRAY[]::TEXT[],'{"connect_account_generation":1}'),
           (studios[3],NULL,'not_connected',false,false,false,ARRAY[]::TEXT[],'{"connect_account_generation":1}');
    -- No checkpoint or grant exists. The only history is fully processed and old.
    INSERT INTO public.stripe_events(stripe_event_id,stripe_account_id,livemode,type,payload,processing_status,processed_at,created_at)
    VALUES('evt_GaQuiet','acct_GaOne',true,'invoice.paid','{}','processed',now()-INTERVAL '40 days',now()-INTERVAL '40 days');
    FOREACH op IN ARRAY private.live_billing_ga_operations_v58('connect_payments') LOOP
        PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],op,'connect_payments','acct_GaOne',repeat('a',40));
        IF NOT FOUND THEN RAISE EXCEPTION 'Ungranted quiet studio denied %',op; END IF;
        PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[2],op,'connect_payments','acct_GaTwo',repeat('b',40));
        IF NOT FOUND THEN RAISE EXCEPTION 'Second ungranted studio denied %',op; END IF;
    END LOOP;
    FOREACH op IN ARRAY ARRAY['connected_customer.default_payment_method.update','connected_unknown.create','connected_subscription_schedule.unknown','connect_account.branding.update','connect_branding_file.create'] LOOP
        PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],op,'connect_payments','acct_GaOne',repeat('a',40));
        IF FOUND THEN RAISE EXCEPTION 'Unsupported payment operation authorized %',op; END IF;
        PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],op,'connect_onboarding','acct_GaOne',repeat('a',40));
        IF FOUND THEN RAISE EXCEPTION 'Internal onboarding operation authorized %',op; END IF;
    END LOOP;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[2],'connected_invoice.pay','connect_payments','acct_GaOne',repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Wrong tenant/account accepted'; END IF;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_payments','acct_GaOne',NULL);
    IF FOUND THEN RAISE EXCEPTION 'Missing deployed SHA accepted'; END IF;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_onboarding','acct_GaOne',repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Wrong operation scope accepted'; END IF;
    UPDATE public.studio_payment_accounts SET details_submitted=false WHERE studio_id=studios[1];
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_payments','acct_GaOne',repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Incomplete KYC accepted'; END IF;
    UPDATE public.studio_payment_accounts SET details_submitted=true WHERE studio_id=studios[1];
    -- Global current event policy, including failed out-of-scope/excluded events.
    FOREACH op IN ARRAY ARRAY['pending','processing','failed'] LOOP
        INSERT INTO public.stripe_events(stripe_event_id,stripe_account_id,livemode,type,payload,processing_status,created_at)
        VALUES('evt_Ga'||op,'acct_GaTwo',true,'invoice.paid','{}',op,now()-INTERVAL '40 days') RETURNING id INTO event_id;
        PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_payments','acct_GaOne',repeat('a',40));
        IF FOUND THEN RAISE EXCEPTION 'Global unresolved event allowed %',op; END IF;
        UPDATE public.stripe_events SET processing_status='processed',processed_at=now() WHERE id=event_id;
    END LOOP;
    INSERT INTO public.stripe_events(stripe_event_id,stripe_account_id,livemode,type,payload,processing_status,created_at)
    VALUES('evt_GaUnmapped','acct_GaUnmapped',true,'unknown.event','{}','processed',now()) RETURNING id INTO event_id;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_payments','acct_GaOne',repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Unresolved unmapped account allowed'; END IF;
    INSERT INTO public.stripe_connect_account_dispositions(stripe_connected_account_id,excluded,reason,actor_id)
    VALUES('acct_GaUnmapped',true,'GA contract explicit exclusion',owner_id);
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_payments','acct_GaOne',repeat('a',40));
    IF NOT FOUND THEN RAISE EXCEPTION 'Processed excluded event blocked'; END IF;
    UPDATE public.stripe_events SET processing_status='failed' WHERE id=event_id;
    IF private.live_billing_ga_events_clear_v58() THEN RAISE EXCEPTION 'Excluded failed event hidden'; END IF;
    UPDATE public.stripe_events SET processing_status='processed' WHERE id=event_id;
    BEGIN
        INSERT INTO public.stripe_connect_account_dispositions(stripe_connected_account_id,excluded,reason,actor_id)
        VALUES('acct_GaTwo',true,'Mapped must take precedence',owner_id);
        RAISE EXCEPTION 'Mapped account exclusion must be refused';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    FOREACH op IN ARRAY ARRAY['connected_subscription_schedule.create', 'connected_subscription_schedule.release', 'connected_subscription_schedule.update'] LOOP
        PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],op,'connect_payments','acct_GaOne',repeat('a',40));
        IF NOT FOUND THEN RAISE EXCEPTION 'Supported schedule operation omitted: %',op; END IF;
    END LOOP;
    FOR result IN SELECT * FROM public.studio_live_billing_supported_operations_v58(studios[1],repeat('a',40)) LOOP
        IF result.allowed_operations IS DISTINCT FROM
           (SELECT array_agg(operation ORDER BY operation COLLATE "C") FROM unnest(result.allowed_operations) operation) THEN
            RAISE EXCEPTION 'GA capability RPC returned noncanonical operation ordering';
        END IF;
    END LOOP;
    -- New studio bootstraps without affecting either existing account.
    account_key := 'koaryu-connect-account-'||studios[3]||'-g1';
    link_key := 'koaryu-connect-onboarding-'||studios[3]||'-g1-'||repeat('b',24);
    SELECT * INTO result FROM public.preflight_connect_onboarding_bootstrap_begin(studios[3],repeat('a',40));
    IF result.eligible IS DISTINCT FROM true THEN RAISE EXCEPTION 'New GA studio cannot begin'; END IF;
    SELECT bootstrap_id INTO bootstrap FROM public.prepare_connect_onboarding_bootstrap_atomic(studios[3],repeat('a',40),1,request,repeat('c',64),repeat('b',64),account_key,link_key);
    IF bootstrap IS NULL THEN RAISE EXCEPTION 'GA preparation failed'; END IF;
    IF EXISTS(SELECT 1 FROM public.stripe_connect_onboarding_bootstraps b WHERE b.id=bootstrap AND b.reconciliation_checkpoint_id IS NOT NULL) THEN RAISE EXCEPTION 'Fabricated GA checkpoint'; END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_account_create_v2(bootstrap,studios[3],repeat('a',40),1,repeat('c',64),account_key);
    IF NOT FOUND THEN RAISE EXCEPTION 'GA account create denied'; END IF;
    UPDATE public.studio_payment_accounts SET metadata='{"connect_account_generation":2}' WHERE studio_id=studios[3];
    PERFORM public.authorize_connect_onboarding_bootstrap_account_create_v2(bootstrap,studios[3],repeat('a',40),1,repeat('c',64),account_key);
    IF FOUND THEN RAISE EXCEPTION 'Stale generation account create accepted'; END IF;
    UPDATE public.studio_payment_accounts SET metadata='{"connect_account_generation":1}' WHERE studio_id=studios[3];
    PERFORM public.bind_connect_onboarding_bootstrap_account_v2(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree','company');
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[1],'connected_invoice.pay','connect_payments','acct_GaOne',repeat('a',40));
    IF NOT FOUND THEN RAISE EXCEPTION 'Third studio mapping blocked first studio'; END IF;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[3],'connect_onboarding_link.create','connect_onboarding','acct_GaThree',repeat('a',40));
    IF FOUND THEN RAISE EXCEPTION 'Ordinary link bypassed bootstrap'; END IF;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(studios[3],'connect_dashboard_login_link.create','connect_onboarding','acct_GaThree',repeat('a',40));
    IF NOT FOUND THEN RAISE EXCEPTION 'Dashboard requires KYC or link recovery'; END IF;
    FOR result IN SELECT * FROM (VALUES
        (studios[3],repeat('d',40),1,'acct_GaThree',repeat('b',64),link_key),
        (studios[1],repeat('a',40),1,'acct_GaThree',repeat('b',64),link_key),
        (studios[3],repeat('a',40),2,'acct_GaThree',repeat('b',64),link_key),
        (studios[3],repeat('a',40),1,'acct_GaOne',repeat('b',64),link_key),
        (studios[3],repeat('a',40),1,'acct_GaThree',repeat('d',64),link_key),
        (studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),link_key||'x')
    ) x(studio,sha,generation,account,context,key) LOOP
        PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(bootstrap,result.studio,result.sha,result.generation,result.account,result.context,repeat('d',64),result.key);
        IF FOUND THEN RAISE EXCEPTION 'Incorrect bootstrap context accepted'; END IF;
    END LOOP;
    FOREACH op IN ARRAY ARRAY['expired','support_required','pending_event'] LOOP
        BEGIN
            IF op='expired' THEN
                UPDATE public.stripe_connect_onboarding_bootstraps
                   SET authorized_at=now()-INTERVAL '2 days', expires_at=now()-INTERVAL '2 days'+INTERVAL '5 minutes', recovery_expires_at=now()-INTERVAL '1 day'
                 WHERE id=bootstrap;
            ELSIF op='support_required' THEN
                UPDATE public.stripe_connect_onboarding_bootstraps SET initial_link_support_required_at=now() WHERE id=bootstrap;
            ELSE
                INSERT INTO public.stripe_events(stripe_event_id,stripe_account_id,livemode,type,payload,processing_status,created_at)
                VALUES('evt_GaBootstrapPending','acct_GaThree',true,'account.updated','{}','pending',now());
            END IF;
            PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key);
            IF FOUND THEN RAISE EXCEPTION 'Bootstrap barrier bypassed: %',op; END IF;
            RAISE EXCEPTION USING ERRCODE='P0580';
        EXCEPTION WHEN SQLSTATE 'P0580' THEN NULL;
        END;
    END LOOP;
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key);
    IF NOT FOUND THEN RAISE EXCEPTION 'GA initial link denied'; END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key);
    IF NOT FOUND THEN RAISE EXCEPTION 'GA same request retry denied'; END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('e',64),link_key);
    IF FOUND THEN RAISE EXCEPTION 'Changed initial payload accepted'; END IF;
    PERFORM public.load_connect_onboarding_bootstrap_recovery_context(studios[3],repeat('a',40));
    IF NOT FOUND THEN RAISE EXCEPTION 'Exact bootstrap recovery denied'; END IF;
    PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key,repeat('e',64),repeat('f',64));
    IF NOT FOUND THEN RAISE EXCEPTION 'Initial response recording denied'; END IF;
    FOREACH op IN ARRAY ARRAY['changed_response','expired_receipt'] LOOP
        BEGIN
            IF op='expired_receipt' THEN
                UPDATE public.stripe_connect_onboarding_bootstraps
                   SET initial_link_claimed_at=now()-INTERVAL '4 minutes',
                       initial_link_response_recorded_at=now()-INTERVAL '3 minutes',
                       initial_link_delivery_receipt_expires_at=now()-INTERVAL '1 minute'
                 WHERE id=bootstrap;
                PERFORM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(studios[3],repeat('a',40),repeat('f',64));
                IF FOUND THEN RAISE EXCEPTION 'Expired receipt acknowledged'; END IF;
                PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key,repeat('e',64),repeat('a',64));
            ELSE
                PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key,repeat('a',64),repeat('a',64));
            END IF;
            IF FOUND THEN RAISE EXCEPTION 'Response identity/expiry barrier bypassed'; END IF;
            SELECT * INTO result FROM public.preflight_connect_onboarding_bootstrap_resume(studios[3],repeat('a',40));
            IF result.phase IS DISTINCT FROM 'support_required' THEN RAISE EXCEPTION 'Unsafe response did not retire to support'; END IF;
            RAISE EXCEPTION USING ERRCODE='P0580';
        EXCEPTION WHEN SQLSTATE 'P0580' THEN NULL;
        END;
    END LOOP;
    PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key,repeat('e',64),repeat('a',64));
    IF NOT FOUND THEN RAISE EXCEPTION 'Same response receipt rotation denied'; END IF;
    PERFORM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(studios[3],repeat('a',40),repeat('f',64));
    IF FOUND THEN RAISE EXCEPTION 'Rotated receipt accepted'; END IF;
    PERFORM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(studios[3],repeat('a',40),repeat('a',64));
    IF NOT FOUND THEN RAISE EXCEPTION 'Exact delivery ack denied'; END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(bootstrap,studios[3],repeat('a',40),1,'acct_GaThree',repeat('b',64),repeat('d',64),link_key);
    IF FOUND THEN RAISE EXCEPTION 'Delivered bootstrap reopened'; END IF;
    PERFORM public.prepare_connect_onboarding_bootstrap_atomic(studios[3],repeat('a',40),1,request,repeat('c',64),repeat('b',64),account_key,link_key);
    IF FOUND THEN RAISE EXCEPTION 'Delivered bootstrap prepared again'; END IF;
END;
$ga$;
ROLLBACK;
