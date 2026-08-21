BEGIN;

DO $access$
DECLARE
    v_role TEXT;
    v_definition TEXT;
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
            'public.koaryu_release_schema_preflight_v4()',
            'EXECUTE'
        ) THEN
            RAISE EXCEPTION '% can execute the v19 schema preflight.', v_role;
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
           'public.koaryu_release_schema_preflight_v4()',
           'EXECUTE'
       ) THEN
        RAISE EXCEPTION 'service_role cannot call the v3 writer or v19 preflight.';
    END IF;

    FOREACH v_definition IN ARRAY ARRAY[
        pg_get_functiondef(
            'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)'::REGPROCEDURE
        ),
        pg_get_functiondef(
            'private.bind_live_billing_authorization_checkpoint()'::REGPROCEDURE
        ),
        pg_get_functiondef(
            'public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)'::REGPROCEDURE
        ),
        pg_get_functiondef(
            'private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)'::REGPROCEDURE
        )
    ] LOOP
        IF v_definition LIKE '%' || '2026' || '-07-13%' THEN
            RAISE EXCEPTION 'Active schema-v3 authorization still depends on the legacy fixed date.';
        END IF;
    END LOOP;

    IF private.koaryu_release_live_billing_v3_manifest_v19()
       NOT LIKE '0:%' THEN
        RAISE EXCEPTION 'Schema-v3 release manifest is not clean: %',
            private.koaryu_release_live_billing_v3_manifest_v19();
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
            'not_started',
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
        );

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
            'provider_accounts', 1,
            'mapped_accounts', 1,
            'excluded_accounts', 0,
            'unresolved_accounts', 0,
            'unresolved_event_accounts', 0
        ),
        'event_reconciliation', jsonb_build_object(
            'bounded_provider_total', 2,
            'bounded_local_total', 2,
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
            'provider_event_count', 1,
            'local_event_count', 1,
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
        'account_evidence', jsonb_build_array(
            jsonb_build_object(
                'studio_id', v_studio,
                'stripe_connected_account_id', 'acct_ContractReadyV3',
                'connect_account_generation', 1,
                'provider_event_count', 1,
                'local_event_count', 1,
                'provider_only_event_count', 0,
                'local_only_event_count', 0,
                'delivery_verified_at', now() - INTERVAL '1 minute',
                'fresh', true
            )
        )
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

    IF v_checkpoint.candidate_sha <> repeat('a', 40)
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
      FROM public.set_studio_live_billing_authorization_atomic(
          v_studio,
          'connect_payments',
          true,
          now() + INTERVAL '1 hour',
          'Schema-v3 one-studio contract',
          v_actor,
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
      FROM public.set_studio_live_billing_authorization_atomic(
          v_blank_studio,
          'connect_onboarding',
          true,
          now() + INTERVAL '1 hour',
          'Accountless onboarding remains bounded',
          v_actor,
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

    v_rolling_report := jsonb_set(
        jsonb_set(
            jsonb_set(
                jsonb_set(
                    jsonb_set(
                        jsonb_set(
                            v_report,
                            '{continuity,mode}',
                            '"rolling"'::JSONB
                        ),
                        '{continuity,previous_checkpoint_id}',
                        to_jsonb(v_checkpoint.id::TEXT)
                    ),
                    '{continuity,previous_checkpoint_sequence}',
                    to_jsonb(v_checkpoint.checkpoint_sequence)
                ),
                '{continuity,previous_checkpoint_expires_at}',
                to_jsonb(v_checkpoint.expires_at)
            ),
            '{continuity,previous_window_ended_at}',
            to_jsonb(v_sidecar.event_window_ended_at)
        ),
        '{continuity,previous_local_event_ingest_watermark}',
        to_jsonb(v_sidecar.local_event_ingest_watermark)
    );

    v_rolling_report := jsonb_set(
        jsonb_set(
            jsonb_set(
                jsonb_set(
                    jsonb_set(
                        jsonb_set(
                            v_rolling_report,
                            '{continuity,previous_checkpoint_valid}',
                            'true'::JSONB
                        ),
                        '{continuity,overlap_started_at}',
                        to_jsonb(now() - INTERVAL '29 days')
                    ),
                    '{continuity,overlap_ended_at}',
                    to_jsonb(v_sidecar.event_window_ended_at)
                ),
                '{continuity,overlap_seconds}',
                to_jsonb(2505600)
            ),
            '{continuity,local_event_ingest_watermark_non_regressing}',
            'true'::JSONB
        ),
        '{continuity,bootstrap_local_history_checked}',
        'false'::JSONB
    );

    v_rolling_report := jsonb_set(
        jsonb_set(
            jsonb_set(
                jsonb_set(
                    v_rolling_report,
                    '{event_reconciliation,bounded_provider_total}',
                    to_jsonb(3)
                ),
                '{event_reconciliation,bounded_local_total}',
                to_jsonb(3)
            ),
            '{event_reconciliation,local_event_ingest_watermark}',
            to_jsonb(v_watermark)
        ),
        '{event_reconciliation,latest_created_at}',
        to_jsonb(now() - INTERVAL '30 seconds')
    );

    v_rolling_report := jsonb_set(
        v_rolling_report,
        '{account_evidence,0}',
        jsonb_build_object(
            'studio_id', v_studio,
            'stripe_connected_account_id', 'acct_ContractReadyV3',
            'connect_account_generation', 1,
            'provider_event_count', 2,
            'local_event_count', 2,
            'provider_only_event_count', 0,
            'local_only_event_count', 0,
            'delivery_verified_at', now() - INTERVAL '30 seconds',
            'fresh', true
        )
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
