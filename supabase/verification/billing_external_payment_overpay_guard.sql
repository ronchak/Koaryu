BEGIN;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_invoice UUID := gen_random_uuid();
    v_pending_payment UUID := gen_random_uuid();
    v_error_message TEXT;
BEGIN
    INSERT INTO auth.users (
        id,
        aud,
        role,
        email,
        raw_app_meta_data,
        raw_user_meta_data,
        created_at,
        updated_at
    )
    VALUES (
        v_owner,
        'authenticated',
        'authenticated',
        'billing-overpay-guard-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Billing Overpay Guard Verification Studio',
        'billing-overpay-guard-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.billing_payers (id, studio_id, display_name)
    VALUES (v_payer, v_studio, 'Verification Payer');

    INSERT INTO public.billing_invoices (
        id,
        studio_id,
        payer_id,
        status,
        amount_due_cents,
        amount_paid_cents,
        amount_remaining_cents,
        currency
    )
    VALUES (
        v_invoice,
        v_studio,
        v_payer,
        'open',
        1000,
        0,
        1000,
        'usd'
    );

    BEGIN
        INSERT INTO public.billing_payments (
            studio_id,
            payer_id,
            invoice_id,
            status,
            amount_cents,
            currency,
            external_method
        )
        VALUES (
            v_studio,
            v_payer,
            v_invoice,
            'externally_recorded',
            1,
            'usd',
            'cash'
        );
        RAISE EXCEPTION 'Expected invoice external payment without idempotency to be rejected.';
    EXCEPTION
        WHEN check_violation THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%Idempotency-Key is required for external payments%' THEN
                RAISE;
            END IF;
    END;

    INSERT INTO public.billing_payments (
        studio_id,
        payer_id,
        invoice_id,
        status,
        amount_cents,
        currency,
        payment_method_type,
        external_method,
        idempotency_key
    )
    VALUES (
        v_studio,
        v_payer,
        v_invoice,
        'externally_recorded',
        700,
        'usd',
        'external',
        'cash',
        'billing-overpay-guard-700'
    );

    INSERT INTO public.billing_payments (
        studio_id,
        payer_id,
        invoice_id,
        status,
        amount_cents,
        currency,
        payment_method_type,
        external_method,
        idempotency_key
    )
    VALUES (
        v_studio,
        v_payer,
        v_invoice,
        'externally_recorded',
        300,
        'usd',
        'external',
        'check',
        'billing-overpay-guard-300'
    );

    BEGIN
        INSERT INTO public.billing_payments (
            studio_id,
            payer_id,
            invoice_id,
            status,
            amount_cents,
            currency,
            payment_method_type,
            external_method,
            idempotency_key
        )
        VALUES (
            v_studio,
            v_payer,
            v_invoice,
            'externally_recorded',
            300,
            'usd',
            'external',
            'check',
            'billing-overpay-guard-300'
        );
        RAISE EXCEPTION 'Expected duplicate external payment idempotency key to be rejected.';
    EXCEPTION
        WHEN unique_violation THEN
            NULL;
        WHEN check_violation THEN
            RAISE EXCEPTION 'Expected duplicate idempotency key to reach the unique constraint before overpay guard.';
    END;

    BEGIN
        INSERT INTO public.billing_payments (
            studio_id,
            payer_id,
            invoice_id,
            status,
            amount_cents,
            currency,
            payment_method_type,
            external_method,
            idempotency_key
        )
        VALUES (
            v_studio,
            v_payer,
            v_invoice,
            'externally_recorded',
            1,
            'usd',
            'external',
            'cash',
            'billing-overpay-guard-over'
        );
        RAISE EXCEPTION 'Expected invoice external overpayment insert to be rejected.';
    EXCEPTION
        WHEN check_violation THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%External payment exceeds the invoice remaining balance%' THEN
                RAISE;
            END IF;
    END;

    INSERT INTO public.billing_payments (
        id,
        studio_id,
        payer_id,
        invoice_id,
        status,
        amount_cents,
        currency,
        payment_method_type,
        external_method,
        idempotency_key
    )
    VALUES (
        v_pending_payment,
        v_studio,
        v_payer,
        v_invoice,
        'pending',
        1,
        'usd',
        'external',
        'cash',
        'billing-overpay-guard-pending'
    );

    BEGIN
        UPDATE public.billing_payments
           SET status = 'externally_recorded'
         WHERE id = v_pending_payment;
        RAISE EXCEPTION 'Expected invoice external overpayment update to be rejected.';
    EXCEPTION
        WHEN check_violation THEN
            v_error_message := SQLERRM;
            IF v_error_message NOT LIKE '%External payment exceeds the invoice remaining balance%' THEN
                RAISE;
            END IF;
    END;

    RAISE NOTICE 'Koaryu billing external payment overpay guard verification passed.';
END $$;

ROLLBACK;
