-- Synthetic local metadata proof. No traversal, provider admission or mail.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE run_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.run_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'run contract failed: %',label; END IF;
    INSERT INTO pg_temp.run_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.run_error(statement TEXT,code TEXT,label TEXT,message TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actual_code TEXT; actual_message TEXT;
BEGIN
    BEGIN EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual_code=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT;
    END;
    IF actual_code IS DISTINCT FROM code OR (message IS NOT NULL AND actual_message IS DISTINCT FROM message) THEN
        RAISE EXCEPTION 'run negative failed %: % / %, expected % / %',label,actual_code,actual_message,code,message;
    END IF;
    PERFORM pg_temp.run_check(true,label);
END $$;
CREATE FUNCTION pg_temp.run_fixture() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE actor UUID:=gen_random_uuid(); owner UUID:=gen_random_uuid(); desk UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid();
    lead UUID:=gen_random_uuid(); program UUID:=gen_random_uuid(); student UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(actor,actor||'@example.invalid',clock_timestamp()),
        (owner,owner||'@example.invalid',clock_timestamp()),(desk,desk||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Run proof',studio,owner,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin'),(studio,owner,'admin'),(studio,desk,'front_desk');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(program,studio,'Run program');
    INSERT INTO public.leads(id,studio_id,first_name,last_name,program_id) VALUES(lead,studio,'Current','Lead',program);
    INSERT INTO public.students(id,studio_id,legal_first_name,preferred_name,legal_last_name,status)
        VALUES(student,studio,'Legal','Preferred','Student','active');
    SET CONSTRAINTS private.workflow_rank_deferred IMMEDIATE;
    RETURN jsonb_build_object('actor',actor,'owner',owner,'desk',desk,'studio',studio,'lead',lead,'program',program,'student',student);
END $$;
CREATE FUNCTION pg_temp.run_workflow(x JSONB,kind TEXT DEFAULT 'lead.created',emails INTEGER DEFAULT 1) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE graph JSONB; nodes JSONB; edges JSONB:='[]'; i INTEGER; w UUID; recipient TEXT;
BEGIN
    recipient:=CASE WHEN kind LIKE 'lead.%' OR kind LIKE 'trial.%' THEN 'lead_or_guardian'
        WHEN kind LIKE 'invoice.%' THEN 'invoice_payer' ELSE 'student_or_guardian' END;
    nodes:=jsonb_build_array(jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',kind,'program_id',NULL)));
    FOR i IN 1..emails LOOP
        nodes:=nodes||jsonb_build_array(jsonb_build_object('id','email'||i,'type','email','config',
            jsonb_build_object('recipient',recipient,'subject_template','Hello','body_template','Synthetic message','reply_to_email','')));
        edges:=edges||jsonb_build_array(jsonb_build_object('id','edge'||i,'source',CASE WHEN i=1 THEN 'trigger' ELSE 'email'||(i-1) END,'target','email'||i,'port','next'));
    END LOOP;
    nodes:=nodes||'[{"id":"end","type":"end","config":{}}]'::JSONB;
    edges:=edges||jsonb_build_array(jsonb_build_object('id','last','source',CASE WHEN emails=0 THEN 'trigger' ELSE 'email'||emails END,'target','end','port','next'));
    graph:=jsonb_build_object('schema_version',1,'nodes',nodes,'edges',edges);
    w:=(public.create_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,gen_random_uuid(),'Run proof','',graph,'{}')#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),1,'publish');
    PERFORM public.command_automation_workflow_v1((x->>'studio')::UUID,(x->>'actor')::UUID,w,gen_random_uuid(),2,'start');
    RETURN w;
END $$;
CREATE FUNCTION pg_temp.run_seed(x JSONB,w UUID,state TEXT DEFAULT 'queued',kind TEXT DEFAULT 'lead',subject UUID DEFAULT NULL,context JSONB DEFAULT '{}')
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE activation public.automation_workflow_activations; event UUID; result UUID;
BEGIN
    SELECT * INTO STRICT activation FROM public.automation_workflow_activations WHERE workflow_id=w AND retired_at IS NULL;
    INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at,context)
        SELECT (x->>'studio')::UUID,(SELECT n->'config'->>'event_type' FROM jsonb_array_elements(v.graph->'nodes') n WHERE n->>'type'='trigger'),gen_random_uuid()::TEXT,kind,coalesce(subject,(x->>'lead')::UUID),clock_timestamp(),context
        FROM public.automation_workflow_versions v WHERE v.id=activation.version_id RETURNING id INTO event;
    INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,next_due_at,claim_token,lease_expires_at)
        VALUES((x->>'studio')::UUID,w,activation.version_id,event,activation.id,activation.epoch,'trigger',state,
            CASE WHEN state IN ('queued','waiting','claimed','running') THEN clock_timestamp() END,
            CASE WHEN state IN ('claimed','running','sending','unknown') THEN gen_random_uuid() END,
            CASE WHEN state IN ('claimed','running','sending','unknown') THEN clock_timestamp()+INTERVAL '1 hour' END) RETURNING id INTO result;
    RETURN result;
END $$;
CREATE FUNCTION pg_temp.run_history(x JSONB,r UUID,node TEXT DEFAULT 'email1',ordinal INTEGER DEFAULT 1) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE step UUID; attempt UUID; at TIMESTAMPTZ:=clock_timestamp();
BEGIN
    INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at)
        VALUES((x->>'studio')::UUID,r,ordinal,node,'email','sending',at) RETURNING id INTO step;
    INSERT INTO private.automation_workflow_email_attempts(studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at)
        VALUES((x->>'studio')::UUID,r,step,node,1,'sending','synthetic@example.invalid','lead',at) RETURNING id INTO attempt;
    RETURN jsonb_build_object('step',step,'attempt',attempt);
END $$;
GRANT ALL ON pg_temp.run_checks TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO service_role;

