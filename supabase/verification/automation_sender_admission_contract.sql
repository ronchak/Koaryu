-- Common owners with synthetic enclosing scopes. This proves no customer source,
-- graph continuation, legacy adoption, verified Auth authority or release readiness.
BEGIN;
SET LOCAL TIME ZONE 'UTC';

CREATE FUNCTION pg_temp.sender_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'sender contract: %',label; END IF;
END $$;
CREATE FUNCTION pg_temp.sender_reject(statement TEXT,expected_state TEXT,expected_message TEXT DEFAULT NULL) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE matched BOOLEAN:=false;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        matched:=SQLSTATE=expected_state AND (expected_message IS NULL OR SQLERRM=expected_message);
        IF NOT matched THEN RAISE; END IF;
    END;
    PERFORM pg_temp.sender_check(matched,'expected rejection: '||expected_state);
END $$;
CREATE FUNCTION pg_temp.sender_reset() RETURNS VOID LANGUAGE sql AS $$
    UPDATE private.automation_sender_gate SET generation=generation+1,mode='ready',reason=NULL,next_probe_at=NULL,
        sender_binding=repeat('a',64),failed_credential_revision=NULL,transient_failures=0,active_preparation_id=NULL,
        active_probe_token=NULL,active_attempt_id=NULL,probe_expires_at=NULL,updated_at=clock_timestamp()
$$;
CREATE FUNCTION pg_temp.sender_result(outcome TEXT DEFAULT 'accepted',evidence TEXT DEFAULT 'accepted',
    scope TEXT DEFAULT NULL,revision BIGINT DEFAULT 1) RETURNS JSONB LANGUAGE sql AS $$
    SELECT jsonb_build_object('outcome',outcome,'error_code',CASE WHEN outcome<>'accepted' THEN 'provider_rejected' END,
        'provider_request_id','synthetic-request','retry_after_seconds',NULL,'submission_evidence',evidence,
        'failure_scope',scope,'credential_revision',revision)
$$;
CREATE FUNCTION pg_temp.sender_fixture(kind TEXT DEFAULT 'workflow',prior INTEGER DEFAULT 0) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE actor UUID:=gen_random_uuid(); studio UUID:=gen_random_uuid(); scope UUID:=gen_random_uuid(); preparation UUID:=gen_random_uuid();
    claim JSONB; settled JSONB; revision BIGINT;
