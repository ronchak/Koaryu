-- Synthetic rollback-only pilot proof. Never run against a hosted database.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE workflow_management_checks(label TEXT PRIMARY KEY);
GRANT SELECT,INSERT ON workflow_management_checks TO anon,authenticated,service_role;
CREATE FUNCTION pg_temp.workflow_check(p_ok BOOLEAN,p_label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ BEGIN
    IF p_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'workflow contract failed: %',p_label; END IF;
    INSERT INTO workflow_management_checks VALUES(p_label);
END $$;
CREATE FUNCTION pg_temp.workflow_error(p_sql TEXT,p_state TEXT,p_message TEXT,p_label TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$ DECLARE caught_state TEXT; caught_message TEXT; BEGIN
    BEGIN EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS caught_state=RETURNED_SQLSTATE,caught_message=MESSAGE_TEXT;
    END;
    IF caught_state IS DISTINCT FROM p_state OR (p_message IS NOT NULL AND caught_message IS DISTINCT FROM p_message) THEN
        RAISE EXCEPTION 'workflow negative failed %: got % (%), expected % (%)',p_label,caught_state,caught_message,p_state,p_message;
    END IF;
    PERFORM pg_temp.workflow_check(true,p_label);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.workflow_check(BOOLEAN,TEXT),pg_temp.workflow_error(TEXT,TEXT,TEXT,TEXT) TO anon,authenticated,service_role;
SELECT pg_temp.workflow_check((SELECT count(*)=0 FROM private.automation_workflow_events)
    AND (SELECT count(*)=0 FROM public.automation_workflow_runs)
    AND (SELECT count(*)=0 FROM public.automation_workflows),'migration creates no customer state');
DO $$ DECLARE role_name TEXT; t TEXT; fn REGPROCEDURE; BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
        EXECUTE format('SET LOCAL ROLE %I',role_name);
        FOREACH t IN ARRAY ARRAY['public.automation_workflows','public.automation_workflow_versions',
            'public.automation_workflow_activations','public.automation_workflow_runs',
            'private.automation_workflow_events','private.automation_command_operations'] LOOP
            PERFORM pg_temp.workflow_error('SELECT * FROM '||t,'42501',NULL,role_name||' rejects '||t);
        END LOOP;
        PERFORM pg_temp.workflow_error('SELECT public.list_automation_workflows_v1(NULL,NULL)','42501',NULL,role_name||' rejects RPC');
        PERFORM pg_temp.workflow_error('SELECT public.validate_automation_workflow_v1(NULL,NULL,NULL)','42501',NULL,role_name||' rejects validation RPC');
        RESET ROLE;
    END LOOP;
    PERFORM pg_temp.workflow_check((SELECT bool_and(c.relrowsecurity AND c.relpersistence='p'
        AND pg_get_userbyid(c.relowner)='postgres') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname||'.'||c.relname)=ANY(ARRAY['public.automation_workflows','public.automation_workflow_versions',
            'public.automation_workflow_activations','public.automation_workflow_runs',
            'private.automation_workflow_events','private.automation_command_operations'])),'six logged RLS postgres-owned tables');
    FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('create_automation_workflow_v1','save_automation_workflow_v1',
            'command_automation_workflow_v1','get_automation_workflow_v1','list_automation_workflows_v1','get_automation_operation_v1',
            'validate_automation_workflow_v1') LOOP
        PERFORM pg_temp.workflow_check(has_function_privilege('service_role',fn,'EXECUTE')
            AND NOT has_function_privilege('anon',fn,'EXECUTE') AND NOT has_function_privilege('authenticated',fn,'EXECUTE')
            AND (SELECT NOT prosecdef AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=fn),fn::TEXT||' service invoker');
    END LOOP;
END $$;


-- Hash every retained business/command row around observations and refused starts.
CREATE FUNCTION pg_temp.workflow_observation_state() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE t TEXT; state JSONB:='{}'; rows JSONB;
BEGIN
    FOREACH t IN ARRAY ARRAY['auth.users','public.staff_roles','public.studios','public.studio_subscriptions',
        'public.programs','public.belt_ladders','public.belt_ranks','public.automation_workflows',
        'public.automation_workflow_versions','public.automation_workflow_activations','public.automation_workflow_runs',
        'private.automation_workflow_events','private.automation_command_operations','public.audit_logs'] LOOP
        EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::TEXT),%L::JSONB) FROM %s r','[]',t) INTO rows;
        state:=state||jsonb_build_object(t,md5(rows::TEXT));
    END LOOP;
    RETURN state;
END $$;
DO $$
DECLARE a UUID:=gen_random_uuid(); a2 UUID:=gen_random_uuid(); b UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); s2 UUID:=gen_random_uuid();
    program UUID:=gen_random_uuid(); foreign_program UUID:=gen_random_uuid(); ladder UUID:=gen_random_uuid(); rank_id UUID:=gen_random_uuid();
    foreign_ladder UUID:=gen_random_uuid(); foreign_rank UUID:=gen_random_uuid(); missing UUID:=gen_random_uuid();
    op UUID:=gen_random_uuid(); later_op UUID:=gen_random_uuid(); wid UUID; start_result JSONB; result JSONB; before_state JSONB;
    g JSONB:='{"schema_version":1,"nodes":[{"id":"start","type":"trigger","config":{"event_type":"student.promoted"}},{"id":"rank","type":"condition","config":{"field":"promotion.rank_id","operator":"in"}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"next","source":"start","target":"rank","port":"next"},{"id":"yes","source":"rank","target":"end","port":"yes"},{"id":"no","source":"rank","target":"end","port":"no"}]}';
    child JSONB; expected JSONB; value JSONB; action TEXT;
