-- Qualify billing_payments.status inside the invoice recompute helper. The
-- function returns a column named status, so unqualified status is ambiguous
-- under Supabase lint and can fail at runtime in PL/pgSQL.

CREATE OR REPLACE FUNCTION public.recompute_billing_invoice_external_payment_totals(
    p_studio_id UUID,
    p_invoice_id UUID
)
RETURNS TABLE(
    updated BOOLEAN,
    amount_paid_cents INTEGER,
    amount_remaining_cents INTEGER,
    status TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_invoice public.billing_invoices%ROWTYPE;
    v_paid INTEGER;
    v_due INTEGER;
    v_updated public.billing_invoices%ROWTYPE;
BEGIN
    SELECT *
      INTO v_invoice
      FROM public.billing_invoices
     WHERE id = p_invoice_id
       AND studio_id = p_studio_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(SUM(payment.amount_cents), 0)::INTEGER
      INTO v_paid
      FROM public.billing_payments AS payment
     WHERE payment.studio_id = p_studio_id
       AND payment.invoice_id = p_invoice_id
       AND payment.status IN ('succeeded', 'externally_recorded');

    v_due := COALESCE(v_invoice.amount_due_cents, 0);

    UPDATE public.billing_invoices AS invoice
       SET amount_paid_cents = LEAST(v_paid, v_due),
           amount_remaining_cents = GREATEST(0, v_due - v_paid),
           status = CASE
               WHEN v_paid >= v_due THEN 'paid'
               ELSE invoice.status
           END,
           paid_at = CASE
               WHEN v_paid >= v_due THEN COALESCE(invoice.paid_at, now())
               ELSE invoice.paid_at
           END,
           external = TRUE,
           application_fee_amount_cents = CASE
               WHEN v_paid >= v_due THEN 0
               ELSE invoice.application_fee_amount_cents
           END,
           updated_at = now()
     WHERE invoice.id = p_invoice_id
       AND invoice.studio_id = p_studio_id
     RETURNING invoice.* INTO v_updated;

    RETURN QUERY SELECT
        true,
        v_updated.amount_paid_cents,
        v_updated.amount_remaining_cents,
        v_updated.status;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_billing_invoice_external_payment_totals(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_billing_invoice_external_payment_totals(UUID, UUID) TO service_role;
