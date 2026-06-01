ALTER TABLE account_deletion_requests
    ADD COLUMN IF NOT EXISTS processing_token TEXT,
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_processing_claim
    ON account_deletion_requests(status, processing_started_at)
    WHERE processing_token IS NOT NULL;