BEGIN
    PERFORM pg_temp.workflow_check((SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='command_automation_workflow_v1')
        AND to_regprocedure('public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)') IS NOT NULL
        AND to_regprocedure('public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean)') IS NULL,'one command owner with replay flag');
    PERFORM pg_temp.workflow_check((SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='workflow_mutate_v1')
        AND to_regprocedure('private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)') IS NOT NULL
        AND to_regprocedure('private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean)') IS NULL,'one private owner with replay flag');
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',now()),(a2,a2||'@example.invalid',now()),(b,b||'@example.invalid',now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Read proof',s::TEXT,a2,'UTC'),(s2,'Foreign read proof',s2::TEXT,b,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'),(s,a2,'admin'),(s2,b,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false),(s2,'active',false);
    INSERT INTO public.programs(id,studio_id,name,archived_at) VALUES(program,s,'Archived but existing',now()),(foreign_program,s2,'Foreign',NULL);
    INSERT INTO public.belt_ladders(id,studio_id,name) VALUES(ladder,s,'Local'),(foreign_ladder,s2,'Foreign');
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name) VALUES(rank_id,s,ladder,'Local'),(foreign_rank,s2,foreign_ladder,'Foreign');
    g:=jsonb_set(jsonb_set(g,'{nodes,0,config,program_id}',to_jsonb(program::TEXT)), '{nodes,1,config,value}',jsonb_build_array(rank_id));
    before_state:=pg_temp.workflow_observation_state();
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_check(public.validate_automation_workflow_v1(s,a,g)='{"payload":{"valid":true,"issues":[]}}','validation accepts current same studio archived program and rank');
    expected:=jsonb_build_object('payload',jsonb_build_object('valid',false,'issues',jsonb_build_array(
        jsonb_build_object('code','reference_unavailable','message','Choose an available program or rank.','node_id','rank','edge_id',NULL,'field','config.value'),
        jsonb_build_object('code','reference_unavailable','message','Choose an available program or rank.','node_id','start','edge_id',NULL,'field','config.program_id'))));
    child:=jsonb_set(jsonb_set(g,'{nodes,0,config,program_id}',to_jsonb(foreign_program::TEXT)),
        '{nodes,1,config,value}',jsonb_build_array(foreign_rank,foreign_rank,missing));
    PERFORM pg_temp.workflow_check(public.validate_automation_workflow_v1(s,a,child)=expected,'foreign and duplicate references return fixed located deduplicated issues');
    child:=jsonb_set(jsonb_set(child,'{nodes,0,config,program_id}',to_jsonb(missing::TEXT)),
        '{nodes,1,config,value}',jsonb_build_array(missing));
    PERFORM pg_temp.workflow_check(public.validate_automation_workflow_v1(s,a,child)=expected,'missing and foreign references are indistinguishable');
    child:=jsonb_set(child,'{nodes,1,config,operator}','null');
    result:=public.validate_automation_workflow_v1(s,a,child);
    PERFORM pg_temp.workflow_check(result#>'{payload,valid}'='false' AND jsonb_array_length(result#>'{payload,issues}')=3
        AND (result#>'{payload,issues}') @> (expected#>'{payload,issues}'),'incomplete safe graph combines executable and reference issues');
    child:=jsonb_set(g,'{nodes,1,config,field}','"program.id"');
    child:=jsonb_set(child,'{nodes,1,config,value}',jsonb_build_array(foreign_program,missing));
    result:=public.validate_automation_workflow_v1(s,a,child);
    PERFORM pg_temp.workflow_check(result#>>'{payload,issues,0,field}'='config.value'
        AND jsonb_array_length(result#>'{payload,issues}')=1,'condition program reference is scoped and located');
    FOREACH value IN ARRAY ARRAY['null'::JSONB,'true'::JSONB,'"untrusted-value"'::JSONB,'{}'::JSONB,
        '{"schema_version":1,"nodes":{},"edges":[]}'::JSONB,
        jsonb_set(g,'{nodes,1,config,value}','["untrusted-value"]'),
        jsonb_set(g,'{nodes,0,id}','"untrusted <id>"'),
        jsonb_set(g,'{nodes,0,config,program_id}','{"untrusted":"value"}')] LOOP
        result:=public.validate_automation_workflow_v1(s,a,value);
        PERFORM pg_temp.workflow_check(result#>'{payload,valid}'='false'
            AND jsonb_array_length(result#>'{payload,issues}')=1
            AND result::TEXT NOT LIKE '%untrusted%','malformed read validation '||md5(value::TEXT));
    END LOOP;
    PERFORM pg_temp.workflow_error(format('SELECT public.validate_automation_workflow_v1(%L,%L,%L)',s,b,g),'42501','AUTOMATION_ADMIN_REQUIRED','validation denies foreign actor');
    RESET ROLE;
    PERFORM pg_temp.workflow_check(pg_temp.workflow_observation_state()=before_state,'validation changes no source or workflow state');
    UPDATE public.staff_roles SET role='front_desk' WHERE user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_error(format('SELECT public.validate_automation_workflow_v1(%L,%L,%L)',s,a,g),'42501','AUTOMATION_ADMIN_REQUIRED','validation requires current admin');
    RESET ROLE;
    UPDATE public.staff_roles SET role='admin' WHERE user_id=a;
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_error(format('SELECT public.validate_automation_workflow_v1(%L,%L,%L)',s,a,g),'42501','AUTOMATION_ADMIN_REQUIRED','validation requires current entitlement');
    RESET ROLE;
    UPDATE public.studio_subscriptions SET status='active' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    result:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Replay proof','',g,'{}'); wid:=(result#>>'{payload,id}')::UUID;
    PERFORM public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),1,'publish');
    start_result:=public.command_automation_workflow_v1(s,a,wid,op,2,'start');
    PERFORM public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),3,'pause');
    RESET ROLE;
    before_state:=pg_temp.workflow_observation_state();
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_check(public.command_automation_workflow_v1(s,a,wid,op,2,'start',false,true)=start_result||'{"replayed":true}',
        'replay only returns original start after pause');
    PERFORM pg_temp.workflow_check(public.command_automation_workflow_v1(s,a,wid,op,2,'start',false,false)=start_result||'{"replayed":true}',
        'readiness flag is absent from original command identity');
    PERFORM pg_temp.workflow_check(public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=start_result->'payload','readback retains original start authority');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,2,%L,false,true)',s,a2,wid,op,'start'),'P0001','AUTOMATION_OPERATION_CONFLICT','replay only changed actor conflicts');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,4,%L,false,true)',s,a,wid,op,'start'),'P0001','AUTOMATION_OPERATION_CONFLICT','replay only changed revision conflicts');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,2,%L,false,true)',s,a,missing,op,'start'),'P0001','AUTOMATION_OPERATION_CONFLICT','replay only changed absent target conflicts');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,4,%L,false,true)',s,a,wid,later_op,'start'),'P0001','AUTOMATION_STATE_CONFLICT','replay only new key refuses start');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,4,%L,false,NULL)',s,a,wid,later_op,'start'),'22023','AUTOMATION_INVALID_REQUEST','explicit null replay flag rejected');
    FOREACH action IN ARRAY ARRAY['publish','pause','archive'] LOOP
        PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,4,%L,false,true)',s,a,wid,later_op,action),'22023','AUTOMATION_INVALID_REQUEST','replay flag invalid for '||action);
    END LOOP;
    PERFORM pg_temp.workflow_error(format('SELECT private.workflow_mutate_v1(%L,%L,NULL,%L,NULL,%L,%L,%L,%L,%L,false,true)',s,a,later_op,'create','Invalid','',g,'{}'),'22023','AUTOMATION_INVALID_REQUEST','private owner rejects replay flag for create');
    RESET ROLE;
    PERFORM pg_temp.workflow_check(pg_temp.workflow_observation_state()=before_state,'replays and blocked starts have no state effects');
    UPDATE public.staff_roles SET archived_at=now() WHERE user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,2,%L,false,true)',s,a,wid,op,'start'),'42501','AUTOMATION_ADMIN_REQUIRED','replay only still requires current actor authority');
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=NULL WHERE user_id=a;
    SET LOCAL ROLE service_role;
    result:=public.command_automation_workflow_v1(s,a,wid,later_op,4,'start');
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='active' AND result->'replayed'='false'
        AND (SELECT count(*)=2 FROM public.automation_workflow_activations WHERE workflow_id=wid),'blocked key starts once when capability returns');
    RESET ROLE;
    -- The enclosing rollback removes these separate-studio fixtures.
