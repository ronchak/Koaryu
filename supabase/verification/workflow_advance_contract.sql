-- Guarded local synthetic advancement proof. Timed contexts are fixtures, not timer enrollment.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE advance_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.advance_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'advance contract failed: %',label; END IF;
    INSERT INTO pg_temp.advance_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.advance_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    IF got_code IS DISTINCT FROM code OR (message IS NOT NULL AND got_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'advance negative failed %: % (%) expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.advance_check(true,label);
END $$;
-- fixture owners start. The comprehensive source fixture is copied from the accepted current-facts contract.
CREATE FUNCTION pg_temp.advance_graph(kind TEXT,policy TEXT DEFAULT NULL,filter_id UUID DEFAULT NULL) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE trigger JSONB; nodes JSONB; edges JSONB; selected TEXT;
BEGIN
    selected:=coalesce(policy,private.workflow_catalog_v1()#>>ARRAY['triggers',kind,'recipient_ids','0']);
    trigger:=jsonb_build_object('event_type',kind,'program_id',filter_id);
    IF private.workflow_catalog_v1()#>ARRAY['triggers',kind,'supports_offset']='true'::JSONB THEN trigger:=trigger||'{"offset_minutes":-1440}'; END IF;
    nodes:=jsonb_build_array(jsonb_build_object('id','trigger','type','trigger','config',trigger),
        jsonb_build_object('id','mail','type','email','config',jsonb_build_object('recipient',selected,'subject_template','Hello {{recipient_name}}',
            'body_template','From {{studio_name}}','reply_to_email','')),'{"id":"end","type":"end","config":{}}'::JSONB);
    edges:='[{"id":"next","source":"trigger","target":"mail","port":"next"},{"id":"done","source":"mail","target":"end","port":"next"}]';
    RETURN jsonb_build_object('schema_version',1,'nodes',nodes,'edges',edges);
END $$;
CREATE FUNCTION pg_temp.advance_fixture(legacy BOOLEAN DEFAULT false,unscoped BOOLEAN DEFAULT false) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); p2 UUID:=gen_random_uuid(); l UUID:=gen_random_uuid();
    r0 UUID:=gen_random_uuid(); r1 UUID:=gen_random_uuid(); r2 UUID:=gen_random_uuid(); st UUID:=gen_random_uuid(); m UUID:=gen_random_uuid();
    e UUID:=gen_random_uuid(); ld UUID:=gen_random_uuid(); tr UUID:=gen_random_uuid(); y UUID:=gen_random_uuid(); i UUID:=gen_random_uuid(); pay UUID:=gen_random_uuid();
    staff UUID:=gen_random_uuid(); w UUID; pr public.promotions; result JSONB; rc UUID;
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp()),(staff,'staff.'||staff||'@example.invalid',NULL);
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Current fact studio',s::TEXT,a,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'),(s,staff,'instructor');
    INSERT INTO public.staff_profiles(user_id,legal_first_name,legal_last_name) VALUES(staff,'Assigned','Teacher');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'First program'),(p2,s,'Other program');
    INSERT INTO public.programs(studio_id,name,is_system) SELECT s,'Unassigned',true WHERE NOT EXISTS(SELECT 1 FROM public.programs WHERE studio_id=s AND is_system AND lower(name)='unassigned');
    INSERT INTO public.belt_ladders(id,studio_id,name,program_id) VALUES(l,s,'Fact ladder',CASE WHEN legacy OR unscoped THEN NULL ELSE p END);
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order,min_classes,min_months) VALUES(r0,s,l,'White',0,0,0),(r1,s,l,'Yellow',1,0,0),(r2,s,l,'Green',2,0,0);
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,email,program_id,current_belt_rank_id,membership_start_date)
        VALUES(st,s,'Student','Person','active','student.'||st||'@example.invalid',p,r0,CURRENT_DATE-120);
    IF NOT legacy THEN INSERT INTO public.student_program_memberships(id,studio_id,student_id,program_id,status,started_at,current_belt_rank_id)
        VALUES(m,s,st,p,'paused',CURRENT_DATE-120,r0); ELSE m:=NULL; END IF;
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    pr:=public.record_student_rank_transition_v3(s,st,m,p,r1,a,NULL,'promotion',gen_random_uuid());
    INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone,status)
        VALUES(e,s,'Current belt test',l,CASE WHEN legacy OR unscoped THEN NULL ELSE p END,clock_timestamp()+INTERVAL '7 days',clock_timestamp()+INTERVAL '7 days 1 hour','UTC','scheduled');
    result:=public.approve_belt_test_recipients_v1(s,a,e,gen_random_uuid(),1,jsonb_build_array(jsonb_build_object('student_id',st,'student_program_membership_id',m)));
    rc:=(result#>>'{payload,items,0,id}')::UUID;
    INSERT INTO public.leads(id,studio_id,first_name,last_name,email,source,stage,is_minor,program_id,assigned_staff_id)
        VALUES(ld,s,'Lead','Person','lead.'||ld||'@example.invalid','referral','inquiry',false,p,staff);
    INSERT INTO public.lead_trial_appointments(id,studio_id,lead_id,program_id,starts_at,ends_at,timezone,location)
        VALUES(tr,s,ld,p,clock_timestamp()+INTERVAL '2 days',clock_timestamp()+INTERVAL '2 days 1 hour','UTC','Main room');
    INSERT INTO public.studio_payment_accounts(studio_id,stripe_connected_account_id,metadata) VALUES(s,'acct_'||replace(s::TEXT,'-',''),'{"connect_account_generation":1}');
    INSERT INTO public.billing_payers(id,studio_id,display_name,email,stripe_account_id,stripe_customer_id,connect_account_generation)
        VALUES(y,s,'Invoice Payer','payer.'||y||'@example.invalid','acct_'||replace(s::TEXT,'-',''),'cus_'||y,1);
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,currency,amount_due_cents,amount_paid_cents,amount_remaining_cents,due_date,
        invoice_number,collection_method,stripe_account_id,stripe_customer_id,stripe_invoice_id,metadata)
        VALUES(i,s,y,'open','usd',1234,0,1234,CURRENT_DATE-5,'FACT-1','send_invoice','acct_'||replace(s::TEXT,'-',''),'cus_'||y,'in_'||i,'{"connect_account_generation":1}');
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,
        connect_account_generation,payment_method_type,idempotency_key) VALUES(pay,s,y,i,'failed',1234,'usd','acct_'||replace(s::TEXT,'-',''),'cus_'||y,'in_'||i,1,'card',pay::TEXT);
    PERFORM private.workflow_finalize_invoice_episodes_v1();
    SET CONSTRAINTS private.workflow_invoice_episode_deferred DEFERRED;
    result:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Fact workflow','',pg_temp.advance_graph('student.enrolled'),'{}');
    w:=(result#>>'{payload,id}')::UUID;
    RETURN jsonb_build_object('actor',a,'staff',staff,'studio',s,'program',p,'program2',p2,'ladder',l,'rank0',r0,'rank1',r1,'rank2',r2,
        'student',st,'membership',m,'event',e,'belt_test_recipient',rc,'lead',ld,'trial_appointment',tr,'payer',y,'invoice',i,'payment',pay,'promotion',pr.id,'workflow',w);
END $$;
CREATE FUNCTION pg_temp.advance_path(kind TEXT DEFAULT 'lead.created',mode TEXT DEFAULT 'end',config JSONB DEFAULT NULL) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE graph JSONB:=pg_temp.advance_graph(kind); middle JSONB; edges JSONB; nodes JSONB;
BEGIN
    nodes:=jsonb_build_array(graph#>'{nodes,0}');
    IF mode='end' THEN edges:='[{"id":"next","source":"trigger","target":"end","port":"next"}]';
    ELSE
        middle:=jsonb_build_object('id','work','type',mode,'config',coalesce(config,CASE mode
            WHEN 'lead_follow_up' THEN '{"due_in_days":3,"note":"Synthetic scheduling note"}'::JSONB
            WHEN 'delay' THEN '{"mode":"duration","minutes":60}'::JSONB
            WHEN 'condition' THEN '{"field":"lead.unconverted","operator":"eq","value":true}'::JSONB
            WHEN 'email' THEN graph#>'{nodes,1,config}' END));
        nodes:=nodes||jsonb_build_array(middle);
        edges:='[{"id":"next","source":"trigger","target":"work","port":"next"}]';
        IF mode='condition' THEN
            edges:=edges||'[{"id":"yes","source":"work","target":"end","port":"yes"},{"id":"no","source":"work","target":"end","port":"no"}]';
        ELSE edges:=edges||'[{"id":"done","source":"work","target":"end","port":"next"}]'; END IF;
    END IF;
    RETURN jsonb_build_object('schema_version',1,'nodes',nodes||'[{"id":"end","type":"end","config":{}}]','edges',edges);
END $$;
CREATE FUNCTION pg_temp.advance_seed(x JSONB,kind TEXT DEFAULT 'lead.created',graph JSONB DEFAULT NULL) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID; w UUID; r UUID; source UUID; event_id UUID; result JSONB;
    activation public.automation_workflow_activations; trial public.lead_trial_appointments; belt public.belt_test_recipients;
    invoice public.billing_invoices; context JSONB; row RECORD; updated JSONB:=x;
BEGIN
    graph:=coalesce(graph,pg_temp.advance_path(kind));
    w:=(public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Advance proof','',graph,'{}')#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),1,'publish');
    PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),2,'start');
    CASE kind
    WHEN 'lead.created' THEN
        result:=public.create_lead_atomic_v1(s,a,gen_random_uuid(),jsonb_build_object('first_name','Advance','last_name','Lead','source','referral','program_id',x->'program'));
        source:=(result#>>'{payload,id}')::UUID; updated:=updated||jsonb_build_object('lead',source);
    WHEN 'lead.stage_changed' THEN
        row:=public.update_lead_atomic(s,a,(x->>'lead')::UUID,'{"stage":"offer_sent"}'); source:=(x->>'lead')::UUID;
    WHEN 'student.enrolled' THEN
        source:=gen_random_uuid();
        PERFORM public.write_student_profile_v2_atomic(source,s,a,'{"legal_first_name":"Advance","legal_last_name":"Student","status":"active"}',ARRAY[(x->>'program')::UUID],'[]',true,'student.created');
        updated:=updated||jsonb_build_object('student',source);
    WHEN 'student.promoted' THEN
        row:=public.record_student_rank_transition_v3(s,(x->>'student')::UUID,(x->>'membership')::UUID,(x->>'program')::UUID,(x->>'rank2')::UUID,a,NULL,'promotion',gen_random_uuid());
        source:=row.id; updated:=updated||jsonb_build_object('promotion',source);
    WHEN 'invoice.payment_failed' THEN
        source:=gen_random_uuid();
        INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,idempotency_key)
            SELECT source,s,i.payer_id,i.id,'failed',1234,'usd',i.stripe_account_id,i.stripe_customer_id,i.stripe_invoice_id,1,'card',source::TEXT
            FROM public.billing_invoices i WHERE i.id=(x->>'invoice')::UUID;
        updated:=updated||jsonb_build_object('payment',source);
    WHEN 'belt_test.approved' THEN
        -- A fresh approval generation from the real current command.
        source:=gen_random_uuid();
        INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,program_id,starts_at,ends_at,timezone,status)
            VALUES(source,s,'Advance test',(x->>'ladder')::UUID,(x->>'program')::UUID,clock_timestamp()+INTERVAL '7 days',clock_timestamp()+INTERVAL '7 days 1 hour','UTC','scheduled');
        updated:=updated||jsonb_build_object('event',source);
        result:=public.approve_belt_test_recipients_v1(s,a,source,gen_random_uuid(),1,jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership')));
        source:=(result#>>'{payload,items,0,id}')::UUID; updated:=updated||jsonb_build_object('belt_test_recipient',source);
    ELSE
        IF kind IN ('trial.scheduled','trial.completed','trial.no_show') THEN
            source:=(x->>'trial_appointment')::UUID;
            IF kind<>'trial.scheduled' THEN
                UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=source;
            END IF;
            result:=public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,source,gen_random_uuid(),1,
                CASE kind WHEN 'trial.scheduled' THEN '{"location":"Updated room"}'::JSONB ELSE jsonb_build_object('status',substr(kind,7)) END);
        ELSIF kind='trial.upcoming' THEN
            SELECT * INTO trial FROM public.lead_trial_appointments WHERE id=(x->>'trial_appointment')::UUID;
            source:=trial.id; context:=jsonb_build_object('appointment_id',source,'lead_id',trial.lead_id,'program_id',trial.program_id,'revision',trial.revision,'status',trial.status);
        ELSIF kind='belt_test.upcoming' THEN
            SELECT * INTO belt FROM public.belt_test_recipients WHERE id=(x->>'belt_test_recipient')::UUID;
            source:=belt.id; context:=jsonb_build_object('event_id',belt.event_id,'student_id',belt.student_id,'student_program_membership_id',belt.student_program_membership_id,
                'approved_program_id',belt.approved_program_id,'approved_current_rank_id',belt.approved_current_rank_id,'approved_target_rank_id',belt.approved_target_rank_id,
                'approved_schedule_revision',belt.approved_schedule_revision,'approval_revision',belt.revision,'approved_rank_context_generation',belt.approved_rank_context_generation);
        ELSIF kind='invoice.overdue' THEN
            SELECT * INTO invoice FROM public.billing_invoices WHERE id=(x->>'invoice')::UUID;
            source:=invoice.id; context:=jsonb_build_object('invoice_id',source,'payer_id',invoice.payer_id,'due_date',invoice.due_date,
                'stripe_account_id',invoice.stripe_account_id,'stripe_customer_id',invoice.stripe_customer_id,'stripe_invoice_id',invoice.stripe_invoice_id,
                'connect_account_generation',1,'currency',invoice.currency);
        ELSE RAISE EXCEPTION 'Unknown synthetic family'; END IF;
    END CASE;
    IF context IS NOT NULL THEN
        -- The three timers have no enrollment owner yet. Only current-context fixtures.
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
            VALUES(s,kind,'timer-context-fixture:'||gen_random_uuid()::TEXT,private.workflow_catalog_v1()#>>ARRAY['triggers',kind,'subject_kind'],source,clock_timestamp(),context) RETURNING id INTO event_id;
        SELECT * INTO activation FROM public.automation_workflow_activations WHERE workflow_id=w AND retired_at IS NULL;
        INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id)
            VALUES(s,w,activation.version_id,event_id,activation.id,activation.epoch,'trigger') RETURNING id INTO r;
    ELSE
        SELECT runs.id,runs.event_id INTO r,event_id FROM public.automation_workflow_runs runs WHERE workflow_id=w ORDER BY created_at DESC LIMIT 1;
        IF r IS NULL THEN RAISE EXCEPTION 'Real command did not capture family %',kind; END IF;
    END IF;
    RETURN updated||jsonb_build_object('run',r,'workflow',w,'source_event',event_id,'kind',kind,'subject',source,'timer_context_fixture',context IS NOT NULL);
END $$;
CREATE FUNCTION pg_temp.advance_claim(x JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE got JSONB;
BEGIN
    -- Keep each test's global claim isolated without deleting its history.
    UPDATE public.automation_workflow_runs SET next_due_at=clock_timestamp()+INTERVAL '1 day'
        WHERE state IN ('queued','waiting','claimed','running') AND id<>(x->>'run')::UUID;
    UPDATE public.automation_workflow_runs SET next_due_at=clock_timestamp()-INTERVAL '1 second' WHERE id=(x->>'run')::UUID AND state IN ('queued','waiting');
    got:=public.claim_automation_workflow_runs_v1(1)#>'{payload,claims,0}';
    IF got->>'run_id' IS DISTINCT FROM x->>'run' THEN RAISE EXCEPTION 'Expected exact fixture claim'; END IF;
    RETURN x||jsonb_build_object('token',got->'claim_token','lease',got->'lease_expires_at');
END $$;
CREATE FUNCTION pg_temp.advance_call(x JSONB,limit_count INTEGER DEFAULT 10) RETURNS JSONB LANGUAGE sql AS $$
    SELECT public.advance_automation_workflow_run_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,limit_count)
$$;
CREATE FUNCTION pg_temp.advance_snapshot(x JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('run',(SELECT to_jsonb(r) FROM public.automation_workflow_runs r WHERE id=(x->>'run')::UUID),
        'steps',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY sequence),'[]') FROM private.automation_workflow_run_steps s WHERE run_id=(x->>'run')::UUID),
        'actions',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM private.automation_workflow_follow_up_actions a WHERE run_id=(x->>'run')::UUID),
        'activities',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM public.lead_activities a WHERE studio_id=(x->>'studio')::UUID),
        'lead',(SELECT to_jsonb(l) FROM public.leads l WHERE id=(x->>'lead')::UUID))
