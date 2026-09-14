BEGIN;

DO $access$
DECLARE
    v_role TEXT;
BEGIN
    IF to_regclass(
        'public.stripe_live_billing_reconciliation_checkpoints_v3'
    ) IS NULL THEN
        RAISE EXCEPTION 'Missing schema-v3 reconciliation sidecar.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_class relation
         WHERE relation.oid =
               'public.stripe_live_billing_reconciliation_checkpoints_v3'::REGCLASS
           AND relation.relrowsecurity
    ) THEN
        RAISE EXCEPTION 'Schema-v3 reconciliation sidecar must enable RLS.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_index index_row
          JOIN pg_class index_relation
            ON index_relation.oid = index_row.indexrelid
         WHERE index_row.indrelid =
               'public.stripe_live_billing_reconciliation_checkpoints_v3'::REGCLASS
           AND index_relation.relname =
               'idx_stripe_live_billing_reconciliation_v3_previous'
           AND index_row.indisvalid
           AND index_row.indisready
           AND index_row.indpred IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Schema-v3 predecessor foreign key index is missing or invalid.';
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF has_table_privilege(
            v_role,
            'public.stripe_live_billing_reconciliation_checkpoints_v3',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        ) THEN
            RAISE EXCEPTION '% can access the schema-v3 sidecar.', v_role;
        END IF;
        IF has_function_privilege(
            v_role,
            'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)',
            'EXECUTE'
        ) THEN
            RAISE EXCEPTION '% can record a schema-v3 checkpoint.', v_role;
        END IF;
        IF has_function_privilege(
            v_role,
            'public.koaryu_release_schema_preflight_v7()',
            'EXECUTE'
        ) THEN
            RAISE EXCEPTION '% can execute the V26 schema preflight.', v_role;
        END IF;
    END LOOP;

    IF NOT has_table_privilege(
        'service_role',
        'public.stripe_live_billing_reconciliation_checkpoints_v3',
        'SELECT'
    )
       OR has_table_privilege(
           'service_role',
           'public.stripe_live_billing_reconciliation_checkpoints_v3',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
        RAISE EXCEPTION 'Schema-v3 sidecar service-role ACL drifted.';
    END IF;

    IF has_function_privilege(
        'service_role',
        'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Schema-v2 checkpoint writer remains callable.';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)',
        'EXECUTE'
    )
       OR NOT has_function_privilege(
           'service_role',
           'public.koaryu_release_schema_preflight_v7()',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'service_role cannot call the v3 writer or V26 preflight.';
    END IF;

    -- The V25-to-V26 restore harness retains the historical V26 anchor. This
    -- final-chain assertion is the separately approved V37 compatibility pin.
    IF private.koaryu_release_operational_contract_v26()
       <> '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136' THEN
        RAISE EXCEPTION 'V26 operational contract has failures: %',
            private.koaryu_release_operational_contract_v26();
    END IF;

    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
        RAISE EXCEPTION 'Schema-v3 release manifest drifted: %',
            private.koaryu_release_live_billing_v3_manifest_v25();
    END IF;
END;
$access$;

DO $contract$
DECLARE
    v_actor UUID := gen_random_uuid();
    v_owner UUID := gen_random_uuid();
    v_studio UUID := gen_random_uuid();
    v_blank_studio UUID := gen_random_uuid();
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_second_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_sidecar public.stripe_live_billing_reconciliation_checkpoints_v3%ROWTYPE;
    v_report JSONB;
    v_rolling_report JSONB;
    v_watermark BIGINT;
    v_result RECORD;
    v_pending_event UUID;
    v_account_evidence JSONB;
    v_event_count INTEGER;
    v_platform_event_count INTEGER;
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
    ) VALUES
        (
            v_actor,
            'authenticated',
            'authenticated',
            'billing-v3-actor-' || replace(v_actor::TEXT, '-', '') ||
                '@example.invalid',
            '{}'::JSONB,
            '{}'::JSONB,
            now(),
            now()
        ),
        (
            v_owner,
            'authenticated',
            'authenticated',
            'billing-v3-owner-' || replace(v_owner::TEXT, '-', '') ||
                '@example.invalid',
            '{}'::JSONB,
            '{}'::JSONB,
            now(),
            now()
        );

    INSERT INTO public.studios(id, name, slug, owner_id) VALUES
        (
            v_studio,
            'Schema V3 Live Billing Contract',
            'schema-v3-live-billing-' || replace(v_studio::TEXT, '-', ''),
            v_owner
        ),
        (
            v_blank_studio,
            'Schema V3 Accountless Connect',
            'schema-v3-accountless-' || replace(v_blank_studio::TEXT, '-', ''),
            v_owner
        );

    INSERT INTO public.studio_payment_accounts (
        studio_id,
        stripe_connected_account_id,
        status,
        charges_enabled,
        payouts_enabled,
        details_submitted,
        requirements_due,
        metadata
    ) VALUES
        (
            v_studio,
            'acct_ContractReadyV3',
            'charges_enabled',
            true,
            true,
            true,
            ARRAY[]::TEXT[],
            jsonb_build_object('connect_account_generation', 1)
        ),
        (
            v_blank_studio,
            NULL,
            'not_connected',
            false,
            false,
            false,
            ARRAY[]::TEXT[],
            jsonb_build_object('connect_account_generation', 1)
        );

    INSERT INTO public.stripe_events (
        stripe_event_id,
        stripe_account_id,
        livemode,
        type,
        payload,
        processing_status,
        processed_at,
        created_at
    ) VALUES
        (
            'evt_v3_platform',
            NULL,
            true,
            'invoice.paid',
            '{}'::JSONB,
            'processed',
            now() - INTERVAL '1 minute',
            now() - INTERVAL '1 minute'
        ),
        (
            'evt_v3_connect',
            'acct_ContractReadyV3',
            true,
            'account.updated',
            '{}'::JSONB,
            'processed',
            now() - INTERVAL '1 minute',
            now() - INTERVAL '1 minute'
        ),
        (
            'evt_v3_old_platform',
            NULL,
            true,
            'invoice.paid',
            '{}'::JSONB,
            'processed',
            now() - INTERVAL '30 days',
            now() - INTERVAL '30 days'
        );

    -- The checkpoint covers every mapping, including pre-existing staging ones.
    -- These mock delivery events and the resulting checkpoints all roll back.
    INSERT INTO public.stripe_events (
        stripe_event_id, stripe_account_id, livemode, type, payload,
        processing_status, processed_at, created_at
    )
    SELECT
        'evt_v3_context_' || replace(v_actor::TEXT, '-', '') || '_' ||
            replace(account.studio_id::TEXT, '-', ''),
        account.stripe_connected_account_id, true, 'account.updated', '{}'::JSONB,
        'processed', now() - INTERVAL '1 minute', now() - INTERVAL '1 minute'
    FROM public.studio_payment_accounts account
    WHERE account.studio_id <> v_studio
      AND account.stripe_connected_account_id IS NOT NULL;

    SELECT COUNT(*), COUNT(*) FILTER (WHERE stripe_account_id IS NULL)
      INTO v_event_count, v_platform_event_count
      FROM public.stripe_events
     WHERE livemode
       AND created_at BETWEEN now() - INTERVAL '29 days' AND now()
       AND private.live_billing_event_is_in_scope(stripe_account_id, type);

    WITH deliveries AS (
        SELECT stripe_account_id, COUNT(*) AS event_count
        FROM public.stripe_events
        WHERE livemode
          AND created_at BETWEEN now() - INTERVAL '29 days' AND now()
          AND private.live_billing_event_is_in_scope(stripe_account_id, type)
        GROUP BY stripe_account_id
    )
    SELECT jsonb_agg(jsonb_build_object(
        'studio_id', account.studio_id,
        'stripe_connected_account_id', account.stripe_connected_account_id,
        'connect_account_generation', CASE WHEN account.studio_id = v_studio
            THEN 1 ELSE private.current_connect_account_generation(account.metadata) END,
        'provider_event_count', deliveries.event_count,
        'local_event_count', deliveries.event_count,
        'provider_only_event_count', 0,
        'local_only_event_count', 0,
        'delivery_verified_at', now() - INTERVAL '1 minute',
        'fresh', true
    ) ORDER BY (account.studio_id = v_studio) DESC, account.studio_id)
      INTO v_account_evidence
      FROM public.studio_payment_accounts account
      JOIN deliveries ON deliveries.stripe_account_id = account.stripe_connected_account_id
     WHERE account.stripe_connected_account_id IS NOT NULL;

    SELECT MAX(live_billing_ingest_sequence)
      INTO v_watermark
      FROM public.stripe_events
     WHERE livemode;

    v_report := jsonb_build_object(
        'schema_version', 3,
        'candidate_sha', repeat('a', 40),
        'provider_mode', 'live',
        'evidence_source', 'provider_read',
        'probe', 'production',
        'checkpoint_eligible', true,
        'generated_at', now(),
        'event_window', jsonb_build_object(
            'started_at', now() - INTERVAL '29 days',
            'ended_at', now()
        ),
        'window_policy', jsonb_build_object(
            'provider_retention_seconds', 2592000,
            'safety_margin_seconds', 86400,
            'rolling_window_seconds', 2505600,
            'minimum_continuity_overlap_seconds', 86400,
            'complete_supported_window', true
        ),
        'deployment_readiness', jsonb_build_object(
            'production_exact_candidate_verified', true,
            'verified_at', now()
        ),
        'continuity', jsonb_build_object(
            'mode', 'bootstrap',
            'eligible', true,
            'previous_checkpoint_id', NULL,
            'previous_checkpoint_sequence', NULL,
            'previous_checkpoint_expires_at', NULL,
            'previous_window_ended_at', NULL,
            'previous_local_event_ingest_watermark', NULL,
            'previous_checkpoint_valid', false,
            'overlap_started_at', NULL,
            'overlap_ended_at', NULL,
            'overlap_seconds', 0,
            'minimum_overlap_seconds', 86400,
            'local_event_ingest_watermark_non_regressing', false,
            'account_generation_continuity_valid', true,
            'bootstrap_local_history_checked', true,
            'bootstrap_historical_provider_completeness_claimed', false,
            'bootstrap_enabled_authorization_count', 0,
            'bootstrap_historical_failed_count', 0,
            'bootstrap_historical_not_processed_count', 0,
            'bootstrap_historical_unmapped_count', 0,
            'delta_failed_count', 0,
            'delta_not_processed_count', 0,
            'delta_unmapped_count', 0
        ),
        'counts', jsonb_build_object(
            'provider_accounts', jsonb_array_length(v_account_evidence),
            'mapped_accounts', jsonb_array_length(v_account_evidence),
            'excluded_accounts', 0,
            'unresolved_accounts', 0,
            'unresolved_event_accounts', 0
        ),
        'event_reconciliation', jsonb_build_object(
            'bounded_provider_total', v_event_count,
            'bounded_local_total', v_event_count,
            'provider_only_event_count', 0,
            'local_only_event_count', 0,
            'failed', 0,
            'not_processed', 0,
            'wrong_mode_provider_event_count', 0,
            'wrong_mode_local_event_count', 0,
            'latest_created_at', now() - INTERVAL '1 minute',
            'latest_provider_created_at', now() - INTERVAL '1 minute',
            'local_event_ingest_watermark', v_watermark,
            'invalid_history_sequence_count', 0
        ),
        'platform_delivery', jsonb_build_object(
            'provider_event_count', v_platform_event_count,
            'local_event_count', v_platform_event_count,
            'delivery_verified_at', now() - INTERVAL '1 minute',
            'fresh', true
        ),
        'webhook_delivery', jsonb_build_object(
            'platform_endpoint_url',
                'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform',
            'connect_endpoint_url',
                'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect',
            'enabled_platform_endpoint_count', 1,
            'enabled_connect_endpoint_count', 1,
            'platform_endpoint_candidate_count', 1,
            'connect_endpoint_candidate_count', 1,
            'unexpected_enabled_endpoint_count', 0,
            'platform_endpoint_contract_matched', true,
            'connect_endpoint_contract_matched', true,
            'platform_endpoint_livemode', true,
            'connect_endpoint_livemode', true,
            'connected_event_context_verified', true,
            'wildcard_accepted', false
        ),
        'account_evidence', v_account_evidence
    );

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
            jsonb_set(
                v_report,
                '{continuity,bootstrap_historical_provider_completeness_claimed}',
                'true'::JSONB
            ),
            now() + INTERVAL '1 hour',
            repeat('b', 64),
            'Bootstrap cannot claim inaccessible provider history',
            v_actor,
            NULL
        );
        RAISE EXCEPTION 'False bootstrap history claim produced a checkpoint.';
    EXCEPTION WHEN SQLSTATE 'P0B40' THEN
        NULL;
    END;

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
            v_report || jsonb_build_object(
                'account_evidence', v_account_evidence - 0,
                'counts', (v_report->'counts') || jsonb_build_object(
                    'mapped_accounts', jsonb_array_length(v_account_evidence) - 1,
                    'provider_accounts', jsonb_array_length(v_account_evidence) - 1
                )
            ),
            now() + INTERVAL '1 hour', repeat('2', 64),
            'Omitted mapping must fail', v_actor, NULL
        );
        RAISE EXCEPTION 'Omitted mapping produced a checkpoint.';
    EXCEPTION WHEN SQLSTATE 'P0B51' THEN
        NULL;
    END;

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
            jsonb_set(v_report, '{account_evidence,0,connect_account_generation}', '2'::JSONB),
            now() + INTERVAL '1 hour', repeat('3', 64),
            'Stale report generation must fail', v_actor, NULL
        );
        RAISE EXCEPTION 'Stale report generation produced a checkpoint.';
    EXCEPTION WHEN SQLSTATE 'P0B50' THEN
        NULL;
    END;

    SELECT *
      INTO v_checkpoint
      FROM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
          v_report,
          now() + INTERVAL '1 hour',
          repeat('c', 64),
          'Exact schema-v3 bootstrap contract',
          v_actor,
          'operator@example.invalid'
      );

    SELECT *
      INTO v_sidecar
      FROM public.stripe_live_billing_reconciliation_checkpoints_v3
     WHERE checkpoint_id = v_checkpoint.id;

    IF v_checkpoint.event_count_since_cutoff <> v_event_count
       OR v_checkpoint.candidate_sha <> repeat('a', 40)
       OR v_checkpoint.source_report_sha256 <> repeat('c', 64)
       OR v_checkpoint.local_event_ingest_watermark <> v_watermark
       OR v_sidecar.report_schema_version <> 3
       OR v_sidecar.continuity_mode <> 'bootstrap'
       OR NOT v_sidecar.bootstrap_local_history_checked
       OR v_sidecar.bootstrap_historical_provider_completeness_claimed
       OR v_sidecar.event_window_ended_at - v_sidecar.event_window_started_at
            <> INTERVAL '29 days' THEN
        RAISE EXCEPTION 'Schema-v3 checkpoint persistence drifted.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.set_studio_live_billing_authorization_operations_v1(
          v_studio,
          'connect_payments',
          true,
          now() + INTERVAL '1 hour',
          'Schema-v3 one-studio contract',
          v_actor,
          ARRAY['connected_invoice.pay']::TEXT[],
          NULL,
          'acct_ContractReadyV3'
      );

    IF v_result.outcome <> 'applied'
       OR NOT v_result.enabled
       OR v_result.changed_at IS NULL THEN
        RAISE EXCEPTION 'Schema-v3 Connect payment scope was not granted.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.authorize_studio_live_billing_mutation_atomic(
          v_studio,
          'connected_invoice.pay',
          'connect_payments',
          'acct_ContractReadyV3',
          repeat('a', 40)
      );

    IF NOT FOUND
       OR NOT v_result.authorized
       OR v_result.checkpoint_id <> v_checkpoint.id THEN
        RAISE EXCEPTION 'Exact schema-v3 payment scope did not authorize.';
    END IF;

    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio,
        'connected_invoice.pay',
        'connect_payments',
        'acct_ContractReadyV3',
        repeat('d', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Stale candidate SHA passed schema-v3 authorization.';
    END IF;

    SELECT *
      INTO v_result
      FROM public.set_studio_live_billing_authorization_operations_v1(
          v_blank_studio,
          'connect_onboarding',
          true,
          now() + INTERVAL '1 hour',
          'Accountless onboarding remains bounded',
          v_actor,
          ARRAY['connect_account.create']::TEXT[],
          NULL,
          NULL
      );

    SELECT *
      INTO v_result
      FROM public.authorize_studio_live_billing_mutation_atomic(
          v_blank_studio,
          'connect_account.create',
          'connect_onboarding',
          NULL,
          repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.authorized THEN
        RAISE EXCEPTION 'Accountless onboarding lost the schema-v3 checkpoint path.';
    END IF;

    INSERT INTO public.stripe_events (
        stripe_event_id,
        stripe_account_id,
        livemode,
        type,
        payload,
        processing_status,
        created_at
    ) VALUES (
        'evt_v3_pending_after_checkpoint',
        'acct_ContractReadyV3',
        true,
        'account.application.deauthorized',
        '{}'::JSONB,
        'pending',
        now() - INTERVAL '30 seconds'
    )
    RETURNING id INTO v_pending_event;

    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio,
        'connected_invoice.pay',
        'connect_payments',
        'acct_ContractReadyV3',
        repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Post-checkpoint pending event did not fail closed.';
    END IF;

    UPDATE public.stripe_events
       SET processing_status = 'processed',
           processed_at = now() - INTERVAL '20 seconds'
     WHERE id = v_pending_event;

    SELECT *
      INTO v_result
      FROM public.authorize_studio_live_billing_mutation_atomic(
          v_studio,
          'connected_invoice.pay',
          'connect_payments',
          'acct_ContractReadyV3',
          repeat('a', 40)
      );
    IF NOT FOUND OR NOT v_result.authorized THEN
        RAISE EXCEPTION 'Resolved post-checkpoint event did not restore authorization.';
    END IF;

    UPDATE public.studio_payment_accounts
       SET metadata = jsonb_build_object('connect_account_generation', 2)
     WHERE studio_id = v_studio;

    PERFORM public.authorize_studio_live_billing_mutation_atomic(
        v_studio,
        'connected_invoice.pay',
        'connect_payments',
        'acct_ContractReadyV3',
        repeat('a', 40)
    );
    IF FOUND THEN
        RAISE EXCEPTION 'Stale Connect generation passed authorization.';
    END IF;

    UPDATE public.studio_payment_accounts
       SET metadata = jsonb_build_object('connect_account_generation', 1)
     WHERE studio_id = v_studio;

    SELECT MAX(live_billing_ingest_sequence)
      INTO v_watermark
      FROM public.stripe_events
     WHERE livemode;

    v_rolling_report := v_report || jsonb_build_object(
        'continuity', (v_report->'continuity') || jsonb_build_object(
            'mode', 'rolling',
            'previous_checkpoint_id', v_checkpoint.id,
            'previous_checkpoint_sequence', v_checkpoint.checkpoint_sequence,
            'previous_checkpoint_expires_at', v_checkpoint.expires_at,
            'previous_window_ended_at', v_sidecar.event_window_ended_at,
            'previous_local_event_ingest_watermark', v_sidecar.local_event_ingest_watermark,
            'previous_checkpoint_valid', true,
            'overlap_started_at', now() - INTERVAL '29 days',
            'overlap_ended_at', v_sidecar.event_window_ended_at,
            'overlap_seconds', 2505600,
            'local_event_ingest_watermark_non_regressing', true,
            'bootstrap_local_history_checked', false
        ),
        'event_reconciliation', (v_report->'event_reconciliation') || jsonb_build_object(
            'bounded_provider_total', v_event_count + 1,
            'bounded_local_total', v_event_count + 1,
            'local_event_ingest_watermark', v_watermark,
            'latest_created_at', now() - INTERVAL '30 seconds'
        ),
        'account_evidence', jsonb_set(v_account_evidence, '{0}', jsonb_build_object(
            'studio_id', v_studio,
            'stripe_connected_account_id', 'acct_ContractReadyV3',
            'connect_account_generation', 1,
            'provider_event_count', 2,
            'local_event_count', 2,
            'provider_only_event_count', 0,
            'local_only_event_count', 0,
            'delivery_verified_at', now() - INTERVAL '30 seconds',
            'fresh', true
        ))
    );

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
            jsonb_set(
                v_rolling_report,
                '{continuity,previous_checkpoint_id}',
                to_jsonb(gen_random_uuid()::TEXT)
            ),
            now() + INTERVAL '1 hour',
            repeat('d', 64),
            'Missing previous checkpoint must fail',
            v_actor,
            NULL
        );
        RAISE EXCEPTION 'Missing previous checkpoint produced continuity.';
    EXCEPTION WHEN SQLSTATE 'P0B46' THEN
        NULL;
    END;

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
            jsonb_set(
                v_rolling_report,
                '{continuity,overlap_started_at}',
                to_jsonb(v_sidecar.event_window_ended_at - INTERVAL '12 hours')
            ),
            now() + INTERVAL '1 hour',
            repeat('e', 64),
            'Broken overlap must fail',
            v_actor,
            NULL
        );
        RAISE EXCEPTION 'Broken overlap produced continuity.';
    EXCEPTION WHEN SQLSTATE 'P0B47' THEN
        NULL;
    END;

    BEGIN
        PERFORM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
            jsonb_set(
                v_rolling_report,
                '{event_reconciliation,local_event_ingest_watermark}',
                to_jsonb(v_watermark - 1)
            ),
            now() + INTERVAL '1 hour',
            repeat('f', 64),
            'Regressed watermark must fail',
            v_actor,
            NULL
        );
        RAISE EXCEPTION 'Regressed watermark produced continuity.';
    EXCEPTION WHEN SQLSTATE 'P0B42' THEN
        NULL;
    END;

    SELECT *
      INTO v_second_checkpoint
      FROM public.record_stripe_live_billing_reconciliation_checkpoint_v3(
          v_rolling_report,
          now() + INTERVAL '1 hour',
          repeat('1', 64),
          'Valid rolling schema-v3 continuity',
          v_actor,
          NULL
      );

    SELECT *
      INTO v_sidecar
      FROM public.stripe_live_billing_reconciliation_checkpoints_v3
     WHERE checkpoint_id = v_second_checkpoint.id;

    IF v_sidecar.continuity_mode <> 'rolling'
       OR v_sidecar.previous_checkpoint_id <> v_checkpoint.id
       OR v_sidecar.previous_checkpoint_sequence <>
          v_checkpoint.checkpoint_sequence
       OR v_sidecar.previous_local_event_ingest_watermark >=
          v_sidecar.local_event_ingest_watermark
       OR v_sidecar.continuity_overlap_ended_at -
          v_sidecar.continuity_overlap_started_at < INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'Rolling continuity was not persisted exactly.';
    END IF;
END;
$contract$;

ROLLBACK;
