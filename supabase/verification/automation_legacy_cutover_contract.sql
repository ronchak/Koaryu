-- Synthetic local legacy adoption. Every fixture and helper rolls back.
BEGIN;
-- Isolate this transactional source fixture from other synthetic rule queues.
UPDATE public.automation_rules SET enabled=false;
SET LOCAL statement_timeout='90s';
CREATE FUNCTION pg_temp.assert_legacy(ok BOOLEAN,message TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Legacy adoption: %',message; END IF; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_legacy(BOOLEAN,TEXT) TO service_role;

-- Test-only recovery exercises the accepted owners. Moving the synthetic probe
-- due time is scheduling, not resetting mode, generation, failure or attempts.
CREATE FUNCTION pg_temp.recover_legacy_sender(studio UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE prep JSONB; result JSONB; scope UUID:=gen_random_uuid(); attempt UUID:=gen_random_uuid(); owner UUID:=gen_random_uuid(); revision BIGINT;
BEGIN
    IF (SELECT mode='ready' FROM private.automation_sender_gate) THEN RETURN; END IF;
    INSERT INTO private.automation_email_credentials(provider_key,encrypted_credentials,revision)
        VALUES('microsoft_graph:primary','synthetic-local-only',1) ON CONFLICT DO NOTHING;
    SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE provider_key='microsoft_graph:primary';
    UPDATE private.automation_sender_gate SET next_probe_at=clock_timestamp() WHERE mode='cooldown';
    prep:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64),'synthetic_recovery',scope)->'payload';
    PERFORM pg_temp.assert_legacy((prep->>'allowed')::BOOLEAN,'synthetic recovery preparation');
    result:=public.settle_automation_sender_preparation_v1((prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID,
        jsonb_build_object('outcome','prepared','credential_revision',revision,'sender_binding',repeat('a',64),
            'safe_reason',NULL,'retry_after_seconds',NULL));
    result:=private.automation_email_attempt_begin_v1(studio,'test',scope,NULL,attempt,owner,scope::TEXT||'@example.invalid',
        (prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID,(prep->>'probe_token')::UUID);
    PERFORM pg_temp.assert_legacy(result->>'outcome'='begun','synthetic recovery attempt');
    result:=private.automation_email_attempt_settle_v1(attempt,owner,jsonb_build_object('outcome','accepted','error_code',NULL,
        'provider_request_id',NULL,'retry_after_seconds',NULL,'submission_evidence','accepted','failure_scope',NULL,'credential_revision',revision));
    PERFORM pg_temp.assert_legacy(result->>'state'='accepted' AND (SELECT mode='ready' FROM private.automation_sender_gate),'synthetic recovery confirmed');
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.recover_legacy_sender(UUID) TO service_role;

DO $catalog$
DECLARE item RECORD;
BEGIN
    PERFORM pg_temp.assert_legacy((SELECT relrowsecurity AND relpersistence='p' AND pg_get_userbyid(relowner)='postgres'
        FROM pg_class WHERE oid='private.automation_unsubscribe_token_bindings'::REGCLASS),'logged RLS mapping ownership');
    PERFORM pg_temp.assert_legacy((SELECT array_agg(column_name::TEXT ORDER BY ordinal_position)=ARRAY['token_hash','studio_id','recipient_email','created_at']
        FROM information_schema.columns WHERE table_schema='private' AND table_name='automation_unsubscribe_token_bindings'),'no mapping payload or plaintext token');
    PERFORM pg_temp.assert_legacy(NOT has_table_privilege('anon','private.automation_unsubscribe_token_bindings','SELECT')
        AND NOT has_table_privilege('authenticated','private.automation_unsubscribe_token_bindings','SELECT')
        AND has_table_privilege('service_role','private.automation_unsubscribe_token_bindings','SELECT,INSERT')
        AND NOT has_table_privilege('service_role','private.automation_unsubscribe_token_bindings','UPDATE')
        AND NOT has_table_privilege('service_role','private.automation_unsubscribe_token_bindings','DELETE'),'mapping service-only minimal privileges');
    FOR item IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE
        (n.nspname='private' AND p.proname IN ('automation_bind_unsubscribe_token_v1','automation_legacy_begin_v1','automation_legacy_settle_v1',
            'automation_legacy_terminal_v1','automation_legacy_delivery_transition_v1','automation_legacy_delivery_delete_v1',
            'automation_unsubscribe_binding_identity_v1','automation_expire_orphaned_legacy_attempts_v1'))
        OR (n.nspname='public' AND p.proname IN ('begin_missed_class_automation_v2','settle_missed_class_automation_v2')) LOOP
        PERFORM pg_temp.assert_legacy(NOT item.prosecdef AND item.proconfig=ARRAY['search_path=""']
            AND pg_get_userbyid(item.proowner)='postgres' AND NOT has_function_privilege('anon',item.oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',item.oid,'EXECUTE')
            AND has_function_privilege('service_role',item.oid,'EXECUTE')=(item.prorettype<>'trigger'::REGTYPE),'private owner privileges');
    END LOOP;
END $catalog$;

DO $contract$
#variable_conflict use_variable
DECLARE actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); student UUID; session UUID:=gen_random_uuid();
    delivery UUID; token UUID; prep JSONB; result JSONB; begun JSONB; settled JSONB; replay JSONB; evidence JSONB;
    attempt UUID; revision BIGINT; generation BIGINT; n INTEGER; failure TEXT; failed BOOLEAN; optout TEXT;
BEGIN
    INSERT INTO auth.users(id,email) VALUES(actor,actor::TEXT||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Legacy contract',studio::TEXT,actor,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES(session,studio,'Old class',current_date-20,'00:00','01:00');
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Subject','Body','reply@example.invalid');
    INSERT INTO private.automation_email_credentials(provider_key,encrypted_credentials,revision)
        VALUES('microsoft_graph:primary','synthetic-local-only',1) ON CONFLICT DO NOTHING;
    SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE provider_key='microsoft_graph:primary';
    SET LOCAL ROLE service_role;
    FOREACH failure IN ARRAY ARRAY['accepted','accepted_closed','message','sender_auth','unclassified','unproved','malformed'] LOOP
        PERFORM pg_temp.recover_legacy_sender(studio);
        student:=gen_random_uuid();
        INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email)
            VALUES(student,studio,'Synthetic','Student',student::TEXT||'@example.invalid');
        INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES(studio,session,student,now()-INTERVAL '20 days');
        result:=public.enqueue_missed_class_automations_v1(1,ARRAY[student::TEXT||'@example.invalid']);
        result:=public.claim_missed_class_automations_v1(1,ARRAY[student::TEXT||'@example.invalid']);
        delivery:=(result#>>'{items,0,id}')::UUID; token:=(result#>>'{items,0,claim_token}')::UUID;
        prep:=public.claim_automation_sender_preparation_v1('microsoft_graph:primary',gen_random_uuid(),repeat('a',64))->'payload';
        result:=public.settle_automation_sender_preparation_v1((prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID,
            jsonb_build_object('outcome','prepared','credential_revision',revision,'sender_binding',repeat('a',64),'safe_reason',NULL,'retry_after_seconds',NULL));
        begun:=public.begin_missed_class_automation_v2(delivery,token,(prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID,
            ARRAY[student::TEXT||'@example.invalid'],(prep->>'probe_token')::UUID)->'payload';
        attempt:=(begun->>'attempt_id')::UUID; optout:=begun#>>'{message,unsubscribe_token}';
        PERFORM pg_temp.assert_legacy((begun->>'ready')::BOOLEAN AND begun->>'state'='sending' AND attempt IS NOT NULL,'prepared actual grant');
        PERFORM pg_temp.assert_legacy(private.workflow_json_keys_v1(begun,
            ARRAY['delivery_id','claim_token','ready','state','reason','attempt_id','lease_expires_at','credential_revision','sender_binding','message'],
            ARRAY['delivery_id','claim_token','ready','state','reason','attempt_id','lease_expires_at','credential_revision','sender_binding','message']),'closed begin fields');
        result:=public.begin_missed_class_automation_v2(delivery,token,(prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID)->'payload';
        PERFORM pg_temp.assert_legacy(result->'ready'='false'::JSONB AND result->'attempt_id'='null'::JSONB AND result->'message'='null'::JSONB,'no repeated send grant');
        PERFORM pg_temp.assert_legacy(public.settle_missed_class_automation_v1(delivery,token,'accepted')='{"updated":false,"state":"sending"}'::JSONB,'no prepared downgrade');
        evidence:=jsonb_build_object('outcome',CASE WHEN failure IN ('accepted','accepted_closed') THEN 'accepted' ELSE 'permanent_failure' END,
            'error_code',CASE WHEN failure IN ('accepted','accepted_closed') THEN NULL ELSE 'provider_rejected' END,'provider_request_id','synthetic-request',
            'retry_after_seconds',NULL,'submission_evidence',CASE WHEN failure IN ('accepted','accepted_closed','unproved','malformed') THEN NULL ELSE 'rejected' END,
            'failure_scope',CASE WHEN failure IN ('accepted','accepted_closed','unproved','malformed') THEN NULL ELSE failure END,'credential_revision',revision);
        IF failure='malformed' THEN evidence:=evidence||'{"extra":true}'::JSONB; END IF;
        IF failure='accepted_closed' THEN
            PERFORM private.automation_sender_failure_v1('sender_transient','provider_unavailable',NULL,NULL,clock_timestamp());
        END IF;
        SELECT g.generation INTO generation FROM private.automation_sender_gate g;
        settled:=public.settle_missed_class_automation_v2(delivery,token,attempt,evidence)->'payload';
        PERFORM pg_temp.assert_legacy((settled->>'updated')::BOOLEAN AND NOT (settled->>'replayed')::BOOLEAN,'fresh settlement');
        PERFORM pg_temp.assert_legacy(settled->>'state'=CASE failure WHEN 'accepted' THEN 'accepted' WHEN 'accepted_closed' THEN 'accepted' WHEN 'unproved' THEN 'unknown' WHEN 'malformed' THEN 'unknown' ELSE 'failed' END,'evidence controls terminal truth');
        PERFORM pg_temp.assert_legacy((SELECT mode=CASE failure WHEN 'accepted' THEN 'ready' WHEN 'message' THEN 'ready' WHEN 'sender_auth' THEN 'auth_blocked' ELSE 'cooldown' END
            AND g.generation=generation+CASE WHEN failure IN ('accepted','accepted_closed','message') THEN 0 ELSE 1 END FROM private.automation_sender_gate g),'classified failure changes gate once');
        replay:=public.settle_missed_class_automation_v2(delivery,token,attempt,evidence)->'payload';
        PERFORM pg_temp.assert_legacy(replay=settled||'{"replayed":true}'::JSONB,'exact settlement replay');
        result:=public.settle_missed_class_automation_v2(delivery,gen_random_uuid(),attempt,evidence)->'payload';
        PERFORM pg_temp.assert_legacy(result->'updated'='false'::JSONB AND result->'state'='null'::JSONB AND result->'reason'='null'::JSONB,'wrong token refusal');
        result:=public.settle_missed_class_automation_v2(gen_random_uuid(),token,attempt,evidence)->'payload';
        PERFORM pg_temp.assert_legacy(result->'updated'='false'::JSONB,'wrong logical identity refusal');
        DELETE FROM public.students WHERE id=student;
        replay:=public.settle_missed_class_automation_v2(delivery,token,attempt,evidence)->'payload';
        PERFORM pg_temp.assert_legacy(replay=settled||'{"replayed":true}'::JSONB,'replay survives cascade');
        PERFORM public.suppress_missed_class_automation_v1(optout);
        PERFORM pg_temp.assert_legacy(EXISTS(SELECT 1 FROM public.automation_suppressions s WHERE s.studio_id=studio AND s.recipient_email=student::TEXT||'@example.invalid'),'original token survives cascade');
        failed:=false;
        BEGIN PERFORM private.automation_bind_unsubscribe_token_v1(studio,optout,'different@example.invalid');
        EXCEPTION WHEN check_violation THEN failed:=true; END;
        PERFORM pg_temp.assert_legacy(failed,'hash binding cannot retarget');
    END LOOP;
    PERFORM pg_temp.recover_legacy_sender(studio);
    PERFORM pg_temp.assert_legacy(public.suppress_missed_class_automation_v1(NULL)='{"success":true}'::JSONB
        AND public.suppress_missed_class_automation_v1('malformed')='{"success":true}'::JSONB
        AND public.suppress_missed_class_automation_v1(repeat('f',64))='{"success":true}'::JSONB,'opaque token responses');
    RESET ROLE;
END $contract$;
ROLLBACK;
