-- Close the final database-first review blockers without rewriting migration
-- 106, which has already been rehearsed on staging.  This migration preserves
-- a durable accepted-checkout binding, applies that binding to both Stripe
-- event families, fixes the secondary-membership ladder lock order, and
-- advances hosted readiness so those controls are part of the release gate.

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
BEGIN
    IF NEW.comped IS TRUE AND OLD.comped IS DISTINCT FROM TRUE THEN
        -- Acceptance and comp grants serialize on this row.  If Stripe has
        -- already created a subscription but its projection has not committed,
        -- rejecting the comp is the only outcome that cannot both grant free
        -- access and cancel/erase a legitimate provider subscription.
        IF jsonb_typeof(v_session) = 'object'
           AND v_session->>'state' = 'completed'
           AND NULLIF(v_session->>'accepted_subscription_id', '') IS NOT NULL
           AND (
               NEW.stripe_subscription_id IS NULL
               OR NEW.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')
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
    IF v_row.stripe_subscription_id IS NOT NULL
       AND v_row.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused') THEN
        RETURN QUERY SELECT 'active', NULL::UUID, NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::BIGINT;
        RETURN;
    END IF;

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';
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

CREATE FUNCTION public.accept_core_checkout_subscription_atomic(
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
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'invalid';
    END IF;

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';

    IF jsonb_typeof(v_session) = 'object'
       AND v_session->>'state' = 'completed'
       AND NULLIF(v_session->>'token', '')::UUID IS NOT DISTINCT FROM p_reservation_token
       AND NULLIF(v_session->>'epoch', '')::BIGINT IS NOT DISTINCT FROM p_checkout_epoch
       AND v_session->>'accepted_subscription_id' IS NOT DISTINCT FROM p_subscription_id
       AND (p_session_id IS NULL OR v_session->>'id' IS NOT DISTINCT FROM p_session_id) THEN
        RETURN 'already_accepted';
    END IF;

    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN 'invalid';
    END IF;
    IF jsonb_typeof(v_session) IS DISTINCT FROM 'object'
       OR v_session->>'state' IS DISTINCT FROM 'published'
       OR NULLIF(v_session->>'token', '')::UUID IS DISTINCT FROM p_reservation_token
       OR NULLIF(v_session->>'epoch', '')::BIGINT IS DISTINCT FROM p_checkout_epoch
       OR (p_session_id IS NOT NULL AND v_session->>'id' IS DISTINCT FROM p_session_id)
       OR NULLIF(p_subscription_id, '') IS NULL THEN
        RETURN 'invalid';
    END IF;

    v_session := (v_session - 'url' - 'expires_at') || jsonb_build_object(
        'state', 'completed',
        'accepted_subscription_id', p_subscription_id,
        'completed_event_created', p_event_created
    );
    UPDATE public.studio_subscriptions subscription
    SET metadata = jsonb_set(
        v_metadata || jsonb_build_object('core_trial_consumed', TRUE),
        '{core_checkout_session}',
        v_session,
        TRUE
    )
    WHERE subscription.studio_id = p_studio_id;
    RETURN 'accepted';
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN 'invalid';
END;
$$;

ALTER FUNCTION public.invalidate_core_checkout_on_comp_grant() OWNER TO postgres;
ALTER FUNCTION public.reserve_core_checkout_atomic(UUID) OWNER TO postgres;
ALTER FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invalidate_core_checkout_on_comp_grant() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reserve_core_checkout_atomic(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_core_checkout_completion_atomic(UUID, UUID, BIGINT, TEXT, BIGINT) FROM service_role;
REVOKE ALL ON FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_core_checkout_atomic(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_core_checkout_subscription_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) TO service_role;

-- Prelock every student reached through the edited program, including students
-- whose rank is held only by a secondary membership.  The wrapper obtains
-- these locks before the internal writer can lock/delete a belt rank, matching
-- the profile writer's students-first order.
CREATE OR REPLACE FUNCTION public.sync_belt_ladder_ranks(
    p_ladder_id UUID,
    p_studio_id UUID,
    p_sub_rank_term TEXT DEFAULT NULL,
    p_ranks JSONB DEFAULT '[]'::JSONB
)
RETURNS TABLE (
    id UUID,
    studio_id UUID,
    name TEXT,
    program_id UUID,
    sub_rank_term TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    ranks JSONB
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_program_id UUID;
BEGIN
    SELECT ladder.program_id INTO v_program_id
    FROM public.belt_ladders ladder
    WHERE ladder.id = p_ladder_id
      AND ladder.studio_id = p_studio_id;

    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = p_studio_id
      AND EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = p_studio_id
            AND membership.student_id = student.id
            AND membership.program_id = v_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
      )
    ORDER BY student.id
    FOR UPDATE;

    PERFORM set_config('koaryu.rank_plan_delete', 'enabled', TRUE);
    RETURN QUERY
    SELECT *
    FROM public.sync_belt_ladder_ranks_internal(
        p_ladder_id, p_studio_id, p_sub_rank_term, p_ranks
    );
    PERFORM set_config('koaryu.rank_plan_delete', 'disabled', TRUE);
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('koaryu.rank_plan_delete', 'disabled', TRUE);
    RAISE;
END;
$$;

ALTER FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) TO service_role;

CREATE FUNCTION private.koaryu_release_critical_surface_manifest_v14()
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
)
SELECT sum(invalid)::TEXT || ':' || encode(
    extensions.digest(convert_to(string_agg(value, '|' ORDER BY value COLLATE "C"), 'UTF8'), 'sha256'),
    'hex'
)
FROM serialized;
$$;

ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v14() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v14() FROM PUBLIC, anon, authenticated, service_role;

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

    IF v_count <> 107 OR v_head <> '20260814183000' THEN
        v_failures := array_append(v_failures, 'migration_history_v14');
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
    IF private.koaryu_release_critical_surface_manifest_v14()
       <> '0:bfd43a4e7b384739a153db1f33d8074f043ca5ad4b93b86ea2129cb3fa8ce0fe' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v14');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v14';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