$$;
-- fixture owners end.
GRANT ALL ON pg_temp.advance_checks TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;
DO $$
DECLARE x JSONB; got JSONB; kind TEXT; fn REGPROCEDURE; rel REGCLASS; role_name TEXT;
BEGIN
    FOREACH rel IN ARRAY ARRAY['private.automation_workflow_dispatch_cursor'::REGCLASS,'private.automation_workflow_follow_up_actions'::REGCLASS] LOOP
        PERFORM pg_temp.advance_check((SELECT relrowsecurity AND relpersistence='p' AND pg_get_userbyid(relowner)='postgres' FROM pg_class WHERE oid=rel),'private durable state '||rel);
        FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
            PERFORM pg_temp.advance_check(NOT has_table_privilege(role_name,rel,'SELECT,INSERT,UPDATE,DELETE'),'client table denial '||rel||role_name);
        END LOOP;
    END LOOP;
    PERFORM pg_temp.advance_check(NOT has_table_privilege('service_role','private.automation_workflow_dispatch_cursor','INSERT,DELETE')
        AND has_table_privilege('service_role','private.automation_workflow_dispatch_cursor','SELECT,UPDATE'),'cursor narrow grants');
    PERFORM pg_temp.advance_check(NOT has_table_privilege('service_role','private.automation_workflow_follow_up_actions','UPDATE,DELETE')
        AND has_table_privilege('service_role','private.automation_workflow_follow_up_actions','SELECT,INSERT'),'receipt narrow grants');
    FOR fn IN SELECT oid FROM pg_proc WHERE proname IN ('workflow_run_position_v1','workflow_condition_result_v1','workflow_lock_run_sources_v1','workflow_defer_owned_run_v1',
        'workflow_apply_lead_follow_up_v1','workflow_transition_owned_v1','claim_automation_workflow_runs_v1','advance_automation_workflow_run_v1','defer_automation_workflow_run_v1') LOOP
        PERFORM pg_temp.advance_check((SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(proowner)='postgres' FROM pg_proc WHERE oid=fn)
            AND has_function_privilege('service_role',fn,'EXECUTE') AND NOT has_function_privilege('anon',fn,'EXECUTE') AND NOT has_function_privilege('authenticated',fn,'EXECUTE'),'service invoker '||fn);
    END LOOP;
    FOR kind IN SELECT jsonb_object_keys(private.workflow_catalog_v1()->'triggers') LOOP
        x:=pg_temp.advance_seed(pg_temp.advance_fixture(),kind); x:=pg_temp.advance_claim(x); got:=pg_temp.advance_call(x);
        PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='stopped' AND got#>>'{payload,run,state}'='completed'
            AND (SELECT count(*)=2 FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID),'actual family completion '||kind);
        PERFORM pg_temp.advance_check((SELECT count(*)=0 FROM private.automation_workflow_email_attempts WHERE run_id=(x->>'run')::UUID),'nonmail family '||kind);
    END LOOP;
