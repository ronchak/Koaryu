-- Assign active program memberships to their first full belt whenever callers
-- omit a rank. This keeps imports, lead conversions, and individual student
-- writes on the same invariant while still allowing a program to have an empty
-- rank plan during initial setup.

CREATE OR REPLACE FUNCTION public.validate_student_program_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    student_studio UUID;
    program_studio UUID;
    rank_studio UUID;
    rank_program UUID;
BEGIN
    SELECT studio_id
    INTO student_studio
    FROM public.students
    WHERE id = NEW.student_id;

    IF student_studio IS NULL OR student_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: student does not belong to this studio';
    END IF;

    SELECT studio_id
    INTO program_studio
    FROM public.programs
    WHERE id = NEW.program_id;

    IF program_studio IS NULL OR program_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: program does not belong to this studio';
    END IF;

    IF NEW.current_belt_rank_id IS NULL
       AND NEW.status IN ('active', 'paused')
       AND NEW.ended_at IS NULL
       AND pg_trigger_depth() = 1 THEN
        SELECT br.id
        INTO NEW.current_belt_rank_id
        FROM public.belt_ladders bl
        JOIN public.belt_ranks br
          ON br.ladder_id = bl.id
         AND br.studio_id = bl.studio_id
        WHERE bl.studio_id = NEW.studio_id
          AND bl.program_id = NEW.program_id
          AND br.is_tip = FALSE
        ORDER BY br.display_order, br.created_at, br.id
        LIMIT 1;
    END IF;

    IF NEW.current_belt_rank_id IS NOT NULL THEN
        SELECT br.studio_id, bl.program_id
        INTO rank_studio, rank_program
        FROM public.belt_ranks br
        JOIN public.belt_ladders bl ON bl.id = br.ladder_id
        WHERE br.id = NEW.current_belt_rank_id;

        IF rank_studio IS NULL OR rank_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'BELT_PROGRAM_MISMATCH: belt rank does not belong to this studio';
        END IF;

        IF rank_program IS NOT NULL AND rank_program <> NEW.program_id THEN
            RAISE EXCEPTION 'BELT_PROGRAM_MISMATCH: belt rank belongs to a different program';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- The students table retains the primary-program rank for compatibility with
-- older reads. Populate that field when the membership default supplies it.
CREATE OR REPLACE FUNCTION public.sync_primary_student_rank_from_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.current_belt_rank_id IS NOT NULL
       AND NEW.status IN ('active', 'paused')
       AND NEW.ended_at IS NULL THEN
        UPDATE public.students
        SET current_belt_rank_id = NEW.current_belt_rank_id,
            updated_at = NOW()
        WHERE id = NEW.student_id
          AND studio_id = NEW.studio_id
          AND program_id = NEW.program_id
          AND current_belt_rank_id IS NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_primary_student_rank_from_membership_trigger
    ON public.student_program_memberships;
CREATE TRIGGER sync_primary_student_rank_from_membership_trigger
    AFTER INSERT OR UPDATE OF current_belt_rank_id, status, ended_at
    ON public.student_program_memberships
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_primary_student_rank_from_membership();

-- Programs can be created before their rank plan. As soon as a full belt is
-- added, fill every still-unassigned active membership with the first full belt
-- in the plan. Explicit rank assignments remain untouched.
CREATE OR REPLACE FUNCTION public.backfill_starting_belt_for_program()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_program_id UUID;
    starting_rank_id UUID;
BEGIN
    SELECT bl.program_id
    INTO target_program_id
    FROM public.belt_ladders bl
    WHERE bl.id = NEW.ladder_id
      AND bl.studio_id = NEW.studio_id;

    IF target_program_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT br.id
    INTO starting_rank_id
    FROM public.belt_ranks br
    WHERE br.ladder_id = NEW.ladder_id
      AND br.studio_id = NEW.studio_id
      AND br.is_tip = FALSE
    ORDER BY br.display_order, br.created_at, br.id
    LIMIT 1;

    IF starting_rank_id IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = starting_rank_id,
        updated_at = NOW()
    WHERE studio_id = NEW.studio_id
      AND program_id = target_program_id
      AND status IN ('active', 'paused')
      AND ended_at IS NULL
      AND current_belt_rank_id IS NULL;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS backfill_starting_belt_for_program_trigger
    ON public.belt_ranks;
