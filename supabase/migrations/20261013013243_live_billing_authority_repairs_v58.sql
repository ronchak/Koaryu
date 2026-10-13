-- Require the exact ready V57 predecessor before changing live authority.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to((SELECT prosrc FROM pg_catalog.pg_proc
        WHERE oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v38()')),
        'UTF8'),'sha256'),'hex') IS DISTINCT FROM '31014bfd35c507749621643cf4279479054d4fcb6ed79e7c60f3a2a612774542' THEN
        RAISE EXCEPTION 'V58 requires the reviewed V57 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v38();
    IF v.ready IS DISTINCT FROM true OR v.migration_count IS DISTINCT FROM 152
       OR v.migration_head IS DISTINCT FROM '20261005105341'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v57'
       OR v.security_failures IS DISTINCT FROM ARRAY[]::TEXT[]
       OR v.pending_versions IS DISTINCT FROM ARRAY['20260727100000','20260727110000','20260801050957','20260801060000','20260801070000','20260801080000','20260801090000','20260801091000','20260801092000','20260801093000','20260801094000','20260801105313','20260801112153','20260801115044','20260801123112','20260801131844','20260814043325','20260814103046','20260814105424','20260814114500','20260814152000','20260814170000','20260814183000','20260814200000','20260814213000','20260815220402','20260816012723','20260820012533','20260820025759','20260820060216','20260822193000','20260823193155','20260824190500','20260825042838','20260825043911','20260826030234','20260826030249','20260826051527','20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435','20261005105341']::TEXT[] THEN
        RAISE EXCEPTION 'V58 requires the exact verified V57 predecessor.';
    END IF;
END;
$predecessor$;

-- V58 makes supported Connect workflows available to every eligible studio.
-- Checkpoint/grant rows remain diagnostic history. NULL bootstrap checkpoint
-- provenance identifies a new GA request; legacy requests are never converted.

ALTER TABLE public.stripe_connect_onboarding_bootstraps
    ALTER COLUMN reconciliation_checkpoint_id DROP NOT NULL;
COMMENT ON COLUMN public.stripe_connect_onboarding_bootstraps.reconciliation_checkpoint_id IS
    'Historical pilot checkpoint; NULL identifies a GA bootstrap. Existing non-null requests cannot resume under GA.';

CREATE FUNCTION private.live_billing_ga_operations_v58(p_scope TEXT)
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE p_scope
        WHEN 'connect_onboarding' THEN ARRAY[
            'connect_account.create', 'connect_dashboard_login_link.create',
            'connect_onboarding_link.create'
        ]::TEXT[]
        WHEN 'connect_payments' THEN ARRAY[
            'connected_capability.readiness',
            'connected_customer.create', 'connected_customer.update',
            'connected_invoice.create', 'connected_invoice.finalize',
            'connected_invoice.pay', 'connected_invoice.send', 'connected_invoice.void',
            'connected_invoice_item.create', 'connected_price.create',
            'connected_product.create', 'connected_product.update',
            'connected_refund.create', 'connected_setup_checkout_session.create',
            'connected_subscription.cancel', 'connected_subscription.create',
            'connected_subscription.update', 'connected_subscription_item.create',
            'connected_subscription_item.delete', 'connected_subscription_item.update',
            'connected_subscription_schedule.create', 'connected_subscription_schedule.release',
            'connected_subscription_schedule.update'
        ]::TEXT[]
        ELSE ARRAY[]::TEXT[]
    END;
$$;
REVOKE ALL ON FUNCTION private.live_billing_ga_operations_v58(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- Callers lock events, mappings and dispositions before reading this predicate.
-- A mapped account takes precedence over an excluded disposition in the existing
-- in-scope helper. Even excluded failed events remain conservatively blocking.
CREATE FUNCTION private.live_billing_ga_events_clear_v58()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM public.stripe_events event
        WHERE event.livemode AND (
            event.processing_status = 'failed'
            OR (private.live_billing_event_is_in_scope(event.stripe_account_id, event.type)
                AND event.processing_status IS DISTINCT FROM 'processed')
            OR (event.stripe_account_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM public.studio_payment_accounts mapped
                    WHERE mapped.stripe_connected_account_id = event.stripe_account_id
                )
                AND NOT EXISTS (
                    SELECT 1 FROM public.stripe_connect_account_dispositions disposition
                    WHERE disposition.stripe_connected_account_id = event.stripe_account_id
                      AND disposition.excluded
                ))
        )
    );
$$;
REVOKE ALL ON FUNCTION private.live_billing_ga_events_clear_v58()
    FROM PUBLIC, anon, authenticated, service_role;

-- Retire an unused Connect identity together with its local reset. Table fences
-- cover inserts as well as updates; NOWAIT avoids waiting behind resource-first
-- provider claims while holding the account fence. The caller can retry from a
-- fresh account read. No provider request is made by this transaction.
CREATE FUNCTION public.reset_stripe_connect_account_atomic_v58(
    p_studio_id UUID, p_actor_id UUID,
    p_expected_stripe_connected_account_id TEXT, p_expected_connect_account_generation INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_retiring_id TEXT;
    v_generation INTEGER;
    v_previous JSONB;
BEGIN
    -- Match the GA event/mapping/disposition order. Subsequent fences never wait:
    -- claims may already own a payer/plan/operation row before touching an account.
    LOCK TABLE public.stripe_events IN SHARE MODE NOWAIT;
    LOCK TABLE public.studio_payment_accounts,
        public.stripe_connect_account_dispositions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    LOCK TABLE public.billing_plans, public.billing_payers, public.billing_subscriptions,
        public.billing_invoices, public.billing_payments, public.billing_refunds,
        public.billing_disputes, public.billing_provider_operations,
        auth.users, public.staff_roles IN SHARE MODE NOWAIT;

    IF p_actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id=p_actor_id)
       OR NOT EXISTS (SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
           AND user_id=p_actor_id AND role='admin' AND archived_at IS NULL) THEN
        RETURN jsonb_build_object('outcome','actor_denied');
    END IF;
    SELECT * INTO v_account FROM public.studio_payment_accounts
        WHERE studio_id=p_studio_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found'); END IF;
    v_retiring_id := v_account.stripe_connected_account_id;
    v_generation := private.current_connect_account_generation(v_account.metadata);
    IF v_retiring_id IS DISTINCT FROM p_expected_stripe_connected_account_id
       OR v_generation IS DISTINCT FROM p_expected_connect_account_generation THEN
        RETURN jsonb_build_object('outcome','stale_account');
    END IF;
    IF v_retiring_id IS NULL THEN
        RETURN jsonb_build_object('outcome','no_change','account',to_jsonb(v_account));
    END IF;
    IF EXISTS (SELECT 1 FROM public.billing_plans WHERE studio_id=p_studio_id AND stripe_price_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.billing_payers WHERE studio_id=p_studio_id AND stripe_customer_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.billing_subscriptions WHERE studio_id=p_studio_id AND stripe_subscription_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.billing_invoices WHERE studio_id=p_studio_id AND stripe_invoice_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.billing_payments WHERE studio_id=p_studio_id AND stripe_payment_intent_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.billing_refunds WHERE studio_id=p_studio_id AND stripe_refund_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM public.billing_disputes WHERE studio_id=p_studio_id AND stripe_dispute_id IS NOT NULL) THEN
        RETURN jsonb_build_object('outcome','billing_history');
    END IF;
    IF EXISTS (SELECT 1 FROM public.billing_provider_operations
        WHERE (studio_id=p_studio_id OR stripe_connected_account_id=v_retiring_id)
          AND state NOT IN ('completed','definitive_failed','definitive_rejected')) THEN
        RETURN jsonb_build_object('outcome','provider_operation_pending');
    END IF;
    IF EXISTS (SELECT 1 FROM public.stripe_events event
        WHERE event.livemode AND event.stripe_account_id=v_retiring_id
          AND (event.processing_status='failed'
            OR (private.live_billing_event_is_in_scope(event.stripe_account_id,event.type)
                AND event.processing_status IS DISTINCT FROM 'processed'))) THEN
        RETURN jsonb_build_object('outcome','event_pending');
    END IF;

    v_previous := COALESCE(v_account.metadata->'previous_stripe_connected_account_ids','[]'::JSONB);
    IF jsonb_typeof(v_previous) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid previous Connect account metadata.';
    END IF;
    IF NOT v_previous @> jsonb_build_array(v_retiring_id) THEN
        v_previous := v_previous || jsonb_build_array(v_retiring_id);
    END IF;
    UPDATE public.studio_payment_accounts SET
        stripe_connected_account_id=NULL, status='not_connected', charges_enabled=false,
        payouts_enabled=false, details_submitted=false, requirements_due=ARRAY[]::TEXT[],
        metadata=COALESCE(v_account.metadata,'{}'::JSONB) || jsonb_build_object(
            'previous_stripe_connected_account_ids',v_previous,
            'connect_account_generation',v_generation+1)
        WHERE studio_id=p_studio_id RETURNING * INTO v_account;
    -- The mapping trigger releases this identity before the exclusion trigger
    -- claims it. Both changes and the audit commit together or all roll back.
    PERFORM public.set_stripe_connect_account_exclusion_atomic(
        v_retiring_id,true,'Retired unused Connect account by studio reset',p_actor_id,NULL);
    INSERT INTO public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
        VALUES(p_studio_id,p_actor_id,'billing.connect_account_reset','billing',p_studio_id,
            jsonb_build_object('previous_stripe_account_id',v_retiring_id));
    RETURN jsonb_build_object('outcome','reset','account',to_jsonb(v_account));
