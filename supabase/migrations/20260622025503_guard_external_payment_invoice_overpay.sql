-- Guard invoice-targeted external payments at the database boundary. The
-- backend performs the friendly pre-check, but this trigger is the authoritative
-- invariant for concurrent requests and non-frontend clients.

CREATE OR REPLACE FUNCTION public.validate_billing_payment_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    payer_studio UUID;
    invoice_row public.billing_invoices%ROWTYPE;
    existing_payment_total INTEGER;
    excluded_payment_id UUID;
BEGIN
    IF NEW.payer_id IS NOT NULL THEN
        SELECT studio_id INTO payer_studio FROM public.billing_payers WHERE id = NEW.payer_id;
        IF payer_studio IS NULL OR payer_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing payment payer must belong to the same studio';
        END IF;
    END IF;

    IF NEW.invoice_id IS NOT NULL THEN
        SELECT *
          INTO invoice_row
          FROM public.billing_invoices
         WHERE id = NEW.invoice_id
         FOR UPDATE;

        IF NOT FOUND OR invoice_row.studio_id <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing payment invoice must belong to the same studio';
        END IF;
    END IF;

    IF NEW.invoice_id IS NOT NULL
       AND NEW.status = 'externally_recorded'
       AND COALESCE(NEW.amount_cents, 0) > 0 THEN
        IF TG_OP = 'UPDATE' THEN
            excluded_payment_id := OLD.id;
        END IF;

        SELECT COALESCE(SUM(payment.amount_cents), 0)::INTEGER
          INTO existing_payment_total
          FROM public.billing_payments AS payment
         WHERE payment.studio_id = NEW.studio_id
           AND payment.invoice_id = NEW.invoice_id
           AND payment.status IN ('succeeded', 'externally_recorded')
           AND (excluded_payment_id IS NULL OR payment.id <> excluded_payment_id);

        IF COALESCE(existing_payment_total, 0) + COALESCE(NEW.amount_cents, 0) > COALESCE(invoice_row.amount_due_cents, 0) THEN
            RAISE EXCEPTION 'External payment exceeds the invoice remaining balance.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
