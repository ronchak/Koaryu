-- Koaryu Program/Ladder Unification Verification
-- Fails when program, ladder, membership, or promotion rows drift from the
-- unified program-ladder contract.

DO $$
DECLARE
    v_failures JSONB;
BEGIN
    WITH failures AS (
        SELECT
            'active_program_without_ladder' AS check_name,
            p.studio_id::TEXT AS studio_id,
            p.id::TEXT AS entity_id,
            jsonb_build_object('program_name', p.name) AS details
        FROM programs p
        WHERE p.archived_at IS NULL
          AND COALESCE(p.is_system, false) = false
          AND NOT EXISTS (
              SELECT 1
              FROM belt_ladders bl
              WHERE bl.studio_id = p.studio_id
                AND bl.program_id = p.id
          )

        UNION ALL

        SELECT
            'unscoped_ladder' AS check_name,
            bl.studio_id::TEXT AS studio_id,
            bl.id::TEXT AS entity_id,
            jsonb_build_object('ladder_name', bl.name) AS details
        FROM belt_ladders bl
        WHERE bl.program_id IS NULL

        UNION ALL

        SELECT
            'duplicate_ladder_for_program' AS check_name,
            bl.studio_id::TEXT AS studio_id,
            bl.program_id::TEXT AS entity_id,
            jsonb_build_object(
                'ladder_count', count(*),
                'ladder_ids', array_agg(bl.id ORDER BY bl.created_at, bl.id)
            ) AS details
        FROM belt_ladders bl
        WHERE bl.program_id IS NOT NULL
        GROUP BY bl.studio_id, bl.program_id
        HAVING count(*) > 1

        UNION ALL

        SELECT
            'ladder_program_tenant_mismatch' AS check_name,
            bl.studio_id::TEXT AS studio_id,
            bl.id::TEXT AS entity_id,
            jsonb_build_object(
                'ladder_program_id', bl.program_id,
                'program_studio_id', p.studio_id
            ) AS details
        FROM belt_ladders bl
        LEFT JOIN programs p ON p.id = bl.program_id
        WHERE bl.program_id IS NOT NULL
          AND p.studio_id IS DISTINCT FROM bl.studio_id

        UNION ALL

        SELECT
            'active_program_ladder_name_mismatch' AS check_name,
            p.studio_id::TEXT AS studio_id,
            p.id::TEXT AS entity_id,
            jsonb_build_object('program_name', p.name, 'ladder_name', bl.name) AS details
        FROM programs p
        JOIN belt_ladders bl
          ON bl.program_id = p.id
         AND bl.studio_id = p.studio_id
        WHERE p.archived_at IS NULL
          AND COALESCE(p.is_system, false) = false
          AND bl.name IS DISTINCT FROM p.name

        UNION ALL

        SELECT
            'system_program_with_ladder' AS check_name,
            p.studio_id::TEXT AS studio_id,
            p.id::TEXT AS entity_id,
            jsonb_build_object('program_name', p.name, 'ladder_id', bl.id) AS details
        FROM programs p
        JOIN belt_ladders bl
          ON bl.program_id = p.id
         AND bl.studio_id = p.studio_id
        WHERE COALESCE(p.is_system, false) = true

        UNION ALL

        SELECT
            'duplicate_active_program_name' AS check_name,
            studio_id::TEXT AS studio_id,
            lower(name) AS entity_id,
            jsonb_build_object(
                'duplicate_count', count(*),
                'program_ids', array_agg(id ORDER BY created_at, id)
            ) AS details
        FROM programs
        WHERE archived_at IS NULL
        GROUP BY studio_id, lower(name)
        HAVING count(*) > 1

        UNION ALL

        SELECT
            'membership_rank_program_mismatch' AS check_name,
            spm.studio_id::TEXT AS studio_id,
            spm.id::TEXT AS entity_id,
            jsonb_build_object(
                'membership_program_id', spm.program_id,
                'rank_id', spm.current_belt_rank_id,
                'rank_program_id', bl.program_id
            ) AS details
        FROM student_program_memberships spm
        JOIN belt_ranks br ON br.id = spm.current_belt_rank_id
        JOIN belt_ladders bl ON bl.id = br.ladder_id
        WHERE br.studio_id IS DISTINCT FROM spm.studio_id
           OR bl.program_id IS DISTINCT FROM spm.program_id

        UNION ALL

        SELECT
            'promotion_program_mismatch' AS check_name,
            pr.studio_id::TEXT AS studio_id,
            pr.id::TEXT AS entity_id,
            jsonb_build_object(
                'promotion_program_id', pr.program_id,
                'membership_program_id', spm.program_id,
                'ladder_program_id', bl.program_id
            ) AS details
        FROM promotions pr
        LEFT JOIN student_program_memberships spm ON spm.id = pr.student_program_membership_id
        LEFT JOIN belt_ranks br ON br.id = pr.to_rank_id
        LEFT JOIN belt_ladders bl ON bl.id = br.ladder_id
        WHERE (spm.id IS NOT NULL AND pr.program_id IS DISTINCT FROM spm.program_id)
           OR (bl.program_id IS NOT NULL AND pr.program_id IS DISTINCT FROM bl.program_id)

        UNION ALL

        SELECT
            'student_without_program_membership' AS check_name,
            st.studio_id::TEXT AS studio_id,
            st.id::TEXT AS entity_id,
            jsonb_build_object('student_name', concat_ws(' ', st.legal_first_name, st.legal_last_name)) AS details
        FROM students st
        LEFT JOIN student_program_memberships spm
          ON spm.student_id = st.id
         AND spm.studio_id = st.studio_id
        WHERE st.deleted_at IS NULL
          AND spm.id IS NULL
    ),
    limited_failures AS (
        SELECT *
        FROM failures
        ORDER BY check_name, studio_id, entity_id
        LIMIT 50
    )
    SELECT jsonb_agg(to_jsonb(limited_failures) ORDER BY check_name, studio_id, entity_id)
      INTO v_failures
      FROM limited_failures;

    IF v_failures IS NOT NULL THEN
        RAISE EXCEPTION 'Program/ladder unification verification failed: %', v_failures;
    END IF;

    RAISE NOTICE 'Koaryu program/ladder unification verification passed.';
END $$;
