-- ==========================================
-- Koaryu v1 — Phase 4 Migration
-- Belt Ladders, Ranks, Promotions
-- ==========================================

-- Belt ladders (per-studio, per-program configuration)
CREATE TABLE belt_ladders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Belt ranks (ordered positions within a ladder)
CREATE TABLE belt_ranks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ladder_id UUID NOT NULL REFERENCES belt_ladders(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color_hex TEXT DEFAULT '#FFFFFF',
    display_order INT NOT NULL DEFAULT 0,
    min_classes INT DEFAULT 0,
    min_months INT DEFAULT 0,
    requires_approval BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Promotions (immutable log)
CREATE TABLE promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    from_rank_id UUID REFERENCES belt_ranks(id),
    to_rank_id UUID NOT NULL REFERENCES belt_ranks(id),
    promoted_by UUID NOT NULL REFERENCES auth.users(id),
    notes TEXT,
    promoted_at TIMESTAMPTZ DEFAULT now()
);

-- Add FK from students to belt_ranks (was forward-declared in 002)
ALTER TABLE students
    ADD CONSTRAINT fk_students_belt_rank
    FOREIGN KEY (current_belt_rank_id) REFERENCES belt_ranks(id) ON DELETE SET NULL;

-- ==========================================
-- Indexes
-- ==========================================
CREATE INDEX idx_belt_ladders_studio ON belt_ladders(studio_id);
CREATE INDEX idx_belt_ranks_ladder ON belt_ranks(ladder_id);
CREATE INDEX idx_belt_ranks_studio ON belt_ranks(studio_id);
CREATE INDEX idx_belt_ranks_order ON belt_ranks(ladder_id, display_order);
CREATE INDEX idx_promotions_student ON promotions(student_id);
CREATE INDEX idx_promotions_studio ON promotions(studio_id);
CREATE INDEX idx_promotions_date ON promotions(studio_id, promoted_at);

-- ==========================================
-- Row Level Security
-- ==========================================
ALTER TABLE belt_ladders ENABLE ROW LEVEL SECURITY;
ALTER TABLE belt_ranks ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;

-- Belt ladders
CREATE POLICY "belt_ladders_select" ON belt_ladders FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "belt_ladders_insert" ON belt_ladders FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "belt_ladders_update" ON belt_ladders FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Belt ranks
CREATE POLICY "belt_ranks_select" ON belt_ranks FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "belt_ranks_insert" ON belt_ranks FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "belt_ranks_update" ON belt_ranks FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Promotions
CREATE POLICY "promotions_select" ON promotions FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "promotions_insert" ON promotions FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- ==========================================
-- Triggers
-- ==========================================
CREATE TRIGGER set_belt_ladders_updated_at
    BEFORE UPDATE ON belt_ladders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
