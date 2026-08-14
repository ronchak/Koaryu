-- Preserve deliberately unranked memberships when an existing full belt is
-- edited. Only creation of the first full belt, or conversion of the first tip
-- into a full belt, owns the retroactive default.
CREATE OR REPLACE FUNCTION public.backfill_starting_belt_for_program()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_program_id UUID;
BEGIN
    IF NEW.is_tip
       OR (
           TG_OP = 'UPDATE'
           AND NOT (OLD.is_tip AND NOT NEW.is_tip)
       )
       OR EXISTS (
           SELECT 1
           FROM public.belt_ranks rank
           WHERE rank.ladder_id = NEW.ladder_id
             AND rank.studio_id = NEW.studio_id
             AND rank.id <> NEW.id
             AND rank.is_tip = FALSE
       ) THEN
        RETURN NEW;
    END IF;

    SELECT ladder.program_id
    INTO target_program_id
    FROM public.belt_ladders ladder
    WHERE ladder.id = NEW.ladder_id
      AND ladder.studio_id = NEW.studio_id;

    IF target_program_id IS NULL THEN
        RETURN NEW;
    END IF;

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

    UPDATE public.student_program_memberships membership
    SET current_belt_rank_id = NEW.id,
        updated_at = NOW()
    WHERE membership.studio_id = NEW.studio_id
      AND membership.program_id = target_program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND membership.current_belt_rank_id IS NULL;

    RETURN NEW;
END;
$$;

-- A rank holder moves to the nearest preceding surviving full belt, falling
-- forward only when no predecessor survives. During a multi-row delete this
-- may temporarily select another row scheduled for deletion; that row's own
-- BEFORE DELETE trigger advances the holder again, so the final survivor is
-- authoritative without touching memberships that were already NULL.
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

-- Rank-holder reassignment now completes in the row trigger. The statement
-- trigger retains only primary-student reconciliation for the affected
-- programs and never assigns a deliberately NULL membership.
CREATE OR REPLACE FUNCTION public.backfill_starting_belt_after_rank_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM deleted_belt_ranks) THEN
        RETURN NULL;
    END IF;

    WITH affected_programs AS (
        SELECT DISTINCT ladder.studio_id, ladder.program_id
        FROM deleted_belt_ranks deleted_rank
        JOIN public.belt_ladders ladder
          ON ladder.id = deleted_rank.ladder_id
         AND ladder.studio_id = deleted_rank.studio_id
        WHERE ladder.program_id IS NOT NULL
    )
    UPDATE public.students student
    SET current_belt_rank_id = membership.current_belt_rank_id,
        updated_at = NOW()
    FROM public.student_program_memberships membership
    JOIN affected_programs affected
      ON affected.studio_id = membership.studio_id
     AND affected.program_id = membership.program_id
    WHERE student.id = membership.student_id
      AND student.studio_id = membership.studio_id
      AND student.program_id = membership.program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

    RETURN NULL;
END;
$$;

