BEGIN;

DO $$
DECLARE
    v_signature TEXT;
    v_function REGPROCEDURE;
    v_config TEXT[];
    v_is_definer BOOLEAN;
    v_role TEXT;
    v_functions TEXT[] := ARRAY[
        'public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)',
        'public.finish_stripe_event_processing(uuid,text,text,text)',
        'public.claim_due_account_deletion_requests(integer,text,integer)',
        'public.finish_account_deletion_request(uuid,text,text,text)',
        'public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)',
        'public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)',
        'public.heartbeat_student_import_run(uuid,text)',
        'public.finish_student_import_run(uuid,text,text,jsonb,text)'
    ];
BEGIN
    FOREACH v_signature IN ARRAY v_functions
    LOOP
        v_function := to_regprocedure(v_signature);
        IF v_function IS NULL THEN
            RAISE EXCEPTION 'Missing worker claim RPC %.', v_signature;
        END IF;

        SELECT proc.proconfig, proc.prosecdef
          INTO v_config, v_is_definer
          FROM pg_proc proc
         WHERE proc.oid = v_function::OID;

        IF v_is_definer THEN
            RAISE EXCEPTION 'Worker claim RPC % must be SECURITY INVOKER.', v_signature;
        END IF;

        IF v_config IS DISTINCT FROM ARRAY[CASE WHEN v_signature LIKE 'public.claim_student_import_run_v2(%'
                THEN 'search_path=pg_catalog' ELSE 'search_path=public, pg_temp' END]::TEXT[] THEN
            RAISE EXCEPTION 'Worker claim RPC % has an unexpected search_path.', v_signature;
        END IF;

        FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
        LOOP
            IF has_function_privilege(v_role, v_function, 'EXECUTE') THEN
                RAISE EXCEPTION '% still has EXECUTE on worker claim RPC %.', v_role, v_signature;
            END IF;
        END LOOP;

        IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
            RAISE EXCEPTION 'service_role must have EXECUTE on worker claim RPC %.', v_signature;
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    v_account_claim_count INTEGER;
    v_claim_status TEXT;
    v_event_key TEXT := 'koaryu-worker-smoke-' || gen_random_uuid()::TEXT;
    v_event_row JSONB;
    v_fresh_request_id UUID;
    v_request_id UUID;
    v_stale_request_id UUID;
    v_updated BOOLEAN;