BEGIN
    INSERT INTO auth.users(id,email) VALUES(actor,actor::TEXT||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Synthetic sender parent',studio::TEXT,actor);
    SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE c.provider_key='microsoft_graph:primary';
    claim:=private.automation_sender_claim_v1(preparation,repeat('a',64),
        CASE WHEN kind='test' THEN 'synthetic_recovery' ELSE 'normal' END,CASE WHEN kind='test' THEN scope END)->'payload';
    PERFORM pg_temp.sender_check((claim->>'allowed')::BOOLEAN,'synthetic fixture preparation allowed');
    settled:=public.settle_automation_sender_preparation_v1(preparation,(claim->>'preparation_token')::UUID,
        jsonb_build_object('outcome','prepared','credential_revision',revision,'sender_binding',repeat('a',64),
            'safe_reason',NULL,'retry_after_seconds',NULL))->'payload';
    PERFORM pg_temp.sender_check(settled->>'outcome'='prepared','synthetic fixture prepared');
    RETURN jsonb_build_object('studio',studio,'scope',scope,'kind',kind,'node',CASE WHEN kind='workflow' THEN 'email' END,
        'attempt',gen_random_uuid(),'owner',gen_random_uuid(),'email',studio::TEXT||'@example.invalid',
        'preparation',preparation,'token',claim->'preparation_token','probe',claim->'probe_token','revision',revision,
        'prior',CASE WHEN kind='legacy' THEN prior END);
END $$;
CREATE FUNCTION pg_temp.sender_begin(f JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT private.automation_email_attempt_begin_v1((f->>'studio')::UUID,f->>'kind',(f->>'scope')::UUID,f->>'node',
        (f->>'attempt')::UUID,(f->>'owner')::UUID,f->>'email',(f->>'preparation')::UUID,(f->>'token')::UUID,
        (f->>'probe')::UUID,(f->>'prior')::INTEGER)
$$;
CREATE FUNCTION pg_temp.sender_settle(f JSONB,result JSONB) RETURNS JSONB LANGUAGE sql AS $$
    SELECT private.automation_email_attempt_settle_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,result)
$$;
GRANT EXECUTE ON FUNCTION pg_temp.sender_check(BOOLEAN,TEXT),pg_temp.sender_reject(TEXT,TEXT,TEXT) TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION pg_temp.sender_result(TEXT,TEXT,TEXT,BIGINT),pg_temp.sender_begin(JSONB),pg_temp.sender_settle(JSONB,JSONB) TO service_role;

DO $catalog$
DECLARE r RECORD; name TEXT; count INTEGER:=0;
BEGIN
    PERFORM pg_temp.sender_check((SELECT generation=1 AND mode='ready' AND sender_binding IS NULL AND reason IS NULL
        AND transient_failures=0 AND active_preparation_id IS NULL FROM private.automation_sender_gate),'inert singleton seed');
    PERFORM pg_temp.sender_check(NOT EXISTS(SELECT 1 FROM private.automation_sender_preparations),'no seed preparation');
    PERFORM pg_temp.sender_check(NOT EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations),'no seed attempt');
    FOREACH name IN ARRAY ARRAY['automation_sender_gate','automation_sender_preparations','automation_email_attempt_reservations'] LOOP
        SELECT c.*,pg_get_userbyid(c.relowner) owner INTO r FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='private' AND c.relname=name;
        PERFORM pg_temp.sender_check(r.relpersistence='p' AND r.relrowsecurity AND r.owner='postgres','logged private RLS table');
        PERFORM pg_temp.sender_check(NOT has_table_privilege('anon','private.'||name,'SELECT,INSERT,UPDATE,DELETE')
            AND NOT has_table_privilege('authenticated','private.'||name,'SELECT,INSERT,UPDATE,DELETE'),'clients denied table');
        PERFORM pg_temp.sender_check(has_table_privilege('service_role','private.'||name,'SELECT,UPDATE')
            AND NOT has_table_privilege('service_role','private.'||name,'DELETE'),'service has no DELETE');
    END LOOP;
    FOR r IN SELECT p.*,p.oid::REGPROCEDURE identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE (n.nspname='private' AND p.proname IN ('automation_sender_instant_v1','automation_sender_preparation_result_valid_v1',
            'automation_legacy_projection_valid_v1','automation_legacy_delivery_result_v1','automation_sender_gate_identity_v1',
            'automation_sender_preparation_identity_v1','automation_email_attempt_identity_v1','automation_sender_gate_lock_v1',
            'automation_sender_retry_at_v1','automation_sender_preparation_reply_v1','automation_email_scope_lock_v1','automation_sender_failure_v1',
            'automation_sender_claim_v1','automation_sender_preparation_settle_v1','automation_delivery_result_v1',
            'automation_email_attempt_begin_v1','automation_email_attempt_settle_v1','automation_email_attempt_expire_v1',
            'automation_legacy_projection_pin_v1','automation_sender_release_probe_v1','automation_sender_release_orphan_probe_v1'))
            OR (n.nspname='public' AND p.proname IN ('claim_automation_sender_preparation_v1','settle_automation_sender_preparation_v1','get_automation_sender_status_v1')) LOOP
        count:=count+1;
        PERFORM pg_temp.sender_check(NOT r.prosecdef AND r.proconfig=ARRAY['search_path=""'] AND pg_get_userbyid(r.proowner)='postgres','function security');
        PERFORM pg_temp.sender_check(NOT has_function_privilege('anon',r.oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',r.oid,'EXECUTE'),'client helper execution denied');
        PERFORM pg_temp.sender_check(has_function_privilege('service_role',r.oid,'EXECUTE')=(r.prorettype<>'trigger'::REGTYPE),'service callable/trigger boundary');
    END LOOP;
    PERFORM pg_temp.sender_check(count=24,'exact24 new functions');
    PERFORM pg_temp.sender_check((SELECT count(*)=1 FROM pg_constraint WHERE conrelid='private.automation_email_attempt_reservations'::REGCLASS
        AND contype='f' AND confrelid='public.studios'::REGCLASS AND confdeltype='c'),'sole studio cascade');
    PERFORM pg_temp.sender_check((SELECT count(*)=1 FROM pg_constraint WHERE conrelid='private.automation_email_attempt_reservations'::REGCLASS AND contype='f'),'no deleting source FK');
    PERFORM pg_temp.sender_check((SELECT indnullsnotdistinct FROM pg_index WHERE indexrelid='private.automation_email_actual_ordinal'::REGCLASS),'null node ordinal uniqueness');
    PERFORM pg_temp.sender_check((SELECT pg_get_expr(indpred,indrelid) !~ '(now|clock_timestamp|statement_timestamp|transaction_timestamp)\(' FROM pg_index
        WHERE indexrelid='private.automation_email_recipient_budget'::REGCLASS),'frequency partial index has no moving clock');
END $catalog$;

SET LOCAL ROLE anon;
SELECT pg_temp.sender_reject($q$SELECT public.claim_automation_sender_preparation_v1('microsoft_graph:primary',gen_random_uuid(),repeat('a',64))$q$,'42501');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.sender_reject($q$SELECT private.automation_sender_release_orphan_probe_v1()$q$,'42501');
RESET ROLE;
SELECT public.save_automation_email_credential_v1('microsoft_graph:primary',0,'synthetic-envelope-no-real-credential');

DO $claim$
DECLARE id UUID:=gen_random_uuid(); first JSONB; replay JSONB; gate_before JSONB; value JSONB; bad JSONB;
BEGIN
    first:=public.claim_automation_sender_preparation_v1('microsoft_graph:primary',id,repeat('a',64));
    PERFORM pg_temp.sender_check((SELECT count(*)=1 FROM jsonb_object_keys(first)) AND first ? 'payload','single envelope');
    first:=first->'payload';
    PERFORM pg_temp.sender_check((first->>'allowed')::BOOLEAN AND first->>'mode'='ready' AND first->>'generation'='1'
        AND first->'probe_token'='null'::JSONB AND first->'retry_at'='null'::JSONB AND first->'reason'='null'::JSONB,'ready grant and first bind');
    replay:=public.claim_automation_sender_preparation_v1('microsoft_graph:primary',id,repeat('a',64))->'payload';
    PERFORM pg_temp.sender_check(replay=first,'claim replay original lease/token');
    PERFORM pg_temp.sender_reject(format('SELECT public.claim_automation_sender_preparation_v1(''microsoft_graph:primary'',%L,repeat(''b'',64))',id),
        '22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject(format('SELECT private.automation_sender_claim_v1(%L,repeat(''a'',64),''synthetic_recovery'',gen_random_uuid())',id),
        '22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject($q$SELECT public.claim_automation_sender_preparation_v1('other',gen_random_uuid(),repeat('a',64))$q$,'22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject($q$SELECT private.automation_sender_claim_v1(gen_random_uuid(),'', 'normal',NULL)$q$,'22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject($q$SELECT private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64),'synthetic_recovery',NULL)$q$,'22023','AUTOMATION_INVALID_REQUEST');
    value:=jsonb_build_object('outcome','prepared','credential_revision',1,'sender_binding',repeat('a',64),'safe_reason',NULL,'retry_after_seconds',NULL);
    replay:=public.settle_automation_sender_preparation_v1(id,(first->>'preparation_token')::UUID,value)->'payload';
    PERFORM pg_temp.sender_check(replay->>'outcome'='prepared' AND replay->'lease_expires_at'=first->'lease_expires_at','prepared does not renew');
    PERFORM pg_temp.sender_check(public.settle_automation_sender_preparation_v1(id,(first->>'preparation_token')::UUID,value)->'payload'=replay,'prepared replay');
    PERFORM pg_temp.sender_check(public.settle_automation_sender_preparation_v1(id,gen_random_uuid(),value)->'payload'->>'outcome'='stale','wrong token stale');
    PERFORM pg_temp.sender_check(public.settle_automation_sender_preparation_v1(gen_random_uuid(),gen_random_uuid(),value)->'payload'->>'outcome'='stale','missing preparation stale');
    PERFORM pg_temp.sender_check(NOT EXISTS(SELECT 1 FROM private.automation_email_attempt_reservations),'preparation is no attempt');
    FOREACH bad IN ARRAY ARRAY['null'::JSONB,'[]'::JSONB,'true'::JSONB,'{}'::JSONB,value-'sender_binding',value||'{"extra":null}'::JSONB,
        value||'{"credential_revision":true}'::JSONB,value||'{"credential_revision":"1"}'::JSONB,value||'{"credential_revision":1.5}'::JSONB,
        value||'{"credential_revision":0}'::JSONB,value||'{"credential_revision":9223372036854775808}'::JSONB,
        value||'{"safe_reason":"provider_unavailable"}'::JSONB,value||'{"retry_after_seconds":1}'::JSONB] LOOP
        PERFORM pg_temp.sender_reject(format('SELECT public.settle_automation_sender_preparation_v1(%L,%L,%L::jsonb)',id,first->>'preparation_token',bad),
            '22023','AUTOMATION_INVALID_REQUEST');
    END LOOP;
    SELECT to_jsonb(g) INTO gate_before FROM private.automation_sender_gate g;
    BEGIN
        DELETE FROM private.automation_sender_gate;
        PERFORM pg_temp.sender_reject($q$SELECT public.claim_automation_sender_preparation_v1('microsoft_graph:primary',gen_random_uuid(),repeat('a',64))$q$,
            'P0001','AUTOMATION_SENDER_UNAVAILABLE');
        RAISE EXCEPTION 'rollback missing singleton' USING ERRCODE='P9001';
    EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
    END;
    PERFORM pg_temp.sender_check((SELECT to_jsonb(g)=gate_before FROM private.automation_sender_gate g),'missing singleton never repaired');
END $claim$;

DO $failure$
<<proof>>
DECLARE a JSONB; b JSONB; evidence JSONB; response JSONB; generation BIGINT; counter INTEGER; lease TIMESTAMPTZ;
BEGIN
    PERFORM pg_temp.sender_reset();
    a:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64))->'payload';
    b:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64))->'payload';
    evidence:=jsonb_build_object('outcome','sender_transient','credential_revision',NULL,'sender_binding',repeat('a',64),
        'safe_reason','token_refresh_unavailable','retry_after_seconds',1);
    response:=public.settle_automation_sender_preparation_v1((a->>'preparation_id')::UUID,(a->>'preparation_token')::UUID,evidence)->'payload';
    PERFORM pg_temp.sender_check(response->>'outcome'='deferred' AND response->'preparation_token'='null'::JSONB AND response->>'retry_at' IS NOT NULL,'transient defers');
    SELECT g.generation,g.transient_failures INTO generation,counter FROM private.automation_sender_gate g;
    PERFORM pg_temp.sender_check(counter=1 AND (SELECT next_probe_at>=updated_at+INTERVAL '60 seconds' FROM private.automation_sender_gate),'first cooldown60');
    PERFORM public.settle_automation_sender_preparation_v1((a->>'preparation_id')::UUID,(a->>'preparation_token')::UUID,evidence);
    PERFORM pg_temp.sender_check((SELECT g.generation=proof.generation AND transient_failures=1 FROM private.automation_sender_gate g),'failure replay one transition');
    evidence:=evidence||'{"outcome":"sender_auth","safe_reason":"authentication_required","retry_after_seconds":null}'::JSONB;
    response:=public.settle_automation_sender_preparation_v1((b->>'preparation_id')::UUID,(b->>'preparation_token')::UUID,evidence)->'payload';
    PERFORM pg_temp.sender_check(response->>'outcome'='blocked' AND response->'retry_at'='null'::JSONB,'new live hard failure fences earlier generation');
    PERFORM pg_temp.sender_check((SELECT g.generation=proof.generation+1 AND mode='auth_blocked' AND next_probe_at IS NULL FROM private.automation_sender_gate g),'hard failure advances once');
    PERFORM pg_temp.sender_check((SELECT credential_revision IS NULL AND result=evidence FROM private.automation_sender_preparations WHERE id=(b->>'preparation_id')::UUID),'failed preparation has no used revision');
    a:=public.claim_automation_sender_preparation_v1('microsoft_graph:primary',gen_random_uuid(),repeat('a',64))->'payload';
    PERFORM pg_temp.sender_check(a->>'allowed'='false' AND a->>'mode'='auth_blocked' AND a->'retry_at'='null'::JSONB,'normal hard denial');
    PERFORM pg_temp.sender_check(NOT EXISTS(SELECT 1 FROM private.automation_sender_preparations WHERE id=(a->>'preparation_id')::UUID),'denial has no preparation');
    b:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64),'synthetic_recovery',gen_random_uuid())->'payload';
    PERFORM pg_temp.sender_check(b->>'allowed'='true' AND b->>'probe_token' IS NOT NULL,'private synthetic hard probe');
    a:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64),'synthetic_recovery',gen_random_uuid())->'payload';
    PERFORM pg_temp.sender_check(a->>'allowed'='false','only one provider-wide probe');
    PERFORM pg_temp.sender_check(NOT private.automation_sender_release_probe_v1((b->>'preparation_id')::UUID,gen_random_uuid(),(b->>'probe_token')::UUID),'wrong token cannot release');
    PERFORM pg_temp.sender_check(private.automation_sender_release_probe_v1((b->>'preparation_id')::UUID,(b->>'preparation_token')::UUID,(b->>'probe_token')::UUID),'exact unused probe release');
    PERFORM pg_temp.sender_check((SELECT mode='auth_blocked' AND transient_failures=1 FROM private.automation_sender_gate),'release preserves failure');
    generation:=(SELECT g.generation FROM private.automation_sender_gate g);
    a:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('b',64))->'payload';
    PERFORM pg_temp.sender_check(a->>'allowed'='false' AND (a->>'generation')::BIGINT=generation+1,'changed binding fences but cannot unblock');
    PERFORM pg_temp.sender_reset();
