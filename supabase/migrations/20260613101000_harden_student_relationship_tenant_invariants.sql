-- ==========================================
-- Koaryu v1 - Student relationship tenant invariants
-- ==========================================
--
-- Service-role RPCs bypass browser RLS, so preserve tenant boundaries at the
-- database layer for legacy student program/rank fields and guardian joins.

CREATE OR REPLACE FUNCTION public.validate_student_profile_tenant_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_program_studio_id UUID;
    v_rank_studio_id UUID;
    v_rank_program_id UUID;
BEGIN
    IF NEW.program_id IS NOT NULL THEN
        SELECT studio_id
          INTO v_program_studio_id
          FROM public.programs
         WHERE id = NEW.program_id;

        IF v_program_studio_id IS NULL OR v_program_studio_id <> NEW.studio_id THEN
            RAISE EXCEPTION 'Student program does not belong to this studio.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF NEW.current_belt_rank_id IS NOT NULL THEN
        SELECT belt_rank.studio_id, ladder.program_id
          INTO v_rank_studio_id, v_rank_program_id
          FROM public.belt_ranks AS belt_rank
          JOIN public.belt_ladders AS ladder ON ladder.id = belt_rank.ladder_id
         WHERE belt_rank.id = NEW.current_belt_rank_id;

        IF v_rank_studio_id IS NULL OR v_rank_studio_id <> NEW.studio_id THEN
            RAISE EXCEPTION 'Student current belt rank does not belong to this studio.'
                USING ERRCODE = 'P0001';
        END IF;

        IF v_rank_program_id IS NOT NULL AND NEW.program_id IS DISTINCT FROM v_rank_program_id THEN
            RAISE EXCEPTION 'Student current belt rank belongs to a different program.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_student_profile_tenant_integrity_trigger ON public.students;
CREATE TRIGGER validate_student_profile_tenant_integrity_trigger
    BEFORE INSERT OR UPDATE OF studio_id, program_id, current_belt_rank_id
    ON public.students
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_student_profile_tenant_integrity();

CREATE OR REPLACE FUNCTION public.validate_student_guardian_tenant_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_student_studio_id UUID;
    v_guardian_studio_id UUID;
BEGIN
    SELECT studio_id
      INTO v_student_studio_id
      FROM public.students
     WHERE id = NEW.student_id;

    SELECT studio_id
      INTO v_guardian_studio_id
      FROM public.guardians
     WHERE id = NEW.guardian_id;

    IF v_student_studio_id IS NULL THEN
        RAISE EXCEPTION 'Student guardian link student was not found.'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_guardian_studio_id IS NULL THEN
        RAISE EXCEPTION 'Student guardian link guardian was not found.'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_student_studio_id <> v_guardian_studio_id THEN
        RAISE EXCEPTION 'Student guardian link crosses studio boundaries.'
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_student_guardian_tenant_integrity_trigger ON public.student_guardians;
CREATE TRIGGER validate_student_guardian_tenant_integrity_trigger
    BEFORE INSERT OR UPDATE OF student_id, guardian_id
    ON public.student_guardians
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_student_guardian_tenant_integrity();
