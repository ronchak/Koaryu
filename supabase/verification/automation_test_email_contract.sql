-- Foreground test contracts. No provider or customer data is used.
BEGIN;
SET LOCAL statement_timeout='90s';
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE test_email_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.test_email_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'test email contract failed: %',label; END IF;
    INSERT INTO pg_temp.test_email_checks VALUES(label);
END $$;
CREATE FUNCTION pg_temp.test_email_error(statement TEXT,code TEXT,message TEXT,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE got_code TEXT; got_message TEXT;
BEGIN
    BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS got_code=RETURNED_SQLSTATE,got_message=MESSAGE_TEXT; END;
    PERFORM pg_temp.test_email_check(got_code=code AND got_message=message,label);
END $$;
-- fixture owners start.
CREATE FUNCTION pg_temp.test_email_graph(kind TEXT DEFAULT 'lead.created',program UUID DEFAULT NULL) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('schema_version',1,'nodes',jsonb_build_array(
        jsonb_build_object('id','trigger','type','trigger','config',jsonb_build_object('event_type',kind,'program_id',program)||
            CASE WHEN private.workflow_catalog_v1()#>ARRAY['triggers',kind,'supports_offset']='true'::JSONB THEN '{"offset_minutes":-1440}'::JSONB ELSE '{}'::JSONB END),
        jsonb_build_object('id','mail','type','email','config',jsonb_build_object('recipient',private.workflow_catalog_v1()#>>ARRAY['triggers',kind,'recipient_ids','0'],
            'subject_template','Hello {{recipient_name}}','body_template','From {{studio_name}}','reply_to_email','')),
        '{"id":"end","type":"end","config":{}}'::JSONB),
        'edges','[{"id":"next","source":"trigger","target":"mail","port":"next"},{"id":"done","source":"mail","target":"end","port":"next"}]'::JSONB)
$$;
CREATE FUNCTION pg_temp.test_email_fixture(kind TEXT DEFAULT 'lead.created') RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a UUID:=gen_random_uuid(); s UUID:=gen_random_uuid(); p UUID:=gen_random_uuid(); w UUID; graph JSONB;
BEGIN
    INSERT INTO auth.users(id,email,email_confirmed_at) VALUES(a,a||'@example.invalid',clock_timestamp());
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(s,'Synthetic studio',s::TEXT,a,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(s,a,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(s,'active',false);
    INSERT INTO public.programs(id,studio_id,name) VALUES(p,s,'Synthetic program');
    graph:=pg_temp.test_email_graph(kind,CASE WHEN (private.workflow_catalog_v1()#>>ARRAY['triggers',kind,'supports_program_filter'])::BOOLEAN THEN p END);
    w:=(public.create_automation_workflow_v1(s,a,gen_random_uuid(),'Synthetic workflow','',graph,'{}')#>>'{payload,id}')::UUID;
    RETURN jsonb_build_object('actor',a,'studio',s,'program',p,'workflow',w,'graph',graph);
END $$;
-- fixture owners end.
DO $$
DECLARE x JSONB:=pg_temp.test_email_fixture(); got JSONB; replay JSONB; runtime JSONB:=jsonb_build_object('sender_binding',repeat('a',64),
    'default_reply_to','reply@example.invalid','allowed_recipients','[]'::JSONB); op UUID:=gen_random_uuid(); v_scope_id UUID; token UUID; fn RECORD; role_name TEXT; before_scopes BIGINT; before_receipts BIGINT;
    rendered JSONB:=jsonb_build_object('subject','[Test] Hello','text_body',E'Synthetic automation test. Sample data only.\n\nBody',
        'html_body',E'<div style="white-space: pre-wrap">Synthetic automation test. Sample data only.\n\nBody</div>');
BEGIN
    FOR fn IN SELECT p.oid::REGPROCEDURE identity,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN ('create_automation_test_email_v1','claim_automation_test_sender_preparation_v1',
            'finish_automation_test_email_preflight_v1','begin_automation_test_email_v1','settle_automation_test_email_v1','get_automation_test_email_v1') LOOP
        FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
            PERFORM pg_temp.test_email_check(NOT has_function_privilege(role_name,fn.identity,'EXECUTE'),fn.identity||' denies '||role_name);
        END LOOP;
        PERFORM pg_temp.test_email_check(has_function_privilege('service_role',fn.identity,'EXECUTE') AND NOT fn.prosecdef
            AND fn.proconfig=ARRAY['search_path=""'],fn.identity||' service invoker');
    END LOOP;
    PERFORM pg_temp.test_email_check((SELECT count(*)=6 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
        AND p.proname IN ('create_automation_test_email_v1','claim_automation_test_sender_preparation_v1','finish_automation_test_email_preflight_v1',
            'begin_automation_test_email_v1','settle_automation_test_email_v1','get_automation_test_email_v1')),'six exact owners');
    PERFORM pg_temp.test_email_check(private.automation_test_rendered_valid_v1(rendered),'fixed synthetic profile');
    PERFORM pg_temp.test_email_check(NOT private.automation_test_rendered_valid_v1(rendered||'{"html_body":"<script>unsafe</script>"}'),'HTML exact escaped body');
    PERFORM pg_temp.test_email_check(NOT private.automation_test_rendered_valid_v1(rendered||jsonb_build_object('subject',E'[Test] bad\nheader')),'header control refusal');
    PERFORM pg_temp.test_email_check(NOT private.automation_test_rendered_valid_v1(rendered||jsonb_build_object('subject','[Test] '||chr(129))),'C1 control refusal');
    PERFORM pg_temp.test_email_check(NOT private.automation_test_rendered_valid_v1(rendered||jsonb_build_object('subject','[Test] '||chr(160))),'Unicode whitespace-only subject refusal');
    SELECT count(*) INTO before_scopes FROM private.automation_test_email_scopes;
    SELECT count(*) INTO before_receipts FROM private.automation_command_operations;
    PERFORM pg_temp.test_email_error(format('SELECT public.create_automation_test_email_v1(%L,%L,%L,%L,%L::JSONB,%L,NULL,true)',
        x->>'studio',x->>'actor',x->>'workflow',gen_random_uuid(),x->'graph','mail'),'P0001','AUTOMATION_STATE_CONFLICT','no-receipt replay-only uses existing state conflict');
    PERFORM pg_temp.test_email_check((SELECT count(*) FROM private.automation_test_email_scopes)=before_scopes
        AND (SELECT count(*) FROM private.automation_command_operations)=before_receipts,'no-receipt replay-only creates no scope or receipt');
    got:=public.create_automation_test_email_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,op,x->'graph','mail',runtime);
    v_scope_id:=(got#>>'{payload,result,test_delivery_id}')::UUID; token:=(got#>>'{payload,execution,execution_token}')::UUID;
    PERFORM pg_temp.test_email_check(got#>>'{payload,result,state}'='queued' AND got#>>'{payload,replayed}'='false','fresh queued grant');
    UPDATE auth.users SET email_confirmed_at=NULL WHERE id=(x->>'actor')::UUID;
    DELETE FROM public.programs WHERE id=(x->>'program')::UUID;
    replay:=public.create_automation_test_email_v1((x->>'studio')::UUID,(x->>'actor')::UUID,(x->>'workflow')::UUID,op,x->'graph','mail',NULL,true);
    PERFORM pg_temp.test_email_check(replay#>>'{payload,replayed}'='true' AND replay#>'{payload,execution}'='null'::JSONB
        AND replay#>'{payload,result}'=got#>'{payload,result}','replay precedes mutable verification references and config');
    PERFORM public.finish_automation_test_email_preflight_v1((x->>'studio')::UUID,v_scope_id,token,'sender_unavailable');
    PERFORM pg_temp.test_email_check(public.get_automation_test_email_v1((x->>'studio')::UUID,(x->>'actor')::UUID,v_scope_id)#>>'{payload,result,state}'='failed','current truth differs from immutable ACK');
    PERFORM pg_temp.test_email_error(format('DELETE FROM private.automation_test_email_payloads WHERE scope_id=%L',v_scope_id),'42501','AUTOMATION_PAYLOAD_CLEAR_REQUIRED','payload delete requires exclusive clear');
    PERFORM pg_temp.test_email_error(format('UPDATE private.automation_test_email_scopes SET recipient_email=%L WHERE id=%L','other@example.invalid',v_scope_id),'22023','AUTOMATION_IMMUTABLE_RECORD','identity is immutable');
    PERFORM pg_temp.test_email_error(format('SELECT private.automation_test_invalidate_queued_v1(%L)',x->>'studio'),'42501','AUTOMATION_PAYLOAD_CLEAR_REQUIRED','invalidation requires exclusive clear');
    PERFORM pg_advisory_xact_lock(hashtextextended('koaryu.local-plan-clear:'||(x->>'studio'),0));
    PERFORM private.automation_test_invalidate_queued_v1((x->>'studio')::UUID);
    DELETE FROM private.automation_test_email_payloads WHERE scope_id=v_scope_id AND studio_id=(x->>'studio')::UUID;
    PERFORM pg_temp.test_email_check(EXISTS(SELECT 1 FROM private.automation_test_email_scopes WHERE id=v_scope_id)
        AND EXISTS(SELECT 1 FROM private.automation_command_operations WHERE operation_id=op),'clear retains scope and receipt');
    PERFORM pg_temp.test_email_check((SELECT count(*)=0 FROM private.automation_email_attempt_reservations WHERE scope_id=v_scope_id),'preflight has no attempt');
END $$;
SELECT count(*) AS automation_test_email_contract_checks FROM test_email_checks;
ROLLBACK;
