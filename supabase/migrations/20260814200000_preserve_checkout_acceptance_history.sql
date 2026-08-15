-- Preserve every accepted Koaryu Core checkout binding across later checkout
-- epochs and attest the promotion columns that the snapshot trigger depends on.
-- Migration 107 has already been rehearsed on staging, so this is deliberately
-- a forward-only replacement rather than a rewrite of applied history.

CREATE OR REPLACE FUNCTION public.reserve_core_checkout_atomic(
    p_studio_id UUID
)
RETURNS TABLE(
    outcome TEXT,
    reservation_token UUID,
    checkout_epoch BIGINT,
    session_id TEXT,
    session_url TEXT,
    expires_at BIGINT
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
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN QUERY SELECT 'comped', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';
    v_acceptances := CASE
        WHEN jsonb_typeof(v_metadata->'core_checkout_acceptances') = 'object'
            THEN v_metadata->'core_checkout_acceptances'
        ELSE '{}'::JSONB
    END;

    -- Acceptance and provider projection are separate requests.  A completed
    -- binding is therefore terminal until that exact accepted subscription has
    -- been projected into an explicit terminal state.  This closes the window
    -- where a second request could erase the binding and reuse a cached trial.
    IF jsonb_typeof(v_session) = 'object'
       AND v_session->>'state' = 'completed'
       AND NULLIF(v_session->>'accepted_subscription_id', '') IS NOT NULL THEN
        v_accepted_subscription_id := v_session->>'accepted_subscription_id';
        IF v_row.stripe_subscription_id IS DISTINCT FROM v_accepted_subscription_id
           OR v_row.status NOT IN ('canceled', 'incomplete_expired') THEN
            RETURN QUERY SELECT 'active', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
            RETURN;
        END IF;

        -- The accepted subscription is now terminal.  Archive the full replay
        -- binding before a new current epoch replaces it.
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
        RETURN QUERY SELECT 'active', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
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
            (v_session->>'expires_at')::BIGINT;
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
            NULL::BIGINT;
        RETURN;
    END IF;

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

    RETURN QUERY SELECT 'reserved', v_token, v_epoch, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
END;
$$;

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

    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN 'invalid';
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

ALTER FUNCTION public.reserve_core_checkout_atomic(UUID) OWNER TO postgres;
ALTER FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reserve_core_checkout_atomic(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_core_checkout_atomic(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) TO service_role;

CREATE FUNCTION private.koaryu_release_critical_surface_manifest_v15()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
WITH required_functions(signature) AS (
    VALUES
      ('public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)'),
      ('public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)'),
      ('public.soft_delete_student_atomic(uuid,uuid,uuid)'),
      ('public.snapshot_promotion_rank_identity()'),
      ('public.invalidate_core_checkout_on_comp_grant()'),
      ('public.reserve_core_checkout_atomic(uuid)'),
      ('public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)'),
      ('public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)'),
      ('public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)'),
      ('public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)'),
      ('public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)'),
      ('public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)'),
      ('public.reassign_memberships_before_belt_rank_delete()')
), function_state AS (
    SELECT required.signature,
           procedure.oid,
           COALESCE(pg_get_functiondef(procedure.oid), '') AS definition,
           COALESCE(pg_get_function_result(procedure.oid), '') AS result_contract,
           owner.rolname AS owner_name,
           procedure.prosecdef,
           COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
           COALESCE(array_to_string(procedure.proacl, ','), '') AS acl
    FROM required_functions required
    LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(required.signature)
    LEFT JOIN pg_roles owner ON owner.oid = procedure.proowner
), required_triggers(table_name, trigger_name) AS (
    VALUES
      ('promotions', 'snapshot_promotion_rank_identity_trigger'),
      ('studio_subscriptions', 'invalidate_core_checkout_on_comp_grant_trigger'),
      ('belt_ranks', 'reassign_memberships_before_belt_rank_delete_trigger')
), trigger_state AS (
    SELECT required.table_name, required.trigger_name, trigger.oid,
           COALESCE(pg_get_triggerdef(trigger.oid, TRUE), '') AS definition,
           COALESCE(trigger.tgenabled::TEXT, '') AS enabled
    FROM required_triggers required
    LEFT JOIN pg_class relation ON relation.relname = required.table_name
    LEFT JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace AND namespace.nspname = 'public'
    LEFT JOIN pg_trigger trigger ON trigger.tgrelid = relation.oid
      AND trigger.tgname = required.trigger_name AND NOT trigger.tgisinternal
), required_constraints(name) AS (
    VALUES ('promotions_from_rank_id_fkey'), ('promotions_to_rank_id_fkey')
), constraint_state AS (
    SELECT required.name, constraint_row.oid,
           COALESCE(pg_get_constraintdef(constraint_row.oid, TRUE), '') AS definition
    FROM required_constraints required
    LEFT JOIN pg_constraint constraint_row ON constraint_row.conname = required.name
      AND constraint_row.conrelid = 'public.promotions'::regclass
), required_columns(name, data_type, not_null, identity_kind, generated_kind, default_expression) AS (
    VALUES
      ('from_rank_id', 'uuid', FALSE, '', '', ''),
      ('to_rank_id', 'uuid', FALSE, '', '', ''),
      ('from_rank_name_snapshot', 'text', FALSE, '', '', ''),
      ('from_rank_color_snapshot', 'text', FALSE, '', '', ''),
      ('to_rank_name_snapshot', 'text', FALSE, '', '', ''),
      ('to_rank_color_snapshot', 'text', FALSE, '', '', '')
), column_state AS (
    SELECT required.name,
           attribute.attnum,
           COALESCE(format_type(attribute.atttypid, attribute.atttypmod), '') AS data_type,
           attribute.attnotnull AS not_null,
           COALESCE(attribute.attidentity::TEXT, '') AS identity_kind,
           COALESCE(attribute.attgenerated::TEXT, '') AS generated_kind,
           COALESCE(pg_get_expr(default_row.adbin, default_row.adrelid, TRUE), '') AS default_expression,
           required.data_type AS expected_data_type,
           required.not_null AS expected_not_null,
           required.identity_kind AS expected_identity_kind,
           required.generated_kind AS expected_generated_kind,
           required.default_expression AS expected_default_expression
    FROM required_columns required
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid = 'public.promotions'::regclass
     AND attribute.attname = required.name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
), serialized AS (
    SELECT 'f:' || signature || ':' ||
           definition || ':' || result_contract || ':' || COALESCE(owner_name, '') || ':' ||
           COALESCE(prosecdef::TEXT, '') || ':' || configuration || ':' || acl AS value,
           (oid IS NULL)::INTEGER AS invalid
    FROM function_state
    UNION ALL
    SELECT 't:' || table_name || ':' || trigger_name || ':' ||
           definition || ':' || enabled,
           (oid IS NULL OR enabled <> 'O')::INTEGER
    FROM trigger_state
    UNION ALL
    SELECT 'c:' || name || ':' || definition,
           (oid IS NULL)::INTEGER
    FROM constraint_state
    UNION ALL
    SELECT 'a:' || name || ':' || data_type || ':' || COALESCE(not_null::TEXT, '') || ':' ||
           identity_kind || ':' || generated_kind || ':' || default_expression,
           (attnum IS NULL
            OR data_type IS DISTINCT FROM expected_data_type
            OR not_null IS DISTINCT FROM expected_not_null
            OR identity_kind IS DISTINCT FROM expected_identity_kind
            OR generated_kind IS DISTINCT FROM expected_generated_kind
            OR default_expression IS DISTINCT FROM expected_default_expression)::INTEGER
    FROM column_state
)
SELECT sum(invalid)::TEXT || ':' || encode(
    extensions.digest(convert_to(string_agg(value, '|' ORDER BY value COLLATE "C"), 'UTF8'), 'sha256'),
    'hex'
)
FROM serialized;
$$;

ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v15() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v15() FROM PUBLIC, anon, authenticated, service_role;

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

    IF v_count <> 108 OR v_head <> '20260814200000' THEN
        v_failures := array_append(v_failures, 'migration_history_v15');
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
    IF private.koaryu_release_critical_surface_manifest_v15()
       <> '0:ea9595fd9c1c661c983d580be9beafdb0b794743dc43caef31a0a53f32f07149' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v15');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v15';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
