BEGIN;

DO $$
DECLARE
    v_role TEXT;
    v_protected_table TEXT;
    v_definition TEXT;
BEGIN
    FOREACH v_protected_table IN ARRAY ARRAY[
        'public.studio_live_billing_authorizations',
        'public.stripe_connect_account_dispositions',
        'public.stripe_live_billing_reconciliation_checkpoints',
        'public.stripe_live_billing_reconciliation_account_evidence'
    ] LOOP
        IF to_regclass(v_protected_table) IS NULL THEN
            RAISE EXCEPTION 'Missing protected live-billing table %.', v_protected_table;
        END IF;
        FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            IF has_table_privilege(v_role, v_protected_table, 'SELECT')
               OR has_table_privilege(v_role, v_protected_table, 'INSERT')
               OR has_table_privilege(v_role, v_protected_table, 'UPDATE')
               OR has_table_privilege(v_role, v_protected_table, 'DELETE') THEN
                RAISE EXCEPTION '% can access protected table %.', v_role, v_protected_table;
            END IF;
        END LOOP;
        IF NOT has_table_privilege('service_role', v_protected_table, 'SELECT')
           OR has_table_privilege('service_role', v_protected_table, 'INSERT')
           OR has_table_privilege('service_role', v_protected_table, 'UPDATE')
           OR has_table_privilege('service_role', v_protected_table, 'DELETE') THEN
            RAISE EXCEPTION 'service_role grants drifted for %.', v_protected_table;
        END IF;
    END LOOP;

    IF has_function_privilege(
        'service_role',
        'public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Legacy aggregate checkpoint writer remains callable.';
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_function_privilege(
            v_role,
            'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
            'EXECUTE'
        ) THEN
            RAISE EXCEPTION '% can call a service-only live-billing RPC.', v_role;
        END IF;
    END LOOP;

    IF NOT has_function_privilege(
        'service_role',
        'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'service_role cannot call the required live-billing RPCs.';
    END IF;

    SELECT pg_get_functiondef(
        'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)'::regprocedure
    ) INTO v_definition;
    IF v_definition NOT LIKE '%https://koaryu.onrender.com/health/ready%'
       OR v_definition NOT LIKE '%charge.refund.updated%'
       OR v_definition NOT LIKE '%refund.created%'
       OR v_definition NOT LIKE '%refund.failed%'
       OR v_definition NOT LIKE '%refund.updated%' THEN
        RAISE EXCEPTION 'Pinned production readiness or refund topology contract drifted.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
           AND relation.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Per-account reconciliation evidence must have RLS enabled.';
    END IF;
END $$;

DO $$
DECLARE
    v_actor UUID := gen_random_uuid();
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_blank_studio UUID := gen_random_uuid();
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_report JSONB;
    v_watermark BIGINT;
    v_result RECORD;
    v_bad_event UUID;
    v_ref TEXT := replace(gen_random_uuid()::TEXT, '-', '');
BEGIN
    INSERT INTO auth.users (
        id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) VALUES
        (v_actor, 'authenticated', 'authenticated',
         'billing-atomic-actor-' || replace(v_actor::TEXT, '-', '') || '@example.invalid',
         '{}'::JSONB, '{}'::JSONB, now(), now()),
        (v_owner, 'authenticated', 'authenticated',
         'billing-atomic-owner-' || replace(v_owner::TEXT, '-', '') || '@example.invalid',
         '{}'::JSONB, '{}'::JSONB, now(), now());

    INSERT INTO public.studios(id, name, slug, owner_id) VALUES
        (v_studio, 'Atomic Live Billing Contract',
         'atomic-live-billing-' || replace(v_studio::TEXT, '-', ''), v_owner),
        (v_blank_studio, 'Accountless Connect Contract',
         'accountless-connect-' || replace(v_blank_studio::TEXT, '-', ''), v_owner);

    INSERT INTO public.studio_payment_accounts(
        studio_id, stripe_connected_account_id, status, charges_enabled,
        payouts_enabled, details_submitted, requirements_due, metadata
    ) VALUES (
        v_studio, 'acct_ContractReady1', 'charges_enabled', true,
        true, true, ARRAY[]::TEXT[], jsonb_build_object('connect_account_generation', 1)
    );

    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, processed_at, created_at
    ) VALUES
        ('evt_atomic_platform', NULL, true, 'invoice.paid', '{}'::JSONB,
         'processed', now() - INTERVAL '1 minute', now() - INTERVAL '1 minute'),
        ('evt_atomic_connect', 'acct_ContractReady1', true, 'account.updated', '{}'::JSONB,
         'processed', now() - INTERVAL '1 minute', now() - INTERVAL '1 minute');

    SELECT MAX(live_billing_ingest_sequence) INTO v_watermark
      FROM public.stripe_events
     WHERE livemode;

    v_report := jsonb_build_object(
        'schema_version', 2,
        'candidate_sha', repeat('a', 40),
        'provider_mode', 'live',
        'evidence_source', 'provider_read',
        'probe', 'production',
        'checkpoint_eligible', true,
        'event_window', jsonb_build_object(
            'started_at', '2026-07-13T00:00:00+00:00',
            'ended_at', now()
        ),
        'deployment_readiness', jsonb_build_object(
            'production_exact_candidate_verified', true,
            'verified_at', now()
        ),
        'counts', jsonb_build_object(
            'provider_accounts', 1,
            'mapped_accounts', 1,
            'excluded_accounts', 0,
            'unresolved_accounts', 0,
            'unresolved_event_accounts', 0
        ),
        'events_since_2026_07_13', jsonb_build_object(
            'bounded_provider_total', 2,
            'bounded_local_total', 2,
            'provider_only_event_count', 0,
            'local_only_event_count', 0,
            'failed', 0,
            'latest_created_at', now() - INTERVAL '1 minute',
            'local_event_ingest_watermark', v_watermark
        ),
        'platform_delivery', jsonb_build_object(
            'provider_event_count', 1,
            'local_event_count', 1,
            'delivery_verified_at', now() - INTERVAL '1 minute',
            'fresh', true
        ),
        'webhook_delivery', jsonb_build_object(
            'enabled_platform_endpoint_count', 1,
            'enabled_connect_endpoint_count', 1,
            'unexpected_enabled_endpoint_count', 0,
            'platform_endpoint_contract_matched', true,
            'connect_endpoint_contract_matched', true
        ),
        'account_evidence', jsonb_build_array(jsonb_build_object(
            'studio_id', v_studio,
            'stripe_connected_account_id', 'acct_ContractReady1',
            'connect_account_generation', 1,
            'provider_event_count', 1,
            'local_event_count', 1,
            'provider_only_event_count', 0,
            'local_only_event_count', 0,
            'delivery_verified_at', now() - INTERVAL '1 minute',
            'fresh', true
        ))
    );

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v2(
            jsonb_set(v_report, '{evidence_source}', '"offline_snapshot"'::JSONB),
            now() + INTERVAL '1 hour', repeat('b', 64),
            'Offline must remain ineligible', v_actor, NULL
        );
        RAISE EXCEPTION 'Offline evidence produced a live checkpoint.';
    EXCEPTION WHEN SQLSTATE 'P0B10' THEN
        NULL;
    END;

    SELECT * INTO v_checkpoint
      FROM public.record_stripe_live_billing_reconciliation_checkpoint_v2(
          v_report,
          now() + INTERVAL '1 hour',
          repeat('c', 64),
          'Exact production candidate contract',
          v_actor,
          'operator@example.invalid'
      );

    IF v_checkpoint.candidate_sha <> repeat('a', 40)
       OR v_checkpoint.deployment_ready_sha <> repeat('a', 40)
       OR v_checkpoint.deployment_ready_url <> 'https://koaryu.onrender.com/health/ready'
       OR v_checkpoint.account_evidence_count <> 1
       OR v_checkpoint.local_event_ingest_watermark <> v_watermark THEN
        RAISE EXCEPTION 'Checkpoint did not persist exact candidate and generation evidence.';
    END IF;

    SELECT * INTO v_result
      FROM public.set_studio_live_billing_authorization_atomic(
          v_studio, 'connect_payments', true, now() + INTERVAL '1 hour',
          'One-studio canary contract', v_actor, NULL, 'acct_ContractReady1'
      );
    IF v_result.outcome <> 'applied' OR NOT v_result.enabled THEN
        RAISE EXCEPTION 'Ready Connect payment scope was not granted.';
    END IF;

    SELECT * INTO v_result
      FROM public.authorize_studio_live_billing_mutation_atomic(
          v_studio, 'connected_invoice.pay', 'connect_payments',
          'acct_ContractReady1', repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.authorized OR v_result.checkpoint_id <> v_checkpoint.id THEN
        RAISE EXCEPTION 'Exact payment scope did not pass atomic authorization.';
    END IF;

    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_invoice.pay', 'connect_payments',
        'acct_ContractReady1', repeat('d', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Stale candidate SHA passed atomic authorization.';
    END IF;

    SELECT * INTO v_result
      FROM public.set_studio_live_billing_authorization_atomic(
          v_blank_studio, 'connect_onboarding', true, now() + INTERVAL '1 hour',
          'Accountless hosted onboarding contract', v_actor, NULL, NULL
      );
    IF v_result.stripe_connected_account_id IS NOT NULL THEN
        RAISE EXCEPTION 'Accountless onboarding grant unexpectedly bound an account.';
    END IF;

    SELECT * INTO v_result
      FROM public.authorize_studio_live_billing_mutation_atomic(
          v_blank_studio, 'connect_account.create', 'connect_onboarding',
          NULL, repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.authorized THEN
        RAISE EXCEPTION 'Semantic accountless Connect create was denied.';
    END IF;

    SELECT * INTO v_result
      FROM public.authorize_studio_live_billing_mutation_atomic(
          v_blank_studio, 'connect_branding_file.create', 'connect_onboarding',
          NULL, repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.authorized THEN
        RAISE EXCEPTION 'Studio-scoped accountless branding upload was denied.';
    END IF;

    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_blank_studio, 'connect_onboarding_v2.post', 'connect_onboarding',
        NULL, repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Generic V2 operation bypassed semantic authorization.';
    END IF;

    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, error, error_reference, created_at
    ) VALUES (
        'evt_atomic_new_failure', 'acct_ContractReady1', true, 'refund.failed', '{}'::JSONB,
        'failed', 'unexpected_processing_error', v_ref, now()
    ) RETURNING id INTO v_bad_event;

    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_refund.create', 'connect_payments',
        'acct_ContractReady1', repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'A failed event after the grant did not invalidate authorization.';
    END IF;

    UPDATE public.stripe_events
       SET processing_status = 'processed', error = NULL, error_reference = NULL, processed_at = now()
     WHERE id = v_bad_event;
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_refund.create', 'connect_payments',
        'acct_ContractReady1', repeat('a', 40)
    );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Resolved post-grant event state did not restore authorization.';
    END IF;

    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, processed_at, created_at
    ) VALUES (
        'evt_atomic_new_unmapped', 'acct_NewUnmapped1', true, 'account.updated', '{}'::JSONB,
        'processed', now(), now()
    );
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_invoice.pay', 'connect_payments',
        'acct_ContractReady1', repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'A new unmapped event account did not invalidate authorization.';
    END IF;

    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_NewUnmapped1', true, 'Reviewed non-Koaryu contract account', v_actor, NULL
    );
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_invoice.pay', 'connect_payments',
        'acct_ContractReady1', repeat('a', 40)
    );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reviewed account disposition did not clear current unmapped drift.';
    END IF;

    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = 'acct_ContractReady2',
           metadata = jsonb_build_object('connect_account_generation', 2)
     WHERE studio_id = v_studio;
    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_ContractReady1', true, 'Prior generation retired', v_actor, NULL
    );
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_invoice.pay', 'connect_payments',
        'acct_ContractReady2', repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Reconnect generation inherited stale authorization evidence.';
    END IF;

    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = 'acct_ContractReady1',
           metadata = jsonb_build_object('connect_account_generation', 1),
           charges_enabled = false
     WHERE studio_id = v_studio;
    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_ContractReady1', false, 'Restore mapped contract account', v_actor, NULL
    );
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_invoice.pay', 'connect_payments',
        'acct_ContractReady1', repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Current readiness loss did not deny payment mutation.';
    END IF;

    UPDATE public.studio_payment_accounts
       SET charges_enabled = true
     WHERE studio_id = v_studio;
    PERFORM public.set_studio_live_billing_authorization_atomic(
        v_studio, 'connect_payments', false, NULL,
        'Canary rollback contract', v_actor, NULL, NULL
    );
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio, 'connected_invoice.pay', 'connect_payments',
        'acct_ContractReady1', repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Revoked payment scope remained authorized.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.stripe_events
         WHERE id = v_bad_event
           AND processing_status = 'processed'
           AND error IS NULL
           AND error_reference IS NULL
    ) THEN
        RAISE EXCEPTION 'Failure correlation disposition did not remain privacy-safe.';
    END IF;
END $$;

ROLLBACK;