END $failure$;

DO $credential$
DECLARE f JSONB; evidence JSONB; before JSONB; result JSONB; revision BIGINT;
BEGIN
    f:=pg_temp.sender_fixture(); revision:=(f->>'revision')::BIGINT;
    evidence:=jsonb_build_object('outcome','prepared','credential_revision',revision,'sender_binding',repeat('a',64),'safe_reason',NULL,'retry_after_seconds',NULL);
    PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',revision,'synthetic-replacement');
    result:=public.claim_automation_sender_preparation_v1('microsoft_graph:primary',(f->>'preparation')::UUID,repeat('a',64))->'payload';
    PERFORM pg_temp.sender_check(result->>'allowed'='false' AND result->'preparation_token'='null'::JSONB,'credential change invalidates prepared claim replay');
    result:=public.settle_automation_sender_preparation_v1((f->>'preparation')::UUID,(f->>'token')::UUID,evidence)->'payload';
    PERFORM pg_temp.sender_check(result->>'outcome'='stale' AND result->'preparation_token'='null'::JSONB,'credential change invalidates prepared replay');
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'reason'='preparation_stale','credential change refuses begin');
    f:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64))->'payload';
    revision:=revision+1;
    PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',revision,'synthetic-refresh-winner');
    evidence:=evidence||jsonb_build_object('credential_revision',revision+1);
    result:=public.settle_automation_sender_preparation_v1((f->>'preparation_id')::UUID,(f->>'preparation_token')::UUID,evidence)->'payload';
    PERFORM pg_temp.sender_check(result->>'outcome'='prepared','refresh winner after claim accepted');
    BEGIN
        DELETE FROM private.automation_email_credentials WHERE provider_key='microsoft_graph:primary';
        result:=public.settle_automation_sender_preparation_v1((f->>'preparation_id')::UUID,(f->>'preparation_token')::UUID,evidence)->'payload';
        PERFORM pg_temp.sender_check(result->>'outcome'='stale','missing current credential is stale');
        RAISE EXCEPTION 'rollback credential absence' USING ERRCODE='P9001';
    EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
    END;
END $credential$;