RESET ROLE;
DO $$
DECLARE obj REGCLASS; fn REGPROCEDURE; role_name TEXT;
BEGIN
    PERFORM pg_temp.run_check(NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs)
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_run_steps)
        AND NOT EXISTS(SELECT 1 FROM private.automation_workflow_email_attempts),'migration creates no customer history');
    FOREACH obj IN ARRAY ARRAY['private.automation_workflow_run_steps'::REGCLASS,'private.automation_workflow_email_attempts'::REGCLASS] LOOP
        PERFORM pg_temp.run_check((SELECT relpersistence='p' AND relrowsecurity AND pg_get_userbyid(relowner)='postgres' FROM pg_class WHERE oid=obj),'logged postgres RLS '||obj);
        FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
            PERFORM pg_temp.run_check(NOT has_table_privilege(role_name,obj,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'client ACL '||role_name||obj);
        END LOOP;
        PERFORM pg_temp.run_check(has_table_privilege('service_role',obj,'SELECT') AND has_table_privilege('service_role',obj,'INSERT')
            AND has_table_privilege('service_role',obj,'UPDATE') AND NOT has_table_privilege('service_role',obj,'DELETE,TRUNCATE,REFERENCES,TRIGGER'),'service metadata ACL '||obj);
    END LOOP;
    FOREACH fn IN ARRAY ARRAY['public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)'::REGPROCEDURE,
        'public.get_automation_workflow_run_v1(uuid,uuid,uuid)'::REGPROCEDURE,'public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)'::REGPROCEDURE,
        'public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)'::REGPROCEDURE] LOOP
        PERFORM pg_temp.run_check((SELECT NOT prosecdef AND prorettype='jsonb'::REGTYPE AND pg_get_userbyid(proowner)='postgres'
            AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=fn) AND has_function_privilege('service_role',fn,'EXECUTE')
            AND NOT has_function_privilege('anon',fn,'EXECUTE') AND NOT has_function_privilege('authenticated',fn,'EXECUTE'),'RPC signature owner ACL '||fn);
    END LOOP;
    FOREACH fn IN ARRAY ARRAY['private.workflow_run_step_identity_v1()'::REGPROCEDURE,'private.workflow_email_attempt_identity_v1()'::REGPROCEDURE,'private.trial_rebooking_marker_v1()'::REGPROCEDURE] LOOP
        PERFORM pg_temp.run_check(NOT has_function_privilege('service_role',fn,'EXECUTE') AND NOT has_function_privilege('anon',fn,'EXECUTE')
            AND NOT has_function_privilege('authenticated',fn,'EXECUTE'),'trigger has no direct execute '||fn);
    END LOOP;
END $$;

RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.run_fixture(); y JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    w UUID; r UUID; h JSONB; before JSONB; result JSONB; receipt JSONB; op UUID; state TEXT; column_name TEXT; bad TEXT; n INTEGER;
BEGIN
    SET LOCAL ROLE service_role;
    w:=pg_temp.run_workflow(x);
    PERFORM pg_temp.run_check(public.list_automation_workflow_runs_v1(s,a,w)->'payload'='{"items":[],"next_cursor":null,"has_more":false}','existing workflow empty list');
    PERFORM pg_temp.run_error(format('SELECT public.list_automation_workflow_runs_v1(%L,%L,%L)',s,a,gen_random_uuid()),'P0002','missing workflow distinct from empty','AUTOMATION_NOT_FOUND');
    FOREACH state IN ARRAY ARRAY['queued','waiting','claimed','running','sending','completed','cancelled','failed','unknown'] LOOP
        r:=pg_temp.run_seed(x,w,state);
        result:=public.get_automation_workflow_run_v1(s,a,r)->'payload';
        PERFORM pg_temp.run_check(result->'steps'='[]' AND result->'attempts'='[]'
            AND (result#>>'{run,can_cancel}')::BOOLEAN=(state IN ('queued','waiting','claimed','running','sending'))
            AND (result#>'{run,next_due_at}'<>'null')=(state IN ('queued','waiting','claimed','running')),'real empty history and state matrix '||state);
        PERFORM pg_temp.run_error(format('UPDATE public.automation_workflow_runs SET next_due_at=%s WHERE id=%L',
            CASE WHEN state IN ('queued','waiting','claimed','running') THEN 'NULL' ELSE 'clock_timestamp()' END,r),'23514','stored due matrix rejects '||state);
        h:=pg_temp.run_history(x,r); before:=private.workflow_run_detail_v1(s,r);op:=gen_random_uuid();
        IF state IN ('queued','waiting','claimed','running','sending') THEN
            result:=public.cancel_automation_workflow_run_v1(s,a,r,op,1);receipt:=result;
            PERFORM pg_temp.run_check(result#>>'{payload,run,revision}'='2' AND result#>>'{payload,run,cancel_reason}'='run_cancelled'
                AND result#>'{payload,run,can_cancel}'='false' AND result#>'{payload,run,next_due_at}'='null'
                AND result#>'{payload,steps}'=before->'steps' AND result#>'{payload,attempts}'=before->'attempts'
                AND result#>>'{payload,run,state}'=CASE WHEN state='sending' THEN 'sending' ELSE 'cancelled' END,'cancel preserves real metadata '||state);
            PERFORM pg_temp.run_check(public.cancel_automation_workflow_run_v1(s,a,r,op,1)=receipt||'{"replayed":true}','same request original replay '||state);
            PERFORM pg_temp.run_error(format('SELECT public.cancel_automation_workflow_run_v1(%L,%L,%L,%L,2)',s,a,r,gen_random_uuid()),'P0001','already intended new key '||state,'AUTOMATION_STATE_CONFLICT');
            PERFORM pg_temp.run_error(format('SELECT public.cancel_automation_workflow_run_v1(%L,%L,%L,%L,2)',s,a,r,op),'P0001','changed CAS under same key '||state,'AUTOMATION_OPERATION_CONFLICT');
            PERFORM pg_temp.run_error(format('SELECT public.cancel_automation_workflow_run_v1(%L,%L,%L,%L,1)',s,x->>'owner',r,op),'P0001','changed actor under same key '||state,'AUTOMATION_OPERATION_CONFLICT');
            PERFORM pg_temp.run_check(public.get_automation_operation_v1(s,(x->>'owner')::UUID,op)#>'{payload,result}'=result->'payload','other current admin reads original receipt '||state);
            UPDATE public.leads SET first_name='Renamed' WHERE id=(x->>'lead')::UUID;
            UPDATE public.automation_workflow_runs SET revision=3,updated_at=clock_timestamp() WHERE id=r;
            PERFORM pg_temp.run_check(public.cancel_automation_workflow_run_v1(s,a,r,op,1)=receipt||'{"replayed":true}'
                AND private.workflow_run_detail_v1(s,r)#>>'{run,revision}'='3','receipt survives later metadata and label '||state);
        ELSE
            PERFORM pg_temp.run_error(format('SELECT public.cancel_automation_workflow_run_v1(%L,%L,%L,%L,1)',s,a,r,op),'P0001','terminal cancel refusal '||state,'AUTOMATION_STATE_CONFLICT');
            PERFORM pg_temp.run_check(private.workflow_run_detail_v1(s,r)=before AND NOT EXISTS(SELECT 1 FROM private.automation_command_operations WHERE studio_id=s AND operation_id=op),'terminal refusal no write '||state);
        END IF;
    END LOOP;
    r:=pg_temp.run_seed(x,w);h:=pg_temp.run_history(x,r);
    FOREACH column_name IN ARRAY ARRAY['next_due_at','cancel_requested_at','updated_at'] LOOP
        FOREACH bad IN ARRAY ARRAY['infinity','-infinity','0001-01-01 BC','10000-01-01'] LOOP
            PERFORM pg_temp.run_error(format('UPDATE public.automation_workflow_runs SET %I=%L %s WHERE id=%L',column_name,bad,
                CASE WHEN column_name='cancel_requested_at' THEN ',cancel_reason=''test_reason''' ELSE '' END,r),'23514','run timestamp '||column_name||bad);
        END LOOP;
    END LOOP;
    PERFORM pg_temp.run_error(format('UPDATE public.automation_workflow_runs SET reason=''Unsafe Message'' WHERE id=%L',r),'23514','safe run reason');
    PERFORM pg_temp.run_error(format('SELECT public.cancel_automation_workflow_run_v1(%L,%L,%L,%L,2)',s,a,r,gen_random_uuid()),'P0001','stale run revision','AUTOMATION_REVISION_CONFLICT');
    UPDATE public.automation_workflow_runs SET revision=9223372036854775807 WHERE id=r;
    op:=gen_random_uuid();before:=private.workflow_run_detail_v1(s,r);
    PERFORM pg_temp.run_error(format('SELECT public.cancel_automation_workflow_run_v1(%L,%L,%L,%L,9223372036854775807)',s,a,r,op),'P0001','overflow refuses','AUTOMATION_STATE_CONFLICT');
    PERFORM pg_temp.run_check(private.workflow_run_detail_v1(s,r)=before AND NOT EXISTS(SELECT 1 FROM private.automation_command_operations WHERE studio_id=s AND operation_id=op),'overflow atomic');
    PERFORM pg_temp.run_error(format('SELECT public.get_automation_workflow_run_v1(%L,%L,%L)',s,x->>'desk',r),'42501','front desk denied','AUTOMATION_ADMIN_REQUIRED');
    PERFORM pg_temp.run_error(format('SELECT public.get_automation_workflow_run_v1(%L,%L,%L)',y->>'studio',y->>'actor',r),'P0002','foreign scoped run denied','AUTOMATION_NOT_FOUND');
    PERFORM pg_temp.run_error(format('SELECT public.get_automation_workflow_run_v1(%L,%L,NULL)',s,a),'22023','null run rejected','AUTOMATION_INVALID_REQUEST');
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=s;
    PERFORM pg_temp.run_error(format('SELECT public.get_automation_workflow_run_v1(%L,%L,%L)',s,a,r),'42501','current entitlement denied','AUTOMATION_ADMIN_REQUIRED');
END $$;

RESET ROLE;
DO $$
<<specimen>>
DECLARE x JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID; w UUID;
    r UUID; h JSONB; step UUID; attempt UUID; state TEXT; bad TEXT; col TEXT; outcome TEXT; evidence TEXT; scope TEXT; before JSONB;
BEGIN
    SET LOCAL ROLE service_role;w:=pg_temp.run_workflow(x);r:=pg_temp.run_seed(x,w,'sending');h:=pg_temp.run_history(x,r);
    step:=(h->>'step')::UUID;attempt:=(h->>'attempt')::UUID;
    FOREACH col IN ARRAY ARRAY['id','studio_id','run_id','step_id'] LOOP
        PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_email_attempts SET %I=gen_random_uuid() WHERE id=%L',col,attempt),'22023','attempt immutable '||col,'AUTOMATION_IMMUTABLE_RECORD');
    END LOOP;
    FOREACH bad IN ARRAY ARRAY['not an email',' Mixed@Example.invalid ','UPPER@example.invalid',''] LOOP
        PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_email_attempts(studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at) VALUES(%L,%L,%L,''email1'',2,''sending'',%L,''lead'',clock_timestamp())',s,r,step,bad),'23514','invalid normalized mailbox '||bad);
    END LOOP;
    FOREACH col IN ARRAY ARRAY['recipient_email','recipient_kind','node_id','attempt_number','began_at'] LOOP
        PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_email_attempts SET %I=%s WHERE id=%L',col,
            CASE col WHEN 'recipient_email' THEN '''changed@example.invalid''' WHEN 'recipient_kind' THEN '''student''' WHEN 'node_id' THEN '''trigger''' WHEN 'attempt_number' THEN '2' ELSE 'clock_timestamp()' END,attempt),
            '22023','attempt immutable '||col,'AUTOMATION_IMMUTABLE_RECORD');
    END LOOP;
    FOREACH col IN ARRAY ARRAY['sequence','node_id','node_type','entered_at'] LOOP
        PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_run_steps SET %I=%s WHERE id=%L',col,
            CASE col WHEN 'sequence' THEN '2' WHEN 'node_id' THEN '''trigger''' WHEN 'node_type' THEN '''trigger''' ELSE 'clock_timestamp()' END,step),
            '22023','step immutable '||col,'AUTOMATION_IMMUTABLE_RECORD');
    END LOOP;
    PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_run_steps SET edge_id=''edge1'' WHERE id=%L',step),'22023','edge belongs to exact source node','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at) VALUES(%L,%L,2,''absent'',''email'',''entered'',clock_timestamp())',s,r),'22023','node belongs to immutable version','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at) VALUES(%L,%L,2,''trigger'',''email'',''entered'',clock_timestamp())',s,r),'22023','node type agrees with immutable version','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at) VALUES(%L,%L,2,''trigger'',''trigger'',''entered'',clock_timestamp())',gen_random_uuid(),r),'23503','same studio step FK');
    INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at) VALUES(s,r,2,'trigger','trigger','entered',clock_timestamp()) RETURNING id INTO step;
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_email_attempts(studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at) VALUES(%L,%L,%L,''trigger'',1,''sending'',''test@example.invalid'',''lead'',clock_timestamp())',s,r,step),'22023','attempt parent must be email','AUTOMATION_INVALID_REQUEST');
    step:=(h->>'step')::UUID;
    FOREACH outcome IN ARRAY ARRAY['entered','waiting','sending','matched','not_matched','accepted','skipped','failed','unknown','cancelled','completed'] LOOP
        BEGIN
            UPDATE private.automation_workflow_run_steps SET outcome=specimen.outcome,finished_at=CASE WHEN specimen.outcome NOT IN ('entered','waiting','sending') THEN clock_timestamp() END WHERE id=step;
            RAISE EXCEPTION USING ERRCODE='P0004',MESSAGE='rollback specimen';
        EXCEPTION WHEN assert_failure THEN NULL;
        END;
        PERFORM pg_temp.run_check(true,'step legal state '||outcome);
        PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_run_steps SET outcome=%L,finished_at=%s WHERE id=%L',outcome,
            CASE WHEN outcome IN ('entered','waiting','sending') THEN 'clock_timestamp()' ELSE 'NULL' END,step),'23514','step finished pair '||outcome);
    END LOOP;
    FOREACH state IN ARRAY ARRAY['sending','accepted','failed','unknown'] LOOP
        FOREACH evidence IN ARRAY ARRAY[NULL,'not_submitted','rejected','accepted','unknown'] LOOP
            FOREACH scope IN ARRAY ARRAY[NULL,'sender_auth','sender_transient','message','unclassified'] LOOP
                IF (evidence IS NULL OR state='accepted' AND evidence='accepted' OR state='failed' AND evidence IN ('not_submitted','rejected') OR state='unknown' AND evidence='unknown')
                    AND (scope IS NULL OR state='failed' OR state='unknown' AND scope='unclassified') THEN
                    BEGIN
                        UPDATE private.automation_workflow_email_attempts SET state=specimen.state,settled_at=CASE WHEN specimen.state<>'sending' THEN clock_timestamp() END,submission_evidence=specimen.evidence,failure_scope=specimen.scope WHERE id=attempt;
                        RAISE EXCEPTION USING ERRCODE='P0004',MESSAGE='rollback specimen';
                    EXCEPTION WHEN assert_failure THEN NULL;
                    END;
                    PERFORM pg_temp.run_check(true,'attempt legal matrix '||state||coalesce(evidence,'null')||coalesce(scope,'null'));
                ELSE
                    PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_email_attempts SET state=%L,settled_at=%s,submission_evidence=%L,failure_scope=%L WHERE id=%L',state,CASE WHEN state<>'sending' THEN 'clock_timestamp()' ELSE 'NULL' END,evidence,scope,attempt),'23514','attempt invalid matrix '||state||coalesce(evidence,'null')||coalesce(scope,'null'));
                END IF;
            END LOOP;
        END LOOP;
    END LOOP;
    PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_run_steps SET outcome=''completed'',finished_at=entered_at-interval ''1 second'' WHERE id=%L',step),'23514','step clock order');
    PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_email_attempts SET state=''accepted'',settled_at=began_at-interval ''1 second'' WHERE id=%L',attempt),'23514','attempt clock order');
    UPDATE private.automation_workflow_email_attempts SET state='accepted',settled_at=clock_timestamp(),submission_evidence='accepted' WHERE id=attempt;
    UPDATE private.automation_workflow_run_steps SET outcome='accepted',finished_at=clock_timestamp(),edge_id='last' WHERE id=step;
    before:=private.workflow_run_detail_v1(s,r);
    UPDATE private.automation_workflow_email_attempts rows SET state=rows.state WHERE id=attempt;
    UPDATE private.automation_workflow_run_steps rows SET outcome=rows.outcome WHERE id=step;
    PERFORM pg_temp.run_check(private.workflow_run_detail_v1(s,r)=before,'terminal exact no-op replay');
    PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_email_attempts SET reason=''changed'' WHERE id=%L',attempt),'22023','terminal attempt immutable','AUTOMATION_IMMUTABLE_RECORD');
    PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_run_steps SET reason=''changed'' WHERE id=%L',step),'22023','terminal step immutable','AUTOMATION_IMMUTABLE_RECORD');
