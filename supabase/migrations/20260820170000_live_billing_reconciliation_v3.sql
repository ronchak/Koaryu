-- Schema-v3 live-billing reconciliation and continuity contract.
--
-- This migration is additive. Legacy checkpoint rows remain readable, but the
-- v2 recorder loses service-role execution and every future enabled
-- authorization must bind to a v3 sidecar row.

CREATE TABLE public.stripe_live_billing_reconciliation_checkpoints_v3 (
    checkpoint_id UUID PRIMARY KEY
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id)
        ON DELETE CASCADE,
    checkpoint_sequence BIGINT NOT NULL UNIQUE,
    candidate_sha TEXT NOT NULL CHECK (candidate_sha ~ '^[0-9a-f]{40}$'),
    verified_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    source_report_sha256 TEXT NOT NULL CHECK (source_report_sha256 ~ '^[0-9a-f]{64}$'),
    report_schema_version INTEGER NOT NULL CHECK (report_schema_version = 3),
    continuity_mode TEXT NOT NULL CHECK (continuity_mode IN ('bootstrap', 'rolling')),
    previous_checkpoint_id UUID
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id)
        ON DELETE RESTRICT,
    previous_checkpoint_sequence BIGINT,
    event_window_started_at TIMESTAMPTZ NOT NULL,
    event_window_ended_at TIMESTAMPTZ NOT NULL,
    continuity_overlap_started_at TIMESTAMPTZ,
    continuity_overlap_ended_at TIMESTAMPTZ,
    previous_local_event_ingest_watermark BIGINT,
    local_event_ingest_watermark BIGINT NOT NULL
        CHECK (local_event_ingest_watermark >= 0),
    bootstrap_historical_provider_completeness_claimed BOOLEAN NOT NULL,
    bootstrap_local_history_checked BOOLEAN NOT NULL,
    provider_retention_seconds INTEGER NOT NULL
        CHECK (provider_retention_seconds = 2592000),
    safety_margin_seconds INTEGER NOT NULL
        CHECK (safety_margin_seconds = 86400),
    minimum_overlap_seconds INTEGER NOT NULL
        CHECK (minimum_overlap_seconds = 86400),
    platform_endpoint_url TEXT NOT NULL
        CHECK (
            platform_endpoint_url =
            'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform'
        ),
    connect_endpoint_url TEXT NOT NULL
        CHECK (
            connect_endpoint_url =
            'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect'
        ),
    platform_endpoint_livemode BOOLEAN NOT NULL CHECK (platform_endpoint_livemode),
    connect_endpoint_livemode BOOLEAN NOT NULL CHECK (connect_endpoint_livemode),
    connected_event_context_verified BOOLEAN NOT NULL
        CHECK (connected_event_context_verified),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > verified_at),
    CHECK (event_window_ended_at > event_window_started_at),
    CHECK (
        event_window_ended_at - event_window_started_at = INTERVAL '29 days'
    ),
    CHECK (bootstrap_historical_provider_completeness_claimed = false),
    CHECK (
        (
            continuity_mode = 'bootstrap'
            AND previous_checkpoint_id IS NULL
            AND previous_checkpoint_sequence IS NULL
            AND previous_local_event_ingest_watermark IS NULL
            AND continuity_overlap_started_at IS NULL
            AND continuity_overlap_ended_at IS NULL
            AND bootstrap_local_history_checked
        )
        OR
        (
            continuity_mode = 'rolling'
            AND previous_checkpoint_id IS NOT NULL
            AND previous_checkpoint_sequence IS NOT NULL
            AND previous_local_event_ingest_watermark IS NOT NULL
            AND previous_local_event_ingest_watermark >= 0
            AND local_event_ingest_watermark >= previous_local_event_ingest_watermark
            AND continuity_overlap_started_at IS NOT NULL
            AND continuity_overlap_ended_at IS NOT NULL
            AND continuity_overlap_ended_at > continuity_overlap_started_at
            AND continuity_overlap_ended_at - continuity_overlap_started_at
                >= INTERVAL '24 hours'
        )
    )
);

CREATE INDEX idx_stripe_live_billing_reconciliation_v3_latest
    ON public.stripe_live_billing_reconciliation_checkpoints_v3(
        checkpoint_sequence DESC
    );

ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints_v3
    ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_live_billing_reconciliation_v3_no_client_access
    ON public.stripe_live_billing_reconciliation_checkpoints_v3
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.stripe_live_billing_reconciliation_checkpoints_v3
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE
    public.stripe_live_billing_reconciliation_checkpoints_v3
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE
    public.stripe_live_billing_reconciliation_checkpoints_v3
    TO service_role;

-- All enabled grants must be deliberately rebound after the v3 contract lands.
UPDATE public.studio_live_billing_authorizations
   SET enabled = false,
       expires_at = NULL,
       revoked_at = COALESCE(revoked_at, now()),
       revoke_reason = COALESCE(
           revoke_reason,
           'Reauthorization required after reconciliation contract v3'
       )
 WHERE enabled;

