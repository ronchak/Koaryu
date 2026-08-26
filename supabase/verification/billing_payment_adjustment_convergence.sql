BEGIN;

DO $$
DECLARE
    v_trigger_definition TEXT;
    v_identity_definition TEXT;
    v_lock_position INTEGER;
    v_old_recompute_position INTEGER;
    v_new_recompute_position INTEGER;
BEGIN
    SELECT pg_get_functiondef(
        'private.recompute_payment_after_adjustment_change()'::regprocedure
    )
    INTO v_trigger_definition;

    SELECT pg_get_functiondef(
        'private.validate_billing_adjustment_payment_identity()'::regprocedure
    )
    INTO v_identity_definition;

    v_lock_position := strpos(v_trigger_definition, 'ORDER BY payment.id');
    v_old_recompute_position := strpos(
        v_trigger_definition,
        'PERFORM private.recompute_billing_payment_adjustment_totals(v_old_payment_id)'
    );
    v_new_recompute_position := strpos(
        v_trigger_definition,
        'PERFORM private.recompute_billing_payment_adjustment_totals(v_new_payment_id)'
    );

    IF v_lock_position = 0
       OR strpos(v_trigger_definition, 'FOR UPDATE') = 0
       OR v_old_recompute_position <= v_lock_position
       OR v_new_recompute_position <= v_lock_position THEN
        RAISE EXCEPTION 'Adjustment move trigger does not lock payment UUIDs before recomputation.';
    END IF;

    IF strpos(v_identity_definition, 'ORDER BY payment.id') = 0
       OR strpos(v_identity_definition, 'FOR UPDATE') = 0
       OR strpos(v_identity_definition, 'ORDER BY payment.id') > strpos(
            v_identity_definition,
            'IF NEW.payment_id IS NULL'
       )
       OR strpos(v_identity_definition, 'FOR UPDATE') > strpos(
            v_identity_definition,
            'IF NOT FOUND'
       ) THEN
        RAISE EXCEPTION 'Adjustment identity validation does not lock parent UUIDs before checking.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function
        CROSS JOIN LATERAL aclexplode(
            COALESCE(function.proacl, acldefault('f', function.proowner))
        ) AS privilege
        WHERE function.oid IN (
            'private.recompute_billing_payment_adjustment_totals(uuid)'::regprocedure,
            'private.validate_billing_payment_identity_change()'::regprocedure,
            'private.validate_billing_adjustment_payment_identity()'::regprocedure,
            'private.recompute_payment_after_adjustment_change()'::regprocedure
        )
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Payment adjustment helper functions remain executable by PUBLIC.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_proc AS function
        WHERE function.oid IN (
            'private.recompute_billing_payment_adjustment_totals(uuid)'::regprocedure,
            'private.validate_billing_payment_identity_change()'::regprocedure,
            'private.validate_billing_adjustment_payment_identity()'::regprocedure,
            'private.recompute_payment_after_adjustment_change()'::regprocedure
        )
          AND (
              function.prosecdef
              OR 'search_path=""' <> ALL(COALESCE(function.proconfig, ARRAY[]::TEXT[]))
          )
    ) THEN
        RAISE EXCEPTION 'Payment adjustment helper function security configuration drifted.';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'private.recompute_billing_payment_adjustment_totals(uuid)',
        'EXECUTE'
    )
       OR has_function_privilege(
           'service_role',
           'private.validate_billing_payment_identity_change()',
           'EXECUTE'
       )
       OR has_function_privilege(
           'service_role',
           'private.validate_billing_adjustment_payment_identity()',
           'EXECUTE'
       )
       OR has_function_privilege(
           'service_role',
           'private.recompute_payment_after_adjustment_change()',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'Payment adjustment helper privileges are broader or narrower than intended.';
    END IF;

    IF to_regclass('public.idx_billing_refunds_payment_id') IS NULL
       OR to_regclass('public.idx_billing_disputes_payment_id') IS NULL
       OR to_regclass('public.idx_billing_payments_stripe_charge') IS NULL
       OR to_regclass('public.idx_billing_refunds_stripe') IS NULL
       OR to_regclass('public.idx_billing_disputes_stripe') IS NULL THEN
        RAISE EXCEPTION 'Payment adjustment projection is missing an owning lookup index.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint AS constraint_state
        WHERE constraint_state.conrelid IN (
            'public.billing_payments'::regclass,
            'public.billing_refunds'::regclass,
            'public.billing_disputes'::regclass
        )
          AND constraint_state.conname IN (
              'billing_payments_connect_account_generation_check',
              'billing_payments_disputed_amount_cents_check',
              'billing_payments_net_collected_amount_cents_check',
              'billing_payments_refundable_amount_cents_check',
              'billing_payments_adjustment_totals_check',
              'billing_refunds_connect_account_generation_check',
              'billing_disputes_connect_account_generation_check',
              'billing_disputes_state_category_check'
          )
          AND NOT constraint_state.convalidated
    ) THEN
        RAISE EXCEPTION 'Payment adjustment constraints were not validated.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.billing_payments'::regclass
          AND attribute.attname = 'gross_paid_amount_cents'
          AND attribute.attgenerated = 's'
          AND NOT attribute.attisdropped
    ) THEN
        RAISE EXCEPTION 'Gross paid is not owned by the expected stored generated column.';
    END IF;
