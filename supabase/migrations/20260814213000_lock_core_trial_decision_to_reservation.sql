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
    v_metadata := (
        v_metadata
        - 'core_checkout_session'
        - 'core_checkout_invalidated_session_id'
        - 'core_checkout_invalidated_session_state'
    )
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
REVOKE ALL ON FUNCTION public.reserve_core_checkout_atomic(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_core_checkout_atomic(UUID) TO service_role;
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
    v_override_subscription_id TEXT := NULLIF(
        current_setting('koaryu.comp_live_override_subscription_id', TRUE),
        ''
    );
BEGIN
    IF NEW.comped IS TRUE AND OLD.comped IS DISTINCT FROM TRUE THEN
        v_accepted_subscription_id := v_session->>'accepted_subscription_id';
        IF v_override_subscription_id IS NOT NULL
           AND v_override_subscription_id IS NOT DISTINCT FROM v_accepted_subscription_id
           AND NEW.stripe_subscription_id IS NOT DISTINCT FROM v_override_subscription_id
           AND NEW.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused') THEN
            v_metadata := jsonb_set(
                jsonb_set(
                    v_metadata,
                    '{comp,live_subscription_override}',
                    'true'::JSONB,
                    TRUE
                ),
                '{comp,live_subscription_override_subscription_id}',
                to_jsonb(v_override_subscription_id),
                TRUE
            );
            NEW.metadata := v_metadata;
        END IF;
        IF jsonb_typeof(v_session) = 'object'
           AND v_session->>'state' = 'completed'
           AND NULLIF(v_accepted_subscription_id, '') IS NOT NULL
           AND NOT (
               NEW.stripe_subscription_id IS NOT DISTINCT FROM v_accepted_subscription_id
               AND NEW.status IN ('canceled', 'incomplete_expired')
           ) AND NOT (
               v_override_subscription_id IS NOT DISTINCT FROM v_accepted_subscription_id
               AND NEW.stripe_subscription_id IS NOT DISTINCT FROM v_override_subscription_id
               AND NEW.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')
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
                'core_checkout_invalidated_session_id', v_session_id,
                'core_checkout_invalidated_session_state', v_session->>'state'
            );
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.invalidate_core_checkout_on_comp_grant() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.invalidate_core_checkout_on_comp_grant() FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the public V1 comp RPC for mixed-version tooling.  The V2 wrapper
-- binds an explicit Core live-subscription override to the exact accepted and
-- already-projected provider subscription while holding the subscription row
-- lock; the trigger above persists that binding in comp provenance.
CREATE FUNCTION public.set_studio_comp_v2_atomic(
    p_studio_id UUID,
    p_comped BOOLEAN,
    p_reason TEXT,
    p_actor_id UUID,
    p_actor_email TEXT DEFAULT NULL,
    p_allow_live_subscription BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(
    outcome TEXT,
    subscription_status TEXT,
    comped BOOLEAN,
    stripe_subscription_id TEXT,
    metadata JSONB,
    status_normalized BOOLEAN,
    provider_status_preserved BOOLEAN
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row public.studio_subscriptions%ROWTYPE;
    v_result RECORD;
    v_session JSONB;
    v_acceptance JSONB;
    v_override_subscription_id TEXT;
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.' USING ERRCODE = 'P0002';
    END IF;

    v_session := CASE
        WHEN jsonb_typeof(v_row.metadata) = 'object'
            THEN v_row.metadata->'core_checkout_session'
        ELSE NULL
    END;
    IF p_comped IS TRUE
       AND p_allow_live_subscription IS TRUE
       AND v_row.stripe_subscription_id IS NOT NULL
       AND v_row.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')
       AND jsonb_typeof(v_session) = 'object'
       AND v_session->>'state' = 'completed'
       AND v_session->>'accepted_subscription_id' IS NOT DISTINCT FROM v_row.stripe_subscription_id THEN
        v_override_subscription_id := v_row.stripe_subscription_id;
    END IF;

    IF p_comped IS FALSE
       AND v_row.comped IS TRUE
       AND jsonb_typeof(v_row.metadata) = 'object'
       AND v_row.metadata->'comp'->>'live_subscription_override' = 'true'
       AND v_row.metadata->'comp'->>'live_subscription_override_subscription_id'
            IS NOT DISTINCT FROM v_row.stripe_subscription_id THEN
        v_override_subscription_id := v_row.stripe_subscription_id;
        v_acceptance := v_row.metadata->'core_checkout_acceptances'
            ->v_override_subscription_id;
    END IF;

    IF p_comped IS TRUE
       AND p_allow_live_subscription IS TRUE
       AND v_row.stripe_subscription_id IS NOT NULL
       AND v_row.status IN ('active', 'trialing', 'past_due', 'unpaid', 'paused')
       AND v_override_subscription_id IS NULL THEN
        RAISE EXCEPTION 'Live subscription override requires the exact accepted Core checkout binding.'
            USING ERRCODE = 'P0C02';
    END IF;

    PERFORM set_config(
        'koaryu.comp_live_override_subscription_id',
        COALESCE(v_override_subscription_id, ''),
        TRUE
    );
    SELECT * INTO v_result
    FROM public.set_studio_comp_atomic(
        p_studio_id,
        p_comped,
        p_reason,
        p_actor_id,
        p_actor_email,
        p_allow_live_subscription
    );

    -- A live-subscription comp archives the current checkout binding so the
    -- operator decision wins while the override is active. Restore that exact
    -- durable binding when the override is revoked; otherwise all later
    -- provider events would be mistaken for an unrelated historical epoch.
    IF p_comped IS FALSE
       AND v_override_subscription_id IS NOT NULL
       AND jsonb_typeof(v_acceptance) = 'object'
       AND v_acceptance->>'state' = 'completed'
       AND v_acceptance->>'accepted_subscription_id'
            IS NOT DISTINCT FROM v_override_subscription_id THEN
        UPDATE public.studio_subscriptions subscription
        SET metadata = jsonb_set(
            CASE
                WHEN jsonb_typeof(subscription.metadata) = 'object'
                    THEN subscription.metadata
                ELSE '{}'::JSONB
            END,
            '{core_checkout_session}',
            v_acceptance,
            TRUE
        )
        WHERE subscription.studio_id = p_studio_id;
    END IF;

    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id;

    RETURN QUERY SELECT
        v_result.outcome,
        v_result.subscription_status,
        v_result.comped,
        v_result.stripe_subscription_id,
        v_row.metadata,
        v_result.status_normalized,
        v_result.provider_status_preserved;
    PERFORM set_config('koaryu.comp_live_override_subscription_id', '', TRUE);
EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('koaryu.comp_live_override_subscription_id', '', TRUE);
    RAISE;
END;
$$;

ALTER FUNCTION public.set_studio_comp_v2_atomic(UUID, BOOLEAN, TEXT, UUID, TEXT, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_studio_comp_v2_atomic(UUID, BOOLEAN, TEXT, UUID, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_studio_comp_v2_atomic(UUID, BOOLEAN, TEXT, UUID, TEXT, BOOLEAN) TO service_role;

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

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';
    v_acceptances := CASE
        WHEN jsonb_typeof(v_metadata->'core_checkout_acceptances') = 'object'
            THEN v_metadata->'core_checkout_acceptances'
        ELSE '{}'::JSONB
    END;
    v_acceptance := v_acceptances->p_subscription_id;

    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        IF NOT (
            v_metadata->'comp'->>'live_subscription_override' = 'true'
            AND v_metadata->'comp'->>'live_subscription_override_subscription_id'
                IS NOT DISTINCT FROM p_subscription_id
            AND v_row.stripe_subscription_id IS NOT DISTINCT FROM p_subscription_id
            AND (
                (
                    jsonb_typeof(v_acceptance) = 'object'
                    AND v_acceptance->>'state' = 'completed'
                    AND NULLIF(v_acceptance->>'token', '')::UUID IS NOT DISTINCT FROM p_reservation_token
                    AND NULLIF(v_acceptance->>'epoch', '')::BIGINT IS NOT DISTINCT FROM p_checkout_epoch
                    AND (p_session_id IS NULL OR v_acceptance->>'id' IS NOT DISTINCT FROM p_session_id)
                ) OR (
                    jsonb_typeof(v_session) = 'object'
                    AND v_session->>'state' = 'completed'
                    AND NULLIF(v_session->>'token', '')::UUID IS NOT DISTINCT FROM p_reservation_token
                    AND NULLIF(v_session->>'epoch', '')::BIGINT IS NOT DISTINCT FROM p_checkout_epoch
                    AND (p_session_id IS NULL OR v_session->>'id' IS NOT DISTINCT FROM p_session_id)
                )
            )
        ) THEN
            RETURN 'invalid';
        END IF;
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

    IF jsonb_typeof(v_acceptance) = 'object'
       AND v_acceptance->>'state' = 'completed'
       AND NULLIF(v_acceptance->>'token', '')::UUID IS NOT DISTINCT FROM p_reservation_token
       AND NULLIF(v_acceptance->>'epoch', '')::BIGINT IS NOT DISTINCT FROM p_checkout_epoch
       AND v_acceptance->>'accepted_subscription_id' IS NOT DISTINCT FROM p_subscription_id
       AND (p_session_id IS NULL OR v_acceptance->>'id' IS NOT DISTINCT FROM p_session_id) THEN
        IF v_row.comped IS TRUE
           AND v_metadata->'comp'->>'live_subscription_override' = 'true'
           AND v_metadata->'comp'->>'live_subscription_override_subscription_id'
                IS NOT DISTINCT FROM p_subscription_id
           AND v_row.stripe_subscription_id IS NOT DISTINCT FROM p_subscription_id THEN
            RETURN 'retained_live';
        END IF;
        -- The binding is authentic, but it belongs to an earlier checkout
        -- epoch.  Callers must acknowledge it without projecting its provider
        -- state over the currently selected subscription.
        RETURN 'historical_replay';
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

-- Return the committed student plus its related response data from the same
-- transaction.  The predecessor writer remains callable during database-first
-- cutover, while the candidate avoids post-commit enrichment reads that could
-- turn a successful create/update into an ambiguous client failure.
CREATE FUNCTION public.write_student_profile_v2_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_student JSONB,
    p_program_ids UUID[] DEFAULT NULL,
    p_guardians JSONB DEFAULT '[]'::JSONB,
    p_replace_programs BOOLEAN DEFAULT FALSE,
    p_audit_action TEXT DEFAULT 'student.updated'
)
RETURNS TABLE (
    result_student JSONB,
    result_guardians JSONB,
    result_program_memberships JSONB
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_student public.students%ROWTYPE;
BEGIN
    SELECT * INTO v_student
    FROM public.write_student_profile_atomic(
        p_student_id,
        p_studio_id,
        p_actor_id,
        p_student,
        p_program_ids,
        p_guardians,
        p_replace_programs,
        p_audit_action
    );

    IF v_student.id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        to_jsonb(v_student),
        COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', guardian.id,
                    'first_name', guardian.first_name,
                    'last_name', guardian.last_name,
                    'email', guardian.email,
                    'phone', guardian.phone,
                    'relation', guardian.relation,
                    'is_primary_contact', guardian.is_primary_contact
                ) ORDER BY guardian.id
            )
            FROM public.student_guardians link
            JOIN public.guardians guardian
              ON guardian.id = link.guardian_id
             AND guardian.studio_id = p_studio_id
            WHERE link.student_id = p_student_id
        ), '[]'::JSONB),
        COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'id', membership.id,
                    'studio_id', membership.studio_id,
                    'student_id', membership.student_id,
                    'program_id', membership.program_id,
                    'program_name', program.name,
                    'program_color_hex', program.color_hex,
                    'status', membership.status,
                    'started_at', membership.started_at,
                    'ended_at', membership.ended_at,
                    'current_belt_rank_id', membership.current_belt_rank_id,
                    'current_belt_rank_name', rank.name,
                    'current_belt_rank_color', rank.color_hex,
                    'created_at', membership.created_at,
                    'updated_at', membership.updated_at
                ) ORDER BY membership.created_at, membership.id
            )
            FROM public.student_program_memberships membership
            LEFT JOIN public.programs program
              ON program.id = membership.program_id
             AND program.studio_id = membership.studio_id
            LEFT JOIN public.belt_ranks rank
              ON rank.id = membership.current_belt_rank_id
             AND rank.studio_id = membership.studio_id
            WHERE membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
        ), '[]'::JSONB);