CREATE TRIGGER backfill_starting_belt_for_program_trigger
    AFTER INSERT OR UPDATE OF ladder_id, studio_id, display_order, is_tip
    ON public.belt_ranks
    FOR EACH ROW
    EXECUTE FUNCTION public.backfill_starting_belt_for_program();

-- Move assignments away from a rank before its foreign-key cascade runs. If a
-- replacement full belt exists, use the first one; otherwise leave the program
-- membership unassigned until a later full belt is created.
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
    SELECT bl.program_id
    INTO target_program_id
    FROM public.belt_ladders bl
    WHERE bl.id = OLD.ladder_id
      AND bl.studio_id = OLD.studio_id;

    IF target_program_id IS NULL THEN
        RETURN OLD;
    END IF;

    SELECT br.id
    INTO replacement_rank_id
    FROM public.belt_ranks br
    WHERE br.ladder_id = OLD.ladder_id
      AND br.studio_id = OLD.studio_id
      AND br.id <> OLD.id
      AND br.is_tip = FALSE
    ORDER BY br.display_order, br.created_at, br.id
    LIMIT 1;

    UPDATE public.student_program_memberships
    SET current_belt_rank_id = replacement_rank_id,
        updated_at = NOW()
    WHERE studio_id = OLD.studio_id
      AND program_id = target_program_id
      AND current_belt_rank_id = OLD.id;

    UPDATE public.students
    SET current_belt_rank_id = replacement_rank_id,
        updated_at = NOW()
    WHERE studio_id = OLD.studio_id
      AND program_id = target_program_id
      AND current_belt_rank_id = OLD.id;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS reassign_memberships_before_belt_rank_delete_trigger
    ON public.belt_ranks;
CREATE TRIGGER reassign_memberships_before_belt_rank_delete_trigger
    BEFORE DELETE ON public.belt_ranks
    FOR EACH ROW
    EXECUTE FUNCTION public.reassign_memberships_before_belt_rank_delete();

-- Repair any unassigned memberships that predate this migration and already
-- have a configured starting belt.
WITH starting_ranks AS (
    SELECT DISTINCT ON (bl.studio_id, bl.program_id)
        bl.studio_id,
        bl.program_id,
        br.id AS rank_id
    FROM public.belt_ladders bl
    JOIN public.belt_ranks br
      ON br.ladder_id = bl.id
     AND br.studio_id = bl.studio_id
    WHERE bl.program_id IS NOT NULL
      AND br.is_tip = FALSE
    ORDER BY bl.studio_id, bl.program_id, br.display_order, br.created_at, br.id
)
UPDATE public.student_program_memberships membership
SET current_belt_rank_id = starting_ranks.rank_id,
    updated_at = NOW()
FROM starting_ranks
WHERE membership.studio_id = starting_ranks.studio_id
  AND membership.program_id = starting_ranks.program_id
  AND membership.status IN ('active', 'paused')
  AND membership.ended_at IS NULL
  AND membership.current_belt_rank_id IS NULL;

REVOKE ALL ON FUNCTION public.sync_primary_student_rank_from_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_starting_belt_for_program() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reassign_memberships_before_belt_rank_delete() FROM PUBLIC;

-- Advance the exact-head operational readiness signal with this migration.
-- The V7 semantic/ACL manifest is intentionally reused because its billing and
-- release-control object scope is unchanged by the student/belt invariant.
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

    IF v_count <> 101
       OR v_head <> '20260814043325'
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
           '20260814043325'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v8');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v8';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V8 drift signal. V8 advances migration history while retaining the V7 runtime-invariant semantic and least-privilege ACL manifest.';
