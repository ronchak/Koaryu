-- Koaryu Program Membership Migration Verification
-- Run after applying 20260425000021_program_memberships.sql.
-- Every query should return zero rows unless it is an intentional cleanup report.

-- Duplicate active program names block tenant-safe uniqueness.
SELECT
    'duplicate_active_program_name' AS check_name,
    studio_id,
    lower(name) AS normalized_name,
    count(*) AS duplicate_count,
    array_agg(id ORDER BY created_at) AS program_ids
FROM programs
WHERE archived_at IS NULL
GROUP BY studio_id, lower(name)
HAVING count(*) > 1;

-- Every studio should have exactly one active protected Unassigned program.
SELECT
    'missing_or_duplicate_unassigned' AS check_name,
    s.id AS studio_id,
    count(p.id) AS unassigned_count
FROM studios s
LEFT JOIN programs p
  ON p.studio_id = s.id
 AND lower(p.name) = 'unassigned'
 AND p.is_system = true
 AND p.archived_at IS NULL
GROUP BY s.id
HAVING count(p.id) <> 1;

-- Non-deleted students should have at least one current or historical program membership.
SELECT
    'student_without_program_membership' AS check_name,
    st.studio_id,
    st.id AS student_id,
    st.legal_first_name,
    st.legal_last_name
FROM students st
LEFT JOIN student_program_memberships spm
  ON spm.student_id = st.id
 AND spm.studio_id = st.studio_id
WHERE st.deleted_at IS NULL
  AND spm.id IS NULL;

-- Memberships must stay within one studio.
SELECT
    'membership_tenant_mismatch' AS check_name,
    spm.id AS membership_id,
    spm.studio_id AS membership_studio_id,
    st.studio_id AS student_studio_id,
    p.studio_id AS program_studio_id
FROM student_program_memberships spm
LEFT JOIN students st ON st.id = spm.student_id
LEFT JOIN programs p ON p.id = spm.program_id
WHERE st.studio_id IS DISTINCT FROM spm.studio_id
   OR p.studio_id IS DISTINCT FROM spm.studio_id;

-- Membership rank must either be unscoped legacy rank data or belong to the same program.
SELECT
    'membership_rank_program_mismatch' AS check_name,
    spm.id AS membership_id,
    spm.program_id,
    spm.current_belt_rank_id,
    bl.program_id AS rank_program_id
FROM student_program_memberships spm
JOIN belt_ranks br ON br.id = spm.current_belt_rank_id
JOIN belt_ladders bl ON bl.id = br.ladder_id
WHERE br.studio_id IS DISTINCT FROM spm.studio_id
   OR (bl.program_id IS NOT NULL AND bl.program_id <> spm.program_id);

-- Leads and class surfaces must not point to programs in another studio.
SELECT 'lead_program_tenant_mismatch' AS check_name, l.id, l.studio_id, l.program_id
FROM leads l
JOIN programs p ON p.id = l.program_id
WHERE p.studio_id <> l.studio_id;

SELECT 'class_template_program_tenant_mismatch' AS check_name, ct.id, ct.studio_id, ct.program_id
FROM class_templates ct
JOIN programs p ON p.id = ct.program_id
WHERE p.studio_id <> ct.studio_id;

SELECT 'class_session_program_tenant_mismatch' AS check_name, cs.id, cs.studio_id, cs.program_id
FROM class_sessions cs
JOIN programs p ON p.id = cs.program_id
WHERE p.studio_id <> cs.studio_id;

-- Sessions generated from a template should inherit that template's program.
SELECT
    'class_session_template_program_mismatch' AS check_name,
    cs.id AS session_id,
    cs.program_id AS session_program_id,
    ct.program_id AS template_program_id
FROM class_sessions cs
JOIN class_templates ct ON ct.id = cs.template_id
WHERE ct.program_id IS NOT NULL
  AND cs.program_id IS DISTINCT FROM ct.program_id;

-- Program-scoped promotions should match their membership and target ladder.
SELECT
    'promotion_program_mismatch' AS check_name,
    pr.id AS promotion_id,
    pr.program_id,
    spm.program_id AS membership_program_id,
    bl.program_id AS ladder_program_id
FROM promotions pr
LEFT JOIN student_program_memberships spm ON spm.id = pr.student_program_membership_id
LEFT JOIN belt_ranks br ON br.id = pr.to_rank_id
LEFT JOIN belt_ladders bl ON bl.id = br.ladder_id
WHERE (spm.id IS NOT NULL AND pr.program_id IS DISTINCT FROM spm.program_id)
   OR (bl.program_id IS NOT NULL AND pr.program_id IS DISTINCT FROM bl.program_id);

-- Ambiguous lead free-text interests need human cleanup before automatic matching.
WITH program_name_counts AS (
    SELECT studio_id, lower(name) AS normalized_name, count(*) AS match_count
    FROM programs
    WHERE archived_at IS NULL
    GROUP BY studio_id, lower(name)
)
SELECT
    'ambiguous_lead_program_interest' AS check_name,
    l.id AS lead_id,
    l.studio_id,
    l.program_interest,
    pnc.match_count
FROM leads l
JOIN program_name_counts pnc
  ON pnc.studio_id = l.studio_id
 AND pnc.normalized_name = lower(trim(l.program_interest))
WHERE l.program_id IS NULL
  AND l.program_interest IS NOT NULL
  AND pnc.match_count > 1;