END;
$$;

ALTER FUNCTION public.write_student_profile_v2_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.write_student_profile_v2_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_student_profile_v2_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) TO service_role;

-- One client operation ID owns the ladder mutation and its audit record.  A
-- retry waits behind an in-flight original transaction, then returns the
-- authoritative ladder without applying the rank plan or audit twice.
CREATE FUNCTION public.sync_belt_ladder_ranks_v2(
    p_ladder_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation_id UUID,
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
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_payload_hash TEXT;
    v_existing_hash TEXT;
BEGIN
    IF p_actor_id IS NULL OR p_operation_id IS NULL THEN
        RAISE EXCEPTION 'Actor and operation ID are required.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_ranks) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Rank payload must be an array.' USING ERRCODE = '22023';
    END IF;

    v_payload_hash := encode(
        extensions.digest(
            convert_to(
                p_ladder_id::TEXT || '|' || p_studio_id::TEXT || '|' ||
                COALESCE(p_sub_rank_term, '') || '|' || p_ranks::TEXT,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'belt_ladder_sync|' || p_studio_id::TEXT || '|' ||
            p_ladder_id::TEXT || '|' || p_operation_id::TEXT,
            0
        )
    );

    SELECT audit.metadata->>'payload_sha256'
    INTO v_existing_hash
    FROM public.audit_logs audit
    WHERE audit.studio_id = p_studio_id
      AND audit.action = 'belt_ladder.synced'
      AND audit.entity_type = 'belt_ladder'
      AND audit.entity_id = p_ladder_id
      AND audit.metadata->>'operation_id' = p_operation_id::TEXT
    ORDER BY audit.created_at DESC, audit.id DESC
    LIMIT 1;

    IF FOUND THEN
        IF v_existing_hash IS DISTINCT FROM v_payload_hash THEN
            RAISE EXCEPTION 'Operation ID was already used for a different ladder payload.'
                USING ERRCODE = '22023';
        END IF;

        RETURN QUERY
        SELECT
            ladder.id,
            ladder.studio_id,
            ladder.name,
            ladder.program_id,
            ladder.sub_rank_term,
            ladder.created_at,
            ladder.updated_at,
            COALESCE(
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'id', rank.id,
                            'ladder_id', rank.ladder_id,
                            'studio_id', rank.studio_id,
                            'name', rank.name,
                            'color_hex', rank.color_hex,
                            'display_order', rank.display_order,
                            'min_classes', rank.min_classes,
                            'min_months', rank.min_months,
                            'requires_approval', rank.requires_approval,
                            'is_tip', rank.is_tip,
                            'tip_color_hex', rank.tip_color_hex,
                            'created_at', rank.created_at
                        )
                        ORDER BY rank.display_order, rank.created_at, rank.id
                    )
                    FROM public.belt_ranks rank
                    WHERE rank.ladder_id = ladder.id
                      AND rank.studio_id = ladder.studio_id
                ),
                '[]'::JSONB
            )
        FROM public.belt_ladders ladder
        WHERE ladder.id = p_ladder_id
          AND ladder.studio_id = p_studio_id;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT *
    FROM public.sync_belt_ladder_ranks(
        p_ladder_id, p_studio_id, p_sub_rank_term, p_ranks
    );

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    ) VALUES (
        p_studio_id,
        p_actor_id,
        'belt_ladder.synced',
        'belt_ladder',
        p_ladder_id,
        jsonb_build_object(
            'operation_id', p_operation_id,
            'payload_sha256', v_payload_hash,
            'rank_count', jsonb_array_length(p_ranks),
            'sub_rank_term', p_sub_rank_term
        )
    );