END;
$$;
REVOKE ALL ON FUNCTION public.reset_stripe_connect_account_atomic_v58(UUID,UUID,TEXT,INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_stripe_connect_account_atomic_v58(UUID,UUID,TEXT,INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.authorize_studio_live_billing_mutation_atomic(
    p_studio_id UUID, p_operation TEXT, p_scope TEXT,
    p_stripe_connected_account_id TEXT, p_candidate_sha TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_studio_id IS NULL OR p_candidate_sha IS NULL
       OR p_candidate_sha !~ '^[0-9a-f]{40}$' THEN
        RETURN;
    END IF;
    -- Core retains its existing exact grant and checkpoint policy. Core's
    -- self-checkout permit is separately owned by the application policy.
    IF p_scope = 'core_subscription' THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.studio_live_billing_authorizations authz
            WHERE authz.studio_id = p_studio_id AND authz.scope = p_scope
              AND authz.enabled
              AND private.live_billing_operation_set_is_canonical_v1(authz.scope, authz.allowed_operations)
              AND p_operation = ANY(authz.allowed_operations)
        ) THEN RETURN; END IF;
        RETURN QUERY SELECT * FROM public.authorize_studio_live_billing_scope_v3(
            p_studio_id, p_operation, p_scope, p_stripe_connected_account_id, p_candidate_sha
        );
        RETURN;
    END IF;
    IF (p_operation = ANY(private.live_billing_ga_operations_v58(p_scope))) IS DISTINCT FROM true THEN
        RETURN;
    END IF;
    LOCK TABLE public.stripe_events, public.studio_payment_accounts,
        public.stripe_connect_account_dispositions, public.stripe_connect_onboarding_bootstraps,
        public.studios IN SHARE MODE;
    IF NOT private.live_billing_ga_events_clear_v58() THEN RETURN; END IF;
    RETURN QUERY
    SELECT true, account.studio_id, NULL::UUID
    FROM public.studio_payment_accounts account
    JOIN public.studios studio ON studio.id = account.studio_id
    WHERE account.studio_id = p_studio_id AND (
        (p_scope = 'connect_onboarding' AND (
            (p_operation = 'connect_account.create'
                AND p_stripe_connected_account_id IS NULL
                AND account.stripe_connected_account_id IS NULL)
            OR (p_operation IN ('connect_onboarding_link.create', 'connect_dashboard_login_link.create')
                AND p_stripe_connected_account_id IS NOT NULL
                AND account.stripe_connected_account_id = p_stripe_connected_account_id
                AND (p_operation = 'connect_dashboard_login_link.create' OR NOT EXISTS (
                    SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
                    WHERE bootstrap.studio_id = account.studio_id
                      AND bootstrap.connect_account_generation = private.current_connect_account_generation(account.metadata)
                      AND bootstrap.initial_link_delivered_at IS NULL
                )))
        ))
        OR (p_scope = 'connect_payments'
            AND p_stripe_connected_account_id IS NOT NULL
            AND account.stripe_connected_account_id = p_stripe_connected_account_id
            AND account.status = 'charges_enabled' AND account.charges_enabled
            AND account.payouts_enabled AND account.details_submitted
            AND cardinality(account.requirements_due) = 0)
    );
END;
$$;

-- Catalog capability hints only. Every provider mutation still obtains a fresh
-- exact permit from the atomic authority, including current event/account state.
CREATE FUNCTION public.studio_live_billing_supported_operations_v58(
    p_studio_id UUID, p_candidate_sha TEXT
)
RETURNS TABLE(scope TEXT, allowed_operations TEXT[])
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_studio_id IS NULL OR p_candidate_sha IS NULL
       OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR NOT EXISTS (SELECT 1 FROM public.studios s WHERE s.id = p_studio_id) THEN RETURN; END IF;
    RETURN QUERY
    SELECT supported.scope, private.live_billing_ga_operations_v58(supported.scope)
    FROM (VALUES ('connect_onboarding'::TEXT), ('connect_payments'::TEXT)) supported(scope);
    RETURN QUERY
    SELECT authz.scope, authz.allowed_operations
    FROM public.studio_live_billing_authorizations authz
    WHERE authz.studio_id = p_studio_id AND authz.scope = 'core_subscription'
      AND authz.enabled
      AND private.live_billing_operation_set_is_canonical_v1(authz.scope, authz.allowed_operations);
END;
$$;
REVOKE ALL ON FUNCTION public.studio_live_billing_supported_operations_v58(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.studio_live_billing_supported_operations_v58(UUID, TEXT) TO service_role;

CREATE FUNCTION private.connect_onboarding_ga_initial_link_eligible_v58(
    p_bootstrap_id UUID, p_candidate_sha TEXT
)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
        JOIN public.studio_payment_accounts account ON account.studio_id = bootstrap.studio_id
        JOIN public.studios studio ON studio.id = account.studio_id
        WHERE bootstrap.id = p_bootstrap_id
          AND p_candidate_sha IS NOT NULL AND p_candidate_sha ~ '^[0-9a-f]{40}$'
          AND bootstrap.candidate_sha = p_candidate_sha
          AND bootstrap.reconciliation_checkpoint_id IS NULL
          AND bootstrap.recovery_context IS NOT NULL AND bootstrap.recovery_expires_at > now()
          AND bootstrap.aborted_at IS NULL AND bootstrap.stripe_livemode
          AND bootstrap.initial_link_delivered_at IS NULL
          AND bootstrap.initial_link_support_required_at IS NULL
          AND (bootstrap.initial_link_delivery_receipt_expires_at IS NULL
               OR bootstrap.initial_link_delivery_receipt_expires_at > now())
          AND bootstrap.account_bound_at IS NOT NULL
          AND bootstrap.stripe_connected_account_id = account.stripe_connected_account_id
          AND bootstrap.connect_account_generation = private.current_connect_account_generation(account.metadata)
          AND 'connect_onboarding_link.create' = ANY(private.live_billing_ga_operations_v58('connect_onboarding'))
          AND private.live_billing_ga_events_clear_v58()
    );
$$;
REVOKE ALL ON FUNCTION private.connect_onboarding_ga_initial_link_eligible_v58(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;


CREATE OR REPLACE FUNCTION public.preflight_connect_onboarding_bootstrap_begin(
    p_studio_id UUID,
    p_candidate_sha TEXT
)
RETURNS TABLE(eligible BOOLEAN, studio_id UUID, connect_account_generation INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_authorization RECORD;
BEGIN
    IF p_studio_id IS NULL OR p_candidate_sha IS NULL OR p_candidate_sha !~ '^[0-9a-f]{40}$' THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER;
        RETURN;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE MODE;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id;
    IF NOT FOUND OR v_account.stripe_connected_account_id IS NOT NULL THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER;
        RETURN;
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.stripe_connect_onboarding_bootstraps bootstrap
         WHERE bootstrap.studio_id = p_studio_id
           AND bootstrap.connect_account_generation
                = private.current_connect_account_generation(v_account.metadata)
    ) THEN
        RETURN QUERY SELECT false, p_studio_id,
            private.current_connect_account_generation(v_account.metadata);
        RETURN;
    END IF;
    SELECT * INTO v_authorization
      FROM public.authorize_studio_live_billing_mutation_atomic(
          p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
      );
    RETURN QUERY SELECT FOUND, p_studio_id,
        private.current_connect_account_generation(v_account.metadata);
END;
$$;

CREATE OR REPLACE FUNCTION public.preflight_connect_onboarding_bootstrap_resume(
    p_studio_id UUID,
    p_candidate_sha TEXT
)
RETURNS TABLE(
    eligible BOOLEAN,
    studio_id UUID,
    connect_account_generation INTEGER,
    phase TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_authorization RECORD;
    v_eligible BOOLEAN;
    v_generation INTEGER;
BEGIN
    IF p_studio_id IS NULL OR p_candidate_sha IS NULL OR p_candidate_sha !~ '^[0-9a-f]{40}$' THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER, 'support_required'::TEXT;
        RETURN;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE MODE;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, p_studio_id, NULL::INTEGER, 'support_required'::TEXT;
        RETURN;
    END IF;
    v_generation := private.current_connect_account_generation(v_account.metadata);
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = v_generation;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, p_studio_id, v_generation, 'none'::TEXT;
        RETURN;
    END IF;

    -- Delivery retires only this generation's bootstrap. It intentionally does
    -- not assert that Stripe consumed the link or that onboarding is complete.
    IF v_bootstrap.initial_link_delivered_at IS NOT NULL THEN
        IF v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id = v_bootstrap.stripe_connected_account_id THEN
            RETURN QUERY SELECT false, p_studio_id, v_generation, 'completed'::TEXT;
        ELSE
            RETURN QUERY SELECT false, p_studio_id, v_generation, 'support_required'::TEXT;
        END IF;
        RETURN;
    END IF;

    IF v_bootstrap.reconciliation_checkpoint_id IS NOT NULL
       OR NOT v_bootstrap.stripe_livemode
       OR v_bootstrap.initial_link_support_required_at IS NOT NULL
       OR v_bootstrap.candidate_sha <> p_candidate_sha
       OR v_bootstrap.recovery_context IS NULL
       OR v_bootstrap.recovery_expires_at <= now()
       OR v_bootstrap.aborted_at IS NOT NULL
       OR (v_bootstrap.stripe_connected_account_id IS NULL
           AND v_account.stripe_connected_account_id IS NOT NULL)
       OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id IS DISTINCT FROM v_bootstrap.stripe_connected_account_id)
       OR (v_bootstrap.initial_link_response_recorded_at IS NOT NULL
           AND v_bootstrap.initial_link_delivery_receipt_expires_at <= now()) THEN
        RETURN QUERY SELECT false, p_studio_id, v_generation, 'support_required'::TEXT;
        RETURN;
    END IF;
    IF v_bootstrap.stripe_connected_account_id IS NULL THEN
        SELECT * INTO v_authorization
          FROM public.authorize_studio_live_billing_mutation_atomic(
              p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
          );
        RETURN QUERY SELECT FOUND, p_studio_id, v_generation, 'account_create'::TEXT;
        RETURN;
    END IF;
    v_eligible := private.connect_onboarding_ga_initial_link_eligible_v58(v_bootstrap.id, p_candidate_sha);
    IF v_eligible IS DISTINCT FROM true AND v_bootstrap.initial_link_claimed_at IS NOT NULL THEN
        RETURN QUERY SELECT false, p_studio_id, v_generation, 'support_required'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT
        v_eligible IS TRUE,
        p_studio_id,
        v_generation,
        CASE
            WHEN v_bootstrap.initial_link_claimed_at IS NULL THEN 'initial_link'
            WHEN v_bootstrap.initial_link_response_recorded_at IS NULL THEN 'initial_link_retry'
            ELSE 'initial_link_delivery_pending'
        END;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_connect_onboarding_bootstrap_atomic(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_recovery_context JSONB,
    p_account_create_payload_sha256 TEXT,
    p_initial_link_context_sha256 TEXT,
    p_account_create_idempotency_key TEXT,
    p_initial_link_idempotency_key TEXT
)
RETURNS TABLE(
    bootstrap_id UUID,
    studio_id UUID,
    connect_account_generation INTEGER,
    recovery_context JSONB,
    account_create_idempotency_key TEXT,
    initial_link_idempotency_key TEXT,
    stripe_connected_account_id TEXT,
    phase TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_account public.studio_payment_accounts%ROWTYPE;
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_authorization RECORD;
    v_recovery_expires_at TIMESTAMPTZ;
BEGIN
    IF p_studio_id IS NULL
       OR p_candidate_sha IS NULL OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_connect_account_generation <= 0
       OR jsonb_typeof(p_recovery_context) <> 'object'
       OR NOT (p_recovery_context ?& ARRAY[
           'business_name', 'contact_email', 'business_entity_type', 'refresh_url', 'return_url'
       ])
       OR EXISTS (
           SELECT 1
             FROM jsonb_object_keys(p_recovery_context) key
            WHERE key <> ALL (ARRAY[
                'business_name', 'contact_email', 'business_entity_type', 'refresh_url', 'return_url'
            ]::TEXT[])
       )
       OR jsonb_typeof(p_recovery_context -> 'business_name') <> 'string'
       OR p_recovery_context ->> 'business_name' = ''
       OR (jsonb_typeof(p_recovery_context -> 'contact_email') NOT IN ('string', 'null'))
       OR p_recovery_context ->> 'business_entity_type' NOT IN ('company', 'individual')
       OR jsonb_typeof(p_recovery_context -> 'refresh_url') <> 'string'
       OR jsonb_typeof(p_recovery_context -> 'return_url') <> 'string'
       OR p_recovery_context ->> 'refresh_url' = ''
       OR p_recovery_context ->> 'return_url' = ''
       OR p_account_create_payload_sha256 !~ '^[0-9a-f]{64}$'
       OR p_initial_link_context_sha256 !~ '^[0-9a-f]{64}$'
       OR p_account_create_idempotency_key !~ '^koaryu-connect-account-[0-9a-f-]+-g[1-9][0-9]*$'
       OR p_initial_link_idempotency_key !~ '^koaryu-connect-onboarding-[0-9a-f-]+-g[1-9][0-9]*-[0-9a-f]{24}$' THEN
        RETURN;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id
       AND private.current_connect_account_generation(account.metadata)
            = p_connect_account_generation;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation;
    IF FOUND THEN
        IF v_bootstrap.reconciliation_checkpoint_id IS NOT NULL
           OR NOT v_bootstrap.stripe_livemode
           OR v_bootstrap.initial_link_delivered_at IS NOT NULL
           OR v_bootstrap.initial_link_support_required_at IS NOT NULL
           OR (v_bootstrap.initial_link_delivery_receipt_expires_at IS NOT NULL
               AND v_bootstrap.initial_link_delivery_receipt_expires_at <= now())
           OR v_bootstrap.candidate_sha IS DISTINCT FROM p_candidate_sha
           OR v_bootstrap.recovery_context IS DISTINCT FROM p_recovery_context
           OR v_bootstrap.account_create_payload_sha256 <> p_account_create_payload_sha256
           OR v_bootstrap.initial_link_context_sha256 <> p_initial_link_context_sha256
           OR v_bootstrap.account_create_idempotency_key <> p_account_create_idempotency_key
           OR v_bootstrap.initial_link_idempotency_key <> p_initial_link_idempotency_key
           OR v_bootstrap.recovery_expires_at <= now()
           OR v_bootstrap.aborted_at IS NOT NULL
           OR (v_bootstrap.stripe_connected_account_id IS NULL
               AND v_account.stripe_connected_account_id IS NOT NULL)
           OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
               AND v_account.stripe_connected_account_id IS DISTINCT FROM v_bootstrap.stripe_connected_account_id) THEN
            RETURN;
        END IF;
    ELSE
        IF v_account.stripe_connected_account_id IS NOT NULL THEN
            RETURN;
        END IF;
        SELECT * INTO v_authorization
          FROM public.authorize_studio_live_billing_mutation_atomic(
              p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
          );
        IF NOT FOUND THEN
            RETURN;
        END IF;
        v_recovery_expires_at := now() + INTERVAL '24 hours';
        INSERT INTO public.stripe_connect_onboarding_bootstraps(
            studio_id, connect_account_generation, bootstrap_token_sha256,
            account_create_payload_sha256, initial_link_context_sha256,
            account_create_idempotency_key, initial_link_idempotency_key,
            candidate_sha, reconciliation_checkpoint_id, stripe_livemode,
            expires_at, recovery_context, recovery_expires_at
        ) VALUES (
            p_studio_id, p_connect_account_generation,
            encode(extensions.digest(convert_to(extensions.gen_random_uuid()::TEXT || clock_timestamp()::TEXT, 'UTF8'), 'sha256'), 'hex'),
            p_account_create_payload_sha256, p_initial_link_context_sha256,
            p_account_create_idempotency_key, p_initial_link_idempotency_key,
            p_candidate_sha, NULL, true,
            now() + INTERVAL '5 minutes', p_recovery_context, v_recovery_expires_at
        ) RETURNING * INTO v_bootstrap;
    END IF;
    RETURN QUERY SELECT
        v_bootstrap.id, v_bootstrap.studio_id, v_bootstrap.connect_account_generation,
        v_bootstrap.recovery_context, v_bootstrap.account_create_idempotency_key,
        v_bootstrap.initial_link_idempotency_key, v_bootstrap.stripe_connected_account_id,
        CASE
            WHEN v_bootstrap.stripe_connected_account_id IS NULL THEN 'account_create'
            WHEN v_bootstrap.initial_link_claimed_at IS NULL THEN 'initial_link'
            ELSE 'initial_link_retry'
        END;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_connect_onboarding_bootstrap_recovery_context(
    p_studio_id UUID,
    p_candidate_sha TEXT
)
RETURNS TABLE(
    bootstrap_id UUID,
    studio_id UUID,
    connect_account_generation INTEGER,
    recovery_context JSONB,
    account_create_idempotency_key TEXT,
    initial_link_idempotency_key TEXT,
    stripe_connected_account_id TEXT,
    phase TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
      FROM public.preflight_connect_onboarding_bootstrap_resume(p_studio_id, p_candidate_sha);
    IF NOT FOUND OR NOT v_preflight.eligible THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT bootstrap.id, bootstrap.studio_id, bootstrap.connect_account_generation,
           bootstrap.recovery_context, bootstrap.account_create_idempotency_key,
           bootstrap.initial_link_idempotency_key, bootstrap.stripe_connected_account_id,
           v_preflight.phase
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = v_preflight.connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_connect_onboarding_bootstrap_account_create_v2(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_account_create_payload_sha256 TEXT,
    p_account_create_idempotency_key TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_authorization RECORD;
BEGIN
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.account_create_payload_sha256 = p_account_create_payload_sha256
       AND bootstrap.account_create_idempotency_key = p_account_create_idempotency_key
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.initial_link_delivered_at IS NULL
       AND bootstrap.initial_link_support_required_at IS NULL
       AND bootstrap.stripe_connected_account_id IS NULL
       AND EXISTS (
           SELECT 1 FROM public.studio_payment_accounts account
           WHERE account.studio_id = bootstrap.studio_id
             AND private.current_connect_account_generation(account.metadata) = bootstrap.connect_account_generation
       );
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO v_authorization
      FROM public.authorize_studio_live_billing_mutation_atomic(
          p_studio_id, 'connect_account.create', 'connect_onboarding', NULL, p_candidate_sha
      );
    IF NOT FOUND THEN
        RETURN;
    END IF;
    RETURN QUERY SELECT true, p_studio_id, v_authorization.checkpoint_id, v_bootstrap.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_connect_onboarding_bootstrap_account_v2(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_stripe_connected_account_id TEXT,
    p_business_entity_type TEXT
)
RETURNS public.studio_payment_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
BEGIN
    IF p_stripe_connected_account_id !~ '^acct_[A-Za-z0-9]+$'
       OR p_business_entity_type NOT IN ('company', 'individual') THEN
        RAISE EXCEPTION 'Invalid Connect bootstrap binding context.' USING ERRCODE = '22023';
    END IF;
    LOCK TABLE public.studio_payment_accounts, public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_context ->> 'business_entity_type' = p_business_entity_type
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.initial_link_delivered_at IS NULL
       AND bootstrap.initial_link_support_required_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Connect bootstrap is not recoverable.' USING ERRCODE = 'P0B21';
    END IF;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id
       AND private.current_connect_account_generation(account.metadata) = p_connect_account_generation
     FOR UPDATE;
    IF NOT FOUND
       OR (v_account.stripe_connected_account_id IS NOT NULL
           AND v_account.stripe_connected_account_id <> p_stripe_connected_account_id)
       OR (v_bootstrap.stripe_connected_account_id IS NOT NULL
           AND v_bootstrap.stripe_connected_account_id <> p_stripe_connected_account_id) THEN
        RAISE EXCEPTION 'Connect account mapping changed during recovery.' USING ERRCODE = 'P0B22';
    END IF;
    UPDATE public.studio_payment_accounts
       SET stripe_connected_account_id = p_stripe_connected_account_id,
           status = 'onboarding_incomplete',
           metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
               'business_entity_type', p_business_entity_type,
               'connect_account_generation', p_connect_account_generation
           )
     WHERE studio_id = p_studio_id
     RETURNING * INTO v_account;
    UPDATE public.stripe_connect_onboarding_bootstraps
       SET stripe_connected_account_id = p_stripe_connected_account_id,
           account_bound_at = COALESCE(account_bound_at, now())
     WHERE id = v_bootstrap.id;
    RETURN v_account;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_connect_onboarding_bootstrap_initial_link_v2(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_stripe_connected_account_id TEXT,
    p_initial_link_context_sha256 TEXT,
    p_initial_link_payload_sha256 TEXT,
    p_initial_link_idempotency_key TEXT
)
RETURNS TABLE(authorized BOOLEAN, studio_id UUID, checkpoint_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_eligible BOOLEAN;
BEGIN
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.stripe_connected_account_id = p_stripe_connected_account_id
       AND bootstrap.initial_link_context_sha256 = p_initial_link_context_sha256
       AND bootstrap.initial_link_idempotency_key = p_initial_link_idempotency_key
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
       AND bootstrap.initial_link_delivered_at IS NULL
       AND bootstrap.initial_link_support_required_at IS NULL
       AND (bootstrap.initial_link_delivery_receipt_expires_at IS NULL
            OR bootstrap.initial_link_delivery_receipt_expires_at > now())
       AND (bootstrap.initial_link_payload_sha256 IS NULL
            OR bootstrap.initial_link_payload_sha256 = p_initial_link_payload_sha256)
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    v_eligible := private.connect_onboarding_ga_initial_link_eligible_v58(v_bootstrap.id, p_candidate_sha);
    IF v_eligible IS DISTINCT FROM true THEN
        IF v_bootstrap.initial_link_claimed_at IS NOT NULL THEN
            UPDATE public.stripe_connect_onboarding_bootstraps
               SET initial_link_support_required_at = COALESCE(initial_link_support_required_at, now())
             WHERE id = v_bootstrap.id;
        END IF;
        RETURN;
    END IF;
    UPDATE public.stripe_connect_onboarding_bootstraps
       SET initial_link_payload_sha256 = COALESCE(initial_link_payload_sha256, p_initial_link_payload_sha256),
           initial_link_claimed_at = COALESCE(initial_link_claimed_at, now()),
           initial_link_last_retry_at = CASE
               WHEN initial_link_claimed_at IS NULL THEN initial_link_last_retry_at
               ELSE now()
           END
     WHERE id = v_bootstrap.id;
    RETURN QUERY SELECT true, p_studio_id, NULL::UUID, v_bootstrap.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_connect_onboarding_bootstrap_initial_link_response(
    p_bootstrap_id UUID,
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_connect_account_generation INTEGER,
    p_stripe_connected_account_id TEXT,
    p_initial_link_context_sha256 TEXT,
    p_initial_link_payload_sha256 TEXT,
    p_initial_link_idempotency_key TEXT,
    p_initial_link_response_sha256 TEXT,
    p_delivery_receipt_sha256 TEXT
)
RETURNS TABLE(recorded BOOLEAN, studio_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_eligible BOOLEAN;
BEGIN
    IF p_initial_link_response_sha256 IS NULL OR p_initial_link_response_sha256 !~ '^[0-9a-f]{64}$'
       OR p_delivery_receipt_sha256 IS NULL OR p_delivery_receipt_sha256 !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.id = p_bootstrap_id
       AND bootstrap.studio_id = p_studio_id
       AND bootstrap.connect_account_generation = p_connect_account_generation
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.stripe_connected_account_id = p_stripe_connected_account_id
       AND bootstrap.initial_link_context_sha256 = p_initial_link_context_sha256
       AND bootstrap.initial_link_payload_sha256 = p_initial_link_payload_sha256
       AND bootstrap.initial_link_idempotency_key = p_initial_link_idempotency_key
       AND bootstrap.initial_link_claimed_at IS NOT NULL
       AND bootstrap.initial_link_delivered_at IS NULL
       AND bootstrap.initial_link_support_required_at IS NULL
       AND bootstrap.recovery_context IS NOT NULL
       AND bootstrap.recovery_expires_at > now()
       AND bootstrap.aborted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    IF v_bootstrap.initial_link_delivery_receipt_expires_at IS NOT NULL
       AND v_bootstrap.initial_link_delivery_receipt_expires_at <= now() THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    IF v_bootstrap.initial_link_response_sha256 IS NOT NULL
       AND v_bootstrap.initial_link_response_sha256 <> p_initial_link_response_sha256 THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    v_eligible := private.connect_onboarding_ga_initial_link_eligible_v58(v_bootstrap.id, p_candidate_sha);
    IF v_eligible IS DISTINCT FROM true THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    UPDATE public.stripe_connect_onboarding_bootstraps
       SET initial_link_response_sha256 = p_initial_link_response_sha256,
           initial_link_response_recorded_at = now(),
           initial_link_delivery_receipt_sha256 = p_delivery_receipt_sha256,
           initial_link_delivery_receipt_expires_at = now() + INTERVAL '2 minutes'
     WHERE id = v_bootstrap.id;
    RETURN QUERY SELECT true, p_studio_id, v_bootstrap.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(
    p_studio_id UUID,
    p_candidate_sha TEXT,
    p_delivery_receipt_sha256 TEXT
)
RETURNS TABLE(acknowledged BOOLEAN, studio_id UUID, bootstrap_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bootstrap public.stripe_connect_onboarding_bootstraps%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_eligible BOOLEAN;
BEGIN
    IF p_studio_id IS NULL
       OR p_candidate_sha IS NULL OR p_candidate_sha !~ '^[0-9a-f]{40}$'
       OR p_delivery_receipt_sha256 IS NULL OR p_delivery_receipt_sha256 !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;
    LOCK TABLE
        public.stripe_events,
        public.studio_payment_accounts,
        public.stripe_connect_account_dispositions,
        public.stripe_live_billing_reconciliation_checkpoints,
        public.stripe_live_billing_reconciliation_account_evidence,
        public.studio_live_billing_authorizations,
        public.stripe_connect_onboarding_bootstraps
        IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO v_bootstrap
      FROM public.stripe_connect_onboarding_bootstraps bootstrap
     WHERE bootstrap.studio_id = p_studio_id
       AND bootstrap.candidate_sha = p_candidate_sha
       AND bootstrap.reconciliation_checkpoint_id IS NULL
       AND bootstrap.stripe_livemode
       AND bootstrap.initial_link_delivery_receipt_sha256 = p_delivery_receipt_sha256
       AND bootstrap.initial_link_response_recorded_at IS NOT NULL
       AND bootstrap.initial_link_delivery_receipt_expires_at > now()
       AND bootstrap.initial_link_support_required_at IS NULL
       AND bootstrap.aborted_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    SELECT * INTO v_account
      FROM public.studio_payment_accounts account
     WHERE account.studio_id = p_studio_id
       AND account.stripe_connected_account_id = v_bootstrap.stripe_connected_account_id
       AND private.current_connect_account_generation(account.metadata)
            = v_bootstrap.connect_account_generation;
    IF NOT FOUND THEN
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_support_required_at = now()
         WHERE id = v_bootstrap.id;
        RETURN;
    END IF;
    IF v_bootstrap.initial_link_delivered_at IS NULL THEN
        v_eligible := private.connect_onboarding_ga_initial_link_eligible_v58(v_bootstrap.id, p_candidate_sha);
        IF v_eligible IS DISTINCT FROM true THEN
            UPDATE public.stripe_connect_onboarding_bootstraps
               SET initial_link_support_required_at = now()
             WHERE id = v_bootstrap.id;
            RETURN;
        END IF;
        UPDATE public.stripe_connect_onboarding_bootstraps
           SET initial_link_delivered_at = now()
         WHERE id = v_bootstrap.id;
    END IF;
    RETURN QUERY SELECT true, p_studio_id, v_bootstrap.id;
END;
$$;

ALTER FUNCTION private.live_billing_ga_operations_v58(TEXT) OWNER TO postgres;
ALTER FUNCTION private.live_billing_ga_events_clear_v58() OWNER TO postgres;
ALTER FUNCTION private.connect_onboarding_ga_initial_link_eligible_v58(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.studio_live_billing_supported_operations_v58(UUID, TEXT) OWNER TO postgres;

-- Advance only the exact inherited expectation singleton. Historical audit
-- grants, checkpoints and bootstrap rows are not rewritten.
DO $expectation$
DECLARE changed INTEGER;
BEGIN
    UPDATE private.koaryu_release_v31_expectations
       SET expected_sha256='af3435a9266c9b482f7933dfc6ff5a756ec71fcf9eb7f3cba481e816226e50cb'
     WHERE expectation_key='operational_contract_v31'
       AND expected_sha256='d01750a441a8ef88ea8c4ebdcdc971ca5c3eae67ea237717b64d60e7016e6c6c';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed<>1 THEN RAISE EXCEPTION 'V58 requires the exact V57 expectation singleton.'; END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v39()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET TimeZone TO 'UTC'
 SET DateStyle TO 'ISO, YMD'
 SET IntervalStyle TO 'postgres'
AS $function$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
               FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;
    IF v_count <> 153 OR v_head <> '20261013013243' THEN
        v_failures := array_append(v_failures, 'migration_history_v58');
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
        '20260824190500','20260825042838','20260825043911','20260826030234',
        '20260826030249','20260826051527',
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301','20260920035023','20260920052705','20260920154441','20260925030000','20260926194918','20260929152445','20260930024404','20260930192626','20261004220435','20261005105341','20261013013243'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:308f79e1b9f231ef90a0674e5960ffbae152cf923a6344bf3e4a94c4d5228e31' THEN
        v_failures := array_append(v_failures, 'resource_ownership_manifest_v31');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       <> '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_schedule_window_manifest_v1()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '8df0d054a33defc36a16f802283cd815a6e5cfd9b1633d7aef288daa4b8158f0' THEN
        v_failures := array_append(v_failures, 'schedule_window_manifest_v1_function');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v31_expectations
    WHERE expectation_key = 'operational_contract_v31';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v31_expectations) <> 1
       OR private.koaryu_release_operational_contract_v31()
            IS DISTINCT FROM '0:' || v_expected THEN
        v_failures := array_append(v_failures, 'operational_contract_v31');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid=relation.relowner
        WHERE namespace.nspname='private'
          AND relation.relname='koaryu_release_v31_expectations'
          AND relation.relkind='r'
          AND owner.rolname='postgres'
          AND relation.relrowsecurity
    )
       OR has_table_privilege(
            'service_role','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'authenticated','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
            'anon','private.koaryu_release_v31_expectations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_class AS relation
            CROSS JOIN LATERAL aclexplode(COALESCE(
                relation.relacl,
                acldefault('r',relation.relowner)
            )) AS privilege
            WHERE relation.oid='private.koaryu_release_v31_expectations'::REGCLASS
              AND privilege.grantee<>relation.relowner
    ) THEN
        v_failures := array_append(v_failures, 'operational_contract_v31_expectation_acl');
    END IF;
    IF EXISTS (
        WITH required_expectation_tables(table_name) AS (
            VALUES
                ('koaryu_release_v27_expectations'),
                ('koaryu_release_v28_expectations'),
                ('koaryu_release_v29_expectations'),
                ('koaryu_release_v30_expectations')
        ), expectation_table_state AS (
            SELECT
                required.table_name,
                relation.oid,
                relation.relkind,
                relation.relrowsecurity,
                owner.rolname AS owner_name,
                COALESCE((
                    SELECT count(DISTINCT privilege.privilege_type)
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee=relation.relowner
                      AND NOT privilege.is_grantable
                      AND privilege.privilege_type IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                      )
                ), 0) AS owner_privilege_count,
                EXISTS (
                    SELECT 1
                    FROM aclexplode(COALESCE(
                        relation.relacl,
                        acldefault('r', relation.relowner)
                    )) AS privilege
                    WHERE privilege.grantee<>relation.relowner
                       OR privilege.is_grantable
                       OR privilege.privilege_type NOT IN (
                          'SELECT','INSERT','UPDATE','DELETE',
                          'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
                       )
                ) AS unexpected_privilege
            FROM required_expectation_tables AS required
            LEFT JOIN pg_class AS relation
              ON relation.relname=required.table_name
             AND relation.relnamespace='private'::REGNAMESPACE
            LEFT JOIN pg_roles AS owner ON owner.oid=relation.relowner
        )
        SELECT 1
        FROM expectation_table_state
        WHERE oid IS NULL
           OR relkind<>'r'
           OR owner_name<>'postgres'
           OR NOT relrowsecurity
           OR owner_privilege_count<>8
           OR unexpected_privilege
    ) THEN
        v_failures := array_append(
            v_failures,
            'inherited_operational_contract_expectation_acl'
        );
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v30_expectations
    WHERE expectation_key = 'operational_contract_v30';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v30_expectations) <> 1
       OR v_expected <> '2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30_expectation');
    END IF;
    SELECT expected_sha256 INTO v_expected
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key = 'operational_contract_v26';
    IF NOT FOUND
       OR (SELECT count(*) FROM private.koaryu_release_v26_expectations) <> 1
       OR v_expected <> '556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
       OR has_table_privilege('service_role', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('authenticated', 'private.koaryu_release_v26_expectations', 'SELECT')
       OR has_table_privilege('anon', 'private.koaryu_release_v26_expectations', 'SELECT') THEN
        v_failures := array_append(v_failures, 'operational_contract_v26_expectation');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v7()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8ce5a3a090a1fc1d29dab85c65fe8be07d6efa9639950732d13cf88e854f91f1' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v7_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v8()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '245040e7bfe42122a551d112ec9d411999b519866e59c8cd537de02c85f9889a' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v8_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v9()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '0f34947cbc4126a929b69db07690ca4bc73fe8b5b9982190ebb6fe2ebbb2d179' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v9_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v10()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '6b14a7594f511f258d6b94863c369a67f08e142dc721429adc7cdab4d4e64f86' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v10_body');
    END IF;
    IF encode(extensions.digest(convert_to(
        (SELECT prosrc FROM pg_proc
         WHERE oid = 'public.koaryu_release_schema_preflight_v11()'::REGPROCEDURE),
        'UTF8'
    ), 'sha256'), 'hex')
       <> '8270ab9a1a4ee091e700dc6fd2d33f2af5fa79dc1de34f3afd391c626e076843' THEN
        v_failures := array_append(v_failures, 'schema_preflight_v11_body');
    END IF;
    IF private.koaryu_release_operational_contract_v26()
       <> '0:eaae3521154ebb1416b3efc95d49f69a2aa583d236a4710b03fda985dae691c0' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:9c6c6f80b94c0412170e2ae59a8d8f1243c3fd049852e50e551592c1d389de07' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:8ca312d765bde9dff26086e888638ee12eb49da8d028e33e6e01455c500e1fdd' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:ad66d5b59dcf033b05cc3a9c3eaece3943972b9e197cbcc55854e3f3aee8b99b' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:1c245a6142a2e9ca2d3249d8772530798cca4ab8a0d9fe9059277f1c37501a4e' THEN
        v_failures := array_append(v_failures, 'operational_contract_v30');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_payments_replay_repairs_manifest_v30()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'a70b46c8b13a88f51d795be3ae4bc759bcc14495fda1cab9629e5c9c86e66228' THEN
        v_failures := array_append(v_failures, 'payments_replay_repairs_manifest_v30_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v11()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '79e338cb42307acf37e395647f29dbb88df57fa8d65443cc976a30c566cff6d2' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11_function');
    END IF;
    IF private.koaryu_release_operational_manifest_v11()
       <> 'f0e6c60876625596b2702e189468c541566d60ca76b01d4fabb11a1c45e81370' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:9f285d9d386666f8b42a6ce9d2c04eac3a6f897f979bb4e8d47c81c318ab5c53' THEN
        v_failures := array_append(v_failures, 'provider_operation_steps_manifest_v28');
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_resource_ownership_manifest_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6ee84c579e50be2b514ac00c975c1f60cf5f116e36adc27fe4296312e5188090' THEN
        v_failures:=array_append(v_failures,'resource_ownership_manifest_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_contract_v31()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6b54e02534f38bcd7bb6e6e811d9e01c9782958319514fee3f0a2f1d4ed167d4' THEN
        v_failures:=array_append(v_failures,'operational_contract_v31_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_provider_operation_steps_manifest_v28()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'b16b633c6f78a2d5cf7d63f1d32679563ff2429197cc92a4d94e826b33a26035' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28_function');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:45cb113e37c4ded47a36179688cb2cb5159567b949ffd038e74a63ee9f35ea73' THEN
        v_failures := array_append(v_failures, 'live_billing_v3_manifest_v25');
        v_failures := array_append(v_failures, 'operational_contract_v26');
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '6500b8aaf8bb91cc91841f2bafaf3699b7ffa328ccaba4a0023721e3eb68f811' THEN
        v_failures := array_append(v_failures, 'operation_authorization_writer_function');
    END IF;
    IF has_function_privilege(
        'service_role',
        'public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)',
        'EXECUTE'
    ) THEN
        v_failures := array_append(v_failures, 'legacy_authorization_scope_execute');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND conname = 'studio_live_billing_authorizations_operation_set_exact'
          AND convalidated
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_constraint');
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute AS attribute
        LEFT JOIN pg_attrdef AS default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE attribute.attrelid = 'public.studio_live_billing_authorizations'::REGCLASS
          AND attribute.attname = 'allowed_operations'
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
          AND format_type(attribute.atttypid, attribute.atttypmod) = 'text[]'
          AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'ARRAY[]::text[]'
    ) THEN
        v_failures := array_append(v_failures, 'operation_allowlist_column');
    END IF;
    IF private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.release',
                'connected_subscription_schedule.update'
            ]::TEXT[]
       ) IS DISTINCT FROM true
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.update',
                'connected_subscription_schedule.create'
            ]::TEXT[]
       ) IS DISTINCT FROM false
       OR private.live_billing_operation_set_is_canonical_v1(
            'connect_payments',ARRAY[
                'connected_subscription_schedule.create',
                'connected_subscription_schedule.unknown'
            ]::TEXT[]
       ) IS DISTINCT FROM false THEN
        v_failures := array_append(
            v_failures,'operation_allowlist_schedule_semantics'
        );
    END IF;
    IF private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM '79eab1f8ce8757ddc23ed4fd6f4bab574d4311677b58e0a9752fe79acc88ae14' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v12()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '57a017e4e7be92f023d31dc4a18e75b95c676765f42b54f9f5fb9f4b768ca3bd' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v12_function');
    END IF;
    IF private.koaryu_release_invoice_retry_preread_manifest_v32()
           <> '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
            v_failures := array_append(
                v_failures,'invoice_retry_preread_manifest_v32'
            );
        END IF;
        IF private.koaryu_release_invoice_retry_compatibility_manifest_v33()
       <> '0:8497daa806dcd7e33992fe8ca76f3207eb36b41e5a976be781e3bf33b22d4fdb' THEN
      v_failures:=array_append(v_failures,'invoice_retry_compatibility_manifest_v33');
    END IF;
    IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
       <> '0:70e87b852a84f9fcad61413ea8660fdf9d5adcb028ec03427f30d815e42526b6' THEN
      v_failures:=array_append(v_failures,'invoice_retry_closeout_manifest_v34');
    END IF;
    IF private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()
       IS DISTINCT FROM (SELECT evidence_manifest FROM private.koaryu_release_v35_expectations
                          WHERE singleton) THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_manifest_v35');
    END IF;
    IF has_function_privilege('anon',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR has_function_privilege('authenticated',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE')
       OR NOT has_function_privilege('service_role',
      'public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamptz,timestamptz,jsonb,uuid[],uuid,text[],text[])','EXECUTE') THEN
      v_failures:=array_append(v_failures,'stripe_rehearsal_evidence_acl_v35');
    END IF;
    IF private.koaryu_release_payer_setup_recovery_manifest_v36()
    IS DISTINCT FROM (SELECT recovery_manifest FROM private.koaryu_release_v36_expectations WHERE singleton) THEN
   v_failures:=array_append(v_failures,'payer_setup_recovery_manifest_v36');
 END IF;
 IF private.koaryu_release_adjustment_trigger_guard_manifest_v37()
      IS DISTINCT FROM (
        SELECT trigger_guard_manifest
        FROM private.koaryu_release_v37_expectations
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,'adjustment_trigger_guard_manifest_v37');
   END IF;

 IF EXISTS (
  SELECT 1 FROM (VALUES
  ('public.billing_payment_cohort(uuid,timestamptz,timestamptz)','5d6f683e3c56fe05db7e4101073d1a23792081192219cfa9eda4db8dcf734a1d'),
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','9af84c3c261a4ddb8aad9bc1c9cc332260fb1e31b1e7f51816b402339e2ad576'),
  ('public.billing_webhook_health(text,boolean,timestamptz)','3bdcc77c7d768e5ede8750900c0b75ac98bdffbb14ada059c580185133a9fd52')
  ) expected(signature,body_hash)
  LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR p.prosecdef OR p.provolatile<>'s'
  OR p.proowner <> 'postgres'::regrole OR p.prorettype<>'jsonb'::regtype
  OR NOT ('search_path=""'=ANY(coalesce(p.proconfig,ARRAY[]::text[])))
  OR encode(extensions.digest(convert_to(p.prosrc,'UTF8'),'sha256'),'hex')<>expected.body_hash
  OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE a.privilege_type='EXECUTE' AND a.grantee NOT IN ('postgres'::regrole,'service_role'::regrole))
 ) THEN v_failures:=array_append(v_failures,'billing_landing_reads_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.idx_billing_invoices_studio_history','public.billing_invoices','CREATE INDEX idx_billing_invoices_studio_history ON public.billing_invoices USING btree (studio_id, created_at DESC, id DESC)'),
   ('public.idx_billing_payments_studio_history','public.billing_payments','CREATE INDEX idx_billing_payments_studio_history ON public.billing_payments USING btree (studio_id, created_at DESC, id DESC)')
  ) expected(index_name,table_name,definition)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=to_regclass(expected.index_name)
  LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
  WHERE c.oid IS NULL OR c.relkind<>'i' OR c.relowner<>'postgres'::regrole
   OR i.indrelid IS DISTINCT FROM to_regclass(expected.table_name)
   OR i.indisvalid IS DISTINCT FROM true OR i.indisready IS DISTINCT FROM true
   OR i.indislive IS DISTINCT FROM true OR i.indisunique IS DISTINCT FROM false
   OR pg_get_indexdef(i.indexrelid) IS DISTINCT FROM expected.definition
 ) THEN v_failures:=array_append(v_failures,'billing_history_indexes_v38'); END IF;
 IF EXISTS (
  SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.oid='private.koaryu_release_critical_surface_manifest_v16()'::REGPROCEDURE
    AND (p.proowner <> 'postgres'::REGROLE OR p.prosecdef OR p.provolatile <> 's'
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
         IS DISTINCT FROM '7fb0ba103de76167982cc96f0698d7516418ababb0892dc70d5c85e1d83efc0f'
      OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                 WHERE a.grantee <> p.proowner))
 ) THEN v_failures:=array_append(v_failures,'rank_command_manifest_v40_definition'); END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='recompute_billing_payer_balance_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.recompute_billing_payer_balance_v1(uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '78890d7907bb56bfdb337df262b17cc5144f8bd87d169df26a10fc048072670f'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_balance_rpc_v41');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='record_external_payment_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '150aedb400108d00c3fe90ca3de7d4ccde6df24ad8dda4f045cd6256af1ad13d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'external_payment_rpc_v43');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='write_billing_plan_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ac577f4bec60aecc52b4950eda7d8a8a469d6ac035d05afeabb74e3a9c8fe789'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_rpc_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='clear_studio_operational_data_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.clear_studio_operational_data_atomic(uuid,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='void'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'fd4f3a1e65eef9f113ac8a648b72d45d84c5d9261e6436bd4aabe6c4643221fd'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'local_plan_clear_coordination_v44');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='claim_student_import_run_owned') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '34c8fbfd2e843be56034d686c2d90911c6c3938ca5e71da1616ea092a6edcddc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_claim_student_import_run_owned_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'afb0c874110e03126be86e561bd1c4cac0391c404f5ecd2c5b342799a625b8a7'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_actor') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_actor(uuid)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='boolean'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'd04e6d08b7fd24eca4a46eddf8fbcaaeeef80d65431e55de5562a198ac09c331'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_actor_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='private' AND p.proname='lock_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('private.lock_student_import_run(uuid,uuid,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.student_import_runs'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '95ea7bdd011af07a17f77120ab7227dd540a1e612b79e03f305f9f5c591002af'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_private_lock_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '187d0eb3385fc7958efc0dedc1e2a39a61224b59596f4611339b6eb7da1c159d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_student_import_run_v2') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '91c5c8919bd1ddfc2b9bfa82ca9cced577a94974e7854a17fc3156540216add2'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_claim_student_import_run_v2_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='finish_student_import_run') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.finish_student_import_run(uuid,text,text,jsonb,text)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '8f40eed2f27ce892b08a673121247a34e8eaf342e0fb9953b6c873945e16b032'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_finish_student_import_run_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='import_student_row_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog, public, private']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '6d9d129040e0f3cb831cbb883c56ee6c8bf4c4b18aff59eb55c0ccf862ae2bd9'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_import_student_row_atomic_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='bind_student_import_rank_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'e428fbeb91f8457bf717917bd93685531188d49d25b003eb2bd6ab7f184f2e68'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_bind_student_import_rank_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_belts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '7b61469ec2de918d7f79effa3a52c590b3eef9416c2ba716f1b6d9cfc91669bb'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_belts_v1_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='prepare_student_import_program_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '25fadfe0298192b7d2bf6c6210ad199743e7dd01d9dd035e7c9f36ba7c17794e'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'import_public_prepare_student_import_program_v1_v45');
    END IF;
    IF (SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'no_policies',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('private.student_import_receipts')
          AND relation.relkind='r') IS DISTINCT FROM '{"owner":"postgres","rls":false,"force_rls":false,"columns":[["import_run_id","uuid",true,null,"","",true],["kind","text",true,null,"","",true],["key","text",true,null,"","",true],["result_json","jsonb",true,null,"","",true],["created_at","timestamp with time zone",true,"now()","","",true]],"acl":[["postgres","postgres","DELETE",false],["postgres","postgres","INSERT",false],["postgres","postgres","MAINTAIN",false],["postgres","postgres","REFERENCES",false],["postgres","postgres","SELECT",false],["postgres","postgres","TRIGGER",false],["postgres","postgres","TRUNCATE",false],["postgres","postgres","UPDATE",false],["service_role","postgres","INSERT",false],["service_role","postgres","SELECT",false]],"constraints":[["student_import_receipts_import_run_id_fkey","f",true,false,false,"FOREIGN KEY (import_run_id) REFERENCES public.student_import_runs(id) ON DELETE CASCADE"],["student_import_receipts_key_check","c",true,false,false,"CHECK (((char_length(key) >= 1) AND (char_length(key) <= 512)))"],["student_import_receipts_kind_check","c",true,false,false,"CHECK ((kind = ANY (ARRAY[''student''::text, ''program''::text, ''ladder''::text, ''rank''::text])))"],["student_import_receipts_pkey","p",true,false,false,"PRIMARY KEY (import_run_id, kind, key)"],["student_import_receipts_result_json_check","c",true,false,false,"CHECK ((jsonb_typeof(result_json) = ''object''::text))"]],"indexes":[["student_import_receipts_pkey",true,true,true,true,"CREATE UNIQUE INDEX student_import_receipts_pkey ON private.student_import_receipts USING btree (import_run_id, kind, key)"]],"no_policies":true,"no_user_triggers":true}'::JSONB
       OR (SELECT jsonb_build_array(pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),
                attribute.attnotnull,pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL)
            FROM pg_catalog.pg_attribute attribute LEFT JOIN pg_catalog.pg_attrdef default_value
              ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=pg_catalog.to_regclass('public.student_import_runs')
              AND attribute.attname='receipts_enabled' AND NOT attribute.attisdropped)
          IS DISTINCT FROM '["boolean",true,"false","","",true]'::JSONB THEN
        v_failures:=array_append(v_failures,'import_receipts_v45');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       IS DISTINCT FROM '4:d34f843175fbf8d24fae0c6e9d80101cf2590d23ac6724e957ba7e04e68eb267' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> 'feed7c0421cbeb5bcb2555837dd1c244367f180c8a884380f2f281ef919c82ee' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_definition_v45');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='begin_billing_enrollment_activation_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'a104d7696ec9a711358697783ca065c9d78233ffa4c63d77633c8fcf42ff5e59'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_begin_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='reject_billing_autopay_activation_without_provider_v31') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='v'
          AND p.prorettype='jsonb'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'b2bee4e53471d0a949ff4533f7ab14938c4fc919e8c97ce8d767f854bc876b44'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'activation_rejection_v48');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid='public.billing_subscriptions'::REGCLASS
          AND a.attname IN ('currency','billing_interval') AND NOT a.attisdropped
          AND a.atttypid='text'::REGTYPE AND NOT a.attnotnull AND d.oid IS NULL
          AND a.attidentity='' AND a.attgenerated='') IS DISTINCT FROM 2 THEN
        v_failures:=array_append(v_failures,'subscription_terms_v49');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_invoice_collection_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_invoice_collection_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '40d16d06464c028c1bd4a27089163181865cd65a8ce963b1738ee0abe3c5eacc'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'invoice_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_payer_balance_facts_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_payer_balance_facts_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='record'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'f81f1d839e26e5fe0abe9bf84af7bcb58c654f88cea4107f4e97b1cf993492b4'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_collection_facts_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='list_billing_payers_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.list_billing_payers_v1(uuid,uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='jsonb'::REGTYPE AND p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ca4a6d2d6657cf82900a315b492af687a42be2fd1a6a3cad296119f6be72ff8d'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'payer_read_projection_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='billing_attention_count_v1') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.billing_attention_count_v1(uuid,date)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='s'
          AND p.prorettype='integer'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '4e57973f97038e57ec411c502960453b07d5f59374ab0e2bc856a42ecbb7e036'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'billing_attention_count_v50');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='update_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.update_lead_atomic(uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '087249d003c83cf7fed72445b36499e3b7e01d492ad9de479d4e7f320ad5661f'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'update_lead_atomic_v52');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='follow_up_lead_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=""']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = '3ebf9f8caae2ab42810e78575f4d31318298740299f6f96ff1ca37c056c83202'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'follow_up_lead_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
            'owner',pg_catalog.pg_get_userbyid(relation.relowner),
            'rls',relation.relrowsecurity,'force_rls',relation.relforcerowsecurity,
            'columns',(SELECT jsonb_agg(jsonb_build_array(attribute.attname,
                pg_catalog.format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
                pg_catalog.pg_get_expr(default_value.adbin,default_value.adrelid),
                attribute.attidentity,attribute.attgenerated,attribute.attacl IS NULL) ORDER BY attribute.attnum)
                FROM pg_catalog.pg_attribute attribute
                LEFT JOIN pg_catalog.pg_attrdef default_value
                  ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
                WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
            'acl',(SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
                ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                         acl.privilege_type,acl.is_grantable)
                FROM pg_catalog.aclexplode(COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))) acl),
            'constraints',(SELECT jsonb_agg(jsonb_build_array(constraint_row.conname,constraint_row.contype,
                constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred,
                pg_catalog.pg_get_constraintdef(constraint_row.oid)) ORDER BY constraint_row.conname COLLATE "C")
                FROM pg_catalog.pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
            'indexes',(SELECT jsonb_agg(jsonb_build_array(index_relation.relname,index_row.indisvalid,
                index_row.indisready,index_row.indisunique,index_row.indisprimary,pg_catalog.pg_get_indexdef(index_row.indexrelid))
                ORDER BY index_relation.relname COLLATE "C")
                FROM pg_catalog.pg_index index_row JOIN pg_catalog.pg_class index_relation ON index_relation.oid=index_row.indexrelid
                WHERE index_row.indrelid=relation.oid),
            'policies',(SELECT jsonb_agg(jsonb_build_array(policy.polname,policy.polcmd,policy.polpermissive,
                (SELECT jsonb_agg(pg_catalog.pg_get_userbyid(role_oid)::TEXT ORDER BY pg_catalog.pg_get_userbyid(role_oid)::TEXT COLLATE "C") FROM unnest(policy.polroles) role_oid),
                pg_catalog.pg_get_expr(policy.polqual,policy.polrelid),pg_catalog.pg_get_expr(policy.polwithcheck,policy.polrelid)) ORDER BY policy.polname COLLATE "C")
                FROM pg_catalog.pg_policy policy WHERE policy.polrelid=relation.oid),
            'no_user_triggers',NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger trigger_row
                WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal))
        FROM pg_catalog.pg_class relation WHERE relation.oid=pg_catalog.to_regclass('public.lead_follow_up_operations')
          AND relation.relkind='r')::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '796b4c0fe4d033966248b78138776b6695dfbc80bdab7e0e9026b6c9745318cb' THEN
        v_failures:=array_append(v_failures,'lead_follow_up_operations_v52');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'public.dashboard_summary_facts(uuid,text,text,date,text)'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '350a7ffbea0fab5fe570d6243a5b22fa0ed6d528053bebf5ccfb2f6e7433cec6' THEN
        v_failures := array_append(v_failures, 'dashboard_summary_facts_v53');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_build_object(
    'functions',(SELECT jsonb_agg(jsonb_build_object(
        'signature',required.signature,'exists',function.oid IS NOT NULL,
        'definition',pg_catalog.pg_get_functiondef(function.oid),'body',function.prosrc,
        'owner',pg_catalog.pg_get_userbyid(function.proowner),'language',language.lanname,
        'volatility',function.provolatile,'security_definer',function.prosecdef,
        'strict',function.proisstrict,'parallel',function.proparallel,
        'config',function.proconfig,'result',pg_catalog.pg_get_function_result(function.oid),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(acl.grantor)::TEXT,acl.privilege_type,acl.is_grantable)
            ORDER BY CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(acl.grantee)::TEXT END COLLATE "C",
                pg_catalog.pg_get_userbyid(acl.grantor)::TEXT COLLATE "C",acl.privilege_type,acl.is_grantable)
            FROM pg_catalog.aclexplode(COALESCE(function.proacl,pg_catalog.acldefault('f',function.proowner))) acl)
        ) ORDER BY required.signature COLLATE "C")
        FROM (VALUES
            ('public.student_business_date(uuid)'),
            ('public.validate_student_birth_date()'),
            ('public.set_student_is_minor()'),
            ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
            ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')
        ) required(signature)
        LEFT JOIN pg_catalog.pg_proc function ON function.oid=pg_catalog.to_regprocedure(required.signature)
        LEFT JOIN pg_catalog.pg_language language ON language.oid=function.prolang),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',required.name,'expected_function',required.signature,
        'exists',trigger_row.oid IS NOT NULL,
        'binding_matches',trigger_row.tgfoid=pg_catalog.to_regprocedure(required.signature),
        'definition',pg_catalog.pg_get_triggerdef(trigger_row.oid),
        'enabled',trigger_row.tgenabled,'type',trigger_row.tgtype,
        'arguments',encode(trigger_row.tgargs,'hex'),
        'internal',trigger_row.tgisinternal,'constraint',trigger_row.tgconstraint<>0,
        'deferrable',trigger_row.tgdeferrable,'initially_deferred',trigger_row.tginitdeferred
        ) ORDER BY required.name COLLATE "C")
        FROM (VALUES ('set_students_is_minor','public.set_student_is_minor()'),
            ('validate_students_birth_date','public.validate_student_birth_date()')) required(name,signature)
        LEFT JOIN pg_catalog.pg_trigger trigger_row
          ON trigger_row.tgrelid=pg_catalog.to_regclass('public.students') AND trigger_row.tgname=required.name)
    ))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '7f48d5bbd40e124f0f096110d6a73213b7684d9edaa0b41b2e1bfc4604359e83' THEN
        v_failures:=array_append(v_failures,'student_profile_facts_v55');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='convert_lead_to_student_atomic') <> 1
       OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)')
          AND p.proowner='postgres'::REGROLE AND NOT p.prosecdef AND p.provolatile='v'
          AND p.prorettype='public.leads'::REGTYPE AND NOT p.proretset
          AND p.proconfig=ARRAY['search_path=public, pg_temp']::TEXT[]
          AND encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex')
              = 'ce9cd28c7191ca26f8a931a79c729bfbafb545527ed0e38a23ce045fe3b0adb8'
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                         a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
              = '[ ["postgres","postgres","EXECUTE",false], ["service_role","postgres","EXECUTE",false] ]'::JSONB
       ) THEN
        v_failures:=array_append(v_failures,'convert_lead_to_student_atomic_v55');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('public.automation_rules'),('public.automation_deliveries'),
    ('public.automation_suppressions'),('private.automation_email_credentials')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '2cac874e09752d14ad6ff1ca72bca38b278d9ffb05ad1b15c6e1b2c9c02afe53' THEN
        v_failures:=array_append(v_failures,'automation_tables_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES
    ('private.automation_delivery_immutable()'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)')
) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM 'd158e4eb04d0fb51d06ca16a490f48675a7036b45f4ff1d70f2148a2b1194478' THEN
        v_failures:=array_append(v_failures,'automation_functions_v56');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'table',required.name,'exists',c.oid IS NOT NULL,'kind',c.relkind,'persistence',c.relpersistence,
    'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a),
    'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'position',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),
        'identity',a.attidentity,'generated',a.attgenerated,
        'collation',(SELECT n.nspname||'.'||co.collname FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace WHERE co.oid=a.attcollation),
        'acl',(SELECT jsonb_agg(jsonb_build_array(
            CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee)::TEXT END,
            pg_catalog.pg_get_userbyid(x.grantor)::TEXT,x.privilege_type,x.is_grantable)
            ORDER BY x.grantee::regrole::TEXT COLLATE "C",x.grantor::regrole::TEXT COLLATE "C",x.privilege_type,x.is_grantable)
            FROM pg_catalog.aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object(
        'name',k.conname,'type',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid),
        'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
        'local',k.conislocal,'inheritance',k.coninhcount,'no_inherit',k.connoinherit,
        'foreign_table',k.confrelid::regclass::TEXT,'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype
        ) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object(
        'name',i.relname,'persistence',i.relpersistence,'definition',pg_catalog.pg_get_indexdef(x.indexrelid),
        'valid',x.indisvalid,'ready',x.indisready,'unique',x.indisunique,
        'primary',x.indisprimary,'exclusion',x.indisexclusion,'immediate',x.indimmediate,
        'nulls_not_distinct',x.indnullsnotdistinct,'live',x.indislive,
        'predicate',pg_catalog.pg_get_expr(x.indpred,x.indrelid)
        ) ORDER BY i.relname COLLATE "C") FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object(
        'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(r::regrole::TEXT ORDER BY r::regrole::TEXT COLLATE "C") FROM unnest(p.polroles) r),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)
        ) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'function',t.tgfoid::regprocedure::TEXT,
        'enabled',t.tgenabled,'type',t.tgtype,'arguments',encode(t.tgargs,'hex'),
        'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'constraint',t.tgconstraint<>0
        ) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
    ) ORDER BY required.name COLLATE "C")
