-- Synthetic, transactional contract. Only disposable/local or guarded staging.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE FUNCTION pg_temp.assert_automation(ok BOOLEAN,message TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Automation contract: %',message; END IF; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.assert_automation(BOOLEAN,TEXT) TO service_role;
-- Test-only recovery exercises the accepted owners. Moving the synthetic probe
-- due time is scheduling, not resetting mode, generation, failure or attempts.
CREATE FUNCTION pg_temp.recover_legacy_sender(studio UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE prep JSONB; result JSONB; scope UUID:=gen_random_uuid(); attempt UUID:=gen_random_uuid(); owner UUID:=gen_random_uuid(); revision BIGINT;
BEGIN
    IF to_regclass('private.automation_sender_gate') IS NULL THEN RETURN; END IF;
    IF (SELECT mode='ready' FROM private.automation_sender_gate) THEN RETURN; END IF;
    INSERT INTO private.automation_email_credentials(provider_key,encrypted_credentials,revision)
        VALUES('microsoft_graph:primary','synthetic-local-only',1) ON CONFLICT DO NOTHING;
    SELECT c.revision INTO revision FROM private.automation_email_credentials c WHERE provider_key='microsoft_graph:primary';
    UPDATE private.automation_sender_gate SET next_probe_at=clock_timestamp() WHERE mode='cooldown';
    prep:=private.automation_sender_claim_v1(gen_random_uuid(),repeat('a',64),'synthetic_recovery',scope)->'payload';
    PERFORM pg_temp.assert_automation((prep->>'allowed')::BOOLEAN,'synthetic recovery preparation');
    result:=public.settle_automation_sender_preparation_v1((prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID,
        jsonb_build_object('outcome','prepared','credential_revision',revision,'sender_binding',repeat('a',64),
            'safe_reason',NULL,'retry_after_seconds',NULL));
    result:=private.automation_email_attempt_begin_v1(studio,'test',scope,NULL,attempt,owner,scope::TEXT||'@example.invalid',
        (prep->>'preparation_id')::UUID,(prep->>'preparation_token')::UUID,(prep->>'probe_token')::UUID);
    PERFORM pg_temp.assert_automation(result->>'outcome'='begun','synthetic recovery attempt');
    result:=private.automation_email_attempt_settle_v1(attempt,owner,jsonb_build_object('outcome','accepted','error_code',NULL,
        'provider_request_id',NULL,'retry_after_seconds',NULL,'submission_evidence','accepted','failure_scope',NULL,'credential_revision',revision));
    PERFORM pg_temp.assert_automation(result->>'state'='accepted' AND (SELECT mode='ready' FROM private.automation_sender_gate),'synthetic recovery confirmed');
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.recover_legacy_sender(UUID) TO service_role;

DO $contract$
#variable_conflict use_variable
DECLARE
    studio UUID:=gen_random_uuid(); other UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); outsider UUID:=gen_random_uuid();
    adult UUID:=gen_random_uuid(); minor UUID:=gen_random_uuid(); never UUID:=gen_random_uuid(); held UUID:=gen_random_uuid();
    inactive UUID:=gen_random_uuid(); recent UUID:=gen_random_uuid(); invalid UUID:=gen_random_uuid(); foreign_student UUID:=gen_random_uuid();
    guardian UUID:=gen_random_uuid(); guardian2 UUID:=gen_random_uuid(); foreign_guardian UUID:=gen_random_uuid();
    session_id UUID:=gen_random_uuid(); today DATE; j JSONB; k JSONB; delivery UUID; token UUID; optout TEXT; old_attempt TIMESTAMPTZ;
    failed BOOLEAN; c RECORD; n INTEGER; original TEXT;
BEGIN
    INSERT INTO auth.users(id,email) VALUES(actor,actor::text||'@example.invalid'),(outsider,outsider::text||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Automation fixture',studio::text,actor,'Pacific/Kiritimati'),(other,'Other studio',other::text,outsider,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin'),(other,outsider,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false),(other,'active',false);
    today:=public.student_business_date(studio);
    PERFORM pg_temp.assert_automation(today=(CURRENT_TIMESTAMP AT TIME ZONE 'Pacific/Kiritimati')::date,'studio business date');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email,is_minor,date_of_birth,status,hold_start_date,hold_end_date) VALUES
        (adult,studio,'Adult','Fixture','  ADULT@EXAMPLE.INVALID ',false,today-INTERVAL '20 years','active',NULL,NULL),
        (minor,studio,'Minor','Fixture','minor@example.invalid',true,NULL,'active',NULL,NULL),
        (never,studio,'Never','Fixture','never@example.invalid',false,NULL,'active',NULL,NULL),
        (held,studio,'Held','Fixture','held@example.invalid',false,NULL,'active',today,today),
        (inactive,studio,'Inactive','Fixture','inactive@example.invalid',false,NULL,'paused',NULL,NULL),
        (recent,studio,'Recent','Fixture','recent@example.invalid',false,NULL,'active',NULL,NULL),
        (invalid,studio,'Invalid','Fixture','invalid email',false,NULL,'active',NULL,NULL),
        (foreign_student,other,'Foreign','Fixture','foreign@example.invalid',false,NULL,'active',NULL,NULL);
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact) VALUES
        (guardian,studio,'Correct','Guardian','GUARDIAN@EXAMPLE.INVALID',true),
        (guardian2,studio,'Wrong','Invalid','invalid email',false),
        (foreign_guardian,other,'Foreign','Guardian','foreign.guardian@example.invalid',true);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(minor,guardian),(minor,guardian2);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES(session_id,studio,'Older class',today-14,'00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at)
        SELECT studio,session_id,id,'present',now()-INTERVAL '14 days' FROM public.students s WHERE s.studio_id=studio AND s.id<>never AND s.id<>recent;
    -- Avoid PL/pgSQL variable/column ambiguity in fixture queries below.
    INSERT INTO public.class_sessions(studio_id,name,date,start_time,end_time) VALUES(studio,'Recent class',today-13,'00:00','01:00') RETURNING id INTO delivery;
    INSERT INTO public.attendance(studio_id,session_id,student_id,status,checked_in_at) VALUES(studio,delivery,recent,'late',now()-INTERVAL '13 days');
    SET LOCAL ROLE service_role;
    j:=public.get_missed_class_automation_rule_v1(studio,actor);
    PERFORM pg_temp.assert_automation(j='{"rule":null}'::jsonb,'missing rule read is side effect free');
    PERFORM pg_temp.assert_automation(NOT EXISTS(SELECT 1 FROM public.automation_rules),'read created no default rule');
    failed:=false;
    BEGIN PERFORM public.get_missed_class_automation_rule_v1(studio,outsider);
    EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
    PERFORM pg_temp.assert_automation(failed,'foreign admin denied');
    j:=public.save_missed_class_automation_rule_v1(studio,actor,0,false,14,'Subject','Body','Reply@Example.Invalid');
    PERFORM pg_temp.assert_automation(j#>>'{rule,revision}'='1' AND j#>>'{rule,reply_to_email}'='reply@example.invalid','CAS initial rule');
    failed:=false;
    BEGIN PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Subject','Body','reply@example.invalid');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN failed:=(SQLERRM='AUTOMATION_RULE_CONFLICT'); END;
    PERFORM pg_temp.assert_automation(failed,'rule stale revision conflict');
    j:=public.preview_missed_class_automation_v1(studio,actor,14);
    PERFORM pg_temp.assert_automation((j->>'eligible_count')::int=2 AND (j->>'skipped_count')::int=5,'truthful eligibility counts');
    PERFORM pg_temp.assert_automation(EXISTS(SELECT 1 FROM jsonb_array_elements(j->'recipients') r WHERE r->>'student_id'=minor::text AND r->>'recipient_email'='guardian@example.invalid' AND r->>'recipient_kind'='guardian'),'retained explicit minor guardian route');
    PERFORM pg_temp.assert_automation((public.enqueue_missed_class_automations_v1(10)->>'enqueued')::int=0,'disabled rule enqueue');
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,1,true,14,'Subject','Body','reply@example.invalid');
    -- Invalid primary falls back to the only valid guardian and its matching name.
    UPDATE public.guardians SET is_primary_contact=(id=guardian2) WHERE id IN (guardian,guardian2);
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,minor);
    PERFORM pg_temp.assert_automation(c.recipient_name='Correct Guardian' AND c.recipient_email='guardian@example.invalid','valid guardian fallback name');
    UPDATE public.guardians SET is_primary_contact=true WHERE id IN (guardian,guardian2);
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,minor);
    PERFORM pg_temp.assert_automation(c.skip_reason='guardian_ambiguous','multiple primaries fail closed');
    UPDATE public.guardians SET is_primary_contact=false,email='second@example.invalid' WHERE id=guardian2;
    UPDATE public.guardians SET is_primary_contact=false WHERE id=guardian;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,minor);
    PERFORM pg_temp.assert_automation(c.skip_reason='guardian_ambiguous','ambiguous valid guardians fail closed');
    UPDATE public.guardians SET is_primary_contact=true WHERE id=guardian;
    -- Current effective holds are inclusive, future holds are not effective.
    UPDATE public.students SET hold_start_date=today+1,hold_end_date=NULL WHERE id=held;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,held);
    PERFORM pg_temp.assert_automation(c.skip_reason IS NULL,'future hold is not current');
    UPDATE public.students SET hold_start_date=today-1,hold_end_date=NULL WHERE id=held;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,held);
    PERFORM pg_temp.assert_automation(c.skip_reason='on_hold','indefinite current hold');
    -- Current Core snapshot matches application local predicate, including expired comped trials.
    UPDATE public.studio_subscriptions SET status='trialing',trial_end=now()-INTERVAL '1 second' WHERE studio_id=studio;
    PERFORM pg_temp.assert_automation(NOT private.automation_core_entitled(studio),'expired trial denies worker');
    UPDATE public.studio_subscriptions SET status='comped',trial_end=NULL WHERE studio_id=studio;
    PERFORM pg_temp.assert_automation(private.automation_core_entitled(studio),'comped status grants worker');
    UPDATE public.studio_subscriptions SET status='active' WHERE studio_id=studio;
    j:=public.enqueue_missed_class_automations_v1(10,ARRAY['adult@example.invalid']);
    PERFORM pg_temp.assert_automation((j->>'enqueued')::int=1 AND (j->>'has_more')::bool,'newly enqueued allowlisted work remains actionable');
    j:=public.enqueue_missed_class_automations_v1(10,ARRAY['adult@example.invalid']);
    PERFORM pg_temp.assert_automation((j->>'enqueued')::int=0 AND (j->>'has_more')::bool,'duplicate queue prevention retains fresh actionable flag');
    j:=public.claim_missed_class_automations_v1(1,ARRAY['adult@example.invalid']);
    delivery:=(j#>>'{items,0,id}')::uuid; token:=(j#>>'{items,0,claim_token}')::uuid;
    PERFORM pg_temp.assert_automation(delivery IS NOT NULL,'claim returns identity');
    PERFORM pg_temp.assert_automation((public.begin_missed_class_automation_v1(delivery,gen_random_uuid())->>'ready')::bool=false,'wrong claim begin rejected');
    -- Rule pause preserves unsent identity for a later scan.
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,2,false,14,'Changed','Changed body','reply@example.invalid');
    j:=public.begin_missed_class_automation_v1(delivery,token);
    PERFORM pg_temp.assert_automation(j->>'reason'='rule_paused' AND j->>'state'='queued','pause retains queue');
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,3,true,14,'Changed','Changed body','reply@example.invalid');
    UPDATE public.automation_deliveries SET next_attempt_at=now() WHERE id=delivery;
    UPDATE public.students SET email='new@example.invalid' WHERE id=adult;
    j:=public.claim_missed_class_automations_v1(1,ARRAY['new@example.invalid']);
    token:=(j#>>'{items,0,claim_token}')::uuid;
    PERFORM pg_temp.assert_automation(token IS NOT NULL,'claim filters current contact instead of stale snapshot');
    j:=public.begin_missed_class_automation_v1(delivery,token,ARRAY['adult@example.invalid']);
    PERFORM pg_temp.assert_automation(j->>'reason'='recipient_not_allowed' AND j->>'state'='queued','begin allowlist recheck');
    UPDATE public.automation_deliveries SET next_attempt_at=now() WHERE id=delivery;
    j:=public.claim_missed_class_automations_v1(1,ARRAY['new@example.invalid']);token:=(j#>>'{items,0,claim_token}')::uuid;
    j:=public.begin_missed_class_automation_v1(delivery,token,ARRAY['new@example.invalid']);
    PERFORM pg_temp.assert_automation((j->>'ready')::bool AND j#>>'{message,recipient_email}'='new@example.invalid' AND j#>>'{message,subject_template}'='Changed','begin refreshes never-attempted snapshots');
    optout:=j#>>'{message,unsubscribe_token}';
    PERFORM pg_temp.assert_automation(length(optout)=64,'32 byte opaque optout token');
    SELECT attempted_at INTO old_attempt FROM public.automation_deliveries WHERE id=delivery;
    PERFORM pg_temp.assert_automation((public.settle_missed_class_automation_v1(delivery,gen_random_uuid(),'accepted')->>'updated')::bool=false,'wrong settle token');
    j:=public.settle_missed_class_automation_v1(delivery,token,'retryable_failure','rate_limited',NULL,99999999);
    PERFORM pg_temp.assert_automation(j->>'state'='retry_wait','safe retryable outcome');
    PERFORM pg_temp.assert_automation((SELECT next_attempt_at<=clock_timestamp()+INTERVAL '1 day' FROM public.automation_deliveries WHERE id=delivery),'bounded retry-after');
    PERFORM pg_temp.assert_automation((public.claim_missed_class_automations_v1(10,ARRAY['new@example.invalid'])->>'has_more')::bool=false,'future retry is not has_more');
    FOR n IN 2..3 LOOP
        PERFORM pg_temp.recover_legacy_sender(studio);
        UPDATE public.automation_deliveries SET next_attempt_at=now() WHERE id=delivery;
        j:=public.claim_missed_class_automations_v1(1);token:=(j#>>'{items,0,claim_token}')::uuid;
        j:=public.begin_missed_class_automation_v1(delivery,token);
        PERFORM pg_temp.assert_automation((j->>'ready')::bool AND j#>>'{message,unsubscribe_token}'=optout,'retry preserves token identity');
        j:=public.settle_missed_class_automation_v1(delivery,token,'retryable_failure','rate_limited');
    END LOOP;
    PERFORM pg_temp.assert_automation(j->>'state'='failed' AND (SELECT attempted_at=old_attempt AND reason='retry_exhausted' AND attempts=3 FROM public.automation_deliveries WHERE id=delivery),'retry cap and immutable first attempt');
    PERFORM pg_temp.assert_automation((public.enqueue_missed_class_automations_v1(1,ARRAY['new@example.invalid'])->>'enqueued')::int=0,'exhausted attempt spends episode');
    UPDATE public.students SET email='changed.again@example.invalid' WHERE id=adult;
    PERFORM public.suppress_missed_class_automation_v1(optout);
    PERFORM pg_temp.assert_automation(EXISTS(SELECT 1 FROM public.automation_suppressions WHERE studio_id=studio AND recipient_email='new@example.invalid'),'optout immutable original recipient');
    PERFORM pg_temp.assert_automation(public.suppress_missed_class_automation_v1('invalid')='{"success":true}'::jsonb,'invalid optout generic response');
    j:=public.get_missed_class_automation_activity_v1(studio,actor,1);
    PERFORM pg_temp.assert_automation(NOT (j#>'{items,0}') ? 'unsubscribe_token' AND NOT (j#>'{items,0}') ? 'claim_token','activity secrets absent');
    -- Credentials use ciphertext CAS; these strings are deliberately synthetic.
    j:=public.get_automation_email_credential_v1('synthetic:contract');
    PERFORM pg_temp.assert_automation(j->>'revision'='0' AND j->'encrypted_credentials'='null'::jsonb,'missing credential revision0');
    j:=public.save_automation_email_credential_v1('synthetic:contract',0,'synthetic-ciphertext-1');
    PERFORM pg_temp.assert_automation(j->>'revision'='1','credential initial CAS');
    failed:=false;
    BEGIN PERFORM public.save_automation_email_credential_v1('synthetic:contract',0,'synthetic-ciphertext-stale');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN failed:=(SQLERRM='AUTOMATION_EMAIL_CREDENTIAL_CONFLICT'); END;
    PERFORM pg_temp.assert_automation(failed,'credential stale CAS');
    j:=public.save_automation_email_credential_v1('synthetic:contract',1,'synthetic-ciphertext-2');
    PERFORM pg_temp.assert_automation(j->>'revision'='2','credential rotation CAS');
    RESET ROLE;
    ALTER TABLE public.staff_roles DISABLE TRIGGER enforce_single_studio_membership;
    INSERT INTO public.staff_roles(studio_id,user_id,role,archived_at) VALUES(other,actor,'instructor',now());
    ALTER TABLE public.staff_roles ENABLE TRIGGER enforce_single_studio_membership;
    failed:=false;
    BEGIN PERFORM public.get_missed_class_automation_rule_v1(studio,actor);
    EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
    PERFORM pg_temp.assert_automation(failed,'historical ambiguous actor memberships deny access');
    DELETE FROM public.staff_roles WHERE studio_id=other AND user_id=actor;
    -- Legacy invalid DOBs remain possible. Disable only the validation trigger to
    -- seed them, then restore it before checking candidate behavior.
    ALTER TABLE public.students DISABLE TRIGGER validate_students_birth_date;
    UPDATE public.students SET date_of_birth='infinity' WHERE id=invalid;
    ALTER TABLE public.students ENABLE TRIGGER validate_students_birth_date;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,invalid);
    PERFORM pg_temp.assert_automation(c.skip_reason='invalid_birth_date','nonfinite legacy DOB skipped');
    ALTER TABLE public.students DISABLE TRIGGER validate_students_birth_date;
    UPDATE public.students SET date_of_birth=today+1 WHERE id=invalid;
    ALTER TABLE public.students ENABLE TRIGGER validate_students_birth_date;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,invalid);
    PERFORM pg_temp.assert_automation(c.skip_reason='invalid_birth_date','future legacy DOB skipped');
    -- Attempt timestamp and original address cannot be rewritten even by a
    -- direct service-role UPDATE after dispatch.
    failed:=false;
    BEGIN UPDATE public.automation_deliveries SET attempted_at=now()-INTERVAL '1 day' WHERE id=delivery;
    EXCEPTION WHEN check_violation THEN failed:=true; END;
    PERFORM pg_temp.assert_automation(failed,'first attempt immutable constraint');
    -- The public tables and every new RPC/helper deny direct client access.
    FOR c IN SELECT p.oid FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
        WHERE (ns.nspname='public' AND p.proname LIKE '%automation%v1')
        OR (ns.nspname='private' AND (p.proname LIKE 'automation_%' OR p.proname='missed_class_automation_candidates')) LOOP
        PERFORM pg_temp.assert_automation(NOT has_function_privilege('anon',c.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',c.oid,'EXECUTE'),'RPC/helper privilege revocation');
        PERFORM pg_temp.assert_automation((SELECT prosecdef=COALESCE(c.oid=to_regprocedure('private.automation_test_verified_email_v1(uuid)'),false)
            AND proconfig=ARRAY['search_path=""'] FROM pg_proc WHERE oid=c.oid),'exact invoker/verified-Auth authority and empty search path');
    END LOOP;
    FOREACH original IN ARRAY ARRAY['public.automation_rules','public.automation_deliveries','public.automation_suppressions','private.automation_email_credentials'] LOOP
        PERFORM pg_temp.assert_automation(NOT has_table_privilege('anon',original,'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('authenticated',original,'SELECT,INSERT,UPDATE,DELETE'),'table privilege revocation');
        PERFORM pg_temp.assert_automation((SELECT relrowsecurity FROM pg_class WHERE oid=original::regclass),'RLS enabled');
    END LOOP;
END $contract$;

-- Anonymous execution must fail with the intended permission error.
SET LOCAL ROLE anon;
DO $$ DECLARE denied BOOLEAN:=false; BEGIN
    BEGIN PERFORM public.get_automation_email_credential_v1('synthetic:contract');
    EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
    IF NOT denied THEN RAISE EXCEPTION 'Anonymous credential RPC was allowed'; END IF;
END $$;
RESET ROLE;
DO $parity$
DECLARE cases JSONB := $cases${"grammar": "conservative ASCII addr-spec, trim literal ASCII spaces then lowercase, root approved 2026-10-04", "accepted": [{"input": "Person+tag@EXAMPLE.COM", "normalized": "person+tag@example.com"}, {"input": "  person@example.com  ", "normalized": "person@example.com"}, {"input": "a!#$%&'*+/=?^_`{|}~-@example.com", "normalized": "a!#$%&'*+/=?^_`{|}~-@example.com"}, {"input": "a@b.c", "normalized": "a@b.c"}, {"input": "a@sub-domain.example.com", "normalized": "a@sub-domain.example.com"}, {"input": "a@xn--bcher-kva.example", "normalized": "a@xn--bcher-kva.example"}, {"input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com", "normalized": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com"}, {"input": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "normalized": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}], "rejected": ["", "person", "p@@example.com", ".p@example.com", "p.@example.com", "p..q@example.com", "p@example", "p@example.com.", "p@-example.com", "p@example-.com", "p@ex_ample.com", "p@example..com", "p q@example.com", "\"p\"@example.com", "p\t@example.com", "\tp@example.com", "p@example.com\n", "p\r\n@example.com", "p\u007f@example.com", "p\u00e9rson@example.com", "p@b\u00fccher.example", "\u00a0p@example.com", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@example.com", "p@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.com", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.ccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"]}$cases$::jsonb; c JSONB;
BEGIN
    FOR c IN SELECT * FROM jsonb_array_elements(cases->'accepted') LOOP
        PERFORM pg_temp.assert_automation(private.automation_normalize_email(c->>'input') IS NOT DISTINCT FROM c->>'normalized','accepted email parity');
    END LOOP;
    FOR c IN SELECT * FROM jsonb_array_elements(cases->'rejected') LOOP
        PERFORM pg_temp.assert_automation(private.automation_normalize_email(c#>>'{}') IS NULL,'rejected email parity');
    END LOOP;
END $parity$;
SET LOCAL statement_timeout='90s';
DO $episodes$
#variable_conflict use_variable
DECLARE
    studio UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); student UUID:=gen_random_uuid();
    old_session UUID:=gen_random_uuid(); next_session UUID:=gen_random_uuid(); old_attendance UUID:=gen_random_uuid();
    next_attendance UUID:=gen_random_uuid(); delivery UUID:=gen_random_uuid(); token UUID; c RECORD; j JSONB; today DATE;
BEGIN
    INSERT INTO auth.users(id,email) VALUES(actor,actor::text||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Episode fixture',studio::text,actor,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
    today:=public.student_business_date(studio);
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES(student,studio,'Episode','Fixture','episode@example.invalid');
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES
        (old_session,studio,'Old class',today-30,'00:00','01:00'),(next_session,studio,'Return class',today-25,'00:00','01:00');
    INSERT INTO public.attendance(id,studio_id,session_id,student_id,checked_in_at) VALUES(old_attendance,studio,old_session,student,now()-INTERVAL '30 days');
    -- Historical immutable attempt fixture. A return must be after this time.
    INSERT INTO public.automation_deliveries(id,studio_id,student_id,attendance_id,attendance_date,attendance_checked_in_at,attendance_occurred_at,
        student_name,student_first_name,studio_name,recipient_email,recipient_name,recipient_kind,subject_template,body_template,reply_to_email,
        rule_revision,days_absent,state,attempts,attempted_at,unsubscribe_token,original_recipient_email)
    SELECT delivery,studio,student,candidate.attendance_id,candidate.last_attendance_date,candidate.attendance_checked_in_at,candidate.attendance_occurred_at,
        candidate.student_name,candidate.student_first_name,candidate.studio_name,candidate.recipient_email,candidate.recipient_name,candidate.recipient_kind,'Old','Old','reply@example.invalid',
        1,10,'accepted',1,now()-INTERVAL '20 days',encode(extensions.gen_random_bytes(32),'hex'),candidate.recipient_email
        FROM private.missed_class_automation_candidates(studio,14,student) candidate;
    IF to_regclass('private.automation_email_attempt_reservations') IS NOT NULL THEN
        -- This episode-only fixture models a cutover two hours earlier with no
        -- settlement clock. The separate cutover suite tests today's fallback.
        INSERT INTO private.automation_email_attempt_reservations(id,studio_id,provider_key,scope_kind,scope_id,recipient_email,
            origin,protocol,state,frequency_state,conservative_anchor_at,observed_legacy_ordinal,legacy_projection)
            VALUES(gen_random_uuid(),studio,'microsoft_graph:primary','legacy',delivery,'episode@example.invalid',
                'cutover_fallback','historical','accepted','accepted',clock_timestamp()-INTERVAL '2 hours',1,
                jsonb_build_object('state','accepted','reason',NULL));
        PERFORM private.automation_bind_unsubscribe_token_v1(studio,d.unsubscribe_token,d.original_recipient_email)
            FROM public.automation_deliveries d WHERE d.id=delivery;
    END IF;

    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','same attendance cannot repeat');
    UPDATE public.class_sessions SET date=today-15 WHERE id=old_session;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','date-only old attendance edit cannot reset');
    UPDATE public.attendance SET checked_in_at=now() WHERE id=old_attendance;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','combined historical date and checkin edit cannot reuse attempted attendance identity');
    UPDATE public.class_sessions SET date=today-30 WHERE id=old_session;
    UPDATE public.attendance SET checked_in_at=now() WHERE id=old_attendance;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','same-day old-row edit cannot reset');
    INSERT INTO public.attendance(id,studio_id,session_id,student_id,checked_in_at) VALUES(next_attendance,studio,next_session,student,now());
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','late historical check-in cannot reset');
    UPDATE public.class_sessions SET date=today-15 WHERE id=next_session;
    UPDATE public.attendance SET checked_in_at=now()-INTERVAL '25 days' WHERE id=next_attendance;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','new occurrence with old ingestion cannot reset');
    UPDATE public.attendance SET checked_in_at=now()-INTERVAL '15 days' WHERE id=next_attendance;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason IS NULL,'strict newer return after attempted time resets');
    UPDATE public.class_sessions SET deleted_at=now() WHERE id=next_session;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','deleted latest attendance cannot reopen older episode');
    UPDATE public.class_sessions SET deleted_at=NULL,date=today-31 WHERE id=next_session;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','backward correction cannot reopen');
    UPDATE public.class_sessions SET date=today-15 WHERE id=next_session;
    UPDATE public.attendance SET checked_in_at=now()+INTERVAL '1 day' WHERE id=next_attendance;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','future checkin is not valid return evidence');
    UPDATE public.attendance SET checked_in_at=now()-INTERVAL '15 days',status='excused' WHERE id=next_attendance;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','excused attendance is not valid return');
    UPDATE public.attendance SET status='present' WHERE id=next_attendance;
    UPDATE public.class_sessions SET status='canceled' WHERE id=next_session;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='episode_already_attempted','canceled class is not return evidence');
    UPDATE public.class_sessions SET status='completed' WHERE id=next_session;
    SET LOCAL ROLE service_role;
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'New','New','reply@example.invalid');
    j:=public.enqueue_missed_class_automations_v1(10,ARRAY['episode@example.invalid']);
    PERFORM pg_temp.assert_automation((j->>'enqueued')::int=1,'new return creates exactly one new episode');
    j:=public.claim_missed_class_automations_v1(1,ARRAY['episode@example.invalid']);
    delivery:=(j#>>'{items,0,id}')::uuid;token:=(j#>>'{items,0,claim_token}')::uuid;
    -- An expired claimed lease is safe to reclaim with a different token.
    UPDATE public.automation_deliveries SET lease_expires_at=now()-INTERVAL '1 second' WHERE id=delivery;
    j:=public.claim_missed_class_automations_v1(1,ARRAY['episode@example.invalid']);
    PERFORM pg_temp.assert_automation((j#>>'{items,0,claim_token}')::uuid<>token,'expired claimed token replaced');
    PERFORM pg_temp.assert_automation((public.begin_missed_class_automation_v1(delivery,token)->>'ready')::bool=false,'stale claim cannot begin');
    token:=(j#>>'{items,0,claim_token}')::uuid;
    PERFORM pg_temp.recover_legacy_sender(studio);
    j:=public.begin_missed_class_automation_v1(delivery,token);
    PERFORM pg_temp.assert_automation((j->>'ready')::bool,'new episode began');
    IF to_regclass('private.automation_email_attempt_reservations') IS NOT NULL THEN
        -- Wait for the original actual send lease. Never shorten common truth.
        PERFORM pg_sleep(greatest(0,extract(epoch FROM d.lease_expires_at-clock_timestamp()))+0.05)
            FROM public.automation_deliveries d WHERE d.id=delivery;
    ELSE
        UPDATE public.automation_deliveries SET lease_expires_at=now()-INTERVAL '1 second' WHERE id=delivery;
    END IF;
    j:=public.claim_missed_class_automations_v1(1,ARRAY['episode@example.invalid']);
    PERFORM pg_temp.assert_automation(jsonb_array_length(j->'items')=0 AND (SELECT state='unknown' FROM public.automation_deliveries WHERE id=delivery),'expired sending becomes unknown never reclaimed');
    PERFORM pg_temp.assert_automation((public.settle_missed_class_automation_v1(delivery,token,'accepted')->>'updated')::bool=false,'expired sending settle rejected');
    PERFORM pg_temp.assert_automation((public.enqueue_missed_class_automations_v1(1,ARRAY['episode@example.invalid'])->>'enqueued')::int=0,'unknown episode never automatically resends');
    RESET ROLE;
END $episodes$;
SET LOCAL statement_timeout='60s';

DO $bounds$
#variable_conflict use_variable
DECLARE studio UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); session_id UUID:=gen_random_uuid(); student UUID;
    j JSONB; c RECORD; i INTEGER; token UUID; delivery UUID; other UUID:=gen_random_uuid();
BEGIN
    INSERT INTO auth.users(id,email) VALUES(actor,actor::text||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Bounds fixture',studio::text,actor),(other,'Foreign fixture',other::text,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES(session_id,studio,'Old class',current_date-20,'00:00','01:00');
    FOR i IN 1..105 LOOP
        INSERT INTO public.students(studio_id,legal_first_name,legal_last_name,email) VALUES(studio,'Bound',lpad(i::text,3,'0'),i::text||'@example.invalid') RETURNING id INTO student;
        INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES(studio,session_id,student,now()-INTERVAL '20 days');
    END LOOP;
    j:=public.preview_missed_class_automation_v1(studio,actor,14);
    PERFORM pg_temp.assert_automation((j->>'eligible_count')::int=105 AND (j->>'skipped_count')::int=0 AND jsonb_array_length(j->'recipients')=100 AND (j->>'truncated')::bool,'preview capped with truthful totals');
    PERFORM public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Bound','Bound','reply@example.invalid');
    -- Seed more than a batch of disallowed queue entries before the allowed one.
    PERFORM public.enqueue_missed_class_automations_v1(10);PERFORM public.enqueue_missed_class_automations_v1(10);
    j:=public.enqueue_missed_class_automations_v1(1,ARRAY['105@example.invalid']);
    j:=public.claim_missed_class_automations_v1(1,ARRAY['105@example.invalid']);
    delivery:=(j#>>'{items,0,id}')::uuid;token:=(j#>>'{items,0,claim_token}')::uuid;
    PERFORM pg_temp.assert_automation(delivery IS NOT NULL,'allowed queue entry is not starved by first batch');
    PERFORM pg_temp.recover_legacy_sender(studio);
    j:=public.begin_missed_class_automation_v1(delivery,token,ARRAY['105@example.invalid']);
    PERFORM pg_temp.assert_automation(j#>>'{message,recipient_email}'='105@example.invalid','allowlisted dispatch uses genuine content');
    PERFORM public.settle_missed_class_automation_v1(delivery,token,'accepted');
    PERFORM pg_temp.assert_automation(EXISTS(SELECT 1 FROM public.automation_deliveries WHERE studio_id=studio AND state='queued' AND attempted_at IS NULL),'disallowed rows remain unsent recoverable');
    -- Corrupt synthetic legacy tenant links must not cross the eligibility join.
    SET LOCAL session_replication_role=replica;
    UPDATE public.class_sessions SET studio_id=other WHERE id=session_id;
    SET LOCAL session_replication_role=origin;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='never_attended','foreign session cannot supply attendance');
    UPDATE public.class_sessions SET studio_id=studio WHERE id=session_id;
    UPDATE public.students SET is_minor=true WHERE id=student;
    INSERT INTO public.guardians(studio_id,first_name,last_name,email,is_primary_contact) VALUES(other,'Foreign','Guardian','foreign@example.invalid',true) RETURNING id INTO delivery;
    SET LOCAL session_replication_role=replica;
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(student,delivery);
    SET LOCAL session_replication_role=origin;
    SELECT * INTO c FROM private.missed_class_automation_candidates(studio,14,student);
    PERFORM pg_temp.assert_automation(c.skip_reason='guardian_missing','foreign guardian cannot route');
END $bounds$;
DO $fairness$
DECLARE owner_id UUID:=gen_random_uuid(); studio UUID; student UUID:=gen_random_uuid(); session_id UUID:=gen_random_uuid();
    prefix TEXT:=left(gen_random_uuid()::text,24); i INTEGER; j JSONB;
BEGIN
    UPDATE public.automation_rules SET enabled=false;
    INSERT INTO auth.users(id,email) VALUES(owner_id,owner_id::text||'@example.invalid');
    FOR i IN 1..12 LOOP
        studio:=(prefix||lpad(i::text,12,'0'))::uuid;
        INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Fair rotation',studio::text,owner_id,'UTC');
        INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
        INSERT INTO public.automation_rules(studio_id,enabled,inactivity_days,subject_template,body_template,reply_to_email,revision)
            VALUES(studio,true,14,'Subject','Body','reply@example.invalid',1);
    END LOOP;
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email) VALUES(student,studio,'Last','Studio','last@example.invalid');
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES(session_id,studio,'Old class',current_date-20,'00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES(studio,session_id,student,now()-INTERVAL '20 days');
    j:=public.enqueue_missed_class_automations_v1(1);
    PERFORM pg_temp.assert_automation((j->>'enqueued')::int=0 AND (j->>'has_more')::bool,'unvisited eligible studio still has_more');
    j:=public.enqueue_missed_class_automations_v1(1);
    PERFORM pg_temp.assert_automation((j->>'enqueued')::int=1 AND (j->>'has_more')::bool,'rotation reaches studio beyond first ten and exposes queued work');
END $fairness$;
-- Explicit internal clock references exercise rollover without changing the
-- server clock, transaction clock, historical date helper or public RPCs.
DO $rollover$
DECLARE studio UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); student UUID:=gen_random_uuid();
    guardian UUID:=gen_random_uuid(); old_session UUID:=gen_random_uuid(); new_session UUID:=gen_random_uuid();
    before_midnight TIMESTAMPTZ:='2020-01-15 07:59:59+00'; after_midnight TIMESTAMPTZ:='2020-01-15 08:00:01+00';
    before_row RECORD; after_row RECORD; j JSONB;
BEGIN
    INSERT INTO auth.users(id,email) VALUES(actor,actor::text||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Rollover fixture',studio::text,actor,'America/Los_Angeles');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,email,date_of_birth,hold_start_date)
        VALUES(student,studio,'Birthday','Fixture','adult@example.invalid','2002-01-15','2020-01-15');
    INSERT INTO public.guardians(id,studio_id,first_name,last_name,email,is_primary_contact)
        VALUES(guardian,studio,'Before','Birthday','guardian@example.invalid',true);
    INSERT INTO public.student_guardians(student_id,guardian_id) VALUES(student,guardian);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time)
        VALUES(old_session,studio,'Previous class','2019-12-31','00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at)
        VALUES(studio,old_session,student,'2019-12-31 08:00:00+00');
    SELECT * INTO before_row FROM private.missed_class_automation_candidates(studio,14,student,NULL,before_midnight);
    SELECT * INTO after_row FROM private.missed_class_automation_candidates(studio,14,student,NULL,after_midnight);
    PERFORM pg_temp.assert_automation(before_row.reference_date='2020-01-14' AND before_row.days_absent=14
        AND before_row.recipient_email='guardian@example.invalid' AND before_row.recipient_kind='guardian'
        AND before_row.skip_reason IS NULL,'one reference before midnight governs age gap and future hold');
    PERFORM pg_temp.assert_automation(after_row.reference_date='2020-01-15' AND after_row.days_absent=15
        AND after_row.recipient_email='adult@example.invalid' AND after_row.recipient_kind='student'
        AND after_row.skip_reason='on_hold','one reference after midnight activates hold and eighteenth birthday');
    UPDATE public.students SET hold_start_date=NULL WHERE id=student;
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time)
        VALUES(new_session,studio,'Midnight class','2020-01-15','00:00','01:00');
    INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at)
        VALUES(studio,new_session,student,'2020-01-15 08:00:00+00');
    SELECT * INTO before_row FROM private.missed_class_automation_candidates(studio,14,student,NULL,before_midnight);
    SELECT * INTO after_row FROM private.missed_class_automation_candidates(studio,14,student,NULL,after_midnight);
    PERFORM pg_temp.assert_automation(before_row.last_attendance_date='2019-12-31' AND before_row.days_absent=14,
        'future occurrence and checkin excluded at explicit reference');
    PERFORM pg_temp.assert_automation(after_row.last_attendance_date='2020-01-15' AND after_row.days_absent=0
        AND after_row.skip_reason='recent_attendance','new occurrence and checkin included at same explicit reference');
    UPDATE public.attendance SET checked_in_at='2020-01-15 08:00:02+00' WHERE session_id=new_session;
    SELECT * INTO after_row FROM private.missed_class_automation_candidates(studio,14,student,NULL,after_midnight);
    PERFORM pg_temp.assert_automation(after_row.last_attendance_date='2019-12-31','checkin after captured reference remains future');
    PERFORM pg_temp.assert_automation(NOT EXISTS(SELECT 1 FROM private.missed_class_automation_candidates(studio,14,student,NULL,NULL))
        AND NOT EXISTS(SELECT 1 FROM private.missed_class_automation_candidates(studio,14,student,NULL,'infinity')),
        'null and nonfinite internal reference fail closed');
    -- Even an empty preview gets a wall-clock date without the legacy helper.
    DELETE FROM public.attendance WHERE student_id=student;
    DELETE FROM public.students WHERE id=student;
    j:=public.preview_missed_class_automation_v1(studio,actor,14);
    PERFORM pg_temp.assert_automation(j->>'reference_date'=(clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date::text
        AND j->'recipients'='[]'::jsonb,'empty preview has current reference date');
END $rollover$;
DO $dispatch_deferral$
#variable_conflict use_variable
DECLARE studio UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid(); session_id UUID:=gen_random_uuid();
    student UUID; j JSONB; rule_before JSONB; row_before JSONB; row_after JSONB; first_id UUID; second_id UUID;
    first_token UUID; second_token UUID; until_at TIMESTAMPTZ; before_until TIMESTAMPTZ; n INTEGER; failed BOOLEAN;
    recipient TEXT; outcome TEXT;
BEGIN
    UPDATE public.automation_rules SET enabled=false;
    INSERT INTO auth.users(id,email) VALUES(actor,actor::text||'@example.invalid');
    INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Deferral fixture',studio::text,actor,'UTC');
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
    INSERT INTO public.class_sessions(id,studio_id,name,date,start_time,end_time) VALUES(session_id,studio,'Old class',current_date-20,'00:00','01:00');
    FOR n IN 1..3 LOOP
        INSERT INTO public.students(studio_id,legal_first_name,legal_last_name,email)
            VALUES(studio,'Deferral',n::text,'defer'||n||'@example.invalid') RETURNING id INTO student;
        INSERT INTO public.attendance(studio_id,session_id,student_id,checked_in_at) VALUES(studio,session_id,student,now()-INTERVAL '20 days');
    END LOOP;
    SET LOCAL ROLE service_role;
    PERFORM pg_temp.recover_legacy_sender(studio);
    rule_before:=public.save_missed_class_automation_rule_v1(studio,actor,0,true,14,'Subject','Body','reply@example.invalid');
    PERFORM public.enqueue_missed_class_automations_v1(10);
    j:=public.claim_missed_class_automations_v1(2);
    first_id:=(j#>>'{items,0,id}')::uuid;first_token:=(j#>>'{items,0,claim_token}')::uuid;
    second_id:=(j#>>'{items,1,id}')::uuid;second_token:=(j#>>'{items,1,claim_token}')::uuid;
    PERFORM pg_temp.assert_automation(first_id IS NOT NULL AND second_id IS NOT NULL,'one studio can fill a bounded claim batch');
    PERFORM pg_temp.assert_automation((public.defer_missed_class_automation_studio_v1(first_id,NULL,'unavailable')->>'updated')::bool=false
        AND (public.defer_missed_class_automation_studio_v1(first_id,gen_random_uuid(),'unavailable')->>'updated')::bool=false,
        'null and wrong deferral tokens rejected');
    failed:=false;
    BEGIN PERFORM public.defer_missed_class_automation_studio_v1(first_id,first_token,'provider_error_text');
    EXCEPTION WHEN invalid_parameter_value THEN failed:=true; END;
    PERFORM pg_temp.assert_automation(failed,'deferral reason allowlist');
    UPDATE public.automation_deliveries SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=first_id;
    PERFORM pg_temp.assert_automation((public.defer_missed_class_automation_studio_v1(first_id,first_token,'unavailable')->>'updated')::bool=false,
        'expired claim cannot defer studio');
    UPDATE public.automation_deliveries SET lease_expires_at=clock_timestamp()+INTERVAL '60 seconds' WHERE id=first_id;
    PERFORM pg_temp.assert_automation((SELECT dispatch_deferred_until IS NULL FROM public.automation_rules WHERE studio_id=studio),
        'invalid tokens never mutate studio cooldown');
    j:=public.defer_missed_class_automation_studio_v1(first_id,first_token,'unavailable');until_at:=(j->>'dispatch_deferred_until')::timestamptz;
    PERFORM pg_temp.assert_automation((j->>'updated')::bool AND j->>'state'='queued' AND until_at>=clock_timestamp()+INTERVAL '59 minutes',
        'live unstarted claim atomically releases with one hour cooldown');
    PERFORM pg_temp.assert_automation(NOT (j->>'has_more')::bool,'only just-deferred studio is not actionable');
    PERFORM pg_temp.assert_automation((SELECT attempts=0 AND attempted_at IS NULL AND claim_token IS NULL AND next_attempt_at>=until_at
        FROM public.automation_deliveries WHERE id=first_id),'fresh deferral spends no attempt');
    PERFORM pg_temp.assert_automation(public.get_missed_class_automation_rule_v1(studio,actor)=rule_before,
        'dispatch scheduling does not change public rule revision updated_at or fields');
    PERFORM pg_temp.assert_automation(NOT (rule_before->'rule') ? 'last_dispatch_claim_at' AND NOT (rule_before->'rule') ? 'dispatch_deferred_until',
        'internal scheduling fields absent from save and get rule JSON');
    j:=public.enqueue_missed_class_automations_v1(10);
    PERFORM pg_temp.assert_automation(j='{"enqueued":0,"has_more":false}'::jsonb,'enqueue and has_more honor studio cooldown');
    j:=public.claim_missed_class_automations_v1(10);
    PERFORM pg_temp.assert_automation(j='{"items":[],"has_more":false}'::jsonb,'claim and has_more honor studio cooldown');
    j:=public.begin_missed_class_automation_v1(second_id,second_token);
    PERFORM pg_temp.assert_automation(NOT (j->>'ready')::bool AND j->>'state'='queued'
        AND (SELECT attempts=0 AND attempted_at IS NULL FROM public.automation_deliveries WHERE id=second_id),'begin honors a cooldown set after its claim');
    PERFORM pg_temp.assert_automation((public.defer_missed_class_automation_studio_v1(first_id,first_token,'subscription_required')->>'updated')::bool=false
        AND (SELECT dispatch_deferred_until=until_at FROM public.automation_rules WHERE studio_id=studio),'stale token cannot extend cooldown');
    -- Advance only synthetic scheduling timestamps to model cooldown expiry.
    UPDATE public.automation_rules SET dispatch_deferred_until=clock_timestamp()-INTERVAL '1 second' WHERE studio_id=studio;
    UPDATE public.automation_deliveries SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE studio_id=studio;
    SELECT recipient_email INTO recipient FROM public.automation_deliveries WHERE id=first_id;
    j:=public.claim_missed_class_automations_v1(1,ARRAY[recipient]);first_token:=(j#>>'{items,0,claim_token}')::uuid;
    PERFORM pg_temp.assert_automation((j#>>'{items,0,id}')::uuid=first_id,'cooled work becomes eligible again with same identity');
    j:=public.begin_missed_class_automation_v1(first_id,first_token);
    PERFORM pg_temp.assert_automation((j->>'ready')::bool,'expired cooldown permits dispatch');
    SELECT dispatch_deferred_until INTO before_until FROM public.automation_rules WHERE studio_id=studio;
    PERFORM pg_temp.assert_automation((public.defer_missed_class_automation_studio_v1(first_id,first_token,'unavailable')->>'updated')::bool=false
        AND (SELECT state='sending' FROM public.automation_deliveries WHERE id=first_id)
        AND (SELECT dispatch_deferred_until=before_until FROM public.automation_rules WHERE studio_id=studio),'sending deferral refused without cooldown mutation');
    PERFORM public.settle_missed_class_automation_v1(first_id,first_token,'retryable_failure','rate_limited');
    UPDATE public.automation_deliveries SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE id=first_id;
    j:=public.claim_missed_class_automations_v1(1,ARRAY[recipient]);first_token:=(j#>>'{items,0,claim_token}')::uuid;
    SELECT to_jsonb(d)-ARRAY['state','reason','claim_token','lease_expires_at','next_attempt_at','updated_at'] INTO row_before
        FROM public.automation_deliveries d WHERE id=first_id;
    until_at:=clock_timestamp()+INTERVAL '2 hours';
    UPDATE public.automation_deliveries SET next_attempt_at=until_at WHERE id=first_id;
    j:=public.defer_missed_class_automation_studio_v1(first_id,first_token,'subscription_required');
    SELECT to_jsonb(d)-ARRAY['state','reason','claim_token','lease_expires_at','next_attempt_at','updated_at'] INTO row_after
        FROM public.automation_deliveries d WHERE id=first_id;
    PERFORM pg_temp.assert_automation((j->>'updated')::bool AND j->>'state'='retry_wait' AND row_before=row_after
        AND (row_after->>'attempts')::int=1 AND row_after->>'attempted_at' IS NOT NULL
        AND (SELECT next_attempt_at>=until_at FROM public.automation_deliveries WHERE id=first_id),
        'claimed safe retry retains every immutable fact and retry eligibility');
    -- Each terminal result also refuses the deferral RPC without rewriting state.
    FOREACH outcome IN ARRAY ARRAY['accepted','unknown','permanent_failure'] LOOP
        PERFORM pg_temp.recover_legacy_sender(studio);
        UPDATE public.automation_rules SET dispatch_deferred_until=NULL WHERE studio_id=studio;
        UPDATE public.automation_deliveries SET next_attempt_at=clock_timestamp()-INTERVAL '1 second' WHERE studio_id=studio;
        j:=public.claim_missed_class_automations_v1(1);
        first_id:=(j#>>'{items,0,id}')::uuid;first_token:=(j#>>'{items,0,claim_token}')::uuid;
        j:=public.begin_missed_class_automation_v1(first_id,first_token);
        PERFORM pg_temp.assert_automation((j->>'ready')::bool,'terminal refusal fixture ready');
        PERFORM public.settle_missed_class_automation_v1(first_id,first_token,outcome);
        SELECT to_jsonb(d) INTO row_before FROM public.automation_deliveries d WHERE id=first_id;
        PERFORM pg_temp.assert_automation((public.defer_missed_class_automation_studio_v1(first_id,first_token,'unavailable')->>'updated')::bool=false
            AND (SELECT to_jsonb(d)=row_before FROM public.automation_deliveries d WHERE id=first_id),'terminal deferral refuses all mutation');
    END LOOP;
    RESET ROLE;
END $dispatch_deferral$;
ROLLBACK;
