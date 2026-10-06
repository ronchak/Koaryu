-- Synthetic current facts only. The guarded runner installs this rollback contract.
BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE current_fact_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.fact_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'current fact contract failed: %',label; END IF;
    INSERT INTO pg_temp.current_fact_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.fact_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    IF got_code IS DISTINCT FROM code OR (message IS NOT NULL AND got_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'current fact negative failed %: got % (%) expected % (%)',label,got_code,got_message,code,message;
    END IF;
    PERFORM pg_temp.fact_check(true,label);
END $$;
-- fixture owners start: runner copies only these synthetic helpers to facts_proof.
CREATE FUNCTION pg_temp.fact_graph(kind TEXT,policy TEXT DEFAULT NULL,filter_id UUID DEFAULT NULL) RETURNS JSONB LANGUAGE plpgsql AS $$
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
CREATE FUNCTION pg_temp.fact_fixture(legacy BOOLEAN DEFAULT false,unscoped BOOLEAN DEFAULT false) RETURNS JSONB LANGUAGE plpgsql AS $$
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
    result:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Fact workflow','',pg_temp.fact_graph('student.enrolled'),'{}');
    w:=(result#>>'{payload,id}')::UUID;
    RETURN jsonb_build_object('actor',a,'staff',staff,'studio',s,'program',p,'program2',p2,'ladder',l,'rank0',r0,'rank1',r1,'rank2',r2,
        'student',st,'membership',m,'event',e,'belt_test_recipient',rc,'lead',ld,'trial_appointment',tr,'payer',y,'invoice',i,'payment',pay,'promotion',pr.id,'workflow',w);
END $$;
CREATE FUNCTION pg_temp.fact_context(x JSONB,kind TEXT) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('kind','entity','entity_type',private.workflow_catalog_v1()#>ARRAY['triggers',kind,'simulation_entity_type'],
        'entity_id',x->(private.workflow_catalog_v1()#>>ARRAY['triggers',kind,'simulation_entity_type']))
$$;
CREATE FUNCTION pg_temp.fact_read(x JSONB,kind TEXT,graph JSONB DEFAULT NULL,context JSONB DEFAULT NULL) RETURNS JSONB LANGUAGE sql AS $$
    SELECT public.get_automation_workflow_simulation_facts_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,
        coalesce(graph,pg_temp.fact_graph(kind)),coalesce(context,pg_temp.fact_context(x,kind)))
$$;
CREATE FUNCTION pg_temp.fact_private(x JSONB,kind TEXT,captured JSONB DEFAULT NULL,filter_id UUID DEFAULT NULL,at TIMESTAMPTZ DEFAULT clock_timestamp()) RETURNS JSONB LANGUAGE sql AS $$
    SELECT private.workflow_current_source_facts_v1((x->>'studio')::UUID,kind,(x->>(private.workflow_catalog_v1()#>>ARRAY['triggers',kind,'simulation_entity_type']))::UUID,
        captured,pg_temp.fact_graph(kind,NULL,filter_id)#>'{nodes,0,config}',at,
        ARRAY(SELECT jsonb_array_elements_text(private.workflow_catalog_v1()#>ARRAY['triggers',kind,'recipient_ids'])))
$$;
CREATE FUNCTION pg_temp.fact_snapshot() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r RECORD; rows JSONB; result JSONB:='{}';
BEGIN
    FOR r IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND (n.nspname IN ('public','private') OR (n.nspname='auth' AND c.relname='users')) ORDER BY n.nspname,c.relname LOOP
        EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT),''[]''::JSONB) FROM %I.%I t',r.nspname,r.relname) INTO rows;
        result:=result||jsonb_build_object(r.nspname||'.'||r.relname,rows);
    END LOOP;
    RETURN result;
END $$;
-- fixture owners end.
GRANT ALL ON pg_temp.current_fact_checks TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); y JSONB:=pg_temp.fact_fixture(); kind TEXT; r RECORD; got JSONB; before JSONB;
    meta JSONB; expected TEXT[]; key TEXT; g JSONB; bad JSONB; spec TEXT; synthetic JSONB;
BEGIN
    FOR r IN SELECT p.*,n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname IN
        ('workflow_fact_text_v1','workflow_staff_auth_email_v1','workflow_current_staff_recipient_v1','workflow_current_rank_authority_v1',
        'workflow_current_source_facts_v1','workflow_graph_read_issues_v1','workflow_simulation_projection_v1','get_automation_workflow_simulation_facts_v1','get_belt_test_recipient_v1') LOOP
        PERFORM pg_temp.fact_check(pg_get_userbyid(r.proowner)='postgres' AND r.proconfig=ARRAY['search_path=""']
            AND r.prosecdef=(r.proname='workflow_staff_auth_email_v1') AND NOT has_function_privilege('anon',r.oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',r.oid,'EXECUTE') AND has_function_privilege('service_role',r.oid,'EXECUTE'), 'function boundary '||r.proname);
        PERFORM pg_temp.fact_check(r.provolatile=CASE WHEN r.nspname='public' THEN 'v' WHEN r.proname='workflow_fact_text_v1' THEN 'i' ELSE 's' END,'function volatility '||r.proname);
    END LOOP;
    FOR kind,meta IN SELECT e.key,e.value FROM jsonb_each(private.workflow_catalog_v1()->'triggers') e LOOP
        UPDATE public.lead_trial_appointments SET status=CASE WHEN kind IN ('trial.completed','trial.no_show') THEN substr(kind,7) ELSE 'scheduled' END
            WHERE id=(x->>'trial_appointment')::UUID;
        before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_read(x,kind);
        PERFORM pg_temp.fact_check(got#>'{payload,valid}'='true'::JSONB AND got#>>'{payload,event_type}'=kind
            AND got#>>'{payload,facts,source_decision}'='eligible','positive '||kind);
        PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'zero writes positive '||kind);
        SELECT array_agg(k ORDER BY k) INTO expected FROM jsonb_object_keys(got#>'{payload,facts,condition_facts}') k;
        PERFORM pg_temp.fact_check(expected=ARRAY(SELECT jsonb_array_elements_text(meta->'field_ids') ORDER BY 1),'all applicable conditions '||kind);
        SELECT array_agg(k ORDER BY k) INTO expected FROM jsonb_object_keys(got#>'{payload,facts,template_facts}') k;
        PERFORM pg_temp.fact_check(expected=ARRAY(SELECT v FROM jsonb_array_elements_text(meta->'template_variables') v WHERE v<>'recipient_name' ORDER BY 1),'all applicable templates '||kind);
        synthetic:=pg_temp.fact_read(x,kind,NULL,'{"kind":"synthetic"}');
        PERFORM pg_temp.fact_check(synthetic#>'{payload,valid}'='true'::JSONB AND synthetic#>'{payload,facts}'='null'::JSONB,'synthetic no customer facts '||kind);
        PERFORM pg_temp.fact_error(format('SELECT pg_temp.fact_read(%L,%L,NULL,%L)',x,kind,pg_temp.fact_context(x,kind)||jsonb_build_object('entity_id',gen_random_uuid())),
            'P0002','AUTOMATION_NOT_FOUND','missing scoped entity '||kind);
        PERFORM pg_temp.fact_error(format('SELECT pg_temp.fact_read(%L,%L,NULL,%L)',x,kind,pg_temp.fact_context(y,kind)),
            'P0002','AUTOMATION_NOT_FOUND','foreign scoped entity '||kind);
        PERFORM pg_temp.fact_check(NOT got::TEXT LIKE '%@example.invalid%' AND NOT got::TEXT LIKE '%recipient_addresses%','public address privacy '||kind);
    END LOOP;
    g:=pg_temp.fact_graph('lead.created');
    g:=jsonb_set(g,'{nodes,0,config,program_id}',y->'program'); before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_read(x,'lead.created',g);
    PERFORM pg_temp.fact_check(got#>'{payload,valid}'='false'::JSONB AND got#>>'{payload,issues,0,code}'='reference_unavailable'
        AND got#>>'{payload,issues,0,node_id}'='trigger' AND got#>>'{payload,issues,0,field}'='config.program_id','safe located foreign reference');
    g:=jsonb_set(pg_temp.fact_graph('lead.created'),'{edges}','[]'); got:=pg_temp.fact_read(x,'lead.created',g);
    PERFORM pg_temp.fact_check(got#>'{payload,valid}'='false'::JSONB AND got#>'{payload,facts}'='null'::JSONB,'invalid submitted graph');
    got:=pg_temp.fact_read(x,'lead.created',NULL,pg_temp.fact_context(x,'student.enrolled'));
    PERFORM pg_temp.fact_check(got#>'{payload,valid}'='false'::JSONB AND got#>>'{payload,issues,0,code}'='context_mismatch','incompatible entity context');
    PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'zero writes invalid missing and synthetic');
    PERFORM pg_temp.fact_error(format('SELECT pg_temp.fact_read(%L,%L,%L)',x||jsonb_build_object('actor',y->'actor'),'lead.created',g),'42501','AUTOMATION_ADMIN_REQUIRED','invalid graph still authorizes actor');
    PERFORM pg_temp.fact_error(format('SELECT pg_temp.fact_read(%L,%L,%L)',x||jsonb_build_object('workflow',y->'workflow'),'lead.created',g),'P0002','AUTOMATION_NOT_FOUND','invalid graph still checks workflow');
    FOREACH bad IN ARRAY ARRAY['null'::JSONB,'{}','{"kind":"entity"}','{"kind":"synthetic","entity_id":null}',
        '{"kind":"entity","entity_type":"lead","entity_id":null}'] LOOP
        PERFORM pg_temp.fact_error(format('SELECT pg_temp.fact_read(%L,%L,NULL,%L)',x,'lead.created',bad),'22023','AUTOMATION_INVALID_REQUEST','closed context '||bad::TEXT);
    END LOOP;
    UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id=(x->>'staff')::UUID;
    UPDATE public.staff_roles SET role='admin' WHERE user_id=(x->>'staff')::UUID;
    UPDATE public.studios SET owner_id=(x->>'staff')::UUID WHERE id=(x->>'studio')::UUID;
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE user_id=(x->>'actor')::UUID;
    PERFORM pg_temp.fact_error(format('SELECT pg_temp.fact_read(%L,%L)',x,'lead.created'),'42501','AUTOMATION_ADMIN_REQUIRED','current archived actor denied');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); s UUID:=(x->>'studio')::UUID; st UUID:=(x->>'student')::UUID;
    ld UUID:=(x->>'lead')::UUID; staff UUID:=(x->>'staff')::UUID; g1 UUID:=gen_random_uuid(); g2 UUID:=gen_random_uuid(); got JSONB; before JSONB;
BEGIN
    got:=pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(got#>>'{facts,recipients,lead_or_guardian,template_facts,recipient_name,value}'='Lead Person'
        AND got#>>'{facts,recipients,assigned_staff,template_facts,recipient_name,value}'='Assigned Teacher','distinct role names');
    PERFORM pg_temp.fact_check(got#>>'{recipient_addresses,assigned_staff,kind}'='assigned_staff'
        AND got#>>'{facts,recipients,assigned_staff,decision}'='ready','ordinary staff does not require verified Auth email');
    UPDATE public.leads SET is_minor=true,guardian_name='Lead Guardian',guardian_email=' LEAD.GUARDIAN@EXAMPLE.INVALID ' WHERE id=ld;
    got:=pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(got#>>'{recipient_addresses,lead_or_guardian,email}'='lead.guardian@example.invalid'
        AND got#>>'{recipient_addresses,lead_or_guardian,kind}'='guardian' AND got#>>'{facts,recipients,lead_or_guardian,template_facts,recipient_name,value}'='Lead Guardian','stored lead guardian normalized');
    UPDATE public.leads SET guardian_email=NULL WHERE id=ld;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'lead.created')#>>'{facts,recipients,lead_or_guardian,decision}'='skip','minor lead never falls back');
    UPDATE public.leads SET is_minor=NULL,source=NULL WHERE id=ld;
    got:=pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND NOT got#>'{facts,condition_facts}' ? 'lead.source'
        AND got#>>'{facts,recipients,lead_or_guardian,decision}'='unavailable','nullable malformed lead facts remain unavailable');
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE user_id=staff;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'lead.created')#>>'{facts,recipients,assigned_staff,reason}'='staff_unavailable','archived assigned staff skip');
    UPDATE public.staff_roles SET archived_at=NULL WHERE user_id=staff;
    DELETE FROM public.staff_profiles WHERE user_id=staff;
    got:=pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(got#>>'{facts,recipients,assigned_staff,decision}'='ready'
        AND got#>'{facts,recipients,assigned_staff,template_facts,recipient_name,value}'='null'::JSONB,'missing legal profile known null');
    UPDATE auth.users SET email='not an email' WHERE id=staff;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'lead.created')#>>'{facts,recipients,assigned_staff,reason}'='invalid_email','invalid Auth email no invited fallback');
    UPDATE public.students SET preferred_name=U&'\2003\0009',email=' ADULT@EXAMPLE.INVALID ' WHERE id=st;
    got:=pg_temp.fact_private(x,'student.enrolled');
    PERFORM pg_temp.fact_check(got#>>'{facts,template_facts,student_first_name,value}'='Student'
        AND got#>>'{recipient_addresses,student_or_guardian,email}'='adult@example.invalid','blank preference and normalized adult email');
    UPDATE public.students SET date_of_birth=CURRENT_DATE-INTERVAL '8 years' WHERE id=st;
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact) VALUES(g1,s,'Primary','Guardian','primary@example.invalid',true),(g2,s,'Other','Guardian','other@example.invalid',false);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(st,g1),(st,g2);
    got:=pg_temp.fact_private(x,'student.enrolled');
    PERFORM pg_temp.fact_check(got#>>'{recipient_addresses,student_or_guardian,email}'='primary@example.invalid'
        AND got#>'{facts,condition_facts,student.is_minor}'='true'::JSONB,'known DOB routes primary guardian');
    UPDATE public.guardians SET is_primary_contact=true,email=NULL WHERE id=g2;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,recipients,student_or_guardian,reason}'='guardian_ambiguous','two primaries even one usable');
    UPDATE public.guardians SET is_primary_contact=false,email='other@example.invalid' WHERE id=g2;
    UPDATE public.guardians SET email=NULL WHERE id=g1;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{recipient_addresses,student_or_guardian,email}'='other@example.invalid','one invalid primary one usable secondary');
    UPDATE public.guardians SET is_primary_contact=false,email='first@example.invalid' WHERE id=g1;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,recipients,student_or_guardian,reason}'='guardian_ambiguous','two usable nonprimaries');
    UPDATE public.guardians SET email=NULL WHERE id IN (g1,g2);
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,recipients,student_or_guardian,reason}'='guardian_missing','minor student never falls back');
    -- Current writes reject these dates. Model legacy corruption only inside the
    -- rollback fixture, restore the birth guard before each actual reader call.
    ALTER TABLE public.students DISABLE TRIGGER validate_students_birth_date;
    UPDATE public.students SET date_of_birth='infinity' WHERE id=st;
    ALTER TABLE public.students ENABLE TRIGGER validate_students_birth_date;
    got:=pg_temp.fact_private(x,'student.enrolled');
    PERFORM pg_temp.fact_check(NOT got#>'{facts,condition_facts}' ? 'student.is_minor'
        AND got#>>'{facts,recipients,student_or_guardian,decision}'='unavailable','invalid DOB unavailable');
    ALTER TABLE public.students DISABLE TRIGGER validate_students_birth_date;
    UPDATE public.students SET date_of_birth=CURRENT_DATE+1 WHERE id=st;
    ALTER TABLE public.students ENABLE TRIGGER validate_students_birth_date;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,recipients,student_or_guardian,reason}'='invalid_birth_date','future DOB unavailable');
    UPDATE public.students SET date_of_birth=NULL WHERE id=st;
    UPDATE public.students SET is_minor=true WHERE id=st;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>'{facts,condition_facts,student.is_minor}'='true'::JSONB,'absent DOB explicit minor fallback');
    UPDATE public.students SET is_minor=false,date_of_birth=NULL,email='suppressed@example.invalid' WHERE id=st;
    INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES(s,'suppressed@example.invalid');
    got:=pg_temp.fact_private(x,'student.enrolled');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND got#>>'{facts,recipients,student_or_guardian,reason}'='suppressed'
        AND got#>'{recipient_addresses,student_or_guardian}'='{"email":null,"kind":null}'::JSONB,'suppression is email only');
    UPDATE public.students SET hold_start_date=CURRENT_DATE,hold_end_date=CURRENT_DATE WHERE id=st;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,source_reason}'='on_hold','inclusive hold both endpoints');
    UPDATE public.students SET hold_start_date=CURRENT_DATE+1,hold_end_date=NULL WHERE id=st;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,source_decision}'='eligible','future hold inactive');
    UPDATE public.students SET hold_start_date=NULL,hold_end_date=NULL,preferred_name=repeat('x',6000) WHERE id=st;
    got:=pg_temp.fact_private(x,'student.enrolled');
    PERFORM pg_temp.fact_check(length(got#>>'{facts,template_facts,student_first_name,value}')=5001,'oversize text remains provably unrenderable');
    UPDATE public.students SET preferred_name='Bad'||chr(10)||'Name' WHERE id=st;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,template_facts,student_first_name,value}'='Bad'||chr(10)||'Name','known control preserved for safe renderer failure');
    before:=pg_temp.fact_snapshot(); PERFORM pg_temp.fact_private(x,'student.enrolled'); PERFORM pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'zero writes missing contact and unavailable minority');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); s UUID:=(x->>'studio')::UUID; st UUID:=(x->>'student')::UUID; m UUID:=(x->>'membership')::UUID;
    captured JSONB; got JSONB; before JSONB; change JSONB; kind TEXT; scope UUID; old_event JSONB; pr public.promotions;
BEGIN
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled',NULL,(x->>'program')::UUID)#>>'{facts,source_decision}'='eligible','hypothetical filtered welcome current paused membership');
    captured:=jsonb_build_object('student_id',st,'matched_program_ids','[]'::JSONB);
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled',captured,(x->>'program')::UUID)#>>'{facts,source_decision}'='ineligible','runtime welcome requires captured match');
    captured:=jsonb_set(captured,'{matched_program_ids}',jsonb_build_array(x->'program'));
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled',captured,(x->>'program')::UUID)#>>'{facts,source_decision}'='eligible','runtime welcome captured and current match');
    FOREACH kind IN ARRAY ARRAY['student.enrolled','student.promoted','lead.created','trial.scheduled','belt_test.approved','invoice.payment_failed','invoice.overdue'] LOOP
        PERFORM pg_temp.fact_check(pg_temp.fact_private(x,kind,'null'::JSONB)#>>'{facts,source_decision}'='unavailable','present malformed context no hypothetical fallback '||kind);
    END LOOP;
    SELECT context INTO captured FROM private.automation_workflow_events WHERE studio_id=s AND source_key=x->>'promotion' AND event_type='student.promoted';
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.promoted',captured)#>>'{facts,source_decision}'='eligible','exact captured promotion');
    before:=pg_temp.fact_snapshot();
    FOREACH change IN ARRAY ARRAY[captured-'rank_context_generation',captured||'{"rank_context_generation":0}',captured||'{"program_id":1}',captured||'{"rank_id":null}'] LOOP
        PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.promoted',change)#>>'{facts,source_decision}'='unavailable','malformed promotion '||md5(change::TEXT));
    END LOOP;
    PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'malformed provenance no writes');
    scope:=private.workflow_rank_scope_enter_v1(s,st,'profile'); before:=pg_temp.fact_snapshot();
    got:=pg_temp.fact_private(x,'student.promoted');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable' AND pg_temp.fact_snapshot()=before,'active rank scope with no dirty rows never repaired');
    PERFORM private.workflow_rank_scope_finish_v1(scope); PERFORM private.workflow_rank_finalize_pending_v1(s);
    pr:=public.record_student_rank_transition_v3(s,st,m,(x->>'program')::UUID,(x->>'rank0')::UUID,(x->>'actor')::UUID,'Proof','demotion',gen_random_uuid());
    pr:=public.record_student_rank_transition_v3(s,st,m,(x->>'program')::UUID,(x->>'rank1')::UUID,(x->>'actor')::UUID,NULL,'promotion',gen_random_uuid());
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.promoted',captured)#>>'{facts,source_reason}'='rank_context_superseded','rank ABA cannot revive old promotion');
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'belt_test.approved')#>>'{facts,source_decision}'='ineligible','rank ABA invalidates prior explicit approval');
    -- A fixture-only historical promotion has no event. Never pick a later one.
    INSERT INTO public.promotions(studio_id,student_id,to_rank_id,program_id,command_program_id,command_membership_id,transition_kind,to_rank_name_snapshot)
        VALUES(s,st,(x->>'rank1')::UUID,(x->>'program')::UUID,(x->>'program')::UUID,m,'promotion','Historical') RETURNING id INTO scope;
    got:=pg_temp.fact_private(x||jsonb_build_object('promotion',scope),'student.promoted');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable','historical promotion missing capture');
    UPDATE public.students SET status='inactive' WHERE id=st;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x||jsonb_build_object('promotion',scope),'student.promoted')#>>'{facts,source_decision}'='ineligible','inactive beats historical capture gap');
    x:=pg_temp.fact_fixture(true); got:=pg_temp.fact_private(x,'belt_test.approved');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible','explicit original legacy belt context');
    x:=pg_temp.fact_fixture(false,true); got:=pg_temp.fact_private(x,'belt_test.approved');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND got#>'{facts,condition_facts,program.id}'=x->'program','unscoped event keeps explicit membership program');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); s UUID:=(x->>'studio')::UUID; ld UUID:=(x->>'lead')::UUID; tr UUID:=(x->>'trial_appointment')::UUID;
    captured JSONB; got JSONB; before JSONB; kind TEXT; context JSONB;
BEGIN
    UPDATE public.leads SET stage='offer_sent',program_id=(x->>'program2')::UUID WHERE id=ld;
    got:=pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND got#>>'{facts,condition_facts,lead.stage}'='offer_sent'
        AND got#>'{facts,condition_facts,program.id}'=x->'program2','open progress and unfiltered lead program reassignment');
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'lead.created',NULL,(x->>'program')::UUID)#>>'{facts,source_decision}'='ineligible','filtered lead stops after program reassignment');
    got:=pg_temp.fact_private(x,'trial.scheduled');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND got#>'{facts,condition_facts,program.id}'=x->'program','trial keeps exact appointment program');
    captured:=jsonb_build_object('appointment_id',tr,'lead_id',ld,'program_id',x->'program','revision',1,'status','scheduled');
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.upcoming',captured)#>>'{facts,source_decision}'='eligible','upcoming uses scheduled context');
    UPDATE public.lead_trial_appointments SET revision=revision+1,location='Changed' WHERE id=tr;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.scheduled',captured)#>>'{facts,source_reason}'='source_context_changed','captured trial revision');
    UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '1 day',ends_at=clock_timestamp()-INTERVAL '23 hours' WHERE id=tr;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.upcoming')#>>'{facts,source_decision}'='ineligible','known trial expired');
    UPDATE public.lead_trial_appointments SET status='no_show',rebooking_superseded=true WHERE id=tr;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.no_show')#>>'{facts,source_reason}'='trial_rebooked','durable replacement marker stops old no-show');
    UPDATE public.lead_trial_appointments SET status='completed' WHERE id=tr;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.completed')#>>'{facts,source_decision}'='eligible','completed not suppressed by replacement marker');
    UPDATE public.leads SET converted_student_id=(x->>'student')::UUID,stage='inquiry' WHERE id=ld;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'lead.created')#>>'{facts,source_decision}'='ineligible','open-looking converted lead stops');
    UPDATE public.leads SET converted_student_id=NULL,stage='closed_lost' WHERE id=ld;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.completed')#>>'{facts,source_decision}'='ineligible','closed lead stops completed followup');
    x:=pg_temp.fact_fixture(); s:=(x->>'studio')::UUID;
    UPDATE public.programs SET archived_at=clock_timestamp() WHERE id=(x->>'program')::UUID;
    FOREACH kind IN ARRAY ARRAY['student.promoted','lead.created','trial.scheduled','belt_test.approved'] LOOP
        PERFORM pg_temp.fact_check(pg_temp.fact_private(x,kind)#>>'{facts,source_decision}'='ineligible','archived exact program '||kind);
    END LOOP;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled')#>>'{facts,source_decision}'='eligible','unfiltered welcome ignores program loss');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); s UUID:=(x->>'studio')::UUID; i UUID:=(x->>'invoice')::UUID; pay UUID:=(x->>'payment')::UUID;
    captured JSONB; overdue JSONB; got JSONB; before JSONB; newid UUID:=gen_random_uuid(); k TEXT;
BEGIN
    SELECT context INTO captured FROM private.automation_workflow_events WHERE studio_id=s AND event_type='invoice.payment_failed' AND source_key=pay::TEXT;
    SELECT jsonb_build_object('invoice_id',id,'payer_id',payer_id,'due_date',to_char(due_date,'YYYY-MM-DD'),
        'stripe_account_id',stripe_account_id,'stripe_customer_id',stripe_customer_id,'stripe_invoice_id',stripe_invoice_id,
        'connect_account_generation',1,'currency',upper(currency)) INTO overdue FROM public.billing_invoices WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue',overdue)#>>'{facts,source_decision}'='eligible','exact runtime overdue context');
    FOREACH k IN ARRAY ARRAY['invoice_id','payer_id','due_date','stripe_account_id','stripe_customer_id','stripe_invoice_id','connect_account_generation','currency'] LOOP
        PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue',overdue-k)#>>'{facts,source_decision}'='unavailable','missing overdue captured key '||k);
    END LOOP;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue',overdue||'{"due_date":"2026-02-30"}')#>>'{facts,source_decision}'='unavailable','malformed captured calendar date');
    UPDATE public.billing_invoices SET due_date=due_date-1 WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue',overdue)#>>'{facts,source_reason}'='source_context_changed','known captured overdue episode changed');
    UPDATE public.billing_invoices SET due_date=(overdue->>'due_date')::DATE WHERE id=i;
    UPDATE public.billing_payers SET email=' ACTUAL.PAYER@EXAMPLE.INVALID ' WHERE id=(x->>'payer')::UUID;
    got:=pg_temp.fact_private(x,'invoice.overdue');
    PERFORM pg_temp.fact_check(got#>>'{recipient_addresses,invoice_payer,email}'='actual.payer@example.invalid'
        AND got#>>'{facts,recipients,invoice_payer,template_facts,recipient_name,value}'='Invoice Payer','actual current invoice payer contact');
    UPDATE public.billing_invoices SET collection_method=NULL WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue')#>'{facts,condition_facts,invoice.collection_method}'='null'::JSONB,'known nullable collection method');
    UPDATE public.billing_invoices SET currency='EUR' WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.payment_failed')#>>'{facts,source_decision}'='unavailable','current payment invoice currency disagreement');
    UPDATE public.billing_payments SET currency='EUR' WHERE id=pay;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.payment_failed')#>>'{facts,source_reason}'='source_context_changed','consistent current replacement currency supersedes capture');
    UPDATE public.billing_invoices SET currency='USD' WHERE id=i; UPDATE public.billing_payments SET currency='USD' WHERE id=pay;
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,idempotency_key,net_collected_amount_cents)
        SELECT newid,studio_id,payer_id,invoice_id,'succeeded',100,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,newid::TEXT,100 FROM public.billing_payments WHERE id=pay;
    UPDATE public.billing_invoices SET amount_remaining_cents=1134 WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.payment_failed')#>>'{facts,source_reason}'='payment_settled','partial successful settlement supersedes failure');
    got:=pg_temp.fact_private(x,'invoice.overdue',overdue);
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND got#>>'{facts,template_facts,invoice_balance,amount_minor_units}'='1134','overdue independent from partial settlement generation');
    UPDATE public.billing_invoices SET status='paid',amount_remaining_cents=0 WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.payment_failed','{}')#>>'{facts,source_decision}'='ineligible','paid terminal dominates missing captured authority');
    x:=pg_temp.fact_fixture(); s:=(x->>'studio')::UUID; i:=(x->>'invoice')::UUID; pay:=(x->>'payment')::UUID;
    UPDATE public.billing_invoices SET currency='ZZZ' WHERE id=i; UPDATE public.billing_payments SET currency='ZZZ' WHERE id=pay;
    got:=pg_temp.fact_private(x,'invoice.overdue');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='eligible' AND got#>>'{facts,template_facts,invoice_balance,currency}'='ZZZ','known unsupported currency retained for formatter');
    UPDATE public.billing_invoices SET external=true WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue')#>>'{facts,source_decision}'='unavailable','external invoice unit provenance unavailable');
    UPDATE public.billing_invoices SET external=false,metadata=metadata||'{"demo":true}' WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue')#>>'{facts,source_reason}'='demo_source','explicit demo true excludes');
    UPDATE public.billing_invoices SET metadata=metadata||'{"demo":"true"}' WHERE id=i;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue')#>>'{facts,source_decision}'='eligible','demo string is not explicit boolean true');
    UPDATE public.billing_invoices SET due_date=NULL WHERE id=i;
    got:=pg_temp.fact_private(x,'invoice.overdue');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='ineligible' AND got#>'{facts,template_facts,invoice_due_date,value}'='null'::JSONB,'known null due date');
    UPDATE public.billing_invoices SET due_date='infinity' WHERE id=i;
    got:=pg_temp.fact_private(x,'invoice.overdue');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable' AND NOT got#>'{facts,template_facts}' ? 'invoice_due_date','nonfinite due date unavailable');
    before:=pg_temp.fact_snapshot(); PERFORM pg_temp.fact_private(x,'invoice.overdue');
    PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'financial unavailable read never repairs');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); y JSONB:=pg_temp.fact_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    e UUID:=(x->>'event')::UUID; rc UUID:=(x->>'belt_test_recipient')::UUID; op UUID:=gen_random_uuid(); original JSONB; current JSONB; first JSONB; kind TEXT;
BEGIN
    first:=public.get_belt_test_recipient_v1(s,a,e,rc);
    PERFORM pg_temp.fact_check((SELECT count(*)=15 FROM jsonb_object_keys(first->'payload')) AND first#>>'{payload,revision}'='1','exact fifteen-field current belt DTO');
    original:=public.revoke_belt_test_recipient_v1(s,a,e,rc,op,1);
    PERFORM public.approve_belt_test_recipients_v1(s,a,e,gen_random_uuid(),1,jsonb_build_array(jsonb_build_object('student_id',x->'student','student_program_membership_id',x->'membership')));
    current:=public.get_belt_test_recipient_v1(s,a,e,rc);
    PERFORM pg_temp.fact_check(current#>>'{payload,revision}'='3' AND current#>>'{payload,state}'='approved'
        AND original#>>'{payload,revision}'='2' AND (SELECT result=original->'payload' FROM private.automation_command_operations WHERE studio_id=s AND operation_id=op),'current reapproval distinct from original immutable revoke receipt');
    UPDATE public.belt_test_events SET revision=revision+1,name='Renamed only' WHERE id=e;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'belt_test.approved')#>>'{facts,source_decision}'='eligible','name-only event revision preserves approval schedule');
    FOREACH kind IN ARRAY ARRAY['draft','scheduled','completed','canceled'] LOOP
        UPDATE public.belt_test_events SET status=kind WHERE id=e;
        PERFORM pg_temp.fact_check(public.get_belt_test_recipient_v1(s,a,e,rc)=current,'current history readable through '||kind);
    END LOOP;
    UPDATE public.belt_test_events SET starts_at=clock_timestamp()-INTERVAL '2 days',ends_at=clock_timestamp()-INTERVAL '1 day 23 hours' WHERE id=e;
    PERFORM pg_temp.fact_check(public.get_belt_test_recipient_v1(s,a,e,rc)=current,'current history through past event');
    DELETE FROM public.student_program_memberships WHERE id=(x->>'membership')::UUID;
    PERFORM pg_temp.fact_check(public.get_belt_test_recipient_v1(s,a,e,rc)=current,'missing logical membership does not erase history');
    PERFORM pg_temp.fact_error(format('SELECT public.get_belt_test_recipient_v1(%L,%L,%L,%L)',s,a,y->>'event',rc),'P0002','AUTOMATION_NOT_FOUND','belt wrong parent');
    PERFORM pg_temp.fact_error(format('SELECT public.get_belt_test_recipient_v1(%L,%L,%L,%L)',s,a,e,y->>'belt_test_recipient'),'P0002','AUTOMATION_NOT_FOUND','belt foreign child');
    PERFORM pg_temp.fact_error(format('SELECT public.get_belt_test_recipient_v1(%L,%L,%L,NULL)',s,a,e),'22023','AUTOMATION_INVALID_REQUEST','belt missing required child');
    UPDATE public.studio_subscriptions SET status='canceled',comped=false WHERE studio_id=s;
    PERFORM pg_temp.fact_error(format('SELECT public.get_belt_test_recipient_v1(%L,%L,%L,%L)',s,a,e,rc),'42501','AUTOMATION_ADMIN_REQUIRED','belt current entitlement denied');
END $$;
DO $$
DECLARE x JSONB:=pg_temp.fact_fixture(); y JSONB:=pg_temp.fact_fixture(); s UUID:=(x->>'studio')::UUID; st UUID:=(x->>'student')::UUID;
    m UUID:=(x->>'membership')::UUID; scope UUID; history UUID:=gen_random_uuid(); pay UUID:=gen_random_uuid(); success UUID:=gen_random_uuid();
    before JSONB; got JSONB; captured JSONB; k TEXT; original TEXT;
BEGIN
    INSERT INTO public.promotions(id,studio_id,student_id,to_rank_id,transition_kind,to_rank_name_snapshot)
        VALUES(history,s,st,(x->>'rank1')::UUID,'promotion','Historical rank');
    got:=pg_temp.fact_private(x||jsonb_build_object('promotion',history),'student.promoted');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable'
        AND NOT got#>'{facts,condition_facts}' ? 'program.id'
        AND NOT got#>'{facts,template_facts}' ? 'program_name','historical null command context is not proved legacy');
    SET CONSTRAINTS private.workflow_rank_deferred DEFERRED;
    scope:=private.workflow_rank_scope_enter_v1(s,st,'profile');
    UPDATE public.student_program_memberships SET current_belt_rank_id=NULL WHERE id=m;
    before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'student.promoted');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable' AND pg_temp.fact_snapshot()=before,'temporary pending rank tuple is unavailable without repair');
    UPDATE public.student_program_memberships SET current_belt_rank_id=(x->>'rank1')::UUID WHERE id=m;
    PERFORM private.workflow_rank_scope_finish_v1(scope);
    before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'student.promoted');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable' AND pg_temp.fact_snapshot()=before,'completed unfinalized rank scope remains unavailable');
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    INSERT INTO private.workflow_payment_capture_markers(payment_id,studio_id,eligible) VALUES(pay,s,false);
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,idempotency_key)
        SELECT pay,studio_id,payer_id,invoice_id,'failed',amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,pay::TEXT
        FROM public.billing_payments WHERE id=(x->>'payment')::UUID;
    PERFORM pg_temp.fact_check(NOT EXISTS(SELECT 1 FROM private.automation_workflow_events WHERE studio_id=s AND source_key=pay::TEXT)
        AND pg_temp.fact_private(x||jsonb_build_object('payment',pay),'invoice.payment_failed')#>>'{facts,source_decision}'='unavailable','historical failed payment has no fabricated capture');
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,idempotency_key,net_collected_amount_cents)
        SELECT success,studio_id,payer_id,invoice_id,'succeeded',100,currency,stripe_account_id,stripe_customer_id,stripe_invoice_id,connect_account_generation,payment_method_type,success::TEXT,100
        FROM public.billing_payments WHERE id=(x->>'payment')::UUID;
    UPDATE public.billing_invoices SET currency='invalid' WHERE id=(x->>'invoice')::UUID;
    before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'invoice.payment_failed');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_reason}'='payment_settled' AND pg_temp.fact_snapshot()=before,'known later settlement survives current financial outage');
    -- The normal writer forbids duplicate membership. Model historical damage
    -- in this rollback fixture, then restore the guard before the reader.
    ALTER TABLE public.staff_roles DISABLE TRIGGER enforce_single_studio_membership;
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES((y->>'studio')::UUID,(x->>'staff')::UUID,'instructor');
    ALTER TABLE public.staff_roles ENABLE TRIGGER enforce_single_studio_membership;
    got:=pg_temp.fact_private(x,'lead.created');
    PERFORM pg_temp.fact_check(got#>>'{facts,recipients,assigned_staff,decision}'='unavailable'
        AND got#>'{recipient_addresses,assigned_staff}'='{"email":null,"kind":null}'::JSONB,'ambiguous current staff membership unavailable');
    DELETE FROM public.staff_roles WHERE studio_id=(y->>'studio')::UUID AND user_id=(x->>'staff')::UUID;
    -- A known nullable appointment program stays null; a deleted exact parent
    -- keeps its logical ID and stops rather than becoming a nullable fallback.
    UPDATE public.lead_trial_appointments SET program_id=NULL WHERE id=(x->>'trial_appointment')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.scheduled')#>'{facts,condition_facts,program.id}'='null'::JSONB,'known nullable trial program');
    UPDATE public.lead_trial_appointments SET program_id=(y->>'program')::UUID WHERE id=(x->>'trial_appointment')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'trial.scheduled')#>>'{facts,source_reason}'='program_unavailable','foreign logical appointment program');
    UPDATE public.belt_test_events SET schedule_revision=schedule_revision+1,revision=revision+1 WHERE id=(x->>'event')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'belt_test.approved')#>>'{facts,source_decision}'='ineligible','effective belt schedule revision stops old approval');
    x:=pg_temp.fact_fixture(); s:=(x->>'studio')::UUID; st:=(x->>'student')::UUID;
    SELECT context INTO captured FROM private.automation_workflow_events WHERE studio_id=s AND source_key=x->>'promotion' AND event_type='student.promoted';
    UPDATE public.belt_ranks SET name='Current renamed label' WHERE id=(x->>'rank1')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.promoted')#>>'{facts,template_facts,rank_name,value}'='Yellow','promotion keeps committed rank-name snapshot');
    UPDATE public.studios SET timezone='America/Los_Angeles' WHERE id=s;
    UPDATE public.students SET hold_start_date='2026-10-05',hold_end_date='2026-10-05' WHERE id=st;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled',NULL,NULL,'2026-10-06T01:00:00Z')#>>'{facts,source_reason}'='on_hold','holds use studio date rather than UTC date');
    UPDATE public.studios SET timezone='Invalid/Zone' WHERE id=s;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.enrolled',NULL,NULL,'2026-10-06T01:00:00Z')#>>'{facts,source_decision}'='eligible','unknown studio zone uses UTC');
