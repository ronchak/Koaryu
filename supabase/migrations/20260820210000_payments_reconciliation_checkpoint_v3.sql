-- Payments 1/6: replace the permanent provider-history boundary with a
-- retention-bounded, continuity-preserving schema-v3 checkpoint contract.
-- Historical migrations and v2 rows remain intact for audit. Current grants
-- and mutation authorization can bind only the v3 evidence recorded here.

DO $$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
      FROM public.koaryu_release_schema_preflight_v3();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count <> 111
       OR v_preflight.migration_head <> '20260816012723'
       OR v_preflight.manifest_version <> 'release-db-attestation-v18'
       OR cardinality(v_preflight.security_failures) <> 0
       OR private.koaryu_release_operational_manifest_v7()
            <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79'
       OR private.koaryu_release_starting_belt_manifest_v9()
            <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9'
       OR private.koaryu_release_student_rank_writer_manifest_v13()
            <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7'
       OR private.koaryu_release_critical_surface_manifest_v17()
            <> '0:05a77426d6e3e1864fe4d1a6beea708cc501b228e670a0309d1420808d2feab8' THEN
        RAISE EXCEPTION 'Payments v3 migration requires the exact V18 predecessor state.';
    END IF;
END
$$;

CREATE TABLE private.stripe_live_billing_reconciliation_v3_checkpoints (
    checkpoint_id UUID PRIMARY KEY
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id) ON DELETE CASCADE,
    evidence_contract_version INTEGER NOT NULL DEFAULT 3
        CHECK (evidence_contract_version = 3),
    continuity_mode TEXT NOT NULL CHECK (continuity_mode IN ('bootstrap', 'rolling')),
    previous_checkpoint_id UUID
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id) ON DELETE RESTRICT,
    event_window_started_at TIMESTAMPTZ NOT NULL,
    event_window_ended_at TIMESTAMPTZ NOT NULL,
    provider_retention_days INTEGER NOT NULL CHECK (provider_retention_days = 30),
    default_window_days INTEGER NOT NULL CHECK (default_window_days = 29),
    minimum_overlap_seconds INTEGER NOT NULL CHECK (minimum_overlap_seconds = 86400),
    overlap_seconds INTEGER CHECK (overlap_seconds IS NULL OR overlap_seconds >= 0),
    history_claim_started_at TIMESTAMPTZ NOT NULL,
    claims_history_before_window BOOLEAN NOT NULL CHECK (NOT claims_history_before_window),
    local_event_ingest_watermark BIGINT NOT NULL CHECK (local_event_ingest_watermark >= 0),
    previous_local_event_ingest_watermark BIGINT
        CHECK (previous_local_event_ingest_watermark IS NULL OR previous_local_event_ingest_watermark >= 0),
    wrong_mode_provider_event_count INTEGER NOT NULL CHECK (wrong_mode_provider_event_count >= 0),
    wrong_mode_local_event_count INTEGER NOT NULL CHECK (wrong_mode_local_event_count >= 0),
    not_processed_event_count INTEGER NOT NULL CHECK (not_processed_event_count >= 0),
    stale_generation_event_count INTEGER NOT NULL CHECK (stale_generation_event_count >= 0),
    platform_endpoint_url TEXT NOT NULL
        CHECK (platform_endpoint_url = 'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform'),
    connect_endpoint_url TEXT NOT NULL
        CHECK (connect_endpoint_url = 'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect'),
    webhook_livemode_matched BOOLEAN NOT NULL CHECK (webhook_livemode_matched),
    connect_surface_context_verified BOOLEAN NOT NULL CHECK (connect_surface_context_verified),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (event_window_ended_at >= event_window_started_at),
    CHECK (history_claim_started_at = event_window_started_at),
    CHECK (
        (continuity_mode = 'bootstrap'
            AND previous_checkpoint_id IS NULL
            AND previous_local_event_ingest_watermark IS NULL
            AND overlap_seconds IS NULL)
        OR
        (continuity_mode = 'rolling'
            AND previous_checkpoint_id IS NOT NULL
            AND previous_local_event_ingest_watermark IS NOT NULL
            AND overlap_seconds IS NOT NULL
            AND overlap_seconds >= minimum_overlap_seconds
            AND local_event_ingest_watermark >= previous_local_event_ingest_watermark)
    )
);

