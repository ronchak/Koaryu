-- ==========================================
-- Koaryu v1 — Phase 3 Migration
-- Schedule & Attendance
-- ==========================================

-- Class templates (recurring schedule definition)
CREATE TABLE class_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sunday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    instructor_id UUID REFERENCES auth.users(id),
    program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
    capacity INT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Class sessions (individual occurrences)
CREATE TABLE class_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    template_id UUID REFERENCES class_templates(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    instructor_id UUID REFERENCES auth.users(id),
    program_id UUID REFERENCES programs(id) ON DELETE SET NULL,
    capacity INT,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'canceled')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Attendance records
CREATE TABLE attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES class_sessions(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'late', 'excused', 'absent')),
    checked_in_at TIMESTAMPTZ DEFAULT now(),
    checked_in_by UUID REFERENCES auth.users(id),
    UNIQUE(session_id, student_id)
);

-- ==========================================
-- Indexes
-- ==========================================
CREATE INDEX idx_class_templates_studio ON class_templates(studio_id);
CREATE INDEX idx_class_templates_day ON class_templates(studio_id, day_of_week) WHERE is_active = true;
CREATE INDEX idx_class_sessions_studio_date ON class_sessions(studio_id, date);
CREATE INDEX idx_class_sessions_template ON class_sessions(template_id);
CREATE INDEX idx_attendance_session ON attendance(session_id);
CREATE INDEX idx_attendance_student ON attendance(student_id);
CREATE INDEX idx_attendance_studio_date ON attendance(studio_id, checked_in_at);

-- ==========================================
-- Row Level Security
-- ==========================================
ALTER TABLE class_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;

-- Class templates
CREATE POLICY "class_templates_select" ON class_templates FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "class_templates_insert" ON class_templates FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "class_templates_update" ON class_templates FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Class sessions
CREATE POLICY "class_sessions_select" ON class_sessions FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "class_sessions_insert" ON class_sessions FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "class_sessions_update" ON class_sessions FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Attendance
CREATE POLICY "attendance_select" ON attendance FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "attendance_insert" ON attendance FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "attendance_update" ON attendance FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- ==========================================
-- Triggers
-- ==========================================
CREATE TRIGGER set_class_templates_updated_at
    BEFORE UPDATE ON class_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
