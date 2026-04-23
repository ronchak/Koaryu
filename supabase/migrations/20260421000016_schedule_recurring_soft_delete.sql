-- ==========================================
-- Koaryu v1 — Schedule hardening
-- Recurring template windows + soft-deleted sessions
-- ==========================================

ALTER TABLE class_templates
    ADD COLUMN IF NOT EXISTS start_date DATE,
    ADD COLUMN IF NOT EXISTS end_date DATE;

UPDATE class_templates
SET start_date = CURRENT_DATE
WHERE start_date IS NULL;

ALTER TABLE class_templates
    ALTER COLUMN start_date SET NOT NULL;

ALTER TABLE class_templates
    ADD CONSTRAINT class_templates_end_after_start
    CHECK (end_date IS NULL OR end_date >= start_date);

ALTER TABLE class_sessions
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_sessions_template_date_unique
    ON class_sessions(template_id, date)
    WHERE template_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_sessions_studio_date_active
    ON class_sessions(studio_id, date)
    WHERE deleted_at IS NULL;
