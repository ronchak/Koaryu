-- Friendly Pilot Core authorization and single-studio guards.
--
-- This migration is intentionally additive and does not rewrite historical
-- memberships. Existing duplicate memberships will fail closed in the app;
-- this trigger prevents any new cross-studio membership from being linked.

CREATE OR REPLACE FUNCTION private.enforce_single_studio_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Serialize membership writes for one Auth identity so concurrent studio
    -- invitations cannot both pass the prospective conflict check.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(NEW.user_id::TEXT, 0)
    );

    IF EXISTS (
        SELECT 1
        FROM public.staff_roles AS existing_role
        WHERE existing_role.user_id = NEW.user_id
          AND existing_role.id IS DISTINCT FROM NEW.id
          AND existing_role.studio_id IS DISTINCT FROM NEW.studio_id
    ) THEN
        RAISE EXCEPTION 'Koaryu accounts can belong to only one studio.'
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.enforce_single_studio_membership()
FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_single_studio_membership
ON public.staff_roles;

CREATE TRIGGER enforce_single_studio_membership
BEFORE INSERT OR UPDATE OF user_id, studio_id
ON public.staff_roles
FOR EACH ROW
EXECUTE FUNCTION private.enforce_single_studio_membership();

-- Student billing identifiers are backend-only. All supported frontend reads
-- already use the API, so authenticated clients do not need direct table
-- SELECT privileges on this billing-bearing row shape.
REVOKE SELECT ON TABLE public.students FROM anon, authenticated;

-- Reuse the existing atomic rank transition writer, then relabel its audit
-- event in the same transaction so a demotion is always explicit and
-- distinguishable from a promotion.
CREATE OR REPLACE FUNCTION public.record_student_demotion(
    p_studio_id UUID,
    p_student_id UUID,
    p_student_program_membership_id UUID,
    p_program_id UUID,
    p_from_rank_id UUID,
    p_to_rank_id UUID,
    p_demoted_by UUID,
    p_reason TEXT
)
RETURNS public.promotions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    demotion_row public.promotions%ROWTYPE;
BEGIN
    IF NULLIF(BTRIM(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'A demotion reason is required.'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT *
    INTO demotion_row
    FROM public.record_student_promotion(
        p_studio_id,
        p_student_id,
        p_student_program_membership_id,
        p_program_id,
        p_from_rank_id,
        p_to_rank_id,
        p_demoted_by,
        BTRIM(p_reason)
    );

    UPDATE public.audit_logs
    SET
        action = 'student.demoted',
        metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
            'reason', BTRIM(p_reason)
        )
    WHERE studio_id = p_studio_id
      AND action = 'student.promoted'
      AND entity_type = 'promotion'
      AND entity_id = demotion_row.id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Failed to create the demotion audit event.'
            USING ERRCODE = 'P0001';
    END IF;

    RETURN demotion_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_student_demotion(
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_student_demotion(
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    UUID,
    TEXT
) TO service_role;
