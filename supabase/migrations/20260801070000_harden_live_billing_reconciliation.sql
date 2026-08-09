-- Reserved Owner 3 remediation slot. Additive hardening for live Stripe
-- reconciliation evidence and atomic mutation authorization.

ALTER TABLE public.stripe_events
    ADD COLUMN live_billing_ingest_sequence BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX idx_stripe_events_live_billing_ingest_sequence
    ON public.stripe_events(live_billing_ingest_sequence);

ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints
    ADD COLUMN evidence_source TEXT,
    ADD COLUMN deployment_ready_url TEXT,
    ADD COLUMN deployment_ready_sha TEXT,
    ADD COLUMN deployment_ready_verified_at TIMESTAMPTZ,
    ADD COLUMN event_window_started_at TIMESTAMPTZ,
    ADD COLUMN event_window_ended_at TIMESTAMPTZ,
    ADD COLUMN local_event_ingest_watermark BIGINT,
    ADD COLUMN bounded_provider_event_count INTEGER,
    ADD COLUMN bounded_local_event_count INTEGER,
    ADD COLUMN provider_only_event_count INTEGER,
    ADD COLUMN local_only_event_count INTEGER,
    ADD COLUMN platform_provider_event_count INTEGER,
    ADD COLUMN platform_local_event_count INTEGER,
    ADD COLUMN platform_delivery_verified_at TIMESTAMPTZ,
    ADD COLUMN unexpected_enabled_endpoint_count INTEGER,
    ADD COLUMN account_evidence_count INTEGER;

ALTER TABLE public.stripe_live_billing_reconciliation_checkpoints
    ADD CONSTRAINT stripe_live_checkpoint_source_contract CHECK (
        evidence_source IS NULL OR evidence_source = 'provider_read'
    ),
    ADD CONSTRAINT stripe_live_checkpoint_ready_url_contract CHECK (
        deployment_ready_url IS NULL
        OR deployment_ready_url = 'https://koaryu.onrender.com/health/ready'
    ),
    ADD CONSTRAINT stripe_live_checkpoint_ready_sha_contract CHECK (
        deployment_ready_sha IS NULL OR deployment_ready_sha ~ '^[0-9a-f]{40}$'
    ),
    ADD CONSTRAINT stripe_live_checkpoint_window_contract CHECK (
        event_window_started_at IS NULL
        OR (
            event_window_started_at = TIMESTAMPTZ '2026-07-13 00:00:00+00'
            AND event_window_ended_at IS NOT NULL
            AND event_window_ended_at >= event_window_started_at
        )
    ),
    ADD CONSTRAINT stripe_live_checkpoint_watermark_contract CHECK (
        local_event_ingest_watermark IS NULL OR local_event_ingest_watermark >= 0
    ),
    ADD CONSTRAINT stripe_live_checkpoint_gap_contract CHECK (
        provider_only_event_count IS NULL
        OR (
            bounded_provider_event_count >= 0
            AND bounded_local_event_count >= 0
            AND provider_only_event_count >= 0
            AND local_only_event_count >= 0
            AND platform_provider_event_count >= 0
            AND platform_local_event_count >= 0
            AND unexpected_enabled_endpoint_count >= 0
            AND account_evidence_count >= 0
        )
    );

CREATE TABLE public.stripe_live_billing_reconciliation_account_evidence (
    checkpoint_id UUID NOT NULL
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id) ON DELETE CASCADE,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE RESTRICT,
    stripe_connected_account_id TEXT NOT NULL
        CHECK (stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$'),
    connect_account_generation INTEGER NOT NULL CHECK (connect_account_generation > 0),
    provider_event_count INTEGER NOT NULL CHECK (provider_event_count > 0),
    local_event_count INTEGER NOT NULL CHECK (local_event_count > 0),
    provider_only_event_count INTEGER NOT NULL CHECK (provider_only_event_count >= 0),
    local_only_event_count INTEGER NOT NULL CHECK (local_only_event_count >= 0),
    delivery_verified_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (checkpoint_id, stripe_connected_account_id),
    UNIQUE (checkpoint_id, studio_id),
    CHECK (provider_event_count = local_event_count),
    CHECK (provider_only_event_count = 0 AND local_only_event_count = 0)
);

ALTER TABLE public.stripe_live_billing_reconciliation_account_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_live_billing_account_evidence_no_client_access
    ON public.stripe_live_billing_reconciliation_account_evidence
    AS RESTRICTIVE
    FOR ALL
    TO anon, authenticated
    USING (false)
    WITH CHECK (false);

CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.stripe_live_billing_reconciliation_account_evidence
    AS RESTRICTIVE
    FOR ALL
    TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