DO $attempts$
DECLARE f JSONB; next JSONB; begun JSONB; result JSONB; saved JSONB; n INTEGER; field TEXT;
BEGIN
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture();
    begun:=pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_check(begun->>'outcome'='begun' AND begun->>'attempt_number'='1','first actual begin');
    SELECT to_jsonb(a) INTO saved FROM private.automation_email_attempt_reservations a WHERE id=(f->>'attempt')::UUID;
    PERFORM pg_temp.sender_check((saved->>'lease_expires_at')::TIMESTAMPTZ=(saved->>'actual_began_at')::TIMESTAMPTZ+INTERVAL '60 seconds'
        AND saved->'budget_at'=saved->'actual_began_at','immutable original actual lease and budget');
    result:=pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_check(result->>'outcome'='already_begun' AND result->'owner_token'='null'::JSONB
        AND result->'lease_expires_at'='null'::JSONB AND result->'generation'='null'::JSONB,'lost begin response grants no resend');
    PERFORM pg_temp.sender_reject(format('SELECT pg_temp.sender_begin(%L::jsonb)',f||jsonb_build_object('owner',gen_random_uuid())),
        '22023','AUTOMATION_INVALID_REQUEST');
    next:=f||jsonb_build_object('attempt',gen_random_uuid(),'owner',gen_random_uuid());
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(next)->>'reason'='scope_terminal','sending scope has no second attempt');
    FOREACH field IN ARRAY ARRAY['owner_token','scope_id','studio_id','preparation_id','preparation_token'] LOOP
        PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET %I=gen_random_uuid() WHERE id=%L',field,f->>'attempt'),
            '22023','AUTOMATION_INVALID_REQUEST');
    END LOOP;
    FOREACH field IN ARRAY ARRAY['actual_began_at','lease_expires_at'] LOOP
        PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET %I=%I+INTERVAL ''1 second'' WHERE id=%L',field,field,f->>'attempt'),
            '22023','AUTOMATION_INVALID_REQUEST');
    END LOOP;
    FOR n IN 1..3 LOOP
        result:=pg_temp.sender_settle(f,pg_temp.sender_result('permanent_failure','not_submitted','message',(f->>'revision')::BIGINT));
        PERFORM pg_temp.sender_check(result->>'state'='failed','proved message failure');
        PERFORM pg_temp.sender_check((SELECT frequency_state='released' AND attempt_number=n FROM private.automation_email_attempt_reservations
            WHERE id=(f->>'attempt')::UUID),'failed frequency released but ordinal retained');
        next:=f||jsonb_build_object('attempt',gen_random_uuid(),'owner',gen_random_uuid());
        begun:=pg_temp.sender_begin(next);
        IF n<3 THEN
            PERFORM pg_temp.sender_check(begun->>'outcome'='begun' AND (begun->>'attempt_number')::INTEGER=n+1,'next absolute ordinal');
            f:=next;
        ELSE
            PERFORM pg_temp.sender_check(begun->>'reason'='retry_exhausted' AND begun->'attempt_id'='null'::JSONB,'three actual begins exhausted');
        END IF;
    END LOOP;
    PERFORM pg_temp.sender_check((SELECT count(*)=3 FROM private.automation_email_attempt_reservations
        WHERE studio_id=(f->>'studio')::UUID AND scope_id=(f->>'scope')::UUID),'no fabricated fourth attempt');
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('permanent_failure','not_submitted','message',(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'outcome'='replayed','matching terminal replay');
    PERFORM pg_temp.sender_check(pg_temp.sender_settle(f,pg_temp.sender_result('accepted','accepted',NULL,(f->>'revision')::BIGINT))->>'outcome'='refused','conflicting terminal result refused');
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'outcome'='already_begun','terminal begin replay still has no grant');
    PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET settled_at=settled_at+INTERVAL ''1 second'' WHERE id=%L',f->>'attempt'),
        '22023','AUTOMATION_INVALID_REQUEST');
    f:=pg_temp.sender_fixture('test');
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'attempt_number'='1','test first begin');
    PERFORM pg_temp.sender_settle(f,pg_temp.sender_result('permanent_failure','not_submitted','message',(f->>'revision')::BIGINT));
    next:=f||jsonb_build_object('attempt',gen_random_uuid(),'owner',gen_random_uuid());
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(next)->>'reason'='retry_exhausted','test absolute one begin');
    f:=pg_temp.sender_fixture('legacy',2);
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'attempt_number'='3','synthetic parent count permits first actual ordinal3');
    PERFORM pg_temp.sender_check((SELECT count(*)=1 FROM private.automation_email_attempt_reservations WHERE scope_id=(f->>'scope')::UUID),'no invented earlier attempts');
    PERFORM pg_temp.sender_reject(format('SELECT pg_temp.sender_begin(%L::jsonb)',pg_temp.sender_fixture()||'{"prior":1}'::JSONB),'22023','AUTOMATION_INVALID_REQUEST');
END $attempts$;

DO $frequency$
<<proof>>
DECLARE f JSONB; other JSONB; result JSONB;
BEGIN
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture();
    INSERT INTO public.automation_suppressions(studio_id,recipient_email) VALUES((f->>'studio')::UUID,f->>'email');
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'reason'='recipient_suppressed','shared suppression checked');
    DELETE FROM public.automation_suppressions WHERE studio_id=(f->>'studio')::UUID;
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'outcome'='begun','suppression rollback fixture restored');
    PERFORM pg_temp.sender_settle(f,pg_temp.sender_result('accepted',NULL,NULL,(f->>'revision')::BIGINT));
    other:=f||jsonb_build_object('scope',gen_random_uuid(),'attempt',gen_random_uuid(),'owner',gen_random_uuid());
    result:=pg_temp.sender_begin(other);
    PERFORM pg_temp.sender_check(result->>'reason'='rate_limited' AND result->>'retry_at' IS NOT NULL,'same recipient different scope charged');
    PERFORM pg_temp.sender_check((SELECT (proof.result->>'retry_at')::TIMESTAMPTZ=actual_began_at+INTERVAL '60 minutes'
        FROM private.automation_email_attempt_reservations WHERE id=(f->>'attempt')::UUID),'frequency uses exact actual begin');
    other:=pg_temp.sender_fixture()||jsonb_build_object('email',f->>'email');
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(other)->>'outcome'='begun','same recipient different studio independent');
    f:=pg_temp.sender_fixture();
    INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,
        origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal)
        SELECT gen_random_uuid(),(f->>'studio')::UUID,'microsoft_graph:primary','legacy',gen_random_uuid(),f->>'email',
            'legacy_settlement_upper_bound','historical','accepted','accepted',clock_timestamp()-make_interval(hours=>n),3
        FROM generate_series(2,4) n;
    result:=pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_check(result->>'reason'='rate_limited' AND (result->>'retry_at')::TIMESTAMPTZ>clock_timestamp()+INTERVAL '19 hours','third recent conservative reservation charged');
    PERFORM pg_temp.sender_check((SELECT bool_and(actual_began_at IS NULL AND attempt_number IS NULL AND admitted_credential_revision IS NULL)
        FROM private.automation_email_attempt_reservations WHERE studio_id=(f->>'studio')::UUID),'history remains conservative');
    f:=pg_temp.sender_fixture();
    INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,
        origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal)
        VALUES(gen_random_uuid(),(f->>'studio')::UUID,'microsoft_graph:primary','legacy',gen_random_uuid(),f->>'email',
            'legacy_settlement_upper_bound','historical','unknown','unknown',clock_timestamp()-INTERVAL '25 hours',3);
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'outcome'='begun','old conservative charge ages out');
END $frequency$;