END $$;
DO $$
DECLARE x JSONB; got JSONB; before JSONB; token UUID; value INTEGER; expected INTEGER; actual INTEGER; i INTEGER; due TIMESTAMPTZ; old_due TIMESTAMPTZ;
BEGIN
    x:=pg_temp.advance_seed(pg_temp.advance_fixture()); x:=pg_temp.advance_claim(x); before:=pg_temp.advance_snapshot(x);
    FOREACH value IN ARRAY ARRAY[0,11,NULL] LOOP
        PERFORM pg_temp.advance_error(format('SELECT public.claim_automation_workflow_runs_v1(%L)',value),'22023','AUTOMATION_INVALID_REQUEST','claim limit '||coalesce(value::TEXT,'null'));
        PERFORM pg_temp.advance_error(format('SELECT public.advance_automation_workflow_run_v1(%L,%L,%L,%L)',x->>'studio',x->>'run',x->>'token',value),'22023','AUTOMATION_INVALID_REQUEST','advance limit '||coalesce(value::TEXT,'null'));
    END LOOP;
    got:=pg_temp.advance_call(x||jsonb_build_object('token',gen_random_uuid()));
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='lease_lost' AND got#>'{payload,run}'='null' AND pg_temp.advance_snapshot(x)=before,'wrong token no mutation');
    got:=pg_temp.advance_call(x||jsonb_build_object('studio',gen_random_uuid()));
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='lease_lost' AND got#>'{payload,run}'='null' AND pg_temp.advance_snapshot(x)=before,'foreign studio no mutation');
    UPDATE public.automation_workflow_runs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=(x->>'run')::UUID;
    before:=pg_temp.advance_snapshot(x); got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='lease_lost' AND pg_temp.advance_snapshot(x)=before,'expired token no mutation');
    token:=(x->>'token')::UUID; x:=pg_temp.advance_claim(x);
    PERFORM pg_temp.advance_check((x->>'token')::UUID<>token,'reclaim fresh token');
    got:=pg_temp.advance_call(x||jsonb_build_object('token',token));
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='lease_lost','old token cannot resume');
    FOR i IN 0..9 LOOP
        got:=public.defer_automation_workflow_run_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,'sender_unavailable');
        SELECT round(extract(epoch FROM next_due_at-updated_at))::INTEGER,deferral_count INTO actual,value FROM public.automation_workflow_runs WHERE id=(x->>'run')::UUID;
        expected:=least(3600,60*(1<<least(i,7)));
        PERFORM pg_temp.advance_check(actual=expected AND value=least(7,i+1) AND got#>>'{payload,outcome}'='waiting','durable backoff '||i);
        x:=pg_temp.advance_claim(x);
    END LOOP;
    got:=pg_temp.advance_call(x,1);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='continue' AND (SELECT deferral_count=0 FROM public.automation_workflow_runs WHERE id=(x->>'run')::UUID),'successful edge resets defer count');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','delay')); x:=pg_temp.advance_claim(x);
    got:=pg_temp.advance_call(x); SELECT scheduled_at INTO old_due FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID AND node_id='work';
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='waiting' AND (got#>>'{payload,run,next_due_at}')::TIMESTAMPTZ=old_due,'duration stores exact due');
    x:=pg_temp.advance_claim(x); got:=public.defer_automation_workflow_run_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,'facts_unavailable');
    x:=pg_temp.advance_claim(x); got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check((got#>>'{payload,run,next_due_at}')::TIMESTAMPTZ=old_due AND (SELECT scheduled_at=old_due FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID AND node_id='work'),'duration survives unrelated defer/reclaim');
    PERFORM pg_temp.advance_error(format('UPDATE private.automation_workflow_run_steps SET scheduled_at=scheduled_at+INTERVAL ''1 second'' WHERE run_id=%L AND node_id=''work''',x->>'run'),'22023','AUTOMATION_IMMUTABLE_RECORD','delay due immutable');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','delay','{"mode":"duration","minutes":0}')); x:=pg_temp.advance_claim(x); got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed','zero delay progresses');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','email')); x:=pg_temp.advance_claim(x); got:=pg_temp.advance_call(x);
    before:=pg_temp.advance_snapshot(x); got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='email' AND got#>>'{payload,run,current_node_id}'='work' AND pg_temp.advance_snapshot(x)=before
        AND (SELECT lease_expires_at=(x->>'lease')::TIMESTAMPTZ FROM public.automation_workflow_runs WHERE id=(x->>'run')::UUID),'email boundary reentry no effect or lease extension');
