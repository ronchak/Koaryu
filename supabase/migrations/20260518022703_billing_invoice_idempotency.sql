-- Make invoice creation safe across retries, tabs, and multiple devices.

ALTER TABLE billing_invoices
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS request_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_create_idempotency
    ON billing_invoices(studio_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
