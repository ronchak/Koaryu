-- ==========================================
-- Koaryu v1 — Student import idempotency
-- Durable import-run records for safe CSV retry behavior
-- ==========================================

CREATE TABLE IF NOT EXISTS student_import_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    operation TEXT NOT NULL DEFAULT 'students_csv_execute',
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'completed', 'failed')),
    result_json JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_import_runs_scope_key
    ON student_import_runs(studio_id, operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_student_import_runs_studio_status
    ON student_import_runs(studio_id, status, created_at DESC);

ALTER TABLE student_import_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "student_import_runs_select" ON student_import_runs;
CREATE POLICY "student_import_runs_select" ON student_import_runs FOR SELECT
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "student_import_runs_insert" ON student_import_runs;
CREATE POLICY "student_import_runs_insert" ON student_import_runs FOR INSERT
    WITH CHECK (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "student_import_runs_update" ON student_import_runs;
CREATE POLICY "student_import_runs_update" ON student_import_runs FOR UPDATE
    USING (studio_id IN (SELECT studio_id FROM staff_roles WHERE user_id = auth.uid()));

DROP TRIGGER IF EXISTS set_student_import_runs_updated_at ON student_import_runs;
CREATE TRIGGER set_student_import_runs_updated_at
    BEFORE UPDATE ON student_import_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
