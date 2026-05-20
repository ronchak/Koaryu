-- ==========================================
-- Koaryu v1 — Make belt ladder sync lintable
-- ==========================================
--
-- The previous implementation used a temporary table inside PL/pgSQL. That
-- works at runtime, but Supabase's linked database lint cannot prove the temp
-- table exists and fails the release gate. Keep the same atomic behavior while
-- using local variables and CTEs instead.

DROP FUNCTION IF EXISTS sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB);

CREATE OR REPLACE FUNCTION sync_belt_ladder_ranks(
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

REVOKE ALL ON FUNCTION sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_belt_ladder_ranks(UUID, UUID, TEXT, JSONB) TO service_role;