END $$;

RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    w UUID; r UUID; ids UUID[]:='{}'; seen UUID[]:='{}'; page JSONB; cursor JSONB; row JSONB; bad JSONB; i INTEGER; h JSONB; seq INTEGER;
BEGIN
    SET LOCAL ROLE service_role;w:=pg_temp.run_workflow(x,'lead.created',38);
    FOR i IN 1..103 LOOP ids:=array_append(ids,pg_temp.run_seed(x,w)); END LOOP;
    -- Equal immutable timestamps are seeded at INSERT by a temporary default.
    -- These rows already have distinct clocks; the separate tie fixture below tests the tie key.
    PERFORM pg_temp.run_check(jsonb_array_length(public.list_automation_workflow_runs_v1(s,a,w)#>'{payload,items}')=50,'default page fifty');
    PERFORM pg_temp.run_check(jsonb_array_length(public.list_automation_workflow_runs_v1(s,a,w,100)#>'{payload,items}')=100,'maximum page hundred');
    LOOP
        page:=public.list_automation_workflow_runs_v1(s,a,w,1,cursor)->'payload';
        FOR row IN SELECT value FROM jsonb_array_elements(page->'items') LOOP seen:=array_append(seen,(row->>'id')::UUID); END LOOP;
        IF (page->>'has_more')::BOOLEAN THEN
            PERFORM pg_temp.run_check(page->'next_cursor'=jsonb_build_object('id',page#>'{items,0,id}','created_at',page#>'{items,0,created_at}'),'cursor last item '||cardinality(seen));
        END IF;
        cursor:=nullif(page->'next_cursor','null'::JSONB);EXIT WHEN cursor IS NULL;
    END LOOP;
    PERFORM pg_temp.run_check(cardinality(seen)=103 AND (SELECT count(DISTINCT n)=103 FROM unnest(seen) n) AND ids@>seen AND seen@>ids,'stable pagination exact coverage');
    FOREACH bad IN ARRAY ARRAY['null'::JSONB,'{}','[]','{"created_at":"infinity","id":"00000000-0000-0000-0000-000000000001"}',
        '{"created_at":"2020-01-01T00:00:00Z","id":null}','{"created_at":123,"id":"00000000-0000-0000-0000-000000000001"}',
        '{"created_at":"2020-01-01T00:00:00","id":"00000000-0000-0000-0000-000000000001"}',
        '{"created_at":"2020-01-01T00:00:00Z","id":"bad"}',
        '{"created_at":"2020-01-01T00:00:00Z","id":"00000000-0000-0000-0000-000000000001","extra":1}'] LOOP
        PERFORM pg_temp.run_error(format('SELECT public.list_automation_workflow_runs_v1(%L,%L,%L,10,%L)',s,a,w,bad),'22023','invalid SQL cursor '||bad::TEXT,'AUTOMATION_INVALID_REQUEST');
    END LOOP;
    FOREACH i IN ARRAY ARRAY[0,101,NULL] LOOP
        PERFORM pg_temp.run_error(format('SELECT public.list_automation_workflow_runs_v1(%L,%L,%L,%L)',s,a,w,i),'22023','invalid SQL page limit '||coalesce(i::TEXT,'null'),'AUTOMATION_INVALID_REQUEST');
    END LOOP;
    r:=ids[1];seq:=1;
    INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at,finished_at)
        VALUES(s,r,seq,'trigger','trigger','completed',clock_timestamp(),clock_timestamp());
    FOR i IN 1..38 LOOP
        seq:=seq+1;h:=pg_temp.run_history(x,r,'email'||i,seq);
        INSERT INTO private.automation_workflow_email_attempts(studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at,settled_at)
            SELECT s,r,(h->>'step')::UUID,'email'||i,n,'failed','synthetic@example.invalid','lead',clock_timestamp(),clock_timestamp() FROM generate_series(2,3) n;
    END LOOP;
    INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at,finished_at)
        VALUES(s,r,40,'end','end','completed',clock_timestamp(),clock_timestamp());
    page:=private.workflow_run_detail_v1(s,r);
    PERFORM pg_temp.run_check(jsonb_array_length(page->'steps')=40 AND jsonb_array_length(page->'attempts')=114
        AND page#>>'{steps,0,node_id}'='trigger' AND page#>>'{steps,39,node_id}'='end'
        AND page#>>'{attempts,0,node_id}'='email1' AND page#>>'{attempts,113,node_id}'='email38','maximum executable graph real ordered history');
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_email_attempts(studio_id,run_id,step_id,node_id,attempt_number,state,recipient_email,recipient_kind,began_at) VALUES(%L,%L,%L,''email38'',4,''sending'',''test@example.invalid'',''lead'',clock_timestamp())',s,r,h->>'step'),'23514','fourth actual attempt rejected');
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps(studio_id,run_id,sequence,node_id,node_type,outcome,entered_at) VALUES(%L,%L,41,''end'',''end'',''entered'',clock_timestamp())',s,r),'23514','step bound enforced');
    PERFORM public.command_automation_workflow_v1(s,a,w,gen_random_uuid(),3,'publish');
    PERFORM pg_temp.run_check(private.workflow_run_detail_v1(s,r)#>>'{run,version_number}'='1','history retains immutable published version');
    PERFORM pg_temp.run_check(NOT EXISTS(SELECT 1 FROM jsonb_object_keys(page->'run') k WHERE k IN ('context','claim_token','lease_expires_at','graph'))
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(page->'attempts') item,jsonb_object_keys(item) k WHERE k IN ('body','subject','token','provider_response','credential_revision')),'public history contains metadata only');
END $$;

RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.run_fixture(); y JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    w UUID; r UUID; trial UUID; completed UUID; unrelated UUID; replacement UUID; req JSONB; original JSONB; result JSONB; prior JSONB; op UUID:=gen_random_uuid();
    states TEXT[]:=ARRAY['queued','sending','unknown']; state_name TEXT; run_ids UUID[]:='{}'; wf_completed UUID; followup UUID;
BEGIN
    SET LOCAL ROLE service_role;
    w:=pg_temp.run_workflow(x,'trial.no_show');wf_completed:=pg_temp.run_workflow(x,'trial.completed');
    req:=jsonb_build_object('starts_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '2 days'),
        'ends_at',private.automation_utc_text_v1(clock_timestamp()+INTERVAL '2 days 1 hour'),'timezone','UTC');
    original:=public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,NULL,op,NULL,req);trial:=(original#>>'{payload,id}')::UUID;
    UPDATE public.lead_trial_appointments SET starts_at=clock_timestamp()-INTERVAL '2 hours',ends_at=clock_timestamp()-INTERVAL '1 hour' WHERE id=trial;
    result:=public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,trial,gen_random_uuid(),1,'{"status":"no_show"}');
    PERFORM pg_temp.run_check(public.get_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,trial)->'payload'=result->'payload'
        AND public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=original->'payload','exact current trial differs from original receipt');
    FOREACH state_name IN ARRAY states LOOP run_ids:=array_append(run_ids,pg_temp.run_seed(x,w,state_name,'trial',trial)); END LOOP;
    INSERT INTO public.lead_trial_appointments(studio_id,lead_id,program_id,starts_at,ends_at,timezone,status)
        VALUES(s,(x->>'lead')::UUID,(x->>'program')::UUID,clock_timestamp()-INTERVAL '2 days 2 hours',clock_timestamp()-INTERVAL '2 days 1 hour','UTC','completed') RETURNING id INTO completed;
    followup:=pg_temp.run_seed(x,wf_completed,'queued','trial',completed);
    INSERT INTO public.lead_trial_appointments(studio_id,lead_id,starts_at,ends_at,timezone,status)
        VALUES((y->>'studio')::UUID,(y->>'lead')::UUID,clock_timestamp()-INTERVAL '2 hours',clock_timestamp()-INTERVAL '1 hour','UTC','no_show') RETURNING id INTO unrelated;
    SELECT to_jsonb(old_row) INTO prior FROM public.lead_trial_appointments old_row WHERE id=trial;
    -- Injected transaction failure proves marker and cancellation rollback together.
    BEGIN
        PERFORM public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,NULL,gen_random_uuid(),NULL,req);
        RAISE EXCEPTION USING ERRCODE='P0004';
    EXCEPTION WHEN assert_failure THEN NULL;
    END;
    PERFORM pg_temp.run_check((SELECT to_jsonb(old_row)=prior FROM public.lead_trial_appointments old_row WHERE id=trial)
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs WHERE id=ANY(run_ids) AND cancel_requested_at IS NOT NULL),'replacement rollback retains original evidence');
    op:=gen_random_uuid();result:=public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,NULL,op,NULL,req);replacement:=(result#>>'{payload,id}')::UUID;
    PERFORM pg_temp.run_check((SELECT bool_and(rebooking_superseded) FROM public.lead_trial_appointments WHERE id IN (trial,completed))
        AND (SELECT NOT rebooking_superseded FROM public.lead_trial_appointments WHERE id=replacement)
        AND (SELECT NOT rebooking_superseded FROM public.lead_trial_appointments WHERE id=unrelated)
        AND (SELECT (to_jsonb(old_row)-'rebooking_superseded')=(prior-'rebooking_superseded') FROM public.lead_trial_appointments old_row WHERE id=trial),'replacement marker scoped monotonic without public revision change');
    PERFORM pg_temp.run_check((SELECT bool_and(cancel_reason='trial_replaced' AND revision=2 AND next_due_at IS NULL) FROM public.automation_workflow_runs WHERE id=ANY(run_ids))
        AND (SELECT state='queued' AND cancel_requested_at IS NULL FROM public.automation_workflow_runs WHERE id=followup),'new trial cancels only prior no-show work');
    PERFORM pg_temp.run_check(public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,NULL,op,NULL,req)=result||'{"replayed":true}','replacement same-key original replay');
    PERFORM public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,replacement,gen_random_uuid(),1,'{"status":"canceled"}');
    RESET ROLE;
    DELETE FROM public.lead_trial_appointments WHERE id=replacement;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.run_check((SELECT rebooking_superseded FROM public.lead_trial_appointments WHERE id=trial)
        AND (SELECT bool_and(cancel_reason='trial_replaced' AND revision=2) FROM public.automation_workflow_runs WHERE id=ANY(run_ids)),'replacement cancellation deletion cannot revive prior work');
    PERFORM pg_temp.run_error(format('UPDATE public.lead_trial_appointments SET rebooking_superseded=false WHERE id=%L',trial),'22023','marker cannot be cleared','AUTOMATION_IMMUTABLE_RECORD');
    PERFORM pg_temp.run_error(format('SELECT public.mutate_lead_trial_appointment_v1(%L,%L,%L,%L,%L,1,''{"status":"no_show"}'')',s,a,x->>'lead',completed,gen_random_uuid()),'P0001','public terminal correction still refused','AUTOMATION_STATE_CONFLICT');
    -- Explicit trusted-source correction fixture; no public terminal transition is added.
    UPDATE public.lead_trial_appointments SET status='no_show',revision=2 WHERE id=completed;
    PERFORM private.workflow_capture_events_v1(s,jsonb_build_array(jsonb_build_object('event_type','trial.no_show',
        'source_key',completed::TEXT||':2','subject_kind','trial','subject_id',completed,'occurred_at',private.automation_utc_text_v1(clock_timestamp()),
        'context',jsonb_build_object('appointment_id',completed,'lead_id',x->'lead','program_id',x->'program','revision',2,'status','no_show'))),private.workflow_prepare_capture_v1(s));
    PERFORM pg_temp.run_check((SELECT count(*)=1 FROM private.automation_workflow_events WHERE studio_id=s AND event_type='trial.no_show' AND subject_id=completed)
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_runs rr JOIN private.automation_workflow_events ev ON ev.id=rr.event_id WHERE ev.subject_id=completed AND ev.event_type='trial.no_show')
        AND (SELECT state='queued' FROM public.automation_workflow_runs WHERE id=followup),'marked late no-show occurrence retained with zero enrollment and completed followup untouched');
    UPDATE public.leads SET stage='closed_lost' WHERE id=(x->>'lead')::UUID;
    RESET ROLE;
    DELETE FROM public.programs WHERE id=(x->>'program')::UUID;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.run_check(public.get_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,trial)#>>'{payload,program_id}'=x->>'program','closed lead deleted program history remains readable');
    PERFORM pg_temp.run_error(format('SELECT public.get_lead_trial_appointment_v1(%L,%L,%L,%L)',s,a,x->>'lead',unrelated),'P0002','trial foreign appointment not found','AUTOMATION_NOT_FOUND');
    PERFORM pg_temp.run_error(format('SELECT public.get_lead_trial_appointment_v1(%L,%L,%L,%L)',s,a,y->>'lead',trial),'P0002','trial wrong lead not found','AUTOMATION_NOT_FOUND');