BEGIN
    BEGIN
        PERFORM *
          FROM public.claim_stripe_event_for_processing(
              v_event_key,
              NULL,
              false,
              'worker.smoke',
              '{}'::JSONB,
              NULL,
              600
          );
        RAISE EXCEPTION 'Expected null Stripe claim token to be rejected.';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    BEGIN
        PERFORM *
          FROM public.claim_due_account_deletion_requests(1, '', 1800);
        RAISE EXCEPTION 'Expected blank account deletion claim token to be rejected.';
    EXCEPTION WHEN invalid_parameter_value THEN
        NULL;
    END;

    SELECT claim_status, event_row
      INTO v_claim_status, v_event_row
      FROM public.claim_stripe_event_for_processing(
          v_event_key,
          NULL,
          false,
          'worker.smoke',
          '{"ok":true}'::JSONB,
          'stripe-token-1',
          600
      );

    IF v_claim_status <> 'claimed' THEN
        RAISE EXCEPTION 'Expected first Stripe event claim, got %.', v_claim_status;
    END IF;

    SELECT claim_status
      INTO v_claim_status
      FROM public.claim_stripe_event_for_processing(
          v_event_key,
          NULL,
          false,
          'worker.smoke',
          '{"ok":true}'::JSONB,
          'stripe-token-2',
          600
      );

    IF v_claim_status <> 'already_processing' THEN
        RAISE EXCEPTION 'Expected fresh duplicate Stripe claim to stay processing, got %.', v_claim_status;
    END IF;

    SELECT updated
      INTO v_updated
      FROM public.finish_stripe_event_processing(
          (v_event_row->>'id')::UUID,
          'wrong-token',
          'processed',
          NULL
      );

    IF v_updated THEN
        RAISE EXCEPTION 'Wrong Stripe token must not finish event.';
    END IF;

    SELECT updated
      INTO v_updated
      FROM public.finish_stripe_event_processing(
          (v_event_row->>'id')::UUID,
          'stripe-token-1',
          'processed',
          NULL
      );

    IF NOT v_updated THEN
        RAISE EXCEPTION 'Correct Stripe token should finish event.';
    END IF;

    SELECT claim_status
      INTO v_claim_status
      FROM public.claim_stripe_event_for_processing(
          v_event_key,
          NULL,
          false,
          'worker.smoke',
          '{"ok":true}'::JSONB,
          'stripe-token-3',
          600
      );

    IF v_claim_status <> 'already_processed' THEN
        RAISE EXCEPTION 'Processed Stripe event should not be reclaimed, got %.', v_claim_status;
    END IF;

    INSERT INTO public.account_deletion_requests (
        requester_email,
        status,
        requested_at,
        scheduled_for
    )
    VALUES (
        'worker-smoke@example.invalid',
        'scheduled',
        '-infinity'::TIMESTAMPTZ,
        '-infinity'::TIMESTAMPTZ
    )
    RETURNING id INTO v_request_id;

    INSERT INTO public.account_deletion_requests (
        requester_email,
        status,
        requested_at,
        scheduled_for,
        processing_token,
        processing_started_at
    )
    VALUES (
        'worker-smoke-fresh@example.invalid',
        'scheduled',
        '-infinity'::TIMESTAMPTZ,
        '-infinity'::TIMESTAMPTZ,
        'fresh-token',
        now()
    )
    RETURNING id INTO v_fresh_request_id;

    INSERT INTO public.account_deletion_requests (
        requester_email,
        status,
        requested_at,
        scheduled_for,
        processing_token,
        processing_started_at
    )
    VALUES (
        'worker-smoke-stale@example.invalid',
        'scheduled',
        '-infinity'::TIMESTAMPTZ,
        '-infinity'::TIMESTAMPTZ,
        'stale-token',
        now() - INTERVAL '31 minutes'
    )
    RETURNING id INTO v_stale_request_id;

    SELECT count(*)
      INTO v_account_claim_count
      FROM public.claim_due_account_deletion_requests(2, 'account-token-1', 1800)
     WHERE id IN (v_request_id, v_stale_request_id);

    IF v_account_claim_count <> 2 THEN
        RAISE EXCEPTION 'Expected exactly unclaimed and stale account deletion rows to be claimed, got %.', v_account_claim_count;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.account_deletion_requests
         WHERE id = v_fresh_request_id
           AND processing_token IS DISTINCT FROM 'fresh-token'
    ) THEN
        RAISE EXCEPTION 'Fresh account deletion claim must not be stolen.';
    END IF;

    SELECT count(*)
      INTO v_account_claim_count
      FROM public.account_deletion_requests
     WHERE id IN (v_request_id, v_stale_request_id)
       AND processing_token = 'account-token-1';

    IF v_account_claim_count <> 2 THEN
        RAISE EXCEPTION 'Expected account deletion claims to carry the new token.';
    END IF;

    SELECT updated
      INTO v_updated
      FROM public.finish_account_deletion_request(v_request_id, 'wrong-token', 'completed', NULL);

    IF v_updated THEN
        RAISE EXCEPTION 'Wrong account deletion token must not finish request.';
    END IF;

    SELECT updated
      INTO v_updated
      FROM public.finish_account_deletion_request(v_request_id, 'account-token-1', 'completed', NULL);

    IF NOT v_updated THEN
        RAISE EXCEPTION 'Correct account deletion token should finish request.';
    END IF;

    RAISE NOTICE 'Stripe and account-deletion worker contracts passed.';
END $$;

CREATE FUNCTION pg_temp.fail_import_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.action = 'students.imported' AND current_setting('koaryu.test_import_audit', TRUE) = 'fail' THEN
        RAISE EXCEPTION 'Synthetic audit failure' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER test_import_audit BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_import_audit();