-- Perform rank replacement only through the corrected DELETE trigger. The
-- prior RPC nulled holders before deleting the old first belt, erasing the
-- distinction between those holders and memberships that were deliberately
-- unranked before the plan edit.
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
        SELECT 1
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
        WHERE BTRIM(COALESCE(submitted.rank_data->>'name', '')) = ''
    ) THEN
        RAISE EXCEPTION 'Rank name is required';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
        WHERE COALESCE((submitted.rank_data->>'min_classes')::INTEGER, 0) < 0
           OR COALESCE((submitted.rank_data->>'min_months')::INTEGER, 0) < 0
    ) THEN
        RAISE EXCEPTION 'Rank requirements must be non-negative';
    END IF;

    WITH submitted_ranks AS (
        SELECT NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
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
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
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

    -- Resolve holders against the old ladder ordering before kept ranks receive
    -- their submitted display orders. If the plan replaces every rank, leave
    -- holders on the old rows until the new rows exist and let the DELETE
    -- trigger select the final survivor.
    WITH submitted_rank_ids AS (
        SELECT NULLIF(submitted.rank_data->>'id', '')::UUID AS rank_id
        FROM jsonb_array_elements(p_ranks) submitted(rank_data)
    ),
    removed_rank_replacements AS (
        SELECT
            removed.id AS removed_rank_id,
            replacement.id AS replacement_rank_id
        FROM public.belt_ranks removed
        JOIN LATERAL (
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
            ORDER BY
                ((kept.display_order, kept.created_at, kept.id)
                    < (removed.display_order, removed.created_at, removed.id)) DESC,
                CASE WHEN (kept.display_order, kept.created_at, kept.id)
                    < (removed.display_order, removed.created_at, removed.id)
                    THEN kept.display_order END DESC,
                CASE WHEN (kept.display_order, kept.created_at, kept.id)
                    < (removed.display_order, removed.created_at, removed.id)
                    THEN kept.created_at END DESC,
                CASE WHEN (kept.display_order, kept.created_at, kept.id)
                    < (removed.display_order, removed.created_at, removed.id)
                    THEN kept.id END DESC,
                kept.display_order,
                kept.created_at,
                kept.id
            LIMIT 1
        ) replacement ON TRUE
        WHERE removed.ladder_id = p_ladder_id
          AND removed.studio_id = p_studio_id
          AND removed.id NOT IN (
              SELECT submitted.rank_id
              FROM submitted_rank_ids submitted
              WHERE submitted.rank_id IS NOT NULL
          )
    ),
    updated_memberships AS (
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
          AND membership.ended_at IS NULL
        RETURNING membership.student_id,
                  membership.program_id,
                  membership.current_belt_rank_id
    )
    UPDATE public.students student
    SET current_belt_rank_id = membership.current_belt_rank_id,
        updated_at = NOW()
    FROM updated_memberships membership
    WHERE student.id = membership.student_id
      AND student.studio_id = p_studio_id
      AND student.program_id = membership.program_id
      AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

    UPDATE belt_ladders ladder_to_update
    SET sub_rank_term = COALESCE(NULLIF(BTRIM(p_sub_rank_term), ''), ladder_to_update.sub_rank_term),
        updated_at = NOW()
    WHERE ladder_to_update.id = p_ladder_id
      AND ladder_to_update.studio_id = p_studio_id;

    FOR v_submitted_rank IN
        SELECT
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
                ladder_id, studio_id, name, color_hex, display_order,
                min_classes, min_months, requires_approval, is_tip, tip_color_hex
            ) VALUES (
                p_ladder_id, p_studio_id, v_submitted_rank.name,
                v_submitted_rank.color_hex, v_submitted_rank.display_order,
                v_submitted_rank.min_classes, v_submitted_rank.min_months,
                v_submitted_rank.requires_approval, v_submitted_rank.is_tip,
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
        COALESCE((
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
        ), '[]'::jsonb) AS ranks
    FROM belt_ladders ladder
    WHERE ladder.id = p_ladder_id
      AND ladder.studio_id = p_studio_id;
END;
$$;

-- Hosted projects can retain explicit service-role EXECUTE grants from older
-- function creation history even when a clean chain has only the owner grant.
-- These functions are trigger-only and require no direct caller privilege, so
-- converge every environment to the least-privilege state attested by V9.
REVOKE ALL ON FUNCTION public.validate_student_program_membership()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_primary_student_rank_from_membership()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backfill_starting_belt_for_program()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reassign_memberships_before_belt_rank_delete()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backfill_starting_belt_after_rank_delete()
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

    IF v_count <> 103
       OR v_head <> '20260814105424'
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
           '20260814105424'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v10');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:7e8dc46f3e4a514f694fe4ea3a1559928397c6e2cee8af2a09e5c3d07129e8b7' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v10';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V10 drift signal. V10 preserves deliberate unranked memberships, converges the trigger-only starting-belt ACL, retains the V9 invariant manifest, and advances migration history.';
