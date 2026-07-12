CREATE TABLE public.billing_invoice_retry_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
    client_idempotency_key TEXT NOT NULL CHECK (
        length(btrim(client_idempotency_key)) BETWEEN 1 AND 255
    ),
    stripe_idempotency_key TEXT NOT NULL CHECK (
        length(btrim(stripe_idempotency_key)) BETWEEN 1 AND 255
    ),
    status TEXT NOT NULL DEFAULT 'processing' CHECK (
        status IN ('processing', 'succeeded', 'failed_definitive', 'reconciliation_required')
    ),
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (studio_id, invoice_id, client_idempotency_key),
    CHECK (
        status <> 'processing'
        OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    )
);

CREATE INDEX idx_billing_invoice_retry_operations_status
    ON public.billing_invoice_retry_operations (status, processing_started_at);

CREATE UNIQUE INDEX idx_billing_invoice_retry_operations_one_active_invoice
    ON public.billing_invoice_retry_operations (studio_id, invoice_id)
    WHERE status IN ('processing', 'reconciliation_required');

CREATE TABLE public.billing_invoice_retry_operation_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL REFERENCES public.billing_invoice_retry_operations(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
    client_idempotency_key TEXT NOT NULL CHECK (
        length(btrim(client_idempotency_key)) BETWEEN 1 AND 255
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (studio_id, invoice_id, client_idempotency_key)
);

CREATE INDEX idx_billing_invoice_retry_operation_aliases_operation
    ON public.billing_invoice_retry_operation_aliases (operation_id);

CREATE FUNCTION public.preserve_billing_invoice_retry_operation_created_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.created_at := OLD.created_at;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.preserve_billing_invoice_retry_operation_created_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preserve_billing_invoice_retry_operation_created_at() TO service_role;

CREATE TRIGGER preserve_billing_invoice_retry_operation_created_at
    BEFORE UPDATE ON public.billing_invoice_retry_operations
    FOR EACH ROW EXECUTE FUNCTION public.preserve_billing_invoice_retry_operation_created_at();

CREATE TRIGGER set_billing_invoice_retry_operations_updated_at
    BEFORE UPDATE ON public.billing_invoice_retry_operations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.billing_invoice_retry_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_retry_operation_aliases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.billing_invoice_retry_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.billing_invoice_retry_operation_aliases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_invoice_retry_operations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.billing_invoice_retry_operation_aliases TO service_role;

COMMENT ON TABLE public.billing_invoice_retry_operations IS
    'Service-role-only durable claims and outcomes for Stripe invoice payment retry operations.';

COMMENT ON TABLE public.billing_invoice_retry_operation_aliases IS
    'Service-role-only aliases that bind adopted client retry keys to one authoritative invoice retry operation.';