END $$;

RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    e private.automation_workflow_events; p UUID:=gen_random_uuid(); invoice UUID:=gen_random_uuid(); payment UUID:=gen_random_uuid();
    ladder UUID:=gen_random_uuid(); rank_id UUID:=gen_random_uuid(); promotion UUID; event UUID:=gen_random_uuid(); recipient UUID:=gen_random_uuid();
    trial UUID:=gen_random_uuid(); kind TEXT; subject UUID; label TEXT; cp INTEGER; w UUID; r UUID; ids UUID[]; page JSONB; original JSONB;
BEGIN
    INSERT INTO public.belt_ladders(id,studio_id,name) VALUES(ladder,s,'Label ladder');
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name,display_order) VALUES(rank_id,s,ladder,'Label rank',0);
    INSERT INTO public.promotions(studio_id,student_id,to_rank_id,promoted_by) VALUES(s,(x->>'student')::UUID,rank_id,a) RETURNING id INTO promotion;
    INSERT INTO public.belt_test_events(id,studio_id,name,ladder_id,starts_at,ends_at,timezone,status)
        VALUES(event,s,'Label event',ladder,clock_timestamp()+INTERVAL '1 day',clock_timestamp()+INTERVAL '1 day 1 hour','UTC','scheduled');
    INSERT INTO public.belt_test_recipients(id,studio_id,event_id,student_id,approved_schedule_revision,approved_rank_context_generation,approved_target_rank_id,state,approved_by,approved_at)
        VALUES(recipient,s,event,(x->>'student')::UUID,1,1,rank_id,'approved',a,clock_timestamp());
    INSERT INTO public.lead_trial_appointments(id,studio_id,lead_id,starts_at,ends_at,timezone,status)
        VALUES(trial,s,(x->>'lead')::UUID,clock_timestamp()-INTERVAL '2 hours',clock_timestamp()-INTERVAL '1 hour','UTC','completed');
    INSERT INTO public.billing_payers(id,studio_id,display_name) VALUES(p,s,'Synthetic payer');
    INSERT INTO public.billing_invoices(id,studio_id,payer_id,status,amount_due_cents,invoice_number) VALUES(invoice,s,p,'open',1000,'  INV-Current  ');
    INSERT INTO public.billing_payments(id,studio_id,payer_id,invoice_id,status,amount_cents) VALUES(payment,s,p,invoice,'processing',1000);
    FOREACH kind IN ARRAY ARRAY['student','promotion','belt_test','lead','trial','invoice'] LOOP
        subject:=CASE kind WHEN 'student' THEN (x->>'student')::UUID WHEN 'promotion' THEN promotion WHEN 'belt_test' THEN recipient
            WHEN 'lead' THEN (x->>'lead')::UUID WHEN 'trial' THEN trial ELSE invoice END;
        label:=CASE WHEN kind IN ('student','promotion','belt_test') THEN 'Preferred Student' WHEN kind IN ('lead','trial') THEN 'Current Lead' ELSE 'INV-Current' END;
        e.studio_id:=s;e.subject_kind:=kind;e.subject_id:=subject;e.event_type:='invoice.overdue';
        PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)=label,'current scoped subject label '||kind);
        e.studio_id:=gen_random_uuid();
        PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','foreign subject unavailable '||kind);
        e.studio_id:=s;e.subject_id:=gen_random_uuid();
        PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','missing subject unavailable '||kind);
    END LOOP;
    e.subject_kind:='invoice';e.subject_id:=payment;e.event_type:='invoice.payment_failed';e.context:=jsonb_build_object('invoice_id',invoice);
    PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='INV-Current','failed payment resolves captured invoice through exact payment');
    e.context:=jsonb_build_object('invoice_id',gen_random_uuid());
    PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','payment captured invoice mismatch unavailable');
    e.subject_kind:='student';e.subject_id:=(x->>'student')::UUID;
    UPDATE public.students SET preferred_name='  ' WHERE id=e.subject_id;
    PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Legal Student','blank preferred name falls back to legal');
    FOREACH cp IN ARRAY ARRAY[9,10,11,12,13,28,29,30,31,32,133,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288] LOOP
        e.subject_kind:='student';e.subject_id:=(x->>'student')::UUID;
        UPDATE public.students SET preferred_name=chr(cp) WHERE id=e.subject_id;
        PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Legal Student','Unicode blank preferred name fallback '||cp);
        e.subject_kind:='invoice';e.subject_id:=invoice;e.event_type:='invoice.overdue';
        UPDATE public.billing_invoices SET invoice_number=chr(cp) WHERE id=invoice;
        PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','Unicode blank invoice fallback '||cp);
        e.subject_kind:='lead';e.subject_id:=(x->>'lead')::UUID;
        UPDATE public.leads SET first_name=chr(cp),last_name=chr(cp) WHERE id=e.subject_id;
        PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','Unicode blank lead fallback '||cp);
    END LOOP;
    e.subject_kind:='student';e.subject_id:=(x->>'student')::UUID;
    UPDATE public.students SET preferred_name=' Renamed ' WHERE id=e.subject_id;
    PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Renamed Student','current preferred name refresh');
    UPDATE public.students SET deleted_at=clock_timestamp() WHERE id=e.subject_id;
    PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','soft deleted student unavailable');
    e.subject_kind:='lead';e.subject_id:=(x->>'lead')::UUID;
    UPDATE public.leads SET first_name=repeat('A',200),last_name=repeat('B',200) WHERE id=e.subject_id;
    PERFORM pg_temp.run_check(length(private.workflow_run_subject_label_v1(e))=240,'subject label capped at240');
    UPDATE public.leads SET first_name=' ',last_name=' ' WHERE id=e.subject_id;
    PERFORM pg_temp.run_check(private.workflow_run_subject_label_v1(e)='Unavailable subject','blank subject unavailable');
    -- Tie timestamps are set in initial INSERTs, preserving immutable created_at.
    w:=pg_temp.run_workflow(x);
    r:=pg_temp.run_seed(x,w);
    INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
        SELECT s,'lead.created','tie'||n,'lead',(x->>'lead')::UUID,clock_timestamp() FROM generate_series(1,3) n;
    INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,created_at)
        SELECT s,w,rr.version_id,ev.id,rr.activation_id,rr.epoch,'trigger',TIMESTAMPTZ '2090-01-01Z'
        FROM public.automation_workflow_runs rr CROSS JOIN private.automation_workflow_events ev WHERE rr.id=r AND ev.studio_id=s AND ev.source_key LIKE 'tie%';
    SELECT array_agg(id ORDER BY id DESC) INTO ids FROM public.automation_workflow_runs WHERE workflow_id=w AND created_at=TIMESTAMPTZ '2090-01-01Z';
    page:=public.list_automation_workflow_runs_v1(s,a,w,2)->'payload';
    PERFORM pg_temp.run_check(page#>>'{items,0,id}'=ids[1]::TEXT AND page#>>'{items,1,id}'=ids[2]::TEXT
        AND page#>>'{next_cursor,id}'=ids[2]::TEXT,'equal timestamp UUID descending keyset');
    page:=public.list_automation_workflow_runs_v1(s,a,w,2,page->'next_cursor')->'payload';
    PERFORM pg_temp.run_check(page#>>'{items,0,id}'=ids[3]::TEXT AND page#>>'{items,1,id}'=r::TEXT AND page->'next_cursor'='null','equal timestamp page boundary no skips');
END $$;

RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; a UUID:=(x->>'actor')::UUID;
    old UUID; replacement UUID; req JSONB; detail JSONB; state_name TEXT;
BEGIN
    INSERT INTO public.lead_trial_appointments(studio_id,lead_id,starts_at,ends_at,timezone,status)
        VALUES(s,(x->>'lead')::UUID,clock_timestamp()-INTERVAL '2 hours',clock_timestamp()-INTERVAL '1 hour','UTC','completed') RETURNING id INTO old;
    req:=jsonb_build_object('starts_at','2090-01-01T10:00:00Z','ends_at','2090-01-01T11:00:00Z','timezone','UTC');
    replacement:=(public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,NULL,gen_random_uuid(),NULL,req)#>>'{payload,id}')::UUID;
    PERFORM pg_temp.run_check((SELECT rebooking_superseded FROM public.lead_trial_appointments WHERE id=old)
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflows WHERE studio_id=s),'zero active workflows still persist replacement authority');
    PERFORM public.mutate_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,replacement,gen_random_uuid(),1,'{"status":"canceled"}');
    FOREACH state_name IN ARRAY ARRAY['scheduled','completed','no_show','canceled'] LOOP
        UPDATE public.lead_trial_appointments SET status=state_name WHERE id=old;
        detail:=public.get_lead_trial_appointment_v1(s,a,(x->>'lead')::UUID,old)->'payload';
        PERFORM pg_temp.run_check(detail->>'status'=state_name AND NOT detail ? 'rebooking_superseded','current trial all statuses internal marker hidden '||state_name);
    END LOOP;
