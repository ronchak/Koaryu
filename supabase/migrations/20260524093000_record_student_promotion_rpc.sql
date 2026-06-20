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
BEGIN
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

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student program membership not found for promotion.'
                USING ERRCODE = 'P0002';
        END IF;
    END IF;

    UPDATE public.students
    SET
        current_belt_rank_id = p_to_rank_id,
        program_id = p_program_id
    WHERE id = p_student_id
        AND studio_id = p_studio_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Student not found for promotion.'
            USING ERRCODE = 'P0002';
    END IF;

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
