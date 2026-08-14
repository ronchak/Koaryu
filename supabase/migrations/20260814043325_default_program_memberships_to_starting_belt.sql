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
       AND (
           TG_OP = 'INSERT'
           OR (
               TG_OP = 'UPDATE'
               AND OLD.ended_at IS NOT NULL
               AND NEW.ended_at IS NULL
           )
       )
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

    -- Match write_student_profile_atomic's students-then-memberships lock order
    -- so a concurrent rank-plan save cannot deadlock with a profile write.
    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = NEW.studio_id
      AND EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = NEW.studio_id
            AND membership.student_id = student.id
            AND membership.program_id = target_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
            AND membership.current_belt_rank_id IS NULL
      )
    ORDER BY student.id
    FOR UPDATE;

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

-- Belt ladder sync updates survivor display orders before deleting omitted
-- ranks. Reassign holders while every rank still has its pre-sync order so a
-- survivor that shifts upward cannot be mistaken for a preceding belt.
CREATE OR REPLACE FUNCTION public.sync_belt_ladder_ranks(
    p_ladder_id UUID,
    p_studio_id UUID,
    p_sub_rank_term TEXT DEFAULT NULL,
    p_ranks JSONB DEFAULT '[]'::jsonb
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
SET search_path = public
AS $$
DECLARE
    v_submitted_rank RECORD;
    v_inserted_rank_id UUID;
    v_existing_rank_count INTEGER := 0;
    v_matching_rank_count INTEGER := 0;
    v_kept_rank_ids UUID[] := ARRAY[]::UUID[];
BEGIN
    IF p_ranks IS NULL THEN
        p_ranks := '[]'::jsonb;
    END IF;

    IF jsonb_typeof(p_ranks) <> 'array' THEN
        RAISE EXCEPTION 'Ranks payload must be a JSON array';
    END IF;

    PERFORM 1
    FROM belt_ladders ladder_to_lock
    WHERE ladder_to_lock.id = p_ladder_id
      AND ladder_to_lock.studio_id = p_studio_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Belt ladder not found';
    END IF;

    IF EXISTS (
        WITH submitted_ranks AS (
            SELECT
                submitted.ordinality::INTEGER AS row_num,
                NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id,
                BTRIM(COALESCE(submitted.rank_data->>'name', '')) AS name,
                COALESCE((submitted.rank_data->>'min_classes')::INTEGER, 0) AS min_classes,
                COALESCE((submitted.rank_data->>'min_months')::INTEGER, 0) AS min_months
            FROM jsonb_array_elements(p_ranks) WITH ORDINALITY AS submitted(rank_data, ordinality)
        )
        SELECT 1
        FROM submitted_ranks submitted_rank
        WHERE submitted_rank.name = ''
    ) THEN
        RAISE EXCEPTION 'Rank name is required';
    END IF;

    IF EXISTS (
        WITH submitted_ranks AS (
            SELECT
                submitted.ordinality::INTEGER AS row_num,
                COALESCE((submitted.rank_data->>'min_classes')::INTEGER, 0) AS min_classes,
                COALESCE((submitted.rank_data->>'min_months')::INTEGER, 0) AS min_months
            FROM jsonb_array_elements(p_ranks) WITH ORDINALITY AS submitted(rank_data, ordinality)
        )
        SELECT 1
        FROM submitted_ranks submitted_rank
        WHERE submitted_rank.min_classes < 0 OR submitted_rank.min_months < 0
    ) THEN
        RAISE EXCEPTION 'Rank requirements must be non-negative';
    END IF;

    WITH submitted_ranks AS (
        SELECT NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id
        FROM jsonb_array_elements(p_ranks) WITH ORDINALITY AS submitted(rank_data, ordinality)
    )
    SELECT COUNT(*), COUNT(DISTINCT rank_id)
    INTO v_existing_rank_count, v_matching_rank_count
    FROM submitted_ranks
    WHERE rank_id IS NOT NULL;

    IF v_existing_rank_count <> v_matching_rank_count THEN
        RAISE EXCEPTION 'Duplicate existing rank ids are not allowed';
    END IF;

    WITH submitted_ranks AS (
        SELECT NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id
        FROM jsonb_array_elements(p_ranks) WITH ORDINALITY AS submitted(rank_data, ordinality)
    )
    SELECT COUNT(*)
    INTO v_matching_rank_count
    FROM belt_ranks existing_rank
    JOIN submitted_ranks submitted_rank
      ON submitted_rank.rank_id = existing_rank.id
    WHERE submitted_rank.rank_id IS NOT NULL
      AND existing_rank.ladder_id = p_ladder_id
      AND existing_rank.studio_id = p_studio_id;

    IF v_matching_rank_count <> v_existing_rank_count THEN
        RAISE EXCEPTION 'One or more referenced rank ids do not belong to this ladder';
    END IF;

    -- Match atomic student writes' students-then-memberships lock order before
    -- changing either copy of the current rank.
    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = p_studio_id
      AND student.program_id = (
          SELECT ladder.program_id
          FROM public.belt_ladders ladder
          WHERE ladder.id = p_ladder_id
            AND ladder.studio_id = p_studio_id
      )
      AND (
          student.current_belt_rank_id IN (
              SELECT removed.id
              FROM public.belt_ranks removed
              WHERE removed.ladder_id = p_ladder_id
                AND removed.studio_id = p_studio_id
                AND NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(p_ranks) submitted(rank_data)
                    WHERE NULLIF(submitted.rank_data->>'id', '')::UUID = removed.id
                )
          )
          OR EXISTS (
              SELECT 1
              FROM public.student_program_memberships membership
              JOIN public.belt_ranks removed
                ON removed.id = membership.current_belt_rank_id
               AND removed.ladder_id = p_ladder_id
               AND removed.studio_id = p_studio_id
              WHERE membership.studio_id = p_studio_id
                AND membership.student_id = student.id
                AND membership.program_id = student.program_id
                AND membership.status IN ('active', 'paused')
                AND membership.ended_at IS NULL
                AND NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(p_ranks) submitted(rank_data)
                    WHERE NULLIF(submitted.rank_data->>'id', '')::UUID = removed.id
                )
          )
      )
    ORDER BY student.id
    FOR UPDATE;

    WITH submitted_rank_ids AS (
        SELECT NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
    ),
    removed_rank_replacements AS (
        SELECT
            removed.id AS removed_rank_id,
            replacement.id AS replacement_rank_id
        FROM public.belt_ranks removed
        LEFT JOIN LATERAL (
            SELECT kept.id
            FROM public.belt_ranks kept
            WHERE kept.ladder_id = removed.ladder_id
              AND kept.studio_id = removed.studio_id
              AND kept.is_tip = FALSE
              AND kept.id IN (
                  SELECT submitted.rank_id
                  FROM submitted_rank_ids submitted
                  WHERE submitted.rank_id IS NOT NULL
              )
              AND (kept.display_order, kept.created_at, kept.id)
                  < (removed.display_order, removed.created_at, removed.id)
            ORDER BY kept.display_order DESC, kept.created_at DESC, kept.id DESC
            LIMIT 1
        ) replacement ON TRUE
        WHERE removed.ladder_id = p_ladder_id
          AND removed.studio_id = p_studio_id
          AND removed.id NOT IN (
              SELECT submitted.rank_id
              FROM submitted_rank_ids submitted
              WHERE submitted.rank_id IS NOT NULL
          )
    )
    UPDATE public.student_program_memberships membership
    SET current_belt_rank_id = replacement.replacement_rank_id,
        updated_at = NOW()
    FROM removed_rank_replacements replacement,
         public.belt_ladders ladder
    WHERE ladder.id = p_ladder_id
      AND ladder.studio_id = p_studio_id
      AND membership.studio_id = p_studio_id
      AND membership.program_id = ladder.program_id
      AND membership.current_belt_rank_id = replacement.removed_rank_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL;

    WITH submitted_rank_ids AS (
        SELECT NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
    ),
    removed_rank_replacements AS (
        SELECT
            removed.id AS removed_rank_id,
            replacement.id AS replacement_rank_id
        FROM public.belt_ranks removed
        LEFT JOIN LATERAL (
            SELECT kept.id
            FROM public.belt_ranks kept
            WHERE kept.ladder_id = removed.ladder_id
              AND kept.studio_id = removed.studio_id
              AND kept.is_tip = FALSE
              AND kept.id IN (
                  SELECT submitted.rank_id
                  FROM submitted_rank_ids submitted
                  WHERE submitted.rank_id IS NOT NULL
              )
              AND (kept.display_order, kept.created_at, kept.id)
                  < (removed.display_order, removed.created_at, removed.id)
            ORDER BY kept.display_order DESC, kept.created_at DESC, kept.id DESC
            LIMIT 1
        ) replacement ON TRUE
        WHERE removed.ladder_id = p_ladder_id
          AND removed.studio_id = p_studio_id
          AND removed.id NOT IN (
              SELECT submitted.rank_id
              FROM submitted_rank_ids submitted
              WHERE submitted.rank_id IS NOT NULL
          )
    )
    UPDATE public.students student
    SET current_belt_rank_id = replacement.replacement_rank_id,
        updated_at = NOW()
    FROM removed_rank_replacements replacement,
         public.belt_ladders ladder
    WHERE ladder.id = p_ladder_id
      AND ladder.studio_id = p_studio_id
      AND student.studio_id = p_studio_id
      AND student.program_id = ladder.program_id
      AND student.current_belt_rank_id = replacement.removed_rank_id
      AND EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = p_studio_id
            AND membership.student_id = student.id
            AND membership.program_id = ladder.program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
            AND membership.current_belt_rank_id IS NOT DISTINCT FROM replacement.replacement_rank_id
      );

    UPDATE belt_ladders ladder_to_update
    SET sub_rank_term = COALESCE(NULLIF(BTRIM(p_sub_rank_term), ''), ladder_to_update.sub_rank_term),
        updated_at = NOW()
    WHERE ladder_to_update.id = p_ladder_id
      AND ladder_to_update.studio_id = p_studio_id;

    FOR v_submitted_rank IN
        SELECT
            submitted.ordinality::INTEGER AS row_num,
            NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id,
            BTRIM(COALESCE(submitted.rank_data->>'name', '')) AS name,
            COALESCE(NULLIF(submitted.rank_data->>'color_hex', ''), '#FFFFFF') AS color_hex,
            submitted.ordinality::INTEGER - 1 AS display_order,
            COALESCE((submitted.rank_data->>'min_classes')::INTEGER, 0) AS min_classes,
            COALESCE((submitted.rank_data->>'min_months')::INTEGER, 0) AS min_months,
            COALESCE((submitted.rank_data->>'requires_approval')::BOOLEAN, FALSE) AS requires_approval,
            COALESCE((submitted.rank_data->>'is_tip')::BOOLEAN, FALSE) AS is_tip,
            CASE
                WHEN COALESCE((submitted.rank_data->>'is_tip')::BOOLEAN, FALSE)
                    THEN NULLIF(submitted.rank_data->>'tip_color_hex', '')
                ELSE NULL
            END AS tip_color_hex
        FROM jsonb_array_elements(p_ranks) WITH ORDINALITY AS submitted(rank_data, ordinality)
        ORDER BY submitted.ordinality
    LOOP
        IF v_submitted_rank.rank_id IS NULL THEN
            INSERT INTO belt_ranks (
                ladder_id,
                studio_id,
                name,
                color_hex,
                display_order,
                min_classes,
                min_months,
                requires_approval,
                is_tip,
                tip_color_hex
            )
            VALUES (
                p_ladder_id,
                p_studio_id,
                v_submitted_rank.name,
                v_submitted_rank.color_hex,
                v_submitted_rank.display_order,
                v_submitted_rank.min_classes,
                v_submitted_rank.min_months,
                v_submitted_rank.requires_approval,
                v_submitted_rank.is_tip,
                v_submitted_rank.tip_color_hex
            )
            RETURNING belt_ranks.id INTO v_inserted_rank_id;

            v_kept_rank_ids := array_append(v_kept_rank_ids, v_inserted_rank_id);
        ELSE
            UPDATE belt_ranks rank_to_update
            SET name = v_submitted_rank.name,
                color_hex = v_submitted_rank.color_hex,
                display_order = v_submitted_rank.display_order,
                min_classes = v_submitted_rank.min_classes,
                min_months = v_submitted_rank.min_months,
                requires_approval = v_submitted_rank.requires_approval,
                is_tip = v_submitted_rank.is_tip,
                tip_color_hex = v_submitted_rank.tip_color_hex
            WHERE rank_to_update.id = v_submitted_rank.rank_id
              AND rank_to_update.ladder_id = p_ladder_id
              AND rank_to_update.studio_id = p_studio_id;

            v_kept_rank_ids := array_append(v_kept_rank_ids, v_submitted_rank.rank_id);
        END IF;
    END LOOP;

    DELETE FROM belt_ranks existing_rank
    WHERE existing_rank.ladder_id = p_ladder_id
      AND existing_rank.studio_id = p_studio_id
      AND NOT (existing_rank.id = ANY(v_kept_rank_ids));

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
                        'id', belt_rank.id,
                        'ladder_id', belt_rank.ladder_id,
                        'studio_id', belt_rank.studio_id,
                        'name', belt_rank.name,
                        'color_hex', belt_rank.color_hex,
                        'display_order', belt_rank.display_order,
                        'min_classes', belt_rank.min_classes,
                        'min_months', belt_rank.min_months,
                        'requires_approval', belt_rank.requires_approval,
                        'is_tip', belt_rank.is_tip,
                        'tip_color_hex', belt_rank.tip_color_hex,
                        'created_at', belt_rank.created_at
                    )
                    ORDER BY belt_rank.display_order, belt_rank.created_at, belt_rank.id
                )
                FROM belt_ranks belt_rank
                WHERE belt_rank.ladder_id = ladder.id
                  AND belt_rank.studio_id = ladder.studio_id
            ),
            '[]'::jsonb
        ) AS ranks
    FROM belt_ladders ladder
    WHERE ladder.id = p_ladder_id
      AND ladder.studio_id = p_studio_id;
END;
$$;

-- Move active assignments away from a rank before its foreign-key cascade
-- runs. Use the nearest preceding full belt so a removed tip or rank never
-- silently resets holders to the bottom of the ladder. Historical ended
-- memberships are left to the foreign key's SET NULL behavior.
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
      AND (br.display_order, br.created_at, br.id)
          < (OLD.display_order, OLD.created_at, OLD.id)
    ORDER BY br.display_order DESC, br.created_at DESC, br.id DESC
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
