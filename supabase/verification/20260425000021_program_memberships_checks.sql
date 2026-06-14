-- Koaryu Program Membership Migration Verification
-- Run after applying 20260425000021_program_memberships.sql. This check fails
-- closed when tenant, program, class, lead, membership, or promotion invariants
-- drift from the current contract.

DO $$
DECLARE
    v_failures JSONB;
BEGIN
    WITH program_name_counts AS (
        SELECT studio_id, lower(name) AS normalized_name, count(*) AS match_count
        FROM programs
        WHERE archived_at IS NULL
        GROUP BY studio_id, lower(name)
    ),
    failures AS (
        SELECT
            'duplicate_active_program_name' AS check_name,
            studio_id::TEXT AS studio_id,
            lower(name) AS entity_id,
            jsonb_build_object(
                'duplicate_count', count(*),
                'program_ids', array_agg(id ORDER BY created_at)
            ) AS details
        FROM programs
        WHERE archived_at IS NULL
        GROUP BY studio_id, lower(name)
        HAVING count(*) > 1

        UNION ALL

        SELECT
            'missing_or_duplicate_unassigned' AS check_name,
            s.id::TEXT AS studio_id,
            s.id::TEXT AS entity_id,
            jsonb_build_object('unassigned_count', count(p.id)) AS details
        FROM studios s
        LEFT JOIN programs p
          ON p.studio_id = s.id
         AND lower(p.name) = 'unassigned'
         AND p.is_system = true
         AND p.archived_at IS NULL
        GROUP BY s.id
        HAVING count(p.id) <> 1

        UNION ALL

        SELECT
            'student_without_program_membership' AS check_name,
            st.studio_id::TEXT AS studio_id,
            st.id::TEXT AS entity_id,
            jsonb_build_object(
                'student_name', concat_ws(' ', st.legal_first_name, st.legal_last_name)
            ) AS details
        FROM students st
        LEFT JOIN student_program_memberships spm
          ON spm.student_id = st.id
         AND spm.studio_id = st.studio_id
        WHERE st.deleted_at IS NULL
          AND spm.id IS NULL

        UNION ALL

        SELECT
            'membership_tenant_mismatch' AS check_name,
            spm.studio_id::TEXT AS studio_id,
            spm.id::TEXT AS entity_id,
            jsonb_build_object(
                'membership_studio_id', spm.studio_id,
                'student_studio_id', st.studio_id,
                'program_studio_id', p.studio_id
            ) AS details
        FROM student_program_memberships spm
        LEFT JOIN students st ON st.id = spm.student_id
        LEFT JOIN programs p ON p.id = spm.program_id
        WHERE st.studio_id IS DISTINCT FROM spm.studio_id
           OR p.studio_id IS DISTINCT FROM spm.studio_id

        UNION ALL

        SELECT
            'membership_rank_program_mismatch' AS check_name,
            spm.studio_id::TEXT AS studio_id,
            spm.id::TEXT AS entity_id,
            jsonb_build_object(
                'program_id', spm.program_id,
                'rank_id', spm.current_belt_rank_id,
                'rank_program_id', bl.program_id
            ) AS details
        FROM student_program_memberships spm
        JOIN belt_ranks br ON br.id = spm.current_belt_rank_id
        JOIN belt_ladders bl ON bl.id = br.ladder_id
        WHERE br.studio_id IS DISTINCT FROM spm.studio_id
           OR (bl.program_id IS NOT NULL AND bl.program_id <> spm.program_id)

        UNION ALL

        SELECT
            'lead_program_tenant_mismatch' AS check_name,
            l.studio_id::TEXT AS studio_id,
            l.id::TEXT AS entity_id,
            jsonb_build_object('program_id', l.program_id, 'program_studio_id', p.studio_id) AS details
        FROM leads l
        JOIN programs p ON p.id = l.program_id
        WHERE p.studio_id <> l.studio_id

        UNION ALL

        SELECT
            'class_template_program_tenant_mismatch' AS check_name,
            ct.studio_id::TEXT AS studio_id,
            ct.id::TEXT AS entity_id,
            jsonb_build_object('program_id', ct.program_id, 'program_studio_id', p.studio_id) AS details
        FROM class_templates ct
        JOIN programs p ON p.id = ct.program_id
        WHERE p.studio_id <> ct.studio_id

        UNION ALL

        SELECT
            'class_session_program_tenant_mismatch' AS check_name,
            cs.studio_id::TEXT AS studio_id,
            cs.id::TEXT AS entity_id,
            jsonb_build_object('program_id', cs.program_id, 'program_studio_id', p.studio_id) AS details
        FROM class_sessions cs
        JOIN programs p ON p.id = cs.program_id
        WHERE p.studio_id <> cs.studio_id

        UNION ALL

        SELECT
            'class_session_template_program_mismatch' AS check_name,
            cs.studio_id::TEXT AS studio_id,
            cs.id::TEXT AS entity_id,
            jsonb_build_object(
                'session_program_id', cs.program_id,
                'template_program_id', ct.program_id
            ) AS details
        FROM class_sessions cs
        JOIN class_templates ct ON ct.id = cs.template_id
        WHERE ct.program_id IS NOT NULL
          AND cs.program_id IS DISTINCT FROM ct.program_id

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
            'ambiguous_lead_program_interest' AS check_name,
            l.studio_id::TEXT AS studio_id,
            l.id::TEXT AS entity_id,
            jsonb_build_object(
                'program_interest', l.program_interest,
                'match_count', pnc.match_count
            ) AS details
        FROM leads l
        JOIN program_name_counts pnc
          ON pnc.studio_id = l.studio_id
         AND pnc.normalized_name = lower(trim(l.program_interest))
        WHERE l.program_id IS NULL
          AND l.program_interest IS NOT NULL
          AND pnc.match_count > 1
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
        RAISE EXCEPTION 'Program membership verification failed: %', v_failures;
    END IF;

    RAISE NOTICE 'Koaryu program membership verification passed.';
END $$;
