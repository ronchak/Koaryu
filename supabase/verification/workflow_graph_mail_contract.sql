-- Focused graph mail authority and wire proof. Disposable local PG17 only.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE graph_mail_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.mail_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'graph mail contract failed: %',label; END IF; INSERT INTO pg_temp.graph_mail_checks VALUES(label); END $$;
-- The comprehensive source fixture is copied from the accepted current-facts contract.
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
        -- Isolated current-context mail fixtures; C2 enrollment is separately proved.
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

DO $$
DECLARE x JSONB; got JSONB; plan JSONB; claim UUID; fn REGPROCEDURE; role_name TEXT;
BEGIN
    FOR fn IN SELECT oid FROM pg_proc WHERE proname IN ('get_workflow_email_plan_v1','resolve_workflow_email_without_attempt_v1','begin_workflow_email_v1','settle_workflow_email_v1') LOOP
        PERFORM pg_temp.mail_check(has_function_privilege('service_role',fn,'EXECUTE') AND NOT has_function_privilege('anon',fn,'EXECUTE') AND NOT has_function_privilege('authenticated',fn,'EXECUTE'),'service-only '||fn);
    END LOOP;
    x:=pg_temp.advance_seed(pg_temp.advance_fixture(),'lead.created',pg_temp.advance_path('lead.created','email')); x:=pg_temp.advance_claim(x);
    UPDATE public.leads SET email='graph.'||(x->>'lead')||'@example.invalid' WHERE id=(x->>'lead')::UUID;
    got:=pg_temp.advance_call(x); PERFORM pg_temp.mail_check(got#>>'{payload,outcome}'='email','reached real email step');
    got:=public.get_workflow_email_plan_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,'work',repeat('a',64),'{}','reply@example.invalid','https://mail.example.invalid/api/v1');
    plan:=got#>'{payload,plan}';
    PERFORM pg_temp.mail_check(plan->>'disposition'='send' AND plan->>'recipient_email'='graph.'||(x->>'lead')||'@example.invalid','current source send plan');
    PERFORM pg_temp.mail_check(NOT EXISTS(SELECT 1 FROM private.workflow_email_unsubscribe_pins WHERE run_id=(x->>'run')::UUID) AND NOT EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations WHERE scope_id=(x->>'run')::UUID),'plan has no candidate token or attempt write');
    got:=public.resolve_workflow_email_without_attempt_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,'work',plan->>'fingerprint',repeat('a',64),'{}','reply@example.invalid','https://mail.example.invalid/api/v1','{"kind":"plan_decision"}');
    PERFORM pg_temp.mail_check(got#>>'{payload,outcome}'='stale_plan','send reversal refuses plan decision');
    got:=public.resolve_workflow_email_without_attempt_v1((x->>'studio')::UUID,(x->>'run')::UUID,(x->>'token')::UUID,'work',plan->>'fingerprint',repeat('a',64),'{}','reply@example.invalid','https://mail.example.invalid/api/v1','{"kind":"render_failed","reason":"invalid_email_context"}');
    PERFORM pg_temp.mail_check(got#>>'{payload,outcome}'='continue' AND got#>>'{payload,run,current_node_id}'='end','safe render failure retains internal continuation claim');
END $$;
SELECT count(*)||' graph mail assertions passed' FROM pg_temp.graph_mail_checks;
ROLLBACK;