END $$;

DO $$
DECLARE
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_payer UUID := gen_random_uuid();
    v_invoice UUID := gen_random_uuid();
    v_payment UUID := gen_random_uuid();
    v_refund UUID := gen_random_uuid();
    v_dispute UUID := gen_random_uuid();
    v_external_payment UUID := gen_random_uuid();
    v_pending_payment UUID := gen_random_uuid();
    v_failed_payment UUID := gen_random_uuid();
    v_enrichment_payment UUID := gen_random_uuid();
    v_enrichment_refund UUID := gen_random_uuid();
    v_payment_row public.billing_payments%ROWTYPE;
    v_invoice_row public.billing_invoices%ROWTYPE;
    v_payer_row public.billing_payers%ROWTYPE;
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
        'payment-adjustment-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
        '{}'::jsonb,
        '{}'::jsonb,
        now(),
        now()
    );

    INSERT INTO public.studios (id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Payment Adjustment Verification Studio',
        'payment-adjustment-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.billing_payers (
        id,
        studio_id,
        display_name,
        billing_status,
        balance_cents
    )
    VALUES (v_payer, v_studio, 'Verification Payer', 'current', 0);

    INSERT INTO public.billing_invoices (
        id,
        studio_id,
        payer_id,
        stripe_invoice_id,
        stripe_account_id,
        status,
        amount_due_cents,
        amount_paid_cents,
        amount_remaining_cents,
        currency,
        paid_at
    )
    VALUES (
        v_invoice,
        v_studio,
        v_payer,
        'in_adjustment_verification',
        'acct_adjustment_verification',
        'paid',
        200,
        200,
        0,
        'usd',
        now()
    );

    INSERT INTO public.billing_payments (
        id,
        studio_id,
        payer_id,
        invoice_id,
        stripe_payment_intent_id,
        stripe_charge_id,
        stripe_account_id,
        connect_account_generation,
        status,
        amount_cents,
        currency,
        net_collected_amount_cents,
        refundable_amount_cents,
        processed_at
    )
    VALUES (
        v_payment,
        v_studio,
        v_payer,
        v_invoice,
        'pi_adjustment_verification',
        'ch_adjustment_verification',
        'acct_adjustment_verification',
        1,
        'succeeded',
        200,
        'usd',
        200,
        200,
        now()
    );

    INSERT INTO public.billing_refunds (
        id,
        studio_id,
        payment_id,
        stripe_refund_id,
        stripe_charge_id,
        stripe_payment_intent_id,
        stripe_account_id,
        connect_account_generation,
        amount_cents,
        status
    )
    VALUES (
        v_refund,
        v_studio,
        v_payment,
        're_adjustment_verification',
        'ch_adjustment_verification',
        'pi_adjustment_verification',
        'acct_adjustment_verification',
        1,
        75,
        'succeeded'
    );

    SELECT * INTO v_payment_row FROM public.billing_payments WHERE id = v_payment;
    IF v_payment_row.gross_paid_amount_cents <> 200
       OR v_payment_row.refunded_amount_cents <> 75
       OR v_payment_row.disputed_amount_cents <> 0
       OR v_payment_row.net_collected_amount_cents <> 125
       OR v_payment_row.refundable_amount_cents <> 125 THEN
        RAISE EXCEPTION 'Succeeded refund did not produce the expected separate payment totals.';
    END IF;

    INSERT INTO public.billing_payments (
        id,
        studio_id,
        payer_id,
        status,
        amount_cents,
        currency,
        net_collected_amount_cents,
        refundable_amount_cents,
        idempotency_key,
        processed_at
    )
    VALUES
        (
            v_external_payment,
            v_studio,
            v_payer,
            'externally_recorded',
            90,
            'usd',
            90,
            0,
            'payment-adjustment-external-90',
            now()
        ),
        (
            v_pending_payment,
            v_studio,
            v_payer,
            'pending',
            80,
            'usd',
            0,
            0,
            NULL,
            NULL
        ),
        (
            v_failed_payment,
            v_studio,
            v_payer,
            'failed',
            70,
            'usd',
            0,
            0,
            NULL,
            NULL
        );

    IF NOT EXISTS (
        SELECT 1
        FROM public.billing_payments
        WHERE id = v_external_payment
          AND gross_paid_amount_cents = 90
          AND refunded_amount_cents = 0
          AND disputed_amount_cents = 0
          AND net_collected_amount_cents = 90
          AND refundable_amount_cents = 0
    ) OR EXISTS (
        SELECT 1
        FROM public.billing_payments
        WHERE id IN (v_pending_payment, v_failed_payment)
          AND (
              gross_paid_amount_cents <> 0
              OR refunded_amount_cents <> 0
              OR disputed_amount_cents <> 0
              OR net_collected_amount_cents <> 0
              OR refundable_amount_cents <> 0
          )
    ) THEN
        RAISE EXCEPTION 'Direct external, pending, or failed payment accounting is not exact.';
    END IF;

    BEGIN
        INSERT INTO public.billing_payments (
            studio_id,
            payer_id,
            stripe_payment_intent_id,
            stripe_charge_id,
            stripe_account_id,
            connect_account_generation,
            status,
            amount_cents,
            currency,
            net_collected_amount_cents,
            refundable_amount_cents
        )
        VALUES (
            v_studio,
            v_payer,
            'pi_zero_net_rejected',
            'ch_zero_net_rejected',
            'acct_adjustment_verification',
            1,
            'succeeded',
            50,
            'usd',
            0,
            0
        );
        RAISE EXCEPTION 'Expected succeeded payment with zero net to fail.';
    EXCEPTION
        WHEN check_violation THEN
            NULL;
    END;

    BEGIN
        UPDATE public.billing_payments
        SET refundable_amount_cents = 124
        WHERE id = v_payment;
        RAISE EXCEPTION 'Expected Stripe refundability mismatch to fail.';
    EXCEPTION
        WHEN check_violation THEN
            NULL;
    END;

    INSERT INTO public.billing_disputes (
        id,
        studio_id,
        payment_id,
        stripe_dispute_id,
        stripe_charge_id,
        stripe_payment_intent_id,
        stripe_account_id,
        connect_account_generation,
        amount_cents,
        status,
        state_category
    )
    VALUES (
        v_dispute,
        v_studio,
        v_payment,
        'dp_adjustment_verification',
        'ch_adjustment_verification',
        'pi_adjustment_verification',
        'acct_adjustment_verification',
        1,
        200,
        'needs_response',
        'active'
    );

    SELECT * INTO v_payment_row FROM public.billing_payments WHERE id = v_payment;
    IF v_payment_row.status <> 'disputed'
       OR v_payment_row.refunded_amount_cents <> 75
       OR v_payment_row.disputed_amount_cents <> 125
       OR v_payment_row.net_collected_amount_cents <> 0
       OR v_payment_row.refundable_amount_cents <> 0 THEN
        RAISE EXCEPTION 'Refund plus dispute did not cap the combined reversal at the gross payment.';
    END IF;

    UPDATE public.billing_disputes
    SET status = 'won', state_category = 'won'
    WHERE id = v_dispute;

    SELECT * INTO v_payment_row FROM public.billing_payments WHERE id = v_payment;
    IF v_payment_row.status <> 'succeeded'
       OR v_payment_row.refunded_amount_cents <> 75
       OR v_payment_row.disputed_amount_cents <> 0
       OR v_payment_row.net_collected_amount_cents <> 125
       OR v_payment_row.refundable_amount_cents <> 125 THEN
        RAISE EXCEPTION 'Won dispute did not restore net collected and refundable amounts exactly once.';
    END IF;

    SELECT * INTO v_invoice_row FROM public.billing_invoices WHERE id = v_invoice;
    SELECT * INTO v_payer_row FROM public.billing_payers WHERE id = v_payer;
    IF v_invoice_row.status <> 'paid'
       OR v_invoice_row.amount_paid_cents <> 200
       OR v_invoice_row.amount_remaining_cents <> 0
       OR v_payer_row.billing_status <> 'current'
       OR v_payer_row.balance_cents <> 0 THEN
        RAISE EXCEPTION 'Payment adjustments changed the invoice receivable or payer past-due state.';
    END IF;

    BEGIN
        INSERT INTO public.billing_refunds (
            studio_id,
            payment_id,
            stripe_refund_id,
            stripe_charge_id,
            stripe_payment_intent_id,
            stripe_account_id,
            connect_account_generation,
            amount_cents,
            status
        )
        VALUES (
            v_studio,
            v_payment,
            're_wrong_generation',
            'ch_adjustment_verification',
            'pi_adjustment_verification',
            'acct_adjustment_verification',
            2,
            1,
            'succeeded'
        );
        RAISE EXCEPTION 'Expected cross-generation adjustment link to fail.';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE '%payment identity mismatch%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        UPDATE public.billing_payments
        SET connect_account_generation = 2
        WHERE id = v_payment;
        RAISE EXCEPTION 'Expected established payment generation mutation to fail.';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE '%Established billing payment identity%' THEN
                RAISE;
            END IF;
    END;

    BEGIN
        UPDATE public.billing_refunds
        SET stripe_charge_id = 'ch_relabelled'
        WHERE id = v_refund;
        RAISE EXCEPTION 'Expected established refund provider identity mutation to fail.';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE '%Established billing adjustment identity%' THEN
                RAISE;
            END IF;
    END;

    INSERT INTO public.billing_payments (
        id,
        studio_id,
        payer_id,
        status,
        amount_cents,
        currency,
        net_collected_amount_cents,
        refundable_amount_cents
    ) VALUES (
        v_enrichment_payment,
        v_studio,
        v_payer,
        'pending',
        30,
        'usd',
        0,
        0
    );

    INSERT INTO public.billing_refunds (
        id,
        studio_id,
        payment_id,
        stripe_refund_id,
        amount_cents,
        status
    ) VALUES (
        v_enrichment_refund,
        v_studio,
        v_enrichment_payment,
        're_enrichment_guard',
        0,
        'pending'
    );

    BEGIN
        UPDATE public.billing_payments
        SET stripe_account_id = 'acct_enrichment_guard',
            connect_account_generation = 1,
            stripe_payment_intent_id = 'pi_enrichment_guard',
            stripe_charge_id = 'ch_enrichment_guard'
        WHERE id = v_enrichment_payment;
        RAISE EXCEPTION 'Expected parent enrichment conflicting with a linked child to fail.';
    EXCEPTION
        WHEN check_violation THEN
            IF SQLERRM NOT LIKE '%conflicts with a linked adjustment%' THEN
                RAISE;
            END IF;
    END;

    RAISE NOTICE 'Koaryu payment adjustment convergence verification passed.';
END $$;

ROLLBACK;
