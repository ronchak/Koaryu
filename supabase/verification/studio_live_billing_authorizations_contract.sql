BEGIN;

DO $$
DECLARE
    v_table TEXT := 'public.studio_live_billing_authorizations';
    v_dispositions TEXT := 'public.stripe_connect_account_dispositions';
    v_checkpoints TEXT := 'public.stripe_live_billing_reconciliation_checkpoints';
    v_role TEXT;
BEGIN
    IF to_regclass(v_table) IS NULL
       OR to_regclass(v_dispositions) IS NULL
       OR to_regclass(v_checkpoints) IS NULL THEN
        RAISE EXCEPTION 'Missing durable live billing authorization tables.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'studio_live_billing_authorizations'
           AND relation.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Live billing authorization table must have RLS enabled.';
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
    LOOP
        IF has_table_privilege(v_role, v_table, 'SELECT')
           OR has_table_privilege(v_role, v_table, 'INSERT')
           OR has_table_privilege(v_role, v_table, 'UPDATE')
           OR has_table_privilege(v_role, v_table, 'DELETE')
           OR has_table_privilege(v_role, v_dispositions, 'SELECT')
           OR has_table_privilege(v_role, v_dispositions, 'INSERT')
           OR has_table_privilege(v_role, v_dispositions, 'UPDATE')
           OR has_table_privilege(v_role, v_dispositions, 'DELETE')
           OR has_table_privilege(v_role, v_checkpoints, 'SELECT')
           OR has_table_privilege(v_role, v_checkpoints, 'INSERT') THEN
            RAISE EXCEPTION '% can directly access protected Stripe authorization state.', v_role;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
          FROM information_schema.table_privileges
         WHERE table_schema = 'public'
           AND table_name IN (
               'studio_live_billing_authorizations',
               'stripe_connect_account_dispositions',
               'stripe_live_billing_reconciliation_checkpoints'
           )
           AND grantee = 'PUBLIC'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can directly access protected Stripe authorization state.';
    END IF;

    IF NOT has_table_privilege('service_role', v_table, 'SELECT')
       OR NOT has_table_privilege('service_role', v_dispositions, 'SELECT')
       OR NOT has_table_privilege('service_role', v_checkpoints, 'SELECT')
       OR has_table_privilege('service_role', v_table, 'INSERT')
       OR has_table_privilege('service_role', v_table, 'UPDATE')
       OR has_table_privilege('service_role', v_table, 'DELETE')
       OR has_table_privilege('service_role', v_dispositions, 'INSERT')
       OR has_table_privilege('service_role', v_dispositions, 'UPDATE')
       OR has_table_privilege('service_role', v_dispositions, 'DELETE')
       OR has_table_privilege('service_role', v_checkpoints, 'INSERT') THEN
        RAISE EXCEPTION 'service_role protected-table grants must be read-only; writes go through RPCs.';
    END IF;

    IF has_function_privilege(
        'anon',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Live billing authorization RPC privilege drift.';
    END IF;

    IF has_function_privilege(
        'anon',
        'public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'anon',
        'public.finish_stripe_event_processing_v2(uuid,text,text,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.finish_stripe_event_processing_v2(uuid,text,text,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.finish_stripe_event_processing_v2(uuid,text,text,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Stripe reconciliation/disposition RPC privilege drift.';
    END IF;
END $$;

DO $$
DECLARE
    v_actor UUID := gen_random_uuid();
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_result RECORD;
    v_authorization public.studio_live_billing_authorizations%ROWTYPE;
    v_ref TEXT := replace(gen_random_uuid()::TEXT, '-', '');
    v_event UUID;
    v_audit_count INTEGER;
BEGIN
    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
        (
            v_actor,
            'authenticated',
            'authenticated',
            'billing-auth-actor-' || replace(v_actor::TEXT, '-', '') || '@example.invalid',
            '{}'::JSONB,
            '{}'::JSONB,
            now(),
            now()
        ),
        (
            v_owner,
            'authenticated',
            'authenticated',
            'billing-auth-owner-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
            '{}'::JSONB,
            '{}'::JSONB,
            now(),
            now()
        );

    INSERT INTO public.studios(id, name, slug, owner_id)
    VALUES (
        v_studio,
        'Live Billing Authorization Contract',
        'live-billing-auth-' || replace(v_studio::TEXT, '-', ''),
        v_owner
    );

    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, processed_at, created_at
    ) VALUES (
        'evt_contract_unmapped_gate', 'acct_ContractUnmapped1', true,
        'account.updated', '{}'::JSONB, 'processed', now(), now()
    );

    PERFORM public.record_stripe_live_billing_reconciliation_checkpoint(
        repeat('a', 40), 1, 0, 0, 1, 1, 0, now(), now(), 1, 1, true, true,
        now() + INTERVAL '1 hour', repeat('b', 64),
        'Contract unresolved checkpoint', v_actor, 'operator@example.invalid'
    );
    BEGIN
        PERFORM public.set_studio_live_billing_authorization_atomic(
            v_studio, 'core_subscription', true, now() + INTERVAL '1 hour',
            'Must fail before reconciliation', v_actor, NULL, NULL
        );
        RAISE EXCEPTION 'Unresolved provider account did not block authorization.';
    EXCEPTION WHEN SQLSTATE 'P0B04' THEN
        NULL;
    END;

    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_ContractUnmapped1', true, 'Verified non-Koaryu contract fixture',
        v_actor, 'operator@example.invalid'
    );
    PERFORM public.record_stripe_live_billing_reconciliation_checkpoint(
        repeat('a', 40), 1, 0, 1, 0, 1, 0, now(), now(), 1, 1, true, true,
        now() + INTERVAL '1 hour', repeat('c', 64),
        'Contract all-clear checkpoint', v_actor, 'operator@example.invalid'
    );

    SELECT * INTO v_result
      FROM public.set_studio_live_billing_authorization_atomic(
          v_studio,
          'connect_onboarding',
          true,
          now() + INTERVAL '1 hour',
          'Contract onboarding grant',
          v_actor,
          'operator@example.invalid',
          NULL
      );

    IF v_result.outcome <> 'applied'
       OR NOT v_result.enabled
       OR v_result.connect_account_generation <> 1
       OR v_result.stripe_connected_account_id IS NOT NULL
       OR v_result.revision <> 1 THEN
        RAISE EXCEPTION 'Initial onboarding authorization was not default-safe.';
    END IF;

    BEGIN
        PERFORM public.set_studio_live_billing_authorization_atomic(
            v_studio,
            'connect_payments',
            true,
            now() + INTERVAL '1 hour',
            'Must fail before KYC',
            v_actor,
            NULL,
            NULL
        );
        RAISE EXCEPTION 'Unready Connect account received payment authorization.';
    EXCEPTION WHEN SQLSTATE 'P0B02' THEN
        NULL;
    END;

    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = 'acct_ContractReady1',
           status = 'charges_enabled',
           charges_enabled = true,
           payouts_enabled = true,
           details_submitted = true,
           requirements_due = ARRAY[]::TEXT[]
     WHERE studio_id = v_studio;

    SELECT * INTO v_result
      FROM public.set_studio_live_billing_authorization_atomic(
          v_studio,
          'connect_payments',
          true,
          now() + INTERVAL '1 hour',
          'Contract payments grant',
          v_actor,
          NULL,
          'acct_ContractReady1'
      );

    IF v_result.outcome <> 'applied'
       OR v_result.stripe_connected_account_id <> 'acct_ContractReady1'
       OR v_result.connect_account_generation <> 1 THEN
        RAISE EXCEPTION 'Payment authorization was not bound to the ready account.';
    END IF;

    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = NULL,
           status = 'not_connected',
           charges_enabled = false,
           payouts_enabled = false,
           details_submitted = false,
           metadata = jsonb_build_object('connect_account_generation', 2)
     WHERE studio_id = v_studio;

    SELECT * INTO v_authorization
      FROM public.studio_live_billing_authorizations
     WHERE studio_id = v_studio
       AND scope = 'connect_payments';

    IF v_authorization.connect_account_generation <> 1 THEN
        RAISE EXCEPTION 'Reconnect unexpectedly rewrote authorization provenance.';
    END IF;

    SELECT * INTO v_result
      FROM public.set_studio_live_billing_authorization_atomic(
          v_studio,
          'connect_payments',
          false,
          NULL,
          'Contract rollback',
          v_actor,
          NULL,
          NULL
      );

    IF v_result.outcome <> 'applied'
       OR v_result.enabled
       OR v_result.revision <> 2 THEN
        RAISE EXCEPTION 'Payment authorization revocation did not advance provenance.';
    END IF;

    SELECT count(*) INTO v_audit_count
      FROM public.audit_logs
     WHERE studio_id = v_studio
       AND action IN (
           'live_billing.authorization_granted',
           'live_billing.authorization_revoked'
       );
    IF v_audit_count <> 3 THEN
        RAISE EXCEPTION 'Authorization changes did not write exact audit rows.';
    END IF;

    SELECT * INTO v_result
      FROM public.set_stripe_connect_account_exclusion_atomic(
          'acct_ExplicitlyExcluded1',
          true,
          'Verified retired account contract fixture',
          v_actor,
          NULL
      );
    IF v_result.outcome <> 'applied' OR NOT v_result.excluded OR v_result.revision <> 1 THEN
        RAISE EXCEPTION 'Explicit unmapped-account exclusion was not recorded.';
    END IF;

    BEGIN
        UPDATE public.studio_payment_accounts
           SET stripe_connected_account_id = 'acct_CurrentMapping1'
         WHERE studio_id = v_studio;
        PERFORM public.set_stripe_connect_account_exclusion_atomic(
            'acct_CurrentMapping1',
            true,
            'Must fail for mapped accounts',
            v_actor,
            NULL
        );
        RAISE EXCEPTION 'Mapped account was excluded.';
    EXCEPTION WHEN SQLSTATE 'P0B03' THEN
        NULL;
    END;

    INSERT INTO public.stripe_events(
        stripe_event_id,
        stripe_account_id,
        livemode,
        type,
        payload,
        processing_status,
        processing_token,
        processing_started_at
    ) VALUES (
        'evt_contract_correlation',
        'acct_ContractReady1',
        true,
        'customer.subscription.updated',
        '{}'::JSONB,
        'processing',
        'contract-token',
        now()
    ) RETURNING id INTO v_event;

    PERFORM public.finish_stripe_event_processing_v2(
        v_event,
        'contract-token',
        'failed',
        'unexpected_processing_error',
        v_ref
    );

    IF NOT EXISTS (
        SELECT 1
          FROM public.stripe_events
         WHERE id = v_event
           AND processing_status = 'failed'
           AND error = 'unexpected_processing_error'
           AND error_reference = v_ref
           AND payload = '{}'::JSONB
    ) THEN
        RAISE EXCEPTION 'Webhook failure correlation did not remain sanitized.';
    END IF;
END $$;

ROLLBACK;
