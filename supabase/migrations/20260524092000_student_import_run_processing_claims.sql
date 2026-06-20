ALTER TABLE student_import_runs
    ADD COLUMN IF NOT EXISTS processing_token TEXT,
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_student_import_runs_processing_claims
    ON student_import_runs(status, processing_started_at)
    WHERE processing_token IS NOT NULL;