END $$;

DO $$
<<fixture>>
DECLARE a UUID:=gen_random_uuid(); owner_id UUID:=gen_random_uuid(); b UUID:=gen_random_uuid(); desk UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); s2 UUID:=gen_random_uuid();
    program UUID:=gen_random_uuid(); other_program UUID:=gen_random_uuid(); ladder UUID:=gen_random_uuid(); rank_id UUID:=gen_random_uuid();
    op UUID:=gen_random_uuid(); save_op UUID:=gen_random_uuid(); wid UUID; wid2 UUID; version1 UUID; activation1 UUID; event_id UUID;
    g JSONB:='{"schema_version":1,"nodes":[{"id":"Start","type":"trigger","config":{"event_type":"lead.created"}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"Edge","source":"Start","target":"end","port":"next"}]}';
    incomplete JSONB; conditions JSONB; layout JSONB:='{"positions":{}}'; result JSONB; saved JSONB; first JSONB; r JSONB;
    rev BIGINT; run_id UUID; run_state TEXT; n INTEGER; child JSONB; receipt_op UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email) VALUES(a,a||'@example.invalid'),(owner_id,owner_id||'@example.invalid'),(b,b||'@example.invalid'),(desk,desk||'@example.invalid');
    UPDATE auth.users SET email_confirmed_at=clock_timestamp() WHERE id IN (a,owner_id,b,desk);
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Workflow contract',s::TEXT,owner_id,'UTC'),(s2,'Other workflow contract',s2::TEXT,b,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin'),(s,owner_id,'admin'),(s2,b,'admin'),(s,desk,'front_desk');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false),(s2,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(program,s,'Synthetic'),(other_program,s2,'Other synthetic');
    INSERT INTO public.belt_ladders(id,studio_id,name) VALUES(ladder,s2,'Other ladder');
    INSERT INTO public.belt_ranks(id,studio_id,ladder_id,name) VALUES(rank_id,s2,ladder,'Other rank');
    SET LOCAL ROLE service_role;
    first:=public.create_automation_workflow_v1(s,a,op,'First','',g,layout); wid:=(first#>>'{payload,id}')::UUID;
    PERFORM pg_temp.workflow_check(first#>>'{payload,status}'='draft' AND first#>>'{payload,revision}'='1'
        AND first#>'{payload,published_version_id}'='null' AND first#>'{payload,has_unpublished_changes}'='true','service admin creates draft revision one');
    PERFORM pg_temp.workflow_check(public.create_automation_workflow_v1(s,a,op,'First','',g,layout)=first||'{"replayed":true}', 'same operation exact replay');
    PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,op,'Changed','',g,layout),'P0001','AUTOMATION_OPERATION_CONFLICT','changed payload operation conflict');
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_workflow_v1(%L,%L,%L)',s,b,wid),'42501','AUTOMATION_ADMIN_REQUIRED','wrong studio actor denied');
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_workflow_v1(%L,%L,%L)',s,desk,wid),'42501','AUTOMATION_ADMIN_REQUIRED','front desk workflow read denied');
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_workflow_v1(%L,%L,%L)',s2,b,wid),'P0002','AUTOMATION_NOT_FOUND','wrong studio entity not found');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,1,%L)',s,a,wid,gen_random_uuid(),'start'),'P0001','AUTOMATION_STATE_CONFLICT','draft cannot start');
    PERFORM pg_temp.workflow_error(format('SELECT public.save_automation_workflow_v1(%L,%L,%L,%L,2,%L,%L,%L,%L)',s,a,wid,gen_random_uuid(),'First','',g,layout),'P0001','AUTOMATION_REVISION_CONFLICT','stale revision rejected');
    incomplete:=jsonb_set(g,'{nodes,0,config,event_type}','null');
    saved:=public.save_automation_workflow_v1(s,a,wid,save_op,1,'Incomplete','',incomplete,layout);
    PERFORM pg_temp.workflow_check(saved#>>'{payload,revision}'='2' AND jsonb_array_length(saved#>'{payload,validation_issues}')>0,'safe incomplete save returns issues');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,2,%L)',s,a,wid,gen_random_uuid(),'publish'),'22023','AUTOMATION_INVALID_REQUEST','incomplete publication rejected');
    result:=public.save_automation_workflow_v1(s,a,wid,gen_random_uuid(),2,'First','',g,layout);
    PERFORM pg_temp.workflow_check(public.save_automation_workflow_v1(s,a,wid,save_op,1,'Incomplete','',incomplete,layout)=saved||'{"replayed":true}','old save replay precedes current revision');
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),3,'publish'); version1:=(result#>>'{payload,published_version_id}')::UUID;
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='paused' AND result#>>'{payload,published_version_number}'='1'
        AND result#>'{payload,has_unpublished_changes}'='false' AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_activations WHERE workflow_id=wid),'first publication paused without activation');
    layout:='{"positions":{"Start":{"x":42,"y":-19}}}';
    result:=public.save_automation_workflow_v1(s,a,wid,gen_random_uuid(),4,'Layout','',g,layout);
    PERFORM pg_temp.workflow_check(result#>'{payload,has_unpublished_changes}'='false','layout-only save preserves semantic equality');
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),5,'start');
    SELECT id INTO activation1 FROM public.automation_workflow_activations WHERE workflow_id=wid AND retired_at IS NULL;
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='active'
        AND (SELECT epoch=1 AND version_id=version1 AND active_from IS NOT NULL FROM public.automation_workflow_activations WHERE id=activation1),'start creates epoch interval');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,6,%L)',s,a,wid,gen_random_uuid(),'start'),'P0001','AUTOMATION_STATE_CONFLICT','already active start rejected');
    FOREACH run_state IN ARRAY ARRAY['queued','waiting','claimed','running','sending','unknown'] LOOP
        INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
            VALUES(s,'lead.created',run_state,'lead',gen_random_uuid(),clock_timestamp()) RETURNING id INTO event_id;
        INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id,state,next_due_at,claim_token,lease_expires_at)
            VALUES(s,wid,version1,event_id,activation1,1,'Start',run_state,
                CASE WHEN run_state NOT IN ('sending','unknown') THEN clock_timestamp() END,
                CASE WHEN run_state IN ('claimed','running','sending','unknown') THEN gen_random_uuid() END,
                CASE WHEN run_state IN ('claimed','running','sending','unknown') THEN clock_timestamp()+INTERVAL '1 minute' END);
    END LOOP;
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),6,'publish');
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='active' AND result#>>'{payload,published_version_number}'='2'
        AND result#>>'{payload,pending_run_count}'='4' AND result#>>'{payload,sending_run_count}'='1'
        AND (SELECT bool_and(version_id=version1 AND revision=1) FROM public.automation_workflow_runs WHERE workflow_id=wid)
        AND (SELECT count(*)=2 AND count(*) FILTER(WHERE retired_at IS NULL)=1 AND min(epoch)=max(epoch) FROM public.automation_workflow_activations WHERE workflow_id=wid),'active publish retains old runs and changes interval');
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),7,'publish',true);
    PERFORM pg_temp.workflow_check((SELECT count(*)=4 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state='cancelled' AND claim_token IS NULL AND lease_expires_at IS NULL AND revision=2)
        AND (SELECT count(*)=2 FROM public.automation_workflow_runs WHERE workflow_id=wid AND state IN ('sending','unknown') AND revision=2 AND claim_token IS NOT NULL AND next_due_at IS NULL
            AND cancel_requested_at IS NOT NULL AND cancel_reason='workflow_republished')
        AND (SELECT epoch=2 FROM public.automation_workflow_activations WHERE workflow_id=wid AND retired_at IS NULL),'cancel pending advances epoch but retains sending unknown');
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),8,'pause');
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='paused' AND result#>>'{payload,pending_run_count}'='0'
        AND NOT EXISTS(SELECT 1 FROM public.automation_workflow_activations WHERE workflow_id=wid AND cancelled_at IS NULL),'pause closes and cancels all intervals');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,9,%L)',s,a,wid,gen_random_uuid(),'pause'),'P0001','AUTOMATION_STATE_CONFLICT','fresh paused pause conflicts');
    result:=public.save_automation_workflow_v1(s,a,wid,gen_random_uuid(),9,'Unsaved incomplete','',incomplete,layout);
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),10,'start');
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='active' AND result#>'{payload,has_unpublished_changes}'='true'
        AND (SELECT epoch=3 FROM public.automation_workflow_activations WHERE workflow_id=wid AND retired_at IS NULL),'start uses published graph with incomplete unsaved draft');
    child:=jsonb_set(g,'{nodes,0,config,event_type}','"lead.stage_changed"');
    result:=public.save_automation_workflow_v1(s,a,wid,gen_random_uuid(),11,'Changed draft trigger','',child,layout);
    r:=public.list_automation_workflows_v1(s,a,50);
    PERFORM pg_temp.workflow_check(r#>>'{payload,items,0,trigger_event_type}'='lead.created'
        AND r#>>'{payload,items,0,draft_trigger_event_type}'='lead.stage_changed','active summary distinguishes published and draft triggers');
    INSERT INTO private.automation_workflow_events(studio_id,event_type,source_key,subject_kind,subject_id,occurred_at)
        VALUES(s,'lead.created','archive-pending','lead',gen_random_uuid(),clock_timestamp()) RETURNING id INTO event_id;
    INSERT INTO public.automation_workflow_runs(studio_id,workflow_id,version_id,event_id,activation_id,epoch,current_node_id)
        SELECT studio_id,workflow_id,version_id,event_id,id,epoch,'Start' FROM public.automation_workflow_activations WHERE workflow_id=wid AND retired_at IS NULL;
    result:=public.command_automation_workflow_v1(s,a,wid,gen_random_uuid(),12,'archive');
    PERFORM pg_temp.workflow_check((SELECT state='cancelled' AND revision=2 FROM public.automation_workflow_runs r WHERE r.event_id=fixture.event_id),'archive cancels new pending run');
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='archived' AND result#>>'{payload,sending_run_count}'='1','archive is terminal and sending remains truthful');
    PERFORM pg_temp.workflow_error(format('SELECT public.save_automation_workflow_v1(%L,%L,%L,%L,13,%L,%L,%L,%L)',s,a,wid,gen_random_uuid(),'No','',g,layout),'P0001','AUTOMATION_STATE_CONFLICT','archived save rejected');
    PERFORM pg_temp.workflow_check(public.get_automation_operation_v1(s,a,op)#>'{payload,result}'=first->'payload','receipt retains original result after archive');
    RESET ROLE;
    PERFORM pg_temp.workflow_error(format('UPDATE public.automation_workflow_versions SET graph=%L WHERE id=%L',incomplete,version1),'22023','AUTOMATION_IMMUTABLE_RECORD','published version immutable');
    PERFORM pg_temp.workflow_error(format('UPDATE private.automation_command_operations SET result=%L WHERE studio_id=%L AND operation_id=%L','{}',s,op),'22023','AUTOMATION_IMMUTABLE_RECORD','receipt immutable');
    PERFORM pg_temp.workflow_error(format('UPDATE public.automation_workflow_activations SET epoch=99 WHERE id=%L',activation1),'22023','AUTOMATION_IMMUTABLE_RECORD','activation identity immutable');
    PERFORM pg_temp.workflow_error(format('UPDATE public.automation_workflow_activations SET retired_at=NULL WHERE id=%L',activation1),'22023','AUTOMATION_IMMUTABLE_RECORD','activation closure cannot reopen');
    PERFORM pg_temp.workflow_error(format('UPDATE public.automation_workflow_runs SET epoch=99 WHERE workflow_id=%L',wid),'22023','AUTOMATION_IMMUTABLE_RECORD','run identity immutable');
    PERFORM pg_temp.workflow_error(format('UPDATE private.automation_workflow_events SET context=%L WHERE studio_id=%L','{"changed":true}',s),'22023','AUTOMATION_IMMUTABLE_RECORD','event context immutable');
    UPDATE public.staff_roles SET role='front_desk' WHERE studio_id=s AND user_id=a;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_operation_v1(%L,%L,%L)',s,a,op),'42501','AUTOMATION_ADMIN_REQUIRED','demoted admin cannot read workflow receipt');
    RESET ROLE;
    UPDATE public.staff_roles SET role='admin' WHERE studio_id=s AND user_id=a;
    INSERT INTO private.automation_command_operations(studio_id,operation_id,actor_id,command,request_fingerprint,entity_type,entity_id,result)
        VALUES(s,receipt_op,desk,'lead.create',repeat('a',64),'lead',NULL,'{"synthetic":true}');
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_check(public.get_automation_operation_v1(s,desk,receipt_op)#>>'{payload,command}'='lead.create','front desk reads own lead creation receipt');
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_operation_v1(%L,%L,%L)',s,desk,op),'42501','AUTOMATION_ADMIN_REQUIRED','front desk cannot read other command receipt');
    PERFORM pg_temp.workflow_check(public.get_automation_operation_v1(s,a,receipt_op)#>>'{payload,command}'='lead.create','admin reads same studio lead receipt');
    RESET ROLE;
    UPDATE public.staff_roles SET archived_at=clock_timestamp() WHERE studio_id=s AND user_id=desk;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_operation_v1(%L,%L,%L)',s,desk,receipt_op),'42501','AUTOMATION_ADMIN_REQUIRED','archived lead actor denied');
    RESET ROLE;
    UPDATE public.studio_subscriptions SET status='canceled' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.workflow_error(format('SELECT public.get_automation_workflow_v1(%L,%L,%L)',s,a,wid),'42501','AUTOMATION_ADMIN_REQUIRED','current entitlement required');
    RESET ROLE;
    UPDATE public.studio_subscriptions SET status='active' WHERE studio_id=s;
    SET LOCAL ROLE service_role;
    child:=jsonb_set(g,'{nodes,0,config,program_id}',to_jsonb(other_program::TEXT));
    PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,gen_random_uuid(),'Wrong program','',child,layout),'P0002','AUTOMATION_NOT_FOUND','trigger rejects other studio program');
    child:=jsonb_set(g,'{nodes,0,config,program_id}',to_jsonb(program::TEXT));
    result:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Same program','',child,layout);
    PERFORM pg_temp.workflow_check(result#>>'{payload,status}'='draft','trigger accepts same studio program');
    wid2:=(result#>>'{payload,id}')::UUID;
    conditions:='{"schema_version":1,"nodes":[{"id":"Start","type":"trigger","config":{"event_type":"lead.created"}},{"id":"condition","type":"condition","config":{"field":"program.id","operator":"eq"}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"first","source":"Start","target":"condition","port":"next"},{"id":"yes","source":"condition","target":"end","port":"yes"},{"id":"no","source":"condition","target":"end","port":"no"}]}';
    result:=public.save_automation_workflow_v1(s,a,wid2,gen_random_uuid(),1,'Omitted condition','',conditions,layout);
    PERFORM pg_temp.workflow_check(NOT (public.get_automation_workflow_v1(s,a,wid2)#>'{payload,draft_graph,nodes,1,config}') ? 'value'
        AND jsonb_array_length(result#>'{payload,validation_issues}')>0,'saved omitted nullable value roundtrip');
    result:=public.save_automation_workflow_v1(s,a,wid2,gen_random_uuid(),2,'Same program','',g,layout);
    FOREACH run_state IN ARRAY ARRAY['eq','in'] LOOP
        child:=jsonb_set(jsonb_set(conditions,'{nodes,1,config,operator}',to_jsonb(run_state)),
            '{nodes,1,config,value}',CASE WHEN run_state='in' THEN jsonb_build_array(program,other_program) ELSE to_jsonb(other_program::TEXT) END);
        PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,gen_random_uuid(),'Wrong condition program','',child,layout),'P0002','AUTOMATION_NOT_FOUND','condition program other studio '||run_state);
        child:=jsonb_set(jsonb_set(jsonb_set(child,'{nodes,0,config,event_type}','"student.promoted"'),
            '{nodes,1,config,field}','"promotion.rank_id"'),'{nodes,1,config,value}',CASE WHEN run_state='in' THEN jsonb_build_array(rank_id) ELSE to_jsonb(rank_id::TEXT) END);
        PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,gen_random_uuid(),'Wrong condition rank','',child,layout),'P0002','AUTOMATION_NOT_FOUND','condition rank other studio '||run_state);
    END LOOP;
    PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,NULL)',s,a,gen_random_uuid(),'Null layout','',g),'22023','AUTOMATION_INVALID_REQUEST','null command layout rejected');
    result:=public.list_automation_workflows_v1(s,a,1);
    r:=public.list_automation_workflows_v1(s,a,1,result#>'{payload,next_cursor}');
    PERFORM pg_temp.workflow_check(NOT (result#>'{payload,items,0}') ?| ARRAY['draft_graph','draft_layout','validation_issues']
        AND (result#>'{payload,items,0}') ?& ARRAY['created_at','trigger_event_type']
        AND (SELECT count(*)=15 FROM jsonb_object_keys(result#>'{payload,items,0}')),'list uses bounded exact summary fields');
    PERFORM pg_temp.workflow_check(result#>'{payload,has_more}'='true' AND r#>'{payload,has_more}'='false'
        AND r#>'{payload,next_cursor}'='null' AND r#>>'{payload,items,0,id}'=wid::TEXT,'keyset pages and cursor consistency');
    PERFORM pg_temp.workflow_error(format('SELECT public.list_automation_workflows_v1(%L,%L,1,%L)',s,a,'{"id":"no"}'),'22023','AUTOMATION_INVALID_REQUEST','malformed cursor rejected');
    FOREACH child IN ARRAY ARRAY['null'::JSONB,'{}'::JSONB,'{"schema_version":null,"nodes":[],"edges":[]}'::JSONB] LOOP
        PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,gen_random_uuid(),'Null','',child,layout),'22023','AUTOMATION_INVALID_REQUEST','malformed graph '||child::TEXT);
    END LOOP;
    PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,NULL,%L,%L,%L)',s,a,gen_random_uuid(),'',g,layout),'22023','AUTOMATION_INVALID_REQUEST','null name rejected');
    PERFORM pg_temp.workflow_error(format('SELECT public.save_automation_workflow_v1(%L,%L,%L,%L,NULL,%L,%L,%L,%L)',s,a,wid2,gen_random_uuid(),'Null','',g,layout),'22023','AUTOMATION_INVALID_REQUEST','null revision rejected');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,1,NULL)',s,a,wid2,gen_random_uuid()),'22023','AUTOMATION_INVALID_REQUEST','null action rejected');
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,1,%L,NULL)',s,a,wid2,gen_random_uuid(),'publish'),'22023','AUTOMATION_INVALID_REQUEST','null cancel flag rejected');
    PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,NULL,%L,%L,%L,%L)',s,a,'Null','',g,layout),'22023','AUTOMATION_INVALID_REQUEST','null operation rejected');
    RESET ROLE;
    PERFORM pg_temp.workflow_error(format('INSERT INTO public.automation_workflow_versions(studio_id,workflow_id,version_number,graph,graph_sha256) VALUES(%L,%L,99,%L,%L)',s2,wid,g,repeat('a',64)),'23503',NULL,'version tenant FK rejects cross studio');
    -- One archived + one draft above must count toward the total admission cap.
    SET LOCAL ROLE service_role;
    FOR n IN 3..100 LOOP
        PERFORM public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Cap '||n,'',g,'{}');
    END LOOP;
    PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',s,a,gen_random_uuid(),'Over cap','',g,'{}'),'P0001','AUTOMATION_STATE_CONFLICT','100 total cap includes archived');
    FOR n IN 1..26 LOOP
        result:=public.create_automation_workflow_v1(s2,b,gen_random_uuid(),'Active '||n,'',g,'{}');
        wid2:=(result#>>'{payload,id}')::UUID;
        PERFORM public.command_automation_workflow_v1(s2,b,wid2,gen_random_uuid(),1,'publish');
        IF n<=25 THEN PERFORM public.command_automation_workflow_v1(s2,b,wid2,gen_random_uuid(),2,'start'); END IF;
    END LOOP;
    PERFORM pg_temp.workflow_error(format('SELECT public.command_automation_workflow_v1(%L,%L,%L,%L,2,%L)',s2,b,wid2,gen_random_uuid(),'start'),'P0001','AUTOMATION_STATE_CONFLICT','25 active cap');
    RESET ROLE;
END $$;
-- WorkflowName uses Python's full whitespace set, without trimming valid names.
DO $$
DECLARE a UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); wid UUID; op UUID; save_op UUID;
    bad_name TEXT; good_name TEXT; create_name TEXT; specimen INTEGER:=0; codepoint INTEGER;
    blanks TEXT[]:=ARRAY['',E' \t\n'||chr(160)||chr(8199)||chr(28)];
    before_state JSONB; created JSONB; saved JSONB; result JSONB;
    g JSONB:='{"schema_version":1,"nodes":[{"id":"start","type":"trigger","config":{"event_type":"lead.created"}},{"id":"end","type":"end","config":{}}],"edges":[{"id":"next","source":"start","target":"end","port":"next"}]}';
BEGIN
    FOREACH codepoint IN ARRAY ARRAY[9,10,11,12,13,28,29,30,31,32,133,160,5760,
        8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288] LOOP
        blanks:=array_append(blanks,chr(codepoint));
    END LOOP;
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',now());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Name proof',s::TEXT,a,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    SET LOCAL ROLE service_role;
    created:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Original','',g,'{}');
    wid:=(created#>>'{payload,id}')::UUID;
    RESET ROLE;
    FOREACH bad_name IN ARRAY blanks||ARRAY[repeat(chr(128578),121)] LOOP
        specimen:=specimen+1;
        before_state:=pg_temp.workflow_observation_state();
        SET LOCAL ROLE service_role;
        PERFORM pg_temp.workflow_error(format('SELECT public.create_automation_workflow_v1(%L,%L,%L,%L,%L,%L,%L)',
            s,a,gen_random_uuid(),bad_name,'',g,'{}'),'22023','AUTOMATION_INVALID_REQUEST','name create rejection '||specimen);
        PERFORM pg_temp.workflow_error(format('SELECT public.save_automation_workflow_v1(%L,%L,%L,%L,1,%L,%L,%L,%L)',
            s,a,wid,gen_random_uuid(),bad_name,'',g,'{}'),'22023','AUTOMATION_INVALID_REQUEST','name save rejection '||specimen);
        PERFORM pg_temp.workflow_error(format('INSERT INTO public.automation_workflows(studio_id,name,draft_graph,draft_layout) VALUES(%L,%L,%L,%L)',
            s,bad_name,g,'{}'),'23514',NULL,'name table insert rejection '||specimen);
        PERFORM pg_temp.workflow_error(format('UPDATE public.automation_workflows SET name=%L WHERE studio_id=%L AND id=%L',
            bad_name,s,wid),'23514',NULL,'name table update rejection '||specimen);
        RESET ROLE;
        PERFORM pg_temp.workflow_check(pg_temp.workflow_observation_state()=before_state,
            'rejected name leaves workflow receipt audit and source state unchanged '||specimen);
    END LOOP;
    FOREACH good_name IN ARRAY ARRAY['  保留名  ',chr(9)||'École'||chr(160),chr(28)||'Name'||chr(12288),
        repeat(chr(128578),120),'A'||chr(8199)||'B',chr(8203)] LOOP
        specimen:=specimen+1; op:=gen_random_uuid(); save_op:=gen_random_uuid();
        create_name:='Original '||specimen;
        SET LOCAL ROLE service_role;
        created:=public.create_automation_workflow_v1(s,a,op,create_name,'',g,'{}');
        wid:=(created#>>'{payload,id}')::UUID;
        saved:=public.save_automation_workflow_v1(s,a,wid,save_op,1,good_name,'',g,'{}');
        PERFORM pg_temp.workflow_check(saved#>>'{payload,name}'=good_name
            AND public.get_automation_workflow_v1(s,a,wid)#>>'{payload,name}'=good_name,
            'Unicode name save roundtrip preserves exact text '||specimen);
        PERFORM pg_temp.workflow_check(public.save_automation_workflow_v1(s,a,wid,save_op,1,good_name,'',g,'{}')=saved||'{"replayed":true}'
            AND public.create_automation_workflow_v1(s,a,op,create_name,'',g,'{}')=created||'{"replayed":true}',
            'Unicode name command replays preserve original exact results '||specimen);
        PERFORM pg_temp.workflow_error(format('SELECT public.save_automation_workflow_v1(%L,%L,%L,%L,1,%L,%L,%L,%L)',
            s,a,wid,save_op,'x'||good_name,'',g,'{}'),CASE WHEN length(good_name)=120 THEN '22023' ELSE 'P0001' END,
            CASE WHEN length(good_name)=120 THEN 'AUTOMATION_INVALID_REQUEST' ELSE 'AUTOMATION_OPERATION_CONFLICT' END,
            'meaningful name change never replays under original key '||specimen);
        IF btrim(good_name)<>good_name THEN
            PERFORM pg_temp.workflow_error(format('SELECT public.save_automation_workflow_v1(%L,%L,%L,%L,1,%L,%L,%L,%L)',
                s,a,wid,save_op,btrim(good_name),'',g,'{}'),'P0001','AUTOMATION_OPERATION_CONFLICT',
                'removing meaningful edge whitespace changes fingerprint '||specimen);
        END IF;
        created:=public.create_automation_workflow_v1(s,a,gen_random_uuid(),good_name,'',g,'{}');
        PERFORM pg_temp.workflow_check(created#>>'{payload,name}'=good_name,'Unicode name create roundtrip preserves exact text '||specimen);
        -- Direct writes obey the same invariant and preserve edge whitespace.
        UPDATE public.automation_workflows SET name=good_name WHERE id=wid;
        INSERT INTO public.automation_workflows(studio_id,name,draft_graph,draft_layout) VALUES(s,good_name,g,'{}') RETURNING to_jsonb(automation_workflows.*) INTO result;
        PERFORM pg_temp.workflow_check(result->>'name'=good_name,'Unicode name direct insert preserves exact text '||specimen);
        RESET ROLE;
    END LOOP;
END $$;
SELECT count(*) AS workflow_management_contract_checks FROM workflow_management_checks;
ROLLBACK;
