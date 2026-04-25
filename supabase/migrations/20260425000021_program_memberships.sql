-- ==========================================
-- Koaryu v1 - First-class programs and student memberships
-- ==========================================

-- Program lifecycle metadata. The base programs table was introduced early as
-- optional categorisation; these columns make it production-manageable.
ALTER TABLE programs
    ADD COLUMN IF NOT EXISTS color_hex TEXT DEFAULT '#64748B',
    ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

DROP TRIGGER IF EXISTS set_programs_updated_at ON programs;
CREATE TRIGGER set_programs_updated_at
    BEFORE UPDATE ON programs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_active_name_unique
    ON programs (studio_id, lower(name))
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_programs_archived_at
    ON programs (studio_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_programs_sort_order
    ON programs (studio_id, sort_order, name);

-- Structured lead-to-program handoff while preserving free text program_interest.
ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES programs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_program_id ON leads(studio_id, program_id);

-- Attendance credit metadata for explicit cross-program drop-ins.
ALTER TABLE attendance
    ADD COLUMN IF NOT EXISTS is_cross_program BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS counts_toward_eligibility BOOLEAN DEFAULT true,
    ADD COLUMN IF NOT EXISTS override_reason TEXT;

-- Per-student, per-program enrollment and rank state.
CREATE TABLE IF NOT EXISTS student_program_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    program_id UUID NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'ended')),
    started_at DATE,
    ended_at DATE,
    current_belt_rank_id UUID REFERENCES belt_ranks(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_program_memberships_active_unique
    ON student_program_memberships(student_id, program_id)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_program_memberships_studio_program
    ON student_program_memberships(studio_id, program_id, status);

CREATE INDEX IF NOT EXISTS idx_student_program_memberships_student
    ON student_program_memberships(student_id);

DROP TRIGGER IF EXISTS set_student_program_memberships_updated_at ON student_program_memberships;
CREATE TRIGGER set_student_program_memberships_updated_at
    BEFORE UPDATE ON student_program_memberships
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE promotions
    ADD COLUMN IF NOT EXISTS student_program_membership_id UUID REFERENCES student_program_memberships(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES programs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_promotions_program_id ON promotions(studio_id, program_id, promoted_at);

ALTER TABLE student_program_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_program_memberships_select" ON student_program_memberships;
CREATE POLICY "student_program_memberships_select" ON student_program_memberships FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "student_program_memberships_insert" ON student_program_memberships;
CREATE POLICY "student_program_memberships_insert" ON student_program_memberships FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "student_program_memberships_update" ON student_program_memberships;
CREATE POLICY "student_program_memberships_update" ON student_program_memberships FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
DROP POLICY IF EXISTS "student_program_memberships_delete" ON student_program_memberships;
CREATE POLICY "student_program_memberships_delete" ON student_program_memberships FOR DELETE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Enforce tenant and rank/program consistency for service-role writes too.
CREATE OR REPLACE FUNCTION validate_student_program_membership()
RETURNS TRIGGER AS $$
DECLARE
    student_studio UUID;
    program_studio UUID;
    rank_studio UUID;
    rank_program UUID;
BEGIN
    SELECT studio_id INTO student_studio FROM students WHERE id = NEW.student_id;
    IF student_studio IS NULL OR student_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: student does not belong to this studio';
    END IF;

    SELECT studio_id INTO program_studio FROM programs WHERE id = NEW.program_id;
    IF program_studio IS NULL OR program_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: program does not belong to this studio';
    END IF;

    IF NEW.current_belt_rank_id IS NOT NULL THEN
        SELECT br.studio_id, bl.program_id
        INTO rank_studio, rank_program
        FROM belt_ranks br
        JOIN belt_ladders bl ON bl.id = br.ladder_id
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_student_program_membership_trigger ON student_program_memberships;
CREATE TRIGGER validate_student_program_membership_trigger
    BEFORE INSERT OR UPDATE ON student_program_memberships
    FOR EACH ROW
    EXECUTE FUNCTION validate_student_program_membership();

CREATE OR REPLACE FUNCTION validate_lead_program_integrity()
RETURNS TRIGGER AS $$
DECLARE
    program_studio UUID;
BEGIN
    IF NEW.program_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT studio_id INTO program_studio FROM programs WHERE id = NEW.program_id;
    IF program_studio IS NULL OR program_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: lead program does not belong to this studio';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_lead_program_integrity_trigger ON leads;
CREATE TRIGGER validate_lead_program_integrity_trigger
    BEFORE INSERT OR UPDATE ON leads
    FOR EACH ROW
    EXECUTE FUNCTION validate_lead_program_integrity();

CREATE OR REPLACE FUNCTION validate_class_template_program_integrity()
RETURNS TRIGGER AS $$
DECLARE
    program_studio UUID;
BEGIN
    IF NEW.program_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT studio_id INTO program_studio FROM programs WHERE id = NEW.program_id;
    IF program_studio IS NULL OR program_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: class template program does not belong to this studio';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_class_session_program_integrity()
RETURNS TRIGGER AS $$
DECLARE
    program_studio UUID;
    template_studio UUID;
    template_program UUID;
BEGIN
    IF NEW.template_id IS NOT NULL THEN
        SELECT studio_id, program_id INTO template_studio, template_program
        FROM class_templates
        WHERE id = NEW.template_id;

        IF template_studio IS NULL OR template_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: class template does not belong to this studio';
        END IF;

        IF NEW.program_id IS NULL THEN
            NEW.program_id := template_program;
        ELSIF template_program IS NOT NULL AND NEW.program_id <> template_program THEN
            RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: class session program must match its template program';
        END IF;
    END IF;

    IF NEW.program_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT studio_id INTO program_studio FROM programs WHERE id = NEW.program_id;
    IF program_studio IS NULL OR program_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'PROGRAM_TENANT_MISMATCH: class program does not belong to this studio';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_class_templates_program_integrity_trigger ON class_templates;
CREATE TRIGGER validate_class_templates_program_integrity_trigger
    BEFORE INSERT OR UPDATE ON class_templates
    FOR EACH ROW
    EXECUTE FUNCTION validate_class_template_program_integrity();

DROP TRIGGER IF EXISTS validate_class_sessions_program_integrity_trigger ON class_sessions;
CREATE TRIGGER validate_class_sessions_program_integrity_trigger
    BEFORE INSERT OR UPDATE ON class_sessions
    FOR EACH ROW
    EXECUTE FUNCTION validate_class_session_program_integrity();

CREATE OR REPLACE FUNCTION validate_attendance_program_integrity()
RETURNS TRIGGER AS $$
DECLARE
    session_studio UUID;
    session_program UUID;
    student_studio UUID;
    has_membership BOOLEAN;
BEGIN
    SELECT studio_id, program_id INTO session_studio, session_program
    FROM class_sessions
    WHERE id = NEW.session_id;

    SELECT studio_id INTO student_studio
    FROM students
    WHERE id = NEW.student_id;

    IF session_studio IS NULL OR student_studio IS NULL OR session_studio <> NEW.studio_id OR student_studio <> NEW.studio_id THEN
        RAISE EXCEPTION 'ATTENDANCE_PROGRAM_MISMATCH: attendance must stay inside one studio';
    END IF;

    IF session_program IS NULL THEN
        NEW.is_cross_program := false;
        NEW.counts_toward_eligibility := COALESCE(NEW.counts_toward_eligibility, true);
        RETURN NEW;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM student_program_memberships spm
        WHERE spm.student_id = NEW.student_id
          AND spm.program_id = session_program
          AND spm.studio_id = NEW.studio_id
          AND spm.status IN ('active', 'paused')
          AND spm.ended_at IS NULL
    ) INTO has_membership;

    NEW.is_cross_program := NOT has_membership;
    IF NEW.is_cross_program THEN
        NEW.counts_toward_eligibility := COALESCE(NEW.counts_toward_eligibility, false);
    ELSE
        NEW.counts_toward_eligibility := COALESCE(NEW.counts_toward_eligibility, true);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS validate_attendance_program_integrity_trigger ON attendance;
CREATE TRIGGER validate_attendance_program_integrity_trigger
    BEFORE INSERT OR UPDATE ON attendance
    FOR EACH ROW
    EXECUTE FUNCTION validate_attendance_program_integrity();

-- Create one protected visible Unassigned program per studio.
INSERT INTO programs (studio_id, name, description, color_hex, sort_order, is_system)
SELECT
    s.id,
    'Unassigned',
    'Students awaiting program assignment.',
    '#94A3B8',
    9999,
    true
FROM studios s
WHERE NOT EXISTS (
    SELECT 1
    FROM programs p
    WHERE p.studio_id = s.id
      AND lower(p.name) = 'unassigned'
      AND p.archived_at IS NULL
);

-- Backfill one current membership for every non-deleted student.
INSERT INTO student_program_memberships (
    studio_id,
    student_id,
    program_id,
    status,
    started_at,
    ended_at,
    current_belt_rank_id
)
SELECT
    st.studio_id,
    st.id,
    COALESCE(st.program_id, unassigned.id),
    CASE
        WHEN st.status = 'paused' THEN 'paused'
        WHEN st.status IN ('inactive', 'canceled') THEN 'ended'
        ELSE 'active'
    END,
    COALESCE(st.membership_start_date, st.created_at::date),
    CASE
        WHEN st.status IN ('inactive', 'canceled') THEN CURRENT_DATE
        ELSE NULL
    END,
    CASE
        WHEN st.current_belt_rank_id IS NULL THEN NULL
        WHEN bl.program_id IS NULL THEN st.current_belt_rank_id
        WHEN bl.program_id = COALESCE(st.program_id, unassigned.id) THEN st.current_belt_rank_id
        ELSE NULL
    END
FROM students st
JOIN programs unassigned
  ON unassigned.studio_id = st.studio_id
 AND lower(unassigned.name) = 'unassigned'
 AND unassigned.is_system = true
LEFT JOIN belt_ranks br ON br.id = st.current_belt_rank_id
LEFT JOIN belt_ladders bl ON bl.id = br.ladder_id
WHERE st.deleted_at IS NULL
ON CONFLICT DO NOTHING;

-- Attach existing promotion history to the backfilled membership context when
-- the target ladder is either unscoped legacy data or matches the membership's
-- program. Ambiguous future multi-membership histories remain null for repair.
WITH promotion_membership_candidates AS (
    SELECT DISTINCT ON (pr_inner.id)
        pr_inner.id AS promotion_id,
        spm.id AS membership_id,
        spm.program_id
    FROM promotions pr_inner
    JOIN student_program_memberships spm
      ON spm.student_id = pr_inner.student_id
     AND spm.studio_id = pr_inner.studio_id
    LEFT JOIN belt_ranks br ON br.id = pr_inner.to_rank_id
    LEFT JOIN belt_ladders bl ON bl.id = br.ladder_id
    WHERE pr_inner.student_program_membership_id IS NULL
      AND pr_inner.program_id IS NULL
      AND (bl.program_id IS NULL OR bl.program_id = spm.program_id)
    ORDER BY pr_inner.id, (spm.ended_at IS NULL) DESC, spm.created_at DESC
)
UPDATE promotions pr
SET
    student_program_membership_id = candidate.membership_id,
    program_id = candidate.program_id
FROM promotion_membership_candidates candidate
WHERE pr.id = candidate.promotion_id;

-- Backfill structured lead program when the free-text interest is an exact unique
-- active program name match in the same studio.
WITH unique_program_names AS (
    SELECT
        studio_id,
        lower(name) AS normalized_name,
        (array_agg(id ORDER BY created_at, id))[1] AS program_id,
        count(*) AS match_count
    FROM programs
    WHERE archived_at IS NULL
    GROUP BY studio_id, lower(name)
)
UPDATE leads l
SET program_id = upn.program_id
FROM unique_program_names upn
WHERE l.program_id IS NULL
  AND l.program_interest IS NOT NULL
  AND upn.match_count = 1
  AND upn.studio_id = l.studio_id
  AND upn.normalized_name = lower(trim(l.program_interest));

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