REVOKE ALL ON TABLE public.stripe_live_billing_reconciliation_account_evidence
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.stripe_live_billing_reconciliation_account_evidence
    TO service_role;

ALTER TABLE public.studio_live_billing_authorizations
    ADD COLUMN reconciliation_checkpoint_id UUID
        REFERENCES public.stripe_live_billing_reconciliation_checkpoints(id) ON DELETE RESTRICT,
    ADD COLUMN local_event_ingest_watermark BIGINT;

-- Any scope enabled before this stronger checkpoint contract must be
-- deliberately re-granted. Provenance remains intact; the row is not deleted.
UPDATE public.studio_live_billing_authorizations
   SET enabled = false,
       expires_at = NULL,
       revoked_at = COALESCE(revoked_at, now()),
       revoke_reason = COALESCE(revoke_reason, 'Reauthorization required after reconciliation hardening')
 WHERE enabled;

ALTER TABLE public.studio_live_billing_authorizations
    ADD CONSTRAINT studio_live_billing_checkpoint_binding CHECK (
        NOT enabled
        OR (
            reconciliation_checkpoint_id IS NOT NULL
            AND local_event_ingest_watermark IS NOT NULL
            AND local_event_ingest_watermark >= 0
        )
    );

CREATE OR REPLACE FUNCTION private.current_connect_account_generation(p_metadata JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_value TEXT := p_metadata->>'connect_account_generation';
BEGIN
    IF v_value IS NULL OR v_value = '' THEN
        RETURN 1;
    END IF;
    IF v_value !~ '^[1-9][0-9]*$' OR v_value::NUMERIC > 2147483647 THEN
        RETURN NULL;
    END IF;
    RETURN v_value::INTEGER;
END;
$$;

REVOKE ALL ON FUNCTION private.current_connect_account_generation(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.current_connect_account_generation(JSONB)
    TO service_role;

-- The legacy aggregate writer cannot produce source-attested per-account
-- evidence. Retain it for migration history, but remove its callable grant.
REVOKE ALL ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint(
    TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN, BOOLEAN,
    TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v2(
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
    v_watermark BIGINT := (p_report #>> '{events_since_2026_07_13,local_event_ingest_watermark}')::BIGINT;
    v_current_watermark BIGINT;
    v_bounded_local_count INTEGER;
    v_account JSONB;
    v_account_count INTEGER := 0;
    v_mapping public.studio_payment_accounts%ROWTYPE;
BEGIN
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence
        IN SHARE ROW EXCLUSIVE MODE;

    IF p_report IS NULL
       OR p_report->>'schema_version' <> '2'
       OR p_report->>'evidence_source' <> 'provider_read'
       OR p_report->>'probe' <> 'production'
       OR p_report->>'provider_mode' <> 'live'
       OR p_report->>'checkpoint_eligible' <> 'true'
       OR p_report #>> '{deployment_readiness,production_exact_candidate_verified}' <> 'true'
       OR v_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_source_report_sha256 !~ '^[0-9a-f]{64}$'
       OR v_window_start IS DISTINCT FROM TIMESTAMPTZ '2026-07-13 00:00:00+00'
       OR v_window_end IS NULL
       OR v_window_end < v_window_start
       OR v_window_end > v_now + INTERVAL '5 minutes'
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
        RAISE EXCEPTION 'Only current source-attested production evidence may be checkpointed.'
            USING ERRCODE = 'P0B10';
    END IF;
    IF v_reason = '' OR char_length(v_reason) > 500 OR v_reason ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'Reconciliation reason must be 1-500 characters without controls.'
            USING ERRCODE = '22023';
    END IF;
    IF p_actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_actor_id) THEN
        RAISE EXCEPTION 'Reconciliation actor must be a real Auth user.'
            USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(MAX(event.live_billing_ingest_sequence), 0), COUNT(*)
      INTO v_current_watermark, v_bounded_local_count
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end
       AND (
            (event.stripe_account_id IS NULL AND event.type = ANY (ARRAY[
                'checkout.session.completed', 'customer.subscription.created',
                'customer.subscription.updated', 'customer.subscription.deleted',
                'invoice.paid', 'invoice.payment_failed'
            ]::TEXT[]))
            OR
            (event.stripe_account_id IS NOT NULL AND event.type = ANY (ARRAY[
                'account.updated', 'account.application.deauthorized',
                'checkout.session.completed', 'invoice.created', 'invoice.finalized',
                'invoice.paid', 'invoice.payment_failed', 'invoice.voided',
                'invoice.marked_uncollectible', 'payment_intent.processing',
                'payment_intent.succeeded', 'payment_intent.payment_failed',
                'charge.refunded', 'charge.refund.updated', 'refund.created',
                'refund.failed', 'refund.updated', 'charge.dispute.created',
                'charge.dispute.updated', 'charge.dispute.closed',
                'customer.subscription.created', 'customer.subscription.updated',
                'customer.subscription.deleted'
            ]::TEXT[]))
       );

    -- The watermark covers every live event in the bounded window, including
    -- types outside the reviewed equality universe.
    SELECT COALESCE(MAX(event.live_billing_ingest_sequence), 0)
      INTO v_current_watermark
      FROM public.stripe_events event
     WHERE event.livemode
       AND event.created_at >= v_window_start
       AND event.created_at <= v_window_end;

    IF v_watermark IS DISTINCT FROM v_current_watermark
       OR (p_report #>> '{events_since_2026_07_13,bounded_local_total}')::INTEGER <> v_bounded_local_count
       OR (p_report #>> '{events_since_2026_07_13,provider_only_event_count}')::INTEGER <> 0
       OR (p_report #>> '{events_since_2026_07_13,local_only_event_count}')::INTEGER <> 0
       OR (p_report #>> '{events_since_2026_07_13,failed}')::INTEGER <> 0
       OR (p_report #>> '{counts,unresolved_accounts}')::INTEGER <> 0
       OR (p_report #>> '{counts,unresolved_event_accounts}')::INTEGER <> 0
       OR (p_report #>> '{webhook_delivery,enabled_platform_endpoint_count}')::INTEGER <> 1
       OR (p_report #>> '{webhook_delivery,enabled_connect_endpoint_count}')::INTEGER <> 1
       OR (p_report #>> '{webhook_delivery,unexpected_enabled_endpoint_count}')::INTEGER <> 0
       OR p_report #>> '{webhook_delivery,platform_endpoint_contract_matched}' <> 'true'
       OR p_report #>> '{webhook_delivery,connect_endpoint_contract_matched}' <> 'true'
       OR (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER <= 0
       OR (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER
            <> (p_report #>> '{platform_delivery,local_event_count}')::INTEGER THEN
        RAISE EXCEPTION 'Reconciliation evidence is incomplete or stale.'
            USING ERRCODE = 'P0B11';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
           AND event.processing_status = 'failed'
    ) OR EXISTS (
        SELECT 1 FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
           AND event.stripe_account_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM public.studio_payment_accounts account
                WHERE account.stripe_connected_account_id = event.stripe_account_id
           )
           AND NOT EXISTS (
               SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                  AND disposition.excluded
           )
    ) THEN
        RAISE EXCEPTION 'Current failed or unmapped live event state blocks checkpointing.'
            USING ERRCODE = 'P0B12';
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
            RAISE EXCEPTION 'Per-account delivery evidence is incomplete or stale.'
                USING ERRCODE = 'P0B13';
        END IF;
        v_account_count := v_account_count + 1;
    END LOOP;
    IF v_account_count <> (p_report #>> '{counts,mapped_accounts}')::INTEGER THEN
        RAISE EXCEPTION 'Per-account evidence count does not match mapped accounts.'
            USING ERRCODE = 'P0B13';
    END IF;
    IF v_account_count <> (
        SELECT COUNT(*)
          FROM public.studio_payment_accounts account
         WHERE account.stripe_connected_account_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Every current Connect mapping requires generation-bound evidence.'
            USING ERRCODE = 'P0B13';
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
        (p_report #>> '{events_since_2026_07_13,bounded_local_total}')::INTEGER,
        0,
        (p_report #>> '{events_since_2026_07_13,latest_created_at}')::TIMESTAMPTZ,
        v_platform_verified_at,
        1, 1, true, true, v_now, p_expires_at, p_source_report_sha256,
        v_reason, p_actor_id, NULLIF(BTRIM(COALESCE(p_actor_email, '')), ''),
        'provider_read', 'https://koaryu.onrender.com/health/ready',
        v_candidate_sha, v_ready_verified_at, v_window_start, v_window_end,
        v_watermark,
        (p_report #>> '{events_since_2026_07_13,bounded_provider_total}')::INTEGER,
        (p_report #>> '{events_since_2026_07_13,bounded_local_total}')::INTEGER,
        0, 0,
        (p_report #>> '{platform_delivery,provider_event_count}')::INTEGER,
        (p_report #>> '{platform_delivery,local_event_count}')::INTEGER,
        v_platform_verified_at, 0, v_account_count
    ) RETURNING * INTO v_checkpoint;

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

REVOKE ALL ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v2(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_stripe_live_billing_reconciliation_checkpoint_v2(
    JSONB, TIMESTAMPTZ, TEXT, TEXT, UUID, TEXT
) TO service_role;

CREATE FUNCTION private.bind_live_billing_authorization_checkpoint()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_checkpoint public.stripe_live_billing_reconciliation_checkpoints%ROWTYPE;
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
        public.stripe_live_billing_reconciliation_account_evidence
        IN SHARE MODE;

    SELECT * INTO v_checkpoint
      FROM public.stripe_live_billing_reconciliation_checkpoints checkpoint
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
        RAISE EXCEPTION 'Current source-attested production reconciliation is required.'
            USING ERRCODE = 'P0B14';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
           AND event.processing_status = 'failed'
    ) OR EXISTS (
        SELECT 1 FROM public.stripe_events event
         WHERE event.livemode
           AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
           AND event.stripe_account_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM public.studio_payment_accounts account
                WHERE account.stripe_connected_account_id = event.stripe_account_id
           )
           AND NOT EXISTS (
               SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                  AND disposition.excluded
           )
    ) THEN
        RAISE EXCEPTION 'Current failed or unmapped live events block authorization.'
            USING ERRCODE = 'P0B15';
    END IF;

    IF NEW.scope LIKE 'connect_%' THEN
        SELECT * INTO v_account
          FROM public.studio_payment_accounts account
         WHERE account.studio_id = NEW.studio_id;
        v_generation := private.current_connect_account_generation(v_account.metadata);
        IF NOT FOUND OR v_generation IS NULL
           OR v_generation IS DISTINCT FROM NEW.connect_account_generation THEN
            RAISE EXCEPTION 'Current Connect account generation does not match authorization.'
                USING ERRCODE = 'P0B16';
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
            RAISE EXCEPTION 'Current Connect account lacks fresh generation-bound evidence.'
                USING ERRCODE = 'P0B17';
        END IF;
    END IF;

    NEW.reconciliation_checkpoint_id := v_checkpoint.id;
    NEW.local_event_ingest_watermark := v_checkpoint.local_event_ingest_watermark;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.bind_live_billing_authorization_checkpoint()
    FROM PUBLIC, anon, authenticated;

CREATE TRIGGER bind_live_billing_authorization_checkpoint
    BEFORE INSERT OR UPDATE OF enabled, expires_at, stripe_connected_account_id,
        connect_account_generation
    ON public.studio_live_billing_authorizations
    FOR EACH ROW
    EXECUTE FUNCTION private.bind_live_billing_authorization_checkpoint();

CREATE FUNCTION public.authorize_studio_live_billing_mutation_atomic(
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
        public.studio_live_billing_authorizations
        IN SHARE MODE;

    RETURN QUERY
    SELECT true, authz.studio_id, checkpoint.id
      FROM public.studio_live_billing_authorizations authz
      JOIN public.stripe_live_billing_reconciliation_checkpoints checkpoint
        ON checkpoint.id = authz.reconciliation_checkpoint_id
      LEFT JOIN public.studio_payment_accounts account
        ON account.studio_id = authz.studio_id
     WHERE authz.studio_id = p_studio_id
       AND authz.scope = p_scope
       AND authz.enabled
       AND authz.expires_at > now()
       AND authz.local_event_ingest_watermark = checkpoint.local_event_ingest_watermark
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
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND event.processing_status = 'failed'
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.created_at >= TIMESTAMPTZ '2026-07-13 00:00:00+00'
              AND event.stripe_account_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM public.studio_payment_accounts mapped
                   WHERE mapped.stripe_connected_account_id = event.stripe_account_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                   WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                     AND disposition.excluded
              )
       )
       AND NOT EXISTS (
           SELECT 1 FROM public.stripe_events event
            WHERE event.livemode
              AND event.live_billing_ingest_sequence > authz.local_event_ingest_watermark
              AND (
                  event.processing_status = 'failed'
                  OR (
                      event.stripe_account_id IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM public.studio_payment_accounts mapped
                           WHERE mapped.stripe_connected_account_id = event.stripe_account_id
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                           WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                             AND disposition.excluded
                      )
                  )
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

REVOKE ALL ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON TABLE public.stripe_live_billing_reconciliation_account_evidence IS
    'Sanitized, generation-bound provider/local delivery proof for one checkpoint and mapped Connect account.';
COMMENT ON FUNCTION public.authorize_studio_live_billing_mutation_atomic(UUID, TEXT, TEXT, TEXT, TEXT) IS
    'Derives live mutation eligibility from locked current database state; caller eligibility booleans are never accepted.';
