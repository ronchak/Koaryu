-- One rank command owner and immutable retained history, with exact forward attestation.
-- Apply this migration and its history registration in one guarded transaction.
DO $predecessor$
DECLARE previous RECORD;
BEGIN
    IF (SELECT encode(extensions.digest(convert_to(prosrc,'UTF8'),'sha256'),'hex')
        FROM pg_catalog.pg_proc WHERE oid='public.koaryu_release_schema_preflight_v20()'::REGPROCEDURE)
       IS DISTINCT FROM '0c3314d60a2ace254e0754a6ade3e1e61d0957dd3ea5cf096c408581e257cd4e' THEN
        RAISE EXCEPTION 'Rank command V40 requires the reviewed full V39 preflight.';
    END IF;
    SELECT * INTO previous FROM public.koaryu_release_schema_preflight_v20();
    IF previous.ready IS DISTINCT FROM TRUE OR previous.migration_count IS DISTINCT FROM 134
       OR previous.migration_head IS DISTINCT FROM '20260908080420'
       OR previous.manifest_version IS DISTINCT FROM 'release-db-attestation-v39'
       OR cardinality(previous.security_failures) IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'Rank command V40 requires exact ready V39.';
    END IF;
END;
$predecessor$;

-- Prospective command evidence shares the retained promotion's deletion lifecycle.
ALTER TABLE public.promotions
    ADD COLUMN command_fingerprint TEXT,
    ADD COLUMN command_program_id UUID,
    ADD COLUMN command_membership_id UUID,
    ADD COLUMN command_from_rank_id UUID,
    ADD CONSTRAINT promotions_command_evidence_check CHECK (
        (command_fingerprint IS NULL AND command_program_id IS NULL
            AND command_membership_id IS NULL AND command_from_rank_id IS NULL)
        OR (command_fingerprint IS NOT NULL AND command_fingerprint ~ '^v1:[0-9a-f]{64}$')
    );

CREATE FUNCTION private.rank_transition_fingerprint_v1(
    p_studio_id UUID, p_operation_id UUID, p_student_id UUID, p_actor_id UUID,
    p_to_rank_id UUID, p_from_rank_id UUID, p_program_id UUID, p_membership_id UUID,
    p_kind TEXT, p_notes TEXT
)
RETURNS TEXT LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog
AS $$
    SELECT 'v1:' || encode(extensions.digest(convert_to(jsonb_build_array(
        'rank-transition-v1', p_studio_id, p_operation_id, p_student_id, p_actor_id,
        p_to_rank_id, p_from_rank_id, p_program_id, p_membership_id, p_kind, p_notes
    )::TEXT, 'UTF8'), 'sha256'), 'hex');
$$;

