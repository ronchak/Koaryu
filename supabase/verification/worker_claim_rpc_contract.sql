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

        IF NOT COALESCE('search_path=public, pg_temp' = ANY(v_config), false) THEN
            RAISE EXCEPTION 'Worker claim RPC % must pin search_path to public, pg_temp.', v_signature;
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
    v_run_id UUID;
    v_smoke_key TEXT := 'worker-smoke-' || gen_random_uuid()::TEXT;
    v_stale_request_id UUID;
    v_studio_id UUID;
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

    SELECT id
      INTO v_studio_id
      FROM public.studios
     ORDER BY created_at NULLS LAST, id
     LIMIT 1;

    IF v_studio_id IS NULL THEN
        RAISE NOTICE 'Skipping student-import worker RPC behavior smoke because no studio row exists.';
    ELSE
        BEGIN
            PERFORM *
              FROM public.claim_student_import_run(
                  v_studio_id,
                  NULL,
                  'students_csv_execute',
                  v_smoke_key,
                  'hash-1',
                  '',
                  45
              );
            RAISE EXCEPTION 'Expected blank student import claim token to be rejected.';
        EXCEPTION WHEN invalid_parameter_value THEN
            NULL;
        END;

        SELECT claim_status, run_row
          INTO v_claim_status, v_event_row
          FROM public.claim_student_import_run(
              v_studio_id,
              NULL,
              'students_csv_execute',
              v_smoke_key,
              'hash-1',
              'student-token-1',
              45
          );

        IF v_claim_status <> 'claimed' THEN
            RAISE EXCEPTION 'Expected first student import claim, got %.', v_claim_status;
        END IF;
        v_run_id := (v_event_row->>'id')::UUID;

        SELECT updated
          INTO v_updated
          FROM public.heartbeat_student_import_run(v_run_id, 'wrong-token');

        IF v_updated THEN
            RAISE EXCEPTION 'Wrong student import token must not heartbeat run.';
        END IF;

        SELECT updated
          INTO v_updated
          FROM public.heartbeat_student_import_run(v_run_id, 'student-token-1');

        IF NOT v_updated THEN
            RAISE EXCEPTION 'Correct student import token should heartbeat run.';
        END IF;

        SELECT claim_status
          INTO v_claim_status
          FROM public.claim_student_import_run(
              v_studio_id,
              NULL,
              'students_csv_execute',
              v_smoke_key,
              'hash-2',
              'student-token-2',
              45
          );

        IF v_claim_status <> 'hash_mismatch' THEN
            RAISE EXCEPTION 'Student import hash mismatch should be explicit, got %.', v_claim_status;
        END IF;

        SELECT claim_status
          INTO v_claim_status
          FROM public.claim_student_import_run(
              v_studio_id,
              NULL,
              'students_csv_execute',
              v_smoke_key,
              'hash-1',
              'student-token-2',
              45
          );

        IF v_claim_status <> 'already_processing' THEN
            RAISE EXCEPTION 'Fresh student import claim should stay processing, got %.', v_claim_status;
        END IF;

        SELECT updated
          INTO v_updated
          FROM public.finish_student_import_run(
              v_run_id,
              'wrong-token',
              'completed',
              '{"imported_count":1}'::JSONB,
              NULL
          );

        IF v_updated THEN
            RAISE EXCEPTION 'Wrong student import token must not finish run.';
        END IF;

        SELECT updated
          INTO v_updated
          FROM public.finish_student_import_run(
              v_run_id,
              'student-token-1',
              'completed',
              '{"imported_count":1}'::JSONB,
              NULL
          );

        IF NOT v_updated THEN
            RAISE EXCEPTION 'Correct student import token should finish run.';
        END IF;

        SELECT claim_status
          INTO v_claim_status
          FROM public.claim_student_import_run(
              v_studio_id,
              NULL,
              'students_csv_execute',
              v_smoke_key,
              'hash-1',
              'student-token-3',
              45
          );

        IF v_claim_status <> 'completed' THEN
            RAISE EXCEPTION 'Completed student import should be reusable, got %.', v_claim_status;
        END IF;
    END IF;

    RAISE NOTICE 'Koaryu worker claim RPC contract verification passed.';
END $$;

ROLLBACK;
