-- Guard external payments at the database boundary. The backend performs the
-- friendly pre-check, but this trigger is the authoritative invariant for
-- concurrent requests and non-frontend clients.

UPDATE public.billing_payments
   SET idempotency_key = 'legacy-external-payment:' || id::TEXT,
       request_hash = COALESCE(NULLIF(btrim(request_hash), ''), 'legacy-external-payment:' || id::TEXT)
 WHERE status = 'externally_recorded'
   AND NULLIF(btrim(COALESCE(idempotency_key, '')), '') IS NULL;

CREATE OR REPLACE FUNCTION public.validate_billing_payment_refs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    payer_studio UUID;
    invoice_row public.billing_invoices%ROWTYPE;
    invoice_exists BOOLEAN := FALSE;
    existing_payment_total INTEGER;
    excluded_payment_id UUID;
    has_duplicate_idempotency_key BOOLEAN := FALSE;
BEGIN
    IF NEW.payer_id IS NOT NULL THEN
        SELECT studio_id INTO payer_studio FROM public.billing_payers WHERE id = NEW.payer_id;
        IF payer_studio IS NULL OR payer_studio <> NEW.studio_id THEN
            RAISE EXCEPTION 'Billing payment payer must belong to the same studio';
        END IF;
    END IF;

    IF NEW.status = 'externally_recorded'
       AND NULLIF(btrim(COALESCE(NEW.idempotency_key, '')), '') IS NULL THEN
        RAISE EXCEPTION 'Idempotency-Key is required for external payments.'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.invoice_id IS NOT NULL
       AND NEW.status = 'externally_recorded'
       AND COALESCE(NEW.amount_cents, 0) > 0 THEN
        SELECT *
          INTO invoice_row
          FROM public.billing_invoices
         WHERE id = NEW.invoice_id
           AND studio_id = NEW.studio_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Billing payment invoice must belong to the same studio';
        END IF;

        IF TG_OP = 'INSERT'
           AND NULLIF(btrim(COALESCE(NEW.idempotency_key, '')), '') IS NOT NULL THEN
            -- Let the unique idempotency index raise 23505 for duplicate
            -- retries so the backend can replay the existing payment.
            SELECT EXISTS (
                SELECT 1
                  FROM public.billing_payments AS payment
                 WHERE payment.studio_id = NEW.studio_id
                   AND payment.idempotency_key = NEW.idempotency_key
            )
              INTO has_duplicate_idempotency_key;

            IF has_duplicate_idempotency_key THEN
                RETURN NEW;
            END IF;
        END IF;

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
    ELSIF NEW.invoice_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1
              FROM public.billing_invoices
             WHERE id = NEW.invoice_id
               AND studio_id = NEW.studio_id
        )
          INTO invoice_exists;

        IF NOT invoice_exists THEN
            RAISE EXCEPTION 'Billing payment invoice must belong to the same studio';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;