CREATE OR REPLACE FUNCTION public.snapshot_promotion_rank_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_rank_name TEXT;
    v_rank_color TEXT;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.command_fingerprint IS NOT NULL AND (
            NEW.studio_id IS DISTINCT FROM OLD.studio_id
            OR NEW.student_id IS DISTINCT FROM OLD.student_id
            OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
            OR NEW.transition_kind IS DISTINCT FROM OLD.transition_kind
        ) THEN
            RAISE EXCEPTION 'A recorded rank command cannot be reassigned.' USING ERRCODE = '22023';
        END IF;
        NEW.from_rank_name_snapshot := OLD.from_rank_name_snapshot;
        NEW.from_rank_color_snapshot := OLD.from_rank_color_snapshot;
        NEW.to_rank_name_snapshot := OLD.to_rank_name_snapshot;
        NEW.to_rank_color_snapshot := OLD.to_rank_color_snapshot;
        NEW.command_fingerprint := OLD.command_fingerprint;
        NEW.command_program_id := OLD.command_program_id;
        NEW.command_membership_id := OLD.command_membership_id;
        NEW.command_from_rank_id := OLD.command_from_rank_id;
        RETURN NEW;
    END IF;

    NEW.command_program_id := NEW.program_id;
    NEW.command_membership_id := NEW.student_program_membership_id;
    NEW.command_from_rank_id := NEW.from_rank_id;
    NEW.command_fingerprint := private.rank_transition_fingerprint_v1(
        NEW.studio_id, NEW.operation_id, NEW.student_id, NEW.promoted_by,
        NEW.to_rank_id, NEW.from_rank_id, NEW.program_id,
        NEW.student_program_membership_id, NEW.transition_kind, NEW.notes
    );

    IF NEW.from_rank_id IS NOT NULL THEN
        SELECT rank.name, rank.color_hex
        INTO v_rank_name, v_rank_color
        FROM public.belt_ranks rank
        WHERE rank.id = NEW.from_rank_id
          AND rank.studio_id = NEW.studio_id;
        IF FOUND THEN
            NEW.from_rank_name_snapshot := v_rank_name;
            NEW.from_rank_color_snapshot := v_rank_color;
        END IF;
    END IF;

    IF NEW.to_rank_id IS NOT NULL THEN
        SELECT rank.name, rank.color_hex
        INTO v_rank_name, v_rank_color
        FROM public.belt_ranks rank
        WHERE rank.id = NEW.to_rank_id
          AND rank.studio_id = NEW.studio_id;
        IF FOUND THEN
            NEW.to_rank_name_snapshot := v_rank_name;
            NEW.to_rank_color_snapshot := v_rank_color;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION private.record_student_rank_transition_v3(
    p_studio_id UUID,
    p_student_id UUID,
    p_student_program_membership_id UUID,
    p_program_id UUID,
    p_from_rank_id UUID,
    p_to_rank_id UUID,
    p_actor_id UUID,
    p_notes TEXT,
    p_transition_kind TEXT,
    p_operation_id UUID,
    p_resolve_context BOOLEAN
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
    v_requested_program UUID := p_program_id;
    v_evidence_program UUID;
    v_evidence_membership UUID;
    v_evidence_from UUID;
    v_legacy_audits INTEGER;
    v_legacy_verified BOOLEAN;
BEGIN
    IF p_studio_id IS NULL OR p_student_id IS NULL OR p_to_rank_id IS NULL
       OR p_actor_id IS NULL OR p_resolve_context IS NULL
       OR (p_resolve_context AND p_operation_id IS NULL)
       OR p_transition_kind IS NULL OR p_transition_kind NOT IN ('promotion', 'demotion') THEN
        RAISE EXCEPTION 'Rank transition command is invalid.'
            USING ERRCODE = '22023', DETAIL = 'rank_transition_invalid';
    END IF;
    IF p_transition_kind = 'demotion' AND NULLIF(BTRIM(p_notes), '') IS NULL THEN
        RAISE EXCEPTION 'A demotion reason is required.'
            USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
    END IF;
    v_expected_action := CASE p_transition_kind
        WHEN 'promotion' THEN 'student.promoted' ELSE 'student.demoted' END;

    IF p_operation_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'student_rank_transition|' || p_studio_id::TEXT || '|' || p_operation_id::TEXT, 0
        ));
        SELECT * INTO v_transition FROM public.promotions promotion
        WHERE promotion.studio_id = p_studio_id AND promotion.operation_id = p_operation_id;
        IF FOUND THEN
            IF v_transition.command_fingerprint IS NOT NULL THEN
                v_evidence_program := CASE WHEN p_resolve_context
                    THEN COALESCE(p_program_id, v_transition.command_program_id) ELSE p_program_id END;
                v_evidence_membership := CASE WHEN p_resolve_context
                    THEN COALESCE(p_student_program_membership_id, v_transition.command_membership_id)
                    ELSE p_student_program_membership_id END;
                v_evidence_from := CASE WHEN p_resolve_context
                    THEN v_transition.command_from_rank_id ELSE p_from_rank_id END;
                IF v_transition.command_fingerprint IS DISTINCT FROM private.rank_transition_fingerprint_v1(
                    p_studio_id, p_operation_id, p_student_id, p_actor_id, p_to_rank_id,
                    v_evidence_from, v_evidence_program, v_evidence_membership,
                    p_transition_kind, p_notes
                ) THEN
                    RAISE EXCEPTION 'Operation ID was already used for a different rank transition.'
                        USING ERRCODE = '22023', DETAIL = 'rank_transition_conflict';
                END IF;
            ELSE
                -- The API asserts only supplied context. V2 asserts exact context/from.
                IF v_transition.student_id IS DISTINCT FROM p_student_id
                   OR v_transition.to_rank_id IS DISTINCT FROM p_to_rank_id
                   OR v_transition.promoted_by IS DISTINCT FROM p_actor_id
                   OR v_transition.transition_kind IS DISTINCT FROM p_transition_kind
                   OR v_transition.notes IS DISTINCT FROM p_notes
                   OR ((NOT p_resolve_context OR p_program_id IS NOT NULL)
                       AND v_transition.program_id IS DISTINCT FROM p_program_id)
                   OR ((NOT p_resolve_context OR p_student_program_membership_id IS NOT NULL)
                       AND v_transition.student_program_membership_id IS DISTINCT FROM p_student_program_membership_id)
                   OR (NOT p_resolve_context AND v_transition.from_rank_id IS DISTINCT FROM p_from_rank_id) THEN
                    RAISE EXCEPTION 'Operation ID was already used for a different rank transition.'
                        USING ERRCODE = '22023', DETAIL = 'rank_transition_conflict';
                END IF;
                IF NOT p_resolve_context AND (p_program_id IS NULL
                    OR p_student_program_membership_id IS NULL OR p_from_rank_id IS NULL) THEN
                    -- A nullable FK cannot prove an original null. Match one complete
                    -- transaction audit, with explicit JSON nulls rather than missing keys.
                    SELECT count(*), bool_and(
                        audit.actor_id = p_actor_id AND audit.action = v_expected_action
                        AND audit.metadata @> jsonb_build_object(
                            'student_id', p_student_id, 'operation_id', p_operation_id,
                            'transition_kind', p_transition_kind, 'program_id', p_program_id,
                            'student_program_membership_id', p_student_program_membership_id,
                            'from_rank_id', p_from_rank_id, 'to_rank_id', p_to_rank_id
                        )
                    ) INTO v_legacy_audits, v_legacy_verified FROM public.audit_logs audit
                    WHERE audit.studio_id = p_studio_id AND audit.entity_type = 'promotion'
                      AND audit.entity_id = v_transition.id;
                    IF v_legacy_audits IS DISTINCT FROM 1 OR v_legacy_verified IS DISTINCT FROM TRUE THEN
                        RAISE EXCEPTION 'The original rank transition cannot be verified; review its history before retrying.'
                            USING ERRCODE = '22023', DETAIL = 'rank_transition_conflict';
                    END IF;
                END IF;
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
        RAISE EXCEPTION 'Student not found for rank transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;

    SELECT rank.ladder_id, ladder.program_id
    INTO v_target_ladder_id, v_target_ladder_program_id
    FROM public.belt_ranks rank
    JOIN public.belt_ladders ladder ON ladder.id = rank.ladder_id
    WHERE rank.id = p_to_rank_id
      AND rank.studio_id = p_studio_id
      AND ladder.studio_id = p_studio_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target belt rank not found for rank transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;
    IF p_resolve_context THEN
        p_program_id := COALESCE(p_program_id, v_target_ladder_program_id,
            CASE WHEN p_student_program_membership_id IS NULL THEN v_student.program_id END);
    END IF;
    IF v_target_ladder_program_id IS NOT NULL
       AND p_program_id IS DISTINCT FROM v_target_ladder_program_id THEN
        RAISE EXCEPTION 'Rank transition program must match the target ladder program.'
            USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
    END IF;

    IF p_student_program_membership_id IS NOT NULL
       OR (p_resolve_context AND p_program_id IS NOT NULL) THEN
        SELECT * INTO v_membership FROM public.student_program_memberships membership
        WHERE membership.studio_id = p_studio_id AND membership.student_id = p_student_id
          AND CASE WHEN p_student_program_membership_id IS NOT NULL
              THEN membership.id = p_student_program_membership_id
              ELSE membership.program_id = p_program_id
                   AND membership.status IN ('active', 'paused') AND membership.ended_at IS NULL END
        FOR UPDATE;
        IF NOT FOUND AND p_student_program_membership_id IS NOT NULL THEN
            RAISE EXCEPTION 'Student program membership not found for rank transition.'
                USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
        END IF;
        IF FOUND THEN p_student_program_membership_id := v_membership.id; END IF;
    END IF;

    IF p_student_program_membership_id IS NOT NULL THEN
        IF v_membership.ended_at IS NOT NULL OR v_membership.status NOT IN ('active', 'paused') THEN
            RAISE EXCEPTION 'Cannot transition an inactive program membership.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        IF p_resolve_context THEN
            IF (v_requested_program IS NOT NULL AND v_membership.program_id IS DISTINCT FROM v_requested_program)
               OR (v_target_ladder_program_id IS NOT NULL
                   AND v_membership.program_id IS DISTINCT FROM v_target_ladder_program_id) THEN
                RAISE EXCEPTION 'Rank transition program must match the student program membership.'
                    USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
            END IF;
            p_program_id := v_membership.program_id;
            p_from_rank_id := v_membership.current_belt_rank_id;
        END IF;
        IF v_membership.program_id IS DISTINCT FROM p_program_id THEN
            RAISE EXCEPTION 'Rank transition program must match the student program membership.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        IF v_membership.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student program membership rank changed before transition.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
    ELSE
        IF v_target_ladder_program_id IS NOT NULL THEN
            IF p_transition_kind = 'promotion' THEN
                RAISE EXCEPTION 'Program-scoped promotions require a student program membership.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
            ELSE
                RAISE EXCEPTION 'Program-scoped demotions require a student program membership.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
            END IF;
        END IF;
        IF p_resolve_context THEN
            IF v_requested_program IS NOT NULL AND v_requested_program IS DISTINCT FROM v_student.program_id THEN
                RAISE EXCEPTION 'Student program membership not found for rank transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
            END IF;
            p_program_id := v_student.program_id;
            p_from_rank_id := v_student.current_belt_rank_id;
        END IF;
        IF v_student.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student rank changed before transition.' USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
    END IF;

    IF p_program_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.programs program
        WHERE program.id = p_program_id AND program.studio_id = p_studio_id
    ) THEN
        RAISE EXCEPTION 'Program not found in this studio for rank transition.'
            USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;

    IF p_from_rank_id IS NOT NULL THEN
        SELECT rank.ladder_id INTO v_from_ladder_id
        FROM public.belt_ranks rank
        WHERE rank.id = p_from_rank_id
          AND rank.studio_id = p_studio_id;
        IF NOT FOUND OR v_from_ladder_id IS DISTINCT FROM v_target_ladder_id THEN
            RAISE EXCEPTION 'Rank transitions must stay within one belt ladder.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
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
        RAISE EXCEPTION 'Target belt rank disappeared before transition.' USING ERRCODE = 'P0002', DETAIL = 'rank_transition_not_found';
    END IF;
    IF p_transition_kind = 'promotion' THEN
        IF (p_from_rank_id IS NULL AND v_to_position <> 1)
           OR (p_from_rank_id IS NOT NULL AND v_to_position <> v_from_position + 1) THEN
            RAISE EXCEPTION 'Students can only be promoted to the next rank.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
        END IF;
        v_expected_action := 'student.promoted';
    ELSE
        IF p_from_rank_id IS NULL OR v_to_position <> v_from_position - 1 THEN
            RAISE EXCEPTION 'Students can only be demoted to the previous rank.'
                USING ERRCODE = 'P0001', DETAIL = 'rank_transition_invalid';
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


