BEGIN;

DO $$
DECLARE
    v_owner_id UUID := gen_random_uuid();
    v_function REGPROCEDURE := to_regprocedure('public.sum_email_usage_for_period(uuid,timestamptz,timestamptz)');
    v_other_studio_id UUID := gen_random_uuid();
    v_studio_id UUID := gen_random_uuid();
    v_total INTEGER;
BEGIN
    IF v_function IS NULL THEN
        RAISE EXCEPTION 'Missing email usage aggregation RPC.';
    END IF;

    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute the email usage aggregation RPC.';
    END IF;

    IF NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute the email usage aggregation RPC.';
    END IF;

    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner_id,
        'authenticated',
        'authenticated',
        'email-usage-verification-' || replace(v_owner_id::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (
            v_studio_id,
            'Email Usage Verification Studio',
            'email-usage-verification-' || replace(v_studio_id::TEXT, '-', ''),
            v_owner_id
        ),
        (
            v_other_studio_id,
            'Email Usage Other Verification Studio',
            'email-usage-other-verification-' || replace(v_other_studio_id::TEXT, '-', ''),
            v_owner_id
        );

    INSERT INTO public.email_usage_events (studio_id, quantity, sent_at)
    VALUES
        (v_studio_id, 2, '2026-06-01T00:00:00Z'),
        (v_studio_id, 3, '2026-06-15T00:00:00Z'),
        (v_studio_id, 99, '2026-07-01T00:00:00Z'),
        (v_other_studio_id, 100, '2026-06-15T00:00:00Z');

    SELECT public.sum_email_usage_for_period(
        v_studio_id,
        '2026-06-01T00:00:00Z',
        '2026-07-01T00:00:00Z'
    )
    INTO v_total;

    IF v_total <> 5 THEN
        RAISE EXCEPTION 'Expected summed email usage of 5, got %.', v_total;
    END IF;

    RAISE NOTICE 'Koaryu email usage RPC verification passed.';
END $$;

ROLLBACK;