END $$;
DO $$
DECLARE x JSONB; got JSONB; before JSONB; action private.automation_workflow_follow_up_actions; old_date DATE:=CURRENT_DATE-2; old_stage TEXT; i INTEGER;
BEGIN
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','lead_follow_up')); x:=pg_temp.advance_claim(x);
    UPDATE public.leads SET follow_up_date=old_date WHERE id=(x->>'lead')::UUID;
    SELECT stage INTO old_stage FROM public.leads WHERE id=(x->>'lead')::UUID;
    got:=pg_temp.advance_call(x,2); SELECT * INTO action FROM private.automation_workflow_follow_up_actions WHERE run_id=(x->>'run')::UUID;
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='continue' AND action.previous_due_date=old_date AND action.due_date=old_date,'earlier human date preserved');
    PERFORM pg_temp.advance_check((SELECT activity_type='note' AND created_by IS NULL AND description='Automation follow-up due '||to_char(old_date,'YYYY-MM-DD')||'. Synthetic scheduling note'
        FROM public.lead_activities WHERE id=action.activity_id),'scheduling note attribution exact');
    PERFORM pg_temp.advance_check((SELECT stage=old_stage AND converted_student_id IS NULL FROM public.leads WHERE id=action.lead_id)
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE studio_id=action.studio_id AND event_type='lead.stage_changed'),'no contacted or stage event');
    UPDATE public.automation_workflow_runs SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=action.run_id;
    x:=pg_temp.advance_claim(x); got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed' AND (SELECT count(*)=1 FROM private.automation_workflow_follow_up_actions WHERE run_id=action.run_id),'lost response reclaim effect once');
    PERFORM pg_temp.advance_error(format('UPDATE private.automation_workflow_follow_up_actions SET due_date=due_date+1 WHERE run_id=%L',action.run_id),'22023','AUTOMATION_IMMUTABLE_RECORD','receipt immutable');
    DELETE FROM public.leads WHERE id=action.lead_id;
    PERFORM pg_temp.advance_check(EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE run_id=action.run_id)
        AND NOT EXISTS(SELECT 1 FROM public.lead_activities WHERE id=action.activity_id),'logical receipt survives operational source deletion');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'trial.scheduled',pg_temp.advance_path('trial.scheduled','lead_follow_up')); x:=pg_temp.advance_claim(x);
    UPDATE public.staff_roles SET role='admin' WHERE studio_id=(x->>'studio')::UUID AND user_id=(x->>'staff')::UUID;
    UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=(x->>'staff')::UUID;
    UPDATE public.studios SET owner_id=(x->>'staff')::UUID WHERE id=(x->>'studio')::UUID;
    DELETE FROM public.staff_roles WHERE studio_id=(x->>'studio')::UUID AND user_id=(x->>'actor')::UUID;
    got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed' AND (SELECT lead_id=(x->>'lead')::UUID FROM private.automation_workflow_follow_up_actions WHERE run_id=(x->>'run')::UUID),'trial lead effect after publisher removal');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','lead_follow_up')); x:=pg_temp.advance_claim(x);
    UPDATE public.leads SET follow_up_date='infinity' WHERE id=(x->>'lead')::UUID;
    got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='waiting' AND got#>>'{payload,run,reason}'='facts_unavailable'
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE run_id=(x->>'run')::UUID),'invalid old date unavailable with no action');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','lead_follow_up')); x:=pg_temp.advance_claim(x);
    UPDATE public.leads SET stage='closed_lost' WHERE id=(x->>'lead')::UUID; got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='cancelled' AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE run_id=(x->>'run')::UUID),'closed lead stops action');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','lead_follow_up')); x:=pg_temp.advance_claim(x);
    before:=pg_temp.advance_snapshot(x);
    BEGIN
        PERFORM pg_temp.advance_call(x); RAISE EXCEPTION USING ERRCODE='P0004';
    EXCEPTION WHEN assert_failure THEN NULL; END;
    PERFORM pg_temp.advance_check(pg_temp.advance_snapshot(x)=before,'activity receipt step run rollback together');
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=(x->>'studio')::UUID; got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,reason}'='subscription_required' AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_follow_up_actions WHERE run_id=(x->>'run')::UUID),'current entitlement prevents internal action');
    UPDATE public.studio_subscriptions SET status='active' WHERE studio_id=(x->>'studio')::UUID; x:=pg_temp.advance_claim(x); got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed','entitlement recovery resumes');