END $$;
DO $$
DECLARE x JSONB; kind TEXT; before JSONB; got JSONB; context JSONB; orphan UUID:=gen_random_uuid();
BEGIN
    FOR kind IN SELECT k FROM jsonb_object_keys(private.workflow_catalog_v1()->'triggers') k LOOP
        x:=pg_temp.fact_fixture();
        IF kind LIKE 'student.%' THEN
            UPDATE public.students SET status='inactive' WHERE id=(x->>'student')::UUID;
        ELSIF kind LIKE 'lead.%' THEN
            UPDATE public.leads SET stage='closed_lost' WHERE id=(x->>'lead')::UUID;
        ELSIF kind LIKE 'trial.%' THEN
            UPDATE public.lead_trial_appointments SET status='canceled' WHERE id=(x->>'trial_appointment')::UUID;
        ELSIF kind='invoice.overdue' THEN
            UPDATE public.billing_invoices SET status='paid',amount_remaining_cents=0 WHERE id=(x->>'invoice')::UUID;
        ELSIF kind='invoice.payment_failed' THEN
            UPDATE public.billing_payments SET status='processing' WHERE id=(x->>'payment')::UUID;
        ELSE
            PERFORM public.revoke_belt_test_recipient_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'event')::UUID,
                (x->>'belt_test_recipient')::UUID,gen_random_uuid(),1);
        END IF;
        before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_read(x,kind);
        PERFORM pg_temp.fact_check(got#>>'{payload,facts,source_decision}'='ineligible','terminal source stops '||kind);
        PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'terminal read zero writes '||kind);
    END LOOP;
    x:=pg_temp.fact_fixture();
    DELETE FROM private.workflow_rank_contexts WHERE studio_id=(x->>'studio')::UUID AND student_id=(x->>'student')::UUID
        AND student_program_membership_id=(x->>'membership')::UUID;
    before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'student.promoted');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable' AND pg_temp.fact_snapshot()=before,'missing rank ledger never seeded by reader');
    UPDATE public.students SET status='inactive' WHERE id=(x->>'student')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.promoted')#>>'{facts,source_decision}'='ineligible','inactive source precedes missing rank ledger');
    x:=pg_temp.fact_fixture();
    DELETE FROM private.workflow_invoice_settlement_authority WHERE studio_id=(x->>'studio')::UUID AND invoice_id=(x->>'invoice')::UUID;
    before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'invoice.payment_failed');
    PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'='unavailable' AND pg_temp.fact_snapshot()=before,'missing settlement ledger never seeded by reader');
    UPDATE public.billing_invoices SET payer_id=NULL WHERE id=(x->>'invoice')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue')#>>'{facts,source_reason}'='invoice_parent_missing','known missing payer stops before absent authority');
    x:=pg_temp.fact_fixture();
    -- The retained update owner preserves an existing invoice link. A genuinely
    -- unlinked initial payment is the admissible missing-parent fixture.
    INSERT INTO public.billing_payments(id,studio_id,payer_id,status,amount_cents,currency,stripe_account_id,stripe_customer_id,connect_account_generation,payment_method_type,idempotency_key)
        SELECT orphan,studio_id,payer_id,'failed',amount_cents,currency,stripe_account_id,stripe_customer_id,connect_account_generation,payment_method_type,orphan::TEXT
        FROM public.billing_payments WHERE id=(x->>'payment')::UUID;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x||jsonb_build_object('payment',orphan),'invoice.payment_failed')#>>'{facts,source_reason}'='invoice_parent_missing','known missing invoice parent');
    x:=pg_temp.fact_fixture();
    SELECT e.context INTO context FROM private.automation_workflow_events e WHERE e.studio_id=(x->>'studio')::UUID AND e.event_type='student.promoted' AND e.source_key=x->>'promotion';
    context:=jsonb_set(context,'{rank_context_generation}','1000');
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'student.promoted',context)#>>'{facts,source_decision}'='unavailable','contradictory future generation is not supersession');
END $$;
DO $$
DECLARE x JSONB; captured JSONB; before JSONB; got JSONB; spec RECORD; base public.billing_invoices; changed public.billing_invoices;
    payment public.billing_payments; mode TEXT;
