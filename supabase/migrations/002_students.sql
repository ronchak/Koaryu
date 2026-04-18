-- ==========================================
-- Koaryu v1 — Phase 2 Migration
-- Students, Guardians
-- ==========================================

-- Programs (optional categorisation per studio)
CREATE TABLE programs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Students (canonical student record)
CREATE TABLE students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,

    -- Name
    legal_first_name TEXT NOT NULL,
    legal_last_name TEXT NOT NULL,
    preferred_name TEXT,

    -- Demographics
    date_of_birth DATE,
    is_minor BOOLEAN GENERATED ALWAYS AS (
        date_of_birth IS NOT NULL AND date_of_birth > (CURRENT_DATE - INTERVAL '18 years')
    ) STORED,

    -- Contact
    email TEXT,
    phone TEXT,
    address_line1 TEXT,
    address_city TEXT,
    address_state TEXT,
    address_zip TEXT,

    -- Emergency contact
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    emergency_contact_relation TEXT,

    -- Membership
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'trialing', 'inactive', 'paused', 'canceled')),
    membership_start_date DATE,
    program_id UUID REFERENCES programs(id) ON DELETE SET NULL,

    -- Belt / rank (forward reference — will be populated in Phase 4)
    current_belt_rank_id UUID,

    -- Stripe
    stripe_customer_id TEXT,

    -- Metadata
    notes TEXT,
    tags TEXT[] DEFAULT '{}',

    -- Soft delete
    deleted_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Guardians (parent / emergency contacts for minors)
CREATE TABLE guardians (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    relation TEXT,  -- e.g. "Mother", "Father", "Grandparent"
    is_primary_contact BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Student ↔ Guardian join
CREATE TABLE student_guardians (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    guardian_id UUID NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
    UNIQUE(student_id, guardian_id)
);

-- ==========================================
-- Indexes
-- ==========================================
CREATE INDEX idx_students_studio_id ON students(studio_id);
CREATE INDEX idx_students_status ON students(studio_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_students_program_id ON students(program_id);
CREATE INDEX idx_students_deleted_at ON students(deleted_at);
CREATE INDEX idx_students_name ON students(studio_id, legal_last_name, legal_first_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_students_tags ON students USING GIN(tags);
CREATE INDEX idx_guardians_studio_id ON guardians(studio_id);
CREATE INDEX idx_student_guardians_student_id ON student_guardians(student_id);
CREATE INDEX idx_programs_studio_id ON programs(studio_id);

-- ==========================================
-- Row Level Security
-- ==========================================
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;

-- Students: studio members can read non-deleted
CREATE POLICY "students_select" ON students FOR SELECT
    USING (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        AND deleted_at IS NULL
    );

CREATE POLICY "students_insert" ON students FOR INSERT
    WITH CHECK (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
    );

CREATE POLICY "students_update" ON students FOR UPDATE
    USING (
        studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
    );

-- Soft delete = UPDATE, not DELETE
-- Hard delete denied to all non-service-roles (enforced by not having DELETE policy)

-- Guardians
CREATE POLICY "guardians_select" ON guardians FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

CREATE POLICY "guardians_insert" ON guardians FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

CREATE POLICY "guardians_update" ON guardians FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Student-Guardian join
CREATE POLICY "student_guardians_select" ON student_guardians FOR SELECT
    USING (
        student_id IN (SELECT id FROM students WHERE studio_id IN (
            SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()
        ))
    );

CREATE POLICY "student_guardians_insert" ON student_guardians FOR INSERT
    WITH CHECK (
        student_id IN (SELECT id FROM students WHERE studio_id IN (
            SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()
        ))
    );

-- Programs
CREATE POLICY "programs_select" ON programs FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

CREATE POLICY "programs_insert" ON programs FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

CREATE POLICY "programs_update" ON programs FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- ==========================================
-- Auto-update trigger
-- ==========================================
CREATE TRIGGER set_students_updated_at
    BEFORE UPDATE ON students
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