DO $settlement$
DECLARE f JSONB; result JSONB; before JSONB; generation BIGINT;
BEGIN
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture(); PERFORM pg_temp.sender_begin(f);
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('retryable_failure',NULL,NULL,(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'state'='unknown' AND result->'result'->>'error_code'='provider_submission_unknown','unproved failure unknown');
    PERFORM pg_temp.sender_check((SELECT frequency_state='unknown' FROM private.automation_email_attempt_reservations WHERE id=(f->>'attempt')::UUID),'unknown remains charged');
    PERFORM pg_temp.sender_check((SELECT mode='cooldown' AND transient_failures=1 FROM private.automation_sender_gate),'unknown pauses provider once');
    SELECT to_jsonb(g) INTO before FROM private.automation_sender_gate g;
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('unknown','unknown','unclassified',(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'outcome'='replayed','normalized unknown replay');
    PERFORM pg_temp.sender_check((SELECT to_jsonb(g)=before FROM private.automation_sender_gate g),'unknown replay does not increment');
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture(); PERFORM pg_temp.sender_begin(f);
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('accepted',NULL,NULL,(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'state'='accepted','accepted-null keeps truthful acceptance');
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f||jsonb_build_object('attempt',gen_random_uuid(),'owner',gen_random_uuid()))->>'reason'='scope_terminal','accepted scope terminal');
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture(); PERFORM pg_temp.sender_begin(f);
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('permanent_failure','rejected','sender_auth',(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'state'='failed' AND (SELECT mode='auth_blocked' FROM private.automation_sender_gate),'proved auth failure blocks');
    PERFORM pg_temp.sender_check((SELECT frequency_state='released' FROM private.automation_email_attempt_reservations WHERE id=(f->>'attempt')::UUID),'proved rejection releases frequency');
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture('legacy');
    f:=f||'{"preparation":null,"token":null,"probe":null}'::JSONB;
    PERFORM pg_temp.sender_check(pg_temp.sender_begin(f)->>'outcome'='begun','synthetic legacy-v1 null preparation allowed ready');
    PERFORM pg_temp.sender_check((SELECT protocol='legacy_v1' AND sender_generation>0 AND sender_binding IS NULL AND admitted_credential_revision IS NULL
        FROM private.automation_email_attempt_reservations WHERE id=(f->>'attempt')::UUID),'legacy admission makes no revision claim');
    result:=pg_temp.sender_settle(f,'{"outcome":"permanent_failure","error_code":"provider_rejected","provider_request_id":null,"retry_after_seconds":null}');
    PERFORM pg_temp.sender_check(result->>'state'='failed' AND result->'result'->'submission_evidence'='null'::JSONB,'legacy old failure remains nullable');
    PERFORM pg_temp.sender_check((SELECT mode='auth_blocked' AND reason='sender_rejection_unclassified' FROM private.automation_sender_gate),'legacy generic rejection conservative hard block');
END $settlement$;

DO $probe_cleanup$
DECLARE f JSONB; result JSONB; before JSONB; after JSONB; variant INTEGER; revision BIGINT;
BEGIN
    FOR variant IN 1..4 LOOP
        PERFORM pg_temp.sender_reset();
        -- Explicit synthetic closed/due state, not a credential or readiness assertion.
        UPDATE private.automation_sender_gate SET mode='cooldown',reason='provider_unavailable',next_probe_at=clock_timestamp()-INTERVAL '1 second',transient_failures=2;
        f:=pg_temp.sender_fixture(); PERFORM pg_temp.sender_begin(f);
        SELECT to_jsonb(g)-ARRAY['active_preparation_id','active_probe_token','active_attempt_id','probe_expires_at','updated_at'] INTO before FROM private.automation_sender_gate g;
        revision:=(f->>'revision')::BIGINT;
        IF variant=2 THEN PERFORM public.save_automation_email_credential_v1('microsoft_graph:primary',revision,'synthetic-new-current'); END IF;
        result:=pg_temp.sender_settle(f,CASE WHEN variant=3 THEN pg_temp.sender_result('permanent_failure','rejected','message',revision)
            WHEN variant=1 THEN pg_temp.sender_result('accepted',NULL,NULL,revision) ELSE pg_temp.sender_result('accepted','accepted',NULL,revision) END);
        PERFORM pg_temp.sender_check(result->>'outcome'='confirmed','owned probe terminal recorded');
        PERFORM pg_temp.sender_check((SELECT active_attempt_id IS NULL AND active_preparation_id IS NULL FROM private.automation_sender_gate),'every owned terminal releases probe');
        IF variant<4 THEN
            SELECT to_jsonb(g)-ARRAY['active_preparation_id','active_probe_token','active_attempt_id','probe_expires_at','updated_at'] INTO after FROM private.automation_sender_gate g;
            PERFORM pg_temp.sender_check(after=before,'cleanup alone preserves every closed gate field');
            result:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64))->'payload';
            PERFORM pg_temp.sender_check(result->>'allowed'='true','new due probe after terminal cleanup');
            before:=(SELECT to_jsonb(g) FROM private.automation_sender_gate g);
            PERFORM pg_temp.sender_settle(f,CASE WHEN variant=3 THEN pg_temp.sender_result('permanent_failure','rejected','message',revision)
                WHEN variant=1 THEN pg_temp.sender_result('accepted',NULL,NULL,revision) ELSE pg_temp.sender_result('accepted','accepted',NULL,revision) END);
            PERFORM pg_temp.sender_check((SELECT to_jsonb(g)=before FROM private.automation_sender_gate g),'terminal replay cannot release newer probe');
        ELSE
            PERFORM pg_temp.sender_check((SELECT mode='ready' AND reason IS NULL AND next_probe_at IS NULL AND transient_failures=0 FROM private.automation_sender_gate),'exact current explicit probe recovers');
        END IF;
    END LOOP;
    PERFORM pg_temp.sender_reset();
    UPDATE private.automation_sender_gate SET mode='auth_blocked',reason='authentication_required';
    f:=pg_temp.sender_fixture('test'); PERFORM pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_check(NOT private.automation_sender_release_probe_v1((f->>'preparation')::UUID,(f->>'token')::UUID,(f->>'probe')::UUID),'consumed probe cannot use unused release');
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('accepted','accepted',NULL,(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'state'='accepted' AND (SELECT mode='ready' FROM private.automation_sender_gate),'private synthetic exact hard recovery');
END $probe_cleanup$;

DO $projection$
DECLARE f JSONB; result JSONB; projection JSONB; saved JSONB; bad JSONB; terminal TEXT; reason TEXT; id UUID; token UUID;
BEGIN
    FOREACH terminal IN ARRAY ARRAY['accepted','unknown','failed','retry_wait'] LOOP
        PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture('legacy'); PERFORM pg_temp.sender_begin(f);
        result:=pg_temp.sender_settle(f,CASE terminal WHEN 'accepted' THEN pg_temp.sender_result('accepted',NULL,NULL,(f->>'revision')::BIGINT)
            WHEN 'unknown' THEN pg_temp.sender_result('unknown','unknown','unclassified',(f->>'revision')::BIGINT)
            ELSE pg_temp.sender_result('permanent_failure','not_submitted','message',(f->>'revision')::BIGINT) END);
        projection:=jsonb_build_object('state',terminal,'reason',CASE terminal WHEN 'accepted' THEN NULL WHEN 'unknown' THEN 'provider_unknown' ELSE 'connection_failed' END);
        PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,gen_random_uuid(),projection),'wrong original token cannot pin');
        SELECT to_jsonb(a)-'legacy_projection' INTO saved FROM private.automation_email_attempt_reservations a WHERE a.id=(f->>'attempt')::UUID;
        PERFORM pg_temp.sender_check(private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,projection),'prepared legacyv2 first terminal pin');
        PERFORM pg_temp.sender_check(private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,projection),'exact projection replay');
        PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,
            projection||'{"reason":"unavailable"}'::JSONB),'conflicting second projection refuses');
        PERFORM pg_temp.sender_check((SELECT to_jsonb(a)-'legacy_projection'=saved FROM private.automation_email_attempt_reservations a
            WHERE a.id=(f->>'attempt')::UUID),'pin changes no result clock reservation admission evidence');
        PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET legacy_projection=NULL WHERE id=%L',f->>'attempt'),
            '22023','AUTOMATION_INVALID_REQUEST');
    END LOOP;
    FOREACH bad IN ARRAY ARRAY['null'::JSONB,'[]'::JSONB,'true'::JSONB,'"accepted"'::JSONB,'{}'::JSONB,
        '{"state":"accepted"}'::JSONB,'{"reason":null}'::JSONB,'{"state":null,"reason":null}'::JSONB,
        '{"state":true,"reason":null}'::JSONB,'{"state":"sending","reason":null}'::JSONB,
        '{"state":"accepted","reason":12}'::JSONB,'{"state":"accepted","reason":false}'::JSONB,
        '{"state":"accepted","reason":[]}'::JSONB,'{"state":"accepted","reason":"provider_submission_unknown"}'::JSONB,
        '{"state":"accepted","reason":null,"extra":null}'::JSONB] LOOP
        PERFORM pg_temp.sender_reject(format('SELECT private.automation_legacy_projection_pin_v1(%L,%L,%L::jsonb)',f->>'attempt',f->>'owner',bad),
            '22023','AUTOMATION_INVALID_REQUEST');
    END LOOP;
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture('legacy');
    PERFORM pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,
        '{"state":"accepted","reason":null}'),'sending cannot pin');
    FOREACH terminal IN ARRAY ARRAY['workflow','test'] LOOP
        f:=pg_temp.sender_fixture(terminal); PERFORM pg_temp.sender_begin(f);
        PERFORM pg_temp.sender_settle(f,pg_temp.sender_result('accepted','accepted',NULL,(f->>'revision')::BIGINT));
        PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,
            '{"state":"accepted","reason":null}'),'graph and test forbidden');
        PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET legacy_projection=''{"state":"accepted","reason":null}'' WHERE id=%L',f->>'attempt'),'23514');
    END LOOP;
    -- Historical terminal reasons are preserved exactly, including reasons absent
    -- from the transport code set. No actual attempt clocks or tokens are invented.
    f:=pg_temp.sender_fixture('legacy');
    FOREACH reason IN ARRAY ARRAY[NULL,'rule_paused','subscription_required','student_unavailable','inactive','on_hold',
        'invalid_birth_date','never_attended','recent_attendance','invalid_email','guardian_missing','guardian_ambiguous',
        'suppressed','episode_already_attempted','attendance_changed','contact_changed','lease_expired','rate_limited',
        'connection_failed','authentication_required','provider_rejected','provider_unknown','retry_exhausted','unavailable','recipient_not_allowed'] LOOP
        id:=gen_random_uuid();
        INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,
            origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal)
            VALUES(id,(f->>'studio')::UUID,'microsoft_graph:primary','legacy',gen_random_uuid(),f->>'email',
                'legacy_settlement_upper_bound','historical','accepted','accepted',clock_timestamp()-INTERVAL '2 days',2);
        projection:=jsonb_build_object('state','accepted','reason',reason);
        PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1(id,gen_random_uuid(),projection),'historical tokenless row refuses nonnull token');
        PERFORM pg_temp.sender_check(private.automation_legacy_projection_pin_v1(id,NULL,projection),'historical null token exact first pin');
        PERFORM pg_temp.sender_check(private.automation_legacy_projection_pin_v1(id,NULL,projection),'historical projection replay');
        PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1(id,NULL,'{"state":"unknown","reason":null}'),'projection state must agree');
    END LOOP;
    PERFORM pg_temp.sender_check(NOT private.automation_legacy_projection_pin_v1(gen_random_uuid(),NULL,'{"state":"accepted","reason":null}'),'absent row refuses');