BEGIN
    FOR spec IN SELECT * FROM (VALUES
        ('currency','{"currency":"bad currency"}'::JSONB,'{"currency":"EUR"}'::JSONB),
        ('generation','{"metadata":{"connect_account_generation":"not-a-generation"}}','{"metadata":{"connect_account_generation":2}}'),
        ('generation missing','{"metadata":{}}','{"metadata":{"connect_account_generation":"2"}}'),
        ('generation zero','{"metadata":{"connect_account_generation":0}}','{"metadata":{"connect_account_generation":2}}'),
        ('generation overflow','{"metadata":{"connect_account_generation":2147483648}}','{"metadata":{"connect_account_generation":2}}'),
        ('generation huge',jsonb_build_object('metadata',jsonb_build_object('connect_account_generation',repeat('9',10000))),'{"metadata":{"connect_account_generation":2}}'),
        ('account empty','{"stripe_account_id":""}','{"stripe_account_id":"acct_replaced"}'),
        ('account missing','{"stripe_account_id":null}','{"stripe_account_id":"acct_replaced"}'),
        ('customer control',jsonb_build_object('stripe_customer_id',E'cus_\tbad'),'{"stripe_customer_id":"cus_replaced"}'),
        ('invoice whitespace','{"stripe_invoice_id":"bad invoice"}','{"stripe_invoice_id":"in_replaced"}'),
        ('date infinity','{"due_date":"infinity"}',jsonb_build_object('due_date',CURRENT_DATE-6)),
        ('date outside Python','{"due_date":"10000-01-01"}',jsonb_build_object('due_date',CURRENT_DATE-6))) v(label,bad,replacement) LOOP
        x:=pg_temp.fact_fixture(); SELECT * INTO base FROM public.billing_invoices WHERE id=(x->>'invoice')::UUID;
        captured:=jsonb_build_object('invoice_id',base.id,'payer_id',base.payer_id,'due_date',to_char(base.due_date,'YYYY-MM-DD'),
            'stripe_account_id',base.stripe_account_id,'stripe_customer_id',base.stripe_customer_id,'stripe_invoice_id',base.stripe_invoice_id,'connect_account_generation',1,'currency','USD');
        FOREACH mode IN ARRAY ARRAY['bad','terminal','replacement'] LOOP
            changed:=jsonb_populate_record(base,CASE WHEN mode='replacement' THEN spec.replacement ELSE spec.bad END);
            UPDATE public.billing_invoices SET currency=changed.currency,due_date=changed.due_date,metadata=changed.metadata,
                stripe_account_id=changed.stripe_account_id,stripe_customer_id=changed.stripe_customer_id,stripe_invoice_id=changed.stripe_invoice_id,
                status=CASE WHEN mode='terminal' THEN 'paid' ELSE 'open' END,amount_remaining_cents=CASE WHEN mode='terminal' THEN 0 ELSE base.amount_remaining_cents END WHERE id=base.id;
            before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'invoice.overdue',captured);
            PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'=CASE WHEN mode='bad' THEN 'unavailable' ELSE 'ineligible' END
                AND (mode<>'replacement' OR got#>>'{facts,source_reason}'='source_context_changed'),mode||' current overdue comparison '||spec.label);
            PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'zero writes '||mode||' current overdue '||spec.label);
        END LOOP;
    END LOOP;
    -- Current payment provider identities are immutable after establishment.
    -- Currency remains an admissible current update under the retained owner.
    FOR spec IN SELECT * FROM (VALUES ('currency','{"currency":"bad currency"}'::JSONB,'{"currency":"EUR"}'::JSONB)) v(label,bad,replacement) LOOP
        x:=pg_temp.fact_fixture();
        FOREACH mode IN ARRAY ARRAY['bad','replacement'] LOOP
            SELECT * INTO payment FROM public.billing_payments WHERE id=(x->>'payment')::UUID;
            payment:=jsonb_populate_record(payment,CASE WHEN mode='bad' THEN spec.bad ELSE spec.replacement END);
            UPDATE public.billing_payments SET currency=payment.currency,stripe_account_id=payment.stripe_account_id,connect_account_generation=payment.connect_account_generation WHERE id=payment.id;
            IF spec.label='currency' AND mode='replacement' THEN UPDATE public.billing_invoices SET currency='EUR' WHERE id=(x->>'invoice')::UUID; END IF;
            before:=pg_temp.fact_snapshot(); got:=pg_temp.fact_private(x,'invoice.payment_failed');
            PERFORM pg_temp.fact_check(got#>>'{facts,source_decision}'=CASE WHEN mode='bad' THEN 'unavailable' ELSE 'ineligible' END,mode||' current payment comparison '||spec.label);
            PERFORM pg_temp.fact_check(pg_temp.fact_snapshot()=before,'zero writes '||mode||' current payment '||spec.label);
        END LOOP;
    END LOOP;
    x:=pg_temp.fact_fixture(); SELECT * INTO base FROM public.billing_invoices WHERE id=(x->>'invoice')::UUID;
    captured:=jsonb_build_object('invoice_id',base.id,'payer_id',base.payer_id,'due_date',to_char(base.due_date,'YYYY-MM-DD'),
        'stripe_account_id',base.stripe_account_id,'stripe_customer_id',base.stripe_customer_id,'stripe_invoice_id',base.stripe_invoice_id,'connect_account_generation',1,'currency','USD');
    UPDATE public.billing_invoices SET currency='Usd',metadata='{"connect_account_generation":"1"}' WHERE id=base.id;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue',captured)#>>'{facts,source_decision}'='eligible','case-only currency and string generation preserve exact current context');
    UPDATE public.billing_invoices SET due_date=NULL WHERE id=base.id;
    PERFORM pg_temp.fact_check(pg_temp.fact_private(x,'invoice.overdue',captured)#>>'{facts,source_reason}'='invoice_not_overdue','known null current due date remains terminal');
END $$;
SELECT count(*) AS current_fact_contract_assertions FROM pg_temp.current_fact_checks;
ROLLBACK;
