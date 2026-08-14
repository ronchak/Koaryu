-- Preserve each retained program membership's belt rank when the atomic profile
-- writer changes the primary program, then attest the resulting writer body.

CREATE OR REPLACE FUNCTION public.write_student_profile_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_student JSONB,
    p_program_ids UUID[] DEFAULT NULL,
    p_guardians JSONB DEFAULT '[]'::JSONB,
    p_replace_programs BOOLEAN DEFAULT FALSE,
    p_audit_action TEXT DEFAULT 'student.updated'
)
RETURNS public.students
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, private
AS $$
DECLARE
    v_student JSONB := p_student;
    v_existing_program_id UUID;
    v_rank_was_supplied BOOLEAN := p_student IS NOT NULL
        AND jsonb_typeof(p_student) = 'object'
        AND p_student ? 'current_belt_rank_id';
    v_retained_membership_ranks JSONB := '{}'::JSONB;
    v_result public.students%ROWTYPE;
BEGIN
    IF (p_replace_programs AND cardinality(p_program_ids) > 0)
       OR v_rank_was_supplied THEN
        -- Match every belt-plan writer's students-then-memberships lock order.
        -- The private writer locks this row again later in the same transaction.
        PERFORM 1
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id
        FOR UPDATE;

        IF p_replace_programs AND cardinality(p_program_ids) > 0 THEN
            SELECT COALESCE(
                jsonb_object_agg(
                    locked.program_id::TEXT,
                    COALESCE(to_jsonb(locked.current_belt_rank_id), 'null'::JSONB)
                ),
                '{}'::JSONB
            )
            INTO v_retained_membership_ranks
            FROM (
                SELECT membership.program_id, membership.current_belt_rank_id
                FROM public.student_program_memberships membership
                WHERE membership.student_id = p_student_id
                  AND membership.studio_id = p_studio_id
                  AND membership.program_id = ANY(p_program_ids)
                  AND membership.status IN ('active', 'paused')
                  AND membership.ended_at IS NULL
                FOR UPDATE
            ) locked;
        ELSE
            PERFORM 1
            FROM public.student_program_memberships membership
            JOIN public.students student
              ON student.id = membership.student_id
             AND student.studio_id = membership.studio_id
             AND student.program_id = membership.program_id
            WHERE membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
              AND membership.status IN ('active', 'paused')
              AND membership.ended_at IS NULL
            FOR UPDATE OF membership;
        END IF;
    END IF;

    IF p_replace_programs
       AND cardinality(p_program_ids) > 0
       AND p_student IS NOT NULL
       AND jsonb_typeof(p_student) = 'object'
       AND NOT (p_student ? 'current_belt_rank_id') THEN
        SELECT student.program_id
        INTO v_existing_program_id
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;

        IF FOUND AND v_existing_program_id IS DISTINCT FROM p_program_ids[1] THEN
            v_student := jsonb_set(
                v_student,
                '{current_belt_rank_id}',
                'null'::JSONB,
                TRUE
            );
        END IF;
    END IF;

    SELECT *
    INTO v_result
    FROM private.write_student_profile_atomic(
        p_student_id,
        p_studio_id,
        p_actor_id,
        v_student,
        p_program_ids,
        p_guardians,
        p_replace_programs,
        p_audit_action
    );

    IF p_replace_programs AND cardinality(p_program_ids) > 0 THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = (saved.value #>> '{}')::UUID,
            updated_at = NOW()
        FROM jsonb_each(v_retained_membership_ranks) saved
        WHERE membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id
          AND membership.program_id = saved.key::UUID
          AND membership.program_id = ANY(p_program_ids)
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND membership.current_belt_rank_id IS NULL
          AND saved.value <> 'null'::JSONB
          AND (
              membership.program_id IS DISTINCT FROM p_program_ids[1]
              OR NOT v_rank_was_supplied
          )
          AND EXISTS (
              SELECT 1
              FROM public.belt_ranks rank
              JOIN public.belt_ladders ladder
                ON ladder.id = rank.ladder_id
               AND ladder.studio_id = rank.studio_id
              WHERE rank.id = (saved.value #>> '{}')::UUID
                AND rank.studio_id = p_studio_id
                AND ladder.program_id = membership.program_id
          );

        UPDATE public.students student
        SET current_belt_rank_id = membership.current_belt_rank_id,
            updated_at = NOW()
        FROM public.student_program_memberships membership
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id
          AND membership.student_id = student.id
          AND membership.studio_id = student.studio_id
          AND membership.program_id = student.program_id
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

        SELECT *
        INTO v_result
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;
    ELSIF v_rank_was_supplied THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = v_result.current_belt_rank_id,
            updated_at = NOW()
        WHERE membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id
          AND membership.program_id = v_result.program_id
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student primary program membership is missing.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN v_result;
END;
$$;

ALTER FUNCTION public.write_student_profile_atomic(
    UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.write_student_profile_atomic(
    UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_student_profile_atomic(
    UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT
) TO service_role;

-- Membership endpoints previously committed membership, compatibility-student,
-- and audit writes separately. Own the complete mutation under the same
-- students-then-memberships lock order as profile, promotion, and belt-plan
-- writers so a failure cannot leave a half-changed primary program.
CREATE FUNCTION public.mutate_student_program_membership_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_operation TEXT,
    p_membership_id UUID DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::JSONB
)
RETURNS public.student_program_memberships
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_student public.students%ROWTYPE;
    v_result public.student_program_memberships%ROWTYPE;
    v_primary public.student_program_memberships%ROWTYPE;
    v_program_id UUID;
    v_unassigned_program_id UUID;
    v_status TEXT;
    v_audit_action TEXT;
    v_audit_entity_id UUID;
BEGIN
    IF p_operation NOT IN ('add', 'update', 'remove') THEN
        RAISE EXCEPTION 'Unsupported student program membership operation.'
            USING ERRCODE = '22023';
    END IF;
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'Student program membership payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO v_student
    FROM public.students student
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id
      AND student.deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found.' USING ERRCODE = 'P0002';
    END IF;

    PERFORM 1
    FROM public.student_program_memberships membership
    WHERE membership.student_id = p_student_id
      AND membership.studio_id = p_studio_id
    ORDER BY membership.id
    FOR UPDATE;

    IF p_operation = 'add' THEN
        v_program_id := NULLIF(p_payload->>'program_id', '')::UUID;
        IF v_program_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM public.programs program
            WHERE program.id = v_program_id
              AND program.studio_id = p_studio_id
              AND program.archived_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Program does not belong to this studio or is archived.'
                USING ERRCODE = 'P0001';
        END IF;

        v_status := COALESCE(NULLIF(p_payload->>'status', ''), 'active');
        INSERT INTO public.student_program_memberships (
            studio_id,
            student_id,
            program_id,
            status,
            started_at,
            ended_at,
            current_belt_rank_id
        ) VALUES (
            p_studio_id,
            p_student_id,
            v_program_id,
            v_status,
            NULLIF(p_payload->>'started_at', '')::DATE,
            CASE
                WHEN v_status = 'ended' THEN COALESCE(NULLIF(p_payload->>'ended_at', '')::DATE, CURRENT_DATE)
                ELSE NULLIF(p_payload->>'ended_at', '')::DATE
            END,
            NULLIF(p_payload->>'current_belt_rank_id', '')::UUID
        )
        RETURNING * INTO v_result;
        v_audit_action := 'student.program_added';
        v_audit_entity_id := p_student_id;
    ELSE
        IF p_membership_id IS NULL THEN
            RAISE EXCEPTION 'Student program membership id is required.'
                USING ERRCODE = '22023';
        END IF;

        SELECT *
        INTO v_result
        FROM public.student_program_memberships membership
        WHERE membership.id = p_membership_id
          AND membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student program membership not found.'
                USING ERRCODE = 'P0002';
        END IF;

        IF p_operation = 'remove' THEN
            UPDATE public.student_program_memberships membership
            SET status = 'ended',
                ended_at = CURRENT_DATE,
                current_belt_rank_id = NULL,
                updated_at = NOW()
            WHERE membership.id = p_membership_id
              AND membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
            RETURNING * INTO v_result;
            v_audit_action := 'student.program_removed';
        ELSE
            v_status := CASE
                WHEN p_payload ? 'status' THEN NULLIF(p_payload->>'status', '')
                ELSE v_result.status
            END;
            UPDATE public.student_program_memberships membership
            SET status = v_status,
                started_at = CASE
                    WHEN p_payload ? 'started_at' THEN NULLIF(p_payload->>'started_at', '')::DATE
                    ELSE membership.started_at
                END,
                ended_at = CASE
                    WHEN v_status IN ('active', 'paused') THEN NULL
                    WHEN p_payload ? 'ended_at' THEN NULLIF(p_payload->>'ended_at', '')::DATE
                    WHEN v_status = 'ended' THEN COALESCE(membership.ended_at, CURRENT_DATE)
                    ELSE membership.ended_at
                END,
                current_belt_rank_id = CASE
                    WHEN v_status = 'ended' THEN NULL
                    WHEN p_payload ? 'current_belt_rank_id'
                        THEN NULLIF(p_payload->>'current_belt_rank_id', '')::UUID
                    ELSE membership.current_belt_rank_id
                END,
                updated_at = NOW()
            WHERE membership.id = p_membership_id
              AND membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
            RETURNING * INTO v_result;
            v_audit_action := 'student.program_updated';
        END IF;
        v_audit_entity_id := p_membership_id;
    END IF;

    SELECT membership.*
    INTO v_primary
    FROM public.student_program_memberships membership
    WHERE membership.student_id = p_student_id
      AND membership.studio_id = p_studio_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
    ORDER BY
        (membership.program_id = v_student.program_id) DESC,
        membership.created_at,
        membership.id
    LIMIT 1;

    IF NOT FOUND THEN
        SELECT program.id
        INTO v_unassigned_program_id
        FROM public.programs program
        WHERE program.studio_id = p_studio_id
          AND program.is_system = TRUE
          AND lower(program.name) = 'unassigned'
          AND program.archived_at IS NULL
        ORDER BY program.created_at, program.id
        LIMIT 1;

        IF v_unassigned_program_id IS NULL THEN
            RAISE EXCEPTION 'Unassigned program is missing for this studio.'
                USING ERRCODE = 'P0001';
        END IF;

        INSERT INTO public.student_program_memberships (
            studio_id, student_id, program_id, status, started_at
        ) VALUES (
            p_studio_id,
            p_student_id,
            v_unassigned_program_id,
            'active',
            COALESCE(v_student.membership_start_date, CURRENT_DATE)
        )
        RETURNING * INTO v_primary;
    END IF;

    UPDATE public.students student
    SET program_id = v_primary.program_id,
        current_belt_rank_id = v_primary.current_belt_rank_id,
        updated_at = NOW()
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id;

    INSERT INTO public.audit_logs (
        studio_id, actor_id, action, entity_type, entity_id, metadata
    ) VALUES (
        p_studio_id,
        p_actor_id,
        v_audit_action,
        CASE WHEN p_operation = 'add' THEN 'student' ELSE 'student_program_membership' END,
        v_audit_entity_id,
        jsonb_build_object(
            'student_id', p_student_id,
            'program_id', v_result.program_id,
            'operation', p_operation,
            'changes', p_payload
        )
    );

    RETURN v_result;
END;
$$;

ALTER FUNCTION public.mutate_student_program_membership_atomic(
    UUID, UUID, UUID, TEXT, UUID, JSONB
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_student_program_membership_atomic(
    UUID, UUID, UUID, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_student_program_membership_atomic(
    UUID, UUID, UUID, TEXT, UUID, JSONB
) TO service_role;

-- Bulk roster mutations and soft deletion must commit their audit rows in the
-- same transaction as the student write. This also gives callers an all-or-
-- nothing result instead of an ambiguous partially updated selection.
CREATE FUNCTION public.mutate_students_bulk_atomic(
    p_studio_id UUID,
    p_actor_id UUID,
    p_student_ids UUID[],
    p_operation TEXT,
    p_tags_to_add TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_tags_to_remove TEXT[] DEFAULT ARRAY[]::TEXT[],
    p_status TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_student_ids UUID[];
    v_count INTEGER;
BEGIN
    SELECT array_agg(id ORDER BY id), count(*)::INTEGER
    INTO v_student_ids, v_count
    FROM (
        SELECT DISTINCT unnest(p_student_ids) AS id
    ) requested;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'Select at least one student.' USING ERRCODE = '22023';
    END IF;
    IF p_operation NOT IN ('tags', 'status') THEN
        RAISE EXCEPTION 'Unsupported bulk student operation.' USING ERRCODE = '22023';
    END IF;
    IF p_operation = 'status' AND p_status NOT IN (
        'active', 'trialing', 'inactive', 'paused', 'canceled'
    ) THEN
        RAISE EXCEPTION 'Invalid student status.' USING ERRCODE = '22023';
    END IF;

    PERFORM 1
    FROM public.students student
    WHERE student.id = ANY(v_student_ids)
      AND student.studio_id = p_studio_id
      AND student.deleted_at IS NULL
    ORDER BY student.id
    FOR UPDATE;

    IF (SELECT count(*) FROM public.students student
        WHERE student.id = ANY(v_student_ids)
          AND student.studio_id = p_studio_id
          AND student.deleted_at IS NULL) <> v_count THEN
        RAISE EXCEPTION 'One or more selected students are no longer available.'
            USING ERRCODE = 'P0002';
    END IF;

    IF p_operation = 'status' THEN
        WITH changed AS (
            UPDATE public.students student
            SET status = p_status,
                updated_at = NOW()
            WHERE student.id = ANY(v_student_ids)
              AND student.studio_id = p_studio_id
              AND student.deleted_at IS NULL
            RETURNING student.id, student.status AS new_status
        )
        INSERT INTO public.audit_logs (
            studio_id, actor_id, action, entity_type, entity_id, metadata
        )
        SELECT p_studio_id, p_actor_id, 'student.status.bulk_updated',
               'student', changed.id,
               jsonb_build_object('new_status', changed.new_status)
        FROM changed;
    ELSE
        WITH changed AS (
            UPDATE public.students student
            SET tags = ARRAY(
                    SELECT DISTINCT tag
                    FROM unnest(
                        COALESCE(student.tags, ARRAY[]::TEXT[])
                        || COALESCE(p_tags_to_add, ARRAY[]::TEXT[])
                    ) tag
                    WHERE tag <> ''
                      AND NOT (tag = ANY(COALESCE(p_tags_to_remove, ARRAY[]::TEXT[])))
                    ORDER BY tag
                ),
                updated_at = NOW()
            WHERE student.id = ANY(v_student_ids)
              AND student.studio_id = p_studio_id
              AND student.deleted_at IS NULL
            RETURNING student.id, student.tags
        )
        INSERT INTO public.audit_logs (
            studio_id, actor_id, action, entity_type, entity_id, metadata
        )
        SELECT p_studio_id, p_actor_id, 'student.tags.bulk_updated',
               'student', changed.id,
               jsonb_build_object(
                   'tags_to_add', COALESCE(p_tags_to_add, ARRAY[]::TEXT[]),
                   'tags_to_remove', COALESCE(p_tags_to_remove, ARRAY[]::TEXT[]),
                   'resulting_tags', changed.tags
               )
        FROM changed;
    END IF;

    RETURN v_count;
END;
$$;

CREATE FUNCTION public.soft_delete_student_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM 1
    FROM public.students student
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id
      AND student.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.students student
    SET deleted_at = NOW(),
        updated_at = NOW()
    WHERE student.id = p_student_id
      AND student.studio_id = p_studio_id
      AND student.deleted_at IS NULL;

    INSERT INTO public.audit_logs (
        studio_id, actor_id, action, entity_type, entity_id, metadata
    ) VALUES (
        p_studio_id, p_actor_id, 'student.deleted', 'student', p_student_id, '{}'::JSONB
    );
    RETURN TRUE;
END;
$$;

ALTER FUNCTION public.mutate_students_bulk_atomic(
    UUID, UUID, UUID[], TEXT, TEXT[], TEXT[], TEXT
) OWNER TO postgres;
ALTER FUNCTION public.soft_delete_student_atomic(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_students_bulk_atomic(
    UUID, UUID, UUID[], TEXT, TEXT[], TEXT[], TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.soft_delete_student_atomic(UUID, UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_students_bulk_atomic(
    UUID, UUID, UUID[], TEXT, TEXT[], TEXT[], TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_student_atomic(UUID, UUID, UUID)
    TO service_role;

-- Promotion rows are immutable history, so rank-plan edits must not make their
-- foreign keys undeletable or erase the names users saw at promotion time.
ALTER TABLE public.promotions
    ADD COLUMN IF NOT EXISTS from_rank_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS from_rank_color_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS to_rank_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS to_rank_color_snapshot TEXT;

UPDATE public.promotions promotion
SET from_rank_name_snapshot = COALESCE(
        promotion.from_rank_name_snapshot,
        (SELECT rank.name FROM public.belt_ranks rank WHERE rank.id = promotion.from_rank_id)
    ),
    from_rank_color_snapshot = COALESCE(
        promotion.from_rank_color_snapshot,
        (SELECT rank.color_hex FROM public.belt_ranks rank WHERE rank.id = promotion.from_rank_id)
    ),
    to_rank_name_snapshot = COALESCE(
        promotion.to_rank_name_snapshot,
        (SELECT rank.name FROM public.belt_ranks rank WHERE rank.id = promotion.to_rank_id)
    ),
    to_rank_color_snapshot = COALESCE(
        promotion.to_rank_color_snapshot,
        (SELECT rank.color_hex FROM public.belt_ranks rank WHERE rank.id = promotion.to_rank_id)
    );

CREATE FUNCTION public.snapshot_promotion_rank_identity()
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
        NEW.from_rank_name_snapshot := COALESCE(
            NEW.from_rank_name_snapshot, OLD.from_rank_name_snapshot
        );
        NEW.from_rank_color_snapshot := COALESCE(
            NEW.from_rank_color_snapshot, OLD.from_rank_color_snapshot
        );
        NEW.to_rank_name_snapshot := COALESCE(
            NEW.to_rank_name_snapshot, OLD.to_rank_name_snapshot
        );
        NEW.to_rank_color_snapshot := COALESCE(
            NEW.to_rank_color_snapshot, OLD.to_rank_color_snapshot
        );
    END IF;

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

ALTER FUNCTION public.snapshot_promotion_rank_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.snapshot_promotion_rank_identity()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS snapshot_promotion_rank_identity_trigger
    ON public.promotions;
CREATE TRIGGER snapshot_promotion_rank_identity_trigger
    BEFORE INSERT OR UPDATE
    ON public.promotions
    FOR EACH ROW
    EXECUTE FUNCTION public.snapshot_promotion_rank_identity();

ALTER TABLE public.promotions
    ALTER COLUMN to_rank_id DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS promotions_from_rank_id_fkey,
    DROP CONSTRAINT IF EXISTS promotions_to_rank_id_fkey,
    ADD CONSTRAINT promotions_from_rank_id_fkey
        FOREIGN KEY (from_rank_id) REFERENCES public.belt_ranks(id) ON DELETE SET NULL,
    ADD CONSTRAINT promotions_to_rank_id_fkey
        FOREIGN KEY (to_rank_id) REFERENCES public.belt_ranks(id) ON DELETE SET NULL;

-- A Core checkout is a provider side effect, so ordinary request
-- idempotency is not enough: two callers with different headers can otherwise
-- create two subscription sessions. Store one studio-scoped reservation under
-- the subscription row lock and invalidate its epoch whenever an operator comp
-- is granted.
CREATE FUNCTION public.invalidate_core_checkout_on_comp_grant()
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
    v_session_id TEXT;
BEGIN
    IF NEW.comped IS TRUE AND OLD.comped IS DISTINCT FROM TRUE THEN
        IF COALESCE(v_old_metadata->>'core_checkout_epoch', '') ~ '^[0-9]+$' THEN
            v_epoch := (v_old_metadata->>'core_checkout_epoch')::BIGINT;
        END IF;
        v_session_id := COALESCE(
            v_old_metadata->'core_checkout_session'->>'id',
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
REVOKE ALL ON FUNCTION public.invalidate_core_checkout_on_comp_grant()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS invalidate_core_checkout_on_comp_grant_trigger
    ON public.studio_subscriptions;
CREATE TRIGGER invalidate_core_checkout_on_comp_grant_trigger
    BEFORE UPDATE OF comped ON public.studio_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.invalidate_core_checkout_on_comp_grant();

CREATE FUNCTION public.reserve_core_checkout_atomic(
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
    SELECT *
    INTO v_row
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

    v_metadata := CASE
        WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata
        ELSE '{}'::JSONB
    END;
    v_session := v_metadata->'core_checkout_session';
    IF jsonb_typeof(v_session) = 'object'
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

CREATE FUNCTION public.publish_core_checkout_atomic(
    p_studio_id UUID,
    p_reservation_token UUID,
    p_checkout_epoch BIGINT,
    p_session_id TEXT,
    p_session_url TEXT,
    p_expires_at BIGINT
)
RETURNS TABLE(
    outcome TEXT,
    session_id TEXT,
    session_url TEXT
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
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.' USING ERRCODE = 'P0002';
    END IF;

    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_reservation := v_metadata->'core_checkout_reservation';
    v_session := v_metadata->'core_checkout_session';

    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN QUERY SELECT 'comped', NULL::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    IF NULLIF(v_reservation->>'token', '')::UUID IS DISTINCT FROM p_reservation_token
       OR NULLIF(v_reservation->>'epoch', '')::BIGINT IS DISTINCT FROM p_checkout_epoch THEN
        IF jsonb_typeof(v_session) = 'object'
           AND NULLIF(v_session->>'url', '') IS NOT NULL THEN
            RETURN QUERY SELECT 'existing', v_session->>'id', v_session->>'url';
        ELSE
            RETURN QUERY SELECT 'stale', NULL::TEXT, NULL::TEXT;
        END IF;
        RETURN;
    END IF;

    UPDATE public.studio_subscriptions subscription
    SET metadata = (v_metadata - 'core_checkout_reservation')
        || jsonb_build_object(
            'core_checkout_session', jsonb_build_object(
                'state', 'published',
                'token', p_reservation_token,
                'epoch', p_checkout_epoch,
                'id', p_session_id,
                'url', p_session_url,
                'expires_at', p_expires_at,
                'created_at', NOW()
            )
        )
    WHERE subscription.studio_id = p_studio_id;

    RETURN QUERY SELECT 'published', p_session_id, p_session_url;
END;
$$;

CREATE FUNCTION public.release_core_checkout_reservation_atomic(
    p_studio_id UUID,
    p_reservation_token UUID,
    p_checkout_epoch BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_row public.studio_subscriptions%ROWTYPE;
    v_metadata JSONB;
    v_reservation JSONB;
BEGIN
    SELECT * INTO v_row
    FROM public.studio_subscriptions subscription
    WHERE subscription.studio_id = p_studio_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio subscription not found.' USING ERRCODE = 'P0002';
    END IF;
    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_reservation := v_metadata->'core_checkout_reservation';
    IF NULLIF(v_reservation->>'token', '')::UUID IS DISTINCT FROM p_reservation_token
       OR NULLIF(v_reservation->>'epoch', '')::BIGINT IS DISTINCT FROM p_checkout_epoch THEN
        RETURN FALSE;
    END IF;
    UPDATE public.studio_subscriptions subscription
    SET metadata = v_metadata - 'core_checkout_reservation'
    WHERE subscription.studio_id = p_studio_id;
    RETURN TRUE;
END;
$$;

CREATE FUNCTION public.accept_core_checkout_completion_atomic(
    p_studio_id UUID,
    p_reservation_token UUID,
    p_checkout_epoch BIGINT,
    p_session_id TEXT,
    p_event_created BIGINT
)
RETURNS BOOLEAN
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
        RETURN FALSE;
    END IF;
    IF v_row.comped IS TRUE OR v_row.status = 'comped' THEN
        RETURN FALSE;
    END IF;
    v_metadata := CASE WHEN jsonb_typeof(v_row.metadata) = 'object' THEN v_row.metadata ELSE '{}'::JSONB END;
    v_session := v_metadata->'core_checkout_session';
    IF NULLIF(v_session->>'token', '')::UUID IS DISTINCT FROM p_reservation_token
       OR NULLIF(v_session->>'epoch', '')::BIGINT IS DISTINCT FROM p_checkout_epoch
       OR v_session->>'id' IS DISTINCT FROM p_session_id THEN
        RETURN FALSE;
    END IF;
    UPDATE public.studio_subscriptions subscription
    SET metadata = jsonb_set(
        v_metadata,
        '{core_checkout_session}',
        v_session || jsonb_build_object(
            'state', 'completed',
            'completed_event_created', p_event_created
        ),
        TRUE
    )
    WHERE subscription.studio_id = p_studio_id;
    RETURN TRUE;
END;
$$;

ALTER FUNCTION public.reserve_core_checkout_atomic(UUID) OWNER TO postgres;
ALTER FUNCTION public.publish_core_checkout_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) OWNER TO postgres;
ALTER FUNCTION public.release_core_checkout_reservation_atomic(UUID, UUID, BIGINT) OWNER TO postgres;
ALTER FUNCTION public.accept_core_checkout_completion_atomic(UUID, UUID, BIGINT, TEXT, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reserve_core_checkout_atomic(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_core_checkout_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_core_checkout_reservation_atomic(UUID, UUID, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_core_checkout_completion_atomic(UUID, UUID, BIGINT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_core_checkout_atomic(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_core_checkout_atomic(UUID, UUID, BIGINT, TEXT, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_core_checkout_reservation_atomic(UUID, UUID, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_core_checkout_completion_atomic(UUID, UUID, BIGINT, TEXT, BIGINT) TO service_role;

-- A row-level DELETE trigger runs only after PostgreSQL has locked the rank
-- tuple. It therefore cannot safely wait on a student that may already be
-- waiting for a key-share lock on that rank. Keep the proven belt-plan writer
-- as the only path that may delete an assigned rank: it locks students before
-- issuing DELETE. The public wrapper scopes that authorization to the internal
-- call and removes it again before returning.
ALTER FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB)
    RENAME TO sync_belt_ladder_ranks_internal;

REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks_internal(UUID, UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_belt_ladder_ranks_internal(UUID, UUID, TEXT, JSONB)
    TO service_role;

CREATE FUNCTION public.sync_belt_ladder_ranks(
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
BEGIN
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

ALTER FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB)
    TO service_role;

-- Direct rank deletion must use the same students-then-memberships order as
-- profile, promotion and belt-plan writers. The belt-plan RPC already holds
-- these student locks before DELETE reaches this row trigger; direct callers
-- acquire them here before the trigger updates any membership.
CREATE OR REPLACE FUNCTION public.reassign_memberships_before_belt_rank_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_program_id UUID;
    replacement_rank_id UUID;
BEGIN
    SELECT ladder.program_id
    INTO target_program_id
    FROM public.belt_ladders ladder
    WHERE ladder.id = OLD.ladder_id
      AND ladder.studio_id = OLD.studio_id;

    IF target_program_id IS NULL THEN
        RETURN OLD;
    END IF;

    IF current_setting('koaryu.rank_plan_delete', TRUE) IS DISTINCT FROM 'enabled'
       AND (
           EXISTS (
               SELECT 1
               FROM public.students student
               WHERE student.studio_id = OLD.studio_id
                 AND student.program_id = target_program_id
                 AND student.current_belt_rank_id = OLD.id
           )
           OR EXISTS (
               SELECT 1
               FROM public.student_program_memberships membership
               WHERE membership.studio_id = OLD.studio_id
                 AND membership.program_id = target_program_id
                 AND membership.current_belt_rank_id = OLD.id
                 AND membership.status IN ('active', 'paused')
                 AND membership.ended_at IS NULL
           )
       ) THEN
        RAISE EXCEPTION 'Assigned belt ranks must be deleted through sync_belt_ladder_ranks.'
            USING ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = OLD.studio_id
      AND (
          (
              student.program_id = target_program_id
              AND student.current_belt_rank_id = OLD.id
          )
          OR EXISTS (
              SELECT 1
              FROM public.student_program_memberships membership
              WHERE membership.studio_id = OLD.studio_id
                AND membership.student_id = student.id
                AND membership.program_id = target_program_id
                AND membership.status IN ('active', 'paused')
                AND membership.ended_at IS NULL
                AND membership.current_belt_rank_id = OLD.id
          )
      )
    ORDER BY student.id
    FOR UPDATE;

    SELECT rank.id
    INTO replacement_rank_id
    FROM public.belt_ranks rank
    WHERE rank.ladder_id = OLD.ladder_id
      AND rank.studio_id = OLD.studio_id
      AND rank.id <> OLD.id
      AND rank.is_tip = FALSE
    ORDER BY
        ((rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)) DESC,
        CASE WHEN (rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)
            THEN rank.display_order END DESC,
        CASE WHEN (rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)
            THEN rank.created_at END DESC,
        CASE WHEN (rank.display_order, rank.created_at, rank.id)
            < (OLD.display_order, OLD.created_at, OLD.id)
            THEN rank.id END DESC,
        rank.display_order,
        rank.created_at,
        rank.id
    LIMIT 1;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = replacement_rank_id,
        updated_at = NOW()
    WHERE studio_id = OLD.studio_id
      AND program_id = target_program_id
      AND current_belt_rank_id = OLD.id
      AND status IN ('active', 'paused')
      AND ended_at IS NULL;

    UPDATE public.students
    SET current_belt_rank_id = replacement_rank_id,
        updated_at = NOW()
    WHERE studio_id = OLD.studio_id
      AND program_id = target_program_id
      AND current_belt_rank_id = OLD.id
      AND EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = OLD.studio_id
            AND membership.student_id = students.id
            AND membership.program_id = target_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
            AND membership.current_belt_rank_id IS NOT DISTINCT FROM replacement_rank_id
      );

    RETURN OLD;
END;
$$;

ALTER FUNCTION public.reassign_memberships_before_belt_rank_delete()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reassign_memberships_before_belt_rank_delete()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
WITH required_functions(signature, expected_result) AS (
    VALUES
        (
            'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        )
),
function_actual AS (
    SELECT
        format(
            '%I.%I(%s)',
            namespace.nspname,
            function.proname,
            oidvectortypes(function.proargtypes)
        ) AS signature,
        replace(pg_get_function_result(function.oid), 'public.', '') AS result_contract
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)',
          namespace.nspname,
          function.proname,
          oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.signature,
        required.expected_result,
        actual.result_contract
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
manifest_state AS (
    SELECT private.koaryu_release_student_rank_writer_manifest_v11() AS v11_manifest
),
invalid AS (
    SELECT
        count(*) FILTER (
            WHERE function.result_contract IS DISTINCT FROM function.expected_result
        ) +
        count(*) FILTER (
            WHERE manifest.v11_manifest IS DISTINCT FROM
              '0:f124f39ae1bbdc05aef61ad965b757cfd0fae56cf3a21369ad701ea4b94d23b4'
        ) AS invalid_count
    FROM function_compared function
    CROSS JOIN manifest_state manifest
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            manifest.v11_manifest || '|' || COALESCE(string_agg(
                function.signature || ':' ||
                function.expected_result || ':' ||
                COALESCE(function.result_contract, ''),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN manifest_state manifest
CROSS JOIN invalid
GROUP BY invalid.invalid_count, manifest.v11_manifest;
$$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $preflight$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_prior RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_prior
    FROM public.koaryu_release_schema_preflight_v6();

    v_failures := array_remove(
        array_remove(v_prior.security_failures, 'migration_history_v6'),
        'operational_semantic_acl_manifest_v6'
    );

    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
             FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version COLLATE "C")
                 FILTER (WHERE version < '20260727100000'))
    INTO v_count, v_head, v_pending, v_baseline
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 106
       OR v_head <> '20260814170000'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000',
           '20260801091000',
           '20260801092000',
           '20260801093000',
           '20260801094000',
           '20260801105313',
           '20260801112153',
           '20260801115044',
           '20260801123112',
           '20260801131844',
           '20260814043325',
           '20260814103046',
           '20260814105424',
           '20260814114500',
           '20260814152000',
           '20260814170000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v13');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9eb0b668ca7b3d2856bb2c118fdcd759127bea1ce9222b5ec030356b27b4d611' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v13';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V13 drift signal. V13 attests retained multi-program rank preservation, all four writer bodies and return contracts, the V9 starting-belt invariant, and migration history.';
