ALTER TABLE stripe_events
    ADD COLUMN IF NOT EXISTS processing_token TEXT,
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_stripe_events_processing_claim
    ON stripe_events(processing_status, processing_started_at)
    WHERE processing_status = 'processing';