END $$;
DO $$
DECLARE x JSONB; got JSONB; before JSONB; before_cursor JSONB; due TIMESTAMPTZ; action TEXT; revision BIGINT; event_count INTEGER;
BEGIN
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'trial.scheduled',pg_temp.advance_path('trial.scheduled','delay','{"mode":"until","field":"trial.starts_at","offset_minutes":-4320}'));
    x:=pg_temp.advance_claim(x);got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed','past due until progresses while event remains future');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'trial.scheduled',pg_temp.advance_path('trial.scheduled','delay','{"mode":"until","field":"trial.starts_at","offset_minutes":1}'));
    -- Directly change the current fixture clock without changing its captured revision.
    UPDATE public.lead_trial_appointments SET starts_at='9999-12-31 23:59:00+00',ends_at='9999-12-31 23:59:30+00' WHERE id=(x->>'trial_appointment')::UUID;
    x:=pg_temp.advance_claim(x);got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='waiting' AND got#>>'{payload,run,reason}'='facts_unavailable'
        AND (SELECT scheduled_at IS NULL AND edge_id IS NULL FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID AND node_id='work'),'year10000 arithmetic unavailable');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'trial.scheduled',pg_temp.advance_path('trial.scheduled','delay','{"mode":"until","field":"trial.starts_at","offset_minutes":-60}'));
    x:=pg_temp.advance_claim(x);got:=pg_temp.advance_call(x);
    SELECT scheduled_at INTO due FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID AND node_id='work';
    UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '1 minute',ends_at=clock_timestamp()+INTERVAL '1 hour' WHERE id=(x->>'trial_appointment')::UUID;
    x:=pg_temp.advance_claim(x);got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='cancelled' AND got#>>'{payload,run,reason}'='trial_unavailable'
        AND (SELECT scheduled_at=due AND finished_at IS NULL FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID AND node_id='work'),'expired event stops without rewriting delay history');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture()); x:=pg_temp.advance_claim(x);
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,gen_random_uuid(),3,'publish');
    got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed' AND (SELECT v.version_number=1 FROM public.automation_workflow_runs r JOIN public.automation_workflow_versions v ON v.id=r.version_id WHERE r.id=(x->>'run')::UUID),'republish retains legitimate old version');
    FOREACH action IN ARRAY ARRAY['pause','archive'] LOOP
        x:=pg_temp.advance_seed(pg_temp.advance_fixture()); x:=pg_temp.advance_claim(x);
        PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,gen_random_uuid(),3,action);
        before:=pg_temp.advance_snapshot(x); got:=pg_temp.advance_call(x);
        PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='lease_lost' AND pg_temp.advance_snapshot(x)=before
            AND before#>>'{run,state}'='cancelled','known lifecycle revoked token no mutation '||action);
        IF action='pause' THEN
            PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,gen_random_uuid(),4,'start');
            PERFORM pg_temp.advance_check((SELECT state='cancelled' AND cancel_reason='workflow_paused' FROM public.automation_workflow_runs WHERE id=(x->>'run')::UUID),'resume cannot revive old run');
        END IF;
    END LOOP;
    x:=pg_temp.advance_seed(pg_temp.advance_fixture());x:=pg_temp.advance_claim(x);
    UPDATE public.automation_workflow_runs SET revision=9223372036854775807 WHERE id=(x->>'run')::UUID;
    before:=pg_temp.advance_snapshot(x);
    PERFORM pg_temp.advance_error(format('SELECT pg_temp.advance_call(%L)',x),'P0001','AUTOMATION_STATE_CONFLICT','revision overflow refuses');
    PERFORM pg_temp.advance_check(pg_temp.advance_snapshot(x)=before,'overflow leaves no step');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture());
    SELECT to_jsonb(c) INTO before_cursor FROM private.automation_workflow_dispatch_cursor c;
    BEGIN PERFORM pg_temp.advance_claim(x); RAISE EXCEPTION USING ERRCODE='P0004'; EXCEPTION WHEN assert_failure THEN NULL; END;
    PERFORM pg_temp.advance_check((SELECT to_jsonb(c)=before_cursor FROM private.automation_workflow_dispatch_cursor c)
        AND (SELECT state='queued' AND claim_token IS NULL FROM public.automation_workflow_runs WHERE id=(x->>'run')::UUID),'claim rollback restores cursor and ownership');
    x:=pg_temp.advance_claim(x);
    UPDATE public.automation_workflow_runs SET current_node_id='end' WHERE id=(x->>'run')::UUID;
    before:=pg_temp.advance_snapshot(x);
    PERFORM pg_temp.advance_error(format('SELECT pg_temp.advance_call(%L)',x),'P0001','AUTOMATION_STATE_CONFLICT','missing predecessor history refuses');
    PERFORM pg_temp.advance_check(pg_temp.advance_snapshot(x)=before,'incompatible history atomic');
    PERFORM pg_temp.advance_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_email_attempts),'all internal contracts create no attempts');
    PERFORM pg_temp.advance_error('DELETE FROM private.automation_workflow_dispatch_cursor; SELECT public.claim_automation_workflow_runs_v1(1)','P0001','AUTOMATION_STATE_CONFLICT','missing cursor refuses recreation');