END $projection$;

DO $historical_ownership$
<<proof>>
DECLARE f JSONB; id UUID; token UUID; result JSONB; anchor TIMESTAMPTZ; expired BOOLEAN;
BEGIN
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture('legacy');
    FOREACH expired IN ARRAY ARRAY[false,true] LOOP
        id:=gen_random_uuid(); token:=gen_random_uuid(); anchor:=clock_timestamp()-INTERVAL '2 hours';
        INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,origin,protocol,
            state,frequency_state,conservative_anchor_at,observed_legacy_ordinal,owner_token,lease_expires_at)
            VALUES(id,(f->>'studio')::UUID,'microsoft_graph:primary','legacy',gen_random_uuid(),f->>'email','legacy_sending_upper_bound','historical',
                'sending','sending',anchor,2,token,clock_timestamp()+CASE WHEN expired THEN INTERVAL '-1 second' ELSE INTERVAL '60 seconds' END);
        IF expired THEN
            result:=private.automation_email_attempt_expire_v1(id);
            PERFORM pg_temp.sender_check(result->>'state'='unknown','expired observed historical ownership becomes unknown');
            PERFORM pg_temp.sender_check(private.automation_email_attempt_expire_v1(id)->>'outcome'='refused','historical expiry once');
            PERFORM pg_temp.sender_check(private.automation_legacy_projection_pin_v1(id,token,'{"state":"unknown","reason":"lease_expired"}'),'original historical expiry projection');
        ELSE
            result:=private.automation_email_attempt_settle_v1(id,token,'{"outcome":"accepted","error_code":null,"provider_request_id":null,"retry_after_seconds":null}');
            PERFORM pg_temp.sender_check(result->>'state'='accepted','observed live historical ownership may settle');
        END IF;
        PERFORM pg_temp.sender_check((SELECT origin='legacy_sending_upper_bound' AND protocol='historical' AND actual_began_at IS NULL
            AND attempt_number IS NULL AND admitted_credential_revision IS NULL AND conservative_anchor_at=anchor
            AND observed_legacy_ordinal=2 FROM private.automation_email_attempt_reservations a WHERE a.id=proof.id),'history clocks and origin preserved');
    END LOOP;
END $historical_ownership$;

