-- Disposable PostgreSQL contract only. Every fixture and test trigger rolls back.
BEGIN;

CREATE FUNCTION pg_temp.plan_write_state(p_studio UUID) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object(
        'plans', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.billing_plans t WHERE studio_id=p_studio),
        'links', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.billing_plan_programs t WHERE studio_id=p_studio),
        'audit', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.audit_logs t WHERE studio_id=p_studio),
        'prices', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.billing_plan_prices t WHERE studio_id=p_studio));
$$;

CREATE FUNCTION pg_temp.expect_plan_write_error(
    p_studio UUID, p_actor UUID, p_plan UUID, p_values JSONB, p_programs UUID[],
    p_code TEXT, p_message TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE rejected BOOLEAN := FALSE;
BEGIN
    BEGIN
        PERFORM public.write_billing_plan_v1(p_studio,p_actor,p_plan,p_values,p_programs);
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE IS DISTINCT FROM p_code OR (p_message IS NOT NULL AND SQLERRM IS DISTINCT FROM p_message) THEN
            RAISE;
        END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Expected plan rejection %, values %',p_code,p_values; END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION pg_temp.plan_write_state(UUID),
    pg_temp.expect_plan_write_error(UUID,UUID,UUID,JSONB,UUID[],TEXT,TEXT) TO service_role;

CREATE FUNCTION pg_temp.reject_plan_write_for_test() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('koaryu.test_plan_write_failure',true) = TG_TABLE_NAME THEN
        RAISE EXCEPTION 'plan write rollback fixture' USING ERRCODE = 'PZ001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER koaryu_test_plan_link_failure BEFORE INSERT ON public.billing_plan_programs
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_plan_write_for_test();
CREATE TRIGGER koaryu_test_plan_audit_failure BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_plan_write_for_test();

DO $contract$
DECLARE
    studio UUID := gen_random_uuid();
    other_studio UUID := gen_random_uuid();
    actor UUID := gen_random_uuid();
    other_actor UUID := gen_random_uuid();
    archived_actor UUID := gen_random_uuid();
    instructor UUID := gen_random_uuid();
    program UUID := gen_random_uuid();
    archived_program UUID := gen_random_uuid();
    foreign_program UUID := gen_random_uuid();
    plan UUID := gen_random_uuid();
    foreign_plan UUID := gen_random_uuid();
    legacy_plan UUID := gen_random_uuid();
    saved JSONB;
    snapshot JSONB;
    before_state JSONB;
    foreign_state JSONB;
    active_row JSONB;
    historical_row JSONB;
    link_id UUID;
    before_audits BIGINT;
    value JSONB;
    key TEXT;
    target UUID;
    denied_actor UUID;
    role_name TEXT;
    rejected BOOLEAN;
    signature REGPROCEDURE := 'public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])'::REGPROCEDURE;
BEGIN
    IF has_function_privilege('anon',signature,'EXECUTE')
       OR has_function_privilege('authenticated',signature,'EXECUTE')
       OR NOT has_function_privilege('service_role',signature,'EXECUTE')
       OR EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
           WHERE p.oid=signature AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
       OR (SELECT prosecdef FROM pg_proc WHERE oid=signature) THEN
        RAISE EXCEPTION 'Plan writer must be invoker, service-role only';
    END IF;
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    SELECT id,'authenticated','authenticated',id::TEXT||'@example.invalid','{}','{}',now(),now()
    FROM unnest(ARRAY[actor,other_actor,archived_actor,instructor]) id;
    INSERT INTO public.studios(id,name,slug,owner_id)
    VALUES(studio,'Plan contract',studio::TEXT,actor),(other_studio,'Other plan contract',other_studio::TEXT,other_actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role,archived_at)
    VALUES(studio,actor,'admin',NULL),(other_studio,other_actor,'admin',NULL),
          (studio,archived_actor,'admin',now()),(studio,instructor,'instructor',NULL);
    INSERT INTO public.programs(id,studio_id,name,color_hex,sort_order,archived_at)
    VALUES(program,studio,'Karate','#123456',0,NULL),
          (archived_program,studio,'Archived judo','#abcdef',1,now()),
          (foreign_program,other_studio,'Other program','#654321',0,NULL);
    -- Insert old timestamps directly: an UPDATE trigger uses transaction now(), even inside this contract.
    INSERT INTO public.billing_plans(id,studio_id,name,description,amount_cents,status,currency,
        stripe_account_id,stripe_product_id,stripe_price_id,stripe_price_version,metadata,updated_at,
        freeze_behavior,cancellation_policy,tax_behavior)
    VALUES(plan,studio,'Active core','Membership',1000,'active','usd',
           'acct_fixture','prod_fixture','price_fixture',3,'{"keep":"provider metadata"}','2000-01-01T00:00:00Z','pause','Notice','inclusive'),
          (legacy_plan,studio,'Legacy euro','Historical',1000,'active','EUR',
           'acct_fixture','prod_legacy','price_legacy',1,'{}','2000-01-01T00:00:00Z',NULL,NULL,NULL),
          (foreign_plan,other_studio,'Other plan',NULL,1000,'pending','usd',NULL,NULL,NULL,1,'{}','2000-01-01T00:00:00Z',NULL,NULL,NULL);
    INSERT INTO public.billing_plan_programs(studio_id,billing_plan_id,program_id)
    VALUES(studio,plan,program) RETURNING id INTO link_id;
    INSERT INTO public.billing_plan_prices(studio_id,billing_plan_id,stripe_account_id,stripe_product_id,
        stripe_price_id,amount_cents,currency,billing_interval,version)
    VALUES(studio,plan,'acct_fixture','prod_fixture','price_fixture',1000,'usd','monthly',3);
    foreign_state := pg_temp.plan_write_state(other_studio);

    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        EXECUTE format('SET LOCAL ROLE %I',role_name);
        rejected := FALSE;
        BEGIN
            PERFORM public.write_billing_plan_v1(studio,actor,NULL,'{"name":"Denied","amount_cents":1000}',NULL);
        EXCEPTION WHEN insufficient_privilege THEN
            IF SQLERRM NOT LIKE '%permission denied for function write_billing_plan_v1%' THEN RAISE; END IF;
            rejected := TRUE;
        END;
        RESET ROLE;
        IF NOT rejected THEN RAISE EXCEPTION 'Role % executed writer',role_name; END IF;
    END LOOP;

    SET LOCAL ROLE service_role;
    IF current_user <> 'service_role' THEN RAISE EXCEPTION 'Positive contract must execute as service_role'; END IF;
    saved := public.write_billing_plan_v1(studio,actor,NULL,
        '{"name":"Created USD","amount_cents":500,"currency":" USD "}',ARRAY[archived_program,program,program]);
    IF saved->'plan'->>'currency' IS DISTINCT FROM 'usd'
       OR saved->'plan'->>'status' IS DISTINCT FROM 'pending'
       OR saved->'programs' IS DISTINCT FROM jsonb_build_array(
           jsonb_build_object('program_id',program,'program_name','Karate','program_color_hex','#123456'),
           jsonb_build_object('program_id',archived_program,'program_name','Archived judo','program_color_hex','#abcdef'))
       OR NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=studio AND actor_id=actor
           AND entity_id=(saved->'plan'->>'id')::UUID AND action='billing.plan_created') THEN
        RAISE EXCEPTION 'Create defaults, deduplication, archived association, snapshot or actor audit failed';
    END IF;

    before_state := pg_temp.plan_write_state(studio);
    FOREACH key IN ARRAY ARRAY['name','amount_cents','currency','billing_interval','signup_fee_cents','trial_days','proration_behavior'] LOOP
        PERFORM pg_temp.expect_plan_write_error(studio,actor,plan,jsonb_build_object(key,NULL),NULL,
            '22023','billing_plan_invalid_request');
    END LOOP;
    FOREACH value IN ARRAY ARRAY[NULL::JSONB,'null','[]','1','"text"','{"unknown":true}',
        '{"amount_cents":"1000"}','{"amount_cents":true}','{"description":{}}',
        '{"name":"  "}','{"trial_days":1.5}']::JSONB[] LOOP
        PERFORM pg_temp.expect_plan_write_error(studio,actor,plan,value,NULL,'22023','billing_plan_invalid_request');
    END LOOP;
    FOREACH key IN ARRAY ARRAY['stripe_account_id','stripe_product_id','stripe_price_id','stripe_price_version',
        'metadata','status','archived_at','studio_id','id'] LOOP
        PERFORM pg_temp.expect_plan_write_error(studio,actor,plan,jsonb_build_object(key,'overwritten'),NULL,
            '22023','billing_plan_invalid_request');
    END LOOP;
    PERFORM pg_temp.expect_plan_write_error(studio,actor,plan,'{}',ARRAY[NULL::UUID],'22023','billing_plan_invalid_request');
    PERFORM pg_temp.expect_plan_write_error(studio,actor,NULL,'{}',NULL,'22023','billing_plan_invalid_request');
    PERFORM pg_temp.expect_plan_write_error(studio,actor,foreign_plan,'{"name":"Stolen"}',NULL,'P0002','billing_plan_not_found');
    PERFORM pg_temp.expect_plan_write_error(studio,actor,gen_random_uuid(),'{}',NULL,'P0002','billing_plan_not_found');
    FOREACH target IN ARRAY ARRAY[NULL::UUID,plan] LOOP
        FOREACH denied_actor IN ARRAY ARRAY[other_actor,archived_actor,instructor] LOOP
            PERFORM pg_temp.expect_plan_write_error(studio,denied_actor,target,'{"name":"Denied","amount_cents":1000}',NULL,
                '42501','billing_plan_actor_not_active');
        END LOOP;
        PERFORM pg_temp.expect_plan_write_error(studio,actor,target,'{"name":"Foreign program","amount_cents":1000}',
            ARRAY[foreign_program],'P0002','billing_plan_program_not_found');
        PERFORM pg_temp.expect_plan_write_error(studio,actor,target,'{"name":"Missing program","amount_cents":1000}',
            ARRAY[gen_random_uuid()],'P0002','billing_plan_program_not_found');
    END LOOP;
    IF pg_temp.plan_write_state(studio) IS DISTINCT FROM before_state
       OR pg_temp.plan_write_state(other_studio) IS DISTINCT FROM foreign_state THEN
        RAISE EXCEPTION 'Rejected request altered plan, links, history or audit';
    END IF;

    -- A link failure follows scalar persistence; an audit failure follows both scalar and link persistence.
    FOREACH key IN ARRAY ARRAY['billing_plan_programs','audit_logs'] LOOP
        PERFORM set_config('koaryu.test_plan_write_failure',key,true);
        FOREACH target IN ARRAY ARRAY[NULL::UUID,plan] LOOP
            PERFORM pg_temp.expect_plan_write_error(studio,actor,target,'{"name":"Rollback","amount_cents":1500}',
                ARRAY[archived_program],'PZ001','plan write rollback fixture');
            IF pg_temp.plan_write_state(studio) IS DISTINCT FROM before_state THEN
                RAISE EXCEPTION '% failure did not roll back create/patch %',key,target;
            END IF;
        END LOOP;
    END LOOP;
    PERFORM set_config('koaryu.test_plan_write_failure','off',true);

    SELECT to_jsonb(t) INTO active_row FROM public.billing_plans t WHERE id=plan;
    IF (active_row->>'updated_at')::TIMESTAMPTZ IS DISTINCT FROM '2000-01-01T00:00:00Z'::TIMESTAMPTZ
       OR (active_row->>'updated_at')::TIMESTAMPTZ = now() THEN
        RAISE EXCEPTION 'No-op fixture cannot detect an unnecessary UPDATE';
    END IF;
    saved := public.write_billing_plan_v1(studio,actor,plan,'{}',NULL);
    saved := public.write_billing_plan_v1(studio,actor,plan,
        '{"name":"Active core","description":"Membership","amount_cents":1000,"currency":" USD "}',ARRAY[program,program]);
    IF saved->'plan' IS DISTINCT FROM active_row OR pg_temp.plan_write_state(studio) IS DISTINCT FROM before_state
       OR (SELECT id FROM public.billing_plan_programs WHERE billing_plan_id=plan AND program_id=program) IS DISTINCT FROM link_id THEN
        RAISE EXCEPTION 'No-op changed status, timestamp, links, provider history or audit';
    END IF;

    SELECT count(*) INTO before_audits FROM public.audit_logs WHERE studio_id=studio;
    snapshot := public.write_billing_plan_v1(studio,actor,plan,'{}',ARRAY[program,archived_program,program]);
    IF snapshot->'plan' IS DISTINCT FROM active_row OR jsonb_array_length(snapshot->'programs') <> 2
       OR (SELECT id FROM public.billing_plan_programs WHERE billing_plan_id=plan AND program_id=program) IS DISTINCT FROM link_id
       OR (SELECT count(*) FROM public.audit_logs WHERE studio_id=studio) <> before_audits+1
       OR NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=studio AND actor_id=actor
           AND entity_id=plan AND entity_type='billing' AND action='billing.plan_updated') THEN
        RAISE EXCEPTION 'Program-only replacement changed readiness/retained link or omitted audit';
    END IF;
    saved := public.write_billing_plan_v1(studio,actor,plan,'{}',ARRAY[]::UUID[]);
    IF saved->'programs' IS DISTINCT FROM '[]'::JSONB OR saved->'plan' IS DISTINCT FROM active_row
       OR EXISTS(SELECT 1 FROM public.billing_plan_programs WHERE billing_plan_id=plan)
       OR jsonb_array_length(snapshot->'programs') <> 2 THEN
        RAISE EXCEPTION 'Clear did not return empty links or changed earlier committed snapshot';
    END IF;
    -- An earlier result keeps names/colors from its own command after later local data changes.
    UPDATE public.programs SET name='Later program',color_hex='#000000' WHERE id=program;
    IF snapshot->'programs'->0 IS DISTINCT FROM
       jsonb_build_object('program_id',program,'program_name','Karate','program_color_hex','#123456') THEN
        RAISE EXCEPTION 'Committed program snapshot changed after a later write';
    END IF;
    saved := public.write_billing_plan_v1(studio,actor,plan,'{"description":null,"freeze_behavior":null,
        "cancellation_policy":null,"tax_behavior":null}',NULL);
    IF saved->'plan'->'description' IS DISTINCT FROM 'null'::JSONB
       OR saved->'plan'->'freeze_behavior' IS DISTINCT FROM 'null'::JSONB
       OR saved->'plan'->'cancellation_policy' IS DISTINCT FROM 'null'::JSONB
       OR saved->'plan'->'tax_behavior' IS DISTINCT FROM 'null'::JSONB
       OR saved->'plan'->>'status' IS DISTINCT FROM 'pending'
       OR (saved->'plan'->>'updated_at')::TIMESTAMPTZ <= (active_row->>'updated_at')::TIMESTAMPTZ
       OR saved->'programs' IS DISTINCT FROM '[]'::JSONB THEN
        RAISE EXCEPTION 'Nullable clearing did not save, mark provider change pending, or preserve links';
    END IF;
    UPDATE public.billing_plans SET status='active' WHERE id=plan;
    saved := public.write_billing_plan_v1(studio,actor,plan,'{"amount_cents":1500}',NULL);
    IF saved->'plan'->'amount_cents' IS DISTINCT FROM '1500'::JSONB
       OR saved->'plan'->>'status' IS DISTINCT FROM 'pending'
       OR saved->'plan'->>'stripe_account_id' IS DISTINCT FROM 'acct_fixture'
       OR saved->'plan'->>'stripe_product_id' IS DISTINCT FROM 'prod_fixture'
       OR saved->'plan'->>'stripe_price_id' IS DISTINCT FROM 'price_fixture'
       OR saved->'plan'->'stripe_price_version' IS DISTINCT FROM '3'::JSONB
       OR saved->'plan'->'metadata' IS DISTINCT FROM '{"keep":"provider metadata"}'::JSONB
       OR pg_temp.plan_write_state(studio)->'prices' IS DISTINCT FROM before_state->'prices' THEN
        RAISE EXCEPTION 'Scalar edit lost provider identity, metadata or price history';
    END IF;
    UPDATE public.billing_plans SET status='archived',archived_at='2001-01-01T00:00:00Z' WHERE id=plan;
    saved := public.write_billing_plan_v1(studio,actor,plan,'{"amount_cents":1600}',ARRAY[program]);
    IF saved->'plan'->>'status' IS DISTINCT FROM 'archived'
       OR (saved->'plan'->>'archived_at')::TIMESTAMPTZ IS DISTINCT FROM '2001-01-01T00:00:00Z'::TIMESTAMPTZ THEN
        RAISE EXCEPTION 'Archived plan was reactivated by a real edit';
    END IF;

    before_state := pg_temp.plan_write_state(studio);
    PERFORM pg_temp.expect_plan_write_error(studio,actor,NULL,'{"name":"New euro","amount_cents":500,"currency":"eur"}',
        NULL,'22023','billing_plan_requires_usd');
    SELECT to_jsonb(t) INTO historical_row FROM public.billing_plans t WHERE id=legacy_plan;
    saved := public.write_billing_plan_v1(studio,actor,legacy_plan,'{"currency":" eur ","amount_cents":1000}',NULL);
    IF saved->'plan' IS DISTINCT FROM historical_row OR pg_temp.plan_write_state(studio) IS DISTINCT FROM before_state THEN
        RAISE EXCEPTION 'Equivalent legacy EUR save rewrote history or audit';
    END IF;
    FOREACH value IN ARRAY ARRAY['{"amount_cents":1001}','{"currency":"gbp"}','{"billing_interval":"annual"}',
        '{"signup_fee_cents":1}','{"trial_days":1}']::JSONB[] LOOP
        PERFORM pg_temp.expect_plan_write_error(studio,actor,legacy_plan,value,NULL,'22023','billing_plan_requires_usd');
    END LOOP;
    IF pg_temp.plan_write_state(studio) IS DISTINCT FROM before_state THEN
        RAISE EXCEPTION 'Rejected legacy non-USD financial edit changed state';
    END IF;
    saved := public.write_billing_plan_v1(studio,actor,legacy_plan,
        '{"freeze_behavior":"pause","cancellation_policy":"Notice","tax_behavior":"inclusive","proration_behavior":"next_cycle"}',
        ARRAY[archived_program]);
    IF saved->'plan'->>'currency' IS DISTINCT FROM 'EUR' OR saved->'plan'->>'status' IS DISTINCT FROM 'active'
       OR saved->'plan'->>'freeze_behavior' IS DISTINCT FROM 'pause' THEN
        RAISE EXCEPTION 'Nonfinancial legacy maintenance rewrote currency or price readiness';
    END IF;
    saved := public.write_billing_plan_v1(studio,actor,legacy_plan,'{"name":"Renamed euro","description":null}',NULL);
    IF saved->'plan'->>'currency' IS DISTINCT FROM 'EUR' OR saved->'plan'->>'status' IS DISTINCT FROM 'pending' THEN
        RAISE EXCEPTION 'Legacy description/name maintenance was blocked or changed currency';
    END IF;
    saved := public.write_billing_plan_v1(studio,actor,legacy_plan,'{"currency":"usd","amount_cents":1200}',NULL);
    IF saved->'plan'->>'currency' IS DISTINCT FROM 'usd' OR saved->'plan'->'amount_cents' IS DISTINCT FROM '1200'::JSONB
       OR saved->'plan'->>'stripe_price_id' IS DISTINCT FROM 'price_legacy'
       OR pg_temp.plan_write_state(other_studio) IS DISTINCT FROM foreign_state THEN
        RAISE EXCEPTION 'Explicit USD redefinition lost provider identity or changed another studio';
    END IF;
    RESET ROLE;
    RAISE NOTICE 'Local plan write ownership contract passed';
END;
$contract$;

ROLLBACK;
