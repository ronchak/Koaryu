-- ==========================================
-- Koaryu v1 — Initial Schema
-- Phase 1: Studios, Staff Roles, Audit Logs
-- ==========================================

-- Studios (tenant table)
CREATE TABLE studios (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    owner_id UUID NOT NULL REFERENCES auth.users(id),
    logo_url TEXT,
    timezone TEXT DEFAULT 'America/New_York',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Staff roles (join table: user ↔ studio)
CREATE TABLE staff_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'instructor', 'front_desk')),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(studio_id, user_id)
);

-- Audit log
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_staff_roles_user_id ON staff_roles(user_id);
CREATE INDEX idx_staff_roles_studio_id ON staff_roles(studio_id);
CREATE INDEX idx_audit_logs_studio_id ON audit_logs(studio_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_studios_owner_id ON studios(owner_id);
CREATE INDEX idx_studios_slug ON studios(slug);

-- ==========================================
-- Row Level Security (RLS)
-- ==========================================

ALTER TABLE studios ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Studios: users can read studios they belong to
CREATE POLICY "studios_select_own" ON studios FOR SELECT
    USING (
        id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid())
        OR owner_id = auth.uid()
    );

-- Studios: only owner can update
CREATE POLICY "studios_update_owner" ON studios FOR UPDATE
    USING (owner_id = auth.uid());

-- Studios: authenticated users can insert (for onboarding)
CREATE POLICY "studios_insert_auth" ON studios FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

-- Staff roles: users can read roles in their studio
CREATE POLICY "staff_roles_select_own" ON staff_roles FOR SELECT
    USING (
        studio_id IN (SELECT studio_id FROM staff_roles sr WHERE sr.user_id = auth.uid())
    );

-- Staff roles: authenticated users can insert (for onboarding self-assignment)
CREATE POLICY "staff_roles_insert_auth" ON staff_roles FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

-- Audit logs: only admins can read
CREATE POLICY "audit_logs_select_admin" ON audit_logs FOR SELECT
    USING (
        studio_id IN (
            SELECT studio_id FROM staff_roles
            WHERE user_id = auth.uid() AND role = 'admin'
        )
    );

-- Audit logs: authenticated users can insert
CREATE POLICY "audit_logs_insert_auth" ON audit_logs FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

-- ==========================================
-- Auto-update timestamp trigger
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_studios_updated_at
    BEFORE UPDATE ON studios
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
