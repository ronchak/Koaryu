-- ==========================================
-- Koaryu v1 — Migration 020
-- Staff role invitation metadata
-- ==========================================

ALTER TABLE staff_roles
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
    ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES auth.users(id),
    ADD COLUMN IF NOT EXISTS invited_email TEXT;

UPDATE staff_roles
SET updated_at = COALESCE(updated_at, created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE staff_roles
    ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_roles_invited_email
    ON staff_roles(studio_id, invited_email);

DROP TRIGGER IF EXISTS set_staff_roles_updated_at ON staff_roles;

CREATE TRIGGER set_staff_roles_updated_at
    BEFORE UPDATE ON staff_roles
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
