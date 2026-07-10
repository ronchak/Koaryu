BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_template UUID := gen_random_uuid();
    v_first_session UUID;
    v_function_definition TEXT;
    v_inserted INTEGER;
BEGIN
    IF has_function_privilege(
        'anon',
        'public.materialize_recurring_class_sessions(uuid,date,date)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.materialize_recurring_class_sessions(uuid,date,date)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Recurring materialization RPC is exposed to client roles.';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.materialize_recurring_class_sessions(uuid,date,date)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Recurring materialization RPC is unavailable to service_role.';
    END IF;

    SELECT pg_get_functiondef(
        'public.materialize_recurring_class_sessions(uuid,date,date)'::regprocedure
    )
    INTO v_function_definition;

    IF v_function_definition NOT ILIKE '%FOR UPDATE%' THEN
        RAISE EXCEPTION 'Recurring materialization RPC must lock templates against series deletion.';
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
        'koaryu-materialization-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Koaryu Materialization Verification',
        'koaryu-materialization-' || replace(v_studio::TEXT, '-', ''),
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
        'Atomic Recurring Class',
        1,
        '17:00',
        '18:00',
        DATE '2026-07-06'
    );

    SELECT public.materialize_recurring_class_sessions(
        v_studio,
        DATE '2026-07-06',
        DATE '2026-07-19'
    )
    INTO v_inserted;

    IF v_inserted <> 2 THEN
        RAISE EXCEPTION 'Expected two recurring sessions, materialized %.', v_inserted;
    END IF;

    SELECT public.materialize_recurring_class_sessions(
        v_studio,
        DATE '2026-07-06',
        DATE '2026-07-19'
    )
    INTO v_inserted;

    IF v_inserted <> 0 THEN
        RAISE EXCEPTION 'Recurring materialization is not idempotent.';
    END IF;

    SELECT id
      INTO v_first_session
      FROM public.class_sessions
     WHERE studio_id = v_studio
       AND template_id = v_template
       AND date = DATE '2026-07-06'
       AND deleted_at IS NULL;

    PERFORM public.delete_recurring_class_series_atomic(
        v_first_session,
        v_studio,
        v_owner
    );

    SELECT public.materialize_recurring_class_sessions(
        v_studio,
        DATE '2026-07-06',
        DATE '2026-08-02'
    )
    INTO v_inserted;

    IF v_inserted <> 0 OR EXISTS (
        SELECT 1
          FROM public.class_sessions
         WHERE studio_id = v_studio
           AND template_id = v_template
           AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Deleted recurring series was resurrected by materialization.';
    END IF;

    RAISE NOTICE 'Atomic recurring-session materialization verification passed.';
END $$;

ROLLBACK;