CREATE OR REPLACE FUNCTION private.record_student_rank_transition_v2(
    p_studio_id UUID, p_student_id UUID, p_student_program_membership_id UUID,
    p_program_id UUID, p_from_rank_id UUID, p_to_rank_id UUID,
    p_actor_id UUID, p_notes TEXT, p_transition_kind TEXT, p_operation_id UUID
)
RETURNS public.promotions LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$
    SELECT private.record_student_rank_transition_v3(
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        p_from_rank_id, p_to_rank_id, p_actor_id, p_notes, p_transition_kind, p_operation_id, FALSE
    );
$$;

CREATE FUNCTION public.record_student_rank_transition_v3(
    p_studio_id UUID, p_student_id UUID, p_student_program_membership_id UUID,
    p_program_id UUID, p_to_rank_id UUID, p_actor_id UUID, p_notes TEXT,
    p_transition_kind TEXT, p_operation_id UUID
)
RETURNS public.promotions LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$
    SELECT private.record_student_rank_transition_v3(
        p_studio_id, p_student_id, p_student_program_membership_id, p_program_id,
        NULL, p_to_rank_id, p_actor_id, p_notes, p_transition_kind, p_operation_id, TRUE
    );
$$;

ALTER FUNCTION private.rank_transition_fingerprint_v1(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.rank_transition_fingerprint_v1(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.rank_transition_fingerprint_v1(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT) TO service_role;
ALTER FUNCTION private.record_student_rank_transition_v3(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_student_rank_transition_v3(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_student_rank_transition_v3(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, BOOLEAN) TO service_role;
ALTER FUNCTION private.record_student_rank_transition_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.record_student_rank_transition_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.record_student_rank_transition_v2(UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) TO service_role;
ALTER FUNCTION public.record_student_rank_transition_v3(UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_student_rank_transition_v3(UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_student_rank_transition_v3(UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID) TO service_role;
ALTER FUNCTION public.snapshot_promotion_rank_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.snapshot_promotion_rank_identity() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.koaryu_release_critical_surface_manifest_v16()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
          ('public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)'),
          ('private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
          ('private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'),
          ('private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)'),
          ('public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
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
    -- The rank-transition receipt is a schema guarantee, not only a function
    -- body: the columns carry the receipt, the partial unique index is what
    -- makes the replay lookup safe under concurrency, and the check constraint
    -- is what keeps transition_kind a closed set. V15 cannot cover any of them
    -- because they did not exist yet, so readiness has to attest them here or a
    -- hosted database missing one still reports ready while the RPC silently
    -- loses idempotency.
    ), required_columns(table_name, column_name) AS (
        VALUES
          ('promotions', 'operation_id'),
          ('promotions', 'transition_kind'),
          ('promotions', 'command_fingerprint'),
          ('promotions', 'command_program_id'),
          ('promotions', 'command_membership_id'),
          ('promotions', 'command_from_rank_id')
    ), column_state AS (
        SELECT required.table_name,
               required.column_name,
               attribute.attnum AS oid,
               COALESCE(format_type(attribute.atttypid, attribute.atttypmod), '') AS type_name,
               COALESCE(attribute.attnotnull::TEXT, '') AS not_null,
               COALESCE(pg_get_expr(default_row.adbin, default_row.adrelid), '') AS default_expression
        FROM required_columns required
        LEFT JOIN pg_attribute attribute
          ON attribute.attrelid = 'public.promotions'::regclass
         AND attribute.attname = required.column_name
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        LEFT JOIN pg_attrdef default_row ON default_row.adrelid = attribute.attrelid
          AND default_row.adnum = attribute.attnum
    ), required_indexes(name) AS (
        VALUES ('promotions_studio_operation_once')
    ), index_state AS (
        SELECT required.name,
               index_row.indexrelid AS oid,
               COALESCE(pg_get_indexdef(index_row.indexrelid), '') AS definition,
               COALESCE(index_row.indisunique::TEXT, '') AS is_unique,
               COALESCE(index_row.indisvalid::TEXT, '') AS is_valid
        FROM required_indexes required
        LEFT JOIN pg_class index_class ON index_class.relname = required.name
        LEFT JOIN pg_index index_row
          ON index_row.indexrelid = index_class.oid
         AND index_row.indrelid = 'public.promotions'::regclass
    ), required_constraints(name) AS (
        VALUES ('promotions_transition_kind_check'), ('promotions_command_evidence_check')
    ), constraint_state AS (
        SELECT required.name,
               constraint_row.oid,
               COALESCE(pg_get_constraintdef(constraint_row.oid, TRUE), '') AS definition,
               COALESCE(constraint_row.convalidated::TEXT, '') AS validated
        FROM required_constraints required
        LEFT JOIN pg_constraint constraint_row ON constraint_row.conname = required.name
          AND constraint_row.conrelid = 'public.promotions'::regclass
    ), foreign_key_state AS (
        SELECT conname AS name, pg_get_constraintdef(oid, TRUE) AS definition,
               convalidated AS validated
        FROM pg_constraint
        WHERE conrelid = 'public.promotions'::REGCLASS AND contype = 'f'
    ), serialized AS (
        SELECT 'f:' || signature || ':' || definition || ':' || result_contract || ':' ||
               owner_name || ':' || security_definer || ':' || configuration || ':' ||
               acl AS value,
               (oid IS NULL)::INTEGER AS invalid
        FROM function_state
        UNION ALL
        SELECT 'a:' || table_name || ':' || column_name || ':' || type_name || ':' || not_null || ':' || default_expression,
               (oid IS NULL)::INTEGER
        FROM column_state
        UNION ALL
        SELECT 'i:' || name || ':' || definition || ':' || is_unique || ':' || is_valid,
               (oid IS NULL OR is_unique <> 'true' OR is_valid <> 'true')::INTEGER
        FROM index_state
        UNION ALL
        SELECT 'c:' || name || ':' || definition || ':' || validated,
               (oid IS NULL OR validated <> 'true')::INTEGER
        FROM constraint_state
        UNION ALL
        -- These are the complete deletion relationships. Adding an FK to the
        -- immutable command UUIDs must change readiness, just like dropping one.
        SELECT 'fk:' || name || ':' || definition || ':' || validated::TEXT,
               (validated IS DISTINCT FROM TRUE)::INTEGER
        FROM foreign_key_state
    )
    SELECT v_invalid + COALESCE(sum(invalid), 0)::INTEGER,
           'v15:' || COALESCE(v_v15, '') || '|' ||
           string_agg(value, '|' ORDER BY value COLLATE "C")
    INTO v_invalid, v_serialized
    FROM serialized;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
$function$
;
ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v16() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v16() FROM PUBLIC, anon, authenticated, service_role;

DO $expectation$
DECLARE changed INTEGER;
BEGIN
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256 = '9f037cc4464637876016f47584d44910a6e175b2358eecb44486779273e75510'
    WHERE expectation_key = 'operational_contract_v31'
      AND expected_sha256 = 'fcaa04476824143c2aa69fc5d1722dbdd5b4459e0edb0249fbc24e89c0af417c';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'V40 requires the exact V39 operational expectation singleton.'; END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v21()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> 135 OR v_head <> '20260908133504' THEN
        v_failures := array_append(v_failures, 'migration_history_v40');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:fda64c2e37a0e6efd3c69b1167fc2056fc53b85042ced46d511312c886a961a4' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_schedule_window_manifest_v1()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '8df0d054a33defc36a16f802283cd815a6e5cfd9b1633d7aef288daa4b8158f0' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1_function');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v31_expectations
    WHERE expectation_key = 'operational_contract_v31';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1
       OR private.koaryu_release_operational_contract_v31()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v31');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname='koaryu_release_v31_expectations'
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid='private.koaryu_release_v31_expectations'::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, 'operational_contract_v31_expectation_acl');
    END IF;
    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
                ('koaryu_release_v27_expectations'),
                ('koaryu_release_v28_expectations'),
                ('koaryu_release_v29_expectations'),
                ('koaryu_release_v30_expectations')
        ), expectation_table_state AS (
            SELECT
                required.table_name,
                relation.oid,
                relation.relkind,
                relation.relrowsecurity,
                owner.rolname AS owner_name,
                COALESCE((
                    SELECT count(DISTINCT privilege.privilege_type)
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee=relation.relowner
                      AND NOT privilege.is_grantable
                      AND privilege.privilege_type IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                      )
                ), 0) AS owner_privilege_count,
                EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee<>relation.relowner
                       OR privilege.is_grantable
                       OR privilege.privilege_type NOT IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                       )
                ) AS unexpected_privilege
            FROM required_expectation_tables AS required
            LEFT JOIN pg_class AS relation
              ON relation.relname=required.table_name
             AND relation.relnamespace='private'::REGNAMESPACE
            LEFT JOIN pg_roles AS owner ON owner.oid=relation.relowner
        )
        SELECT 1
        FROM expectation_table_state
        WHERE oid IS NULL
           OR relkind<>'r'
           OR owner_name<>'postgres'
           OR NOT relrowsecurity
           OR owner_privilege_count<>8
           OR unexpected_privilege
    ) THEN
        v_failures := array_append(
            v_failures,
            'inherited_operational_contract_expectation_acl'
        );
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8ce5a3a090a1fc1d29dab85c65fe8be07d6efa9639950732d13cf88e854f91f1' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v7_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '245040e7bfe42122a551d112ec9d411999b519866e59c8cd537de02c85f9889a' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v8_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '0f34947cbc4126a929b69db07690ca4bc73fe8b5b9982190ebb6fe2ebbb2d179' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v9_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '6b14a7594f511f258d6b94863c369a67f08e142dc721429adc7cdab4d4e64f86' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v10_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8270ab9a1a4ee091e700dc6fd2d33f2af5fa79dc1de34f3afd391c626e076843' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v11_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'a70b46c8b13a88f51d795be3ae4bc759bcc14495fda1cab9629e5c9c86e66228' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '79e338cb42307acf37e395647f29dbb88df57fa8d65443cc976a30c566cff6d2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11_function');
    END IF;
    IF private.koaryu_release_operational_manifest_v11()
       <> '2efb0b2cf73beabfb219dd3642a824714c1b0619c5498ecf195071f929e651f6' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:6389e87cdb8a5db79c540f38da4fdc71aa56ed10fa5d5533518f470bf52f7dfc' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6ee84c579e50be2b514ac00c975c1f60cf5f116e36adc27fe4296312e5188090' THEN
        v_failures:=array_append(v_failures,'resource_ownership_manifest_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6b54e02534f38bcd7bb6e6e811d9e01c9782958319514fee3f0a2f1d4ed167d4' THEN
        v_failures:=array_append(v_failures,'operational_contract_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'b16b633c6f78a2d5cf7d63f1d32679563ff2429197cc92a4d94e826b33a26035' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28_function');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
        v_failures := array_append(v_failures, 'operational_contract_v26');
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6500b8aaf8bb91cc91841f2bafaf3699b7ffa328ccaba4a0023721e3eb68f811' THEN
        v_failures := array_append(v_failures, 'operation_authorization_writer_function');
    END IF;
    IF has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, 'legacy_authorization_scope_execute');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND conname = 'studio_live_billing_authorizations_operation_set_exact'
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_constraint');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'text[]'
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'ARRAY[]::text[]'
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_column');
    END IF;
    IF private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.release',
                'connected_subscription_schedule.update'
            ]::TEXT[]
       ) IS DISTINCT FROM true
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.update',
                'connected_subscription_schedule.create'
            ]::TEXT[]
       ) IS DISTINCT FROM false
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.unknown'
            ]::TEXT[]
       ) IS DISTINCT FROM false THEN
        v_failures := array_append(
            v_failures,'operation_allowlist_schedule_semantics'
        );
    END IF;
    IF private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM '27cb3807a6ff60653fc0c7423428710a2c01d9254c1e5f59c0e2cb16c37f4d26' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '57a017e4e7be92f023d31dc4a18e75b95c676765f42b54f9f5fb9f4b768ca3bd' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    IF private.koaryu_release_invoice_retry_preread_manifest_v32()
           <> '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
            v_failures := array_append(
                v_failures,'invoice_retry_preread_manifest_v32'
            );
        END IF;
        IF private.koaryu_release_invoice_retry_compatibility_manifest_v33()
       <> '0:8497daa806dcd7e33992fe8ca76f3207eb36b41e5a976be781e3bf33b22d4fdb' THEN
      v_failures:=array_append(v_failures,'invoice_retry_compatibility_manifest_v33');
    END IF;
    IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
       <> '0:d054ae0cf5ce43ce2c241ca628e0724b5239bd696c323ba9c817b8bd21ee0eec' THEN
      v_failures:=array_append(v_failures,'invoice_retry_closeout_manifest_v34');
    END IF;
    IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_manifest_v35');
    END IF;
    IF has_function_privilege('anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR has_function_privilege('authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR NOT has_function_privilege('service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE') THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_acl_v35');
    END IF;
    IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    IS DISTINCT FROM (SELECT recovery_manifest FROM private.koaryu_release_v36_expectations WHERE singleton) THEN
   v_failures:=array_append(v_failures,'payer_setup_recovery_manifest_v36');
 END IF;
 IF private.koaryu_release_adjustment_trigger_guard_manifest_v37()
      IS DISTINCT FROM (
        SELECT trigger_guard_manifest
        FROM private.koaryu_release_v37_expectations
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,'adjustment_trigger_guard_manifest_v37');
   END IF;
   
 IF EXISTS (
  SELECT 1 FROM (VALUES
  ('public.billing_payment_cohort(uuid,timestamptz,timestamptz)','5d6f683e3c56fe05db7e4101073d1a23792081192219cfa9eda4db8dcf734a1d'),
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','7adf5dc3a58e5f96aa87c3a4c1e4f509b081e97185a104e8d8239ad1fae2a222'),
  ('public.billing_webhook_health(text,boolean,timestamptz)','3bdcc77c7d768e5ede8750900c0b75ac98bdffbb14ada059c580185133a9fd52')
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,'billing_landing_reads_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.idx_billing_invoices_studio_history','public.billing_invoices','CREATE INDEX idx_billing_invoices_studio_history ON public.billing_invoices USING btree (studio_id, created_at DESC, id DESC)'),
   ('public.idx_billing_payments_studio_history','public.billing_payments','CREATE INDEX idx_billing_payments_studio_history ON public.billing_payments USING btree (studio_id, created_at DESC, id DESC)')
  ) expected(index_name,table_name,definition)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(expected.index_name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.oid IS NULL OR c.relkind<>'i' OR c.relowner<>'postgres'::regrole
   OR i.indrelid IS DISTINCT FROM to_regclass(expected.table_name)
   OR i.indisvalid IS DISTINCT FROM true OR i.indisready IS DISTINCT FROM true
   OR i.indislive IS DISTINCT FROM true OR i.indisunique IS DISTINCT FROM false
   OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM expected.definition
 ) THEN v_failures:=array_append(v_failures,'billing_history_indexes_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid='private.koaryu_release_critical_surface_manifest_v16()'::REGPROCEDURE
    AND (p.proowner <> 'postgres'::REGROLE OR p.prosecdef OR p.provolatile <> 's'
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
         IS DISTINCT FROM '7fb0ba103de76167982cc96f0698d7516418ababb0892dc70d5c85e1d83efc0f'
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee <> p.proowner))
 ) THEN v_failures:=array_append(v_failures,'rank_command_manifest_v40_definition'); END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v40'::TEXT;
