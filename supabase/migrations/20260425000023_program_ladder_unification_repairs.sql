-- Koaryu v1 - repair edge cases discovered after program/ladder unification.

WITH ladder_rank_counts AS (
    SELECT
        bl.id,
        bl.studio_id,
        bl.program_id,
        count(br.id) AS rank_count,
        row_number() OVER (
            PARTITION BY bl.studio_id, bl.program_id
            ORDER BY
                CASE WHEN count(br.id) > 0 THEN 0 ELSE 1 END,
                bl.created_at,
                bl.id
        ) AS keep_order,
        count(*) OVER (PARTITION BY bl.studio_id, bl.program_id) AS ladder_count
    FROM belt_ladders bl
    LEFT JOIN belt_ranks br ON br.ladder_id = bl.id
    WHERE bl.program_id IS NOT NULL
    GROUP BY bl.id, bl.studio_id, bl.program_id, bl.created_at
),
empty_duplicate_ladders AS (
    SELECT id
    FROM ladder_rank_counts
    WHERE ladder_count > 1
      AND keep_order > 1
      AND rank_count = 0
)
DELETE FROM belt_ladders bl
USING empty_duplicate_ladders duplicate
WHERE bl.id = duplicate.id;

WITH promotion_context AS (
    SELECT DISTINCT ON (pr.id)
        pr.id AS promotion_id,
        bl.program_id,
        spm.id AS membership_id
    FROM promotions pr
    JOIN belt_ranks br
      ON br.id = pr.to_rank_id
    JOIN belt_ladders bl
      ON bl.id = br.ladder_id
    LEFT JOIN student_program_memberships spm
      ON spm.student_id = pr.student_id
     AND spm.studio_id = pr.studio_id
     AND spm.program_id = bl.program_id
    WHERE pr.studio_id = br.studio_id
      AND bl.program_id IS NOT NULL
      AND (
          pr.program_id IS DISTINCT FROM bl.program_id
          OR pr.student_program_membership_id IS NULL
      )
    ORDER BY pr.id, (spm.ended_at IS NULL) DESC, spm.created_at DESC
)
UPDATE promotions pr
SET
    program_id = promotion_context.program_id,
    student_program_membership_id = COALESCE(
        promotion_context.membership_id,
        pr.student_program_membership_id
    )
FROM promotion_context
WHERE pr.id = promotion_context.promotion_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM belt_ladders
        WHERE program_id IS NOT NULL
        GROUP BY studio_id, program_id
        HAVING count(*) > 1
    ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_belt_ladders_one_per_program
            ON belt_ladders(studio_id, program_id)
            WHERE program_id IS NOT NULL;
    END IF;
END $$;