END $$;
DO $$
DECLARE got BOOLEAN; field TEXT; metadata JSONB; value JSONB; pair RECORD;
BEGIN
    FOR field,metadata IN SELECT e.key,e.value FROM jsonb_each(private.workflow_catalog_v1()->'fields') e LOOP
        value:=CASE metadata->>'value_type' WHEN 'boolean' THEN 'true'::JSONB WHEN 'uuid' THEN '"12345678-ABCD-1234-ABCD-123456789ABC"'::JSONB ELSE metadata->'values'->0 END;
        PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'eq',value,value),'typed equality '||field);
        PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'eq',value,NULL) IS NULL,'missing unavailable '||field);
        PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'neq',value,'{}') IS NULL,'malformed unavailable '||field);
        IF metadata->'nullable'='true' THEN
            PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'eq','null','null') AND private.workflow_condition_result_v1(field,'neq',value,'null'),'nullable scalar '||field);
            PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'not_in',jsonb_build_array(value),'null') IS FALSE,'nullable membership never negative match '||field);
        ELSE
            PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'neq',value,'null') IS NULL,'nonnull null unavailable '||field);
        END IF;
        IF metadata->'operators' ? 'in' THEN
            PERFORM pg_temp.advance_check(private.workflow_condition_result_v1(field,'in',jsonb_build_array(value),value)
                AND NOT private.workflow_condition_result_v1(field,'not_in',jsonb_build_array(value),value),'typed membership '||field);
        END IF;
    END LOOP;
    PERFORM pg_temp.advance_check(private.workflow_condition_result_v1('program.id','eq','"12345678-abcd-1234-abcd-123456789abc"','"{12345678ABCD1234ABCD123456789ABC}"'),'UUID identity normalization');
    PERFORM pg_temp.advance_error('SELECT private.workflow_condition_result_v1(''unknown'',''eq'',''true'',''true'')','22023','AUTOMATION_INVALID_REQUEST','unknown field refuses');
    PERFORM pg_temp.advance_error('SELECT private.workflow_condition_result_v1(''lead.unconverted'',''gt'',''true'',''true'')','22023','AUTOMATION_INVALID_REQUEST','unknown operator refuses');
    PERFORM pg_temp.advance_error('SELECT private.workflow_condition_result_v1(''program.id'',''in'',''[]'',NULL)','22023','AUTOMATION_INVALID_REQUEST','empty expected membership refuses even missing actual');
