BEGIN;

DO $$
DECLARE
    v_rpc REGPROCEDURE := 'public.set_studio_comp_atomic(uuid, boolean, text, uuid, text)'::REGPROCEDURE;
BEGIN
    IF to_regprocedure('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text)') IS NULL THEN
        RAISE EXCEPTION 'Missing public.set_studio_comp_atomic(uuid, boolean, text, uuid, text).';
    END IF;

    IF NOT has_function_privilege('service_role', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role must execute public.set_studio_comp_atomic.';
    END IF;

    IF has_function_privilege('anon', v_rpc, 'EXECUTE')
       OR has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
        RAISE EXCEPTION 'Browser-facing roles must not execute public.set_studio_comp_atomic.';
    END IF;
END $$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_row public.studio_subscriptions%ROWTYPE;
BEGIN
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
        'comp-metadata-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Comp Metadata Smoke',
        'comp-metadata-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        metadata
    )
    VALUES (
        v_studio,
        'incomplete',
        false,
        '{
            "core_subscription_event_created": 123,
            "comp": {"state": "revoked", "source": "comp_studio_cli"}
        }'::JSONB
    );

    PERFORM public.set_studio_comp_atomic(
        v_studio,
        true,
        'Metadata verification',
        v_owner,
        'owner@example.invalid'
    );

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_row.metadata->>'core_subscription_event_created' <> '123'
       OR v_row.metadata->'comp'->>'state' <> 'granted' THEN
        RAISE EXCEPTION 'Comp mutation did not preserve existing billing metadata.';
    END IF;

    UPDATE public.studio_subscriptions
       SET metadata = '{
           "core_subscription_event_created": 456,
           "comp": {"state": "revoked", "source": "comp_studio_cli"}
       }'::JSONB
     WHERE studio_id = v_studio;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_row.metadata->>'core_subscription_event_created' <> '456'
       OR v_row.metadata->'comp'->>'state' <> 'granted' THEN
        RAISE EXCEPTION 'Stale billing metadata replacement erased comp provenance.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.reject_comp_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF NEW.action IN ('platform_comp.granted', 'platform_comp.revoked') THEN
        RAISE EXCEPTION 'forced comp audit failure';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reject_comp_audit_for_rollback_check
    BEFORE INSERT ON public.audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION pg_temp.reject_comp_audit();

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_failed BOOLEAN := false;
    v_row public.studio_subscriptions%ROWTYPE;
    v_audit_count INTEGER;
BEGIN
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
        'comp-rollback-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::JSONB,
        '{}'::JSONB,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Comp Rollback Smoke',
        'comp-rollback-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.studio_subscriptions (
        studio_id,
        status,
        comped,
        metadata
    )
    VALUES (
        v_studio,
        'incomplete',
        false,
        '{"core_subscription_event_created":123}'::JSONB
    );

    BEGIN
        PERFORM public.set_studio_comp_atomic(
            v_studio,
            true,
            'Rollback verification',
            v_owner,
            'owner@example.invalid'
        );
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM <> 'forced comp audit failure' THEN
                RAISE;
            END IF;
            v_failed := true;
    END;

    IF NOT v_failed THEN
        RAISE EXCEPTION 'The forced audit failure did not abort comp mutation.';
    END IF;

    SELECT *
      INTO v_row
      FROM public.studio_subscriptions
     WHERE studio_id = v_studio;

    IF v_row.comped
       OR v_row.status <> 'incomplete'
       OR v_row.metadata <> '{"core_subscription_event_created":123}'::JSONB THEN
        RAISE EXCEPTION 'Failed audit insert did not roll back the subscription update.';
    END IF;

    SELECT COUNT(*)
      INTO v_audit_count
      FROM public.audit_logs
     WHERE studio_id = v_studio
       AND action IN ('platform_comp.granted', 'platform_comp.revoked');

    IF v_audit_count <> 0 THEN
        RAISE EXCEPTION 'Failed atomic comp mutation left an audit row.';
    END IF;
END $$;

ROLLBACK;
