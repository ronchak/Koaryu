-- ==========================================
-- Koaryu v1 — Phase 5 Migration
-- Lead Pipeline
-- ==========================================

-- Leads (prospect records)
CREATE TABLE leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    source TEXT DEFAULT 'walk_in'
        CHECK (source IN ('walk_in', 'referral', 'social', 'search', 'website', 'other')),
    stage TEXT NOT NULL DEFAULT 'inquiry'
        CHECK (stage IN ('inquiry', 'trial_scheduled', 'trial_completed', 'offer_sent', 'enrolled', 'closed_lost')),
    program_interest TEXT,
    is_minor BOOLEAN DEFAULT false,
    guardian_name TEXT,
    guardian_email TEXT,
    guardian_phone TEXT,
    assigned_staff_id UUID REFERENCES auth.users(id),
    follow_up_date DATE,
    lost_reason TEXT
        CHECK (lost_reason IS NULL OR lost_reason IN ('no_show', 'price_objection', 'timing', 'no_response', 'other')),
    notes TEXT,
    converted_student_id UUID REFERENCES students(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Lead activities (activity log per lead)
CREATE TABLE lead_activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    activity_type TEXT NOT NULL
        CHECK (activity_type IN ('note', 'stage_change', 'email', 'call', 'meeting', 'follow_up')),
    description TEXT,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- Indexes
-- ==========================================
CREATE INDEX idx_leads_studio ON leads(studio_id);
CREATE INDEX idx_leads_stage ON leads(studio_id, stage);
CREATE INDEX idx_leads_source ON leads(studio_id, source);
CREATE INDEX idx_leads_follow_up ON leads(studio_id, follow_up_date) WHERE stage NOT IN ('enrolled', 'closed_lost');
CREATE INDEX idx_leads_assigned ON leads(assigned_staff_id);
CREATE INDEX idx_lead_activities_lead ON lead_activities(lead_id);

-- ==========================================
-- Row Level Security
-- ==========================================
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;

-- Leads
CREATE POLICY "leads_select" ON leads FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "leads_insert" ON leads FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "leads_update" ON leads FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- Lead activities
CREATE POLICY "lead_activities_select" ON lead_activities FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));
CREATE POLICY "lead_activities_insert" ON lead_activities FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

-- ==========================================
-- Triggers
-- ==========================================
CREATE TRIGGER set_leads_updated_at
    BEFORE UPDATE ON leads
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
