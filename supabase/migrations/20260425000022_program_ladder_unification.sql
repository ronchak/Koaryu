-- Koaryu v1 - make Programs the user-facing belt tracker plans.
-- Each active non-system program owns exactly one belt_ladders row.

ALTER TABLE belt_ladders
    ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES programs(id) ON DELETE SET NULL;

CREATE TEMP TABLE koaryu_program_ladder_unification (
    ladder_id UUID PRIMARY KEY,
    program_id UUID NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
    ladder RECORD;
    target_program_id UUID;
    base_name TEXT;
    candidate_name TEXT;
    suffix INTEGER;
BEGIN
    FOR ladder IN
        SELECT id, studio_id, name, created_at
        FROM belt_ladders
        WHERE program_id IS NULL
        ORDER BY created_at, id
    LOOP
        target_program_id := NULL;

        SELECT p.id
        INTO target_program_id
        FROM programs p
        WHERE p.studio_id = ladder.studio_id
          AND p.archived_at IS NULL
          AND COALESCE(p.is_system, false) = false
          AND lower(trim(p.name)) = lower(trim(COALESCE(ladder.name, 'Untitled Program')))
          AND NOT EXISTS (
              SELECT 1
              FROM belt_ladders existing
              WHERE existing.program_id = p.id
          )
        ORDER BY p.created_at, p.id
        LIMIT 1;

        IF target_program_id IS NULL THEN
            base_name := COALESCE(NULLIF(trim(ladder.name), ''), 'Untitled Program');
            candidate_name := base_name;
            suffix := 2;

            WHILE EXISTS (
                SELECT 1
                FROM programs p
                WHERE p.studio_id = ladder.studio_id
                  AND p.archived_at IS NULL
                  AND lower(trim(p.name)) = lower(trim(candidate_name))
            ) LOOP
                candidate_name := base_name || ' ' || suffix;
                suffix := suffix + 1;
            END LOOP;

            INSERT INTO programs (
                studio_id,
                name,
                description,
                color_hex,
                sort_order,
                is_system,
                created_at,
                updated_at
            )
            VALUES (
                ladder.studio_id,
                candidate_name,
                'Program created from an existing Belt Tracker plan.',
                '#64748B',
                0,
                false,
                COALESCE(ladder.created_at, NOW()),
                NOW()
            )
            RETURNING id INTO target_program_id;
        END IF;

        UPDATE belt_ladders bl
        SET
            program_id = target_program_id,
            name = (SELECT p.name FROM programs p WHERE p.id = target_program_id),
            updated_at = NOW()
        WHERE bl.id = ladder.id;

        INSERT INTO koaryu_program_ladder_unification (ladder_id, program_id)
        VALUES (ladder.id, target_program_id)
        ON CONFLICT (ladder_id) DO UPDATE SET program_id = EXCLUDED.program_id;
    END LOOP;
END $$;

-- When a student's current rank came from a formerly unscoped ladder, move the
-- current program context to that ladder's newly materialized Program.
UPDATE students st
SET
    program_id = mapped.program_id,
    updated_at = NOW()
FROM belt_ranks br
JOIN koaryu_program_ladder_unification mapped
  ON mapped.ladder_id = br.ladder_id
WHERE st.current_belt_rank_id = br.id
  AND st.studio_id = br.studio_id
  AND st.deleted_at IS NULL;

UPDATE student_program_memberships spm
SET
    program_id = mapped.program_id,
    updated_at = NOW()
FROM belt_ranks br
JOIN koaryu_program_ladder_unification mapped
  ON mapped.ladder_id = br.ladder_id
WHERE spm.current_belt_rank_id = br.id
  AND spm.studio_id = br.studio_id
  AND NOT EXISTS (
      SELECT 1
      FROM student_program_memberships existing
      WHERE existing.id <> spm.id
        AND existing.student_id = spm.student_id
        AND existing.program_id = mapped.program_id
        AND existing.ended_at IS NULL
  );

WITH promotion_context AS (
    SELECT DISTINCT ON (pr.id)
        pr.id AS promotion_id,
        mapped.program_id,
        spm.id AS membership_id
    FROM promotions pr
    JOIN belt_ranks br
      ON br.id = pr.to_rank_id
    JOIN koaryu_program_ladder_unification mapped
      ON mapped.ladder_id = br.ladder_id
    LEFT JOIN student_program_memberships spm
      ON spm.student_id = pr.student_id
     AND spm.studio_id = pr.studio_id
     AND spm.program_id = mapped.program_id
    WHERE pr.studio_id = br.studio_id
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

-- Every active, user-facing Program gets a rank plan immediately. Programs
-- without ranks start as an empty ladder that staff can configure in Belt Tracker.
INSERT INTO belt_ladders (
    studio_id,
    name,
    program_id,
    sub_rank_term,
    created_at,
    updated_at
)
SELECT
    p.studio_id,
    p.name,
    p.id,
    'Stripe',
    NOW(),
    NOW()
FROM programs p
WHERE p.archived_at IS NULL
  AND COALESCE(p.is_system, false) = false
  AND NOT EXISTS (
      SELECT 1
      FROM belt_ladders bl
      WHERE bl.program_id = p.id
  );

-- Keep the user-facing names aligned.
UPDATE belt_ladders bl
SET
    name = p.name,
    updated_at = NOW()
FROM programs p
WHERE bl.program_id = p.id
  AND bl.studio_id = p.studio_id
  AND bl.name IS DISTINCT FROM p.name;

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
