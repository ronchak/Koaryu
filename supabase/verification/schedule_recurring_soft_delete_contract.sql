BEGIN;

DO $$
DECLARE
    v_predicate TEXT;
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_template UUID := gen_random_uuid();
    v_original_session UUID := gen_random_uuid();
    v_replacement_session UUID := gen_random_uuid();
    v_expected_exception BOOLEAN;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'idx_class_sessions_template_date_unique'
    ) THEN
        RAISE EXCEPTION 'Old recurring-session unique index still exists.';
    END IF;

    SELECT pg_get_expr(index_relation.indpred, index_relation.indrelid)
    INTO v_predicate
    FROM pg_index index_relation
    JOIN pg_class index_class ON index_class.oid = index_relation.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
    WHERE namespace.nspname = 'public'
      AND index_class.relname = 'idx_class_sessions_template_date_active_unique'
      AND index_relation.indisunique;

    IF v_predicate IS NULL THEN
        RAISE EXCEPTION 'Active recurring-session unique index is missing.';
    END IF;

    IF v_predicate NOT ILIKE '%template_id IS NOT NULL%'
       OR v_predicate NOT ILIKE '%deleted_at IS NULL%' THEN
        RAISE EXCEPTION 'Active recurring-session unique index has unexpected predicate: %', v_predicate;
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
        v_owner,
        'authenticated',
        'authenticated',
        'koaryu-recurring-verification-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Koaryu Recurring Verification',
        'koaryu-recurring-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.class_templates (
        id,
        studio_id,
        name,
        day_of_week,
        start_time,
        end_time,
        start_date
    )
    VALUES (
        v_template,
        v_studio,
        'Recurring Verification Template',
        1,
        '17:00',
        '18:00',
        DATE '2026-05-24'
    );

    INSERT INTO public.class_sessions (
        id,
        studio_id,
        template_id,
        name,
        date,
        start_time,
        end_time
    )
    VALUES (
        v_original_session,
        v_studio,
        v_template,
        'Recurring Verification Original',
        DATE '2026-05-25',
        '17:00',
        '18:00'
    );

    v_expected_exception := false;
    BEGIN
        INSERT INTO public.class_sessions (
            studio_id,
            template_id,
            name,
            date,
            start_time,
            end_time
        )
        VALUES (
            v_studio,
            v_template,
            'Recurring Verification Duplicate Active',
            DATE '2026-05-25',
            '17:00',
            '18:00'
        );
    EXCEPTION WHEN unique_violation THEN
        v_expected_exception := true;
    END;

    IF NOT v_expected_exception THEN
        RAISE EXCEPTION 'Expected duplicate active recurring session to be rejected.';
    END IF;

    UPDATE public.class_sessions
    SET deleted_at = now()
    WHERE id = v_original_session;

    INSERT INTO public.class_sessions (
        id,
        studio_id,
        template_id,
        name,
        date,
        start_time,
        end_time
    )
    VALUES (
        v_replacement_session,
        v_studio,
        v_template,
        'Recurring Verification Replacement',
        DATE '2026-05-25',
        '17:00',
        '18:00'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.class_sessions
        WHERE id = v_replacement_session
          AND template_id = v_template
          AND date = DATE '2026-05-25'
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Expected replacement active recurring session after soft-delete.';
    END IF;

    RAISE NOTICE 'Koaryu recurring-session soft-delete uniqueness verification passed.';
END $$;

ROLLBACK;