DO $$
DECLARE
    studio UUID := gen_random_uuid(); actor UUID := gen_random_uuid(); run_id UUID; legacy_id UUID;
    candidate RECORD; finished RECORD; saved JSONB; original JSONB;
    program_id UUID := gen_random_uuid(); ladder_id UUID := gen_random_uuid(); rank_id UUID := gen_random_uuid();
    program_result JSONB; belt_result JSONB; ranks JSONB;
    result JSONB := '{"total_rows":1,"valid_rows":0,"error_rows":1,"imported_count":0,"non_critical_errors":[]}'::JSONB;
    rejected BOOLEAN;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor::TEXT || '@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id) VALUES(studio,'Import worker contract',studio::TEXT,actor);
    INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
    SET LOCAL ROLE service_role;

    rejected := FALSE;
    BEGIN
        PERFORM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','hash','',45);
    EXCEPTION WHEN invalid_parameter_value THEN rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Blank token was accepted'; END IF;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','hash','token',45);
    run_id := (candidate.run_row->>'id')::UUID;
    IF candidate.claim_status IS DISTINCT FROM 'claimed' OR run_id IS NULL
       OR candidate.run_row->'receipts' IS DISTINCT FROM '[]'::JSONB
       OR candidate.run_row->'receipts_enabled' IS DISTINCT FROM 'true'::JSONB THEN
        RAISE EXCEPTION 'Modern claim was not initialized atomically';
    END IF;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','different','other',45);
    IF candidate.claim_status IS DISTINCT FROM 'hash_mismatch' THEN RAISE EXCEPTION 'Changed request accepted'; END IF;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','hash','other',45);
    IF candidate.claim_status IS DISTINCT FROM 'already_processing' THEN RAISE EXCEPTION 'Active claim stolen'; END IF;
    IF (SELECT updated FROM public.heartbeat_student_import_run(run_id,'wrong')) IS DISTINCT FROM FALSE
       OR (SELECT updated FROM public.heartbeat_student_import_run(run_id,'token')) IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'Retained heartbeat token boundary failed';
    END IF;
    SELECT * INTO finished FROM public.finish_student_import_run(run_id,'wrong','completed',result,NULL);
    IF finished.updated IS DISTINCT FROM FALSE THEN RAISE EXCEPTION 'Stale worker completed the run'; END IF;

    PERFORM public.prepare_student_import_program_v1(studio,run_id,'token','__unassigned__',gen_random_uuid(),'Unassigned',NULL,TRUE);
    program_result := public.prepare_student_import_program_v1(studio,run_id,'token','owned',program_id,'Owned program',ladder_id,FALSE);
    ranks := jsonb_build_array(jsonb_build_object('key','white','id',rank_id,'name','White','color_hex','#ffffff'));
    belt_result := public.prepare_student_import_belts_v1(studio,run_id,'token',program_id,ladder_id,ranks,FALSE);
    UPDATE public.programs SET name='Staff program',archived_at=now() WHERE id=program_id;
    UPDATE public.belt_ladders SET name='Staff ladder',sub_rank_term='Keep' WHERE id=ladder_id;
    UPDATE public.belt_ranks SET name='Staff rank',display_order=9,min_classes=42 WHERE id=rank_id;
    IF public.prepare_student_import_program_v1(studio,run_id,'token','owned',program_id,'Owned program',ladder_id,FALSE) IS DISTINCT FROM program_result
       OR public.prepare_student_import_belts_v1(studio,run_id,'token',program_id,ladder_id,ranks,FALSE) IS DISTINCT FROM belt_result
       OR NOT EXISTS(SELECT 1 FROM public.programs WHERE id=program_id AND name='Staff program' AND archived_at IS NOT NULL)
       OR NOT EXISTS(SELECT 1 FROM public.belt_ladders WHERE id=ladder_id AND name='Staff ladder' AND sub_rank_term='Keep')
       OR NOT EXISTS(SELECT 1 FROM public.belt_ranks WHERE id=rank_id AND name='Staff rank' AND display_order=9 AND min_classes=42) THEN
        RAISE EXCEPTION 'Setup replay overwrote later staff edits';
    END IF;
    DELETE FROM public.belt_ladders WHERE id=ladder_id;
    DELETE FROM public.programs WHERE id=program_id;
    IF public.prepare_student_import_program_v1(studio,run_id,'token','owned',program_id,'Owned program',ladder_id,FALSE) IS DISTINCT FROM program_result
       OR public.prepare_student_import_belts_v1(studio,run_id,'token',program_id,ladder_id,ranks,FALSE) IS DISTINCT FROM belt_result
       OR EXISTS(SELECT 1 FROM public.programs WHERE id=program_id)
       OR EXISTS(SELECT 1 FROM public.belt_ladders WHERE id=ladder_id)
       OR EXISTS(SELECT 1 FROM public.belt_ranks WHERE id=rank_id)
       OR (SELECT count(*) FROM public.audit_logs WHERE studio_id=studio) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Setup replay recreated deleted configuration or repeated an audit';
    END IF;
    PERFORM public.finish_student_import_run(run_id,'token','failed',NULL,'Retryable interruption');
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','hash','retry',45);
    IF candidate.claim_status IS DISTINCT FROM 'claimed' OR (candidate.run_row->>'id')::UUID IS DISTINCT FROM run_id
       OR jsonb_array_length(candidate.run_row->'receipts') IS DISTINCT FROM 4 THEN
        RAISE EXCEPTION 'Failed-run recovery lost its setup receipt or run identity';
    END IF;
    UPDATE public.student_import_runs SET processing_started_at=now()-INTERVAL '1 hour' WHERE id=run_id;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','hash','reclaimed',45);
    IF candidate.claim_status IS DISTINCT FROM 'claimed' OR candidate.run_row->>'processing_token' IS DISTINCT FROM 'reclaimed' THEN
        RAISE EXCEPTION 'Stale modern claim was not reclaimed';
    END IF;
    rejected := FALSE;
    BEGIN PERFORM public.finish_student_import_run(run_id,'reclaimed','completed',result || '{"imported_count":1}',NULL);
    EXCEPTION WHEN invalid_parameter_value THEN rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Uncommitted student count was accepted'; END IF;
    PERFORM set_config('koaryu.test_import_audit','fail',TRUE);
    SELECT * INTO finished FROM public.finish_student_import_run(run_id,'reclaimed','completed',result,NULL);
    saved := finished.run_row->'result_json';
    IF finished.updated IS DISTINCT FROM TRUE OR saved->>'execution_status' IS DISTINCT FROM 'completed_with_warnings'
       OR saved->'non_critical_errors' IS DISTINCT FROM jsonb_build_array('Students were imported, but the final import audit log could not be written. Contact support if you need the audit event reconciled.')
       OR EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=studio AND action='students.imported') THEN
        RAISE EXCEPTION 'Final audit failure was not frozen with completion';
    END IF;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','modern','hash','later',45);
    IF candidate.claim_status IS DISTINCT FROM 'completed' OR candidate.run_row->'result_json' IS DISTINCT FROM saved THEN
        RAISE EXCEPTION 'Lost final reply did not recover the exact stored result';
    END IF;

    SELECT * INTO candidate FROM public.claim_student_import_run(studio,actor,'students_csv_execute','old-new','hash','old',45);
    IF candidate.claim_status IS DISTINCT FROM 'unsupported_run'
       OR EXISTS(SELECT 1 FROM public.student_import_runs WHERE studio_id=studio AND idempotency_key='old-new') THEN
        RAISE EXCEPTION 'Old caller started an untracked import';
    END IF;
    INSERT INTO public.student_import_runs(studio_id,actor_id,idempotency_key,request_hash,status,processing_token,processing_started_at)
    VALUES(studio,actor,'legacy','legacy-hash','processing','legacy-token',now()-INTERVAL '1 hour') RETURNING id INTO legacy_id;
    SELECT to_jsonb(r) INTO original FROM public.student_import_runs r WHERE id=legacy_id;
    SELECT * INTO candidate FROM public.claim_student_import_run(studio,actor,'students_csv_execute','legacy','legacy-hash','old-retry',45);
    IF candidate.claim_status IS DISTINCT FROM 'unsupported_run' THEN RAISE EXCEPTION 'Old caller resumed untracked work'; END IF;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','legacy','legacy-hash','new-retry',45);
    IF candidate.claim_status IS DISTINCT FROM 'unsupported_run'
       OR (SELECT to_jsonb(r) FROM public.student_import_runs r WHERE id=legacy_id) IS DISTINCT FROM original THEN
        RAISE EXCEPTION 'New caller changed incomplete legacy work';
    END IF;
    rejected := FALSE;
    BEGIN PERFORM public.finish_student_import_run(legacy_id,'legacy-token','completed',result,NULL);
    EXCEPTION WHEN invalid_parameter_value THEN rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Untracked legacy completion was accepted'; END IF;
    -- Model a genuinely completed pre-migration cache, without replaying its old writes.
    UPDATE public.student_import_runs SET status='completed',processing_token=NULL,result_json=result WHERE id=legacy_id;
    SELECT * INTO candidate FROM public.claim_student_import_run(studio,actor,'students_csv_execute','legacy','legacy-hash','old-cache',45);
    IF candidate.claim_status IS DISTINCT FROM 'completed' OR candidate.run_row->'result_json' IS DISTINCT FROM result THEN
        RAISE EXCEPTION 'Old caller lost completed legacy cache';
    END IF;
    SELECT * INTO candidate FROM public.claim_student_import_run_v2(studio,actor,'students_csv_execute','legacy','legacy-hash','new-cache',45);
    IF candidate.claim_status IS DISTINCT FROM 'completed' OR candidate.run_row->'result_json' IS DISTINCT FROM result THEN
        RAISE EXCEPTION 'New caller lost completed legacy cache';
    END IF;
    RAISE NOTICE 'Import claim, recovery, finalization and legacy refusal contracts passed.';
END $$;
ROLLBACK;