END $$;
RESET ROLE;
DO $$
DECLARE x JSONB:=pg_temp.run_fixture(); s UUID:=(x->>'studio')::UUID; w UUID; r UUID; h JSONB;
    step JSONB; attempt JSONB; bad JSONB; k TEXT; instant TEXT; state_name TEXT;
BEGIN
    w:=pg_temp.run_workflow(x);r:=pg_temp.run_seed(x,w,'sending');h:=pg_temp.run_history(x,r);
    SELECT to_jsonb(saved) INTO step FROM private.automation_workflow_run_steps saved WHERE id=(h->>'step')::UUID;
    SELECT to_jsonb(saved) INTO attempt FROM private.automation_workflow_email_attempts saved WHERE id=(h->>'attempt')::UUID;
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps SELECT (jsonb_populate_record(NULL::private.automation_workflow_run_steps,%L)).*',step||jsonb_build_object('id',gen_random_uuid())),'23505','duplicate run node and sequence rejected');
    PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_email_attempts SELECT (jsonb_populate_record(NULL::private.automation_workflow_email_attempts,%L)).*',attempt||jsonb_build_object('id',gen_random_uuid())),'23505','duplicate run node attempt ordinal rejected');
    FOREACH state_name IN ARRAY ARRAY['sending','accepted','failed','unknown'] LOOP
        PERFORM pg_temp.run_error(format('UPDATE private.automation_workflow_email_attempts SET state=%L,settled_at=%s WHERE id=%L',state_name,
            CASE WHEN state_name='sending' THEN 'clock_timestamp()' ELSE 'NULL' END,h->>'attempt'),'23514','attempt exact settlement pair '||state_name);
    END LOOP;
    FOREACH bad IN ARRAY ARRAY['{"state":"bogus"}'::JSONB,'{"reason":"raw message"}','{"submission_evidence":"bogus"}','{"failure_scope":"bogus"}','{"recipient_kind":"bogus"}'] LOOP
        PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_email_attempts SELECT (jsonb_populate_record(NULL::private.automation_workflow_email_attempts,%L)).*',attempt||jsonb_build_object('id',gen_random_uuid(),'attempt_number',2)||bad),'23514','attempt enums and safe reason '||bad::TEXT);
    END LOOP;
    FOREACH bad IN ARRAY ARRAY['{"outcome":"bogus"}'::JSONB,'{"reason":"raw message"}'] LOOP
        PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps SELECT (jsonb_populate_record(NULL::private.automation_workflow_run_steps,%L)).*',step||jsonb_build_object('id',gen_random_uuid(),'node_id','trigger','node_type','trigger','sequence',2)||bad),'23514','step enums and safe reason '||bad::TEXT);
    END LOOP;
    FOREACH instant IN ARRAY ARRAY['infinity','-infinity','10000-01-01','0001-01-01 BC'] LOOP
        FOREACH k IN ARRAY ARRAY['scheduled_at','entered_at','finished_at'] LOOP
            bad:=step||jsonb_build_object('id',gen_random_uuid(),'node_id','trigger','node_type','trigger','sequence',2,k,instant);
            IF k='finished_at' THEN bad:=bad||'{"outcome":"completed"}'::JSONB; END IF;
            PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_run_steps SELECT (jsonb_populate_record(NULL::private.automation_workflow_run_steps,%L)).*',bad),'23514','step finite Python instant '||k||instant);
        END LOOP;
        FOREACH k IN ARRAY ARRAY['began_at','settled_at'] LOOP
            bad:=attempt||jsonb_build_object('id',gen_random_uuid(),'attempt_number',2,k,instant);
            IF k='settled_at' THEN bad:=bad||'{"state":"accepted"}'::JSONB; END IF;
            PERFORM pg_temp.run_error(format('INSERT INTO private.automation_workflow_email_attempts SELECT (jsonb_populate_record(NULL::private.automation_workflow_email_attempts,%L)).*',bad),'23514','attempt finite Python instant '||k||instant);
        END LOOP;
    END LOOP;
END $$;
SELECT count(*) AS workflow_run_assertions FROM pg_temp.run_checks;
ROLLBACK;