END;
$function$
;
-- V20 presents its historical tuple only after full V21 proves the new state.
-- The existing V19 and V18 adapters remain byte-for-byte unchanged.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v20()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v21();
    IF v.ready IS TRUE AND v.migration_count = 135 AND v.migration_head = '20260908133504'
       AND v.manifest_version = 'release-db-attestation-v40'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 51
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260908133504' THEN
        RETURN QUERY SELECT TRUE, 134, '20260908080420'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v39'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v39'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v21() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v21() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v21() TO service_role;
ALTER FUNCTION public.koaryu_release_schema_preflight_v20() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v20() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v20() TO service_role;

DO $derived$
BEGIN
    IF private.koaryu_release_critical_surface_manifest_v18() IS DISTINCT FROM '0:ffffe870f71abab5b1def36d5a496d2d5efa508204a773992c6d5fbe7aecae80' THEN
        RAISE EXCEPTION 'V40 critical_surface_manifest_v18 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_operational_manifest_v11() IS DISTINCT FROM '2efb0b2cf73beabfb219dd3642a824714c1b0619c5498ecf195071f929e651f6' THEN
        RAISE EXCEPTION 'V40 operational_manifest_v11 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31() IS DISTINCT FROM '0:fda64c2e37a0e6efd3c69b1167fc2056fc53b85042ced46d511312c886a961a4' THEN
        RAISE EXCEPTION 'V40 resource_ownership_manifest_v31 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_operational_contract_v31() IS DISTINCT FROM '0:9f037cc4464637876016f47584d44910a6e175b2358eecb44486779273e75510' THEN
        RAISE EXCEPTION 'V40 operational_contract_v31 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_operational_manifest_v12() IS DISTINCT FROM '27cb3807a6ff60653fc0c7423428710a2c01d9254c1e5f59c0e2cb16c37f4d26' THEN
        RAISE EXCEPTION 'V40 operational_manifest_v12 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v11() IS DISTINCT FROM '0:ba8bf9c6e32248c80d8621c29e4d9c062bb99bbc8e69da1533765a05931a26a9' THEN
        RAISE EXCEPTION 'V40 student_rank_writer_manifest_v11 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13() IS DISTINCT FROM '0:3201f4586df300ab113e7db82b6cead45d3ea3bc1add1ebc473625deaf80a702' THEN
        RAISE EXCEPTION 'V40 student_rank_writer_manifest_v13 does not match the reviewed state.';
    END IF;
END;
$derived$;