FROM (VALUES ('private.automation_command_operations'),
    ('private.automation_email_attempt_reservations'),
    ('private.automation_email_credentials'),
    ('private.automation_sender_gate'),
    ('private.automation_sender_preparations'),
    ('private.automation_test_email_payloads'),
    ('private.automation_test_email_scopes'),
    ('private.automation_unsubscribe_token_bindings'),
    ('private.automation_workflow_dispatch_cursor'),
    ('private.automation_workflow_email_attempts'),
    ('private.automation_workflow_events'),
    ('private.automation_workflow_follow_up_actions'),
    ('private.automation_workflow_run_steps'),
    ('private.billing_invoice_retry_hash_capture_control_v33'),
    ('private.billing_invoice_retry_hash_ledger_v33'),
    ('private.koaryu_release_v26_expectations'),
    ('private.koaryu_release_v27_expectations'),
    ('private.koaryu_release_v28_expectations'),
    ('private.koaryu_release_v29_expectations'),
    ('private.koaryu_release_v30_expectations'),
    ('private.koaryu_release_v31_expectations'),
    ('private.koaryu_release_v35_expectations'),
    ('private.koaryu_release_v36_expectations'),
    ('private.koaryu_release_v37_expectations'),
    ('private.stripe_connect_account_identity_guards'),
    ('private.student_import_receipts'),
    ('private.studio_creation_requests'),
    ('private.workflow_email_attempt_payloads'),
    ('private.workflow_email_unsubscribe_pins'),
    ('private.workflow_invoice_collection_episodes'),
    ('private.workflow_invoice_episode_pending'),
    ('private.workflow_invoice_episode_state'),
    ('private.workflow_invoice_settlement_authority'),
    ('private.workflow_payment_capture_markers'),
    ('private.workflow_payment_settlement_observations'),
    ('private.workflow_rank_contexts'),
    ('private.workflow_rank_pending_contexts'),
    ('private.workflow_rank_pending_events'),
    ('private.workflow_rank_scopes'),
    ('private.workflow_timer_activations'),
    ('private.workflow_timer_dispatch_cursor'),
    ('public.account_deletion_requests'),
    ('public.attendance'),
    ('public.audit_logs'),
    ('public.automation_deliveries'),
    ('public.automation_rules'),
    ('public.automation_suppressions'),
    ('public.automation_workflow_activations'),
    ('public.automation_workflow_runs'),
    ('public.automation_workflow_versions'),
    ('public.automation_workflows'),
    ('public.belt_ladders'),
    ('public.belt_ranks'),
    ('public.belt_test_events'),
    ('public.belt_test_recipients'),
    ('public.billing_adjustments'),
    ('public.billing_disputes'),
    ('public.billing_enrollment_transition_aliases'),
    ('public.billing_enrollment_transition_intents'),
    ('public.billing_invoice_items'),
    ('public.billing_invoice_mutation_owners'),
    ('public.billing_invoice_retry_operation_aliases'),
    ('public.billing_invoice_retry_operations'),
    ('public.billing_invoices'),
    ('public.billing_payer_payment_consents'),
    ('public.billing_payer_setup_requests'),
    ('public.billing_payers'),
    ('public.billing_payments'),
    ('public.billing_plan_prices'),
    ('public.billing_plan_programs'),
    ('public.billing_plans'),
    ('public.billing_provider_operation_resource_aliases'),
    ('public.billing_provider_operation_resources'),
    ('public.billing_provider_operation_steps'),
    ('public.billing_provider_operations'),
    ('public.billing_refunds'),
    ('public.billing_subscriptions'),
    ('public.class_sessions'),
    ('public.class_templates'),
    ('public.email_usage_events'),
    ('public.export_jobs'),
    ('public.guardians'),
    ('public.lead_activities'),
    ('public.lead_follow_up_operations'),
    ('public.lead_trial_appointments'),
    ('public.leads'),
    ('public.operational_alert_audit_events'),
    ('public.operational_alert_delivery_attempts'),
    ('public.operational_alert_delivery_outcomes'),
    ('public.operational_alert_episodes'),
    ('public.operational_alert_heartbeats'),
    ('public.operational_alert_outbox'),
    ('public.programs'),
    ('public.promotions'),
    ('public.staff_profiles'),
    ('public.staff_roles'),
    ('public.stripe_connect_account_dispositions'),
    ('public.stripe_connect_onboarding_bootstraps'),
    ('public.stripe_events'),
    ('public.stripe_live_billing_reconciliation_account_evidence'),
    ('public.stripe_live_billing_reconciliation_checkpoints'),
    ('public.stripe_live_billing_reconciliation_checkpoints_v3'),
    ('public.student_billing_enrollments'),
    ('public.student_guardians'),
    ('public.student_import_runs'),
    ('public.student_program_memberships'),
    ('public.students'),
    ('public.studio_live_billing_authorizations'),
    ('public.studio_payment_accounts'),
    ('public.studio_subscriptions'),
    ('public.studios'),
    ('public.support_ticket_events'),
    ('public.support_tickets')) required(name)
LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(required.name))::TEXT,'UTF8'),'sha256'),'hex'))
       NOT IN ('90cbd2b2139f3975294c9bbe99ea24cc0943ea6a1345dbdd1edb37aa41fc33d3','e8b20992404a7b771ac0d14036ee9119cf86ca0cb373597623deb5d1b4369fb1','88ed9e1376d757faba41afb4dfbe86b433451ba629e7f64d37de00f0790b4ae5','c69f596fbed4da0d29aeff4677a5cd7729f9cefd44502df77f2fff3916be4381')
       OR (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY (n.nspname||'.'||c.relname) COLLATE "C")
           FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p'))
          IS DISTINCT FROM ARRAY['private.automation_command_operations','private.automation_email_attempt_reservations','private.automation_email_credentials','private.automation_sender_gate','private.automation_sender_preparations','private.automation_test_email_payloads','private.automation_test_email_scopes','private.automation_unsubscribe_token_bindings','private.automation_workflow_dispatch_cursor','private.automation_workflow_email_attempts','private.automation_workflow_events','private.automation_workflow_follow_up_actions','private.automation_workflow_run_steps','private.billing_invoice_retry_hash_capture_control_v33','private.billing_invoice_retry_hash_ledger_v33','private.koaryu_release_v26_expectations','private.koaryu_release_v27_expectations','private.koaryu_release_v28_expectations','private.koaryu_release_v29_expectations','private.koaryu_release_v30_expectations','private.koaryu_release_v31_expectations','private.koaryu_release_v35_expectations','private.koaryu_release_v36_expectations','private.koaryu_release_v37_expectations','private.stripe_connect_account_identity_guards','private.student_import_receipts','private.studio_creation_requests','private.workflow_email_attempt_payloads','private.workflow_email_unsubscribe_pins','private.workflow_invoice_collection_episodes','private.workflow_invoice_episode_pending','private.workflow_invoice_episode_state','private.workflow_invoice_settlement_authority','private.workflow_payment_capture_markers','private.workflow_payment_settlement_observations','private.workflow_rank_contexts','private.workflow_rank_pending_contexts','private.workflow_rank_pending_events','private.workflow_rank_scopes','private.workflow_timer_activations','private.workflow_timer_dispatch_cursor','public.account_deletion_requests','public.attendance','public.audit_logs','public.automation_deliveries','public.automation_rules','public.automation_suppressions','public.automation_workflow_activations','public.automation_workflow_runs','public.automation_workflow_versions','public.automation_workflows','public.belt_ladders','public.belt_ranks','public.belt_test_events','public.belt_test_recipients','public.billing_adjustments','public.billing_disputes','public.billing_enrollment_transition_aliases','public.billing_enrollment_transition_intents','public.billing_invoice_items','public.billing_invoice_mutation_owners','public.billing_invoice_retry_operation_aliases','public.billing_invoice_retry_operations','public.billing_invoices','public.billing_payer_payment_consents','public.billing_payer_setup_requests','public.billing_payers','public.billing_payments','public.billing_plan_prices','public.billing_plan_programs','public.billing_plans','public.billing_provider_operation_resource_aliases','public.billing_provider_operation_resources','public.billing_provider_operation_steps','public.billing_provider_operations','public.billing_refunds','public.billing_subscriptions','public.class_sessions','public.class_templates','public.email_usage_events','public.export_jobs','public.guardians','public.lead_activities','public.lead_follow_up_operations','public.lead_trial_appointments','public.leads','public.operational_alert_audit_events','public.operational_alert_delivery_attempts','public.operational_alert_delivery_outcomes','public.operational_alert_episodes','public.operational_alert_heartbeats','public.operational_alert_outbox','public.programs','public.promotions','public.staff_profiles','public.staff_roles','public.stripe_connect_account_dispositions','public.stripe_connect_onboarding_bootstraps','public.stripe_events','public.stripe_live_billing_reconciliation_account_evidence','public.stripe_live_billing_reconciliation_checkpoints','public.stripe_live_billing_reconciliation_checkpoints_v3','public.student_billing_enrollments','public.student_guardians','public.student_import_runs','public.student_program_memberships','public.students','public.studio_live_billing_authorizations','public.studio_payment_accounts','public.studio_subscriptions','public.studios','public.support_ticket_events','public.support_tickets']::TEXT[] THEN
        v_failures:=array_append(v_failures,'live_billing_tables_v58');
    END IF;
    IF (SELECT encode(extensions.digest(convert_to((SELECT jsonb_agg(jsonb_build_object(
    'signature',required.signature,'exists',p.oid IS NOT NULL,
    'definition',pg_catalog.pg_get_functiondef(p.oid),'body',p.prosrc,
    'owner',pg_catalog.pg_get_userbyid(p.proowner),'language',l.lanname,
    'kind',p.prokind,'volatility',p.provolatile,'security_definer',p.prosecdef,
    'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
    'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),
    'arguments',pg_catalog.pg_get_function_arguments(p.oid),'returns_set',p.proretset,
    'overloads',(SELECT jsonb_agg(x.oid::regprocedure::TEXT ORDER BY x.oid::regprocedure::TEXT COLLATE "C")
        FROM pg_catalog.pg_proc x JOIN pg_catalog.pg_namespace n ON n.oid=x.pronamespace
        WHERE n.nspname=split_part(required.signature,'.',1)
          AND x.proname=split_part(split_part(required.signature,'.',2),'(',1)),
    'acl',(SELECT jsonb_agg(jsonb_build_array(
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
        pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
        ORDER BY a.grantee::regrole::TEXT COLLATE "C",a.grantor::regrole::TEXT COLLATE "C",a.privilege_type,a.is_grantable)
        FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
    ) ORDER BY required.signature COLLATE "C")
FROM (VALUES ('private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)'),
    ('private.automation_bind_unsubscribe_token_v1(uuid,text,text)'),
    ('private.automation_clear_statement_fence_v1()'),
    ('private.automation_core_entitled(uuid)'),
    ('private.automation_delivery_immutable()'),
    ('private.automation_delivery_result_v1(jsonb,bigint)'),
    ('private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)'),
    ('private.automation_email_attempt_expire_v1(uuid)'),
    ('private.automation_email_attempt_identity_v1()'),
    ('private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)'),
    ('private.automation_expire_orphaned_legacy_attempts_v1(integer)'),
    ('private.automation_has_actionable_work(text[])'),
    ('private.automation_instant_v1(jsonb)'),
    ('private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)'),
    ('private.automation_legacy_delivery_delete_v1()'),
    ('private.automation_legacy_delivery_result_v1(jsonb)'),
    ('private.automation_legacy_delivery_transition_v1()'),
    ('private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)'),
    ('private.automation_legacy_projection_valid_v1(jsonb)'),
    ('private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)'),
    ('private.automation_legacy_terminal_v1(jsonb,integer)'),
    ('private.automation_normalize_email(text)'),
    ('private.automation_require_admin(uuid,uuid)'),
    ('private.automation_sender_claim_v1(uuid,text,text,uuid)'),
    ('private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)'),
    ('private.automation_sender_gate_identity_v1()'),
    ('private.automation_sender_gate_lock_v1()'),
    ('private.automation_sender_instant_v1(timestamp with time zone)'),
    ('private.automation_sender_preparation_identity_v1()'),
    ('private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)'),
    ('private.automation_sender_preparation_result_valid_v1(jsonb)'),
    ('private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)'),
    ('private.automation_sender_release_orphan_probe_v1()'),
    ('private.automation_sender_release_probe_v1(uuid,uuid,uuid)'),
    ('private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)'),
    ('private.automation_test_actor_v1(uuid,uuid)'),
    ('private.automation_test_allowed_v1(text[])'),
    ('private.automation_test_clear_owned_v1(uuid)'),
    ('private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)'),
    ('private.automation_test_expire_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_fail_v1(private.automation_test_email_scopes,text)'),
    ('private.automation_test_invalidate_queued_v1(uuid)'),
    ('private.automation_test_original_v1(uuid,uuid,uuid)'),
    ('private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])'),
    ('private.automation_test_payload_delete_v1()'),
    ('private.automation_test_payload_identity_v1()'),
    ('private.automation_test_rendered_valid_v1(jsonb)'),
    ('private.automation_test_result_v1(private.automation_test_email_scopes)'),
    ('private.automation_test_scope_identity_v1()'),
    ('private.automation_test_verified_email_v1(uuid)'),
    ('private.automation_timezone_v1(jsonb)'),
    ('private.automation_unsubscribe_binding_identity_v1()'),
    ('private.automation_utc_text_v1(timestamp with time zone)'),
    ('private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)'),
    ('private.belt_test_event_payload_v1(public.belt_test_events)'),
    ('private.belt_test_lock_recipient_runs_v1(uuid,uuid[])'),
    ('private.belt_test_name_v1(jsonb)'),
    ('private.belt_test_recipient_identity_v1()'),
    ('private.belt_test_recipient_payload_v1(public.belt_test_recipients)'),
    ('private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)'),
    ('private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)'),
    ('private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)'),
    ('private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)'),
    ('private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)'),
    ('private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)'),
    ('private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)'),
    ('private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)'),
    ('private.billing_plan_resource_version_v31(public.billing_plans,text,integer)'),
    ('private.billing_provider_operation_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)'),
    ('private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)'),
    ('private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)'),
    ('private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)'),
    ('private.bind_live_billing_authorization_checkpoint()'),
    ('private.can_read_staff_profile(uuid)'),
    ('private.capture_billing_invoice_retry_alias_v33()'),
    ('private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)'),
    ('private.capture_billing_invoice_retry_resource_v33()'),
    ('private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)'),
    ('private.clear_studio_operational_data_v2(uuid,boolean)'),
    ('private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)'),
    ('private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)'),
    ('private.current_connect_account_generation(jsonb)'),
    ('private.deterministic_import_uuid(uuid,text)'),
    ('private.enforce_billing_payer_connect_identity_v1()'),
    ('private.enforce_billing_payment_refundable_amount_v31()'),
    ('private.enforce_billing_provider_step_parent_v1()'),
    ('private.enforce_live_billing_checkpoint_processed_events()'),
    ('private.enforce_single_studio_membership()'),
    ('private.handle_invoice_retry_consent_change_v33(uuid,uuid)'),
    ('private.has_unambiguous_studio_membership()'),
    ('private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'),
    ('private.is_admin_in_studio(uuid)'),
    ('private.is_admin_or_front_desk_in_studio(uuid)'),
    ('private.is_staff_in_studio(uuid)'),
    ('private.koaryu_release_adjustment_trigger_guard_manifest_v37()'),
    ('private.koaryu_release_critical_surface_manifest_v14()'),
    ('private.koaryu_release_critical_surface_manifest_v15()'),
    ('private.koaryu_release_critical_surface_manifest_v16()'),
    ('private.koaryu_release_critical_surface_manifest_v17()'),
    ('private.koaryu_release_critical_surface_manifest_v18()'),
    ('private.koaryu_release_enrollment_transition_manifest_v29()'),
    ('private.koaryu_release_invoice_retry_closeout_manifest_v34()'),
    ('private.koaryu_release_invoice_retry_compatibility_manifest_v33()'),
    ('private.koaryu_release_invoice_retry_preread_manifest_v32()'),
    ('private.koaryu_release_live_billing_v3_manifest_v25()'),
    ('private.koaryu_release_operational_contract_v25()'),
    ('private.koaryu_release_operational_contract_v26()'),
    ('private.koaryu_release_operational_contract_v27()'),
    ('private.koaryu_release_operational_contract_v28()'),
    ('private.koaryu_release_operational_contract_v29()'),
    ('private.koaryu_release_operational_contract_v30()'),
    ('private.koaryu_release_operational_contract_v31()'),
    ('private.koaryu_release_operational_manifest_v10()'),
    ('private.koaryu_release_operational_manifest_v11()'),
    ('private.koaryu_release_operational_manifest_v12()'),
    ('private.koaryu_release_operational_manifest_v2()'),
    ('private.koaryu_release_operational_manifest_v2_base()'),
    ('private.koaryu_release_operational_manifest_v4()'),
    ('private.koaryu_release_operational_manifest_v5()'),
    ('private.koaryu_release_operational_manifest_v6()'),
    ('private.koaryu_release_operational_manifest_v7()'),
    ('private.koaryu_release_operational_manifest_v8()'),
    ('private.koaryu_release_operational_manifest_v9()'),
    ('private.koaryu_release_payer_setup_recovery_manifest_v36()'),
    ('private.koaryu_release_payment_adjustment_manifest_v26()'),
    ('private.koaryu_release_payments_replay_repairs_manifest_v30()'),
    ('private.koaryu_release_provider_operation_steps_manifest_v28()'),
    ('private.koaryu_release_provider_operations_manifest_v27()'),
    ('private.koaryu_release_resource_ownership_manifest_v31()'),
    ('private.koaryu_release_schedule_window_manifest_v1()'),
    ('private.koaryu_release_schema_preflight_v14_snapshot_v34()'),
    ('private.koaryu_release_starting_belt_manifest_v9()'),
    ('private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()'),
    ('private.koaryu_release_student_rank_writer_manifest_v11()'),
    ('private.koaryu_release_student_rank_writer_manifest_v12()'),
    ('private.koaryu_release_student_rank_writer_manifest_v13()'),
    ('private.live_billing_event_is_in_scope(text,text)'),
    ('private.live_billing_ga_events_clear_v58()'),
    ('private.live_billing_ga_operations_v58(text)'),
    ('private.live_billing_operation_set_is_canonical_v1(text,text[])'),
    ('private.lock_student_import_actor(uuid)'),
    ('private.lock_student_import_run(uuid,uuid,text)'),
    ('private.maintain_billing_invoice_mutation_owner_v31()'),
    ('private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)'),
    ('private.preserve_billing_enrollment_transition_identity_v1()'),
    ('private.preserve_billing_invoice_mutation_owner_v31()'),
    ('private.preserve_billing_invoice_retry_hash_ledger_v33()'),
    ('private.preserve_billing_payer_payment_consent_v1()'),
    ('private.preserve_billing_payer_setup_request_v1()'),
    ('private.preserve_billing_provider_operation_identity_v1()'),
    ('private.preserve_billing_provider_operation_resource_alias_v1()'),
    ('private.preserve_billing_provider_operation_resource_v1()'),
    ('private.preserve_billing_provider_operation_step_v1()'),
    ('private.prevent_account_deletion_orphan()'),
    ('private.prevent_staff_admin_orphan()'),
    ('private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)'),
    ('private.recompute_billing_payment_adjustment_totals(uuid)'),
    ('private.recompute_payment_after_adjustment_change()'),
    ('private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)'),
    ('private.reject_billing_enrollment_transition_alias_mutation_v1()'),
    ('private.reject_consent_change_during_invoice_retry_v31()'),
    ('private.reject_payer_change_during_invoice_retry_v31()'),
    ('private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)'),
    ('private.set_audit_actor_legal_name()'),
    ('private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)'),
    ('private.sync_connect_identity_exclusion_guard()'),
    ('private.sync_connect_identity_mapping_guard()'),
    ('private.trial_appointment_payload_v1(public.lead_trial_appointments)'),
    ('private.trial_rebooking_marker_v1()'),
    ('private.validate_billing_adjustment_payment_identity()'),
    ('private.validate_billing_payment_identity_change()'),
    ('private.workflow_activation_immutable_v1()'),
    ('private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)'),
    ('private.workflow_blank_v1(jsonb)'),
    ('private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)'),
    ('private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])'),
    ('private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)'),
    ('private.workflow_capture_events_v1(uuid,jsonb,jsonb)'),
    ('private.workflow_capture_payment_failure_v1()'),
    ('private.workflow_catalog_v1()'),
    ('private.workflow_condition_result_v1(text,text,jsonb,jsonb)'),
    ('private.workflow_current_rank_authority_v1(uuid,uuid,uuid)'),
    ('private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])'),
    ('private.workflow_current_staff_recipient_v1(uuid,uuid)'),
    ('private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)'),
    ('private.workflow_delay_due_identity_v1()'),
    ('private.workflow_detail_v1(uuid,uuid)'),
    ('private.workflow_email_attempt_identity_v1()'),
    ('private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)'),
    ('private.workflow_email_fingerprint_v1(jsonb,jsonb)'),
    ('private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)'),
    ('private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('private.workflow_email_parameters_valid_v1(text,text[],text,text)'),
    ('private.workflow_email_payload_delete_v1()'),
    ('private.workflow_email_payload_identity_v1()'),
    ('private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)'),
    ('private.workflow_email_project_settlement_v1(uuid,boolean)'),
    ('private.workflow_email_rendered_valid_v1(jsonb)'),
    ('private.workflow_email_selected_values_v1(jsonb,jsonb)'),
    ('private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)'),
    ('private.workflow_expire_email_attempts_v1(integer)'),
    ('private.workflow_fact_text_v1(text)'),
    ('private.workflow_finalize_invoice_episode_deferred_v1()'),
    ('private.workflow_finalize_invoice_episodes_v1()'),
    ('private.workflow_finalize_rank_deferred_v1()'),
    ('private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)'),
    ('private.workflow_follow_up_receipt_identity_v1()'),
    ('private.workflow_graph_read_issues_v1(uuid,jsonb)'),
    ('private.workflow_hash_v1(jsonb)'),
    ('private.workflow_immutable_record_v1()'),
    ('private.workflow_integer_v1(jsonb,bigint,bigint)'),
    ('private.workflow_invoice_episode_context_valid_v1(jsonb)'),
    ('private.workflow_invoice_episode_identity_v1()'),
    ('private.workflow_invoice_episode_pending_identity_v1()'),
    ('private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)'),
    ('private.workflow_invoice_episode_state_identity_v1()'),
    ('private.workflow_invoice_episode_threshold_v1(date,text)'),
    ('private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_invoice_settlement_identity_v1()'),
    ('private.workflow_invoice_settlement_seed_v1()'),
    ('private.workflow_json_keys_v1(jsonb,text[],text[])'),
    ('private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)'),
    ('private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])'),
    ('private.workflow_lock_lead_assignee_v1(uuid)'),
    ('private.workflow_lock_recipient_auth_v1(uuid)'),
    ('private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)'),
    ('private.workflow_lock_timed_sources_v1(jsonb)'),
    ('private.workflow_mark_invoice_episode_v1()'),
    ('private.workflow_mark_payer_episode_demo_v1()'),
    ('private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)'),
    ('private.workflow_observe_payment_settlement_v1(uuid,uuid)'),
    ('private.workflow_payment_evidence_v1(public.billing_payments)'),
    ('private.workflow_payment_evidence_valid_v1(jsonb)'),
    ('private.workflow_payment_settlement_valid_v1(uuid,uuid)'),
    ('private.workflow_prepare_capture_v1(uuid,uuid[],boolean)'),
    ('private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)'),
    ('private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)'),
    ('private.workflow_rank_compare_pending_v1(uuid,uuid)'),
    ('private.workflow_rank_context_generation_v1(uuid,uuid,uuid)'),
    ('private.workflow_rank_context_identity_v1()'),
    ('private.workflow_rank_finalize_pending_v1(uuid)'),
    ('private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)'),
    ('private.workflow_rank_scope_enter_v1(uuid,uuid,text)'),
    ('private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)'),
    ('private.workflow_rank_tuple_v1(uuid,uuid,uuid)'),
    ('private.workflow_require_actor_v1(uuid,uuid,boolean)'),
    ('private.workflow_require_graph_tenant_v1(uuid,jsonb)'),
    ('private.workflow_run_detail_v1(uuid,uuid)'),
    ('private.workflow_run_identity_v1()'),
    ('private.workflow_run_position_v1(public.automation_workflow_runs)'),
    ('private.workflow_run_step_identity_v1()'),
    ('private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)'),
    ('private.workflow_run_subject_label_v1(private.automation_workflow_events)'),
    ('private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)'),
    ('private.workflow_semantic_graph_v1(jsonb)'),
    ('private.workflow_settlement_observation_identity_v1()'),
    ('private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)'),
    ('private.workflow_staff_auth_email_v1(uuid,uuid)'),
    ('private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)'),
    ('private.workflow_timed_candidates_v1(integer,timestamp with time zone)'),
    ('private.workflow_timer_activation_identity_v1()'),
    ('private.workflow_timer_activation_insert_v1()'),
    ('private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)'),
    ('private.workflow_trigger_event_type_v1(jsonb)'),
    ('private.workflow_typed_value_v1(jsonb,jsonb)'),
    ('private.workflow_validate_v1(jsonb,jsonb,boolean)'),
    ('private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)'),
    ('public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)'),
    ('public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)'),
    ('public.acknowledge_operational_alert(text,uuid,text,text)'),
    ('public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)'),
    ('public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.archive_students_bulk_atomic(uuid,uuid,uuid[])'),
    ('public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)'),
    ('public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)'),
    ('public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)'),
    ('public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)'),
    ('public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)'),
    ('public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)'),
    ('public.backfill_starting_belt_after_rank_delete()'),
    ('public.backfill_starting_belt_for_program()'),
    ('public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)'),
    ('public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)'),
    ('public.begin_missed_class_automation_v1(uuid,uuid,text[])'),
    ('public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)'),
    ('public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)'),
    ('public.billing_attention_count_v1(uuid,date)'),
    ('public.billing_invoice_collection_facts_v1(uuid,uuid,date)'),
    ('public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_payer_balance_facts_v1(uuid,uuid,date)'),
    ('public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.billing_webhook_health(text,boolean,timestamp with time zone)'),
    ('public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)'),
    ('public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)'),
    ('public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)'),
    ('public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)'),
    ('public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)'),
    ('public.claim_automation_sender_preparation_v1(text,uuid,text)'),
    ('public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])'),
    ('public.claim_automation_workflow_runs_v1(integer)'),
    ('public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)'),
    ('public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)'),
    ('public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)'),
    ('public.claim_due_account_deletion_requests(integer,text,integer)'),
    ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)'),
    ('public.claim_missed_class_automations_v1(integer,text[])'),
    ('public.claim_operational_alert_delivery(text,text,uuid,integer)'),
    ('public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)'),
    ('public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)'),
    ('public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)'),
    ('public.clear_studio_comp_for_billing_event(uuid,bigint)'),
    ('public.clear_studio_operational_data_atomic(uuid,boolean)'),
    ('public.clear_studio_operational_data_v2(uuid,boolean)'),
    ('public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)'),
    ('public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)'),
    ('public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)'),
    ('public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)'),
    ('public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)'),
    ('public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)'),
    ('public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)'),
    ('public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)'),
    ('public.complete_operational_alert_delivery(uuid,text,text)'),
    ('public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)'),
    ('public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)'),
    ('public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)'),
    ('public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)'),
    ('public.create_studio_onboarding(uuid,text,text,text)'),
    ('public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)'),
    ('public.dashboard_summary_facts(uuid,text,text,date,text)'),
    ('public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)'),
    ('public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])'),
    ('public.delete_recurring_class_series_atomic(uuid,uuid,uuid)'),
    ('public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)'),
    ('public.enforce_operational_alert_sent_receipt()'),
    ('public.enqueue_missed_class_automations_v1(integer,text[])'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)'),
    ('public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)'),
    ('public.fail_operational_alert_delivery(uuid,text,text,integer)'),
    ('public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)'),
    ('public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)'),
    ('public.finish_account_deletion_request(uuid,text,text,text)'),
    ('public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)'),
    ('public.finish_billing_subscription_quantity_sync(uuid,uuid,text)'),
    ('public.finish_stripe_event_processing(uuid,text,text,text)'),
    ('public.finish_stripe_event_processing_v2(uuid,text,text,text,text)'),
    ('public.finish_student_import_run(uuid,text,text,jsonb,text)'),
    ('public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.get_automation_email_credential_v1(text)'),
    ('public.get_automation_operation_v1(uuid,uuid,uuid)'),
    ('public.get_automation_sender_status_v1(text)'),
    ('public.get_automation_test_email_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_run_v1(uuid,uuid,uuid)'),
    ('public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)'),
    ('public.get_automation_workflow_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_event_v1(uuid,uuid,uuid)'),
    ('public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)'),
    ('public.get_missed_class_automation_activity_v1(uuid,uuid,integer)'),
    ('public.get_missed_class_automation_rule_v1(uuid,uuid)'),
    ('public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)'),
    ('public.heartbeat_student_import_run(uuid,text)'),
    ('public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])'),
    ('public.invalidate_core_checkout_on_comp_grant()'),
    ('public.koaryu_release_schema_preflight()'),
    ('public.koaryu_release_schema_preflight_v10()'),
    ('public.koaryu_release_schema_preflight_v11()'),
    ('public.koaryu_release_schema_preflight_v12()'),
    ('public.koaryu_release_schema_preflight_v13()'),
    ('public.koaryu_release_schema_preflight_v14()'),
    ('public.koaryu_release_schema_preflight_v15()'),
    ('public.koaryu_release_schema_preflight_v16()'),
    ('public.koaryu_release_schema_preflight_v17()'),
    ('public.koaryu_release_schema_preflight_v18()'),
    ('public.koaryu_release_schema_preflight_v19()'),
    ('public.koaryu_release_schema_preflight_v2()'),
    ('public.koaryu_release_schema_preflight_v20()'),
    ('public.koaryu_release_schema_preflight_v21()'),
    ('public.koaryu_release_schema_preflight_v22()'),
    ('public.koaryu_release_schema_preflight_v23()'),
    ('public.koaryu_release_schema_preflight_v24()'),
    ('public.koaryu_release_schema_preflight_v25()'),
    ('public.koaryu_release_schema_preflight_v26()'),
    ('public.koaryu_release_schema_preflight_v27()'),
    ('public.koaryu_release_schema_preflight_v28()'),
    ('public.koaryu_release_schema_preflight_v29()'),
    ('public.koaryu_release_schema_preflight_v3()'),
    ('public.koaryu_release_schema_preflight_v30()'),
    ('public.koaryu_release_schema_preflight_v31()'),
    ('public.koaryu_release_schema_preflight_v32()'),
    ('public.koaryu_release_schema_preflight_v33()'),
    ('public.koaryu_release_schema_preflight_v34()'),
    ('public.koaryu_release_schema_preflight_v35()'),
    ('public.koaryu_release_schema_preflight_v36()'),
    ('public.koaryu_release_schema_preflight_v37()'),
    ('public.koaryu_release_schema_preflight_v38()'),
    ('public.koaryu_release_schema_preflight_v4()'),
    ('public.koaryu_release_schema_preflight_v5()'),
    ('public.koaryu_release_schema_preflight_v6()'),
    ('public.koaryu_release_schema_preflight_v7()'),
    ('public.koaryu_release_schema_preflight_v8()'),
    ('public.koaryu_release_schema_preflight_v9()'),
    ('public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)'),
    ('public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])'),
    ('public.list_billing_payers_v1(uuid,uuid,date)'),
    ('public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)'),
    ('public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)'),
    ('public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)'),
    ('public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)'),
    ('public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)'),
    ('public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)'),
    ('public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.materialize_recurring_class_sessions(uuid,date,date)'),
    ('public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)'),
    ('public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)'),
    ('public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)'),
    ('public.operational_alert_heartbeats(text)'),
    ('public.operational_alert_metric_counts()'),
    ('public.preflight_connect_onboarding_bootstrap_begin(uuid,text)'),
    ('public.preflight_connect_onboarding_bootstrap_resume(uuid,text)'),
    ('public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)'),
    ('public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)'),
    ('public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)'),
    ('public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)'),
    ('public.preserve_billing_invoice_retry_operation_created_at()'),
    ('public.preserve_studio_comp_provenance()'),
    ('public.prevent_operational_alert_append_only_mutation()'),
    ('public.preview_missed_class_automation_v1(uuid,uuid,integer)'),
    ('public.process_automation_workflow_occurrences_v1(integer)'),
    ('public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)'),
    ('public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)'),
    ('public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)'),
    ('public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)'),
    ('public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)'),
    ('public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)'),
    ('public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)'),
    ('public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)'),
    ('public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])'),
    ('public.reassign_memberships_before_belt_rank_delete()'),
    ('public.recompute_billing_invoice_external_payment_totals(uuid,uuid)'),
    ('public.recompute_billing_payer_balance_v1(uuid,uuid)'),
    ('public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)'),
    ('public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)'),
    ('public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)'),
    ('public.record_operational_alert_heartbeat(text,text,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)'),
    ('public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)'),
    ('public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)'),
    ('public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)'),
    ('public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)'),
    ('public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)'),
    ('public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)'),
    ('public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)'),
    ('public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)'),
    ('public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)'),
    ('public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)'),
    ('public.reserve_core_checkout_atomic(uuid)'),
    ('public.reserve_core_checkout_v2_atomic(uuid)'),
    ('public.reset_stripe_connect_account_atomic_v58(uuid,uuid,text,integer)'),
    ('public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)'),
    ('public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)'),
    ('public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)'),
    ('public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)'),
    ('public.save_automation_email_credential_v1(text,bigint,text)'),
    ('public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)'),
    ('public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)'),
    ('public.schedule_window_read(uuid,date,date,text)'),
    ('public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)'),
    ('public.set_student_is_minor()'),
    ('public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)'),
    ('public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)'),
    ('public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)'),
    ('public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)'),
    ('public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)'),
    ('public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)'),
    ('public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)'),
    ('public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)'),
    ('public.snapshot_promotion_rank_identity()'),
    ('public.soft_delete_student_atomic(uuid,uuid,uuid)'),
    ('public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)'),
    ('public.student_business_date(uuid)'),
    ('public.studio_live_billing_supported_operations_v58(uuid,text)'),
    ('public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)'),
    ('public.support_triage_digest(integer)'),
    ('public.support_triage_list_tickets(text[],text[],text[],integer)'),
    ('public.support_triage_update_ticket(uuid,text,text,jsonb)'),
    ('public.suppress_missed_class_automation_v1(text)'),
    ('public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)'),
    ('public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)'),
    ('public.sync_primary_student_rank_from_membership()'),
    ('public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)'),
    ('public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)'),
    ('public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)'),
    ('public.update_lead_atomic(uuid,uuid,uuid,jsonb)'),
    ('public.update_updated_at_column()'),
    ('public.validate_attendance_program_integrity()'),
    ('public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)'),
    ('public.validate_billing_adjustment_refs()'),
    ('public.validate_billing_dispute_refs()'),
    ('public.validate_billing_invoice_item_refs()'),
    ('public.validate_billing_invoice_refs()'),
    ('public.validate_billing_payer_guardian()'),
    ('public.validate_billing_payment_refs()'),
    ('public.validate_billing_plan_program()'),
    ('public.validate_billing_refund_refs()'),
    ('public.validate_billing_subscription_refs()'),
    ('public.validate_class_session_program_integrity()'),
    ('public.validate_class_template_program_integrity()'),
    ('public.validate_lead_program_integrity()'),
    ('public.validate_student_billing_enrollment()'),
    ('public.validate_student_birth_date()'),
    ('public.validate_student_guardian_tenant_integrity()'),
    ('public.validate_student_profile_tenant_integrity()'),
    ('public.validate_student_program_membership()'),
    ('public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])'),
    ('public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)'),
    ('public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)')) required(signature)
LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(required.signature)
LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang)::TEXT,'UTF8'),'sha256'),'hex'))
       IS DISTINCT FROM '0068d8ee28c824a8a34ce020a6c81ec3f3d8aeb9f1a2a81f545ede3c52b214b2'
       OR (SELECT array_agg(p.oid::REGPROCEDURE::TEXT ORDER BY p.oid::REGPROCEDURE::TEXT COLLATE "C")
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname IN ('public','private') AND p.prokind='f'
             AND p.oid <> pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v39()'))
          IS DISTINCT FROM ARRAY['private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)','private.automation_bind_unsubscribe_token_v1(uuid,text,text)','private.automation_clear_statement_fence_v1()','private.automation_core_entitled(uuid)','private.automation_delivery_immutable()','private.automation_delivery_result_v1(jsonb,bigint)','private.automation_email_attempt_begin_v1(uuid,text,uuid,text,uuid,uuid,text,uuid,uuid,uuid,integer)','private.automation_email_attempt_expire_v1(uuid)','private.automation_email_attempt_identity_v1()','private.automation_email_attempt_settle_v1(uuid,uuid,jsonb)','private.automation_email_scope_lock_v1(uuid,text,uuid,text,text)','private.automation_expire_orphaned_legacy_attempts_v1(integer)','private.automation_has_actionable_work(text[])','private.automation_instant_v1(jsonb)','private.automation_legacy_begin_v1(uuid,uuid,text[],uuid,uuid,uuid)','private.automation_legacy_delivery_delete_v1()','private.automation_legacy_delivery_result_v1(jsonb)','private.automation_legacy_delivery_transition_v1()','private.automation_legacy_projection_pin_v1(uuid,uuid,jsonb)','private.automation_legacy_projection_valid_v1(jsonb)','private.automation_legacy_settle_v1(uuid,uuid,uuid,jsonb)','private.automation_legacy_terminal_v1(jsonb,integer)','private.automation_normalize_email(text)','private.automation_require_admin(uuid,uuid)','private.automation_sender_claim_v1(uuid,text,text,uuid)','private.automation_sender_failure_v1(text,text,bigint,integer,timestamp with time zone)','private.automation_sender_gate_identity_v1()','private.automation_sender_gate_lock_v1()','private.automation_sender_instant_v1(timestamp with time zone)','private.automation_sender_preparation_identity_v1()','private.automation_sender_preparation_reply_v1(uuid,private.automation_sender_gate,private.automation_sender_preparations,text,text)','private.automation_sender_preparation_result_valid_v1(jsonb)','private.automation_sender_preparation_settle_v1(uuid,uuid,jsonb)','private.automation_sender_release_orphan_probe_v1()','private.automation_sender_release_probe_v1(uuid,uuid,uuid)','private.automation_sender_retry_at_v1(private.automation_sender_gate,timestamp with time zone)','private.automation_test_actor_v1(uuid,uuid)','private.automation_test_allowed_v1(text[])','private.automation_test_clear_owned_v1(uuid)','private.automation_test_execution_v1(private.automation_test_email_scopes,jsonb)','private.automation_test_expire_v1(private.automation_test_email_scopes)','private.automation_test_fail_v1(private.automation_test_email_scopes,text)','private.automation_test_invalidate_queued_v1(uuid)','private.automation_test_original_v1(uuid,uuid,uuid)','private.automation_test_own_v1(uuid,uuid,uuid,uuid,text[])','private.automation_test_payload_delete_v1()','private.automation_test_payload_identity_v1()','private.automation_test_rendered_valid_v1(jsonb)','private.automation_test_result_v1(private.automation_test_email_scopes)','private.automation_test_scope_identity_v1()','private.automation_test_verified_email_v1(uuid)','private.automation_timezone_v1(jsonb)','private.automation_unsubscribe_binding_identity_v1()','private.automation_utc_text_v1(timestamp with time zone)','private.belt_test_cancel_recipient_runs_v1(uuid,uuid[],timestamp with time zone)','private.belt_test_event_payload_v1(public.belt_test_events)','private.belt_test_lock_recipient_runs_v1(uuid,uuid[])','private.belt_test_name_v1(jsonb)','private.belt_test_recipient_identity_v1()','private.belt_test_recipient_payload_v1(public.belt_test_recipients)','private.billing_enrollment_item_schedule_completed_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_phase_succeeded_v31(public.billing_provider_operations,public.billing_enrollment_transition_intents)','private.billing_enrollment_item_schedule_pre_provider_rejected_v31(public.billing_provider_operations)','private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)','private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)','private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)','private.billing_operation_resource_version_v31(text,public.billing_payments,public.billing_payers,text,integer)','private.billing_payer_payment_consent_json_v1(public.billing_payer_payment_consents,text)','private.billing_payer_setup_request_json_v1(public.billing_payer_setup_requests,text)','private.billing_plan_resource_version_v31(public.billing_plans,text,integer)','private.billing_provider_operation_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_resource_json_v1(public.billing_provider_operation_resources,public.billing_provider_operations,text,text)','private.billing_provider_operation_step_json_v1(public.billing_provider_operation_steps)','private.billing_provider_operation_step_plan_json_v1(public.billing_provider_operations,text)','private.billing_provider_operation_step_result_json_v1(public.billing_provider_operations,public.billing_provider_operation_steps,text)','private.bind_live_billing_authorization_checkpoint()','private.can_read_staff_profile(uuid)','private.capture_billing_invoice_retry_alias_v33()','private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)','private.capture_billing_invoice_retry_resource_v33()','private.claim_billing_invoice_mutation_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_payment_payer_operation_resource_v31(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','private.claim_student_import_run_owned(uuid,uuid,text,text,text,text,boolean,integer)','private.clear_studio_operational_data_v2(uuid,boolean)','private.connect_onboarding_bootstrap_link_checkpoint(uuid,text)','private.connect_onboarding_ga_initial_link_eligible_v58(uuid,text)','private.current_connect_account_generation(jsonb)','private.deterministic_import_uuid(uuid,text)','private.enforce_billing_payer_connect_identity_v1()','private.enforce_billing_payment_refundable_amount_v31()','private.enforce_billing_provider_step_parent_v1()','private.enforce_live_billing_checkpoint_processed_events()','private.enforce_single_studio_membership()','private.handle_invoice_retry_consent_change_v33(uuid,uuid)','private.has_unambiguous_studio_membership()','private.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','private.is_admin_in_studio(uuid)','private.is_admin_or_front_desk_in_studio(uuid)','private.is_staff_in_studio(uuid)','private.koaryu_release_adjustment_trigger_guard_manifest_v37()','private.koaryu_release_critical_surface_manifest_v14()','private.koaryu_release_critical_surface_manifest_v15()','private.koaryu_release_critical_surface_manifest_v16()','private.koaryu_release_critical_surface_manifest_v17()','private.koaryu_release_critical_surface_manifest_v18()','private.koaryu_release_enrollment_transition_manifest_v29()','private.koaryu_release_invoice_retry_closeout_manifest_v34()','private.koaryu_release_invoice_retry_compatibility_manifest_v33()','private.koaryu_release_invoice_retry_preread_manifest_v32()','private.koaryu_release_live_billing_v3_manifest_v25()','private.koaryu_release_operational_contract_v25()','private.koaryu_release_operational_contract_v26()','private.koaryu_release_operational_contract_v27()','private.koaryu_release_operational_contract_v28()','private.koaryu_release_operational_contract_v29()','private.koaryu_release_operational_contract_v30()','private.koaryu_release_operational_contract_v31()','private.koaryu_release_operational_manifest_v10()','private.koaryu_release_operational_manifest_v11()','private.koaryu_release_operational_manifest_v12()','private.koaryu_release_operational_manifest_v2()','private.koaryu_release_operational_manifest_v2_base()','private.koaryu_release_operational_manifest_v4()','private.koaryu_release_operational_manifest_v5()','private.koaryu_release_operational_manifest_v6()','private.koaryu_release_operational_manifest_v7()','private.koaryu_release_operational_manifest_v8()','private.koaryu_release_operational_manifest_v9()','private.koaryu_release_payer_setup_recovery_manifest_v36()','private.koaryu_release_payment_adjustment_manifest_v26()','private.koaryu_release_payments_replay_repairs_manifest_v30()','private.koaryu_release_provider_operation_steps_manifest_v28()','private.koaryu_release_provider_operations_manifest_v27()','private.koaryu_release_resource_ownership_manifest_v31()','private.koaryu_release_schedule_window_manifest_v1()','private.koaryu_release_schema_preflight_v14_snapshot_v34()','private.koaryu_release_starting_belt_manifest_v9()','private.koaryu_release_stripe_rehearsal_evidence_manifest_v35()','private.koaryu_release_student_rank_writer_manifest_v11()','private.koaryu_release_student_rank_writer_manifest_v12()','private.koaryu_release_student_rank_writer_manifest_v13()','private.live_billing_event_is_in_scope(text,text)','private.live_billing_ga_events_clear_v58()','private.live_billing_ga_operations_v58(text)','private.live_billing_operation_set_is_canonical_v1(text,text[])','private.lock_student_import_actor(uuid)','private.lock_student_import_run(uuid,uuid,text)','private.maintain_billing_invoice_mutation_owner_v31()','private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)','private.preserve_billing_enrollment_transition_identity_v1()','private.preserve_billing_invoice_mutation_owner_v31()','private.preserve_billing_invoice_retry_hash_ledger_v33()','private.preserve_billing_payer_payment_consent_v1()','private.preserve_billing_payer_setup_request_v1()','private.preserve_billing_provider_operation_identity_v1()','private.preserve_billing_provider_operation_resource_alias_v1()','private.preserve_billing_provider_operation_resource_v1()','private.preserve_billing_provider_operation_step_v1()','private.prevent_account_deletion_orphan()','private.prevent_staff_admin_orphan()','private.rank_transition_fingerprint_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text)','private.recompute_billing_payment_adjustment_totals(uuid)','private.recompute_payment_after_adjustment_change()','private.record_student_rank_transition_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','private.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,boolean)','private.reject_billing_enrollment_transition_alias_mutation_v1()','private.reject_consent_change_during_invoice_retry_v31()','private.reject_payer_change_during_invoice_retry_v31()','private.resolve_billing_invoice_retry_identity_v33(uuid,uuid,uuid,uuid)','private.set_audit_actor_legal_name()','private.stripe_rehearsal_manifest_ids_v35(jsonb,text,boolean)','private.sync_connect_identity_exclusion_guard()','private.sync_connect_identity_mapping_guard()','private.trial_appointment_payload_v1(public.lead_trial_appointments)','private.trial_rebooking_marker_v1()','private.validate_billing_adjustment_payment_identity()','private.validate_billing_payment_identity_change()','private.workflow_activation_immutable_v1()','private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)','private.workflow_blank_v1(jsonb)','private.workflow_cancel_pending_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_cancel_runs_v1(uuid,uuid[],timestamp with time zone,text)','private.workflow_cancel_settled_invoice_runs_v1(uuid,uuid[])','private.workflow_cancel_source_pending_v1(uuid,text,uuid,timestamp with time zone,text)','private.workflow_capture_events_v1(uuid,jsonb,jsonb)','private.workflow_capture_payment_failure_v1()','private.workflow_catalog_v1()','private.workflow_condition_result_v1(text,text,jsonb,jsonb)','private.workflow_current_rank_authority_v1(uuid,uuid,uuid)','private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])','private.workflow_current_staff_recipient_v1(uuid,uuid)','private.workflow_defer_owned_run_v1(uuid,uuid,timestamp with time zone,text)','private.workflow_delay_due_identity_v1()','private.workflow_detail_v1(uuid,uuid)','private.workflow_email_attempt_identity_v1()','private.workflow_email_attempt_payload_v1(private.automation_workflow_email_attempts)','private.workflow_email_fingerprint_v1(jsonb,jsonb)','private.workflow_email_finish_step_v1(uuid,uuid,uuid,text,timestamp with time zone,text,text,boolean)','private.workflow_email_own_v1(uuid,uuid,uuid,text,text,text[],text,text)','private.workflow_email_parameters_valid_v1(text,text[],text,text)','private.workflow_email_payload_delete_v1()','private.workflow_email_payload_identity_v1()','private.workflow_email_plan_v1(public.automation_workflow_runs,private.automation_workflow_events,jsonb,jsonb,timestamp with time zone,text,text[],text,text)','private.workflow_email_project_settlement_v1(uuid,boolean)','private.workflow_email_rendered_valid_v1(jsonb)','private.workflow_email_selected_values_v1(jsonb,jsonb)','private.workflow_email_source_inventory_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_enroll_timed_occurrence_v1(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone)','private.workflow_expire_email_attempts_v1(integer)','private.workflow_fact_text_v1(text)','private.workflow_finalize_invoice_episode_deferred_v1()','private.workflow_finalize_invoice_episodes_v1()','private.workflow_finalize_rank_deferred_v1()','private.workflow_financial_identity_valid_v1(public.billing_invoices,public.billing_payers,public.studio_payment_accounts,public.billing_payments)','private.workflow_follow_up_receipt_identity_v1()','private.workflow_graph_read_issues_v1(uuid,jsonb)','private.workflow_hash_v1(jsonb)','private.workflow_immutable_record_v1()','private.workflow_integer_v1(jsonb,bigint,bigint)','private.workflow_invoice_episode_context_valid_v1(jsonb)','private.workflow_invoice_episode_identity_v1()','private.workflow_invoice_episode_pending_identity_v1()','private.workflow_invoice_episode_projection_v1(public.billing_invoices,public.billing_payers)','private.workflow_invoice_episode_state_identity_v1()','private.workflow_invoice_episode_threshold_v1(date,text)','private.workflow_invoice_financial_context_v1(uuid,uuid,uuid)','private.workflow_invoice_settlement_identity_v1()','private.workflow_invoice_settlement_seed_v1()','private.workflow_json_keys_v1(jsonb,text[],text[])','private.workflow_lock_email_sources_v1(uuid,private.automation_workflow_events,jsonb,text)','private.workflow_lock_financial_sources_v1(uuid,uuid,uuid[])','private.workflow_lock_lead_assignee_v1(uuid)','private.workflow_lock_recipient_auth_v1(uuid)','private.workflow_lock_run_sources_v1(uuid,private.automation_workflow_events,jsonb)','private.workflow_lock_timed_sources_v1(jsonb)','private.workflow_mark_invoice_episode_v1()','private.workflow_mark_payer_episode_demo_v1()','private.workflow_mutate_v1(uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,jsonb,boolean,boolean)','private.workflow_observe_payment_settlement_v1(uuid,uuid)','private.workflow_payment_evidence_v1(public.billing_payments)','private.workflow_payment_evidence_valid_v1(jsonb)','private.workflow_payment_settlement_valid_v1(uuid,uuid)','private.workflow_prepare_capture_v1(uuid,uuid[],boolean)','private.workflow_prepare_financial_context_v1(uuid,uuid,uuid)','private.workflow_queue_invoice_episode_v1(uuid,uuid,boolean,boolean,boolean,text)','private.workflow_rank_compare_pending_v1(uuid,uuid)','private.workflow_rank_context_generation_v1(uuid,uuid,uuid)','private.workflow_rank_context_identity_v1()','private.workflow_rank_finalize_pending_v1(uuid)','private.workflow_rank_mark_dirty_v1(uuid,uuid,uuid,boolean)','private.workflow_rank_scope_enter_v1(uuid,uuid,text)','private.workflow_rank_scope_finish_v1(uuid,uuid,jsonb)','private.workflow_rank_tuple_v1(uuid,uuid,uuid)','private.workflow_require_actor_v1(uuid,uuid,boolean)','private.workflow_require_graph_tenant_v1(uuid,jsonb)','private.workflow_run_detail_v1(uuid,uuid)','private.workflow_run_identity_v1()','private.workflow_run_position_v1(public.automation_workflow_runs)','private.workflow_run_step_identity_v1()','private.workflow_run_step_payload_v1(private.automation_workflow_run_steps)','private.workflow_run_subject_label_v1(private.automation_workflow_events)','private.workflow_run_summary_payload_v1(public.automation_workflow_runs,private.automation_workflow_events,public.automation_workflow_versions,text)','private.workflow_semantic_graph_v1(jsonb)','private.workflow_settlement_observation_identity_v1()','private.workflow_simulation_projection_v1(uuid,uuid,jsonb,jsonb,timestamp with time zone)','private.workflow_staff_auth_email_v1(uuid,uuid)','private.workflow_student_enrollment_event_v1(uuid,uuid,jsonb)','private.workflow_timed_candidates_v1(integer,timestamp with time zone)','private.workflow_timer_activation_identity_v1()','private.workflow_timer_activation_insert_v1()','private.workflow_transition_owned_v1(uuid,uuid,uuid,integer,text)','private.workflow_trigger_event_type_v1(jsonb)','private.workflow_typed_value_v1(jsonb,jsonb)','private.workflow_validate_v1(jsonb,jsonb,boolean)','private.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.accept_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,text,timestamp with time zone)','public.accept_core_checkout_completion_atomic(uuid,uuid,bigint,text,bigint)','public.accept_core_checkout_subscription_atomic(uuid,uuid,bigint,text,text,bigint)','public.acknowledge_connect_onboarding_bootstrap_initial_link_delivery(uuid,text,text)','public.acknowledge_operational_alert(text,uuid,text,text)','public.advance_automation_workflow_run_v1(uuid,uuid,uuid,integer)','public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.archive_students_bulk_atomic(uuid,uuid,uuid[])','public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)','public.authorize_billing_provider_operation_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_recovery_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,text,text,text,uuid,integer,bigint)','public.authorize_billing_provider_operation_step_recovery_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,text,text,uuid,integer,bigint)','public.authorize_connect_onboarding_bootstrap_account_create(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_account_create_v2(uuid,uuid,text,integer,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link(uuid,text,integer,text,text,text,text,text)','public.authorize_connect_onboarding_bootstrap_initial_link_v2(uuid,uuid,text,integer,text,text,text,text)','public.authorize_studio_live_billing_mutation_atomic(uuid,text,text,text,text)','public.authorize_studio_live_billing_scope_v3(uuid,text,text,text,text)','public.backfill_starting_belt_after_rank_delete()','public.backfill_starting_belt_for_program()','public.begin_automation_test_email_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text[],text,jsonb)','public.begin_billing_enrollment_activation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,uuid,text,text)','public.begin_missed_class_automation_v1(uuid,uuid,text[])','public.begin_missed_class_automation_v2(uuid,uuid,uuid,uuid,text[],uuid)','public.begin_workflow_email_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb,uuid,uuid,uuid)','public.billing_attention_count_v1(uuid,date)','public.billing_invoice_collection_facts_v1(uuid,uuid,date)','public.billing_landing_aggregates(uuid,timestamp with time zone,timestamp with time zone)','public.billing_payer_balance_facts_v1(uuid,uuid,date)','public.billing_payment_cohort(uuid,timestamp with time zone,timestamp with time zone)','public.billing_webhook_health(text,boolean,timestamp with time zone)','public.bind_billing_payer_setup_session_v1(uuid,uuid,uuid,uuid,text,text,integer,bigint)','public.bind_connect_onboarding_bootstrap_account(uuid,text,integer,text,text,text)','public.bind_connect_onboarding_bootstrap_account_v2(uuid,uuid,text,integer,text,text)','public.bind_student_import_rank_v1(uuid,uuid,text,uuid,text,uuid)','public.cancel_automation_workflow_run_v1(uuid,uuid,uuid,uuid,bigint)','public.claim_automation_sender_preparation_v1(text,uuid,text)','public.claim_automation_test_sender_preparation_v1(uuid,uuid,uuid,uuid,uuid,text,text[])','public.claim_automation_workflow_runs_v1(integer)','public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_enrollment_transition_v29(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)','public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_invoice_closeout_operation_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_resource_v30(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)','public.claim_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,integer)','public.claim_billing_provider_operation_v1(uuid,uuid,text,text,text,text,integer,uuid,integer)','public.claim_billing_subscription_quantity_sync(uuid,uuid,text,integer)','public.claim_due_account_deletion_requests(integer,text,integer)','public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)','public.claim_missed_class_automations_v1(integer,text[])','public.claim_operational_alert_delivery(text,text,uuid,integer)','public.claim_stripe_event_for_processing(text,text,boolean,text,jsonb,text,integer)','public.claim_student_import_run(uuid,uuid,text,text,text,text,integer)','public.claim_student_import_run_v2(uuid,uuid,text,text,text,text,integer)','public.clear_studio_comp_for_billing_event(uuid,bigint)','public.clear_studio_operational_data_atomic(uuid,boolean)','public.clear_studio_operational_data_v2(uuid,boolean)','public.close_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,text,text,integer,text,text)','public.command_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,boolean,boolean)','public.complete_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,text,text,integer,timestamp with time zone)','public.complete_billing_provider_operation_provider_phase_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint)','public.complete_billing_provider_operation_provider_phase_v31(uuid,uuid,uuid,text,text,text,text,integer,text,integer,bigint,uuid)','public.complete_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text)','public.complete_due_billing_enrollment_item_transition_v31(uuid,uuid,uuid,bigint,text,jsonb)','public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)','public.complete_operational_alert_delivery(uuid,text,text)','public.convert_lead_to_student_atomic(uuid,uuid,uuid,uuid,uuid,text,date,uuid,uuid)','public.create_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb,text,jsonb,boolean)','public.create_automation_workflow_v1(uuid,uuid,uuid,text,text,jsonb,jsonb)','public.create_lead_atomic_v1(uuid,uuid,uuid,jsonb)','public.create_studio_onboarding(uuid,text,text,text)','public.create_support_ticket(uuid,uuid,text,text,text,text,text,text,text,text,jsonb)','public.dashboard_summary_facts(uuid,text,text,date,text)','public.defer_automation_workflow_run_v1(uuid,uuid,uuid,text)','public.defer_missed_class_automation_studio_v1(uuid,uuid,text,text[])','public.delete_recurring_class_series_atomic(uuid,uuid,uuid)','public.disable_billing_payer_autopay_v1(uuid,uuid,uuid,timestamp with time zone,text)','public.enforce_operational_alert_sent_receipt()','public.enqueue_missed_class_automations_v1(integer,text[])','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,integer,text,text,text)','public.evaluate_operational_alert(text,text,bigint,integer,integer,text,text,text,text)','public.fail_operational_alert_delivery(uuid,text,text,integer)','public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)','public.finalize_billing_payer_setup_projection_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer)','public.finish_account_deletion_request(uuid,text,text,text)','public.finish_automation_test_email_preflight_v1(uuid,uuid,uuid,text)','public.finish_billing_subscription_quantity_sync(uuid,uuid,text)','public.finish_stripe_event_processing(uuid,text,text,text)','public.finish_stripe_event_processing_v2(uuid,text,text,text,text)','public.finish_student_import_run(uuid,text,text,jsonb,text)','public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)','public.get_automation_email_credential_v1(text)','public.get_automation_operation_v1(uuid,uuid,uuid)','public.get_automation_sender_status_v1(text)','public.get_automation_test_email_v1(uuid,uuid,uuid)','public.get_automation_workflow_run_v1(uuid,uuid,uuid)','public.get_automation_workflow_simulation_facts_v1(uuid,uuid,uuid,jsonb,jsonb)','public.get_automation_workflow_v1(uuid,uuid,uuid)','public.get_belt_test_event_v1(uuid,uuid,uuid)','public.get_belt_test_recipient_v1(uuid,uuid,uuid,uuid)','public.get_lead_trial_appointment_v1(uuid,uuid,uuid,uuid)','public.get_missed_class_automation_activity_v1(uuid,uuid,integer)','public.get_missed_class_automation_rule_v1(uuid,uuid)','public.get_workflow_email_plan_v1(uuid,uuid,uuid,text,text,text[],text,text)','public.heartbeat_student_import_run(uuid,text)','public.import_student_row_atomic(jsonb,uuid,uuid,text,integer,text,text,text,text,uuid[])','public.invalidate_core_checkout_on_comp_grant()','public.koaryu_release_schema_preflight()','public.koaryu_release_schema_preflight_v10()','public.koaryu_release_schema_preflight_v11()','public.koaryu_release_schema_preflight_v12()','public.koaryu_release_schema_preflight_v13()','public.koaryu_release_schema_preflight_v14()','public.koaryu_release_schema_preflight_v15()','public.koaryu_release_schema_preflight_v16()','public.koaryu_release_schema_preflight_v17()','public.koaryu_release_schema_preflight_v18()','public.koaryu_release_schema_preflight_v19()','public.koaryu_release_schema_preflight_v2()','public.koaryu_release_schema_preflight_v20()','public.koaryu_release_schema_preflight_v21()','public.koaryu_release_schema_preflight_v22()','public.koaryu_release_schema_preflight_v23()','public.koaryu_release_schema_preflight_v24()','public.koaryu_release_schema_preflight_v25()','public.koaryu_release_schema_preflight_v26()','public.koaryu_release_schema_preflight_v27()','public.koaryu_release_schema_preflight_v28()','public.koaryu_release_schema_preflight_v29()','public.koaryu_release_schema_preflight_v3()','public.koaryu_release_schema_preflight_v30()','public.koaryu_release_schema_preflight_v31()','public.koaryu_release_schema_preflight_v32()','public.koaryu_release_schema_preflight_v33()','public.koaryu_release_schema_preflight_v34()','public.koaryu_release_schema_preflight_v35()','public.koaryu_release_schema_preflight_v36()','public.koaryu_release_schema_preflight_v37()','public.koaryu_release_schema_preflight_v38()','public.koaryu_release_schema_preflight_v4()','public.koaryu_release_schema_preflight_v5()','public.koaryu_release_schema_preflight_v6()','public.koaryu_release_schema_preflight_v7()','public.koaryu_release_schema_preflight_v8()','public.koaryu_release_schema_preflight_v9()','public.list_automation_workflow_runs_v1(uuid,uuid,uuid,integer,jsonb)','public.list_automation_workflows_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_events_v1(uuid,uuid,integer,jsonb)','public.list_belt_test_recipients_v1(uuid,uuid,uuid,integer,jsonb)','public.list_billing_enrollment_scheduled_transitions_v1(uuid,uuid[])','public.list_billing_payers_v1(uuid,uuid,date)','public.list_lead_trial_appointments_v1(uuid,uuid,uuid,integer,jsonb)','public.list_student_ids_for_program_filter(uuid,uuid,text,text,text,text,integer,integer)','public.list_student_roster(uuid,text,text,uuid,integer,text,date,text,text,integer,text,uuid,text)','public.load_connect_onboarding_bootstrap_recovery_context(uuid,text)','public.mark_billing_enrollment_due_pre_provider_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_enrollment_due_readback_reconciliation_v1(uuid,uuid,uuid,bigint,text,text)','public.mark_billing_payer_setup_reconciliation_v1(uuid,uuid,text,text,text,integer,text)','public.mark_billing_provider_recovery_reconciliation_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.materialize_recurring_class_sessions(uuid,date,date)','public.mutate_belt_test_event_v1(uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_lead_trial_appointment_v1(uuid,uuid,uuid,uuid,uuid,bigint,jsonb)','public.mutate_student_program_membership_atomic(uuid,uuid,uuid,text,uuid,jsonb)','public.mutate_students_bulk_atomic(uuid,uuid,uuid[],text,text[],text[],text)','public.operational_alert_heartbeats(text)','public.operational_alert_metric_counts()','public.preflight_connect_onboarding_bootstrap_begin(uuid,text)','public.preflight_connect_onboarding_bootstrap_resume(uuid,text)','public.prepare_billing_payer_setup_request_v1(uuid,uuid,uuid,uuid,uuid,text,text,integer,uuid,bigint,timestamp with time zone)','public.prepare_connect_onboarding_bootstrap_atomic(uuid,text,integer,jsonb,text,text,text,text)','public.prepare_student_import_belts_v1(uuid,uuid,text,uuid,uuid,jsonb,boolean)','public.prepare_student_import_program_v1(uuid,uuid,text,text,uuid,text,uuid,boolean,boolean)','public.preserve_billing_invoice_retry_operation_created_at()','public.preserve_studio_comp_provenance()','public.prevent_operational_alert_append_only_mutation()','public.preview_missed_class_automation_v1(uuid,uuid,integer)','public.process_automation_workflow_occurrences_v1(integer)','public.publish_core_checkout_atomic(uuid,uuid,bigint,text,text,bigint)','public.read_active_billing_payer_payment_consent_v1(uuid,uuid,text,text,integer)','public.read_billing_enrollment_item_schedule_identity_v31(uuid,uuid)','public.read_billing_enrollment_transition_by_key_v1(uuid,uuid,text,text,text,uuid)','public.read_billing_payer_setup_request_v1(uuid,uuid,uuid,text,integer)','public.read_billing_payer_setup_webhook_v1(uuid,text,text,integer)','public.read_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,text)','public.read_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer)','public.read_stripe_rehearsal_local_evidence_v1(uuid,text,integer,timestamp with time zone,timestamp with time zone,jsonb,uuid[],uuid,text[],text[])','public.reassign_memberships_before_belt_rank_delete()','public.recompute_billing_invoice_external_payment_totals(uuid,uuid)','public.recompute_billing_payer_balance_v1(uuid,uuid)','public.record_connect_onboarding_bootstrap_initial_link_response(uuid,uuid,text,integer,text,text,text,text,text,text)','public.record_core_checkout_compensation_required_atomic(uuid,text,text,bigint,text,boolean)','public.record_external_payment_v1(uuid,uuid,uuid,integer,text,text,text,text,text)','public.record_operational_alert_heartbeat(text,text,text)','public.record_stripe_live_billing_reconciliation_checkpoint(text,integer,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,boolean,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v2(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_stripe_live_billing_reconciliation_checkpoint_v3(jsonb,timestamp with time zone,text,text,uuid,text)','public.record_student_demotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_demotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_promotion(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text)','public.record_student_promotion_v2(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid)','public.record_student_rank_transition_v3(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)','public.register_billing_provider_operation_step_plan_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,integer,jsonb)','public.reject_billing_autopay_activation_without_provider_v31(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,text,text,bigint)','public.reject_billing_payer_setup_without_provider_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,integer,uuid,bigint,bigint)','public.reject_billing_provider_recovery_source_drift_v2(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text)','public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)','public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)','public.release_core_checkout_reservation_atomic(uuid,uuid,bigint)','public.reserve_billing_autopay_activation_v31(uuid,uuid,uuid,uuid,uuid,text,integer,text,text,numeric)','public.reserve_core_checkout_atomic(uuid)','public.reserve_core_checkout_v2_atomic(uuid)','public.reset_stripe_connect_account_atomic_v58(uuid,uuid,text,integer)','public.resolve_workflow_email_without_attempt_v1(uuid,uuid,uuid,text,text,text,text[],text,text,jsonb)','public.revoke_belt_test_recipient_v1(uuid,uuid,uuid,uuid,uuid,bigint)','public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)','public.revoke_billing_payer_payment_consent_v1(uuid,uuid,uuid,text,integer,timestamp with time zone,uuid,text,text)','public.save_automation_email_credential_v1(text,bigint,text)','public.save_automation_workflow_v1(uuid,uuid,uuid,uuid,bigint,text,text,jsonb,jsonb)','public.save_missed_class_automation_rule_v1(uuid,uuid,bigint,boolean,integer,text,text,text)','public.schedule_window_read(uuid,date,date,text)','public.set_stripe_connect_account_exclusion_atomic(text,boolean,text,uuid,text)','public.set_student_is_minor()','public.set_studio_comp_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_comp_v2_atomic(uuid,boolean,text,uuid,text,boolean)','public.set_studio_live_billing_authorization_atomic(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.set_studio_live_billing_authorization_operations_v1(uuid,text,boolean,timestamp with time zone,text,uuid,text[],text,text)','public.set_studio_live_billing_authorization_scope_v3(uuid,text,boolean,timestamp with time zone,text,uuid,text,text)','public.settle_automation_sender_preparation_v1(uuid,uuid,jsonb)','public.settle_automation_test_email_v1(uuid,uuid,uuid,uuid,jsonb)','public.settle_missed_class_automation_v1(uuid,uuid,text,text,text,integer)','public.settle_missed_class_automation_v2(uuid,uuid,uuid,jsonb)','public.settle_workflow_email_v1(uuid,uuid,uuid,jsonb)','public.snapshot_promotion_rank_identity()','public.soft_delete_student_atomic(uuid,uuid,uuid)','public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)','public.student_business_date(uuid)','public.studio_live_billing_supported_operations_v58(uuid,text)','public.sum_email_usage_for_period(uuid,timestamp with time zone,timestamp with time zone)','public.support_triage_digest(integer)','public.support_triage_list_tickets(text[],text[],text[],integer)','public.support_triage_update_ticket(uuid,text,text,jsonb)','public.suppress_missed_class_automation_v1(text)','public.sync_belt_ladder_ranks(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_internal(uuid,uuid,text,jsonb)','public.sync_belt_ladder_ranks_v2(uuid,uuid,uuid,uuid,text,jsonb)','public.sync_primary_student_rank_from_membership()','public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_enrollment_transition_v29(uuid,uuid,uuid,bigint,uuid,bigint,text,text)','public.transition_billing_provider_operation_step_v1(uuid,uuid,uuid,text,text,text,text,integer,text,integer,text,text,text,text,uuid,bigint,text,text,text,text,text,text,text)','public.transition_billing_provider_operation_v1(uuid,uuid,uuid,text,text,text,text,integer,uuid,bigint,text,text,text,text,text,text,text,text,text)','public.update_lead_atomic(uuid,uuid,uuid,jsonb)','public.update_updated_at_column()','public.validate_attendance_program_integrity()','public.validate_automation_workflow_v1(uuid,uuid,jsonb,jsonb)','public.validate_billing_adjustment_refs()','public.validate_billing_dispute_refs()','public.validate_billing_invoice_item_refs()','public.validate_billing_invoice_refs()','public.validate_billing_payer_guardian()','public.validate_billing_payment_refs()','public.validate_billing_plan_program()','public.validate_billing_refund_refs()','public.validate_billing_subscription_refs()','public.validate_class_session_program_integrity()','public.validate_class_template_program_integrity()','public.validate_lead_program_integrity()','public.validate_student_billing_enrollment()','public.validate_student_birth_date()','public.validate_student_guardian_tenant_integrity()','public.validate_student_profile_tenant_integrity()','public.validate_student_program_membership()','public.write_billing_plan_v1(uuid,uuid,uuid,jsonb,uuid[])','public.write_student_profile_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)','public.write_student_profile_v2_atomic(uuid,uuid,uuid,jsonb,uuid[],jsonb,boolean,text)']::TEXT[] THEN
        v_failures:=array_append(v_failures,'live_billing_functions_v58');
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='koaryu_release_schema_preflight_v39') <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid=pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v39()')
          AND p.proowner='postgres'::REGROLE AND p.prosecdef AND p.provolatile='s'
          AND p.proretset AND p.proconfig=ARRAY['search_path=pg_catalog','TimeZone=UTC','DateStyle=ISO, YMD','IntervalStyle=postgres']::TEXT[]
          AND (SELECT jsonb_agg(jsonb_build_array(
                CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END,
                pg_catalog.pg_get_userbyid(a.grantor)::TEXT,a.privilege_type,a.is_grantable)
                ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::TEXT END COLLATE "C",
                    a.privilege_type,a.is_grantable)
               FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a)
             = '[["postgres","postgres","EXECUTE",false],["service_role","postgres","EXECUTE",false]]'::JSONB) THEN
        v_failures:=array_append(v_failures,'preflight_security_v58');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v58'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v38()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v39();
    IF v.ready IS TRUE AND v.migration_count = 153 AND v.migration_head = '20261013013243'
       AND v.manifest_version = 'release-db-attestation-v58'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 69
       AND v.pending_versions[cardinality(v.pending_versions)] = '20261013013243' THEN
        RETURN QUERY SELECT TRUE, 152, '20261005105341'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v57'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v57'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v39() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v39() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v39() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v38() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v38() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v38() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v39();
    IF v.migration_count IS DISTINCT FROM 152 OR v.migration_head IS DISTINCT FROM '20261005105341'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v58',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V58 installed contracts did not verify before history registration: %',row_to_json(v);
    END IF;
END;
$installed$;