DO $normalization$
DECLARE input JSONB; result JSONB; code TEXT; value JSONB;
BEGIN
    FOREACH code IN ARRAY ARRAY['authentication_required','credential_refresh_conflict','credential_store_unavailable','invalid_message',
        'provider_connection_failed','provider_rejected','provider_submission_unknown','provider_throttled','provider_unavailable',
        'recipient_not_allowed','send_budget_exhausted','sending_disabled','setup_required','token_refresh_invalid','token_refresh_rejected',
        'token_refresh_throttled','token_refresh_unavailable'] LOOP
        input:=pg_temp.sender_result('permanent_failure','rejected','unclassified',1)||jsonb_build_object('error_code',code);
        PERFORM pg_temp.sender_check(private.automation_delivery_result_v1(input,1)=input,'all17 safe transport codes');
    END LOOP;
    input:=pg_temp.sender_result('accepted',NULL,NULL,1)||'{"error_code":"arbitrary provider text"}'::JSONB;
    result:=private.automation_delivery_result_v1(input,1);
    PERFORM pg_temp.sender_check(result->>'outcome'='accepted' AND result->'error_code'='null'::JSONB,'accepted strips error');
    input:=pg_temp.sender_result('permanent_failure','not_submitted','message',1)||'{"error_code":"arbitrary provider text"}'::JSONB;
    PERFORM pg_temp.sender_check(private.automation_delivery_result_v1(input,1)->>'error_code'='provider_unavailable','proved failure safe fallback');
    input:=pg_temp.sender_result('accepted','accepted',NULL,2);
    result:=private.automation_delivery_result_v1(input,1);
    PERFORM pg_temp.sender_check(result->>'outcome'='unknown' AND result->'credential_revision'='null'::JSONB,'used revision contradiction loses revision');
    input:=pg_temp.sender_result('permanent_failure','rejected','sender_auth',1);
    FOREACH value IN ARRAY ARRAY['true'::JSONB,'"1"'::JSONB,'0'::JSONB,'1.5'::JSONB,'9223372036854775808'::JSONB,'[]'::JSONB] LOOP
        PERFORM pg_temp.sender_check(private.automation_delivery_result_v1(input||jsonb_build_object('credential_revision',value),1)->>'outcome'='unknown','invalid strict revision unknown');
    END LOOP;
    FOREACH value IN ARRAY ARRAY['true'::JSONB,'"1"'::JSONB,'0'::JSONB,'1.5'::JSONB,'86401'::JSONB,'[]'::JSONB] LOOP
        result:=private.automation_delivery_result_v1(input||jsonb_build_object('retry_after_seconds',value),1);
        PERFORM pg_temp.sender_check(result->>'outcome'='unknown' AND result->'retry_after_seconds'='null'::JSONB,'invalid retry unknown without coercion');
    END LOOP;
    FOREACH value IN ARRAY ARRAY['null'::JSONB,'true'::JSONB,'[]'::JSONB,'{}'::JSONB,'"accepted"'::JSONB,input-'outcome',input||'{"extra":null}'::JSONB] LOOP
        PERFORM pg_temp.sender_check(private.automation_delivery_result_v1(value,1)->>'outcome'='unknown','malformed closed result unknown');
    END LOOP;
    result:=private.automation_delivery_result_v1(input||'{"provider_request_id":"private body with spaces"}'::JSONB,1);
    PERFORM pg_temp.sender_check(result->>'outcome'='permanent_failure' AND result->'provider_request_id'='null'::JSONB,'unsafe request ID discarded only');
    result:=private.automation_delivery_result_v1(pg_temp.sender_result('unknown','accepted','sender_auth',1),1);
    PERFORM pg_temp.sender_check(result->>'outcome'='unknown' AND result->>'submission_evidence'='unknown' AND result->>'failure_scope'='unclassified','explicit unknown dominates');
END $normalization$;

DO $rollback$
DECLARE f JSONB; before JSONB; result JSONB; number BIGINT; field TEXT;
BEGIN
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture('legacy');
    SELECT to_jsonb(g) INTO before FROM private.automation_sender_gate g;
    SELECT count(*) INTO number FROM private.automation_email_attempt_reservations;
    BEGIN
        PERFORM pg_temp.sender_begin(f);
        PERFORM pg_temp.sender_settle(f,pg_temp.sender_result('permanent_failure','rejected','sender_auth',(f->>'revision')::BIGINT));
        PERFORM private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,'{"state":"failed","reason":"authentication_required"}');
        RAISE EXCEPTION 'synthetic enclosing parent failed' USING ERRCODE='P9001';
    EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
    END;
    PERFORM pg_temp.sender_check((SELECT count(*)=number FROM private.automation_email_attempt_reservations),'parent rollback erases attempt and reservation');
    PERFORM pg_temp.sender_check((SELECT to_jsonb(g)=before FROM private.automation_sender_gate g),'parent rollback erases gate transition');
    PERFORM pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_settle(f,pg_temp.sender_result('accepted','accepted',NULL,(f->>'revision')::BIGINT));
    BEGIN
        PERFORM private.automation_legacy_projection_pin_v1((f->>'attempt')::UUID,(f->>'owner')::UUID,'{"state":"accepted","reason":null}');
        RAISE EXCEPTION 'synthetic parent projection rollback' USING ERRCODE='P9001';
    EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
    END;
    PERFORM pg_temp.sender_check((SELECT legacy_projection IS NULL AND state='accepted' FROM private.automation_email_attempt_reservations
        WHERE id=(f->>'attempt')::UUID),'projection first pin rolls back independently');
    FOREACH field IN ARRAY ARRAY['created_at','lease_expires_at'] LOOP
        PERFORM pg_temp.sender_reject(format('UPDATE private.automation_sender_preparations SET %I=%I+INTERVAL ''1 second'' WHERE id=%L',field,field,f->>'preparation'),
            '22023','AUTOMATION_INVALID_REQUEST');
    END LOOP;
    PERFORM pg_temp.sender_reject(format('UPDATE private.automation_sender_preparations SET state=''expired'' WHERE id=%L',f->>'preparation'),
        '22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject(format('UPDATE private.automation_sender_preparations SET result=result||''{"credential_revision":1}'' WHERE id=%L',f->>'preparation'),
        '22023','AUTOMATION_INVALID_REQUEST');
    BEGIN
        UPDATE private.automation_sender_gate SET generation=9223372036854775807;
        PERFORM pg_temp.sender_reject($q$SELECT private.automation_sender_claim_v1(gen_random_uuid(),repeat('c',64))$q$,'22003');
        PERFORM pg_temp.sender_check((SELECT generation=9223372036854775807 AND sender_binding=repeat('a',64) FROM private.automation_sender_gate),'overflow rolls back whole binding change');
        RAISE EXCEPTION 'rollback overflow fixture' USING ERRCODE='P9001';
    EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
    END;
END $rollback$;