REVOKE ALL ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v2(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v3(
    p_report JSONB,
    p_expires_at TIMESTAMPTZ,
    p_source_report_sha256 TEXT,
    p_reason TEXT,
    p_actor_id UUID,
    p_actor_email TEXT DEFAULT NULL
)
RETURNS public.stripe_live_billing_reconciliation_checkpoints
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_reason TEXT := BTRIM(COALESCE(p_reason, ''));
    v_candidate_sha TEXT := p_report->>'candidate_sha';
    v_window_start TIMESTAMPTZ :=
        (p_report #>> '{event_window,started_at}')::TIMESTAMPTZ;
    v_window_end TIMESTAMPTZ :=
        (p_report #>> '{event_window,ended_at}')::TIMESTAMPTZ;
    v_ready_verified_at TIMESTAMPTZ :=
        (p_report #>> '{deployment_readiness,verified_at}')::TIMESTAMPTZ;
    v_platform_verified_at TIMESTAMPTZ :=
        (p_report #>> '{platform_delivery,delivery_verified_at}')::TIMESTAMPTZ;
    v_watermark BIGINT :=
        (p_report #>> '{event_reconciliation,local_event_ingest_watermark}')::BIGINT;
    v_current_watermark BIGINT;
    v_bounded_local_count INTEGER;
    v_mapping_count INTEGER;
    v_account JSONB;
    v_account_count INTEGER := 0;
    v_mapping public.studio_payment_accounts%ROWTYPE;
    v_continuity_mode TEXT := p_report #>> '{continuity,mode}';
    v_previous_checkpoint_id UUID :=
        NULLIF(p_report #>> '{continuity,previous_checkpoint_id}', '')::UUID;
    v_previous_checkpoint_sequence BIGINT :=
        NULLIF(p_report #>> '{continuity,previous_checkpoint_sequence}', '')::BIGINT;
    v_previous_watermark BIGINT :=
        NULLIF(
            p_report #>> '{continuity,previous_local_event_ingest_watermark}',
            ''
        )::BIGINT;
    v_previous_window_end TIMESTAMPTZ :=
        NULLIF(p_report #>> '{continuity,previous_window_ended_at}', '')::TIMESTAMPTZ;
    v_previous_expires_at TIMESTAMPTZ :=
        NULLIF(
            p_report #>> '{continuity,previous_checkpoint_expires_at}',
            ''
        )::TIMESTAMPTZ;
    v_overlap_start TIMESTAMPTZ :=
        NULLIF(p_report #>> '{continuity,overlap_started_at}', '')::TIMESTAMPTZ;
    v_overlap_end TIMESTAMPTZ :=
        NULLIF(p_report #>> '{continuity,overlap_ended_at}', '')::TIMESTAMPTZ;
    v_previous_checkpoint
        public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_previous_sidecar
        public.stripe_live_billing_reconciliation_checkpoints_v3%ROWTYPE;
BEGIN
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_checkpoints_v3,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations
        IN SHARE ROW EXCLUSIVE MODE;

    IF p_report IS NULL
       OR p_report->>'schema_version' <> '3'
       OR p_report->>'evidence_source' <> 'provider_read'
       OR p_report->>'probe' <> 'production'
       OR p_report->>'provider_mode' <> 'live'
       OR p_report->>'checkpoint_eligible' <> 'true'
       OR p_report #>> '{deployment_readiness,production_exact_candidate_verified}'
            <> 'true'
       OR p_report #>> '{continuity,eligible}' <> 'true'
       OR p_report #>> '{window_policy,complete_supported_window}' <> 'true'
       OR p_report #>> '{continuity,bootstrap_historical_provider_completeness_claimed}'
            <> 'false'
       OR v_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_source_report_sha256 !~ '^[0-9a-f]{64}$'
       OR v_window_start IS NULL
       OR v_window_end IS NULL
       OR v_window_end - v_window_start IS DISTINCT FROM INTERVAL '29 days'
       OR v_window_end < v_now - INTERVAL '15 minutes'
       OR v_window_end > v_now + INTERVAL '5 minutes'
       OR (p_report #>> '{window_policy,provider_retention_seconds}')::INTEGER
            <> 2592000
       OR (p_report #>> '{window_policy,safety_margin_seconds}')::INTEGER
            <> 86400
       OR (p_report #>> '{window_policy,rolling_window_seconds}')::INTEGER
            <> 2505600
       OR (p_report #>> '{window_policy,minimum_continuity_overlap_seconds}')::INTEGER
            <> 86400
       OR v_ready_verified_at IS NULL
       OR v_ready_verified_at < v_now - INTERVAL '15 minutes'
       OR v_ready_verified_at > v_now + INTERVAL '5 minutes'
       OR v_platform_verified_at IS NULL
       OR v_platform_verified_at < v_now - INTERVAL '24 hours'
       OR v_platform_verified_at > v_now + INTERVAL '5 minutes'
       OR v_watermark IS NULL
       OR p_expires_at IS NULL
       OR p_expires_at <= v_now
       OR p_expires_at > v_now + INTERVAL '24 hours' THEN
        RAISE EXCEPTION
            'Only current source-attested schema-v3 production evidence may be checkpointed.'
            USING ERRCODE = 'P0B40';
    END IF;

    IF v_reason = ''
       OR char_length(v_reason) > 500
       OR v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION
            'Reconciliation reason must be 1-500 characters without controls.'
            USING ERRCODE = '22023';
    END IF;
    IF p_actor_id IS NULL
       OR NOT EXISTS (
           SELECT 1 FROM auth.users WHERE id = p_actor_id
       ) THEN
        RAISE EXCEPTION
            'Reconciliation actor must be a real Auth user.'
            USING ERRCODE = '22023';
    END IF;

    IF p_report #>> '{webhook_delivery,platform_endpoint_url}'
            <> 'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform'
       OR p_report #>> '{webhook_delivery,connect_endpoint_url}'
            <> 'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect'
       OR p_report #>> '{webhook_delivery,platform_endpoint_livemode}' <> 'true'
       OR p_report #>> '{webhook_delivery,connect_endpoint_livemode}' <> 'true'
       OR p_report #>> '{webhook_delivery,connected_event_context_verified}'
            <> 'true'
       OR (p_report #>> '{webhook_delivery,enabled_platform_endpoint_count}')::INTEGER
            <> 1
       OR (p_report #>> '{webhook_delivery,enabled_connect_endpoint_count}')::INTEGER
            <> 1
       OR (p_report #>> '{webhook_delivery,platform_endpoint_candidate_count}')::INTEGER
            <> 1
       OR (p_report #>> '{webhook_delivery,connect_endpoint_candidate_count}')::INTEGER
            <> 1
       OR (p_report #>> '{webhook_delivery,unexpected_enabled_endpoint_count}')::INTEGER
            <> 0
       OR p_report #>> '{webhook_delivery,platform_endpoint_contract_matched}'
            <> 'true'
       OR p_report #>> '{webhook_delivery,connect_endpoint_contract_matched}'
            <> 'true'
       OR p_report #>> '{webhook_delivery,wildcard_accepted}' <> 'false' THEN
        RAISE EXCEPTION
            'The exact live platform and Connect webhook topology is required.'
            USING ERRCODE = 'P0B41';
    END IF;

    SELECT
        COALESCE(MAX(event.live_billing_ingest_sequence), 0),
        COUNT(*) FILTER (
            WHERE private.live_billing_event_is_in_scope(
                event.stripe_account_id,
                event.type
            )
        )
      INTO v_current_watermark, v_bounded_local_count
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at <= v_window_end
       AND (
           event.created_at >= v_window_start
           OR event.live_billing_ingest_sequence IS NOT NULL
       );

    SELECT COUNT(*)
      INTO v_bounded_local_count
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND private.live_billing_event_is_in_scope(
           event.stripe_account_id,
           event.type
       );

    IF v_watermark IS DISTINCT FROM v_current_watermark
       OR (p_report #>> '{event_reconciliation,bounded_local_total}')::INTEGER
            <> v_bounded_local_count
       OR (p_report #>> '{event_reconciliation,provider_only_event_count}')::INTEGER
            <> 0
       OR (p_report #>> '{event_reconciliation,local_only_event_count}')::INTEGER
            <> 0
       OR (p_report #>> '{event_reconciliation,failed}')::INTEGER <> 0
       OR (p_report #>> '{event_reconciliation,not_processed}')::INTEGER <> 0
       OR (p_report #>> '{event_reconciliation,wrong_mode_provider_event_count}')::INTEGER
            <> 0
       OR (p_report #>> '{event_reconciliation,wrong_mode_local_event_count}')::INTEGER
            <> 0
       OR (p_report #>> '{event_reconciliation,invalid_history_sequence_count}')::INTEGER
            <> 0
       OR (p_report #>> '{counts,unresolved_accounts}')::INTEGER <> 0
       OR (p_report #>> '{counts,unresolved_event_accounts}')::INTEGER <> 0
       OR (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER <= 0
       OR (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER
            <> (p_report #>> '{platform_delivery,local_event_count}')::INTEGER
       OR p_report #>> '{platform_delivery,fresh}' <> 'true' THEN
        RAISE EXCEPTION
            'Rolling reconciliation evidence is incomplete or stale.'
            USING ERRCODE = 'P0B42';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= v_window_start
           AND event.created_at <= v_window_end
           AND (
               (
                   private.live_billing_event_is_in_scope(
                       event.stripe_account_id,
                       event.type
                   )
                   AND event.processing_status IS DISTINCT FROM 'processed'
               )
               OR (
                   event.stripe_account_id IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.studio_payment_accounts account
                        WHERE account.stripe_connected_account_id =
                              event.stripe_account_id
                   )
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.stripe_connect_account_dispositions disposition
                        WHERE disposition.stripe_connected_account_id =
                              event.stripe_account_id
                          AND disposition.excluded
                   )
               )
           )
    ) THEN
        RAISE EXCEPTION
            'Current failed, stuck, or unmapped live event state blocks checkpointing.'
            USING ERRCODE = 'P0B43';
    END IF;

    IF v_continuity_mode = 'bootstrap' THEN
        IF EXISTS (
            SELECT 1
              FROM public.stripe_live_billing_reconciliation_checkpoints_v3
        )
           OR EXISTS (
               SELECT 1
                 FROM public.studio_live_billing_authorizations authz
                WHERE authz.enabled
           )
           OR p_report #>> '{continuity,bootstrap_local_history_checked}'
                <> 'true'
           OR (p_report #>> '{continuity,bootstrap_enabled_authorization_count}')::INTEGER
                <> 0
           OR (p_report #>> '{continuity,bootstrap_historical_failed_count}')::INTEGER
                <> 0
           OR (p_report #>> '{continuity,bootstrap_historical_not_processed_count}')::INTEGER
                <> 0
           OR (p_report #>> '{continuity,bootstrap_historical_unmapped_count}')::INTEGER
                <> 0
           OR v_previous_checkpoint_id IS NOT NULL
           OR v_previous_checkpoint_sequence IS NOT NULL
           OR v_previous_watermark IS NOT NULL
           OR v_overlap_start IS NOT NULL
           OR v_overlap_end IS NOT NULL THEN
            RAISE EXCEPTION
                'The first schema-v3 checkpoint must satisfy the explicit bootstrap rule.'
                USING ERRCODE = 'P0B44';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM public.stripe_events event
             WHERE event.livemode
               AND event.live_billing_ingest_sequence <= v_watermark
               AND (
                   event.processing_status = 'failed'
                   OR (
                       private.live_billing_event_is_in_scope(
                           event.stripe_account_id,
                           event.type
                       )
                       AND event.processing_status IS DISTINCT FROM 'processed'
                   )
                   OR (
                       event.stripe_account_id IS NOT NULL
                       AND NOT EXISTS (
                           SELECT 1
                             FROM public.studio_payment_accounts account
                            WHERE account.stripe_connected_account_id =
                                  event.stripe_account_id
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM public.stripe_connect_account_dispositions disposition
                            WHERE disposition.stripe_connected_account_id =
                                  event.stripe_account_id
                              AND disposition.excluded
                       )
                   )
               )
        ) THEN
            RAISE EXCEPTION
                'Local live history is not clean enough to establish the v3 bootstrap horizon.'
                USING ERRCODE = 'P0B45';
        END IF;
    ELSIF v_continuity_mode = 'rolling' THEN
        SELECT *
          INTO v_previous_sidecar
          FROM public.stripe_live_billing_reconciliation_checkpoints_v3 sidecar
         WHERE sidecar.checkpoint_id = v_previous_checkpoint_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'Rolling continuity requires the previous accepted schema-v3 checkpoint.'
                USING ERRCODE = 'P0B46';
        END IF;

        SELECT *
          INTO v_previous_checkpoint
          FROM public.stripe_live_billing_reconciliation_checkpoints checkpoint
         WHERE checkpoint.id = v_previous_checkpoint_id;

        IF NOT FOUND
           OR v_previous_checkpoint.checkpoint_sequence
                IS DISTINCT FROM v_previous_checkpoint_sequence
           OR v_previous_sidecar.checkpoint_sequence
                IS DISTINCT FROM v_previous_checkpoint_sequence
           OR v_previous_checkpoint.expires_at <= v_now
           OR v_previous_expires_at
                IS DISTINCT FROM v_previous_checkpoint.expires_at
           OR v_previous_window_end
                IS DISTINCT FROM v_previous_sidecar.event_window_ended_at
           OR v_previous_watermark
                IS DISTINCT FROM v_previous_sidecar.local_event_ingest_watermark
           OR v_previous_checkpoint_sequence IS DISTINCT FROM (
               SELECT MAX(sidecar.checkpoint_sequence)
                 FROM public.stripe_live_billing_reconciliation_checkpoints_v3 sidecar
           )
           OR v_window_end < v_previous_sidecar.event_window_ended_at
           OR v_overlap_start IS DISTINCT FROM GREATEST(
               v_window_start,
               v_previous_sidecar.event_window_started_at
           )
           OR v_overlap_end IS DISTINCT FROM LEAST(
               v_window_end,
               v_previous_sidecar.event_window_ended_at
           )
           OR v_overlap_end - v_overlap_start < INTERVAL '24 hours'
           OR v_watermark < v_previous_sidecar.local_event_ingest_watermark
           OR p_report #>> '{continuity,previous_checkpoint_valid}' <> 'true'
           OR p_report #>> '{continuity,local_event_ingest_watermark_non_regressing}'
                <> 'true'
           OR p_report #>> '{continuity,account_generation_continuity_valid}'
                <> 'true'
           OR (p_report #>> '{continuity,delta_failed_count}')::INTEGER <> 0
           OR (p_report #>> '{continuity,delta_not_processed_count}')::INTEGER <> 0
           OR (p_report #>> '{continuity,delta_unmapped_count}')::INTEGER <> 0 THEN
            RAISE EXCEPTION
                'Rolling checkpoint overlap, expiry, generation, or watermark continuity is invalid.'
                USING ERRCODE = 'P0B47';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM public.stripe_live_billing_reconciliation_account_evidence evidence
              JOIN public.studio_payment_accounts account
                ON account.stripe_connected_account_id =
                   evidence.stripe_connected_account_id
             WHERE evidence.checkpoint_id = v_previous_checkpoint_id
               AND evidence.connect_account_generation IS DISTINCT FROM
                   private.current_connect_account_generation(account.metadata)
        ) THEN
            RAISE EXCEPTION
                'A previously evidenced account generation regressed or changed in place.'
                USING ERRCODE = 'P0B48';
        END IF;

        IF EXISTS (
            SELECT 1
              FROM public.stripe_events event
             WHERE event.livemode
               AND event.live_billing_ingest_sequence >
                   v_previous_sidecar.local_event_ingest_watermark
               AND event.live_billing_ingest_sequence <= v_watermark
               AND (
                   event.processing_status = 'failed'
                   OR (
                       private.live_billing_event_is_in_scope(
                           event.stripe_account_id,
                           event.type
                       )
                       AND event.processing_status IS DISTINCT FROM 'processed'
                   )
                   OR (
                       event.stripe_account_id IS NOT NULL
                       AND NOT EXISTS (
                           SELECT 1
                             FROM public.studio_payment_accounts account
                            WHERE account.stripe_connected_account_id =
                                  event.stripe_account_id
                       )
                       AND NOT EXISTS (
                           SELECT 1
                             FROM public.stripe_connect_account_dispositions disposition
                            WHERE disposition.stripe_connected_account_id =
                                  event.stripe_account_id
                              AND disposition.excluded
                       )
                   )
               )
        ) THEN
            RAISE EXCEPTION
                'Local ingest continuity contains a failed, stuck, or unmapped event.'
                USING ERRCODE = 'P0B49';
        END IF;
    ELSE
        RAISE EXCEPTION
            'Continuity mode must be bootstrap or rolling.'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_report->'account_evidence') <> 'array' THEN
        RAISE EXCEPTION
            'Per-account reconciliation evidence is required.'
            USING ERRCODE = '22023';
    END IF;

    FOR v_account IN
        SELECT value FROM jsonb_array_elements(p_report->'account_evidence')
    LOOP
        SELECT *
          INTO v_mapping
          FROM public.studio_payment_accounts account
         WHERE account.studio_id = (v_account->>'studio_id')::UUID
           AND account.stripe_connected_account_id =
               v_account->>'stripe_connected_account_id';

        IF NOT FOUND
           OR private.current_connect_account_generation(v_mapping.metadata)
                IS DISTINCT FROM
                (v_account->>'connect_account_generation')::INTEGER
           OR (v_account->>'provider_event_count')::INTEGER <= 0
           OR (v_account->>'provider_event_count')::INTEGER
                <> (v_account->>'local_event_count')::INTEGER
           OR (v_account->>'provider_only_event_count')::INTEGER <> 0
           OR (v_account->>'local_only_event_count')::INTEGER <> 0
           OR v_account->>'fresh' <> 'true'
           OR (v_account->>'delivery_verified_at')::TIMESTAMPTZ
                < v_now - INTERVAL '24 hours'
           OR (v_account->>'delivery_verified_at')::TIMESTAMPTZ
                > v_now + INTERVAL '5 minutes' THEN
            RAISE EXCEPTION
                'Per-account delivery evidence is incomplete, stale, or generation-mismatched.'
                USING ERRCODE = 'P0B50';
        END IF;
        v_account_count := v_account_count + 1;
    END LOOP;

    SELECT COUNT(*)
      INTO v_mapping_count
      FROM public.studio_payment_accounts account
     WHERE account.stripe_connected_account_id IS NOT NULL;

    IF v_account_count
            <> (p_report #>> '{counts,mapped_accounts}')::INTEGER
       OR v_account_count <> v_mapping_count THEN
        RAISE EXCEPTION
            'Every current Connect mapping requires fresh generation-bound evidence.'
            USING ERRCODE = 'P0B51';
    END IF;

    INSERT INTO public.stripe_live_billing_reconciliation_checkpoints (
        stripe_livemode,
        candidate_sha,
        provider_account_count,
        mapped_account_count,
        excluded_account_count,
        unresolved_account_count,
        event_count_since_cutoff,
        failed_event_count,
        latest_event_created_at,
        webhook_delivery_verified_at,
        enabled_platform_endpoint_count,
        enabled_connect_endpoint_count,
        platform_endpoint_contract_matched,
        connect_endpoint_contract_matched,
        verified_at,
        expires_at,
        source_report_sha256,
        reason,
        verified_by,
        verified_by_email,
        evidence_source,
        deployment_ready_url,
        deployment_ready_sha,
        deployment_ready_verified_at,
        event_window_started_at,
        event_window_ended_at,
        local_event_ingest_watermark,
        bounded_provider_event_count,
        bounded_local_event_count,
        provider_only_event_count,
        local_only_event_count,
        platform_provider_event_count,
        platform_local_event_count,
        platform_delivery_verified_at,
        unexpected_enabled_endpoint_count,
        account_evidence_count
    ) VALUES (
        true,
        v_candidate_sha,
        (p_report #>> '{counts,provider_accounts}')::INTEGER,
        (p_report #>> '{counts,mapped_accounts}')::INTEGER,
        (p_report #>> '{counts,excluded_accounts}')::INTEGER,
        0,
        (p_report #>> '{event_reconciliation,bounded_local_total}')::INTEGER,
        0,
        (p_report #>> '{event_reconciliation,latest_created_at}')::TIMESTAMPTZ,
        v_platform_verified_at,
        1,
        1,
        true,
        true,
        v_now,
        p_expires_at,
        p_source_report_sha256,
        v_reason,
        p_actor_id,
        NULLIF(BTRIM(COALESCE(p_actor_email, '')), ''),
        'provider_read',
        'https://koaryu.onrender.com/health/ready',
        v_candidate_sha,
        v_ready_verified_at,
        NULL,
        NULL,
        v_watermark,
        (p_report #>> '{event_reconciliation,bounded_provider_total}')::INTEGER,
        (p_report #>> '{event_reconciliation,bounded_local_total}')::INTEGER,
        0,
        0,
        (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER,
        (p_report #>> '{platform_delivery,local_event_count}')::INTEGER,
        v_platform_verified_at,
        0,
        v_account_count
    )
    RETURNING * INTO v_checkpoint;

    INSERT INTO public.stripe_live_billing_reconciliation_checkpoints_v3 (
        checkpoint_id,
        checkpoint_sequence,
        candidate_sha,
        verified_at,
        expires_at,
        source_report_sha256,
        report_schema_version,
        continuity_mode,
        previous_checkpoint_id,
        previous_checkpoint_sequence,
        event_window_started_at,
        event_window_ended_at,
        continuity_overlap_started_at,
        continuity_overlap_ended_at,
        previous_local_event_ingest_watermark,
        local_event_ingest_watermark,
        bootstrap_historical_provider_completeness_claimed,
        bootstrap_local_history_checked,
        provider_retention_seconds,
        safety_margin_seconds,
        minimum_overlap_seconds,
        platform_endpoint_url,
        connect_endpoint_url,
        platform_endpoint_livemode,
        connect_endpoint_livemode,
        connected_event_context_verified
    ) VALUES (
        v_checkpoint.id,
        v_checkpoint.checkpoint_sequence,
        v_candidate_sha,
        v_checkpoint.verified_at,
        v_checkpoint.expires_at,
        p_source_report_sha256,
        3,
        v_continuity_mode,
        v_previous_checkpoint_id,
        v_previous_checkpoint_sequence,
        v_window_start,
        v_window_end,
        v_overlap_start,
        v_overlap_end,
        v_previous_watermark,
        v_watermark,
        false,
        (p_report #>> '{continuity,bootstrap_local_history_checked}')::BOOLEAN,
        2592000,
        86400,
        86400,
        'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform',
        'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect',
        true,
        true,
        true
    );

    INSERT INTO public.stripe_live_billing_reconciliation_account_evidence (
        checkpoint_id,
        studio_id,
        stripe_connected_account_id,
        connect_account_generation,
        provider_event_count,
        local_event_count,
        provider_only_event_count,
        local_only_event_count,
        delivery_verified_at
    )
    SELECT
        v_checkpoint.id,
        (value->>'studio_id')::UUID,
        value->>'stripe_connected_account_id',
        (value->>'connect_account_generation')::INTEGER,
        (value->>'provider_event_count')::INTEGER,
        (value->>'local_event_count')::INTEGER,
        0,
        0,
        (value->>'delivery_verified_at')::TIMESTAMPTZ
      FROM jsonb_array_elements(p_report->'account_evidence');

    RETURN v_checkpoint;
END;
$$;

ALTER FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v3(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v3(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v3(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION private.bind_live_billing_authorization_checkpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_sidecar public.stripe_live_billing_reconciliation_checkpoints_v3%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_generation INTEGER;
BEGIN
    IF NOT NEW.enabled THEN
        RETURN NEW;
    END IF;

    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_checkpoints_v3,
        public.stripe_live_billing_reconciliation_account_evidence
        IN SHARE MODE;

    SELECT checkpoint.*
      INTO v_checkpoint
      FROM public.stripe_live_billing_reconciliation_checkpoints checkpoint
      JOIN public.stripe_live_billing_reconciliation_checkpoints_v3 sidecar
        ON sidecar.checkpoint_id = checkpoint.id
     WHERE checkpoint.stripe_livemode
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url =
           'https://koaryu.onrender.com/health/ready'
       AND checkpoint.deployment_ready_sha = checkpoint.candidate_sha
       AND checkpoint.unresolved_account_count = 0
       AND checkpoint.failed_event_count = 0
       AND checkpoint.provider_only_event_count = 0
       AND checkpoint.local_only_event_count = 0
       AND checkpoint.enabled_platform_endpoint_count = 1
       AND checkpoint.enabled_connect_endpoint_count = 1
       AND checkpoint.unexpected_enabled_endpoint_count = 0
       AND checkpoint.platform_endpoint_contract_matched
       AND checkpoint.connect_endpoint_contract_matched
       AND checkpoint.platform_delivery_verified_at >= now() - INTERVAL '24 hours'
       AND checkpoint.expires_at > now()
       AND sidecar.report_schema_version = 3
       AND sidecar.candidate_sha = checkpoint.candidate_sha
       AND sidecar.expires_at = checkpoint.expires_at
       AND sidecar.local_event_ingest_watermark =
           checkpoint.local_event_ingest_watermark
       AND sidecar.platform_endpoint_livemode
       AND sidecar.connect_endpoint_livemode
       AND sidecar.connected_event_context_verified
       AND sidecar.event_window_ended_at - sidecar.event_window_started_at =
           INTERVAL '29 days'
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                   WHERE evidence.checkpoint_id = checkpoint.id
                     AND evidence.studio_id = mapped.studio_id
                     AND evidence.stripe_connected_account_id =
                         mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation =
                         private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
     ORDER BY checkpoint.checkpoint_sequence DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Current source-attested schema-v3 production reconciliation is required.'
            USING ERRCODE = 'P0B52';
    END IF;

    SELECT *
      INTO v_sidecar
      FROM public.stripe_live_billing_reconciliation_checkpoints_v3
     WHERE checkpoint_id = v_checkpoint.id;

    IF EXISTS (
        SELECT 1
          FROM public.stripe_events event
         WHERE event.livemode
           AND (
               (
                   event.live_billing_ingest_sequence <=
                       v_checkpoint.local_event_ingest_watermark
                   AND event.created_at >= v_sidecar.event_window_started_at
                   AND (
                       (
                           private.live_billing_event_is_in_scope(
                               event.stripe_account_id,
                               event.type
                           )
                           AND event.processing_status IS DISTINCT FROM 'processed'
                       )
                       OR (
                           event.stripe_account_id IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.studio_payment_accounts account
                                WHERE account.stripe_connected_account_id =
                                      event.stripe_account_id
                           )
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.stripe_connect_account_dispositions disposition
                                WHERE disposition.stripe_connected_account_id =
                                      event.stripe_account_id
                                  AND disposition.excluded
                           )
                       )
                   )
               )
               OR
               (
                   event.live_billing_ingest_sequence >
                       v_checkpoint.local_event_ingest_watermark
                   AND (
                       event.processing_status = 'failed'
                       OR (
                           private.live_billing_event_is_in_scope(
                               event.stripe_account_id,
                               event.type
                           )
                           AND event.processing_status IS DISTINCT FROM 'processed'
                       )
                       OR (
                           event.stripe_account_id IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.studio_payment_accounts account
                                WHERE account.stripe_connected_account_id =
                                      event.stripe_account_id
                           )
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public.stripe_connect_account_dispositions disposition
                                WHERE disposition.stripe_connected_account_id =
                                      event.stripe_account_id
                                  AND disposition.excluded
                           )
                       )
                   )
               )
           )
    ) THEN
        RAISE EXCEPTION
            'Current failed, stuck, or unmapped live events block authorization.'
            USING ERRCODE = 'P0B53';
    END IF;

    IF NEW.scope LIKE 'connect_%' THEN
        SELECT *
          INTO v_account
          FROM public.studio_payment_accounts account
         WHERE account.studio_id = NEW.studio_id;

        v_generation :=
            private.current_connect_account_generation(v_account.metadata);
        IF NOT FOUND
           OR v_generation IS NULL
           OR v_generation IS DISTINCT FROM NEW.connect_account_generation THEN
            RAISE EXCEPTION
                'Current Connect account generation does not match authorization.'
                USING ERRCODE = 'P0B54';
        END IF;

        IF v_account.stripe_connected_account_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                WHERE evidence.checkpoint_id = v_checkpoint.id
                  AND evidence.studio_id = NEW.studio_id
                  AND evidence.stripe_connected_account_id =
                      v_account.stripe_connected_account_id
                  AND evidence.connect_account_generation = v_generation
                  AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
           ) THEN
            RAISE EXCEPTION
                'Current Connect account lacks fresh generation-bound evidence.'
                USING ERRCODE = 'P0B55';
        END IF;
    END IF;

    NEW.reconciliation_checkpoint_id := v_checkpoint.id;
    NEW.local_event_ingest_watermark :=
        v_checkpoint.local_event_ingest_watermark;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.bind_live_billing_authorization_checkpoint()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.bind_live_billing_authorization_checkpoint()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    p_studio_id UUID,
    p_operation TEXT,
    p_scope TEXT,
    p_stripe_connected_account_id TEXT,
    p_candidate_sha TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_studio_id IS NULL
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_scope NOT IN (
           'core_subscription',
           'connect_onboarding',
           'connect_payments'
       )
       OR NOT (
            (
                p_scope = 'core_subscription'
                AND p_operation = ANY (ARRAY[
                    'customer.create',
                    'core_checkout_session.create',
                    'customer_portal_session.create'
                ]::TEXT[])
            )
            OR
            (
                p_scope = 'connect_onboarding'
                AND p_operation = ANY (ARRAY[
                    'connect_account.create',
                    'connect_account.branding.update',
                    'connect_branding_file.create',
                    'connect_onboarding_link.create',
                    'connect_dashboard_login_link.create'
                ]::TEXT[])
            )
            OR
            (
                p_scope = 'connect_payments'
                AND p_operation = ANY (ARRAY[
                    'connected_customer.create',
                    'connected_customer.update',
                    'connected_customer.default_payment_method.update',
                    'connected_product.create',
                    'connected_product.update',
                    'connected_price.create',
                    'connected_setup_checkout_session.create',
                    'connected_subscription.create',
                    'connected_subscription_item.create',
                    'connected_subscription_item.update',
                    'connected_subscription_item.delete',
                    'connected_subscription.update',
                    'connected_subscription.cancel',
                    'connected_invoice_item.create',
                    'connected_invoice.create',
                    'connected_invoice.finalize',
                    'connected_invoice.send',
                    'connected_invoice.pay',
                    'connected_invoice.void',
                    'connected_refund.create',
                    'connected_capability.readiness'
                ]::TEXT[])
            )
       ) THEN
        RETURN;
    END IF;

    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_checkpoints_v3,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations
        IN SHARE MODE;

    RETURN QUERY
    SELECT true, authz.studio_id, checkpoint.id
      FROM public.studio_live_billing_authorizations authz
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      JOIN public.stripe_live_billing_reconciliation_checkpoints_v3 sidecar
        ON sidecar.checkpoint_id = checkpoint.id
      LEFT JOIN public.studio_payment_accounts account
        ON account.studio_id = authz.studio_id
     WHERE authz.studio_id = p_studio_id
       AND authz.scope = p_scope
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.local_event_ingest_watermark =
           checkpoint.local_event_ingest_watermark
       AND checkpoint.stripe_livemode
       AND checkpoint.candidate_sha = p_candidate_sha
       AND checkpoint.deployment_ready_sha = p_candidate_sha
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url =
           'https://koaryu.onrender.com/health/ready'
       AND checkpoint.deployment_ready_verified_at >= now() - INTERVAL '24 hours'
       AND checkpoint.expires_at > now()
       AND checkpoint.unresolved_account_count = 0
       AND checkpoint.failed_event_count = 0
       AND checkpoint.provider_only_event_count = 0
       AND checkpoint.local_only_event_count = 0
       AND checkpoint.enabled_platform_endpoint_count = 1
       AND checkpoint.enabled_connect_endpoint_count = 1
       AND checkpoint.unexpected_enabled_endpoint_count = 0
       AND checkpoint.platform_endpoint_contract_matched
       AND checkpoint.connect_endpoint_contract_matched
       AND checkpoint.platform_delivery_verified_at >= now() - INTERVAL '24 hours'
       AND sidecar.report_schema_version = 3
       AND sidecar.candidate_sha = p_candidate_sha
       AND sidecar.expires_at = checkpoint.expires_at
       AND sidecar.local_event_ingest_watermark =
           checkpoint.local_event_ingest_watermark
       AND sidecar.platform_endpoint_livemode
       AND sidecar.connect_endpoint_livemode
       AND sidecar.connected_event_context_verified
       AND sidecar.event_window_ended_at - sidecar.event_window_started_at =
           INTERVAL '29 days'
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.stripe_live_billing_reconciliation_account_evidence evidence
            WHERE evidence.checkpoint_id = checkpoint.id
       )
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                   WHERE evidence.checkpoint_id = checkpoint.id
                     AND evidence.studio_id = mapped.studio_id
                     AND evidence.stripe_connected_account_id =
                         mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation =
                         private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.stripe_events event
            WHERE event.livemode
              AND (
                  (
                      event.live_billing_ingest_sequence <=
                          checkpoint.local_event_ingest_watermark
                      AND event.created_at >= sidecar.event_window_started_at
                      AND (
                          (
                              private.live_billing_event_is_in_scope(
                                  event.stripe_account_id,
                                  event.type
                              )
                              AND event.processing_status IS DISTINCT FROM 'processed'
                          )
                          OR (
                              event.stripe_account_id IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.studio_payment_accounts mapped
                                   WHERE mapped.stripe_connected_account_id =
                                         event.stripe_account_id
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.stripe_connect_account_dispositions disposition
                                   WHERE disposition.stripe_connected_account_id =
                                         event.stripe_account_id
                                     AND disposition.excluded
                              )
                          )
                      )
                  )
                  OR
                  (
                      event.live_billing_ingest_sequence >
                          authz.local_event_ingest_watermark
                      AND (
                          event.processing_status = 'failed'
                          OR (
                              private.live_billing_event_is_in_scope(
                                  event.stripe_account_id,
                                  event.type
                              )
                              AND event.processing_status IS DISTINCT FROM 'processed'
                          )
                          OR (
                              event.stripe_account_id IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.studio_payment_accounts mapped
                                   WHERE mapped.stripe_connected_account_id =
                                         event.stripe_account_id
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.stripe_connect_account_dispositions disposition
                                   WHERE disposition.stripe_connected_account_id =
                                         event.stripe_account_id
                                     AND disposition.excluded
                              )
                          )
                      )
                  )
              )
       )
       AND (
           (
               p_scope = 'core_subscription'
               AND authz.stripe_connected_account_id IS NULL
               AND p_stripe_connected_account_id IS NULL
           )
           OR
           (
               p_scope = 'connect_onboarding'
               AND account.studio_id = p_studio_id
               AND authz.connect_account_generation =
                   private.current_connect_account_generation(account.metadata)
               AND (
                   (
                       p_operation = 'connect_account.create'
                       AND p_stripe_connected_account_id IS NULL
                       AND account.stripe_connected_account_id IS NULL
                       AND authz.stripe_connected_account_id IS NULL
                   )
                   OR
                   (
                       p_operation = 'connect_branding_file.create'
                       AND p_stripe_connected_account_id IS NULL
                   )
                   OR
                   (
                       p_operation NOT IN (
                           'connect_account.create',
                           'connect_branding_file.create'
                       )
                       AND p_stripe_connected_account_id IS NOT NULL
                       AND account.stripe_connected_account_id =
                           p_stripe_connected_account_id
                       AND (
                           authz.stripe_connected_account_id IS NULL
                           OR authz.stripe_connected_account_id =
                               p_stripe_connected_account_id
                       )
                       AND EXISTS (
                           SELECT 1
                             FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                            WHERE evidence.checkpoint_id = checkpoint.id
                              AND evidence.studio_id = p_studio_id
                              AND evidence.stripe_connected_account_id =
                                  p_stripe_connected_account_id
                              AND evidence.connect_account_generation =
                                  private.current_connect_account_generation(
                                      account.metadata
                                  )
                              AND evidence.delivery_verified_at >=
                                  now() - INTERVAL '24 hours'
                       )
                   )
               )
           )
           OR
           (
               p_scope = 'connect_payments'
               AND p_stripe_connected_account_id IS NOT NULL
               AND authz.stripe_connected_account_id =
                   p_stripe_connected_account_id
               AND authz.connect_account_generation =
                   private.current_connect_account_generation(account.metadata)
               AND account.stripe_connected_account_id =
                   p_stripe_connected_account_id
               AND account.status = 'charges_enabled'
               AND account.charges_enabled
               AND account.payouts_enabled
               AND account.details_submitted
               AND cardinality(account.requirements_due) = 0
               AND EXISTS (
                   SELECT 1
                     FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                    WHERE evidence.checkpoint_id = checkpoint.id
                      AND evidence.studio_id = p_studio_id
                      AND evidence.stripe_connected_account_id =
                          p_stripe_connected_account_id
                      AND evidence.connect_account_generation =
                          private.current_connect_account_generation(
                              account.metadata
                          )
                      AND evidence.delivery_verified_at >=
                          now() - INTERVAL '24 hours'
               )
           )
       )
     LIMIT 1;
END;
$$;

ALTER FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION private.connect_onboarding_bootstrap_link_checkpoint(
    p_bootstrap_id UUID,
    p_candidate_sha TEXT
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT checkpoint.id
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
      JOIN public.studio_live_billing_authorizations authz
        ON authz.studio_id = bootstrap.studio_id
       AND authz.scope = 'connect_onboarding'
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      JOIN public.stripe_live_billing_reconciliation_checkpoints_v3 sidecar
        ON sidecar.checkpoint_id = checkpoint.id
      JOIN public.studio_payment_accounts account
        ON account.studio_id = bootstrap.studio_id
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id = checkpoint.id
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.stripe_connected_account_id IS NOT NULL
       AND bootstrap.account_bound_at IS NOT NULL
       AND account.stripe_connected_account_id =
           bootstrap.stripe_connected_account_id
       AND private.current_connect_account_generation(account.metadata) =
           bootstrap.connect_account_generation
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.connect_account_generation =
           bootstrap.connect_account_generation
       AND (
           authz.stripe_connected_account_id IS NULL
           OR authz.stripe_connected_account_id =
               bootstrap.stripe_connected_account_id
       )
       AND authz.local_event_ingest_watermark =
           checkpoint.local_event_ingest_watermark
       AND checkpoint.stripe_livemode
       AND checkpoint.candidate_sha = p_candidate_sha
       AND checkpoint.deployment_ready_sha = p_candidate_sha
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url =
           'https://koaryu.onrender.com/health/ready'
       AND checkpoint.deployment_ready_verified_at >= now() - INTERVAL '24 hours'
       AND checkpoint.expires_at > now()
       AND checkpoint.unresolved_account_count = 0
       AND checkpoint.failed_event_count = 0
       AND checkpoint.provider_only_event_count = 0
       AND checkpoint.local_only_event_count = 0
       AND checkpoint.enabled_platform_endpoint_count = 1
       AND checkpoint.enabled_connect_endpoint_count = 1
       AND checkpoint.unexpected_enabled_endpoint_count = 0
       AND checkpoint.platform_endpoint_contract_matched
       AND checkpoint.connect_endpoint_contract_matched
       AND checkpoint.platform_delivery_verified_at >= now() - INTERVAL '24 hours'
       AND sidecar.report_schema_version = 3
       AND sidecar.candidate_sha = p_candidate_sha
       AND sidecar.expires_at = checkpoint.expires_at
       AND sidecar.local_event_ingest_watermark =
           checkpoint.local_event_ingest_watermark
       AND sidecar.platform_endpoint_livemode
       AND sidecar.connect_endpoint_livemode
       AND sidecar.connected_event_context_verified
       AND checkpoint.account_evidence_count = (
           SELECT COUNT(*)
             FROM public.stripe_live_billing_reconciliation_account_evidence evidence
            WHERE evidence.checkpoint_id = checkpoint.id
       )
       AND checkpoint.account_evidence_count + 1 = (
           SELECT COUNT(*)
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id IS NOT NULL
              AND NOT (
                  mapped.studio_id = bootstrap.studio_id
                  AND mapped.stripe_connected_account_id =
                      bootstrap.stripe_connected_account_id
                  AND private.current_connect_account_generation(mapped.metadata) =
                      bootstrap.connect_account_generation
              )
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                   WHERE evidence.checkpoint_id = checkpoint.id
                     AND evidence.studio_id = mapped.studio_id
                     AND evidence.stripe_connected_account_id =
                         mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation =
                         private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
       AND NOT EXISTS (
           SELECT 1
             FROM public.stripe_events event
            WHERE event.livemode
              AND (
                  (
                      event.live_billing_ingest_sequence <=
                          checkpoint.local_event_ingest_watermark
                      AND event.created_at >= sidecar.event_window_started_at
                      AND (
                          (
                              private.live_billing_event_is_in_scope(
                                  event.stripe_account_id,
                                  event.type
                              )
                              AND event.processing_status IS DISTINCT FROM 'processed'
                          )
                          OR (
                              event.stripe_account_id IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.studio_payment_accounts mapped
                                   WHERE mapped.stripe_connected_account_id =
                                         event.stripe_account_id
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.stripe_connect_account_dispositions disposition
                                   WHERE disposition.stripe_connected_account_id =
                                         event.stripe_account_id
                                     AND disposition.excluded
                              )
                          )
                      )
                  )
                  OR
                  (
                      event.live_billing_ingest_sequence >
                          authz.local_event_ingest_watermark
                      AND (
                          event.processing_status = 'failed'
                          OR (
                              private.live_billing_event_is_in_scope(
                                  event.stripe_account_id,
                                  event.type
                              )
                              AND event.processing_status IS DISTINCT FROM 'processed'
                          )
                          OR (
                              event.stripe_account_id IS NOT NULL
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.studio_payment_accounts mapped
                                   WHERE mapped.stripe_connected_account_id =
                                         event.stripe_account_id
                              )
                              AND NOT EXISTS (
                                  SELECT 1
                                    FROM public.stripe_connect_account_dispositions disposition
                                   WHERE disposition.stripe_connected_account_id =
                                         event.stripe_account_id
                                     AND disposition.excluded
                              )
                          )
                      )
                  )
              )
       )
     LIMIT 1
$$;

ALTER FUNCTION private.connect_onboarding_bootstrap_link_checkpoint(UUID, TEXT)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION
    private.connect_onboarding_bootstrap_link_checkpoint(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_live_billing_v3_manifest_v19()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $manifest$
DECLARE
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    WITH required_functions(
        signature,
        expected_security_definer,
        expected_search_path,
        expected_service_execute
    ) AS (
        VALUES
          (
            'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb, timestamp with time zone, text, text, uuid, text)',
            true,
            'search_path=""',
            true
          ),
          (
            'private.bind_live_billing_authorization_checkpoint()',
            true,
            'search_path=""',
            false
          ),
          (
            'public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)',
            true,
            'search_path=""',
            true
          ),
          (
            'private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)',
            true,
            'search_path=""',
            false
          )
    ),
    function_state AS (
        SELECT
            required.signature,
            procedure.oid,
            COALESCE(owner.rolname, '') AS owner_name,
            COALESCE(procedure.prosecdef::TEXT, '') AS security_definer,
            COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
            has_function_privilege(
                'service_role',
                procedure.oid,
                'EXECUTE'
            ) AS service_execute,
            has_function_privilege(
                'anon',
                procedure.oid,
                'EXECUTE'
            ) AS anon_execute,
            has_function_privilege(
                'authenticated',
                procedure.oid,
                'EXECUTE'
            ) AS authenticated_execute,
            EXISTS (
                SELECT 1
                  FROM aclexplode(
                      COALESCE(
                          procedure.proacl,
                          acldefault('f', procedure.proowner)
                      )
                  ) privilege
                 WHERE privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE'
            ) AS public_execute,
            COALESCE(pg_get_functiondef(procedure.oid), '') AS definition,
            required.expected_security_definer,
            required.expected_search_path,
            required.expected_service_execute
        FROM required_functions required
        LEFT JOIN pg_proc procedure
          ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles owner
          ON owner.oid = procedure.proowner
    ),
    table_state AS (
        SELECT
            relation.oid,
            COALESCE(owner.rolname, '') AS owner_name,
            relation.relrowsecurity,
            has_table_privilege(
                'service_role',
                relation.oid,
                'SELECT'
            ) AS service_select,
            has_table_privilege(
                'service_role',
                relation.oid,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ) AS service_write,
            has_table_privilege(
                'anon',
                relation.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ) AS anon_access,
            has_table_privilege(
                'authenticated',
                relation.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ) AS authenticated_access,
            EXISTS (
                SELECT 1
                  FROM aclexplode(
                      COALESCE(
                          relation.relacl,
                          acldefault('r', relation.relowner)
                      )
                  ) privilege
                 WHERE privilege.grantee = 0
            ) AS public_access
        FROM pg_class relation
        JOIN pg_roles owner ON owner.oid = relation.relowner
        WHERE relation.oid =
            to_regclass(
                'public.stripe_live_billing_reconciliation_checkpoints_v3'
            )
    ),
    column_state AS (
        SELECT
            column_name,
            data_type,
            is_nullable,
            ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name =
              'stripe_live_billing_reconciliation_checkpoints_v3'
    ),
    constraint_state AS (
        SELECT
            constraint_row.conname,
            constraint_row.contype::TEXT,
            constraint_row.convalidated,
            pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid =
            to_regclass(
                'public.stripe_live_billing_reconciliation_checkpoints_v3'
            )
    ),
    serialized AS (
        SELECT
            'f:' || signature || ':' || owner_name || ':' ||
            security_definer || ':' || configuration || ':' ||
            service_execute::TEXT || ':' || definition AS value,
            (
                oid IS NULL
                OR owner_name <> 'postgres'
                OR security_definer <>
                    expected_security_definer::TEXT
                OR configuration <> expected_search_path
                OR service_execute IS DISTINCT FROM expected_service_execute
                OR anon_execute
                OR authenticated_execute
                OR public_execute
                OR definition LIKE '%' || '2026' || '-07-13%'
            )::INTEGER AS invalid
        FROM function_state
        UNION ALL
        SELECT
            't:' || owner_name || ':' || relrowsecurity::TEXT || ':' ||
            service_select::TEXT || ':' || service_write::TEXT || ':' ||
            anon_access::TEXT || ':' || authenticated_access::TEXT || ':' ||
            public_access::TEXT,
            (
                oid IS NULL
                OR owner_name <> 'postgres'
                OR NOT relrowsecurity
                OR NOT service_select
                OR service_write
                OR anon_access
                OR authenticated_access
                OR public_access
            )::INTEGER
        FROM table_state
        UNION ALL
        SELECT
            'c:' || column_name || ':' || data_type || ':' ||
            is_nullable || ':' || ordinal_position::TEXT,
            0
        FROM column_state
        UNION ALL
        SELECT
            'k:' || conname || ':' || contype || ':' ||
            convalidated::TEXT || ':' || definition,
            (NOT convalidated)::INTEGER
        FROM constraint_state
        UNION ALL
        SELECT
            'legacy-v2-service-execute:' ||
            has_function_privilege(
                'service_role',
                'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
                'EXECUTE'
            )::TEXT,
            has_function_privilege(
                'service_role',
                'public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)',
                'EXECUTE'
            )::INTEGER
    )
    SELECT
        COALESCE(sum(invalid), 0)::INTEGER,
        string_agg(value, '|' ORDER BY value COLLATE "C")
      INTO v_invalid, v_serialized
      FROM serialized;

    RETURN v_invalid::TEXT || ':' ||
        encode(
            extensions.digest(
                convert_to(COALESCE(v_serialized, ''), 'UTF8'),
                'sha256'
            ),
            'hex'
        );
END;
$manifest$;

ALTER FUNCTION private.koaryu_release_live_billing_v3_manifest_v19()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION
    private.koaryu_release_live_billing_v3_manifest_v19()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v4()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $preflight$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT
        count(*)::INTEGER,
        max(version),
        array_agg(version ORDER BY version COLLATE "C")
            FILTER (WHERE version >= '20260727100000')
      INTO v_count, v_head, v_pending
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 112
       OR v_head <> '20260820170000' THEN
        v_failures :=
            array_append(v_failures, 'migration_history_v19');
    END IF;

    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820170000'
    ]::TEXT[] THEN
        v_failures :=
            array_append(v_failures, 'migration_history_sequence_v19');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'edb917a52aeb0b0451a403b640aa2599552641d4e6569e526e2a8267495c79a2' THEN
        v_failures :=
            array_append(
                v_failures,
                'operational_semantic_acl_manifest_v19'
            );
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures :=
            array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures :=
            array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;

    IF private.koaryu_release_critical_surface_manifest_v17()
       <> '0:5df0deffed6e55418dccce707ae31e68352035a3962c2cd1609f3f2f764d78ad' THEN
        v_failures :=
            array_append(v_failures, 'critical_surface_manifest_v19');
    END IF;

    IF private.koaryu_release_live_billing_v3_manifest_v19()
       <> '0:d3d3467ba2ede7270190b86c2c36ced103528041ef89d0805f0187390416e338' THEN
        v_failures :=
            array_append(v_failures, 'live_billing_v3_manifest_v19');
    END IF;

    RETURN QUERY
    SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v19';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4()
    TO service_role;

-- Preserve the deployed v18 backend during a database-first cutover. New
-- backends call v4; v3 continues returning its exact old shape only when v4
-- proves the complete v19 state.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v3()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $compatibility$
DECLARE
    v_current RECORD;
BEGIN
    SELECT *
      INTO v_current
      FROM public.koaryu_release_schema_preflight_v4();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 112
       AND v_current.migration_head = '20260820170000'
       AND v_current.manifest_version = 'release-db-attestation-v19'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY
        SELECT
            true,
            111,
            '20260816012723'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957',
                '20260801060000','20260801070000','20260801080000',
                '20260801090000','20260801091000','20260801092000',
                '20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112',
                '20260801131844','20260814043325','20260814103046',
                '20260814105424','20260814114500','20260814152000',
                '20260814170000','20260814183000','20260814200000',
                '20260814213000','20260815220402','20260816012723'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v18'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        false,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(
            v_current.security_failures,
            ARRAY['v19_compatibility_preflight']::TEXT[]
        ),
        'release-db-attestation-v18'::TEXT;
END;
$compatibility$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v3()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v3()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v3()
    TO service_role;

DO $diagnostics$
BEGIN
    RAISE NOTICE 'KOARYU_V19_OPERATIONAL_MANIFEST=%',
        private.koaryu_release_operational_manifest_v7();
    RAISE NOTICE 'KOARYU_V19_CRITICAL_SURFACE_MANIFEST=%',
        private.koaryu_release_critical_surface_manifest_v17();
    RAISE NOTICE 'KOARYU_V19_LIVE_BILLING_MANIFEST=%',
        private.koaryu_release_live_billing_v3_manifest_v19();
END;
$diagnostics$;

COMMENT ON TABLE
    public.stripe_live_billing_reconciliation_checkpoints_v3
IS
    'Schema-v3 retention-bounded rolling reconciliation and continuity proof. Legacy checkpoint rows remain audit-only.';

COMMENT ON FUNCTION
    public.record_stripe_live_billing_reconciliation_checkpoint_v3(
        JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
    )
IS
    'Records only exact-SHA, live, provider-read schema-v3 evidence with bootstrap or unexpired rolling continuity.';
