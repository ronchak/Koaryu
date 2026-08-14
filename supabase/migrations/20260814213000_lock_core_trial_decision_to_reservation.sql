-- Close the remaining exact-head review blockers without rewriting migration
-- 108, which is already live on staging. Trial eligibility is bound to the
-- row-locked checkout reservation, and checkout acceptance versus operator
-- comp grants now fail closed in either lock order.

CREATE FUNCTION public.reserve_core_checkout_v2_atomic(
    p_studio_id UUID
)
RETURNS TABLE(
    outcome TEXT,
    reservation_token UUID,
    checkout_epoch BIGINT,
    session_id TEXT,
    session_url TEXT,
    expires_at BIGINT,
    trial_period_days INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row public.studio_subscriptions%ROWTYPE;
    v_metadata JSONB;
    v_reservation JSONB;
    v_session JSONB;
    v_acceptances JSONB;
    v_accepted_subscription_id TEXT;
    v_epoch BIGINT := 0;
    v_token UUID;
    v_created_at TIMESTAMPTZ;
    v_trial_period_days INTEGER;
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN QUERY SELECT 'comped', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT, NULL::INTEGER;
        RETURN;
    END IF;

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';
    v_acceptances := CASE
        WHEN jsonb_typeof(v_metadata->'core_checkout_acceptances') = 'object'
            THEN v_metadata->'core_checkout_acceptances'
        ELSE '{}'::JSONB
    END;

    IF jsonb_typeof(v_session) = 'object'
       AND v_session->>'state' = 'completed'
       AND NULLIF(v_session->>'accepted_subscription_id', '') IS NOT NULL THEN
        v_accepted_subscription_id := v_session->>'accepted_subscription_id';
        IF v_row.stripe_subscription_id IS DISTINCT FROM v_accepted_subscription_id
           OR v_row.status NOT IN ('canceled', 'incomplete_expired') THEN
            RETURN QUERY SELECT 'active', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT, NULL::INTEGER;
            RETURN;
        END IF;

        v_acceptances := v_acceptances || jsonb_build_object(
            v_accepted_subscription_id,
            v_session
        );
        v_metadata := jsonb_set(
            v_metadata,
            '{core_checkout_acceptances}',
            v_acceptances,
            TRUE
        );
    END IF;

    IF v_row.stripe_subscription_id IS NOT NULL
       AND v_row.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused') THEN
        RETURN QUERY SELECT 'active', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT, NULL::INTEGER;
        RETURN;
    END IF;

    IF jsonb_typeof(v_session) = 'object'
       AND v_session->>'state' = 'published'
       AND COALESCE(v_session->>'expires_at', '') ~ '^[0-9]+$'
       AND (v_session->>'expires_at')::BIGINT > extract(epoch FROM NOW())::BIGINT + 60
       AND NULLIF(v_session->>'url', '') IS NOT NULL THEN
        RETURN QUERY SELECT
            'existing',
            NULLIF(v_session->>'token', '')::UUID,
            NULLIF(v_session->>'epoch', '')::BIGINT,
            v_session->>'id',
            v_session->>'url',
            (v_session->>'expires_at')::BIGINT,
            NULL::INTEGER;
        RETURN;
    END IF;

    v_reservation := v_metadata->'core_checkout_reservation';
    BEGIN
        v_created_at := NULLIF(v_reservation->>'created_at', '')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
        v_created_at := NULL;
    END;
    IF jsonb_typeof(v_reservation) = 'object'
       AND v_reservation->>'state' = 'reserved'
       AND v_created_at > NOW() - INTERVAL '2 minutes' THEN
        RETURN QUERY SELECT
            'in_progress',
            NULLIF(v_reservation->>'token', '')::UUID,
            NULLIF(v_reservation->>'epoch', '')::BIGINT,
            NULL::TEXT,
            NULL::TEXT,
            NULL::BIGINT,
            NULL::INTEGER;
        RETURN;
    END IF;

    -- This decision is intentionally made only after FOR UPDATE. A caller that
    -- read an earlier subscription snapshot cannot carry stale eligibility
    -- across an accepted-and-terminal subscription transition.
    v_trial_period_days := CASE
        WHEN v_row.stripe_subscription_id IS NULL
         AND (
            NOT (v_metadata ? 'core_trial_consumed')
            OR v_metadata->'core_trial_consumed' = 'false'::JSONB
         )
        THEN 30
        ELSE NULL
    END;

    IF COALESCE(v_metadata->>'core_checkout_epoch', '') ~ '^[0-9]+$' THEN
        v_epoch := (v_metadata->>'core_checkout_epoch')::BIGINT;
    END IF;
    v_epoch := v_epoch + 1;
    v_token := gen_random_uuid();
    v_metadata := (v_metadata - 'core_checkout_session' - 'core_checkout_invalidated_session_id')
        || jsonb_build_object(
            'core_checkout_epoch', v_epoch,
            'core_checkout_reservation', jsonb_build_object(
                'state', 'reserved',
                'token', v_token,
                'epoch', v_epoch,
                'created_at', NOW()
            )
        );

    UPDATE public.studio_subscriptions subscription
    SET metadata = v_metadata
    WHERE subscription.studio_id = p_studio_id;

    RETURN QUERY SELECT 'reserved', v_token, v_epoch, NULL::TEXT, NULL::TEXT, NULL::BIGINT, v_trial_period_days;
END;
$$;

ALTER FUNCTION public.reserve_core_checkout_v2_atomic(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reserve_core_checkout_atomic(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_core_checkout_v2_atomic(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_core_checkout_v2_atomic(UUID) TO service_role;

-- A completed checkout is unreconciled until the exact accepted subscription
-- is projected terminal. A different older canceled subscription must not let
-- an operator comp race past the new provider subscription.
CREATE OR REPLACE FUNCTION public.invalidate_core_checkout_on_comp_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
    v_metadata JSONB := CASE
        WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata
        ELSE '{}'::JSONB
    END;
    v_old_metadata JSONB := CASE
        WHEN jsonb_typeof(OLD.metadata) = 'object' THEN OLD.metadata
        ELSE '{}'::JSONB
    END;
    v_epoch BIGINT := 0;
    v_session JSONB := v_old_metadata->'core_checkout_session';
    v_session_id TEXT;
    v_accepted_subscription_id TEXT;
BEGIN
    IF NEW.comped IS TRUE AND OLD.comped IS DISTINCT FROM TRUE THEN
        v_accepted_subscription_id := v_session->>'accepted_subscription_id';
        IF jsonb_typeof(v_session) = 'object'
           AND v_session->>'state' = 'completed'
           AND NULLIF(v_accepted_subscription_id, '') IS NOT NULL
           AND NOT (
               NEW.stripe_subscription_id IS NOT DISTINCT FROM v_accepted_subscription_id
               AND NEW.status IN ('canceled', 'incomplete_expired')
           ) THEN
            RAISE EXCEPTION 'Koaryu Core checkout already completed; reconcile the subscription before granting a comp.'
                USING ERRCODE = 'P0001';
        END IF;

        IF COALESCE(v_old_metadata->>'core_checkout_epoch', '') ~ '^[0-9]+$' THEN
            v_epoch := (v_old_metadata->>'core_checkout_epoch')::BIGINT;
        END IF;
        v_session_id := COALESCE(
            v_session->>'id',
            v_old_metadata->'core_checkout_reservation'->>'session_id'
        );
        NEW.metadata := (v_metadata - 'core_checkout_reservation' - 'core_checkout_session')
            || jsonb_build_object(
                'core_checkout_epoch', v_epoch + 1,
                'core_checkout_invalidated_session_id', v_session_id
            );
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.invalidate_core_checkout_on_comp_grant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invalidate_core_checkout_on_comp_grant() FROM PUBLIC, anon, authenticated, service_role;

-- Comp is checked before replay acceptance. Once an operator comp has won the
-- row lock, either webhook family must reject/cancel the provider subscription
-- instead of clearing the comp from an archived acceptance.
CREATE OR REPLACE FUNCTION public.accept_core_checkout_subscription_atomic(
    p_studio_id UUID,
    p_reservation_token UUID,
    p_checkout_epoch BIGINT,
    p_session_id TEXT,
    p_subscription_id TEXT,
    p_event_created BIGINT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row public.studio_subscriptions%ROWTYPE;
    v_metadata JSONB;
    v_session JSONB;
    v_acceptances JSONB;
    v_acceptance JSONB;
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND OR NULLIF(p_subscription_id, '') IS NULL THEN
        RETURN 'invalid';
    END IF;

    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN 'invalid';
    END IF;

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';
    v_acceptances := CASE
        WHEN jsonb_typeof(v_metadata->'core_checkout_acceptances') = 'object'
            THEN v_metadata->'core_checkout_acceptances'
        ELSE '{}'::JSONB
    END;
    v_acceptance := v_acceptances->p_subscription_id;

    IF jsonb_typeof(v_acceptance) = 'object'
       AND v_acceptance->>'state' = 'completed'
       AND NULLIF(v_acceptance->>'token', '')::UUID IS NOT DISTINCT FROM p_reservation_token
       AND NULLIF(v_acceptance->>'epoch', '')::BIGINT IS NOT DISTINCT FROM p_checkout_epoch
       AND v_acceptance->>'accepted_subscription_id' IS NOT DISTINCT FROM p_subscription_id
       AND (p_session_id IS NULL OR v_acceptance->>'id' IS NOT DISTINCT FROM p_session_id) THEN
        RETURN 'already_accepted';
    END IF;

    IF jsonb_typeof(v_session) = 'object'
       AND v_session->>'state' = 'completed'
       AND NULLIF(v_session->>'token', '')::UUID IS NOT DISTINCT FROM p_reservation_token
       AND NULLIF(v_session->>'epoch', '')::BIGINT IS NOT DISTINCT FROM p_checkout_epoch
       AND v_session->>'accepted_subscription_id' IS NOT DISTINCT FROM p_subscription_id
       AND (p_session_id IS NULL OR v_session->>'id' IS NOT DISTINCT FROM p_session_id) THEN
        UPDATE public.studio_subscriptions subscription
        SET metadata = jsonb_set(
            v_metadata,
            '{core_checkout_acceptances}',
            v_acceptances || jsonb_build_object(p_subscription_id, v_session),
            TRUE
        )
        WHERE subscription.studio_id = p_studio_id;
        RETURN 'already_accepted';
    END IF;

    IF jsonb_typeof(v_session) IS DISTINCT FROM 'object'
       OR v_session->>'state' IS DISTINCT FROM 'published'
       OR NULLIF(v_session->>'token', '')::UUID IS DISTINCT FROM p_reservation_token
       OR NULLIF(v_session->>'epoch', '')::BIGINT IS DISTINCT FROM p_checkout_epoch
       OR (p_session_id IS NOT NULL AND v_session->>'id' IS DISTINCT FROM p_session_id) THEN
        RETURN 'invalid';
    END IF;

    v_session := (v_session - 'url' - 'expires_at') || jsonb_build_object(
        'state', 'completed',
        'accepted_subscription_id', p_subscription_id,
        'completed_event_created', p_event_created
    );
    UPDATE public.studio_subscriptions subscription
    SET metadata = jsonb_set(
            jsonb_set(
                v_metadata || jsonb_build_object('core_trial_consumed', TRUE),
                '{core_checkout_session}',
                v_session,
                TRUE
            ),
            '{core_checkout_acceptances}',
            v_acceptances || jsonb_build_object(p_subscription_id, v_session),
            TRUE
        )
    WHERE subscription.studio_id = p_studio_id;
    RETURN 'accepted';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN 'invalid';
END;
$$;

ALTER FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) TO service_role;

CREATE FUNCTION private.koaryu_release_critical_surface_manifest_v16()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_v15 TEXT;
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    v_v15 := private.koaryu_release_critical_surface_manifest_v15();
    v_invalid := COALESCE(NULLIF(split_part(v_v15, ':', 1), '')::INTEGER, 1);

    SELECT v_invalid + (procedure.oid IS NULL)::INTEGER,
           'v15:' || COALESCE(v_v15, '') || '|f:' ||
           'public.reserve_core_checkout_v2_atomic(uuid):' ||
           COALESCE(pg_get_functiondef(procedure.oid), '') || ':' ||
           COALESCE(pg_get_function_result(procedure.oid), '') || ':' ||
           COALESCE(owner.rolname, '') || ':' ||
           COALESCE(procedure.prosecdef::TEXT, '') || ':' ||
           COALESCE(array_to_string(procedure.proconfig, ','), '') || ':' ||
           COALESCE(array_to_string(procedure.proacl, ','), '')
    INTO v_invalid, v_serialized
    FROM (SELECT to_regprocedure('public.reserve_core_checkout_v2_atomic(uuid)') AS oid) required
    LEFT JOIN pg_proc procedure ON procedure.oid = required.oid
    LEFT JOIN pg_roles owner ON owner.oid = procedure.proowner;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
$$;

ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v16() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v16() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT, pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 109 OR v_head <> '20260814213000' THEN
        v_failures := array_append(v_failures, 'migration_history_v16');
    END IF;
    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v16()
       <> '0:800957d36c16a6b5db75e2c8188916eabacda33e642481dce013ea215ae7f4de' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v16');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v16';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
