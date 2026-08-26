-- Schema-v3 live-billing reconciliation and continuity contract.
--
-- This migration is additive. Legacy checkpoint rows remain readable, but the
-- v2 recorder loses service-role execution and every future enabled
-- authorization must bind to a v3 sidecar row.

DO $v24_preflight_guard$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT *
      INTO v_preflight
      FROM public.koaryu_release_schema_preflight_v4();

    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 117
       OR v_preflight.migration_head IS DISTINCT FROM '20260824190500'
       OR v_preflight.pending_versions IS DISTINCT FROM ARRAY[
            '20260727100000','20260727110000','20260801050957','20260801060000',
            '20260801070000','20260801080000','20260801090000','20260801091000',
            '20260801092000','20260801093000','20260801094000','20260801105313',
            '20260801112153','20260801115044','20260801123112','20260801131844',
            '20260814043325','20260814103046','20260814105424','20260814114500',
            '20260814152000','20260814170000','20260814183000','20260814200000',
            '20260814213000','20260815220402','20260816012723','20260820012533',
            '20260820025759','20260820060216','20260822193000','20260823193155',
            '20260824190500'
       ]::TEXT[]
       OR COALESCE(v_preflight.security_failures, ARRAY[]::TEXT[])
            <> ARRAY[]::TEXT[]
       OR v_preflight.manifest_version IS DISTINCT FROM
            'release-db-attestation-v24' THEN
        RAISE EXCEPTION
            'Schema-v3 reconciliation requires the exact ready 117/V24 predecessor.';
    END IF;
END;
$v24_preflight_guard$;

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

CREATE INDEX idx_stripe_live_billing_reconciliation_v3_previous
    ON public.stripe_live_billing_reconciliation_checkpoints_v3(
        previous_checkpoint_id
    )
    WHERE previous_checkpoint_id IS NOT NULL;

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
        public.studio_live_billing_authorizations,
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_checkpoints_v3,
        public.stripe_live_billing_reconciliation_account_evidence
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
) FROM PUBLIC, anon, authenticated, service_role;
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
        public.studio_live_billing_authorizations,
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_checkpoints_v3,
        public.stripe_live_billing_reconciliation_account_evidence
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
) FROM PUBLIC, anon, authenticated, service_role;
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

CREATE FUNCTION private.koaryu_release_operational_contract_v25()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog
SET TimeZone = 'UTC'
AS $v7$

