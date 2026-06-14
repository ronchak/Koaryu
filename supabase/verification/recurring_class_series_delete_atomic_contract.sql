BEGIN;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.delete_recurring_class_series_atomic(uuid, uuid, uuid)'::REGPROCEDURE;
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_template UUID := gen_random_uuid();
    v_other_template UUID := gen_random_uuid();
    v_selected_session UUID := gen_random_uuid();
    v_future_session UUID := gen_random_uuid();
    v_past_session UUID := gen_random_uuid();
    v_other_session UUID := gen_random_uuid();
    v_count INTEGER;
BEGIN
    IF to_regprocedure('public.delete_recurring_class_series_atomic(uuid, uuid, uuid)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.delete_recurring_class_series_atomic(uuid, uuid, uuid).';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.delete_recurring_class_series_atomic.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.delete_recurring_class_series_atomic.';
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
        'series-delete-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES
        (v_studio, 'Series Delete Smoke', 'series-delete-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Series Delete Other', 'series-delete-other-' || replace(v_other_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.class_templates (
        id,
        studio_id,
        name,
        day_of_week,
        start_time,
        end_time,
        start_date,
        is_active
    )
    VALUES
        (v_template, v_studio, 'Youth Basics', 0, '09:00', '10:00', '2026-05-01', true),
        (v_other_template, v_other_studio, 'Other Basics', 0, '09:00', '10:00', '2026-05-01', true);

    INSERT INTO public.class_sessions (
        id,
        studio_id,
        template_id,
        name,
        date,
        start_time,
        end_time,
        status
    )
    VALUES
        (v_past_session, v_studio, v_template, 'Youth Basics', '2026-05-24', '09:00', '10:00', 'scheduled'),
        (v_selected_session, v_studio, v_template, 'Youth Basics', '2026-05-31', '09:00', '10:00', 'scheduled'),
        (v_future_session, v_studio, v_template, 'Youth Basics', '2026-06-07', '09:00', '10:00', 'scheduled'),
        (v_other_session, v_other_studio, v_other_template, 'Other Basics', '2026-06-07', '09:00', '10:00', 'scheduled');

    PERFORM public.delete_recurring_class_series_atomic(v_selected_session, v_studio, v_owner);

    SELECT COUNT(*)
    INTO v_count
    FROM public.class_templates
    WHERE id = v_template
      AND studio_id = v_studio
      AND is_active = false
      AND end_date = '2026-05-30';

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic series delete did not end the target template before the selected session.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.class_sessions
    WHERE id IN (v_selected_session, v_future_session)
      AND studio_id = v_studio
      AND status = 'canceled'
      AND deleted_at IS NOT NULL;

    IF v_count <> 2 THEN
        RAISE EXCEPTION 'Atomic series delete did not cancel selected and future sessions.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.class_sessions
    WHERE id = v_past_session
      AND studio_id = v_studio
      AND status = 'scheduled'
      AND deleted_at IS NULL;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic series delete changed a past session.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.class_sessions
    WHERE id = v_other_session
      AND studio_id = v_other_studio
      AND status = 'scheduled'
      AND deleted_at IS NULL;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic series delete changed another studio session.';
    END IF;

    SELECT COUNT(*)
    INTO v_count
    FROM public.audit_logs
    WHERE studio_id = v_studio
      AND actor_id = v_owner
      AND action = 'class_series.deleted'
      AND entity_id = v_template;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Atomic series delete did not write one audit row.';
    END IF;
END $$;

ROLLBACK;
