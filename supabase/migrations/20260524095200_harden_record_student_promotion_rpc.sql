-- ==========================================
-- Koaryu v1 - Harden atomic student promotion RPC
-- ==========================================
--
-- The backend owns promotion orchestration, but this service-role RPC is the
-- final atomic writer. Validate the caller-supplied studio, student, program,
-- membership, and rank context before inserting the immutable promotion row.

CREATE OR REPLACE FUNCTION public.record_student_promotion(
    p_studio_id UUID,
    p_student_id UUID,
    p_student_program_membership_id UUID,
    p_program_id UUID,
    p_from_rank_id UUID,
    p_to_rank_id UUID,
    p_promoted_by UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS public.promotions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    promotion_row public.promotions%ROWTYPE;
    student_row public.students%ROWTYPE;
    membership_row public.student_program_memberships%ROWTYPE;
    target_rank_ladder_id UUID;
    target_rank_studio_id UUID;
    target_ladder_program_id UUID;
    from_rank_ladder_id UUID;
    program_studio_id UUID;
BEGIN
    SELECT *
    INTO student_row
    FROM public.students
    WHERE id = p_student_id
      AND studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found for promotion.'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT br.ladder_id, br.studio_id, bl.program_id
    INTO target_rank_ladder_id, target_rank_studio_id, target_ladder_program_id
    FROM public.belt_ranks br
    JOIN public.belt_ladders bl ON bl.id = br.ladder_id
    WHERE br.id = p_to_rank_id;

    IF target_rank_ladder_id IS NULL OR target_rank_studio_id IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Target belt rank not found for promotion.'
            USING ERRCODE = 'P0002';
    END IF;

    IF p_from_rank_id IS NOT NULL THEN
        SELECT ladder_id
        INTO from_rank_ladder_id
        FROM public.belt_ranks
        WHERE id = p_from_rank_id
          AND studio_id = p_studio_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Current belt rank not found for promotion.'
                USING ERRCODE = 'P0002';
        END IF;

        IF from_rank_ladder_id IS DISTINCT FROM target_rank_ladder_id THEN
            RAISE EXCEPTION 'Promotions must stay within one belt ladder.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_program_id IS NOT NULL THEN
        SELECT studio_id
        INTO program_studio_id
        FROM public.programs
        WHERE id = p_program_id;

        IF NOT FOUND OR program_studio_id IS DISTINCT FROM p_studio_id THEN
            RAISE EXCEPTION 'Promotion program does not belong to this studio.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF target_ladder_program_id IS NOT NULL
       AND p_program_id IS DISTINCT FROM target_ladder_program_id THEN
        RAISE EXCEPTION 'Promotion program must match the target ladder program.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_student_program_membership_id IS NOT NULL THEN
        SELECT *
        INTO membership_row
        FROM public.student_program_memberships
        WHERE id = p_student_program_membership_id
          AND studio_id = p_studio_id
          AND student_id = p_student_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student program membership not found for promotion.'
                USING ERRCODE = 'P0002';
        END IF;

        IF membership_row.ended_at IS NOT NULL THEN
            RAISE EXCEPTION 'Cannot promote an ended program membership.'
                USING ERRCODE = 'P0001';
        END IF;

        IF p_program_id IS DISTINCT FROM membership_row.program_id THEN
            RAISE EXCEPTION 'Promotion program must match the student program membership.'
                USING ERRCODE = 'P0001';
        END IF;

        IF membership_row.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student program membership rank changed before promotion.'
                USING ERRCODE = 'P0001';
        END IF;
    ELSE
        IF target_ladder_program_id IS NOT NULL THEN
            RAISE EXCEPTION 'Program-scoped promotions require a student program membership.'
                USING ERRCODE = 'P0001';
        END IF;

        IF student_row.current_belt_rank_id IS DISTINCT FROM p_from_rank_id THEN
            RAISE EXCEPTION 'Student rank changed before promotion.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    INSERT INTO public.promotions (
        studio_id,
        student_id,
        student_program_membership_id,
        program_id,
        from_rank_id,
        to_rank_id,
        promoted_by,
        notes
    )
    VALUES (
        p_studio_id,
        p_student_id,
        p_student_program_membership_id,
        p_program_id,
        p_from_rank_id,
        p_to_rank_id,
        p_promoted_by,
        p_notes
    )
    RETURNING * INTO promotion_row;

    IF p_student_program_membership_id IS NOT NULL THEN
        UPDATE public.student_program_memberships
        SET current_belt_rank_id = p_to_rank_id
        WHERE id = p_student_program_membership_id
          AND studio_id = p_studio_id
          AND student_id = p_student_id;
    END IF;

    UPDATE public.students
    SET
        current_belt_rank_id = p_to_rank_id,
        program_id = p_program_id
    WHERE id = p_student_id
      AND studio_id = p_studio_id;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        p_studio_id,
        p_promoted_by,
        'student.promoted',
        'promotion',
        promotion_row.id,
        jsonb_build_object(
            'student_id', p_student_id,
            'student_program_membership_id', p_student_program_membership_id,
            'program_id', p_program_id,
            'from_rank_id', p_from_rank_id,
            'to_rank_id', p_to_rank_id
        )
    );

    RETURN promotion_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_student_promotion(
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_student_promotion(
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    TEXT
) TO service_role;
