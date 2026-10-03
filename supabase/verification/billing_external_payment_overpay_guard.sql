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
            net_collected_amount_cents,
            currency,
            external_method
        )
        VALUES (
            v_studio,
            v_payer,
            v_invoice,
            'externally_recorded',
            1,
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
        net_collected_amount_cents,
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
        net_collected_amount_cents,
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
            net_collected_amount_cents,
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
            net_collected_amount_cents,
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
           SET status = 'externally_recorded',
               net_collected_amount_cents = 1
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

CREATE FUNCTION pg_temp.reject_external_audit_for_test()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('koaryu.test_external_audit_failure', true) = 'on'
       AND NEW.action = 'billing.external_payment_recorded' THEN
        RAISE EXCEPTION 'external audit rollback fixture' USING ERRCODE = 'PZ001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER koaryu_test_external_audit BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_external_audit_for_test();

DO $external_command$
DECLARE
    studio UUID := gen_random_uuid();
    other_studio UUID := gen_random_uuid();
    actor UUID := gen_random_uuid();
    retry_actor UUID := gen_random_uuid();
    payer UUID := gen_random_uuid();
    other_payer UUID := gen_random_uuid();
    payment JSONB;
    replay JSONB;
    legacy JSONB;
    rejected BOOLEAN;
BEGIN
    INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(actor,'authenticated','authenticated',actor::TEXT||'@example.invalid','{}','{}',now(),now()),
          (retry_actor,'authenticated','authenticated',retry_actor::TEXT||'@example.invalid','{}','{}',now(),now());
    INSERT INTO public.studios(id,name,slug,owner_id)
    VALUES(studio,'External audit fixture',studio::TEXT,actor),
          (other_studio,'Other external fixture',other_studio::TEXT,retry_actor);
    INSERT INTO public.billing_payers(id,studio_id,display_name)
    VALUES(payer,studio,'Original payer'),(other_payer,other_studio,'Other payer');
    -- A historical confirmed non-USD record is preserved, including its absent audit.
    INSERT INTO public.billing_payments(studio_id,payer_id,status,amount_cents,currency,payment_method_type,
        external_method,note,idempotency_key,request_hash,processed_at,net_collected_amount_cents,refundable_amount_cents)
    VALUES(studio,payer,'externally_recorded',500,'eur','external','cash','Legacy note','legacy-external',repeat('b',64),now(),500,0)
    RETURNING to_jsonb(billing_payments.*) INTO legacy;

    SET LOCAL ROLE service_role;
    IF current_user <> 'service_role' THEN RAISE EXCEPTION 'Expected service_role'; END IF;
    PERFORM set_config('koaryu.test_external_audit_failure','on',true);
    rejected := FALSE;
    BEGIN
        PERFORM public.record_external_payment_v1(studio,actor,payer,500,'usd','cash','Guest''s class',
            'external-command',repeat('a',64));
    EXCEPTION WHEN SQLSTATE 'PZ001' THEN
        IF SQLERRM <> 'external audit rollback fixture' THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected OR EXISTS(SELECT 1 FROM public.billing_payments WHERE studio_id=studio AND idempotency_key='external-command')
       OR EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=studio AND action='billing.external_payment_recorded') THEN
        RAISE EXCEPTION 'Audit failure did not roll back the payment and its key.';
    END IF;
    PERFORM set_config('koaryu.test_external_audit_failure','off',true);
    payment := public.record_external_payment_v1(studio,actor,payer,500,'usd','cash','Guest''s class',
        'external-command',repeat('a',64));
    replay := public.record_external_payment_v1(studio,retry_actor,payer,500,'usd','cash','Guest''s class',
        'external-command',repeat('a',64));
    IF payment IS DISTINCT FROM replay OR payment->>'note' IS DISTINCT FROM 'Guest''s class'
       OR payment->>'status' IS DISTINCT FROM 'externally_recorded'
       OR (payment->>'net_collected_amount_cents')::INTEGER IS DISTINCT FROM 500
       OR (payment->>'refundable_amount_cents')::INTEGER IS DISTINCT FROM 0
       OR (SELECT count(*) FROM public.billing_payments WHERE studio_id=studio AND idempotency_key='external-command') <> 1
       OR (SELECT count(*) FROM public.audit_logs WHERE studio_id=studio AND action='billing.external_payment_recorded') <> 1
       OR NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE studio_id=studio AND actor_id=actor
           AND entity_type='billing' AND entity_id=(payment->>'id')::UUID AND action='billing.external_payment_recorded'
           AND metadata=jsonb_build_object('amount_cents',500,'external_method','cash')) THEN
        RAISE EXCEPTION 'Retry changed the original payment or its original-actor audit.';
    END IF;
    rejected := FALSE;
    BEGIN
        PERFORM public.record_external_payment_v1(studio,retry_actor,payer,501,'usd','cash','Changed',
            'external-command',repeat('c',64));
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'external_payment_request_conflict' THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Changed request hash was accepted.'; END IF;
    rejected := FALSE;
    BEGIN
        PERFORM public.record_external_payment_v1(studio,actor,other_payer,500,'usd','cash',NULL,
            'wrong-studio',repeat('d',64));
    EXCEPTION WHEN SQLSTATE 'P0002' THEN
        IF SQLERRM <> 'external_payment_payer_not_found' THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Cross-studio payer was accepted.'; END IF;
    rejected := FALSE;
    BEGIN
        PERFORM public.record_external_payment_v1(studio,actor,payer,500,'eur','cash','New non-USD',
            'new-non-usd',repeat('e',64));
    EXCEPTION WHEN SQLSTATE '22023' THEN
        IF SQLERRM <> 'external_payment_requires_usd' THEN RAISE; END IF;
        rejected := TRUE;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'New non-USD payment was accepted.'; END IF;
    replay := public.record_external_payment_v1(studio,retry_actor,payer,500,'eur','cash','Legacy note',
        'legacy-external',repeat('b',64));
    IF replay IS DISTINCT FROM legacy
       OR EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id=(legacy->>'id')::UUID AND action='billing.external_payment_recorded') THEN
        RAISE EXCEPTION 'Historical replay changed confirmed facts or fabricated an audit.';
    END IF;
    replay := public.record_external_payment_v1(other_studio,retry_actor,other_payer,500,'usd','cash',NULL,
        'external-command',repeat('a',64));
    IF replay->>'id' = payment->>'id' OR (replay->>'studio_id')::UUID IS DISTINCT FROM other_studio THEN
        RAISE EXCEPTION 'Idempotency key leaked across studios.';
    END IF;
    RESET ROLE;
END;
$external_command$;
DROP TRIGGER koaryu_test_external_audit ON public.audit_logs;

ROLLBACK;