END;
$$;

ALTER FUNCTION public.sync_belt_ladder_ranks_v2(UUID, UUID, UUID, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks_v2(UUID, UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_belt_ladder_ranks_v2(UUID, UUID, UUID, UUID, TEXT, JSONB) TO service_role;

-- Keep an invalid paid Checkout completion recoverable even when the provider
-- cancellation succeeds and the webhook is acknowledged. The receipt is
-- written under the subscription-row lock before any provider mutation.
CREATE FUNCTION public.record_core_checkout_compensation_required_atomic(
    p_studio_id UUID,
    p_session_id TEXT,
    p_subscription_id TEXT,
    p_event_created BIGINT,
    p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row public.studio_subscriptions%ROWTYPE;
    v_metadata JSONB;
    v_receipts JSONB;
BEGIN
    IF NULLIF(p_session_id, '') IS NULL
       OR NULLIF(p_subscription_id, '') IS NULL
       OR NULLIF(p_reason, '') IS NULL THEN
        RAISE EXCEPTION 'Checkout compensation identity and reason are required.'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.' USING ERRCODE = 'P0002';
    END IF;

    v_metadata := CASE
        WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata
        ELSE '{}'::JSONB
    END;
    v_receipts := CASE
        WHEN jsonb_typeof(v_metadata->'core_checkout_compensations') = 'object'
            THEN v_metadata->'core_checkout_compensations'
        ELSE '{}'::JSONB
    END;

    IF v_receipts ? p_subscription_id THEN
        IF v_receipts->p_subscription_id->>'session_id' IS DISTINCT FROM p_session_id THEN
            RAISE EXCEPTION 'Subscription compensation identity changed.'
                USING ERRCODE = '22023';
        END IF;
        RETURN FALSE;
    END IF;

    v_receipts := v_receipts || jsonb_build_object(
        p_subscription_id,
        jsonb_build_object(
            'state', 'required',
            'session_id', p_session_id,
            'subscription_id', p_subscription_id,
            'event_created', p_event_created,
            'reason', p_reason,
            'recorded_at', NOW()
        )
    );
    UPDATE public.studio_subscriptions subscription
    SET metadata = jsonb_set(
        v_metadata,
        '{core_checkout_compensations}',
        v_receipts,
        TRUE
    )
    WHERE subscription.studio_id = p_studio_id;
    RETURN TRUE;
END;
$$;

ALTER FUNCTION public.record_core_checkout_compensation_required_atomic(UUID, TEXT, TEXT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_core_checkout_compensation_required_atomic(UUID, TEXT, TEXT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_core_checkout_compensation_required_atomic(UUID, TEXT, TEXT, BIGINT, TEXT) TO service_role;

-- Rank transitions are receipt-idempotent and validate direction/adjacency
-- after taking the same student lock used by rank-plan synchronization. This
-- also keeps secondary-program transitions from overwriting the student's
-- primary compatibility fields.
ALTER TABLE public.promotions
    ADD COLUMN IF NOT EXISTS operation_id UUID,
    ADD COLUMN IF NOT EXISTS transition_kind TEXT;

ALTER TABLE public.promotions
    DROP CONSTRAINT IF EXISTS promotions_transition_kind_check;
ALTER TABLE public.promotions
    ADD CONSTRAINT promotions_transition_kind_check
    CHECK (transition_kind IS NULL OR transition_kind IN ('promotion', 'demotion'));

CREATE UNIQUE INDEX IF NOT EXISTS promotions_studio_operation_once
    ON public.promotions (studio_id, operation_id)
    WHERE operation_id IS NOT NULL;

CREATE FUNCTION private.record_student_rank_transition_v2(
    p_studio_id UUID,
    p_student_id UUID,
    p_student_program_membership_id UUID,
    p_program_id UUID,
    p_from_rank_id UUID,
    p_to_rank_id UUID,
    p_actor_id UUID,
    p_notes TEXT,
    p_transition_kind TEXT,
    p_operation_id UUID
)
RETURNS public.promotions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_transition public.promotions%ROWTYPE;
    v_student public.students%ROWTYPE;
    v_membership public.student_program_memberships%ROWTYPE;
    v_target_ladder_id UUID;
    v_target_ladder_program_id UUID;
    v_from_ladder_id UUID;
    v_from_position INTEGER;
    v_to_position INTEGER;
    v_expected_action TEXT;
BEGIN
    IF p_transition_kind NOT IN ('promotion', 'demotion') THEN
        RAISE EXCEPTION 'Rank transition kind is invalid.' USING ERRCODE = '22023';
    END IF;
    IF p_transition_kind = 'demotion' AND NULLIF(BTRIM(p_notes), '') IS NULL THEN
        RAISE EXCEPTION 'A demotion reason is required.' USING ERRCODE = 'P0001';
    END IF;
    IF p_operation_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
            hashtextextended(
                'student_rank_transition|' || p_studio_id::TEXT || '|' || p_operation_id::TEXT,
                0
            )
        );
        SELECT * INTO v_transition
        FROM public.promotions promotion
        WHERE promotion.studio_id = p_studio_id
          AND promotion.operation_id = p_operation_id;
        IF FOUND THEN
            IF v_transition.student_id IS DISTINCT FROM p_student_id
               OR v_transition.student_program_membership_id IS DISTINCT FROM p_student_program_membership_id
               OR v_transition.program_id IS DISTINCT FROM p_program_id
               OR v_transition.from_rank_id IS DISTINCT FROM p_from_rank_id
               OR v_transition.to_rank_id IS DISTINCT FROM p_to_rank_id
               OR v_transition.promoted_by IS DISTINCT FROM p_actor_id
               OR v_transition.notes IS DISTINCT FROM p_notes
               OR v_transition.transition_kind IS DISTINCT FROM p_transition_kind THEN
                RAISE EXCEPTION 'Operation ID was already used for a different rank transition.'
                    USING ERRCODE = '22023';
            END IF;
            RETURN v_transition;
        END IF;
    END IF;

    SELECT * INTO v_student
    FROM public.students student
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found for rank transition.' USING ERRCODE = 'P0002';
    END IF;

    SELECT rank.ladder_id, ladder.program_id
    INTO v_target_ladder_id, v_target_ladder_program_id
    FROM public.belt_ranks rank
    JOIN public.belt_ladders ladder ON ladder.id = rank.ladder_id
    WHERE rank.id = p_to_rank_id
      AND rank.studio_id = p_studio_id
      AND ladder.studio_id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target belt rank not found for rank transition.' USING ERRCODE = 'P0002';
    END IF;
    IF v_target_ladder_program_id IS NOT NULL
       AND p_program_id IS DISTINCT FROM v_target_ladder_program_id THEN
        RAISE EXCEPTION 'Rank transition program must match the target ladder program.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_student_program_membership_id IS NOT NULL THEN
        SELECT * INTO v_membership
        FROM public.student_program_memberships membership
        WHERE membership.id = p_student_program_membership_id
          AND membership.studio_id = p_studio_id
          AND membership.student_id = p_student_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student program membership not found for rank transition.'
                USING ERRCODE = 'P0002';
        END IF;
        IF v_membership.ended_at IS NOT NULL
           OR v_membership.status NOT IN ('active', 'paused') THEN
            RAISE EXCEPTION 'Cannot transition an inactive program membership.'
                USING ERRCODE = 'P0001';
        END IF;
        IF v_membership.program_id IS DISTINCT FROM p_program_id THEN
            RAISE EXCEPTION 'Rank transition program must match the student program membership.'
                USING ERRCODE = 'P0001';
        END IF;
        IF v_membership.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student program membership rank changed before transition.'
                USING ERRCODE = 'P0001';
        END IF;
    ELSE
        IF v_target_ladder_program_id IS NOT NULL THEN
            IF p_transition_kind = 'promotion' THEN
                RAISE EXCEPTION 'Program-scoped promotions require a student program membership.'
                    USING ERRCODE = 'P0001';
            ELSE
                RAISE EXCEPTION 'Program-scoped demotions require a student program membership.'
                    USING ERRCODE = 'P0001';
            END IF;
        END IF;
        IF v_student.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student rank changed before transition.' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_from_rank_id IS NOT NULL THEN
        SELECT rank.ladder_id INTO v_from_ladder_id
        FROM public.belt_ranks rank
        WHERE rank.id = p_from_rank_id
          AND rank.studio_id = p_studio_id;
        IF NOT FOUND OR v_from_ladder_id IS DISTINCT FROM v_target_ladder_id THEN
            RAISE EXCEPTION 'Rank transitions must stay within one belt ladder.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    WITH ordered AS (
        SELECT rank.id,
               row_number() OVER (
                   ORDER BY rank.display_order, rank.created_at, rank.id
               )::INTEGER AS position
        FROM public.belt_ranks rank
        WHERE rank.studio_id = p_studio_id
          AND rank.ladder_id = v_target_ladder_id
    )
    SELECT
        max(position) FILTER (WHERE id = p_from_rank_id),
        max(position) FILTER (WHERE id = p_to_rank_id)
    INTO v_from_position, v_to_position
    FROM ordered;

    IF v_to_position IS NULL THEN
        RAISE EXCEPTION 'Target belt rank disappeared before transition.' USING ERRCODE = 'P0002';
    END IF;
    IF p_transition_kind = 'promotion' THEN
        IF (p_from_rank_id IS NULL AND v_to_position <> 1)
           OR (p_from_rank_id IS NOT NULL AND v_to_position <> v_from_position + 1) THEN
            RAISE EXCEPTION 'Students can only be promoted to the next rank.'
                USING ERRCODE = 'P0001';
        END IF;
        v_expected_action := 'student.promoted';
    ELSE
        IF p_from_rank_id IS NULL OR v_to_position <> v_from_position - 1 THEN
            RAISE EXCEPTION 'Students can only be demoted to the previous rank.'
                USING ERRCODE = 'P0001';
        END IF;
        v_expected_action := 'student.demoted';
    END IF;

    INSERT INTO public.promotions (
        studio_id, student_id, student_program_membership_id, program_id,
        from_rank_id, to_rank_id, promoted_by, notes, operation_id, transition_kind
    ) VALUES (
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_actor_id, p_notes, p_operation_id,
        p_transition_kind
    )
    RETURNING * INTO v_transition;

    IF p_student_program_membership_id IS NOT NULL THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = p_to_rank_id
        WHERE membership.id = p_student_program_membership_id;
    END IF;
    IF p_student_program_membership_id IS NULL
       OR v_student.program_id IS NOT DISTINCT FROM p_program_id THEN
        UPDATE public.students student
        SET current_belt_rank_id = p_to_rank_id
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;
    END IF;

    INSERT INTO public.audit_logs (
        studio_id, actor_id, action, entity_type, entity_id, metadata
    ) VALUES (
        p_studio_id, p_actor_id, v_expected_action, 'promotion', v_transition.id,
        jsonb_build_object(
            'student_id', p_student_id,
            'student_program_membership_id', p_student_program_membership_id,
            'program_id', p_program_id,
            'from_rank_id', p_from_rank_id,
            'to_rank_id', p_to_rank_id,
            'operation_id', p_operation_id,
            'transition_kind', p_transition_kind
        ) || CASE
            WHEN p_transition_kind = 'demotion' THEN
                jsonb_build_object('reason', BTRIM(p_notes))
            ELSE '{}'::JSONB
        END
    );
    RETURN v_transition;
END;
$$;

ALTER FUNCTION private.record_student_rank_transition_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_student_rank_transition_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_student_rank_transition_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) TO service_role;

CREATE FUNCTION public.record_student_promotion_v2(
    p_studio_id UUID, p_student_id UUID, p_student_program_membership_id UUID,
    p_program_id UUID, p_from_rank_id UUID, p_to_rank_id UUID,
    p_promoted_by UUID, p_notes TEXT, p_operation_id UUID
)
RETURNS public.promotions
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    SELECT private.record_student_rank_transition_v2(
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_promoted_by, p_notes, 'promotion', p_operation_id
    );
$$;

CREATE FUNCTION public.record_student_demotion_v2(
    p_studio_id UUID, p_student_id UUID, p_student_program_membership_id UUID,
    p_program_id UUID, p_from_rank_id UUID, p_to_rank_id UUID,
    p_demoted_by UUID, p_reason TEXT, p_operation_id UUID
)
RETURNS public.promotions
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    SELECT private.record_student_rank_transition_v2(
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_demoted_by, p_reason, 'demotion', p_operation_id
    );
$$;

-- Mixed-version wrappers keep origin/main safe during database-first rollout.
CREATE OR REPLACE FUNCTION public.record_student_promotion(
    p_studio_id UUID, p_student_id UUID, p_student_program_membership_id UUID,
    p_program_id UUID, p_from_rank_id UUID, p_to_rank_id UUID,
    p_promoted_by UUID, p_notes TEXT DEFAULT NULL
)
RETURNS public.promotions
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    SELECT private.record_student_rank_transition_v2(
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_promoted_by, p_notes, 'promotion', NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.record_student_demotion(
    p_studio_id UUID, p_student_id UUID, p_student_program_membership_id UUID,
    p_program_id UUID, p_from_rank_id UUID, p_to_rank_id UUID,
    p_demoted_by UUID, p_reason TEXT
)
RETURNS public.promotions
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    SELECT private.record_student_rank_transition_v2(
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_demoted_by, BTRIM(p_reason), 'demotion', NULL
    );
$$;

ALTER FUNCTION public.record_student_promotion_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID) OWNER TO postgres;
ALTER FUNCTION public.record_student_demotion_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID) OWNER TO postgres;
ALTER FUNCTION public.record_student_promotion(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.record_student_demotion(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_student_promotion_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_student_demotion_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_student_promotion(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_student_demotion(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_student_promotion_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_student_demotion_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_student_promotion(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_student_demotion(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;

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

    WITH required_functions(signature) AS (
        VALUES
          ('public.reserve_core_checkout_v2_atomic(uuid)'),
          ('public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)'),
          ('public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)'),
          ('public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
          ('public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text)'),
          ('private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
          ('public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
          ('public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
          ('public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
          ('public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
          ('public.koaryu_release_schema_preflight_v2()')
    ), function_state AS (
        SELECT required.signature,
               procedure.oid,
               COALESCE(pg_get_functiondef(procedure.oid), '') AS definition,
               COALESCE(pg_get_function_result(procedure.oid), '') AS result_contract,
               COALESCE(owner.rolname, '') AS owner_name,
               COALESCE(procedure.prosecdef::TEXT, '') AS security_definer,
               COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
               COALESCE(array_to_string(procedure.proacl, ','), '') AS acl
        FROM required_functions required
        LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles owner ON owner.oid = procedure.proowner
    )
    SELECT v_invalid + COALESCE(sum((oid IS NULL)::INTEGER), 0)::INTEGER,
           'v15:' || COALESCE(v_v15, '') || '|' ||
           string_agg(
               'f:' || signature || ':' || definition || ':' || result_contract || ':' ||
               owner_name || ':' || security_definer || ':' || configuration || ':' || acl,
               '|' ORDER BY signature COLLATE "C"
           )
    INTO v_invalid, v_serialized
    FROM function_state;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
$$;

ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v16() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v16() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v3()
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
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v16');
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
       <> '0:5f89277c75be4ff15896749d0943dfd095ab9974dbaf2b32da3f825fce52e195' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v16');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v16';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v3() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v3() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v3() TO service_role;

-- Preserve the currently deployed origin/main application's exact V7 readiness
-- contract during
-- database-first cutover and rollback.  The compatibility response is emitted
-- only when the V3 check proves the real database is at exact V16; it does not
-- make a partial or drifted database look healthy.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT, pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_current RECORD;
BEGIN
    SELECT * INTO v_current
    FROM public.koaryu_release_schema_preflight_v3();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 109
       AND v_current.migration_head = '20260814213000'
       AND v_current.manifest_version = 'release-db-attestation-v16'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY SELECT
            TRUE,
            100,
            '20260801131844'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957','20260801060000',
                '20260801070000','20260801080000','20260801090000','20260801091000',
                '20260801092000','20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112','20260801131844'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v7'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        FALSE,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY['v16_compatibility_preflight']::TEXT[]),
        'release-db-attestation-v7'::TEXT;
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