ALTER TABLE private.stripe_live_billing_reconciliation_v3_checkpoints OWNER TO postgres;
REVOKE ALL ON TABLE private.stripe_live_billing_reconciliation_v3_checkpoints
FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE private.koaryu_payments_v3_release_attestation (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    predecessor_operational_manifest TEXT NOT NULL,
    predecessor_critical_manifest TEXT NOT NULL,
    current_operational_manifest TEXT,
    current_critical_manifest TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE private.koaryu_payments_v3_release_attestation OWNER TO postgres;
REVOKE ALL ON TABLE private.koaryu_payments_v3_release_attestation
FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO private.koaryu_payments_v3_release_attestation (
    predecessor_operational_manifest,
    predecessor_critical_manifest
) VALUES (
    private.koaryu_release_operational_manifest_v7(),
    private.koaryu_release_critical_surface_manifest_v17()
);

CREATE FUNCTION private.live_billing_event_generation_matches_current(
    p_stripe_account_id TEXT,
    p_payload JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_generation_text TEXT;
    v_current_generation INTEGER;
BEGIN
    IF p_stripe_account_id IS NULL THEN
        RETURN true;
    END IF;
    SELECT private.current_connect_account_generation(account.metadata)
      INTO v_current_generation
      FROM public.studio_payment_accounts account
     WHERE account.stripe_connected_account_id = p_stripe_account_id;
    IF NOT FOUND THEN
        RETURN true;
    END IF;
    v_generation_text := COALESCE(
        p_payload #>> '{data,object,metadata,connect_account_generation}',
        p_payload #>> '{metadata,connect_account_generation}'
    );
    IF v_generation_text IS NULL OR v_generation_text = '' THEN
        RETURN true;
    END IF;
    IF v_generation_text !~ '^[1-9][0-9]*$'
       OR v_generation_text::NUMERIC > 2147483647 THEN
        RETURN false;
    END IF;
    RETURN v_current_generation IS NOT NULL
       AND v_current_generation = v_generation_text::INTEGER;
END;
$$;

ALTER FUNCTION private.live_billing_event_generation_matches_current(TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.live_billing_event_generation_matches_current(TEXT, JSONB)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.live_billing_v3_post_checkpoint_risk(
    p_local_event_ingest_watermark BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.stripe_events event
         WHERE event.live_billing_ingest_sequence > p_local_event_ingest_watermark
           AND (
               NOT event.livemode
               OR (
                   private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
                   AND event.processing_status IS DISTINCT FROM 'processed'
               )
               OR (
                   event.stripe_account_id IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.studio_payment_accounts mapped
                        WHERE mapped.stripe_connected_account_id = event.stripe_account_id
                   )
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.stripe_connect_account_dispositions disposition
                        WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                          AND disposition.excluded
                   )
               )
               OR NOT private.live_billing_event_generation_matches_current(
                   event.stripe_account_id,
                   event.payload
               )
           )
    )
$$;

ALTER FUNCTION private.live_billing_v3_post_checkpoint_risk(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.live_billing_v3_post_checkpoint_risk(BIGINT)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.read_stripe_live_billing_reconciliation_continuity_v3()
RETURNS TABLE(
    has_prior_checkpoint BOOLEAN,
    checkpoint_id UUID,
    evidence_contract_version INTEGER,
    candidate_sha TEXT,
    verified_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    event_window_started_at TIMESTAMPTZ,
    event_window_ended_at TIMESTAMPTZ,
    local_event_ingest_watermark BIGINT,
    continuity_mode TEXT,
    previous_checkpoint_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        latest.checkpoint_id IS NOT NULL,
        latest.checkpoint_id,
        latest.evidence_contract_version,
        latest.candidate_sha,
        latest.verified_at,
        latest.expires_at,
        latest.event_window_started_at,
        latest.event_window_ended_at,
        latest.local_event_ingest_watermark,
        latest.continuity_mode,
        latest.previous_checkpoint_id
      FROM (SELECT 1) anchor
      LEFT JOIN LATERAL (
          SELECT
              v3.checkpoint_id,
              v3.evidence_contract_version,
              checkpoint.candidate_sha,
              checkpoint.verified_at,
              checkpoint.expires_at,
              v3.event_window_started_at,
              v3.event_window_ended_at,
              v3.local_event_ingest_watermark,
              v3.continuity_mode,
              v3.previous_checkpoint_id
            FROM private.stripe_live_billing_reconciliation_v3_checkpoints v3
            JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
              ON checkpoint.id = v3.checkpoint_id
           ORDER BY checkpoint.verified_at DESC, checkpoint.checkpoint_sequence DESC
           LIMIT 1
      ) latest ON true
$$;

ALTER FUNCTION public.read_stripe_live_billing_reconciliation_continuity_v3() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_stripe_live_billing_reconciliation_continuity_v3()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_stripe_live_billing_reconciliation_continuity_v3()
TO service_role;

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
    v_window_start TIMESTAMPTZ := (p_report #>> '{event_window,started_at}')::TIMESTAMPTZ;
    v_window_end TIMESTAMPTZ := (p_report #>> '{event_window,ended_at}')::TIMESTAMPTZ;
    v_ready_verified_at TIMESTAMPTZ := (p_report #>> '{deployment_readiness,verified_at}')::TIMESTAMPTZ;
    v_platform_verified_at TIMESTAMPTZ := (p_report #>> '{platform_delivery,delivery_verified_at}')::TIMESTAMPTZ;
    v_watermark BIGINT := (p_report #>> '{events,local_event_ingest_watermark}')::BIGINT;
    v_current_watermark BIGINT;
    v_bounded_local_count INTEGER;
    v_wrong_mode_local_count INTEGER;
    v_not_processed_count INTEGER;
    v_failed_count INTEGER;
    v_stale_generation_count INTEGER;
    v_unmapped_event_count INTEGER;
    v_account JSONB;
    v_account_count INTEGER := 0;
    v_mapping public.studio_payment_accounts%ROWTYPE;
    v_continuity_mode TEXT := p_report #>> '{continuity,mode}';
    v_previous_checkpoint_id UUID := NULLIF(p_report #>> '{continuity,previous_checkpoint_id}', '')::UUID;
    v_previous_watermark BIGINT := NULLIF(p_report #>> '{continuity,previous_local_event_ingest_watermark}', '')::BIGINT;
    v_report_overlap_seconds INTEGER := NULLIF(p_report #>> '{continuity,overlap_seconds}', '')::INTEGER;
    v_latest_prior RECORD;
    v_overlap_seconds INTEGER;
BEGIN
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        private.stripe_live_billing_reconciliation_v3_checkpoints
        IN SHARE ROW EXCLUSIVE MODE;

    IF p_report IS NULL
       OR p_report->>'schema_version' <> '3'
       OR p_report->>'evidence_source' <> 'provider_read'
       OR p_report->>'probe' <> 'production'
       OR p_report->>'provider_mode' <> 'live'
       OR p_report->>'checkpoint_eligible' <> 'true'
       OR p_report #>> '{deployment_readiness,production_exact_candidate_verified}' <> 'true'
       OR p_report #>> '{continuity,eligible}' <> 'true'
       OR p_report #>> '{continuity,claims_history_before_window}' <> 'false'
       OR (p_report #>> '{continuity,history_claim_started_at}')::TIMESTAMPTZ
            IS DISTINCT FROM v_window_start
       OR (p_report #>> '{event_window,provider_retention_days}')::INTEGER <> 30
       OR (p_report #>> '{event_window,default_window_days}')::INTEGER <> 29
       OR (p_report #>> '{continuity,minimum_overlap_seconds}')::INTEGER <> 86400
       OR v_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_source_report_sha256 !~ '^[0-9a-f]{64}$'
       OR v_window_start IS NULL
       OR v_window_end IS NULL
       OR v_window_end < v_window_start
       OR v_window_start < v_now - INTERVAL '30 days'
       OR v_window_end < v_now - INTERVAL '15 minutes'
       OR v_window_end > v_now + INTERVAL '5 minutes'
       OR v_ready_verified_at IS NULL
       OR v_ready_verified_at < v_now - INTERVAL '15 minutes'
       OR v_ready_verified_at > v_now + INTERVAL '5 minutes'
       OR v_platform_verified_at IS NULL
       OR v_platform_verified_at < v_now - INTERVAL '24 hours'
       OR v_platform_verified_at > v_now + INTERVAL '5 minutes'
       OR v_watermark IS NULL
       OR v_watermark < 0
       OR p_expires_at IS NULL
       OR p_expires_at <= v_now
       OR p_expires_at > v_now + INTERVAL '24 hours' THEN
        RAISE EXCEPTION 'Only current source-attested schema-v3 production evidence may be checkpointed.'
            USING ERRCODE = 'P0B40';
    END IF;
    IF v_reason = '' OR char_length(v_reason) > 500 OR v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Reconciliation reason must be 1-500 characters without controls.'
            USING ERRCODE = '22023';
    END IF;
    IF p_actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_actor_id) THEN
        RAISE EXCEPTION 'Reconciliation actor must be a real Auth user.'
            USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(MAX(event.live_billing_ingest_sequence), 0)
      INTO v_current_watermark
      FROM public.stripe_events event;

    SELECT COUNT(*)
      INTO v_bounded_local_count
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND private.live_billing_event_is_in_scope(event.stripe_account_id, event.type);

    SELECT COUNT(*)
      INTO v_wrong_mode_local_count
      FROM public.stripe_events event
     WHERE NOT event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end;

    SELECT COUNT(*)
      INTO v_not_processed_count
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
       AND event.processing_status IS DISTINCT FROM 'processed';

    SELECT COUNT(*)
      INTO v_failed_count
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND event.processing_status = 'failed'
       AND NOT (
           event.stripe_account_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM public.studio_payment_accounts mapped
                WHERE mapped.stripe_connected_account_id = event.stripe_account_id
           )
           AND EXISTS (
               SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                  AND disposition.excluded
           )
       );

    SELECT COUNT(*)
      INTO v_unmapped_event_count
      FROM public.stripe_events event
     WHERE event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND event.stripe_account_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.studio_payment_accounts mapped
            WHERE mapped.stripe_connected_account_id = event.stripe_account_id
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_connect_account_dispositions disposition
            WHERE disposition.stripe_connected_account_id = event.stripe_account_id
              AND disposition.excluded
       );

    SELECT COUNT(*)
      INTO v_stale_generation_count
      FROM public.stripe_events event
     WHERE event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND NOT private.live_billing_event_generation_matches_current(
           event.stripe_account_id,
           event.payload
       );

    IF v_watermark IS DISTINCT FROM v_current_watermark
       OR (p_report #>> '{events,bounded_local_total}')::INTEGER <> v_bounded_local_count
       OR (p_report #>> '{events,provider_only_event_count}')::INTEGER <> 0
       OR (p_report #>> '{events,local_only_event_count}')::INTEGER <> 0
       OR (p_report #>> '{events,failed}')::INTEGER <> v_failed_count
       OR (p_report #>> '{events,not_processed}')::INTEGER <> v_not_processed_count
       OR (p_report #>> '{events,wrong_mode_provider}')::INTEGER <> 0
       OR (p_report #>> '{events,wrong_mode_local}')::INTEGER <> v_wrong_mode_local_count
       OR (p_report #>> '{events,stale_generation}')::INTEGER <> v_stale_generation_count
       OR v_failed_count <> 0
       OR v_not_processed_count <> 0
       OR v_wrong_mode_local_count <> 0
       OR v_stale_generation_count <> 0
       OR v_unmapped_event_count <> 0
       OR (p_report #>> '{counts,unresolved_accounts}')::INTEGER <> 0
       OR (p_report #>> '{counts,unresolved_event_accounts}')::INTEGER <> 0
       OR (p_report #>> '{webhook_delivery,expected_platform_url}')
            <> 'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform'
       OR (p_report #>> '{webhook_delivery,expected_connect_url}')
            <> 'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect'
       OR (p_report #>> '{webhook_delivery,enabled_platform_endpoint_count}')::INTEGER <> 1
       OR (p_report #>> '{webhook_delivery,enabled_connect_endpoint_count}')::INTEGER <> 1
       OR (p_report #>> '{webhook_delivery,duplicate_expected_endpoint_count}')::INTEGER <> 0
       OR (p_report #>> '{webhook_delivery,disabled_expected_endpoint_count}')::INTEGER <> 0
       OR (p_report #>> '{webhook_delivery,unexpected_enabled_endpoint_count}')::INTEGER <> 0
       OR (p_report #>> '{webhook_delivery,wrong_mode_endpoint_count}')::INTEGER <> 0
       OR p_report #>> '{webhook_delivery,platform_endpoint_contract_matched}' <> 'true'
       OR p_report #>> '{webhook_delivery,connect_endpoint_contract_matched}' <> 'true'
       OR p_report #>> '{webhook_delivery,connect_surface_context_verified}' <> 'true'
       OR (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER <= 0
       OR (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER
            <> (p_report #>> '{platform_delivery,local_event_count}')::INTEGER THEN
        RAISE EXCEPTION 'Schema-v3 reconciliation evidence is incomplete or stale.'
            USING ERRCODE = 'P0B41';
    END IF;

    SELECT
        v3.checkpoint_id,
        v3.event_window_started_at,
        v3.event_window_ended_at,
        v3.local_event_ingest_watermark,
        checkpoint.expires_at
      INTO v_latest_prior
      FROM private.stripe_live_billing_reconciliation_v3_checkpoints v3
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = v3.checkpoint_id
     ORDER BY checkpoint.verified_at DESC, checkpoint.checkpoint_sequence DESC
     LIMIT 1;

    IF NOT FOUND THEN
        IF v_continuity_mode <> 'bootstrap'
           OR v_previous_checkpoint_id IS NOT NULL
           OR v_previous_watermark IS NOT NULL
           OR v_report_overlap_seconds IS NOT NULL THEN
            RAISE EXCEPTION 'The first schema-v3 checkpoint must use the explicit bootstrap contract.'
                USING ERRCODE = 'P0B42';
        END IF;
    ELSE
        v_overlap_seconds := GREATEST(
            0,
            EXTRACT(EPOCH FROM (
                LEAST(v_window_end, v_latest_prior.event_window_ended_at)
                - GREATEST(v_window_start, v_latest_prior.event_window_started_at)
            ))::INTEGER
        );
        IF v_continuity_mode <> 'rolling'
           OR v_previous_checkpoint_id IS DISTINCT FROM v_latest_prior.checkpoint_id
           OR v_latest_prior.expires_at <= v_now
           OR v_previous_watermark IS DISTINCT FROM v_latest_prior.local_event_ingest_watermark
           OR v_watermark < v_latest_prior.local_event_ingest_watermark
           OR v_overlap_seconds < 86400
           OR v_report_overlap_seconds IS DISTINCT FROM v_overlap_seconds THEN
            RAISE EXCEPTION 'Schema-v3 checkpoint continuity is missing, expired, broken, or regressed.'
                USING ERRCODE = 'P0B43';
        END IF;
    END IF;

    IF jsonb_typeof(p_report->'account_evidence') <> 'array' THEN
        RAISE EXCEPTION 'Per-account reconciliation evidence is required.'
            USING ERRCODE = '22023';
    END IF;
    FOR v_account IN SELECT value FROM jsonb_array_elements(p_report->'account_evidence')
    LOOP
        SELECT * INTO v_mapping
          FROM public.studio_payment_accounts account
         WHERE account.studio_id = (v_account->>'studio_id')::UUID
           AND account.stripe_connected_account_id = v_account->>'stripe_connected_account_id';
        IF NOT FOUND
           OR private.current_connect_account_generation(v_mapping.metadata)
                IS DISTINCT FROM (v_account->>'connect_account_generation')::INTEGER
           OR (v_account->>'provider_event_count')::INTEGER <= 0
           OR (v_account->>'provider_event_count')::INTEGER
                <> (v_account->>'local_event_count')::INTEGER
           OR (v_account->>'provider_only_event_count')::INTEGER <> 0
           OR (v_account->>'local_only_event_count')::INTEGER <> 0
           OR (v_account->>'fresh') <> 'true'
           OR (v_account->>'delivery_verified_at')::TIMESTAMPTZ < v_now - INTERVAL '24 hours'
           OR (v_account->>'delivery_verified_at')::TIMESTAMPTZ > v_now + INTERVAL '5 minutes' THEN
            RAISE EXCEPTION 'Per-account schema-v3 delivery evidence is incomplete or stale.'
                USING ERRCODE = 'P0B44';
        END IF;
        v_account_count := v_account_count + 1;
    END LOOP;
    IF v_account_count <> (p_report #>> '{counts,mapped_accounts}')::INTEGER
       OR v_account_count <> (
           SELECT COUNT(*)
             FROM public.studio_payment_accounts account
            WHERE account.stripe_connected_account_id IS NOT NULL
       ) THEN
        RAISE EXCEPTION 'Every current Connect mapping requires generation-bound evidence.'
            USING ERRCODE = 'P0B44';
    END IF;

    INSERT INTO public.stripe_live_billing_reconciliation_checkpoints (
        stripe_livemode, candidate_sha, provider_account_count, mapped_account_count,
        excluded_account_count, unresolved_account_count, event_count_since_cutoff,
        failed_event_count, latest_event_created_at, webhook_delivery_verified_at,
        enabled_platform_endpoint_count, enabled_connect_endpoint_count,
        platform_endpoint_contract_matched, connect_endpoint_contract_matched,
        verified_at, expires_at, source_report_sha256, reason, verified_by,
        verified_by_email, evidence_source, deployment_ready_url,
        deployment_ready_sha, deployment_ready_verified_at, event_window_started_at,
        event_window_ended_at, local_event_ingest_watermark,
        bounded_provider_event_count, bounded_local_event_count,
        provider_only_event_count, local_only_event_count,
        platform_provider_event_count, platform_local_event_count,
        platform_delivery_verified_at, unexpected_enabled_endpoint_count,
        account_evidence_count
    ) VALUES (
        true, v_candidate_sha,
        (p_report #>> '{counts,provider_accounts}')::INTEGER,
        (p_report #>> '{counts,mapped_accounts}')::INTEGER,
        (p_report #>> '{counts,excluded_accounts}')::INTEGER,
        0,
        (p_report #>> '{events,bounded_local_total}')::INTEGER,
        0,
        (p_report #>> '{events,latest_created_at}')::TIMESTAMPTZ,
        v_platform_verified_at,
        1, 1, true, true, v_now, p_expires_at, p_source_report_sha256,
        v_reason, p_actor_id, NULLIF(BTRIM(COALESCE(p_actor_email, '')), ''),
        'provider_read', 'https://koaryu.onrender.com/health/ready',
        v_candidate_sha, v_ready_verified_at,
        NULL, NULL, NULL,
        (p_report #>> '{events,bounded_provider_total}')::INTEGER,
        (p_report #>> '{events,bounded_local_total}')::INTEGER,
        0, 0,
        (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER,
        (p_report #>> '{platform_delivery,local_event_count}')::INTEGER,
        v_platform_verified_at, 0, v_account_count
    ) RETURNING * INTO v_checkpoint;

    INSERT INTO private.stripe_live_billing_reconciliation_v3_checkpoints (
        checkpoint_id, continuity_mode, previous_checkpoint_id,
        event_window_started_at, event_window_ended_at,
        provider_retention_days, default_window_days, minimum_overlap_seconds,
        overlap_seconds, history_claim_started_at, claims_history_before_window,
        local_event_ingest_watermark, previous_local_event_ingest_watermark,
        wrong_mode_provider_event_count, wrong_mode_local_event_count,
        not_processed_event_count, stale_generation_event_count,
        platform_endpoint_url, connect_endpoint_url,
        webhook_livemode_matched, connect_surface_context_verified
    ) VALUES (
        v_checkpoint.id, v_continuity_mode, v_previous_checkpoint_id,
        v_window_start, v_window_end,
        30, 29, 86400,
        v_report_overlap_seconds, v_window_start, false,
        v_watermark, v_previous_watermark,
        0, 0, 0, 0,
        'https://koaryu.onrender.com/api/v1/webhooks/stripe/platform',
        'https://koaryu.onrender.com/api/v1/webhooks/stripe/connect',
        true, true
    );

    INSERT INTO public.stripe_live_billing_reconciliation_account_evidence (
        checkpoint_id, studio_id, stripe_connected_account_id,
        connect_account_generation, provider_event_count, local_event_count,
        provider_only_event_count, local_only_event_count, delivery_verified_at
    )
    SELECT
        v_checkpoint.id,
        (value->>'studio_id')::UUID,
        value->>'stripe_connected_account_id',
        (value->>'connect_account_generation')::INTEGER,
        (value->>'provider_event_count')::INTEGER,
        (value->>'local_event_count')::INTEGER,
        0, 0,
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

-- Existing grants are deliberately closed. Provenance remains, and a later
-- operator must re-grant against a v3 checkpoint.
UPDATE public.studio_live_billing_authorizations
   SET enabled = false,
       expires_at = NULL,
       revoked_at = COALESCE(revoked_at, now()),
       revoke_reason = COALESCE(revoke_reason, 'Reauthorization required after reconciliation contract v3')
 WHERE enabled;

CREATE OR REPLACE FUNCTION private.bind_live_billing_authorization_checkpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
    v_v3 private.stripe_live_billing_reconciliation_v3_checkpoints%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_generation INTEGER;
    v_current_watermark BIGINT;
BEGIN
    IF NOT NEW.enabled THEN
        RETURN NEW;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        private.stripe_live_billing_reconciliation_v3_checkpoints
        IN SHARE MODE;

    SELECT checkpoint.*, v3.*
      INTO v_checkpoint, v_v3
      FROM public.stripe_live_billing_reconciliation_checkpoints checkpoint
      JOIN private.stripe_live_billing_reconciliation_v3_checkpoints v3
        ON v3.checkpoint_id = checkpoint.id
     WHERE checkpoint.stripe_livemode
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url = 'https://koaryu.onrender.com/health/ready'
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
       AND v3.evidence_contract_version = 3
       AND NOT v3.claims_history_before_window
       AND v3.webhook_livemode_matched
       AND v3.connect_surface_context_verified
       AND v3.wrong_mode_provider_event_count = 0
       AND v3.wrong_mode_local_event_count = 0
       AND v3.not_processed_event_count = 0
       AND v3.stale_generation_event_count = 0
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
                     AND evidence.stripe_connected_account_id = mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation
                          = private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
     ORDER BY checkpoint.verified_at DESC, checkpoint.checkpoint_sequence DESC
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Current schema-v3 production reconciliation is required.'
            USING ERRCODE = 'P0B45';
    END IF;

    SELECT COALESCE(MAX(event.live_billing_ingest_sequence), 0)
      INTO v_current_watermark
      FROM public.stripe_events event;
    IF v_current_watermark < v_v3.local_event_ingest_watermark
       OR private.live_billing_v3_post_checkpoint_risk(v_v3.local_event_ingest_watermark) THEN
        RAISE EXCEPTION 'Current event state has drifted beyond the schema-v3 checkpoint.'
            USING ERRCODE = 'P0B46';
    END IF;

    IF NEW.scope LIKE 'connect_%' THEN
        SELECT * INTO v_account
          FROM public.studio_payment_accounts account
         WHERE account.studio_id = NEW.studio_id;
        v_generation := private.current_connect_account_generation(v_account.metadata);
        IF NOT FOUND OR v_generation IS NULL
           OR v_generation IS DISTINCT FROM NEW.connect_account_generation THEN
            RAISE EXCEPTION 'Current Connect account generation does not match authorization.'
                USING ERRCODE = 'P0B47';
        END IF;
        IF v_account.stripe_connected_account_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
              FROM public.stripe_live_billing_reconciliation_account_evidence evidence
             WHERE evidence.checkpoint_id = v_checkpoint.id
               AND evidence.studio_id = NEW.studio_id
               AND evidence.stripe_connected_account_id = v_account.stripe_connected_account_id
               AND evidence.connect_account_generation = v_generation
               AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
        ) THEN
            RAISE EXCEPTION 'Current Connect account lacks fresh generation-bound v3 evidence.'
                USING ERRCODE = 'P0B48';
        END IF;
    END IF;

    NEW.reconciliation_checkpoint_id := v_checkpoint.id;
    NEW.local_event_ingest_watermark := v_v3.local_event_ingest_watermark;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.bind_live_billing_authorization_checkpoint() OWNER TO postgres;
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
       OR p_scope NOT IN ('core_subscription', 'connect_onboarding', 'connect_payments')
       OR NOT (
            (p_scope = 'core_subscription' AND p_operation = ANY (ARRAY[
                'customer.create', 'core_checkout_session.create',
                'customer_portal_session.create'
            ]::TEXT[]))
            OR (p_scope = 'connect_onboarding' AND p_operation = ANY (ARRAY[
                'connect_account.create', 'connect_account.branding.update',
                'connect_branding_file.create', 'connect_onboarding_link.create',
                'connect_dashboard_login_link.create'
            ]::TEXT[]))
            OR (p_scope = 'connect_payments' AND p_operation = ANY (ARRAY[
                'connected_customer.create', 'connected_customer.update',
                'connected_customer.default_payment_method.update',
                'connected_product.create', 'connected_product.update',
                'connected_price.create', 'connected_setup_checkout_session.create',
                'connected_subscription.create', 'connected_subscription_item.create',
                'connected_subscription_item.update', 'connected_subscription_item.delete',
                'connected_subscription.update', 'connected_subscription.cancel',
                'connected_invoice_item.create', 'connected_invoice.create',
                'connected_invoice.finalize', 'connected_invoice.send',
                'connected_invoice.pay', 'connected_invoice.void',
                'connected_refund.create', 'connected_capability.readiness'
            ]::TEXT[]))
       ) THEN
        RETURN;
    END IF;

    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        private.stripe_live_billing_reconciliation_v3_checkpoints,
        public.studio_live_billing_authorizations
        IN SHARE MODE;

    RETURN QUERY
    SELECT true, authz.studio_id, checkpoint.id
      FROM public.studio_live_billing_authorizations authz
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      JOIN private.stripe_live_billing_reconciliation_v3_checkpoints v3
        ON v3.checkpoint_id = checkpoint.id
      LEFT JOIN public.studio_payment_accounts account
        ON account.studio_id = authz.studio_id
     WHERE authz.studio_id = p_studio_id
       AND authz.scope = p_scope
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.local_event_ingest_watermark = v3.local_event_ingest_watermark
       AND checkpoint.stripe_livemode
       AND checkpoint.candidate_sha = p_candidate_sha
       AND checkpoint.deployment_ready_sha = p_candidate_sha
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url = 'https://koaryu.onrender.com/health/ready'
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
       AND v3.evidence_contract_version = 3
       AND NOT v3.claims_history_before_window
       AND v3.webhook_livemode_matched
       AND v3.connect_surface_context_verified
       AND v3.wrong_mode_provider_event_count = 0
       AND v3.wrong_mode_local_event_count = 0
       AND v3.not_processed_event_count = 0
       AND v3.stale_generation_event_count = 0
       AND (SELECT COALESCE(MAX(event.live_billing_ingest_sequence), 0)
              FROM public.stripe_events event) >= v3.local_event_ingest_watermark
       AND NOT private.live_billing_v3_post_checkpoint_risk(v3.local_event_ingest_watermark)
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
                     AND evidence.stripe_connected_account_id = mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation
                          = private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
       AND (
           (p_scope = 'core_subscription'
                AND authz.stripe_connected_account_id IS NULL
                AND p_stripe_connected_account_id IS NULL)
           OR
           (p_scope = 'connect_onboarding'
                AND account.studio_id = p_studio_id
                AND authz.connect_account_generation
                    = private.current_connect_account_generation(account.metadata)
                AND (
                    (p_operation = 'connect_account.create'
                        AND p_stripe_connected_account_id IS NULL
                        AND account.stripe_connected_account_id IS NULL
                        AND authz.stripe_connected_account_id IS NULL)
                    OR
                    (p_operation = 'connect_branding_file.create'
                        AND p_stripe_connected_account_id IS NULL)
                    OR
                    (p_operation NOT IN ('connect_account.create', 'connect_branding_file.create')
                        AND p_stripe_connected_account_id IS NOT NULL
                        AND account.stripe_connected_account_id = p_stripe_connected_account_id
                        AND (authz.stripe_connected_account_id IS NULL
                            OR authz.stripe_connected_account_id = p_stripe_connected_account_id)
                        AND EXISTS (
                            SELECT 1
                              FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                             WHERE evidence.checkpoint_id = checkpoint.id
                               AND evidence.studio_id = p_studio_id
                               AND evidence.stripe_connected_account_id = p_stripe_connected_account_id
                               AND evidence.connect_account_generation
                                    = private.current_connect_account_generation(account.metadata)
                               AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
                        ))
                ))
           OR
           (p_scope = 'connect_payments'
                AND p_stripe_connected_account_id IS NOT NULL
                AND authz.stripe_connected_account_id = p_stripe_connected_account_id
                AND authz.connect_account_generation
                    = private.current_connect_account_generation(account.metadata)
                AND account.stripe_connected_account_id = p_stripe_connected_account_id
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
                       AND evidence.stripe_connected_account_id = p_stripe_connected_account_id
                       AND evidence.connect_account_generation
                            = private.current_connect_account_generation(account.metadata)
                       AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
                ))
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
      JOIN private.stripe_live_billing_reconciliation_v3_checkpoints v3
        ON v3.checkpoint_id = checkpoint.id
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
       AND account.stripe_connected_account_id = bootstrap.stripe_connected_account_id
       AND private.current_connect_account_generation(account.metadata)
            = bootstrap.connect_account_generation
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.connect_account_generation = bootstrap.connect_account_generation
       AND (authz.stripe_connected_account_id IS NULL
            OR authz.stripe_connected_account_id = bootstrap.stripe_connected_account_id)
       AND authz.local_event_ingest_watermark = v3.local_event_ingest_watermark
       AND checkpoint.stripe_livemode
       AND checkpoint.candidate_sha = p_candidate_sha
       AND checkpoint.deployment_ready_sha = p_candidate_sha
       AND checkpoint.evidence_source = 'provider_read'
       AND checkpoint.deployment_ready_url = 'https://koaryu.onrender.com/health/ready'
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
       AND v3.evidence_contract_version = 3
       AND NOT v3.claims_history_before_window
       AND v3.webhook_livemode_matched
       AND v3.connect_surface_context_verified
       AND v3.wrong_mode_provider_event_count = 0
       AND v3.wrong_mode_local_event_count = 0
       AND v3.not_processed_event_count = 0
       AND v3.stale_generation_event_count = 0
       AND NOT private.live_billing_v3_post_checkpoint_risk(v3.local_event_ingest_watermark)
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
                  AND mapped.stripe_connected_account_id = bootstrap.stripe_connected_account_id
                  AND private.current_connect_account_generation(mapped.metadata)
                        = bootstrap.connect_account_generation
              )
              AND NOT EXISTS (
                  SELECT 1
                    FROM public.stripe_live_billing_reconciliation_account_evidence evidence
                   WHERE evidence.checkpoint_id = checkpoint.id
                     AND evidence.studio_id = mapped.studio_id
                     AND evidence.stripe_connected_account_id = mapped.stripe_connected_account_id
                     AND evidence.connect_account_generation
                          = private.current_connect_account_generation(mapped.metadata)
                     AND evidence.delivery_verified_at >= now() - INTERVAL '24 hours'
              )
       )
     LIMIT 1
$$;

ALTER FUNCTION private.connect_onboarding_bootstrap_link_checkpoint(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.connect_onboarding_bootstrap_link_checkpoint(UUID, TEXT)
FROM PUBLIC, anon, authenticated, service_role;

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
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_attestation RECORD;
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
      INTO v_count, v_head, v_pending
      FROM supabase_migrations.schema_migrations;

    IF v_count <> 112 OR v_head <> '20260820210000' THEN
        v_failures := array_append(v_failures, 'migration_history_v19');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820210000'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v19');
    END IF;

    SELECT * INTO v_attestation
      FROM private.koaryu_payments_v3_release_attestation
     WHERE singleton;
    IF NOT FOUND
       OR v_attestation.predecessor_operational_manifest
            <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79'
       OR v_attestation.predecessor_critical_manifest
            <> '0:05a77426d6e3e1864fe4d1a6beea708cc501b228e670a0309d1420808d2feab8'
       OR v_attestation.current_operational_manifest IS NULL
       OR v_attestation.current_critical_manifest IS NULL
       OR private.koaryu_release_operational_manifest_v7()
            IS DISTINCT FROM v_attestation.current_operational_manifest
       OR private.koaryu_release_critical_surface_manifest_v17()
            IS DISTINCT FROM v_attestation.current_critical_manifest THEN
        v_failures := array_append(v_failures, 'payments_v3_chained_release_attestation');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;

    IF to_regclass('private.stripe_live_billing_reconciliation_v3_checkpoints') IS NULL
       OR to_regprocedure('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)') IS NULL
       OR to_regprocedure('public.read_stripe_live_billing_reconciliation_continuity_v3()') IS NULL
       OR to_regprocedure('private.live_billing_event_generation_matches_current(text,jsonb)') IS NULL
       OR to_regprocedure('private.live_billing_v3_post_checkpoint_risk(bigint)') IS NULL
       OR NOT has_function_privilege(
           'service_role',
           'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)',
           'EXECUTE'
       )
       OR NOT has_function_privilege(
           'service_role',
           'public.read_stripe_live_billing_reconciliation_continuity_v3()',
           'EXECUTE'
       )
       OR has_function_privilege(
           'anon',
           'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)',
           'EXECUTE'
       )
       OR has_function_privilege(
           'authenticated',
           'public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)',
           'EXECUTE'
       )
       OR has_table_privilege(
           'service_role',
           'private.stripe_live_billing_reconciliation_v3_checkpoints',
           'SELECT,INSERT,UPDATE,DELETE'
       ) THEN
        v_failures := array_append(v_failures, 'payments_reconciliation_checkpoint_v3');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v19';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v3() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v3()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v3()
TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
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
AS $$
DECLARE
    v_current RECORD;
BEGIN
    SELECT * INTO v_current
      FROM public.koaryu_release_schema_preflight_v3();
    IF v_current.ready IS TRUE
       AND v_current.migration_count = 112
       AND v_current.migration_head = '20260820210000'
       AND v_current.manifest_version = 'release-db-attestation-v19'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY SELECT
            true,
            100,
            '20260801131844'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957','20260801060000',
                '20260801070000','20260801080000','20260801090000','20260801091000',
                '20260801092000','20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112','20260801131844'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v7'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT
        false,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY['v19_compatibility_preflight']::TEXT[]),
        'release-db-attestation-v7'::TEXT;
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
TO service_role;

UPDATE private.koaryu_payments_v3_release_attestation
   SET current_operational_manifest = private.koaryu_release_operational_manifest_v7(),
       current_critical_manifest = private.koaryu_release_critical_surface_manifest_v17()
 WHERE singleton;

COMMENT ON TABLE private.stripe_live_billing_reconciliation_v3_checkpoints IS
    'Provider-retention-bounded schema-v3 continuity evidence. Direct API roles have no access.';
COMMENT ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v3(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) IS
    'Records exact-candidate, rolling-window live reconciliation evidence after independently rechecking local continuity and event state.';