DO $generated_budget_and_cooldown$
DECLARE f JSONB; id UUID:=gen_random_uuid(); claim JSONB; evidence JSONB; result JSONB; n INTEGER; delay INTEGER;
BEGIN
    PERFORM pg_temp.sender_reset(); f:=pg_temp.sender_fixture();
    PERFORM pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_settle(f,pg_temp.sender_result('accepted','accepted',NULL,(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check((SELECT budget_at=actual_began_at FROM private.automation_email_attempt_reservations
        WHERE private.automation_email_attempt_reservations.id=(f->>'attempt')::UUID),'generated budget survives valid settlement');
    PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET budget_at=clock_timestamp() WHERE id=%L',f->>'attempt'),'428C9');
    INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,
        origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal)
        VALUES(id,(f->>'studio')::UUID,'microsoft_graph:primary','legacy',gen_random_uuid(),f->>'email',
            'cutover_fallback','historical','unknown','unknown',clock_timestamp(),1);
    PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET conservative_anchor_at=conservative_anchor_at+INTERVAL ''1 second'' WHERE id=%L',id),
        '22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject(format('UPDATE private.automation_email_attempt_reservations SET actual_began_at=actual_began_at+INTERVAL ''1 second'' WHERE id=%L',f->>'attempt'),
        '22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reset();
    FOR n IN 1..8 LOOP
        IF n>1 THEN UPDATE private.automation_sender_gate SET next_probe_at=clock_timestamp()-INTERVAL '1 second'; END IF;
        claim:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64))->'payload';
        evidence:=jsonb_build_object('outcome','sender_transient','credential_revision',NULL,'sender_binding',repeat('a',64),
            'safe_reason','provider_throttled','retry_after_seconds',NULL);
        result:=public.settle_automation_sender_preparation_v1((claim->>'preparation_id')::UUID,(claim->>'preparation_token')::UUID,evidence)->'payload';
        delay:=least(3600,60*(2^(n-1))::INTEGER);
        PERFORM pg_temp.sender_check(result->>'outcome'='deferred' AND (SELECT transient_failures=least(7,n)
            AND next_probe_at=updated_at+make_interval(secs=>delay) FROM private.automation_sender_gate),'bounded exponential cooldown and saturating counter');
    END LOOP;
    PERFORM pg_temp.sender_reset();
    claim:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64))->'payload';
    evidence:=evidence||'{"retry_after_seconds":3600}'::JSONB;
    PERFORM public.settle_automation_sender_preparation_v1((claim->>'preparation_id')::UUID,(claim->>'preparation_token')::UUID,evidence);
    PERFORM pg_temp.sender_check((SELECT next_probe_at=updated_at+INTERVAL '3600 seconds' FROM private.automation_sender_gate),'Retry-After bounded at one hour');
    PERFORM pg_temp.sender_reject(format('SELECT public.settle_automation_sender_preparation_v1(%L,%L,%L::jsonb)',
        claim->>'preparation_id',claim->>'preparation_token',evidence||'{"retry_after_seconds":3601}'::JSONB),'22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reset();
END $generated_budget_and_cooldown$;

-- Exercise actual service-role calls against the real new SQL owners.
CREATE TEMP TABLE sender_role_fixture(value JSONB);
INSERT INTO sender_role_fixture VALUES(pg_temp.sender_fixture());
GRANT SELECT ON sender_role_fixture TO service_role;
SET LOCAL ROLE service_role;
DO $service$
DECLARE f JSONB; result JSONB;
BEGIN
    SELECT value INTO f FROM sender_role_fixture;
    result:=pg_temp.sender_begin(f);
    PERFORM pg_temp.sender_check(result->>'outcome'='begun','real service-role begin');
    result:=pg_temp.sender_settle(f,pg_temp.sender_result('accepted','accepted',NULL,(f->>'revision')::BIGINT));
    PERFORM pg_temp.sender_check(result->>'state'='accepted','real service-role settle');
    PERFORM pg_temp.sender_reject('DELETE FROM private.automation_email_attempt_reservations','42501');
    PERFORM pg_temp.sender_reject('SELECT private.automation_email_attempt_identity_v1()','42501');
END $service$;
RESET ROLE;

-- BEGIN FOCUSED SENDER STATUS CONTRACT
CREATE FUNCTION pg_temp.sender_observed_rows() RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object(
        'gate',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::TEXT,'ctid',ctid::TEXT) ORDER BY provider_key) FROM private.automation_sender_gate t),
        'preparations',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::TEXT,'ctid',ctid::TEXT) ORDER BY id) FROM private.automation_sender_preparations t),
        'attempts',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::TEXT,'ctid',ctid::TEXT) ORDER BY id) FROM private.automation_email_attempt_reservations t))
$$;
DO $sender_status$
DECLARE v_mode TEXT; v_reason TEXT; v_before JSONB; v_status JSONB; r RECORD;
BEGIN
    PERFORM pg_temp.sender_check((SELECT provolatile='s' AND NOT prosecdef AND proconfig=ARRAY['search_path=""']
        FROM pg_proc WHERE oid='public.get_automation_sender_status_v1(text)'::REGPROCEDURE),'status STABLE invoker empty path');
    PERFORM pg_temp.sender_check(has_function_privilege('service_role','public.get_automation_sender_status_v1(text)','EXECUTE')
        AND NOT has_function_privilege('anon','public.get_automation_sender_status_v1(text)','EXECUTE')
        AND NOT has_function_privilege('authenticated','public.get_automation_sender_status_v1(text)','EXECUTE'),'status service-only ACL');
    PERFORM pg_temp.sender_reset();
    FOREACH v_mode IN ARRAY ARRAY['ready','cooldown','auth_blocked'] LOOP
        v_reason:=CASE WHEN v_mode<>'ready' THEN 'provider_unavailable' END;
        UPDATE private.automation_sender_gate SET mode=v_mode,reason=v_reason,
            next_probe_at=CASE WHEN v_mode='cooldown' THEN clock_timestamp()-INTERVAL '1 second' END;
        v_before:=pg_temp.sender_observed_rows();
        v_status:=public.get_automation_sender_status_v1('microsoft_graph:primary');
        PERFORM pg_temp.sender_check(v_status=jsonb_build_object('payload',jsonb_build_object('mode',v_mode,'reason',v_reason)),'exact status envelope');
        PERFORM pg_temp.sender_check(pg_temp.sender_observed_rows()=v_before,'status performs no row rewrite or expiry');
    END LOOP;
    v_before:=pg_temp.sender_observed_rows();
    PERFORM pg_temp.sender_reject($q$SELECT public.get_automation_sender_status_v1('other')$q$,'22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_reject($q$SELECT public.get_automation_sender_status_v1(NULL)$q$,'22023','AUTOMATION_INVALID_REQUEST');
    PERFORM pg_temp.sender_check(pg_temp.sender_observed_rows()=v_before,'wrong-key status performs no writes');
    BEGIN
        DELETE FROM private.automation_sender_gate;
        v_before:=pg_temp.sender_observed_rows();
        PERFORM pg_temp.sender_reject($q$SELECT public.get_automation_sender_status_v1('microsoft_graph:primary')$q$,'P0001','AUTOMATION_SENDER_UNAVAILABLE');
        PERFORM pg_temp.sender_check(pg_temp.sender_observed_rows()=v_before,'missing gate is never repaired by status');
        RAISE EXCEPTION 'rollback missing status fixture' USING ERRCODE='P9001';
    EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
    END;
    FOREACH v_reason IN ARRAY ARRAY['mode','reason'] LOOP
        BEGIN
            FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='private.automation_sender_gate'::REGCLASS AND contype='c' LOOP
                EXECUTE format('ALTER TABLE private.automation_sender_gate DROP CONSTRAINT %I',r.conname);
            END LOOP;
            IF v_reason='mode' THEN UPDATE private.automation_sender_gate SET mode='unknown';
            ELSE UPDATE private.automation_sender_gate SET reason='untrusted_provider_text'; END IF;
            v_before:=pg_temp.sender_observed_rows();
            PERFORM pg_temp.sender_reject($q$SELECT public.get_automation_sender_status_v1('microsoft_graph:primary')$q$,'P0001','AUTOMATION_SENDER_UNAVAILABLE');
            PERFORM pg_temp.sender_check(pg_temp.sender_observed_rows()=v_before,'corrupt gate is neither disclosed nor repaired');
            RAISE EXCEPTION 'rollback corrupt status fixture' USING ERRCODE='P9001';
        EXCEPTION WHEN SQLSTATE 'P9001' THEN NULL;
        END;
    END LOOP;
    PERFORM pg_temp.sender_reset();
END $sender_status$;
SET LOCAL ROLE anon;
SELECT pg_temp.sender_reject($q$SELECT public.get_automation_sender_status_v1('microsoft_graph:primary')$q$,'42501');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.sender_reject($q$SELECT public.get_automation_sender_status_v1('microsoft_graph:primary')$q$,'42501');
RESET ROLE;
-- END FOCUSED SENDER STATUS CONTRACT

SELECT 'sender admission contract passed' AS result;
ROLLBACK;