END $$;
DO $$
DECLARE x JSONB; got JSONB; graph JSONB; nodes JSONB; edges JSONB; i INTEGER; scope UUID; before JSONB; saved DATE;
BEGIN
    nodes:=jsonb_build_array(pg_temp.advance_path()#>'{nodes,0}'); edges:='[]';
    FOR i IN 1..38 LOOP
        nodes:=nodes||jsonb_build_array(jsonb_build_object('id','delay'||i,'type','delay','config',jsonb_build_object('mode','duration','minutes',0)));
        edges:=edges||jsonb_build_array(jsonb_build_object('id','edge'||i,'source',CASE WHEN i=1 THEN 'trigger' ELSE 'delay'||(i-1) END,'target','delay'||i,'port','next'));
    END LOOP;
    graph:=jsonb_build_object('schema_version',1,'nodes',nodes||'[{"id":"end","type":"end","config":{}}]',
        'edges',edges||'[{"id":"done","source":"delay38","target":"end","port":"next"}]');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',graph);x:=pg_temp.advance_claim(x);
    FOR i IN 1..4 LOOP
        got:=pg_temp.advance_call(x,10);
        PERFORM pg_temp.advance_check((SELECT count(*)=i*10 FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID)
            AND got#>>'{payload,outcome}'=CASE WHEN i=4 THEN 'stopped' ELSE 'continue' END,'ten visit bound '||i);
    END LOOP;
    PERFORM pg_temp.advance_check((SELECT count(DISTINCT node_id)=40 AND count(*)=40 FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID),'forty unique DAG visits');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'student.promoted');x:=pg_temp.advance_claim(x);
    -- Actual scope API, held active only inside a rollback subtransaction.
    BEGIN
        SET CONSTRAINTS private.workflow_rank_deferred DEFERRED;
        scope:=private.workflow_rank_scope_enter_v1((x->>'studio')::UUID,(x->>'student')::UUID,'profile');
        got:=pg_temp.advance_call(x);
        IF got#>>'{payload,outcome}' IS DISTINCT FROM 'waiting' OR got#>>'{payload,run,reason}' IS DISTINCT FROM 'facts_unavailable'
            OR NOT EXISTS(SELECT 1 FROM private.workflow_rank_scopes WHERE id=scope AND state='active') THEN
            RAISE EXCEPTION 'Pending scope was finalized or consumed';
        END IF;
        RAISE EXCEPTION USING ERRCODE='P0004';
    EXCEPTION WHEN assert_failure THEN NULL; END;
    PERFORM pg_temp.advance_check(true,'pending source scope unavailable with no runtime finalization');
    DELETE FROM private.workflow_rank_contexts WHERE studio_id=(x->>'studio')::UUID AND student_id=(x->>'student')::UUID;
    got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='waiting' AND got#>>'{payload,run,reason}'='facts_unavailable'
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID),'historical missing authority never baseline zero');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'invoice.overdue',pg_temp.advance_path('invoice.overdue','condition','{"field":"invoice.collection_method","operator":"neq","value":"send_invoice"}'));x:=pg_temp.advance_claim(x);
    UPDATE public.billing_invoices SET collection_method='invalid' WHERE id=(x->>'invoice')::UUID;
    got:=pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check(got#>>'{payload,outcome}'='waiting' AND (SELECT edge_id IS NULL AND outcome='waiting' FROM private.automation_workflow_run_steps WHERE run_id=(x->>'run')::UUID AND node_id='work'),'missing selected field never takes negative branch');
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','lead_follow_up'));x:=pg_temp.advance_claim(x);
    PERFORM pg_temp.advance_call(x,2);
    UPDATE public.leads SET follow_up_date=CURRENT_DATE-3 WHERE id=(x->>'lead')::UUID;
    saved:=CURRENT_DATE-3;
    PERFORM pg_temp.advance_call(x);
    PERFORM pg_temp.advance_check((SELECT follow_up_date=saved FROM public.leads WHERE id=(x->>'lead')::UUID),'later human earlier date survives response-loss continuation');
END $$;
DO $$
DECLARE x JSONB; y JSONB; got JSONB; before JSONB; due DATE; graph JSONB;
BEGIN
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','lead_follow_up'));x:=pg_temp.advance_claim(x);
    PERFORM pg_temp.advance_call(x);
    SELECT follow_up_date INTO due FROM public.leads WHERE id=(x->>'lead')::UUID;
    y:=pg_temp.advance_seed(x,'lead.stage_changed',pg_temp.advance_path('lead.stage_changed','lead_follow_up','{"due_in_days":10,"note":"Second run"}'));y:=pg_temp.advance_claim(y);
    got:=pg_temp.advance_call(y);
    PERFORM pg_temp.advance_check(got#>>'{payload,run,state}'='completed' AND (SELECT count(*)=2 AND count(DISTINCT activity_id)=2 AND bool_and(due_date=due)
        FROM private.automation_workflow_follow_up_actions WHERE lead_id=(x->>'lead')::UUID),'independent run receipt retains earlier schedule');
    graph:='{"schema_version":1,"nodes":[{"id":"trigger","type":"trigger","config":{"event_type":"lead.created","program_id":null}},
        {"id":"first","type":"delay","config":{"mode":"duration","minutes":0}},{"id":"second","type":"delay","config":{"mode":"duration","minutes":0}},
        {"id":"end","type":"end","config":{}}],"edges":[{"id":"a","source":"trigger","target":"first","port":"next"},
        {"id":"b","source":"first","target":"second","port":"next"},{"id":"c","source":"second","target":"end","port":"next"}]}';
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',graph);x:=pg_temp.advance_claim(x);
    -- Every row separately satisfies node/type/edge identity, but the old chain
    -- skipped its first node. The latest predecessor alone looks legitimate.
    INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,edge_id,entered_at,finished_at)
        VALUES((x->>'studio')::UUID,(x->>'run')::UUID,1,'trigger','trigger','completed','a',clock_timestamp(),clock_timestamp()),
        ((x->>'studio')::UUID,(x->>'run')::UUID,2,'second','delay','completed','c',clock_timestamp(),clock_timestamp());
    UPDATE public.automation_workflow_runs SET current_node_id='end' WHERE id=(x->>'run')::UUID;
    before:=pg_temp.advance_snapshot(x);
    PERFORM pg_temp.advance_error(format('SELECT pg_temp.advance_call(%L)',x),'P0001','AUTOMATION_STATE_CONFLICT','older incompatible visited edge refuses');
    PERFORM pg_temp.advance_check(pg_temp.advance_snapshot(x)=before,'older incompatible history refusal atomic');
END $$;
SELECT count(*) AS workflow_advance_assertions FROM pg_temp.advance_checks;
ROLLBACK;
