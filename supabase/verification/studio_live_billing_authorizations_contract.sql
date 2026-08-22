BEGIN;

DO $$
DECLARE
    v_role TEXT;
    v_protected_table TEXT;
    v_definition TEXT;
    v_sequence TEXT;
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

    IF to_regclass('public.stripe_connect_onboarding_bootstraps') IS NULL
       OR has_table_privilege('anon', 'public.stripe_connect_onboarding_bootstraps', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'public.stripe_connect_onboarding_bootstraps', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'public.stripe_connect_onboarding_bootstraps', 'SELECT,INSERT,UPDATE,DELETE')
       OR NOT EXISTS (
           SELECT 1 FROM pg_class relation
           WHERE relation.oid = 'public.stripe_connect_onboarding_bootstraps'::REGCLASS
             AND relation.relrowsecurity
       ) THEN
        RAISE EXCEPTION 'Connect onboarding bootstrap table is not default-deny.';
    END IF;

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
        ) OR has_function_privilege(
            v_role,
            'public.preflight_connect_onboarding_bootstrap_begin(uuid,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.preflight_connect_onboarding_bootstrap_resume(uuid,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)',
            'EXECUTE'
        ) OR has_function_privilege(
            v_role,
            'public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)',
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
    ) OR NOT has_function_privilege(
        'service_role',
        'public.preflight_connect_onboarding_bootstrap_begin(uuid,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.preflight_connect_onboarding_bootstrap_resume(uuid,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role',
        'public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'service_role cannot call the required live-billing RPCs.';
    END IF;

    IF has_function_privilege(
        'service_role',
        'public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'service_role',
        'public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Legacy raw-token bootstrap RPC remains callable.';
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

    IF to_regclass('private.stripe_connect_account_identity_guards') IS NULL
       OR has_table_privilege('anon', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('service_role', 'private.stripe_connect_account_identity_guards', 'SELECT,INSERT,UPDATE,DELETE') THEN
        RAISE EXCEPTION 'Private Connect identity guard ACL drifted.';
    END IF;

    FOREACH v_sequence IN ARRAY ARRAY[
        pg_get_serial_sequence('public.stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence'),
        pg_get_serial_sequence('public.operational_alert_audit_events', 'id'),
        pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence')
    ] LOOP
        IF v_sequence IS NULL
           OR has_sequence_privilege('anon', v_sequence, 'USAGE,SELECT,UPDATE')
           OR has_sequence_privilege('authenticated', v_sequence, 'USAGE,SELECT,UPDATE')
           OR NOT has_sequence_privilege('service_role', v_sequence, 'USAGE')
           OR NOT has_sequence_privilege('service_role', v_sequence, 'SELECT')
           OR has_sequence_privilege('service_role', v_sequence, 'UPDATE') THEN
            RAISE EXCEPTION 'Release identity sequence ACL drifted.';
        END IF;
    END LOOP;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_function_privilege(v_role, 'public.koaryu_release_schema_preflight()', 'EXECUTE') THEN
            RAISE EXCEPTION '% can execute the hosted schema preflight.', v_role;
        END IF;
        IF has_function_privilege(v_role, 'public.koaryu_release_schema_preflight_v2()', 'EXECUTE') THEN
            RAISE EXCEPTION '% can execute the hosted V2 schema preflight.', v_role;
        END IF;
        IF has_function_privilege(v_role, 'public.koaryu_release_schema_preflight_v3()', 'EXECUTE') THEN
            RAISE EXCEPTION '% can execute the hosted V3 schema preflight.', v_role;
        END IF;
        IF has_function_privilege(v_role, 'public.koaryu_release_schema_preflight_v6()', 'EXECUTE') THEN
            RAISE EXCEPTION '% can execute the retired hosted V6 schema preflight.', v_role;
        END IF;
    END LOOP;
    IF EXISTS (
        SELECT 1
          FROM pg_proc function
          CROSS JOIN LATERAL aclexplode(coalesce(
              function.proacl, acldefault('f', function.proowner)
          )) acl
         WHERE function.oid = 'public.koaryu_release_schema_preflight()'::REGPROCEDURE
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can execute the hosted schema preflight.';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc function
          CROSS JOIN LATERAL aclexplode(coalesce(
              function.proacl, acldefault('f', function.proowner)
          )) acl
         WHERE function.oid = 'public.koaryu_release_schema_preflight_v2()'::REGPROCEDURE
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can execute the hosted V2 schema preflight.';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc function
          CROSS JOIN LATERAL aclexplode(coalesce(
              function.proacl, acldefault('f', function.proowner)
          )) acl
         WHERE function.oid = 'public.koaryu_release_schema_preflight_v3()'::REGPROCEDURE
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can execute the hosted V3 schema preflight.';
    END IF;
    IF EXISTS (
        SELECT 1
          FROM pg_proc function
          CROSS JOIN LATERAL aclexplode(coalesce(
              function.proacl, acldefault('f', function.proowner)
          )) acl
         WHERE function.oid = 'public.koaryu_release_schema_preflight_v6()'::REGPROCEDURE
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'PUBLIC can execute the retired hosted V6 schema preflight.';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.koaryu_release_schema_preflight()', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role cannot execute the hosted schema preflight.';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.koaryu_release_schema_preflight_v2()', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role cannot execute the hosted V2 schema preflight.';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.koaryu_release_schema_preflight_v3()', 'EXECUTE') THEN
        RAISE EXCEPTION 'service_role cannot execute the hosted V3 schema preflight.';
    END IF;
    IF has_function_privilege('service_role', 'private.koaryu_release_operational_manifest_v2()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_operational_manifest_v2()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_operational_manifest_v2()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.koaryu_release_operational_manifest_v2_base()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_operational_manifest_v2_base()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_operational_manifest_v2_base()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.koaryu_release_operational_manifest_v4()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_operational_manifest_v4()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_operational_manifest_v4()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.koaryu_release_operational_manifest_v5()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_operational_manifest_v5()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_operational_manifest_v5()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.koaryu_release_operational_manifest_v6()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_operational_manifest_v6()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_operational_manifest_v6()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.koaryu_release_operational_manifest_v7()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_operational_manifest_v7()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_operational_manifest_v7()', 'EXECUTE')
       OR has_function_privilege('service_role', 'private.koaryu_release_starting_belt_manifest_v9()', 'EXECUTE')
       OR has_function_privilege('anon', 'private.koaryu_release_starting_belt_manifest_v9()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'private.koaryu_release_starting_belt_manifest_v9()', 'EXECUTE')
       OR has_function_privilege('service_role', 'public.koaryu_release_schema_preflight_v6()', 'EXECUTE') THEN
        RAISE EXCEPTION 'Private operational manifest helper is directly callable.';
    END IF;
END $$;

DO $$
DECLARE
    v_actor UUID := gen_random_uuid();
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_blank_studio UUID := gen_random_uuid();
    v_other_studio UUID := gen_random_uuid();
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_report JSONB;
    v_watermark BIGINT;
    v_result RECORD;
    v_bad_event UUID;
    v_ref TEXT := replace(gen_random_uuid()::TEXT, '-', '');
    v_guard_event UUID;
    v_preflight RECORD;
    v_audit_count INTEGER;
    v_bootstrap RECORD;
    v_link_key TEXT;
    v_processing_event UUID;
    v_status TEXT;
    v_recovery_context JSONB;
    v_bootstrap_updated_at TIMESTAMPTZ;
    v_delivery_receipt_hash TEXT := repeat('4', 64);
    v_rotated_receipt_hash TEXT := repeat('5', 64);
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
         'accountless-connect-' || replace(v_blank_studio::TEXT, '-', ''), v_owner),
        (v_other_studio, 'Pre-existing Evidence Contract',
         'pre-existing-evidence-' || replace(v_other_studio::TEXT, '-', ''), v_owner);

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
      FROM public.preflight_connect_onboarding_bootstrap_begin(
          v_blank_studio, repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.eligible OR v_result.connect_account_generation <> 1 THEN
        RAISE EXCEPTION 'Read-only begin preflight denied an eligible accountless bootstrap.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.stripe_connect_onboarding_bootstraps
         WHERE studio_id = v_blank_studio
    ) THEN
        RAISE EXCEPTION 'Begin preflight mutated bootstrap state.';
    END IF;
    SELECT * INTO v_result
      FROM public.preflight_connect_onboarding_bootstrap_resume(
          v_blank_studio, repeat('a', 40)
      );
    IF NOT FOUND OR v_result.eligible OR v_result.phase <> 'none' THEN
        RAISE EXCEPTION 'Resume preflight did not distinguish a missing bootstrap.';
    END IF;

    v_link_key := 'koaryu-connect-onboarding-' || v_blank_studio::TEXT || '-g1-' || repeat('b', 24);
    v_recovery_context := jsonb_build_object(
        'business_name', 'Accountless Connect Contract',
        'contact_email', 'owner@example.invalid',
        'business_entity_type', 'individual',
        'refresh_url', 'https://app.koaryu.test/billing/connect/refresh',
        'return_url', 'https://app.koaryu.test/billing?connect=return'
    );
    SELECT * INTO v_bootstrap
      FROM public.prepare_connect_onboarding_bootstrap_atomic(
          v_blank_studio, repeat('a', 40), 1, v_recovery_context,
          repeat('1', 64), repeat('2', 64),
          'koaryu-connect-account-' || v_blank_studio::TEXT || '-g1',
          v_link_key
      );
    IF NOT FOUND OR v_bootstrap.bootstrap_id IS NULL
       OR v_bootstrap.recovery_context IS DISTINCT FROM v_recovery_context THEN
        RAISE EXCEPTION 'Bootstrap preparation did not persist one exact recovery context.';
    END IF;

    SELECT updated_at INTO v_bootstrap_updated_at
      FROM public.stripe_connect_onboarding_bootstraps
     WHERE id = v_bootstrap.bootstrap_id;
    SELECT * INTO v_result
      FROM public.preflight_connect_onboarding_bootstrap_resume(
          v_blank_studio, repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.eligible OR v_result.phase <> 'account_create' THEN
        RAISE EXCEPTION 'Read-only resume preflight denied the stored account-create phase.';
    END IF;
    IF (SELECT updated_at FROM public.stripe_connect_onboarding_bootstraps
         WHERE id = v_bootstrap.bootstrap_id) <> v_bootstrap_updated_at THEN
        RAISE EXCEPTION 'Resume preflight mutated bootstrap state.';
    END IF;
    SELECT * INTO v_result
      FROM public.preflight_connect_onboarding_bootstrap_begin(
          v_blank_studio, repeat('a', 40)
      );
    IF NOT FOUND OR v_result.eligible THEN
        RAISE EXCEPTION 'Begin preflight offered a second permit after preparation.';
    END IF;

    -- Exact same-context preparation recovers the same row; any context drift
    -- is support-required and must never mint another permit.
    SELECT * INTO v_result
      FROM public.prepare_connect_onboarding_bootstrap_atomic(
          v_blank_studio, repeat('a', 40), 1, v_recovery_context,
          repeat('1', 64), repeat('2', 64),
          'koaryu-connect-account-' || v_blank_studio::TEXT || '-g1', v_link_key
      );
    IF NOT FOUND OR v_result.bootstrap_id <> v_bootstrap.bootstrap_id THEN
        RAISE EXCEPTION 'Exact preparation retry did not recover the original row.';
    END IF;
    PERFORM public.prepare_connect_onboarding_bootstrap_atomic(
        v_blank_studio, repeat('a', 40), 1,
        v_recovery_context || jsonb_build_object('return_url', 'https://app.koaryu.test/changed'),
        repeat('1', 64), repeat('2', 64),
        'koaryu-connect-account-' || v_blank_studio::TEXT || '-g1', v_link_key
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Cross-context preparation reused the original permit.';
    END IF;

    SELECT * INTO v_result
      FROM public.authorize_connect_onboarding_bootstrap_account_create_v2(
          v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
          repeat('1', 64), 'koaryu-connect-account-' || v_blank_studio::TEXT || '-g1'
      );
    IF NOT FOUND OR NOT v_result.authorized OR v_result.bootstrap_id <> v_bootstrap.bootstrap_id THEN
        RAISE EXCEPTION 'Account creation did not use the prepared bootstrap permit.';
    END IF;

    BEGIN
        PERFORM public.bind_connect_onboarding_bootstrap_account_v2(
            v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
            'acct_BootstrapCreated1', 'company'
        );
        RAISE EXCEPTION 'Bind accepted an entity type outside the stored recovery context.';
    EXCEPTION WHEN SQLSTATE 'P0B21' THEN
        NULL;
    END;

    SELECT * INTO v_result
      FROM public.bind_connect_onboarding_bootstrap_account_v2(
          v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
          'acct_BootstrapCreated1', 'individual'
      );
    IF v_result.stripe_connected_account_id <> 'acct_BootstrapCreated1'
       OR private.current_connect_account_generation(v_result.metadata) <> 1 THEN
        RAISE EXCEPTION 'Created account was not atomically bound to the bootstrap generation.';
    END IF;

    SELECT * INTO v_result
      FROM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
          v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
          'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key
      );
    IF NOT FOUND OR NOT v_result.authorized
       OR v_result.bootstrap_id <> v_bootstrap.bootstrap_id THEN
        RAISE EXCEPTION 'Initial Account Link did not consume the same bootstrap permit.';
    END IF;

    -- An uncertain provider call may reauthorize only the same permit, payload,
    -- account, generation, candidate, and stored idempotency key.
    SELECT * INTO v_result
      FROM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
          v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
          'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key
      );
    IF NOT FOUND OR v_result.bootstrap_id <> v_bootstrap.bootstrap_id THEN
        RAISE EXCEPTION 'Exact idempotent retry minted or lost the original permit.';
    END IF;

    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
        v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
        'acct_BootstrapCreated1', repeat('2', 64), repeat('4', 64), v_link_key
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Changed initial-link payload replayed a claimed bootstrap.';
    END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
        v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
        'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64),
        'koaryu-connect-onboarding-' || v_blank_studio::TEXT || '-g1-' || repeat('c', 24)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Changed idempotency key replayed a claimed bootstrap.';
    END IF;

    -- No ordinary or later Account Link inherits the bootstrap waiver.
    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_blank_studio, 'connect_onboarding_link.create', 'connect_onboarding',
        'acct_BootstrapCreated1', repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'A later Account Link bypassed generation-bound checkpoint evidence.';
    END IF;

    BEGIN
        INSERT INTO public.studio_payment_accounts(
            studio_id, stripe_connected_account_id, status, charges_enabled,
            payouts_enabled, details_submitted, requirements_due, metadata
        ) VALUES (
            v_other_studio, 'acct_PreexistingGap1', 'onboarding_incomplete', false,
            false, false, ARRAY[]::TEXT[], jsonb_build_object('connect_account_generation', 1)
        );
        PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
            v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
            'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key
        );
        IF FOUND THEN
            RAISE EXCEPTION 'Bootstrap waiver covered a second mapping without checkpoint evidence.';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
             WHERE bootstrap.id = v_bootstrap.bootstrap_id
               AND bootstrap.initial_link_support_required_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'Second mapping did not close uncertain initial-link retry.';
        END IF;
        RAISE EXCEPTION 'rollback second-mapping probe' USING ERRCODE = 'P0B33';
    EXCEPTION WHEN SQLSTATE 'P0B33' THEN
        NULL;
    END;

    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, created_at
    ) VALUES (
        'evt_bootstrap_processing_gate', 'acct_BootstrapCreated1', true,
        'account.application.deauthorized', '{}'::JSONB, 'pending', now()
    ) RETURNING id INTO v_processing_event;

    FOREACH v_status IN ARRAY ARRAY['pending', 'processing', 'failed', 'ignored'] LOOP
        BEGIN
            UPDATE public.stripe_events
               SET processing_status = v_status,
                   processed_at = NULL,
                   error = CASE WHEN v_status = 'failed' THEN 'bootstrap_processing_gate' ELSE NULL END
             WHERE id = v_processing_event;
            PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
                v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
                'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key
            );
            IF FOUND THEN
                RAISE EXCEPTION 'Relevant % event passed the mutation-time processing gate.', v_status;
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
                 WHERE bootstrap.id = v_bootstrap.bootstrap_id
                   AND bootstrap.initial_link_support_required_at IS NOT NULL
            ) THEN
                RAISE EXCEPTION 'Blocked % event did not close uncertain initial-link retry.', v_status;
            END IF;
            RAISE EXCEPTION 'rollback processing-state probe' USING ERRCODE = 'P0B32';
        EXCEPTION WHEN SQLSTATE 'P0B32' THEN
            NULL;
        END;
    END LOOP;
    UPDATE public.stripe_events
       SET processing_status = 'processed', processed_at = now(), error = NULL
     WHERE id = v_processing_event;

    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_ExcludedBootstrap1', true, 'Reviewed out-of-scope bootstrap contract', v_actor, NULL
    );
    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, created_at
    ) VALUES (
        'evt_bootstrap_excluded_ignored', 'acct_ExcludedBootstrap1', true,
        'account.updated', '{}'::JSONB, 'ignored', now()
    );
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
        v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
        'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key
    );
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reviewed excluded account incorrectly blocked the in-scope bootstrap.';
    END IF;

    -- A provider response registers only a short-lived hashed delivery receipt.
    -- It does not retire the bootstrap before the authenticated browser acks.
    SELECT * INTO v_result
      FROM public.record_connect_onboarding_bootstrap_initial_link_response(
          v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
          'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key,
          repeat('6', 64), v_delivery_receipt_hash
      );
    IF NOT FOUND OR NOT v_result.recorded THEN
        RAISE EXCEPTION 'Initial-link provider response was not recorded for delivery.';
    END IF;
    SELECT * INTO v_result
      FROM public.preflight_connect_onboarding_bootstrap_resume(
          v_blank_studio, repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.eligible OR v_result.phase <> 'initial_link_delivery_pending' THEN
        RAISE EXCEPTION 'A recorded response retired the bootstrap before browser acknowledgement.';
    END IF;

    -- If authorization won the lock just before expiry but the provider returned
    -- afterward, response recording must not reopen the expired delivery window.
    BEGIN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_claimed_at = now() - INTERVAL '3 minutes',
               initial_link_response_recorded_at = now() - INTERVAL '2 minutes',
               initial_link_delivery_receipt_expires_at = now() - INTERVAL '1 second'
         WHERE id = v_bootstrap.bootstrap_id;
        PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(
            v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
            'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key,
            repeat('6', 64), v_rotated_receipt_hash
        );
        IF NOT EXISTS (
            SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
             WHERE bootstrap.id = v_bootstrap.bootstrap_id
               AND bootstrap.initial_link_support_required_at IS NOT NULL
               AND bootstrap.initial_link_delivery_receipt_sha256 = v_delivery_receipt_hash
        ) THEN
            RAISE EXCEPTION 'Late provider response rotated an expired delivery receipt.';
        END IF;
        RAISE EXCEPTION 'rollback late-response expiry probe' USING ERRCODE = 'P0B31';
    EXCEPTION WHEN SQLSTATE 'P0B31' THEN
        NULL;
    END;

    -- A lost HTTP response can recover only the same provider response/key. A
    -- retry rotates the delivery receipt so a late response cannot retire it.
    SELECT * INTO v_result
      FROM public.record_connect_onboarding_bootstrap_initial_link_response(
          v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
          'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key,
          repeat('6', 64), v_rotated_receipt_hash
      );
    IF NOT FOUND OR NOT v_result.recorded THEN
        RAISE EXCEPTION 'Exact same-response recovery could not rotate its receipt.';
    END IF;
    PERFORM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
        v_blank_studio, repeat('a', 40), v_delivery_receipt_hash
    );
    IF FOUND THEN
        RAISE EXCEPTION 'A stale delivery receipt retired the bootstrap.';
    END IF;
    PERFORM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
        v_studio, repeat('a', 40), v_rotated_receipt_hash
    );
    IF FOUND THEN
        RAISE EXCEPTION 'A cross-studio delivery receipt retired the bootstrap.';
    END IF;

    -- A different provider response under the claimed idempotency key is
    -- irreconcilable. Verify it becomes support-required, then roll back only
    -- this negative-test subtransaction so the valid response can be acked.
    BEGIN
        PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(
            v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
            'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key,
            repeat('7', 64), v_rotated_receipt_hash
        );
        IF NOT EXISTS (
            SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
             WHERE bootstrap.id = v_bootstrap.bootstrap_id
               AND bootstrap.initial_link_support_required_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'Changed provider response did not require support.';
        END IF;
        RAISE EXCEPTION 'rollback changed-response probe' USING ERRCODE = 'P0B30';
    EXCEPTION WHEN SQLSTATE 'P0B30' THEN
        NULL;
    END;

    SELECT * INTO v_result
      FROM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
          v_blank_studio, repeat('a', 40), v_rotated_receipt_hash
      );
    IF NOT FOUND OR NOT v_result.acknowledged THEN
        RAISE EXCEPTION 'Exact browser delivery receipt did not retire the bootstrap.';
    END IF;
    -- Lost acknowledgement responses retry idempotently only with that receipt.
    SELECT * INTO v_result
      FROM public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
          v_blank_studio, repeat('a', 40), v_rotated_receipt_hash
      );
    IF NOT FOUND OR NOT v_result.acknowledged THEN
        RAISE EXCEPTION 'Exact delivery acknowledgement was not idempotent.';
    END IF;
    SELECT * INTO v_result
      FROM public.preflight_connect_onboarding_bootstrap_resume(
          v_blank_studio, repeat('f', 40)
      );
    IF NOT FOUND OR v_result.eligible OR v_result.phase <> 'completed' THEN
        RAISE EXCEPTION 'Delivered bootstrap was not durably retired across candidate change.';
    END IF;
    PERFORM public.authorize_connect_onboarding_bootstrap_initial_link_v2(
        v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
        'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Delivered bootstrap authorized a second initial Account Link.';
    END IF;
    PERFORM public.record_connect_onboarding_bootstrap_initial_link_response(
        v_bootstrap.bootstrap_id, v_blank_studio, repeat('a', 40), 1,
        'acct_BootstrapCreated1', repeat('2', 64), repeat('3', 64), v_link_key,
        repeat('6', 64), repeat('8', 64)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Delivered bootstrap accepted another provider response.';
    END IF;

    DELETE FROM public.stripe_events WHERE id = v_processing_event;
    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = NULL,
           status = 'not_connected',
           metadata = jsonb_build_object('connect_account_generation', 1)
     WHERE studio_id = v_blank_studio;

    -- Even an expired, unbound permit cannot be replaced for the same studio
    -- generation after a provider result became uncertain.
    UPDATE public.stripe_connect_onboarding_bootstraps
       SET stripe_connected_account_id = NULL,
           account_bound_at = NULL,
           initial_link_payload_sha256 = NULL,
           initial_link_claimed_at = NULL,
           initial_link_last_retry_at = NULL,
           initial_link_response_sha256 = NULL,
           initial_link_response_recorded_at = NULL,
           initial_link_delivery_receipt_sha256 = NULL,
           initial_link_delivery_receipt_expires_at = NULL,
           initial_link_delivered_at = NULL,
           initial_link_support_required_at = NULL,
           authorized_at = now() - INTERVAL '10 minutes',
           expires_at = now() - INTERVAL '5 minutes',
           recovery_expires_at = now() - INTERVAL '1 minute',
           aborted_at = NULL
     WHERE id = v_bootstrap.bootstrap_id;
    PERFORM public.prepare_connect_onboarding_bootstrap_atomic(
        v_blank_studio, repeat('a', 40), 1, v_recovery_context,
        repeat('1', 64), repeat('2', 64),
        'koaryu-connect-account-' || v_blank_studio::TEXT || '-g1', v_link_key
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Expired uncertain create minted a second generation permit.';
    END IF;
    SELECT * INTO v_result
      FROM public.preflight_connect_onboarding_bootstrap_resume(
          v_blank_studio, repeat('a', 40)
      );
    IF NOT FOUND OR v_result.eligible OR v_result.phase <> 'support_required' THEN
        RAISE EXCEPTION 'Expired bootstrap did not become support-required.';
    END IF;
    UPDATE public.stripe_connect_onboarding_bootstraps
       SET aborted_at = now()
     WHERE id = v_bootstrap.bootstrap_id;

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

    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_ContractReady1', false, 'Restore mapped contract account', v_actor, NULL
    );
    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = 'acct_ContractReady1',
           metadata = jsonb_build_object('connect_account_generation', 1),
           charges_enabled = false
     WHERE studio_id = v_studio;
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

    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        'acct_GuardExcludedFinal1', true, 'Guard exclusion-first contract', v_actor, NULL
    );
    BEGIN
        INSERT INTO public.studio_payment_accounts(
            studio_id, stripe_connected_account_id, status, metadata
        ) VALUES (
            v_blank_studio, 'acct_GuardExcludedFinal1', 'pending', '{}'::JSONB
        );
        RAISE EXCEPTION 'Exclusion-first identity invariant accepted a mapping.';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = 'acct_GuardMappedFinal1'
     WHERE studio_id = v_studio;
    BEGIN
        INSERT INTO public.stripe_connect_account_dispositions(
            stripe_connected_account_id, excluded, reason, actor_id
        ) VALUES (
            'acct_GuardMappedFinal1', true, 'Guard mapping-first contract', v_actor
        );
        RAISE EXCEPTION 'Mapping-first identity invariant accepted an exclusion.';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    IF NOT EXISTS (
        SELECT 1 FROM private.stripe_connect_account_identity_guards
         WHERE stripe_connected_account_id = 'acct_GuardMappedFinal1'
           AND mapped_studio_id = v_studio AND NOT excluded
    ) OR NOT EXISTS (
        SELECT 1 FROM private.stripe_connect_account_identity_guards
         WHERE stripe_connected_account_id = 'acct_GuardExcludedFinal1'
           AND mapped_studio_id IS NULL AND excluded
    ) THEN
        RAISE EXCEPTION 'Private Connect identity guard did not preserve the winning state.';
    END IF;

    INSERT INTO public.stripe_events(
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, processing_token, processing_started_at, created_at
    ) VALUES (
        'evt_atomic_correlation', 'acct_GuardMappedFinal1', true,
        'customer.subscription.updated', '{}'::JSONB,
        'processing', 'contract-token', now(), now()
    ) RETURNING id INTO v_guard_event;
    PERFORM public.finish_stripe_event_processing_v2(
        v_guard_event, 'contract-token', 'failed',
        'unexpected_processing_error', v_ref
    );
    IF NOT EXISTS (
        SELECT 1 FROM public.stripe_events
         WHERE id = v_guard_event
           AND processing_status = 'failed'
           AND error = 'unexpected_processing_error'
           AND error_reference = v_ref
           AND processing_token IS NULL
    ) THEN
        RAISE EXCEPTION 'Sanitized Stripe failure correlation was not persisted.';
    END IF;

    SELECT count(*) INTO v_audit_count
      FROM public.audit_logs
     WHERE studio_id = v_studio
       AND action IN (
           'live_billing.authorization_granted',
           'live_billing.authorization_revoked'
       );
    IF v_audit_count < 2 THEN
        RAISE EXCEPTION 'Live-billing authorization audit evidence is incomplete.';
    END IF;

    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v4();
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        RAISE EXCEPTION 'Starting-belt V9 manifest mismatch; got %',
            private.koaryu_release_starting_belt_manifest_v9();
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        RAISE EXCEPTION 'Student-rank writer V13 manifest mismatch; got %',
            private.koaryu_release_student_rank_writer_manifest_v13();
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:cf1b1a4403e539721172d4a8cfec64540e4f5dcec2aab12eafbcfb51fbd84b3a' THEN
        RAISE EXCEPTION 'Critical-surface V18 archive manifest mismatch; got %',
            private.koaryu_release_critical_surface_manifest_v18();
    END IF;
    IF NOT v_preflight.ready
       OR v_preflight.migration_count <> 115
       OR v_preflight.migration_head <> '20260822193000'
       OR v_preflight.pending_versions IS DISTINCT FROM ARRAY[
           '20260727100000', '20260727110000', '20260801050957',
           '20260801060000', '20260801070000', '20260801080000',
           '20260801090000', '20260801091000', '20260801092000',
           '20260801093000', '20260801094000', '20260801105313',
           '20260801112153', '20260801115044', '20260801123112',
           '20260801131844', '20260814043325', '20260814103046',
           '20260814105424', '20260814114500', '20260814152000',
           '20260814170000', '20260814183000', '20260814200000',
           '20260814213000', '20260815220402', '20260816012723',
           '20260820012533', '20260820025759', '20260820060216',
           '20260822193000'
       ]::TEXT[]
       OR cardinality(v_preflight.security_failures) <> 0
       OR v_preflight.manifest_version <> 'release-db-attestation-v22' THEN
        RAISE EXCEPTION 'Exact-head hosted schema preflight failed: %', v_preflight.security_failures;
    END IF;

    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF NOT v_preflight.ready
       OR v_preflight.migration_count <> 100
       OR v_preflight.migration_head <> '20260801131844'
       OR v_preflight.pending_versions IS DISTINCT FROM ARRAY[
           '20260727100000', '20260727110000', '20260801050957',
           '20260801060000', '20260801070000', '20260801080000',
           '20260801090000', '20260801091000', '20260801092000',
           '20260801093000', '20260801094000', '20260801105313',
           '20260801112153', '20260801115044', '20260801123112',
           '20260801131844'
       ]::TEXT[]
       OR cardinality(v_preflight.security_failures) <> 0
       OR v_preflight.manifest_version <> 'release-db-attestation-v7' THEN
        RAISE EXCEPTION 'Deployed predecessor V7 compatibility preflight failed on exact V18.';
    END IF;

    EXECUTE 'ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints
        DROP CONSTRAINT stripe_live_checkpoint_window_contract';
    EXECUTE 'ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints
        ADD CONSTRAINT stripe_live_checkpoint_window_contract
        CHECK (event_window_started_at IS NULL OR event_window_ended_at IS NOT NULL)';
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF v_preflight.ready
       OR NOT ('operational_semantic_acl_manifest_v7' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'Hosted preflight accepted weakened reconciliation-window semantics.';
    END IF;
    EXECUTE 'ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints
        DROP CONSTRAINT stripe_live_checkpoint_window_contract';
    EXECUTE $restore$
        ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints
        ADD CONSTRAINT stripe_live_checkpoint_window_contract CHECK (
            event_window_started_at IS NULL
            OR (
                event_window_started_at = TIMESTAMPTZ '2026-07-13 00:00:00+00'
                AND event_window_ended_at IS NOT NULL
                AND event_window_ended_at >= event_window_started_at
            )
        )
    $restore$;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF NOT v_preflight.ready THEN
        RAISE EXCEPTION 'Hosted preflight did not recover after exact CHECK restoration: %',
            v_preflight.security_failures;
    END IF;

    GRANT EXECUTE ON FUNCTION public.validate_student_program_membership()
        TO service_role;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF v_preflight.ready
       OR NOT ('starting_belt_invariant_manifest_v9' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'Hosted preflight accepted a direct grant on a trigger-only function.';
    END IF;
    REVOKE EXECUTE ON FUNCTION public.validate_student_program_membership()
        FROM service_role;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF NOT v_preflight.ready THEN
        RAISE EXCEPTION 'Hosted preflight did not recover after trigger-function ACL restoration: %',
            v_preflight.security_failures;
    END IF;

    EXECUTE 'CREATE POLICY injected_permissive_contract_policy
        ON public.stripe_live_billing_reconciliation_account_evidence
        FOR SELECT TO authenticated USING (false)';
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF v_preflight.ready
       OR NOT ('operational_semantic_acl_manifest_v7' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'Hosted preflight accepted an injected policy-manifest drift.';
    END IF;

    GRANT TRIGGER ON TABLE public.studio_payment_accounts TO authenticated;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF v_preflight.ready
       OR NOT ('operational_semantic_acl_manifest_v7' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'Hosted preflight accepted an unexpected studio-payment browser privilege.';
    END IF;
    REVOKE TRIGGER ON TABLE public.studio_payment_accounts FROM authenticated;

    GRANT TRUNCATE ON TABLE public.stripe_events TO service_role;
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF v_preflight.ready
       OR NOT ('operational_semantic_acl_manifest_v7' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'Hosted preflight accepted an excessive Stripe-event service privilege.';
    END IF;
    REVOKE TRUNCATE ON TABLE public.stripe_events FROM service_role;

    EXECUTE format(
        'GRANT UPDATE ON SEQUENCE %s TO service_role',
        pg_get_serial_sequence('public.stripe_events', 'live_billing_ingest_sequence')::REGCLASS
    );
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v2();
    IF v_preflight.ready
       OR NOT ('operational_semantic_acl_manifest_v7' = ANY(v_preflight.security_failures)) THEN
        RAISE EXCEPTION 'Hosted preflight accepted injected service-role sequence UPDATE.';
    END IF;
END $$;

ROLLBACK;