with required_tables(schema_name, table_name, rls_enabled, service_privileges) as (
  values
    ('public', 'studio_live_billing_authorizations', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_checkpoints', true, 'SELECT'),
    ('public', 'stripe_connect_account_dispositions', true, 'SELECT'),
    ('public', 'stripe_live_billing_reconciliation_account_evidence', true, 'SELECT'),
    ('public', 'stripe_connect_onboarding_bootstraps', true, ''),
    ('public', 'operational_alert_episodes', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_outbox', true, 'INSERT,SELECT,UPDATE'),
    ('public', 'operational_alert_delivery_attempts', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_delivery_outcomes', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_audit_events', true, 'INSERT,SELECT'),
    ('public', 'operational_alert_heartbeats', true, 'INSERT,SELECT,UPDATE'),
    ('private', 'stripe_connect_account_identity_guards', false, '')
),
acl_scope_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  values
    ('public', 'studio_payment_accounts'),
    ('public', 'stripe_events')
),
scoped_definition_tables(schema_name, table_name) as (
  select schema_name, table_name from required_tables
  union all
  select 'public', 'studio_payment_accounts'
),
table_actual as (
  select
    namespace.nspname as schema_name,
    relation.relname as table_name,
    owner.rolname as owner_name,
    relation.relrowsecurity,
    coalesce((
      select string_agg(
               coalesce(grantor.rolname, 'PUBLIC') || '>' ||
               coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
               ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
             )
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
        left join pg_roles grantor on grantor.oid = acl.grantor
        left join pg_roles grantee on grantee.oid = acl.grantee
    ), '') as acl_state,
    exists (
      select 1
        from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
       where acl.grantee = 0
    ) as public_access,
    has_table_privilege('anon', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_access,
    has_table_privilege('authenticated', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_access,
    concat_ws(',',
      case when has_table_privilege('service_role', relation.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('service_role', relation.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('service_role', relation.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('service_role', relation.oid, 'DELETE') then 'DELETE' end,
      case when has_table_privilege('service_role', relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
      case when has_table_privilege('service_role', relation.oid, 'REFERENCES') then 'REFERENCES' end,
      case when has_table_privilege('service_role', relation.oid, 'TRIGGER') then 'TRIGGER' end
    ) as service_privileges
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_roles owner on owner.oid = relation.relowner
  join required_tables required
    on required.schema_name = namespace.nspname and required.table_name = relation.relname
  where relation.relkind = 'r'
),
table_compared as (
  select required.*, actual.owner_name, actual.relrowsecurity,
         actual.public_access, actual.anon_access, actual.authenticated_access,
         actual.service_privileges as actual_service_privileges,
         actual.acl_state
    from required_tables required
    left join table_actual actual using (schema_name, table_name)
),
table_acl_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_roles owner on owner.oid = relation.relowner
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
   where relation.relkind = 'r'
),
column_acl_definitions as (
  select namespace.nspname as schema_name,
         relation.relname as table_name,
         attribute.attnum,
         attribute.attname as column_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                    acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C",
                                 coalesce(grantee.rolname, 'PUBLIC') collate "C",
                                 acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(attribute.attacl) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join acl_scope_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
    join pg_attribute attribute
      on attribute.attrelid = relation.oid
     and attribute.attnum > 0
     and not attribute.attisdropped
   where relation.relkind = 'r'
),
required_policies(table_name, policy_name, permissive, command_name, role_names, predicate_kind) as (
  values
    ('studio_live_billing_authorizations', 'studio_live_billing_authorizations_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('studio_live_billing_authorizations', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_billing_reconciliation_checkpoints_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_checkpoints', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_account_dispositions', 'stripe_connect_account_dispositions_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_account_dispositions', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_live_billing_reconciliation_account_evidence', 'stripe_live_billing_account_evidence_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_live_billing_reconciliation_account_evidence', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_no_client_access', false, '*', 'anon,authenticated', 'deny_all'),
    ('stripe_connect_onboarding_bootstraps', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_episodes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_outbox', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_attempts', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_delivery_outcomes', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_audit_events', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard'),
    ('operational_alert_heartbeats', 'reject_ambiguous_staff_membership_access', false, '*', 'authenticated', 'membership_guard')
),
policy_actual as (
  select relation.relname as table_name, policy.polname as policy_name,
         policy.polpermissive as permissive, policy.polcmd::text as command_name,
         (select string_agg(role.rolname, ',' order by role.rolname collate "C")
            from unnest(policy.polroles) role_oid
            join pg_roles role on role.oid = role_oid) as role_names,
         case
           when regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
            and regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g') = 'false'
             then 'deny_all'
           when regexp_replace(
                  regexp_replace(pg_get_expr(policy.polqual, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
            and regexp_replace(
                  regexp_replace(pg_get_expr(policy.polwithcheck, policy.polrelid), '[[:space:]()]', '', 'g'),
                  'AShas_unambiguous_studio_membership$', ''
                ) = 'SELECTprivate.has_unambiguous_studio_membership'
             then 'membership_guard'
           else 'unexpected'
         end as predicate_kind
    from pg_policy policy
    join pg_class relation on relation.oid = policy.polrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join required_tables covered
      on covered.schema_name = 'public' and covered.table_name = relation.relname
   where namespace.nspname = 'public'
),
policy_compared as (
  select coalesce(required.table_name, actual.table_name) as table_name,
         coalesce(required.policy_name, actual.policy_name) as policy_name,
         required.permissive, required.command_name, required.role_names,
         required.predicate_kind,
         actual.permissive as actual_permissive,
         actual.command_name as actual_command_name,
         actual.role_names as actual_role_names,
         actual.predicate_kind as actual_predicate_kind,
         required.table_name is not null as expected_policy,
         actual.table_name is not null as actual_policy
    from required_policies required
    full join policy_actual actual using (table_name, policy_name)
),
required_functions(signature, search_path_config, security_definer, service_execute) as (
  values
    ('public.preserve_studio_comp_provenance()', 'search_path=pg_catalog', false, false),
    ('public.set_studio_comp_atomic(uuid, boolean, text, uuid, text, boolean)', 'search_path=public, pg_temp', false, true),
    ('public.clear_studio_comp_for_billing_event(uuid, bigint)', 'search_path=public, pg_temp', false, true),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text, integer, integer, integer, integer, integer, integer, timestamp with time zone, timestamp with time zone, integer, integer, boolean, boolean, timestamp with time zone, text, text, uuid, text)', 'search_path=public, pg_temp', true, false),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb, timestamp with time zone, text, text, uuid, text)', 'search_path=""', true, false),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid, text, text, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('public.bind_connect_onboarding_bootstrap_account(uuid, text, integer, text, text, text)', 'search_path=""', true, false),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid, text, integer, text, text, text, text, text)', 'search_path=""', true, false),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid, text)', 'search_path=""', true, false),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid, text)', 'search_path=""', true, true),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid, text)', 'search_path=""', true, true),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid, text, integer, jsonb, text, text, text, text)', 'search_path=""', true, true),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid, uuid, text, integer, text, text)', 'search_path=""', true, true),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid, uuid, text, integer, text, text, text, text)', 'search_path=""', true, true),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid, uuid, text, integer, text, text, text, text, text, text)', 'search_path=""', true, true),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid, text, text)', 'search_path=""', true, true),
    ('private.live_billing_event_is_in_scope(text, text)', 'search_path=""', true, false),
    ('private.enforce_live_billing_checkpoint_processed_events()', 'search_path=""', true, false),
    ('private.current_connect_account_generation(jsonb)', 'search_path=""', false, true),
    ('private.bind_live_billing_authorization_checkpoint()', 'search_path=""', true, false),
    ('public.set_studio_live_billing_authorization_atomic(uuid, text, boolean, timestamp with time zone, text, uuid, text, text)', 'search_path=public, pg_temp', true, true),
    ('public.set_stripe_connect_account_exclusion_atomic(text, boolean, text, uuid, text)', 'search_path=public, pg_temp', true, true),
    ('public.finish_stripe_event_processing_v2(uuid, text, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.prevent_operational_alert_append_only_mutation()', 'search_path=""', false, false),
    ('public.enforce_operational_alert_sent_receipt()', 'search_path=""', false, false),
    ('public.operational_alert_metric_counts()', 'search_path=public, pg_temp', false, true),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, text, text)', 'search_path=public, pg_temp', false, false),
    ('public.evaluate_operational_alert(text, text, bigint, integer, integer, text, text, integer, text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.acknowledge_operational_alert(text, uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.claim_operational_alert_delivery(text, text, uuid, integer)', 'search_path=public, pg_temp', false, true),
    ('public.complete_operational_alert_delivery(uuid, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.fail_operational_alert_delivery(uuid, text, text, integer)', 'search_path=public, pg_temp', false, true),
    ('public.record_operational_alert_heartbeat(text, text, text)', 'search_path=public, pg_temp', false, true),
    ('public.operational_alert_heartbeats(text)', 'search_path=public, pg_temp', false, true),
    ('public.koaryu_release_schema_preflight()', 'search_path=pg_catalog', true, true),
    ('public.koaryu_release_schema_preflight_v6()', 'search_path=pg_catalog', true, false),
    ('private.koaryu_release_operational_manifest_v2()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v2_base()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v4()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v5()', 'search_path=pg_catalog', false, false),
    ('private.koaryu_release_operational_manifest_v6()', 'search_path=pg_catalog', false, false),
    ('private.sync_connect_identity_mapping_guard()', 'search_path=pg_catalog', true, false),
    ('private.sync_connect_identity_exclusion_guard()', 'search_path=pg_catalog', true, false)
),
function_actual as (
  select format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) as signature,
         owner.rolname as owner_name, language.lanname as language_name,
         function.prosecdef as security_definer,
         coalesce(array_to_string(function.proconfig, ','), '') as search_path_config,
         exists (select 1 from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl where acl.grantee = 0 and acl.privilege_type = 'EXECUTE') as public_execute,
         has_function_privilege('anon', function.oid, 'EXECUTE') as anon_execute,
         has_function_privilege('authenticated', function.oid, 'EXECUTE') as authenticated_execute,
         has_function_privilege('service_role', function.oid, 'EXECUTE') as service_execute,
         encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') as body_sha256,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (
           select 1
             from aclexplode(coalesce(function.proacl, acldefault('f', function.proowner))) acl
             left join pg_roles grantee on grantee.oid = acl.grantee
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> function.proowner
              and not (
                grantee.rolname = 'service_role'
                and required.service_execute
                and not acl.is_grantable
              )
         ) as unexpected_execute_grant
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    join pg_roles owner on owner.oid = function.proowner
    join pg_language language on language.oid = function.prolang
    join required_functions required
      on required.signature = format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes))
),
function_compared as (
  select required.*, actual.owner_name, actual.language_name,
         actual.security_definer as actual_security_definer,
         actual.search_path_config as actual_search_path_config,
         actual.public_execute, actual.anon_execute, actual.authenticated_execute,
         actual.service_execute as actual_service_execute,
         actual.body_sha256, actual.acl_state, actual.unexpected_execute_grant
    from required_functions required
    left join function_actual actual using (signature)
),
required_triggers(table_name, trigger_name, function_schema, function_name, trigger_type) as (
  values
    ('studio_subscriptions', 'preserve_studio_comp_provenance_on_metadata_update', 'public', 'preserve_studio_comp_provenance', 19),
    ('studio_live_billing_authorizations', 'set_studio_live_billing_authorizations_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_connect_account_dispositions', 'set_stripe_connect_account_dispositions_updated_at', 'public', 'update_updated_at_column', 19),
    ('studio_live_billing_authorizations', 'bind_live_billing_authorization_checkpoint', 'private', 'bind_live_billing_authorization_checkpoint', 23),
    ('stripe_connect_onboarding_bootstraps', 'set_stripe_connect_onboarding_bootstraps_updated_at', 'public', 'update_updated_at_column', 19),
    ('stripe_live_billing_reconciliation_checkpoints', 'enforce_live_billing_checkpoint_processed_events', 'private', 'enforce_live_billing_checkpoint_processed_events', 7),
    ('operational_alert_delivery_attempts', 'prevent_operational_alert_attempt_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_delivery_outcomes', 'prevent_operational_alert_outcome_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_audit_events', 'prevent_operational_alert_audit_mutation', 'public', 'prevent_operational_alert_append_only_mutation', 27),
    ('operational_alert_outbox', 'enforce_operational_alert_sent_receipt', 'public', 'enforce_operational_alert_sent_receipt', 23),
    ('studio_payment_accounts', 'sync_connect_identity_mapping_guard', 'private', 'sync_connect_identity_mapping_guard', 29),
    ('stripe_connect_account_dispositions', 'sync_connect_identity_exclusion_guard', 'private', 'sync_connect_identity_exclusion_guard', 29)
),
trigger_actual as (
  select relation.relname as table_name, trigger.tgname as trigger_name,
         function_namespace.nspname as function_schema, function.proname as function_name,
         trigger.tgtype::integer as trigger_type, trigger.tgenabled, trigger.tgisinternal,
         encode(extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_proc function on function.oid = trigger.tgfoid
    join pg_namespace function_namespace on function_namespace.oid = function.pronamespace
    join required_triggers required
      on required.table_name = relation.relname and required.trigger_name = trigger.tgname
   where namespace.nspname = 'public'
),
trigger_compared as (
  select required.*, actual.function_schema as actual_function_schema,
         actual.function_name as actual_function_name,
         actual.trigger_type as actual_trigger_type,
         actual.tgenabled, actual.tgisinternal, actual.definition_sha256
    from required_triggers required
    left join trigger_actual actual using (table_name, trigger_name)
),
required_indexes(index_name, table_name, unique_index, partial_index) as (
  values
    ('idx_studio_live_billing_authorizations_enabled', 'studio_live_billing_authorizations', false, true),
    ('idx_stripe_live_billing_reconciliation_checkpoints_latest', 'stripe_live_billing_reconciliation_checkpoints', false, false),
    ('idx_stripe_events_error_reference', 'stripe_events', true, true),
    ('idx_stripe_events_live_billing_ingest_sequence', 'stripe_events', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_generation_once', 'stripe_connect_onboarding_bootstraps', true, false),
    ('idx_stripe_connect_onboarding_bootstraps_delivery_receipt', 'stripe_connect_onboarding_bootstraps', true, true),
    ('operational_alert_episodes_one_unresolved', 'operational_alert_episodes', true, true),
    ('operational_alert_episodes_recent', 'operational_alert_episodes', false, false),
    ('operational_alert_outbox_claim', 'operational_alert_outbox', false, true),
    ('operational_alert_delivery_attempts_delivery', 'operational_alert_delivery_attempts', false, false),
    ('operational_alert_audit_events_episode', 'operational_alert_audit_events', false, false)
),
index_actual as (
  select index_relation.relname as index_name, table_relation.relname as table_name,
         index.indisunique as unique_index, index.indpred is not null as partial_index,
         index.indisvalid, index.indisready,
         encode(extensions.digest(convert_to(pg_get_indexdef(index.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index
    join pg_class index_relation on index_relation.oid = index.indexrelid
    join pg_class table_relation on table_relation.oid = index.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join required_indexes required on required.index_name = index_relation.relname
   where namespace.nspname = 'public'
),
index_compared as (
  select required.*, actual.table_name as actual_table_name,
         actual.unique_index as actual_unique_index,
         actual.partial_index as actual_partial_index,
         actual.indisvalid, actual.indisready, actual.definition_sha256
    from required_indexes required
    left join index_actual actual using (index_name)
),
required_sequences(table_name, column_name, service_usage, service_select, service_update) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'checkpoint_sequence', true, true, false),
    ('stripe_events', 'live_billing_ingest_sequence', true, true, false),
    ('operational_alert_audit_events', 'id', true, true, false)
),
sequence_actual as (
  select table_relation.relname as table_name, attribute.attname as column_name,
         owner.rolname as owner_name,
         coalesce((
           select string_agg(
                    coalesce(grantor.rolname, 'PUBLIC') || '>' ||
                    coalesce(grantee.rolname, 'PUBLIC') || ':' || acl.privilege_type || ':' || acl.is_grantable::text,
                    ',' order by coalesce(grantor.rolname, 'PUBLIC') collate "C", coalesce(grantee.rolname, 'PUBLIC') collate "C", acl.privilege_type collate "C", acl.is_grantable
                  )
             from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl
             left join pg_roles grantor on grantor.oid = acl.grantor
             left join pg_roles grantee on grantee.oid = acl.grantee
         ), '') as acl_state,
         exists (select 1 from aclexplode(coalesce(sequence.relacl, acldefault('S', sequence.relowner))) acl where acl.grantee = 0) as public_access,
         has_sequence_privilege('anon', sequence.oid, 'USAGE,SELECT,UPDATE') as anon_access,
         has_sequence_privilege('authenticated', sequence.oid, 'USAGE,SELECT,UPDATE') as authenticated_access,
         has_sequence_privilege('service_role', sequence.oid, 'USAGE') as service_usage,
         has_sequence_privilege('service_role', sequence.oid, 'SELECT') as service_select,
         has_sequence_privilege('service_role', sequence.oid, 'UPDATE') as service_update
    from pg_class sequence
    join pg_depend dependency on dependency.objid = sequence.oid and dependency.deptype in ('a', 'i')
    join pg_class table_relation on table_relation.oid = dependency.refobjid
    join pg_attribute attribute on attribute.attrelid = table_relation.oid and attribute.attnum = dependency.refobjsubid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join pg_roles owner on owner.oid = sequence.relowner
    join required_sequences required on required.table_name = table_relation.relname and required.column_name = attribute.attname
   where namespace.nspname = 'public' and sequence.relkind = 'S'
),
sequence_compared as (
  select required.*, actual.owner_name, actual.public_access,
         actual.anon_access, actual.authenticated_access,
         actual.service_usage as actual_service_usage,
         actual.service_select as actual_service_select,
         actual.service_update as actual_service_update,
         actual.acl_state
    from required_sequences required
    left join sequence_actual actual using (table_name, column_name)
),
required_columns(table_name, column_name, data_type, nullable, identity_column) as (
  values
    ('stripe_events', 'error_reference', 'text', true, false),
    ('stripe_events', 'live_billing_ingest_sequence', 'bigint', false, true),
    ('stripe_live_billing_reconciliation_checkpoints', 'evidence_source', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_url', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_sha', 'text', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'deployment_ready_verified_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'event_window_started_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'event_window_ended_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'local_event_ingest_watermark', 'bigint', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'bounded_provider_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'bounded_local_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'provider_only_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'local_only_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_provider_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_local_event_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'platform_delivery_verified_at', 'timestamp with time zone', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'unexpected_enabled_endpoint_count', 'integer', true, false),
    ('stripe_live_billing_reconciliation_checkpoints', 'account_evidence_count', 'integer', true, false),
    ('studio_live_billing_authorizations', 'reconciliation_checkpoint_id', 'uuid', true, false),
    ('studio_live_billing_authorizations', 'local_event_ingest_watermark', 'bigint', true, false),
    ('stripe_connect_onboarding_bootstraps', 'bootstrap_token_sha256', 'text', false, false),
    ('stripe_connect_onboarding_bootstraps', 'connect_account_generation', 'integer', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_payload_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connected_account_id', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'expires_at', 'timestamp with time zone', false, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_claimed_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_context', 'jsonb', true, false),
    ('stripe_connect_onboarding_bootstraps', 'recovery_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_response_recorded_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_sha256', 'text', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivery_receipt_expires_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_delivered_at', 'timestamp with time zone', true, false),
    ('stripe_connect_onboarding_bootstraps', 'initial_link_support_required_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'backup_destination_id', 'text', false, false),
    ('operational_alert_episodes', 'escalation_after_minutes', 'integer', false, false),
    ('operational_alert_episodes', 'acknowledged_at', 'timestamp with time zone', true, false),
    ('operational_alert_episodes', 'acknowledged_by_role', 'text', true, false),
    ('operational_alert_episodes', 'acknowledged_actor_ref', 'text', true, false),
    ('operational_alert_outbox', 'event_kind', 'text', false, false),
    ('operational_alert_outbox', 'destination_role', 'text', false, false)
),
column_compared as (
  select required.*,
         actual.data_type as actual_data_type,
         actual.is_nullable = 'YES' as actual_nullable,
         actual.is_identity = 'YES' as actual_identity_column
    from required_columns required
    left join information_schema.columns actual
      on actual.table_schema = 'public'
     and actual.table_name = required.table_name
     and actual.column_name = required.column_name
),
required_constraints(table_name, constraint_identity, constraint_type) as (
  values
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_source_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_url_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_ready_sha_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_window_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_watermark_contract', 'c'),
    ('stripe_live_billing_reconciliation_checkpoints', 'stripe_live_checkpoint_gap_contract', 'c'),
    ('studio_live_billing_authorizations', 'studio_live_billing_checkpoint_binding', 'c'),
    ('stripe_live_billing_reconciliation_account_evidence', 'primary:checkpoint_id,stripe_connected_account_id', 'p'),
    ('stripe_live_billing_reconciliation_account_evidence', 'unique:checkpoint_id,studio_id', 'u'),
    ('operational_alert_episodes', 'operational_alert_episode_ack_complete', 'c'),
    ('operational_alert_outbox', 'operational_alert_outbox_episode_event_role_key', 'u'),
    ('operational_alert_audit_events', 'operational_alert_audit_events_event_type_check', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_context_object', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_recovery_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_hash', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_response_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_pair', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivery_order', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_receipt_expiry', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_delivered_state', 'c'),
    ('stripe_connect_onboarding_bootstraps', 'stripe_connect_onboarding_bootstraps_terminal_state', 'c')
),
constraint_actual as (
  select relation.relname as table_name,
         case
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'p'
             then 'primary:' || columns.column_names
           when relation.relname = 'stripe_live_billing_reconciliation_account_evidence'
            and constraint_state.contype = 'u'
             then 'unique:' || columns.column_names
           else constraint_state.conname
         end as constraint_identity,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join lateral (
      select string_agg(attribute.attname, ',' order by key_position.ordinality) as column_names
        from unnest(constraint_state.conkey) with ordinality key_position(attnum, ordinality)
        join pg_attribute attribute
          on attribute.attrelid = constraint_state.conrelid
         and attribute.attnum = key_position.attnum
    ) columns on true
   where namespace.nspname = 'public'
),
constraint_compared as (
  select required.*,
         actual.constraint_type as actual_constraint_type,
         actual.convalidated, actual.definition_sha256
    from required_constraints required
    left join constraint_actual actual using (table_name, constraint_identity)
),
scoped_index_definitions as (
  select namespace.nspname as schema_name, table_relation.relname as table_name,
         index_relation.relname as index_name,
         encode(extensions.digest(convert_to(pg_get_indexdef(index_state.indexrelid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_index index_state
    join pg_class index_relation on index_relation.oid = index_state.indexrelid
    join pg_class table_relation on table_relation.oid = index_state.indrelid
    join pg_namespace namespace on namespace.oid = table_relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = table_relation.relname
),
scoped_constraint_definitions as (
  select namespace.nspname as schema_name, relation.relname as table_name,
         constraint_state.conname as constraint_name,
         constraint_state.contype::text as constraint_type,
         constraint_state.convalidated,
         encode(extensions.digest(convert_to(pg_get_constraintdef(constraint_state.oid), 'UTF8'), 'sha256'), 'hex') as definition_sha256
    from pg_constraint constraint_state
    join pg_class relation on relation.oid = constraint_state.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join scoped_definition_tables covered
      on covered.schema_name = namespace.nspname and covered.table_name = relation.relname
),
states as (
  select 'bootstrap_checks' as category, count(*)::integer as object_count,
         encode(
           extensions.digest(
             convert_to(count(*)::text, 'UTF8'),
             'sha256'
           ),
           'hex'
         ) as state_digest,
         (
           count(*) <> 23
           OR count(*) FILTER (WHERE NOT constraint_row.convalidated) <> 0
         )::integer as failures
    from pg_constraint constraint_row
   where constraint_row.conrelid =
         'public.stripe_connect_onboarding_bootstraps'::regclass
     and constraint_row.contype = 'c'
  union all
  select 'tables' as category, count(*)::integer as object_count,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || coalesce(owner_name, '') || ':' || coalesce(relrowsecurity::text, '') || ':' || coalesce(actual_service_privileges, '') || ':' || coalesce(acl_state, ''), '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex') as state_digest,
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or relrowsecurity is distinct from rls_enabled or public_access or anon_access or authenticated_access or actual_service_privileges is distinct from service_privileges)::integer as failures
    from table_compared
  union all
  select 'table_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || owner_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from table_acl_definitions
  union all
  select 'column_acls', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || attnum::text || ':' || column_name || ':' || acl_state, '|' order by schema_name collate "C", table_name collate "C", attnum), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from column_acl_definitions
  union all
  select 'policies', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || policy_name || ':' || coalesce(actual_permissive::text, '') || ':' || coalesce(actual_command_name, '') || ':' || coalesce(actual_role_names, '') || ':' || coalesce(actual_predicate_kind, ''), '|' order by table_name collate "C", policy_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not expected_policy or not actual_policy or actual_permissive is distinct from permissive or actual_command_name is distinct from command_name or actual_role_names is distinct from role_names or actual_predicate_kind is distinct from predicate_kind)::integer
    from policy_compared
  union all
  select 'functions', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(signature || ':' || coalesce(owner_name, '') || ':' || coalesce(language_name, '') || ':' || coalesce(actual_security_definer::text, '') || ':' || coalesce(actual_search_path_config, '') || ':' || coalesce(actual_service_execute::text, '') || ':' || coalesce(body_sha256, '') || ':' || coalesce(acl_state, ''), '|' order by signature collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or language_name not in ('sql', 'plpgsql') or actual_security_definer is distinct from security_definer or actual_search_path_config is distinct from search_path_config or public_execute or anon_execute or authenticated_execute or actual_service_execute is distinct from service_execute or unexpected_execute_grant)::integer
    from function_compared
  union all
  select 'triggers', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || trigger_name || ':' || coalesce(actual_function_schema, '') || '.' || coalesce(actual_function_name, '') || ':' || coalesce(actual_trigger_type::text, '') || ':' || coalesce(tgenabled::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", trigger_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_function_schema is distinct from function_schema or actual_function_name is distinct from function_name or actual_trigger_type is distinct from trigger_type or tgenabled is distinct from 'O' or tgisinternal is distinct from false)::integer
    from trigger_compared
  union all
  select 'indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(index_name || ':' || coalesce(actual_table_name, '') || ':' || coalesce(actual_unique_index::text, '') || ':' || coalesce(actual_partial_index::text, '') || ':' || coalesce(indisvalid::text, '') || ':' || coalesce(indisready::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_table_name is distinct from table_name or actual_unique_index is distinct from unique_index or actual_partial_index is distinct from partial_index or indisvalid is distinct from true or indisready is distinct from true)::integer
    from index_compared
  union all
  select 'sequences', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(owner_name, '') || ':' || coalesce(actual_service_usage::text, '') || ':' || coalesce(actual_service_select::text, '') || ':' || coalesce(actual_service_update::text, '') || ':' || coalesce(acl_state, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where owner_name is null or owner_name <> 'postgres' or public_access or anon_access or authenticated_access or actual_service_usage is distinct from service_usage or actual_service_select is distinct from service_select or actual_service_update is distinct from service_update)::integer
    from sequence_compared
  union all
  select 'columns', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || '.' || column_name || ':' || coalesce(actual_data_type, '') || ':' || coalesce(actual_nullable::text, '') || ':' || coalesce(actual_identity_column::text, ''), '|' order by table_name collate "C", column_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_data_type is distinct from data_type or actual_nullable is distinct from nullable or actual_identity_column is distinct from identity_column)::integer
    from column_compared
  union all
  select 'constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(table_name || ':' || constraint_identity || ':' || coalesce(actual_constraint_type, '') || ':' || coalesce(convalidated::text, '') || ':' || coalesce(definition_sha256, ''), '|' order by table_name collate "C", constraint_identity collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where actual_constraint_type is distinct from constraint_type or convalidated is distinct from true)::integer
    from constraint_compared
  union all
  select 'scoped_indexes', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || index_name || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", index_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         0::integer
    from scoped_index_definitions
  union all
  select 'scoped_constraints', count(*)::integer,
         encode(extensions.digest(convert_to(coalesce(string_agg(schema_name || '.' || table_name || ':' || constraint_name || ':' || constraint_type || ':' || convalidated::text || ':' || definition_sha256, '|' order by schema_name collate "C", table_name collate "C", constraint_name collate "C"), ''), 'UTF8'), 'sha256'), 'hex'),
         count(*) filter (where not convalidated)::integer
    from scoped_constraint_definitions
)
select COALESCE(sum(failures), 0)::TEXT || ':' ||
       encode(
           extensions.digest(
               convert_to(
                   string_agg(
                       category || '=' || object_count::TEXT || ':' ||
                       CASE
                           WHEN category = 'scoped_constraints'
                               THEN 'restore-normalized'
                           ELSE state_digest
                       END || ':' || failures::TEXT,
                       ';' ORDER BY category COLLATE "C"
                   ),
                   'UTF8'
               ),
               'sha256'
           ),
           'hex'
       )
  from states
$v7$;

ALTER FUNCTION private.koaryu_release_operational_contract_v25() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v25()
    FROM PUBLIC, anon, authenticated, service_role;



CREATE FUNCTION private.koaryu_release_live_billing_v3_manifest_v25()
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
          ),
          (
            'private.koaryu_release_operational_contract_v25()',
            false,
            'search_path=pg_catalog,TimeZone=UTC',
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

ALTER FUNCTION private.koaryu_release_live_billing_v3_manifest_v25()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION
    private.koaryu_release_live_billing_v3_manifest_v25()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v5()
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

    IF v_count <> 118
       OR v_head <> '20260826030234' THEN
        v_failures :=
            array_append(v_failures, 'migration_history_v25');
    END IF;

    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260826030234'
    ]::TEXT[] THEN
        v_failures :=
            array_append(v_failures, 'migration_history_sequence_v25');
    END IF;

    IF private.koaryu_release_operational_contract_v25()
       <> '0:a6142da2d83ec38483a696cecb4669d2ab8239314db4ca19308d4d619f729f32' THEN
        v_failures :=
            array_append(
                v_failures,
                'operational_semantic_acl_contract_v25'
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

    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:02e96ca8d2f4fe2117c2ab314fdab0ef079bac0a7c502c0cfcf2c3376529d620' THEN
        v_failures :=
            array_append(v_failures, 'critical_surface_manifest_v18');
    END IF;

    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:a873ce36f6623c9f574a0875bde6f887957bdbfdb4c8add796979b019f1a724a' THEN
        v_failures :=
            array_append(v_failures, 'live_billing_v3_manifest_v25');
    END IF;

    RETURN QUERY
    SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v25';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v5()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v5()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v5()
    TO service_role;

-- Preserve the deployed V24 backend during a database-first cutover. New
-- backends call V5; V4 returns its exact old shape only when V5 proves the
-- complete V25 state.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v4()
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
      FROM public.koaryu_release_schema_preflight_v5();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 118
       AND v_current.migration_head = '20260826030234'
       AND v_current.manifest_version = 'release-db-attestation-v25'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY
        SELECT
            true,
            117,
            '20260824190500'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957',
                '20260801060000','20260801070000','20260801080000',
                '20260801090000','20260801091000','20260801092000',
                '20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112',
                '20260801131844','20260814043325','20260814103046',
                '20260814105424','20260814114500','20260814152000',
                '20260814170000','20260814183000','20260814200000',
                '20260814213000','20260815220402','20260816012723',
                '20260820012533','20260820025759','20260820060216',
                '20260822193000','20260823193155','20260824190500'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v24'::TEXT;
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
            ARRAY['v25_compatibility_preflight']::TEXT[]
        ),
        'release-db-attestation-v24'::TEXT;
END;
$compatibility$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v4()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v4()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v4()
    TO service_role;

DO $diagnostics$
BEGIN
    RAISE NOTICE 'KOARYU_V25_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v25();
    RAISE NOTICE 'KOARYU_V25_CRITICAL_SURFACE_MANIFEST=%',
        private.koaryu_release_critical_surface_manifest_v18();
    RAISE NOTICE 'KOARYU_V25_LIVE_BILLING_MANIFEST=%',
        private.koaryu_release_live_billing_v3_manifest_v25();
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
