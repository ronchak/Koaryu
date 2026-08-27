-- Period-safe enrollment cancellation intents and due-work claims.

DO $v28_guard$
DECLARE v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v9();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 123
       OR v_preflight.migration_head IS DISTINCT FROM '20260826073728'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v28'
       OR cardinality(v_preflight.security_failures) <> 0
       OR private.koaryu_release_schedule_window_manifest_v1()
            IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        RAISE EXCEPTION 'Enrollment period transitions require exact ready 123/V28.';
    END IF;
END;
$v28_guard$;

CREATE TABLE public.billing_enrollment_transition_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    enrollment_id UUID NOT NULL REFERENCES public.student_billing_enrollments(id) ON DELETE RESTRICT,
    payer_id UUID NOT NULL REFERENCES public.billing_payers(id) ON DELETE RESTRICT,
    billing_subscription_id UUID NOT NULL REFERENCES public.billing_subscriptions(id) ON DELETE RESTRICT,
    source_intent_id UUID,
    provider_operation_id UUID,
    transition_kind TEXT NOT NULL,
    mutation_strategy TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    provider_caller_request_key TEXT,
    provider_request_sha256 TEXT,
    stripe_connected_account_id TEXT NOT NULL,
    connect_account_generation INTEGER NOT NULL,
    stripe_subscription_id TEXT NOT NULL,
    stripe_subscription_item_id TEXT,
    period_boundary TIMESTAMPTZ NOT NULL,
    expected_quantity INTEGER,
    expected_subscription_item_count INTEGER NOT NULL,
    same_item_active_count INTEGER NOT NULL,
    provider_quantity INTEGER,
    initiated_by UUID NOT NULL,
    reason_code TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'scheduled',
    lease_owner UUID,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    recovery_proof_sha256 TEXT,
    recovery_outcome TEXT,
    recovery_actor_id UUID,
    recovery_authorized_at TIMESTAMPTZ,
    provider_evidence_sha256 TEXT,
    reconciliation_reason_code TEXT,
    revision BIGINT NOT NULL DEFAULT 1,
    scheduled_at TIMESTAMPTZ,
    due_claimed_at TIMESTAMPTZ,
    provider_succeeded_at TIMESTAMPTZ,
    projected_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    reconciliation_required_at TIMESTAMPTZ,
    definitive_rejected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_enrollment_transition_intents_kind_exact CHECK (
        transition_kind IN (
            'schedule_period_end','revoke_scheduled','execute_due','immediate_cancel'
        )
    ),
    CONSTRAINT billing_enrollment_transition_intents_strategy_exact CHECK (
        mutation_strategy IN (
            'subscription_cancel_at_period_end',
            'subscription_item_delete_at_period_end',
            'subscription_cancel_immediate',
            'subscription_item_delete_immediate'
        )
    ),
    CONSTRAINT billing_enrollment_transition_intents_state_exact CHECK (
        state IN (
            'scheduled','due_claimed','provider_request_in_flight','provider_succeeded',
            'projected','completed','revoked','recovery_authorized',
            'reconciliation_required','definitive_rejected'
        )
    ),
    CONSTRAINT billing_enrollment_transition_intents_hash_shape
        CHECK (
            request_sha256 ~ '^[0-9a-f]{64}$'
            AND (provider_request_sha256 IS NULL
                OR provider_request_sha256 ~ '^[0-9a-f]{64}$')
            AND (provider_evidence_sha256 IS NULL
                OR provider_evidence_sha256 ~ '^[0-9a-f]{64}$')
        ),
    CONSTRAINT billing_enrollment_transition_intents_provider_key_safe CHECK (
        provider_caller_request_key IS NULL
        OR (
            octet_length(provider_caller_request_key) BETWEEN 1 AND 255
            AND provider_caller_request_key = btrim(provider_caller_request_key)
            AND provider_caller_request_key !~ '[[:cntrl:]]'
        )
    ),
    CONSTRAINT billing_enrollment_transition_intents_provider_request_complete CHECK (
        (provider_caller_request_key IS NULL AND provider_request_sha256 IS NULL)
        OR (provider_caller_request_key IS NOT NULL AND provider_request_sha256 IS NOT NULL)
    ),
    CONSTRAINT billing_enrollment_transition_intents_generation_positive
        CHECK (connect_account_generation > 0),
    CONSTRAINT billing_enrollment_transition_intents_quantity_shape CHECK (
        (mutation_strategy LIKE 'subscription_cancel_%'
            AND stripe_subscription_item_id IS NOT NULL
            AND expected_subscription_item_count = 1
            AND same_item_active_count = 1
            AND expected_quantity = 0
            AND provider_quantity = 1)
        OR (mutation_strategy LIKE 'subscription_item_delete_%'
            AND stripe_subscription_item_id IS NOT NULL AND expected_quantity >= 0
            AND provider_quantity > 0
            AND expected_quantity = same_item_active_count - 1
            AND provider_quantity = same_item_active_count
            AND (expected_subscription_item_count > 1 OR expected_quantity > 0))
    ),
    CONSTRAINT billing_enrollment_transition_intents_reason_safe
        CHECK (
            reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
            AND (reconciliation_reason_code IS NULL
                OR reconciliation_reason_code ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
        ),
    CONSTRAINT billing_enrollment_transition_intents_ids_safe CHECK (
        stripe_connected_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$'
        AND stripe_subscription_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$'
        AND (stripe_subscription_item_id IS NULL
            OR stripe_subscription_item_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$')
    ),
    CONSTRAINT billing_enrollment_transition_intents_lease_complete CHECK (
        (lease_owner IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
        OR (lease_owner IS NOT NULL AND lease_acquired_at IS NOT NULL
            AND lease_expires_at > lease_acquired_at)
    ),
    CONSTRAINT billing_enrollment_transition_intents_recovery_complete CHECK (
        (recovery_proof_sha256 IS NULL AND recovery_outcome IS NULL
            AND recovery_actor_id IS NULL AND recovery_authorized_at IS NULL)
        OR (recovery_proof_sha256 ~ '^[0-9a-f]{64}$'
            AND recovery_outcome IN (
                'provider_no_object_safe_to_retry','provider_succeeded_reconcile_only'
            ) AND recovery_actor_id IS NOT NULL AND recovery_authorized_at IS NOT NULL)
    ),
    CONSTRAINT billing_enrollment_transition_intents_revision_positive CHECK (revision > 0),
    CONSTRAINT billing_enrollment_transition_intents_counts_bounded CHECK (
        expected_subscription_item_count >= 0 AND same_item_active_count >= 0
    ),
    CONSTRAINT billing_enrollment_transition_intents_source_shape CHECK (
        (transition_kind IN ('revoke_scheduled','execute_due') AND source_intent_id IS NOT NULL)
        OR (transition_kind IN ('schedule_period_end','immediate_cancel') AND source_intent_id IS NULL)
    ),
    CONSTRAINT billing_enrollment_transition_intents_source_identity_unique
        UNIQUE (id,studio_id),
    CONSTRAINT billing_enrollment_transition_intents_source_fkey
        FOREIGN KEY (source_intent_id,studio_id)
        REFERENCES public.billing_enrollment_transition_intents(id,studio_id)
        ON DELETE RESTRICT,
    CONSTRAINT billing_enrollment_transition_intents_provider_operation_fkey
        FOREIGN KEY (provider_operation_id,studio_id)
        REFERENCES public.billing_provider_operations(id,studio_id) ON DELETE RESTRICT,
    CONSTRAINT billing_enrollment_transition_intents_alias_identity_unique
        UNIQUE (id,studio_id,transition_kind),
    CONSTRAINT billing_enrollment_transition_intents_provider_operation_unique
        UNIQUE (provider_operation_id)
);

CREATE UNIQUE INDEX billing_enrollment_transition_one_open_idx
    ON public.billing_enrollment_transition_intents(studio_id, enrollment_id, transition_kind)
    WHERE state NOT IN ('completed','revoked','definitive_rejected');
CREATE INDEX billing_enrollment_transition_due_idx
    ON public.billing_enrollment_transition_intents(period_boundary, id)
    WHERE state = 'scheduled' AND transition_kind = 'schedule_period_end';
CREATE INDEX billing_enrollment_transition_payer_idx
    ON public.billing_enrollment_transition_intents(studio_id, payer_id, created_at DESC);

CREATE TABLE public.billing_enrollment_transition_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id UUID NOT NULL,
    studio_id UUID NOT NULL REFERENCES public.studios(id) ON DELETE CASCADE,
    transition_kind TEXT NOT NULL,
    caller_request_key TEXT NOT NULL,
    actor_id UUID NOT NULL,
    request_sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT billing_enrollment_transition_aliases_kind_exact CHECK (
        transition_kind IN (
            'schedule_period_end','revoke_scheduled','execute_due','immediate_cancel'
        )
    ),
    CONSTRAINT billing_enrollment_transition_aliases_key_safe CHECK (
        octet_length(caller_request_key) BETWEEN 1 AND 255
        AND caller_request_key = btrim(caller_request_key)
        AND caller_request_key !~ '[[:cntrl:]]'
    ),
    CONSTRAINT billing_enrollment_transition_aliases_hash_shape
        CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT billing_enrollment_transition_aliases_intent_fkey
        FOREIGN KEY (intent_id,studio_id,transition_kind)
        REFERENCES public.billing_enrollment_transition_intents(id,studio_id,transition_kind)
        ON DELETE RESTRICT,
    CONSTRAINT billing_enrollment_transition_aliases_key_unique
        UNIQUE (studio_id, transition_kind, caller_request_key),
    CONSTRAINT billing_enrollment_transition_aliases_intent_key_unique
        UNIQUE (intent_id, caller_request_key)
);
CREATE INDEX billing_enrollment_transition_aliases_intent_idx
    ON public.billing_enrollment_transition_aliases(intent_id, created_at);

ALTER TABLE public.billing_enrollment_transition_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_enrollment_transition_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_enrollment_transition_intents OWNER TO postgres;
ALTER TABLE public.billing_enrollment_transition_aliases OWNER TO postgres;
REVOKE ALL ON TABLE public.billing_enrollment_transition_intents,
    public.billing_enrollment_transition_aliases FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY billing_enrollment_transition_intents_no_client_access
    ON public.billing_enrollment_transition_intents AS RESTRICTIVE
    FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY billing_enrollment_transition_aliases_no_client_access
    ON public.billing_enrollment_transition_aliases AS RESTRICTIVE
    FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_enrollment_transition_intents AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));
CREATE POLICY reject_ambiguous_staff_membership_access
    ON public.billing_enrollment_transition_aliases AS RESTRICTIVE
    FOR ALL TO authenticated
    USING ((SELECT private.has_unambiguous_studio_membership()))
    WITH CHECK ((SELECT private.has_unambiguous_studio_membership()));

CREATE FUNCTION private.preserve_billing_enrollment_transition_identity_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    IF ROW(
        NEW.id,NEW.studio_id,NEW.enrollment_id,NEW.payer_id,
        NEW.billing_subscription_id,NEW.source_intent_id,NEW.transition_kind,
        NEW.mutation_strategy,NEW.request_sha256,NEW.provider_caller_request_key,
        NEW.provider_request_sha256,NEW.stripe_connected_account_id,
        NEW.connect_account_generation,NEW.stripe_subscription_id,
        NEW.stripe_subscription_item_id,NEW.period_boundary,NEW.expected_quantity,
        NEW.expected_subscription_item_count,NEW.same_item_active_count,
        NEW.provider_quantity,NEW.initiated_by,NEW.reason_code,NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.id,OLD.studio_id,OLD.enrollment_id,OLD.payer_id,
        OLD.billing_subscription_id,OLD.source_intent_id,OLD.transition_kind,
        OLD.mutation_strategy,OLD.request_sha256,OLD.provider_caller_request_key,
        OLD.provider_request_sha256,OLD.stripe_connected_account_id,
        OLD.connect_account_generation,OLD.stripe_subscription_id,
        OLD.stripe_subscription_item_id,OLD.period_boundary,OLD.expected_quantity,
        OLD.expected_subscription_item_count,OLD.same_item_active_count,
        OLD.provider_quantity,OLD.initiated_by,OLD.reason_code,OLD.created_at
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_identity_immutable';
    END IF;
    IF OLD.provider_operation_id IS NOT NULL
       AND NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_provider_operation_immutable';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision+1
       OR NEW.updated_at<OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE='40001',
            MESSAGE='billing_enrollment_transition_revision_invalid';
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.preserve_billing_enrollment_transition_identity_v1()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_enrollment_transition_identity_v1()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER preserve_billing_enrollment_transition_identity_v1
    BEFORE UPDATE ON public.billing_enrollment_transition_intents
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_enrollment_transition_identity_v1();

CREATE FUNCTION private.reject_billing_enrollment_transition_alias_mutation_v1()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE='billing_enrollment_transition_alias_immutable';
END;
$$;
ALTER FUNCTION private.reject_billing_enrollment_transition_alias_mutation_v1()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reject_billing_enrollment_transition_alias_mutation_v1()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER reject_billing_enrollment_transition_alias_update_v1
    BEFORE UPDATE ON public.billing_enrollment_transition_aliases
    FOR EACH ROW EXECUTE FUNCTION private.reject_billing_enrollment_transition_alias_mutation_v1();
CREATE TRIGGER reject_billing_enrollment_transition_alias_delete_v1
    BEFORE DELETE ON public.billing_enrollment_transition_aliases
    FOR EACH ROW EXECUTE FUNCTION private.reject_billing_enrollment_transition_alias_mutation_v1();

CREATE FUNCTION private.billing_enrollment_transition_json_v1(
    p_intent public.billing_enrollment_transition_intents,
    p_outcome TEXT,
    p_requested_key TEXT
) RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'outcome', p_outcome,
        'requested_caller_request_key', p_requested_key,
        'intent', to_jsonb(p_intent)
            - ARRAY['lease_owner','lease_acquired_at','lease_expires_at',
                    'recovery_proof_sha256']::TEXT[]
    );
$$;
ALTER FUNCTION private.billing_enrollment_transition_json_v1(
    public.billing_enrollment_transition_intents,TEXT,TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_enrollment_transition_json_v1(
    public.billing_enrollment_transition_intents,TEXT,TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.assert_billing_enrollment_transition_current_v1(
    p_intent public.billing_enrollment_transition_intents
) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_subscription public.billing_subscriptions%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_plan_interval TEXT;
    v_actual_subscription_item_count INTEGER;
    v_actual_same_item_count INTEGER;
    v_missing_item_count INTEGER;
BEGIN
    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=p_intent.enrollment_id AND studio_id=p_intent.studio_id FOR UPDATE;
    SELECT * INTO v_subscription FROM public.billing_subscriptions
    WHERE id=p_intent.billing_subscription_id AND studio_id=p_intent.studio_id FOR UPDATE;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id=p_intent.payer_id AND studio_id=p_intent.studio_id FOR UPDATE;
    SELECT * INTO v_account FROM public.studio_payment_accounts
    WHERE studio_id=p_intent.studio_id FOR UPDATE;
    SELECT plan.billing_interval INTO v_plan_interval
    FROM public.billing_plans AS plan WHERE plan.id=v_enrollment.billing_plan_id;
    SELECT
        count(DISTINCT candidate.stripe_subscription_item_id)::INTEGER,
        count(*) FILTER (
            WHERE candidate.stripe_subscription_item_id=p_intent.stripe_subscription_item_id
        )::INTEGER,
        count(*) FILTER (
            WHERE candidate.stripe_subscription_item_id IS NULL
        )::INTEGER
    INTO v_actual_subscription_item_count,v_actual_same_item_count,v_missing_item_count
    FROM public.student_billing_enrollments AS candidate
    WHERE candidate.studio_id=p_intent.studio_id
      AND candidate.billing_subscription_id=p_intent.billing_subscription_id
      AND candidate.status IN ('pending','active')
      AND NOT (candidate.metadata ? 'stripe_detach_pending');
    IF v_enrollment.id IS NULL OR v_subscription.id IS NULL OR v_payer.id IS NULL
       OR v_enrollment.payer_id IS DISTINCT FROM p_intent.payer_id
       OR v_enrollment.billing_subscription_id IS DISTINCT FROM p_intent.billing_subscription_id
       OR v_enrollment.status NOT IN ('pending','active')
       OR v_enrollment.collection_mode NOT IN ('autopay','invoice_link')
       OR v_plan_interval='paid_in_full'
       OR v_enrollment.stripe_subscription_id IS DISTINCT FROM p_intent.stripe_subscription_id
       OR v_enrollment.stripe_subscription_item_id IS DISTINCT FROM p_intent.stripe_subscription_item_id
       OR v_subscription.payer_id IS DISTINCT FROM p_intent.payer_id
       OR v_subscription.stripe_subscription_id IS DISTINCT FROM p_intent.stripe_subscription_id
       OR v_subscription.stripe_account_id IS DISTINCT FROM p_intent.stripe_connected_account_id
       OR (v_subscription.metadata->>'connect_account_generation')::INTEGER
            IS DISTINCT FROM p_intent.connect_account_generation
       OR v_payer.stripe_account_id IS DISTINCT FROM p_intent.stripe_connected_account_id
       OR v_payer.connect_account_generation IS DISTINCT FROM p_intent.connect_account_generation
       OR v_account.stripe_connected_account_id IS DISTINCT FROM p_intent.stripe_connected_account_id
       OR private.current_connect_account_generation(v_account.metadata)
            IS DISTINCT FROM p_intent.connect_account_generation
       OR v_missing_item_count<>0
       OR v_actual_subscription_item_count IS DISTINCT FROM p_intent.expected_subscription_item_count
       OR v_actual_same_item_count IS DISTINCT FROM p_intent.same_item_active_count THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_current_identity_mismatch';
    END IF;
END;
$$;
ALTER FUNCTION private.assert_billing_enrollment_transition_current_v1(
    public.billing_enrollment_transition_intents
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.assert_billing_enrollment_transition_current_v1(
    public.billing_enrollment_transition_intents
) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.claim_billing_enrollment_transition_v1(
    p_studio_id UUID, p_actor_id UUID, p_transition_kind TEXT,
    p_caller_request_key TEXT, p_request_sha256 TEXT,
    p_enrollment_id UUID, p_payer_id UUID, p_billing_subscription_id UUID,
    p_stripe_subscription_id TEXT, p_stripe_subscription_item_id TEXT,
    p_stripe_connected_account_id TEXT, p_connect_account_generation INTEGER,
    p_period_boundary TIMESTAMPTZ, p_expected_quantity INTEGER,
    p_expected_subscription_item_count INTEGER,p_same_item_active_count INTEGER,
    p_provider_quantity INTEGER,p_mutation_strategy TEXT,p_reason_code TEXT,
    p_lease_owner UUID, p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_subscription public.billing_subscriptions%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_plan_interval TEXT;
    v_actual_subscription_item_count INTEGER;
    v_actual_same_item_count INTEGER;
    v_missing_item_count INTEGER;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_alias public.billing_enrollment_transition_aliases%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_transition_kind NOT IN ('schedule_period_end','immediate_cancel')
       OR p_mutation_strategy NOT IN (
            'subscription_cancel_at_period_end','subscription_item_delete_at_period_end',
            'subscription_cancel_immediate','subscription_item_delete_immediate')
       OR (p_transition_kind='schedule_period_end'
            AND p_mutation_strategy NOT LIKE '%_at_period_end')
       OR (p_transition_kind='immediate_cancel'
            AND p_mutation_strategy NOT LIKE '%_immediate')
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key <> btrim(p_caller_request_key)
       OR p_caller_request_key ~ '[[:cntrl:]]'
       OR p_connect_account_generation <= 0
       OR p_lease_owner IS NULL
       OR p_expected_subscription_item_count<1 OR p_same_item_active_count<1
       OR p_provider_quantity<1 OR p_expected_quantity<0
       OR (p_transition_kind='schedule_period_end' AND p_period_boundary<=clock_timestamp())
       OR (p_transition_kind='immediate_cancel' AND p_period_boundary>clock_timestamp())
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_enrollment_transition_claim_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id=p_studio_id AND membership.user_id=p_actor_id
          AND membership.archived_at IS NULL
          AND (
              (p_transition_kind='immediate_cancel' AND membership.role='admin')
              OR (p_transition_kind='schedule_period_end'
                  AND membership.role IN ('admin','front_desk'))
          )
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501',
            MESSAGE='billing_enrollment_transition_actor_forbidden';
    END IF;

    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=p_enrollment_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_subscription FROM public.billing_subscriptions
    WHERE id=p_billing_subscription_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_account FROM public.studio_payment_accounts
    WHERE studio_id=p_studio_id FOR UPDATE;
    SELECT plan.billing_interval INTO v_plan_interval
    FROM public.billing_plans AS plan WHERE plan.id=v_enrollment.billing_plan_id;
    IF v_enrollment.id IS NULL OR v_payer.id IS NULL OR v_subscription.id IS NULL
       OR v_enrollment.payer_id IS DISTINCT FROM p_payer_id
       OR v_enrollment.billing_subscription_id IS DISTINCT FROM p_billing_subscription_id
       OR v_enrollment.collection_mode NOT IN ('autopay','invoice_link')
       OR v_plan_interval='paid_in_full'
       OR v_enrollment.status NOT IN ('pending','active')
       OR v_enrollment.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
       OR v_enrollment.stripe_subscription_item_id IS DISTINCT FROM p_stripe_subscription_item_id
       OR v_subscription.payer_id IS DISTINCT FROM p_payer_id
       OR v_subscription.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
       OR v_subscription.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_account.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR private.current_connect_account_generation(v_account.metadata)
            IS DISTINCT FROM p_connect_account_generation
       OR v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_payer.connect_account_generation IS DISTINCT FROM p_connect_account_generation
       OR (v_subscription.metadata->>'connect_account_generation')::INTEGER
            IS DISTINCT FROM p_connect_account_generation
       OR (p_transition_kind='schedule_period_end'
            AND v_subscription.current_period_end IS DISTINCT FROM p_period_boundary)
       OR (p_transition_kind='immediate_cancel'
            AND p_period_boundary < v_now - interval '5 minutes') THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_identity_mismatch';
    END IF;

    SELECT
        count(DISTINCT candidate.stripe_subscription_item_id)::INTEGER,
        count(*) FILTER (
            WHERE candidate.stripe_subscription_item_id=p_stripe_subscription_item_id
        )::INTEGER,
        count(*) FILTER (
            WHERE candidate.stripe_subscription_item_id IS NULL
        )::INTEGER
    INTO v_actual_subscription_item_count,v_actual_same_item_count,v_missing_item_count
    FROM public.student_billing_enrollments AS candidate
    WHERE candidate.studio_id=p_studio_id
      AND candidate.billing_subscription_id=p_billing_subscription_id
      AND candidate.status IN ('pending','active')
      AND NOT (candidate.metadata ? 'stripe_detach_pending');
    IF v_missing_item_count<>0
       OR v_actual_subscription_item_count IS DISTINCT FROM p_expected_subscription_item_count
       OR v_actual_same_item_count IS DISTINCT FROM p_same_item_active_count
       OR p_provider_quantity IS DISTINCT FROM v_actual_same_item_count
       OR p_expected_quantity IS DISTINCT FROM v_actual_same_item_count-1
       OR (
            p_mutation_strategy LIKE 'subscription_cancel_%'
            AND NOT (
                v_actual_subscription_item_count=1
                AND v_actual_same_item_count=1
            )
       )
       OR (
            p_mutation_strategy LIKE 'subscription_item_delete_%'
            AND v_actual_subscription_item_count=1
            AND v_actual_same_item_count=1
       ) THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_quantity_mismatch';
    END IF;

    SELECT * INTO v_alias FROM public.billing_enrollment_transition_aliases
    WHERE studio_id=p_studio_id AND transition_kind=p_transition_kind
      AND caller_request_key=p_caller_request_key FOR UPDATE;
    IF FOUND THEN
        SELECT * INTO v_intent FROM public.billing_enrollment_transition_intents
        WHERE id=v_alias.intent_id FOR UPDATE;
        IF v_alias.actor_id IS DISTINCT FROM p_actor_id
           OR v_alias.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_intent.enrollment_id IS DISTINCT FROM p_enrollment_id THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_enrollment_transition_request_conflict';
        END IF;
        RETURN private.billing_enrollment_transition_json_v1(
            v_intent,'replay',p_caller_request_key
        );
    END IF;

    SELECT * INTO v_intent FROM public.billing_enrollment_transition_intents
    WHERE studio_id=p_studio_id AND enrollment_id=p_enrollment_id
      AND state NOT IN ('completed','revoked','definitive_rejected')
    ORDER BY created_at,id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        IF v_intent.initiated_by IS DISTINCT FROM p_actor_id
           OR v_intent.transition_kind IS DISTINCT FROM p_transition_kind
           OR v_intent.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_enrollment_transition_request_conflict';
        END IF;
        INSERT INTO public.billing_enrollment_transition_aliases(
            intent_id,studio_id,transition_kind,caller_request_key,
            actor_id,request_sha256,created_at
        ) VALUES (v_intent.id,p_studio_id,p_transition_kind,p_caller_request_key,
            p_actor_id,p_request_sha256,v_now);
        RETURN private.billing_enrollment_transition_json_v1(
            v_intent,'adopted',p_caller_request_key
        );
    END IF;

    INSERT INTO public.billing_enrollment_transition_intents(
        studio_id,enrollment_id,payer_id,billing_subscription_id,
        transition_kind,mutation_strategy,request_sha256,
        provider_caller_request_key,provider_request_sha256,
        stripe_connected_account_id,connect_account_generation,
        stripe_subscription_id,stripe_subscription_item_id,
        period_boundary,expected_quantity,expected_subscription_item_count,
        same_item_active_count,provider_quantity,initiated_by,reason_code,state,
        lease_owner,lease_acquired_at,lease_expires_at,scheduled_at,
        created_at,updated_at
    ) VALUES (
        p_studio_id,p_enrollment_id,p_payer_id,p_billing_subscription_id,
        p_transition_kind,p_mutation_strategy,p_request_sha256,
        CASE WHEN p_transition_kind='immediate_cancel'
                  OR p_mutation_strategy='subscription_cancel_at_period_end'
             THEN p_caller_request_key END,
        CASE WHEN p_transition_kind='immediate_cancel'
                  OR p_mutation_strategy='subscription_cancel_at_period_end'
             THEN p_request_sha256 END,
        p_stripe_connected_account_id,p_connect_account_generation,
        p_stripe_subscription_id,p_stripe_subscription_item_id,
        p_period_boundary,p_expected_quantity,p_expected_subscription_item_count,
        p_same_item_active_count,p_provider_quantity,p_actor_id,p_reason_code,
        CASE WHEN p_transition_kind='schedule_period_end' THEN 'scheduled'
             ELSE 'due_claimed' END,
        CASE WHEN p_transition_kind='immediate_cancel'
                  OR p_mutation_strategy='subscription_cancel_at_period_end'
             THEN p_lease_owner END,
        CASE WHEN p_transition_kind='immediate_cancel'
                  OR p_mutation_strategy='subscription_cancel_at_period_end'
             THEN v_now END,
        CASE WHEN p_transition_kind='immediate_cancel'
                  OR p_mutation_strategy='subscription_cancel_at_period_end'
             THEN v_now+make_interval(secs=>p_lease_seconds) END,
        CASE WHEN p_transition_kind='schedule_period_end' THEN v_now END,
        v_now,v_now
    ) RETURNING * INTO v_intent;
    IF p_transition_kind = 'immediate_cancel'
       OR p_mutation_strategy = 'subscription_cancel_at_period_end' THEN
        INSERT INTO public.billing_provider_operations(
            studio_id,actor_id,operation_type,caller_request_key,request_sha256,
            stripe_connected_account_id,connect_account_generation,state,
            lease_owner,lease_acquired_at,lease_expires_at,started_at,created_at,updated_at
        ) VALUES (
            p_studio_id,p_actor_id,
            CASE WHEN p_transition_kind='immediate_cancel'
                THEN 'enrollment.cancel.immediate'
                ELSE 'enrollment.cancel.period_end.schedule' END,
            p_caller_request_key,
            p_request_sha256,p_stripe_connected_account_id,p_connect_account_generation,
            'started',p_lease_owner,v_now,v_now+make_interval(secs=>p_lease_seconds),
            v_now,v_now,v_now
        ) RETURNING * INTO v_operation;
        UPDATE public.billing_enrollment_transition_intents
        SET provider_operation_id=v_operation.id,revision=revision+1,updated_at=v_now
        WHERE id=v_intent.id RETURNING * INTO v_intent;
    END IF;
    INSERT INTO public.billing_enrollment_transition_aliases(
        intent_id,studio_id,transition_kind,caller_request_key,
        actor_id,request_sha256,created_at
    ) VALUES (v_intent.id,p_studio_id,p_transition_kind,p_caller_request_key,
        p_actor_id,p_request_sha256,v_now);
    RETURN private.billing_enrollment_transition_json_v1(v_intent,'claimed',p_caller_request_key);
END;
$$;

ALTER FUNCTION public.claim_billing_enrollment_transition_v1(
    UUID,UUID,TEXT,TEXT,TEXT,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,
    TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_enrollment_transition_v1(
    UUID,UUID,TEXT,TEXT,TEXT,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,
    TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_enrollment_transition_v1(
    UUID,UUID,TEXT,TEXT,TEXT,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,
    TIMESTAMPTZ,INTEGER,INTEGER,INTEGER,INTEGER,TEXT,TEXT,UUID,INTEGER
) TO service_role;

CREATE FUNCTION public.claim_due_billing_enrollment_transitions_v1(
    p_worker_id UUID, p_lease_seconds INTEGER DEFAULT 30, p_limit INTEGER DEFAULT 25
) RETURNS SETOF public.billing_enrollment_transition_intents
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_candidate RECORD;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_schedule public.billing_enrollment_transition_intents%ROWTYPE;
    v_execute public.billing_enrollment_transition_intents%ROWTYPE;
    v_now TIMESTAMPTZ;
    v_provider_key TEXT;
    v_provider_hash TEXT;
    v_returned INTEGER:=0;
BEGIN
    IF p_worker_id IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300
       OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_enrollment_transition_due_claim_invalid';
    END IF;
    FOR v_candidate IN
        SELECT intent.id,intent.enrollment_id
        FROM public.billing_enrollment_transition_intents AS intent
        WHERE intent.transition_kind='schedule_period_end'
          AND intent.state IN ('scheduled','due_claimed')
          AND intent.period_boundary<=clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_enrollment_transition_intents AS revoke
            WHERE revoke.source_intent_id=intent.id
              AND revoke.transition_kind='revoke_scheduled'
              AND revoke.state NOT IN ('completed','revoked','definitive_rejected')
          )
        ORDER BY intent.period_boundary,intent.id
        LIMIT p_limit*4
    LOOP
        v_now:=clock_timestamp();
        SELECT * INTO v_enrollment FROM public.student_billing_enrollments
        WHERE id=v_candidate.enrollment_id FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;
        SELECT * INTO v_schedule
        FROM public.billing_enrollment_transition_intents AS intent
        WHERE intent.id=v_candidate.id
          AND intent.transition_kind='schedule_period_end'
          AND intent.state IN ('scheduled','due_claimed')
          AND intent.period_boundary<=v_now
          AND NOT EXISTS (
            SELECT 1 FROM public.billing_enrollment_transition_intents AS revoke
            WHERE revoke.source_intent_id=intent.id
              AND revoke.transition_kind='revoke_scheduled'
              AND revoke.state NOT IN ('completed','revoked','definitive_rejected')
          )
        FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
            CONTINUE;
        END IF;
        SELECT * INTO v_execute
        FROM public.billing_enrollment_transition_intents AS execute
        WHERE execute.source_intent_id=v_schedule.id
          AND execute.transition_kind='execute_due'
        ORDER BY execute.created_at DESC,execute.id DESC
        LIMIT 1 FOR UPDATE;
        IF FOUND THEN
            IF v_execute.state='due_claimed'
               AND v_execute.provider_operation_id IS NULL
               AND v_execute.lease_expires_at<=v_now THEN
                UPDATE public.billing_enrollment_transition_intents
                SET lease_owner=p_worker_id,lease_acquired_at=v_now,
                    lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
                    revision=revision+1,updated_at=v_now
                WHERE id=v_execute.id RETURNING * INTO v_execute;
                RETURN NEXT v_execute;
                v_returned:=v_returned+1;
                EXIT WHEN v_returned>=p_limit;
            END IF;
            CONTINUE;
        END IF;
        IF v_schedule.state<>'scheduled' THEN
            CONTINUE;
        END IF;
        v_provider_key:='enrollment-period-execute:'||v_schedule.id::TEXT;
        v_provider_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
            'source_intent_id',v_schedule.id,
            'studio_id',v_schedule.studio_id,
            'enrollment_id',v_schedule.enrollment_id,
            'payer_id',v_schedule.payer_id,
            'billing_subscription_id',v_schedule.billing_subscription_id,
            'mutation_strategy',v_schedule.mutation_strategy,
            'stripe_connected_account_id',v_schedule.stripe_connected_account_id,
            'connect_account_generation',v_schedule.connect_account_generation,
            'stripe_subscription_id',v_schedule.stripe_subscription_id,
            'stripe_subscription_item_id',v_schedule.stripe_subscription_item_id,
            'period_boundary',v_schedule.period_boundary,
            'expected_quantity',v_schedule.expected_quantity,
            'expected_subscription_item_count',v_schedule.expected_subscription_item_count,
            'same_item_active_count',v_schedule.same_item_active_count,
            'provider_quantity',v_schedule.provider_quantity
        )::TEXT,'UTF8'),'sha256'),'hex');
        INSERT INTO public.billing_enrollment_transition_intents(
            studio_id,enrollment_id,payer_id,billing_subscription_id,
            source_intent_id,transition_kind,mutation_strategy,request_sha256,
            provider_caller_request_key,provider_request_sha256,
            stripe_connected_account_id,connect_account_generation,
            stripe_subscription_id,stripe_subscription_item_id,period_boundary,
            expected_quantity,expected_subscription_item_count,same_item_active_count,
            provider_quantity,initiated_by,reason_code,state,lease_owner,
            lease_acquired_at,lease_expires_at,due_claimed_at,created_at,updated_at
        ) VALUES (
            v_schedule.studio_id,v_schedule.enrollment_id,v_schedule.payer_id,
            v_schedule.billing_subscription_id,v_schedule.id,'execute_due',
            v_schedule.mutation_strategy,v_schedule.request_sha256,
            CASE WHEN v_schedule.mutation_strategy='subscription_item_delete_at_period_end'
                THEN v_provider_key END,
            CASE WHEN v_schedule.mutation_strategy='subscription_item_delete_at_period_end'
                THEN v_provider_hash END,
            v_schedule.stripe_connected_account_id,v_schedule.connect_account_generation,
            v_schedule.stripe_subscription_id,v_schedule.stripe_subscription_item_id,
            v_schedule.period_boundary,v_schedule.expected_quantity,
            v_schedule.expected_subscription_item_count,v_schedule.same_item_active_count,
            v_schedule.provider_quantity,v_schedule.initiated_by,v_schedule.reason_code,
            'due_claimed',p_worker_id,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now
        ) RETURNING * INTO v_execute;
        UPDATE public.billing_enrollment_transition_intents
        SET state='due_claimed',due_claimed_at=v_now,revision=revision+1,updated_at=v_now
        WHERE id=v_schedule.id;
        RETURN NEXT v_execute;
        v_returned:=v_returned+1;
        EXIT WHEN v_returned>=p_limit;
    END LOOP;
END;
$$;
ALTER FUNCTION public.claim_due_billing_enrollment_transitions_v1(UUID,INTEGER,INTEGER)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(UUID,INTEGER,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_due_billing_enrollment_transitions_v1(UUID,INTEGER,INTEGER)
    TO service_role;

CREATE FUNCTION public.start_due_billing_enrollment_transition_v1(
    p_intent_id UUID, p_worker_id UUID, p_expected_revision BIGINT,
    p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_source_id UUID;
    v_enrollment_id UUID;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_source public.billing_enrollment_transition_intents%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT source_intent_id,enrollment_id INTO v_source_id,v_enrollment_id
    FROM public.billing_enrollment_transition_intents WHERE id=p_intent_id;
    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=v_enrollment_id FOR UPDATE;
    SELECT * INTO v_source FROM public.billing_enrollment_transition_intents
    WHERE id=v_source_id FOR UPDATE;
    SELECT * INTO v_intent FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id FOR UPDATE;
    IF v_intent.id IS NULL OR v_intent.transition_kind<>'execute_due'
       OR v_intent.source_intent_id IS NULL
       OR v_intent.mutation_strategy<>'subscription_item_delete_at_period_end'
       OR v_source.id IS DISTINCT FROM v_intent.source_intent_id
       OR v_source.state<>'due_claimed'
       OR v_intent.state<>'due_claimed' OR v_intent.lease_owner IS DISTINCT FROM p_worker_id
       OR v_intent.revision IS DISTINCT FROM p_expected_revision
       OR v_intent.period_boundary>v_now OR v_intent.provider_operation_id IS NOT NULL
       OR v_intent.provider_request_sha256 !~ '^[0-9a-f]{64}$'
       OR octet_length(v_intent.provider_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_due_start_invalid';
    END IF;
    PERFORM private.assert_billing_enrollment_transition_current_v1(v_intent);
    INSERT INTO public.billing_provider_operations(
        studio_id,actor_id,operation_type,caller_request_key,request_sha256,
        stripe_connected_account_id,connect_account_generation,state,
        lease_owner,lease_acquired_at,lease_expires_at,started_at,created_at,updated_at
    ) VALUES (
        v_intent.studio_id,v_intent.initiated_by,
        'enrollment.cancel.period_end.execute',v_intent.provider_caller_request_key,
        v_intent.provider_request_sha256,
        v_intent.stripe_connected_account_id,v_intent.connect_account_generation,
        'started',p_worker_id,v_now,v_now+make_interval(secs=>p_lease_seconds),
        v_now,v_now,v_now
    ) RETURNING * INTO v_operation;
    UPDATE public.billing_enrollment_transition_intents
    SET provider_operation_id=v_operation.id,
        lease_owner=p_worker_id,
        lease_acquired_at=v_now,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
        revision=revision+1,updated_at=v_now
    WHERE id=v_intent.id RETURNING * INTO v_intent;
    INSERT INTO public.billing_enrollment_transition_aliases(
        intent_id,studio_id,transition_kind,caller_request_key,
        actor_id,request_sha256,created_at
    ) VALUES (
        v_intent.id,v_intent.studio_id,'execute_due',
        v_intent.provider_caller_request_key,v_intent.initiated_by,
        v_intent.provider_request_sha256,v_now
    );
    RETURN private.billing_enrollment_transition_json_v1(
        v_intent,'started',v_intent.provider_caller_request_key
    )
        || jsonb_build_object(
            'operation',private.billing_provider_operation_json_v1(v_operation,'claimed')->'operation'
        );
END;
$$;
ALTER FUNCTION public.start_due_billing_enrollment_transition_v1(
    UUID,UUID,BIGINT,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_due_billing_enrollment_transition_v1(
    UUID,UUID,BIGINT,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.start_due_billing_enrollment_transition_v1(
    UUID,UUID,BIGINT,INTEGER
) TO service_role;

CREATE FUNCTION public.complete_due_billing_enrollment_transition_v1(
    p_intent_id UUID,p_worker_id UUID,p_expected_revision BIGINT,
    p_provider_evidence_sha256 TEXT,p_provider_subscription_state TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_source_id UUID;
    v_enrollment_id UUID;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_source public.billing_enrollment_transition_intents%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    SELECT source_intent_id,enrollment_id INTO v_source_id,v_enrollment_id
    FROM public.billing_enrollment_transition_intents WHERE id=p_intent_id;
    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=v_enrollment_id FOR UPDATE;
    SELECT * INTO v_source FROM public.billing_enrollment_transition_intents
    WHERE id=v_source_id FOR UPDATE;
    SELECT * INTO v_intent FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id FOR UPDATE;
    IF v_intent.id IS NULL OR v_source.id IS NULL
       OR v_intent.transition_kind<>'execute_due'
       OR v_intent.mutation_strategy<>'subscription_cancel_at_period_end'
       OR v_intent.provider_operation_id IS NOT NULL
       OR v_intent.provider_caller_request_key IS NOT NULL
       OR v_intent.provider_request_sha256 IS NOT NULL
       OR v_intent.state<>'due_claimed' OR v_source.state<>'due_claimed'
       OR v_intent.lease_owner IS DISTINCT FROM p_worker_id
       OR v_intent.lease_expires_at<=v_now
       OR v_intent.revision<>p_expected_revision
       OR p_provider_evidence_sha256 !~ '^[0-9a-f]{64}$'
       OR p_provider_subscription_state<>'canceled'
       OR v_enrollment.status NOT IN ('canceled','ended') THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_due_completion_invalid';
    END IF;
    UPDATE public.billing_enrollment_transition_intents
    SET state='completed',provider_evidence_sha256=p_provider_evidence_sha256,
        provider_succeeded_at=COALESCE(provider_succeeded_at,v_now),
        projected_at=COALESCE(projected_at,v_now),completed_at=COALESCE(completed_at,v_now),
        lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
        revision=revision+1,updated_at=v_now
    WHERE id=v_intent.id RETURNING * INTO v_intent;
    UPDATE public.billing_enrollment_transition_intents
    SET state='completed',provider_evidence_sha256=p_provider_evidence_sha256,
        completed_at=COALESCE(completed_at,v_now),revision=revision+1,updated_at=v_now
    WHERE id=v_source.id;
    RETURN private.billing_enrollment_transition_json_v1(v_intent,'completed',NULL);
END;
$$;
ALTER FUNCTION public.complete_due_billing_enrollment_transition_v1(
    UUID,UUID,BIGINT,TEXT,TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_due_billing_enrollment_transition_v1(
    UUID,UUID,BIGINT,TEXT,TEXT
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_due_billing_enrollment_transition_v1(
    UUID,UUID,BIGINT,TEXT,TEXT
) TO service_role;

CREATE FUNCTION public.revoke_billing_enrollment_transition_v1(
    p_intent_id UUID,p_studio_id UUID,p_actor_id UUID,p_expected_revision BIGINT,
    p_caller_request_key TEXT,p_request_sha256 TEXT,p_reason_code TEXT,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_enrollment_id UUID;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_source public.billing_enrollment_transition_intents%ROWTYPE;
    v_revoke public.billing_enrollment_transition_intents%ROWTYPE;
    v_alias public.billing_enrollment_transition_aliases%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key<>btrim(p_caller_request_key)
       OR p_caller_request_key~'[[:cntrl:]]'
       OR p_lease_owner IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_enrollment_transition_revoke_invalid';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
          AND user_id=p_actor_id AND archived_at IS NULL
          AND role IN ('admin','front_desk')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501',
            MESSAGE='billing_enrollment_transition_actor_forbidden';
    END IF;
    SELECT enrollment_id INTO v_enrollment_id
    FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id AND studio_id=p_studio_id;
    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=v_enrollment_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_source FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id AND studio_id=p_studio_id FOR UPDATE;

    SELECT * INTO v_alias FROM public.billing_enrollment_transition_aliases
    WHERE studio_id=p_studio_id AND transition_kind='revoke_scheduled'
      AND caller_request_key=p_caller_request_key FOR UPDATE;
    IF FOUND THEN
        SELECT * INTO v_revoke FROM public.billing_enrollment_transition_intents
        WHERE id=v_alias.intent_id FOR UPDATE;
        IF v_alias.actor_id IS DISTINCT FROM p_actor_id
           OR v_alias.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_revoke.source_intent_id IS DISTINCT FROM p_intent_id THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_enrollment_transition_request_conflict';
        END IF;
        IF v_revoke.provider_operation_id IS NOT NULL THEN
            SELECT * INTO v_operation FROM public.billing_provider_operations
            WHERE id=v_revoke.provider_operation_id;
        END IF;
        RETURN private.billing_enrollment_transition_json_v1(
            v_revoke,'replay',p_caller_request_key
        ) || CASE WHEN v_operation.id IS NULL THEN '{}'::JSONB ELSE jsonb_build_object(
            'operation',private.billing_provider_operation_json_v1(
                v_operation,'replay'
            )->'operation') END;
    END IF;

    SELECT * INTO v_revoke FROM public.billing_enrollment_transition_intents
    WHERE source_intent_id=p_intent_id AND studio_id=p_studio_id
      AND transition_kind='revoke_scheduled'
      AND state NOT IN ('completed','revoked','definitive_rejected')
    FOR UPDATE;
    IF FOUND THEN
        IF v_revoke.initiated_by IS DISTINCT FROM p_actor_id
           OR v_revoke.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_enrollment_transition_request_conflict';
        END IF;
        INSERT INTO public.billing_enrollment_transition_aliases(
            intent_id,studio_id,transition_kind,caller_request_key,
            actor_id,request_sha256,created_at
        ) VALUES (
            v_revoke.id,p_studio_id,'revoke_scheduled',p_caller_request_key,
            p_actor_id,p_request_sha256,v_now
        );
        IF v_revoke.provider_operation_id IS NOT NULL THEN
            SELECT * INTO v_operation FROM public.billing_provider_operations
            WHERE id=v_revoke.provider_operation_id;
        END IF;
        RETURN private.billing_enrollment_transition_json_v1(
            v_revoke,'adopted',p_caller_request_key
        ) || CASE WHEN v_operation.id IS NULL THEN '{}'::JSONB ELSE jsonb_build_object(
            'operation',private.billing_provider_operation_json_v1(
                v_operation,'read'
            )->'operation') END;
    END IF;

    IF v_source.id IS NULL OR v_source.transition_kind<>'schedule_period_end'
       OR v_source.state<>'scheduled' OR v_source.revision<>p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_revoke_invalid';
    END IF;
    PERFORM private.assert_billing_enrollment_transition_current_v1(v_source);
    INSERT INTO public.billing_enrollment_transition_intents(
        studio_id,enrollment_id,payer_id,billing_subscription_id,source_intent_id,
        transition_kind,mutation_strategy,request_sha256,
        provider_caller_request_key,provider_request_sha256,
        stripe_connected_account_id,
        connect_account_generation,stripe_subscription_id,stripe_subscription_item_id,
        period_boundary,expected_quantity,expected_subscription_item_count,
        same_item_active_count,provider_quantity,initiated_by,reason_code,state,
        created_at,updated_at
    ) VALUES (
        v_source.studio_id,v_source.enrollment_id,v_source.payer_id,
        v_source.billing_subscription_id,v_source.id,'revoke_scheduled',
        v_source.mutation_strategy,p_request_sha256,
        CASE WHEN v_source.mutation_strategy='subscription_cancel_at_period_end'
            THEN p_caller_request_key END,
        CASE WHEN v_source.mutation_strategy='subscription_cancel_at_period_end'
            THEN p_request_sha256 END,
        v_source.stripe_connected_account_id,
        v_source.connect_account_generation,v_source.stripe_subscription_id,
        v_source.stripe_subscription_item_id,v_source.period_boundary,
        v_source.expected_quantity,v_source.expected_subscription_item_count,
        v_source.same_item_active_count,v_source.provider_quantity,p_actor_id,
        p_reason_code,
        CASE WHEN v_source.mutation_strategy='subscription_cancel_at_period_end'
            THEN 'due_claimed' ELSE 'completed' END,v_now,v_now
    ) RETURNING * INTO v_revoke;
    IF v_source.mutation_strategy='subscription_cancel_at_period_end' THEN
        INSERT INTO public.billing_provider_operations(
            studio_id,actor_id,operation_type,caller_request_key,request_sha256,
            stripe_connected_account_id,connect_account_generation,state,
            lease_owner,lease_acquired_at,lease_expires_at,started_at,created_at,updated_at
        ) VALUES (
            v_source.studio_id,p_actor_id,'enrollment.cancel.period_end.revoke',
            p_caller_request_key,p_request_sha256,v_source.stripe_connected_account_id,
            v_source.connect_account_generation,'started',p_lease_owner,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now
        ) RETURNING * INTO v_operation;
        UPDATE public.billing_enrollment_transition_intents
        SET provider_operation_id=v_operation.id,lease_owner=p_lease_owner,
            lease_acquired_at=v_now,
            lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
            revision=revision+1,updated_at=v_now
        WHERE id=v_revoke.id RETURNING * INTO v_revoke;
    ELSE
        UPDATE public.billing_enrollment_transition_intents
        SET state='revoked',revoked_at=v_now,revision=revision+1,updated_at=v_now
        WHERE id=v_source.id;
    END IF;
    INSERT INTO public.billing_enrollment_transition_aliases(
        intent_id,studio_id,transition_kind,caller_request_key,
        actor_id,request_sha256,created_at
    ) VALUES (v_revoke.id,p_studio_id,'revoke_scheduled',p_caller_request_key,
        p_actor_id,p_request_sha256,v_now);
    RETURN private.billing_enrollment_transition_json_v1(
        v_revoke,CASE WHEN v_operation.id IS NULL THEN 'revoked' ELSE 'claimed' END,
        p_caller_request_key
    ) || CASE WHEN v_operation.id IS NULL THEN '{}'::JSONB ELSE jsonb_build_object(
        'operation',private.billing_provider_operation_json_v1(v_operation,'claimed')->'operation') END;
END;
$$;
ALTER FUNCTION public.revoke_billing_enrollment_transition_v1(
    UUID,UUID,UUID,BIGINT,TEXT,TEXT,TEXT,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.revoke_billing_enrollment_transition_v1(
    UUID,UUID,UUID,BIGINT,TEXT,TEXT,TEXT,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.revoke_billing_enrollment_transition_v1(
    UUID,UUID,UUID,BIGINT,TEXT,TEXT,TEXT,UUID,INTEGER
) TO service_role;

CREATE FUNCTION public.transition_billing_enrollment_transition_v1(
    p_intent_id UUID,p_studio_id UUID,p_actor_id UUID,p_expected_revision BIGINT,
    p_provider_operation_id UUID,p_expected_operation_revision BIGINT,
    p_provider_evidence_sha256 TEXT DEFAULT NULL,
    p_reconciliation_reason_code TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_source_id UUID;
    v_enrollment_id UUID;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_source public.billing_enrollment_transition_intents%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_expected_operation_type TEXT;
    v_expected_provider_object_id TEXT;
    v_target_state TEXT;
    v_legal BOOLEAN:=false;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    SELECT source_intent_id,enrollment_id INTO v_source_id,v_enrollment_id
    FROM public.billing_enrollment_transition_intents WHERE id=p_intent_id;
    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=v_enrollment_id AND studio_id=p_studio_id FOR UPDATE;
    IF v_source_id IS NOT NULL THEN
        SELECT * INTO v_source FROM public.billing_enrollment_transition_intents
        WHERE id=v_source_id FOR UPDATE;
    END IF;
    SELECT * INTO v_intent FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id=p_provider_operation_id AND studio_id=p_studio_id FOR UPDATE;
    v_expected_operation_type:=CASE v_intent.transition_kind
        WHEN 'schedule_period_end' THEN 'enrollment.cancel.period_end.schedule'
        WHEN 'revoke_scheduled' THEN 'enrollment.cancel.period_end.revoke'
        WHEN 'execute_due' THEN 'enrollment.cancel.period_end.execute'
        WHEN 'immediate_cancel' THEN 'enrollment.cancel.immediate'
    END;
    v_expected_provider_object_id:=CASE
        WHEN v_intent.mutation_strategy LIKE 'subscription_cancel_%'
            THEN v_intent.stripe_subscription_id
        ELSE v_intent.stripe_subscription_item_id
    END;
    IF v_intent.id IS NULL OR v_operation.id IS NULL
       OR v_intent.initiated_by IS DISTINCT FROM p_actor_id
       OR v_intent.provider_operation_id IS DISTINCT FROM p_provider_operation_id
       OR v_intent.revision IS DISTINCT FROM p_expected_revision
       OR v_operation.revision IS DISTINCT FROM p_expected_operation_revision
       OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM v_intent.initiated_by
       OR v_operation.operation_type IS DISTINCT FROM v_expected_operation_type
       OR v_operation.caller_request_key IS DISTINCT FROM v_intent.provider_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM v_intent.provider_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM v_intent.stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM v_intent.connect_account_generation
       OR v_operation.state NOT IN (
            'provider_request_in_flight','provider_succeeded','projected','completed',
            'reconciliation_required','definitive_failed','definitive_rejected'
       ) THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_state_invalid';
    END IF;

    IF v_operation.state IN ('provider_succeeded','projected','completed') THEN
        IF p_provider_evidence_sha256 !~ '^[0-9a-f]{64}$'
           OR v_operation.provider_object_id IS DISTINCT FROM v_expected_provider_object_id THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_enrollment_transition_provider_evidence_invalid';
        END IF;
    ELSIF v_operation.state='reconciliation_required' THEN
        IF p_provider_evidence_sha256 !~ '^[0-9a-f]{64}$'
           OR p_reconciliation_reason_code !~ '^[a-z0-9][a-z0-9_.:-]{0,127}$'
           OR v_operation.reconciliation_reason_code
                IS DISTINCT FROM p_reconciliation_reason_code THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_enrollment_transition_reconciliation_evidence_invalid';
        END IF;
    END IF;

    v_target_state:=CASE
        WHEN v_intent.transition_kind='schedule_period_end'
             AND v_operation.state='completed' THEN 'scheduled'
        WHEN v_operation.state='definitive_failed' THEN 'definitive_rejected'
        ELSE v_operation.state
    END;
    IF v_intent.state=v_target_state
       AND v_intent.provider_evidence_sha256 IS NOT DISTINCT FROM p_provider_evidence_sha256
       AND v_intent.reconciliation_reason_code IS NOT DISTINCT FROM p_reconciliation_reason_code THEN
        RETURN private.billing_enrollment_transition_json_v1(v_intent,'replay',NULL);
    END IF;
    v_legal:=CASE v_intent.state
        WHEN 'scheduled' THEN v_target_state IN (
            'provider_request_in_flight','definitive_rejected'
        )
        WHEN 'due_claimed' THEN v_target_state IN (
            'provider_request_in_flight','definitive_rejected'
        )
        WHEN 'provider_request_in_flight' THEN v_target_state IN (
            'provider_succeeded','reconciliation_required','definitive_rejected'
        )
        WHEN 'provider_succeeded' THEN v_target_state IN (
            'projected','completed','scheduled','reconciliation_required'
        )
        WHEN 'projected' THEN v_target_state IN (
            'completed','scheduled','reconciliation_required'
        )
        WHEN 'reconciliation_required' THEN v_target_state IN (
            'provider_succeeded','projected','completed','scheduled','definitive_rejected'
        )
        WHEN 'recovery_authorized' THEN v_target_state IN (
            'provider_request_in_flight','provider_succeeded'
        )
        ELSE false
    END;
    IF NOT v_legal THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_state_invalid';
    END IF;

    IF v_operation.state='completed' AND v_intent.transition_kind='revoke_scheduled' THEN
        IF v_source.id IS NULL OR v_source.state NOT IN ('scheduled','reconciliation_required') THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_enrollment_transition_source_invalid';
        END IF;
        UPDATE public.billing_enrollment_transition_intents
        SET state='revoked',revoked_at=COALESCE(revoked_at,v_now),
            revision=revision+1,updated_at=v_now
        WHERE id=v_source.id;
    ELSIF v_operation.state='completed' AND v_intent.transition_kind='execute_due' THEN
        IF v_source.id IS NULL OR v_source.state NOT IN ('due_claimed','reconciliation_required') THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_enrollment_transition_source_invalid';
        END IF;
        UPDATE public.billing_enrollment_transition_intents
        SET state='completed',completed_at=COALESCE(completed_at,v_now),
            revision=revision+1,updated_at=v_now
        WHERE id=v_source.id;
    ELSIF v_operation.state IN ('definitive_failed','definitive_rejected')
          AND v_intent.transition_kind='execute_due' AND v_source.id IS NOT NULL THEN
        UPDATE public.billing_enrollment_transition_intents
        SET state='reconciliation_required',
            reconciliation_reason_code='due_execution_definitive_rejection',
            reconciliation_required_at=COALESCE(reconciliation_required_at,v_now),
            revision=revision+1,updated_at=v_now
        WHERE id=v_source.id;
    END IF;
    UPDATE public.billing_enrollment_transition_intents SET
        state=v_target_state,
        provider_evidence_sha256=COALESCE(p_provider_evidence_sha256,provider_evidence_sha256),
        reconciliation_reason_code=CASE WHEN v_operation.state='reconciliation_required'
            THEN p_reconciliation_reason_code ELSE NULL END,
        provider_succeeded_at=CASE WHEN v_operation.state IN ('provider_succeeded','projected','completed')
            THEN COALESCE(provider_succeeded_at,v_now) ELSE provider_succeeded_at END,
        projected_at=CASE WHEN v_operation.state IN ('projected','completed')
            THEN COALESCE(projected_at,v_now) ELSE projected_at END,
        completed_at=CASE WHEN v_target_state='completed'
            THEN COALESCE(completed_at,v_now) ELSE completed_at END,
        reconciliation_required_at=CASE WHEN v_target_state='reconciliation_required'
            THEN v_now ELSE reconciliation_required_at END,
        definitive_rejected_at=CASE WHEN v_target_state='definitive_rejected'
            THEN v_now ELSE definitive_rejected_at END,
        lease_owner=CASE WHEN v_operation.state IN (
            'completed','reconciliation_required','definitive_rejected'
        ) THEN NULL ELSE v_operation.lease_owner END,
        lease_acquired_at=CASE WHEN v_operation.state IN (
            'completed','reconciliation_required','definitive_rejected'
        ) THEN NULL ELSE v_operation.lease_acquired_at END,
        lease_expires_at=CASE WHEN v_operation.state IN (
            'completed','reconciliation_required','definitive_rejected'
        ) THEN NULL ELSE v_operation.lease_expires_at END,
        revision=revision+1,updated_at=v_now
    WHERE id=v_intent.id RETURNING * INTO v_intent;
    RETURN private.billing_enrollment_transition_json_v1(v_intent,'transitioned',NULL);
END;
$$;
ALTER FUNCTION public.transition_billing_enrollment_transition_v1(
    UUID,UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transition_billing_enrollment_transition_v1(
    UUID,UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.transition_billing_enrollment_transition_v1(
    UUID,UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT
) TO service_role;

CREATE FUNCTION public.authorize_billing_enrollment_transition_recovery_v1(
    p_intent_id UUID,p_studio_id UUID,p_recovery_actor_id UUID,
    p_expected_revision BIGINT,p_provider_operation_id UUID,
    p_expected_operation_revision BIGINT,p_recovery_proof_sha256 TEXT,
    p_recovery_outcome TEXT,p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_enrollment_id UUID;
    v_enrollment public.student_billing_enrollments%ROWTYPE;
    v_intent public.billing_enrollment_transition_intents%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_expected_operation_type TEXT;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles WHERE studio_id=p_studio_id
          AND user_id=p_recovery_actor_id AND archived_at IS NULL AND role='admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501',
            MESSAGE='billing_enrollment_transition_recovery_actor_forbidden';
    END IF;
    SELECT enrollment_id INTO v_enrollment_id
    FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id AND studio_id=p_studio_id;
    SELECT * INTO v_enrollment FROM public.student_billing_enrollments
    WHERE id=v_enrollment_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_intent FROM public.billing_enrollment_transition_intents
    WHERE id=p_intent_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id=p_provider_operation_id AND studio_id=p_studio_id FOR UPDATE;
    v_expected_operation_type:=CASE v_intent.transition_kind
        WHEN 'schedule_period_end' THEN 'enrollment.cancel.period_end.schedule'
        WHEN 'revoke_scheduled' THEN 'enrollment.cancel.period_end.revoke'
        WHEN 'execute_due' THEN 'enrollment.cancel.period_end.execute'
        WHEN 'immediate_cancel' THEN 'enrollment.cancel.immediate'
    END;
    IF v_intent.id IS NULL OR v_operation.id IS NULL
       OR v_intent.state NOT IN ('provider_request_in_flight','reconciliation_required')
       OR v_intent.revision<>p_expected_revision
       OR v_intent.provider_operation_id IS DISTINCT FROM p_provider_operation_id
       OR v_operation.revision<>p_expected_operation_revision
       OR v_operation.state<>'recovery_authorized'
       OR v_operation.operation_type IS DISTINCT FROM v_expected_operation_type
       OR v_operation.recovery_actor_id IS DISTINCT FROM p_recovery_actor_id
       OR v_operation.recovery_proof_sha256 IS DISTINCT FROM p_recovery_proof_sha256
       OR v_operation.recovery_outcome IS DISTINCT FROM p_recovery_outcome
       OR v_operation.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_operation.actor_id IS DISTINCT FROM v_intent.initiated_by
       OR v_operation.caller_request_key IS DISTINCT FROM v_intent.provider_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM v_intent.provider_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM v_intent.stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM v_intent.connect_account_generation
       OR p_recovery_proof_sha256 !~ '^[0-9a-f]{64}$'
       OR p_recovery_outcome NOT IN (
            'provider_no_object_safe_to_retry','provider_succeeded_reconcile_only'
       ) OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_enrollment_transition_recovery_invalid';
    END IF;
    UPDATE public.billing_enrollment_transition_intents SET
        state='recovery_authorized',recovery_proof_sha256=p_recovery_proof_sha256,
        recovery_outcome=p_recovery_outcome,recovery_actor_id=p_recovery_actor_id,
        recovery_authorized_at=v_now,lease_owner=p_lease_owner,
        lease_acquired_at=v_now,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
        revision=revision+1,updated_at=v_now
    WHERE id=v_intent.id RETURNING * INTO v_intent;
    RETURN private.billing_enrollment_transition_json_v1(v_intent,'recovery_authorized',NULL);
END;
$$;
ALTER FUNCTION public.authorize_billing_enrollment_transition_recovery_v1(
    UUID,UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.authorize_billing_enrollment_transition_recovery_v1(
    UUID,UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.authorize_billing_enrollment_transition_recovery_v1(
    UUID,UUID,UUID,BIGINT,UUID,BIGINT,TEXT,TEXT,UUID,INTEGER
) TO service_role;

-- V29 readiness pins below come from the repository-owned canonical and restored
-- PostgreSQL 17 verification paths.

CREATE FUNCTION private.koaryu_release_enrollment_transition_manifest_v29()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog SET "TimeZone"='UTC' AS $$
DECLARE v_invalid INTEGER; v_serialized TEXT;
BEGIN
    WITH required_function(
        signature,expected_security_definer,expected_service_execute,expected_config
    ) AS (VALUES
        ('private.koaryu_release_operational_manifest_v7()',false,false,'search_path=pg_catalog,TimeZone=UTC'),
        ('private.preserve_billing_enrollment_transition_identity_v1()',false,false,'search_path=""'),
        ('private.reject_billing_enrollment_transition_alias_mutation_v1()',false,false,'search_path=""'),
        ('private.billing_enrollment_transition_json_v1(public.billing_enrollment_transition_intents,text,text)',false,false,'search_path=""'),
        ('private.assert_billing_enrollment_transition_current_v1(public.billing_enrollment_transition_intents)',false,false,'search_path=""'),
        ('public.claim_billing_enrollment_transition_v1(uuid,uuid,text,text,text,uuid,uuid,uuid,text,text,text,integer,timestamp with time zone,integer,integer,integer,integer,text,text,uuid,integer)',true,true,'search_path=""'),
        ('public.claim_due_billing_enrollment_transitions_v1(uuid,integer,integer)',true,true,'search_path=""'),
        ('public.start_due_billing_enrollment_transition_v1(uuid,uuid,bigint,integer)',true,true,'search_path=""'),
        ('public.complete_due_billing_enrollment_transition_v1(uuid,uuid,bigint,text,text)',true,true,'search_path=""'),
        ('public.revoke_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,text,text,text,uuid,integer)',true,true,'search_path=""'),
        ('public.transition_billing_enrollment_transition_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text)',true,true,'search_path=""'),
        ('public.authorize_billing_enrollment_transition_recovery_v1(uuid,uuid,uuid,bigint,uuid,bigint,text,text,uuid,integer)',true,true,'search_path=""')
    ), function_state AS (
        SELECT required.signature,required.expected_security_definer,
            required.expected_service_execute,required.expected_config,p.oid,owner.rolname,
            p.prosecdef,COALESCE(array_to_string(p.proconfig,','),'') config,
            has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
            has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
            has_function_privilege('authenticated',p.oid,'EXECUTE') auth_execute,
            NOT EXISTS (
                SELECT 1 FROM aclexplode(
                    COALESCE(p.proacl,acldefault('f',p.proowner))
                ) AS grant_state
                WHERE grant_state.grantee<>p.proowner
                  AND NOT (
                    required.expected_service_execute
                    AND grant_state.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role')
                    AND grant_state.privilege_type='EXECUTE'
                  )
            ) no_unexpected_grants,
            pg_get_functiondef(p.oid) definition
        FROM required_function required
        LEFT JOIN pg_proc p ON p.oid=to_regprocedure(required.signature)
        LEFT JOIN pg_roles owner ON owner.oid=p.proowner
    ), object_state AS (
        SELECT 'functions' category,string_agg(
            signature||':'||COALESCE(rolname,'')||':'||COALESCE(prosecdef::TEXT,'')||':'||
            config||':'||COALESCE(service_execute::TEXT,'')||':'||
            COALESCE(no_unexpected_grants::TEXT,'')||':'||
            encode(extensions.digest(convert_to(COALESCE(definition,''),'UTF8'),'sha256'),'hex'),
            '|' ORDER BY signature COLLATE "C") value
        FROM function_state
        UNION ALL
        SELECT 'tables',string_agg(
            relation.relname||':'||owner.rolname||':'||relation.relrowsecurity::TEXT||':'||
            COALESCE(array_to_string(relation.relacl,','),''),
            '|' ORDER BY relation.relname COLLATE "C")
        FROM pg_class relation JOIN pg_roles owner ON owner.oid=relation.relowner
        WHERE relation.oid IN (
            'public.billing_enrollment_transition_intents'::REGCLASS,
            'public.billing_enrollment_transition_aliases'::REGCLASS)
        UNION ALL
        SELECT 'constraints',string_agg(
            relation.relname||'.'||constraint_state.conname||':'||
            pg_get_constraintdef(constraint_state.oid),
            '|' ORDER BY relation.relname COLLATE "C",constraint_state.conname COLLATE "C")
        FROM pg_constraint constraint_state JOIN pg_class relation
          ON relation.oid=constraint_state.conrelid
        WHERE constraint_state.conrelid IN (
            'public.billing_enrollment_transition_intents'::REGCLASS,
            'public.billing_enrollment_transition_aliases'::REGCLASS)
        UNION ALL
        SELECT 'indexes',string_agg(
            relation.relname||'.'||index_relation.relname||':'||pg_get_indexdef(i.indexrelid),
            '|' ORDER BY relation.relname COLLATE "C",index_relation.relname COLLATE "C")
        FROM pg_index i JOIN pg_class relation ON relation.oid=i.indrelid
        JOIN pg_class index_relation ON index_relation.oid=i.indexrelid
        WHERE i.indrelid IN (
            'public.billing_enrollment_transition_intents'::REGCLASS,
            'public.billing_enrollment_transition_aliases'::REGCLASS)
        UNION ALL
        SELECT 'policies',string_agg(
            relation.relname||'.'||policy.polname||':'||policy.polpermissive::TEXT||':'||
            policy.polcmd::TEXT||':'||pg_get_expr(policy.polqual,policy.polrelid)||':'||
            pg_get_expr(policy.polwithcheck,policy.polrelid),
            '|' ORDER BY relation.relname COLLATE "C",policy.polname COLLATE "C")
        FROM pg_policy policy JOIN pg_class relation ON relation.oid=policy.polrelid
        WHERE policy.polrelid IN (
            'public.billing_enrollment_transition_intents'::REGCLASS,
            'public.billing_enrollment_transition_aliases'::REGCLASS)
        UNION ALL
        SELECT 'triggers',string_agg(
            relation.relname||'.'||trigger.tgname||':'||trigger.tgenabled::TEXT||':'||
            pg_get_triggerdef(trigger.oid),
            '|' ORDER BY relation.relname COLLATE "C",trigger.tgname COLLATE "C")
        FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
        WHERE NOT trigger.tgisinternal AND trigger.tgrelid IN (
            'public.billing_enrollment_transition_intents'::REGCLASS,
            'public.billing_enrollment_transition_aliases'::REGCLASS)
    )
    SELECT
        (SELECT count(*) FROM function_state WHERE oid IS NULL OR rolname<>'postgres'
            OR prosecdef IS DISTINCT FROM expected_security_definer
            OR config<>expected_config
            OR service_execute IS DISTINCT FROM expected_service_execute
            OR anon_execute OR auth_execute OR NOT no_unexpected_grants)
        + (SELECT count(*) FROM (VALUES
            ('public.billing_enrollment_transition_intents'::REGCLASS),
            ('public.billing_enrollment_transition_aliases'::REGCLASS)
          ) required(oid) WHERE NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
            WHERE c.oid=required.oid AND r.rolname='postgres' AND c.relrowsecurity
              AND NOT has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')
              AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
              AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')))
        + CASE WHEN (
            SELECT count(*) FROM pg_policy policy
            WHERE policy.polrelid IN (
                'public.billing_enrollment_transition_intents'::REGCLASS,
                'public.billing_enrollment_transition_aliases'::REGCLASS)
              AND policy.polname IN (
                'billing_enrollment_transition_intents_no_client_access',
                'billing_enrollment_transition_aliases_no_client_access',
                'reject_ambiguous_staff_membership_access')
              AND NOT policy.polpermissive
        )=4 THEN 0 ELSE 1 END
        + CASE WHEN (
            SELECT count(*) FROM pg_trigger trigger
            WHERE NOT trigger.tgisinternal AND trigger.tgenabled='O'
              AND trigger.tgrelid IN (
                'public.billing_enrollment_transition_intents'::REGCLASS,
                'public.billing_enrollment_transition_aliases'::REGCLASS)
              AND trigger.tgname IN (
                'preserve_billing_enrollment_transition_identity_v1',
                'reject_billing_enrollment_transition_alias_update_v1',
                'reject_billing_enrollment_transition_alias_delete_v1')
        )=3 THEN 0 ELSE 1 END,
        string_agg(category||'='||COALESCE(value,''),E'\n' ORDER BY category COLLATE "C")
    INTO v_invalid,v_serialized FROM object_state;
    RETURN v_invalid::TEXT||':'||encode(
        extensions.digest(convert_to(COALESCE(v_serialized,''),'UTF8'),'sha256'),'hex');
END;
$$;
ALTER FUNCTION private.koaryu_release_enrollment_transition_manifest_v29() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_enrollment_transition_manifest_v29()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.koaryu_release_operational_contract_v29()
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog SET "TimeZone"='UTC' AS $$
    SELECT '0:'||encode(extensions.digest(convert_to(
        private.koaryu_release_operational_contract_v28()||'|'||
        private.koaryu_release_enrollment_transition_manifest_v29(),'UTF8'),'sha256'),'hex');
$$;
ALTER FUNCTION private.koaryu_release_operational_contract_v29() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_contract_v29()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.koaryu_release_v29_expectations(
    expectation_key TEXT PRIMARY KEY CHECK(expectation_key='operational_contract_v29'),
    expected_sha256 TEXT NOT NULL CHECK(expected_sha256~'^[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v29_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v29_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v29_expectations
    FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.koaryu_release_v29_expectations VALUES(
    'operational_contract_v29','e2c4f27b967c5bff881a00e51416691ef752cc51e8298fb2142c96f607e4e1d0');

CREATE FUNCTION private.koaryu_release_operational_manifest_v10()
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog SET "TimeZone"='UTC' AS $$
    SELECT encode(extensions.digest(convert_to(
        private.koaryu_release_operational_manifest_v9()||'|'||
        private.koaryu_release_enrollment_transition_manifest_v29()||'|'||
        private.koaryu_release_operational_contract_v29()||'|'||
        (SELECT string_agg(expectation_key||':'||expected_sha256,'|')
         FROM private.koaryu_release_v29_expectations),'UTF8'),'sha256'),'hex');
$$;
ALTER FUNCTION private.koaryu_release_operational_manifest_v10() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_operational_manifest_v10()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v10()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_count INTEGER;v_head TEXT;v_pending TEXT[];v_failures TEXT[]:=ARRAY[]::TEXT[];
    v_expected TEXT;
BEGIN
    SELECT count(*)::INTEGER,max(version),array_agg(version ORDER BY version COLLATE "C")
        FILTER(WHERE version>='20260727100000')
    INTO v_count,v_head,v_pending FROM supabase_migrations.schema_migrations;
    IF v_count<>124 OR v_head<>'20260826102840' THEN
        v_failures:=array_append(v_failures,'migration_history_v29');
    END IF;
    IF COALESCE(v_pending,ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723','20260820012533',
        '20260820025759','20260820060216','20260822193000','20260823193155',
        '20260824190500','20260825042838','20260825043911',
        '20260826030234','20260826030249','20260826051527',
        '20260826073728','20260826102840'
    ]::TEXT[] THEN
        v_failures:=array_append(v_failures,'migration_history_sequence_v29');
    END IF;
    IF private.koaryu_release_enrollment_transition_manifest_v29()
       <> '0:118b8031e9393f0114f486d0704e71475099d326f7fba9ad5d7518ad5a6a2c60' THEN
        v_failures:=array_append(v_failures,'enrollment_transition_manifest_v29');
    END IF;
    SELECT expected_sha256 INTO v_expected FROM private.koaryu_release_v29_expectations
    WHERE expectation_key='operational_contract_v29';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v29_expectations)<>1
       OR private.koaryu_release_operational_contract_v29() IS DISTINCT FROM '0:'||v_expected THEN
        v_failures:=array_append(v_failures,'operational_contract_v29');
    END IF;
    SELECT expected_sha256 INTO v_expected FROM private.koaryu_release_v28_expectations
    WHERE expectation_key='operational_contract_v28';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v28_expectations)<>1
       OR private.koaryu_release_operational_contract_v28() IS DISTINCT FROM '0:'||v_expected THEN
        v_failures:=array_append(v_failures,'operational_contract_v28');
    END IF;
    SELECT expected_sha256 INTO v_expected FROM private.koaryu_release_v27_expectations
    WHERE expectation_key='operational_contract_v27';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v27_expectations)<>1
       OR private.koaryu_release_operational_contract_v27() IS DISTINCT FROM '0:'||v_expected THEN
        v_failures:=array_append(v_failures,'operational_contract_v27');
    END IF;
    SELECT expected_sha256 INTO v_expected FROM private.koaryu_release_v26_expectations
    WHERE expectation_key='operational_contract_v26';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v26_expectations)<>1
       OR private.koaryu_release_operational_contract_v26() IS DISTINCT FROM '0:'||v_expected THEN
        v_failures:=array_append(v_failures,'operational_contract_v26');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:1de704b805b929154bf88e1727838d0d95c1c3da16246c3d48c3bdafafcb5931' THEN
        v_failures:=array_append(v_failures,'provider_operation_steps_manifest_v28');
    END IF;
    IF private.koaryu_release_operational_manifest_v9()
       <> '67f9fb3a6730a356ad944828eeba4398912edf114dcdd2daf0a48e4cdc7a5280' THEN
        v_failures:=array_append(v_failures,'operational_manifest_v9');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
    ),'UTF8'),'sha256'),'hex')
       <> '2615e19ea37158de13259f072419f7047440a2ad1065288e7b0056d21439f57f' THEN
        v_failures:=array_append(v_failures,'operational_manifest_v7_function');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_operational_manifest_v9()'::REGPROCEDURE
    ),'UTF8'),'sha256'),'hex')
       <> '911922f5e0400bc1dff67f219f0c59f256b64dc5593aaf57f01ae0ec8b831b6e' THEN
        v_failures:=array_append(v_failures,'operational_manifest_v9_function');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures:=array_append(v_failures,'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures:=array_append(v_failures,'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18()
       <> '0:df60c194ff14dc5ea729ca41e469e21bb79acf33edf63edf857fb34e2a8f6628' THEN
        v_failures:=array_append(v_failures,'critical_surface_manifest_v18');
    END IF;
    IF private.koaryu_release_live_billing_v3_manifest_v25()
       <> '0:f810f40507fd5be476a90be7915be9f926ea15aafca7588cbca76233cda8adfb' THEN
        v_failures:=array_append(v_failures,'live_billing_v3_manifest_v25');
    END IF;
    IF private.koaryu_release_payment_adjustment_manifest_v26()
       <> '0:b63f010f0b0111f38b72fc43009f77722d824d96c3775a9dc3d34e6c58a63657' THEN
        v_failures:=array_append(v_failures,'payment_adjustment_manifest_v26');
    END IF;
    IF private.koaryu_release_schedule_window_manifest_v1()
       IS DISTINCT FROM '0:f4c66d3098dcb3210ac6cc92e1831eebaf9f2ed74b210e84ec773cb1d8e854a7' THEN
        v_failures:=array_append(v_failures,'schedule_window_manifest_v1');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures)=0,v_count,v_head,
        COALESCE(v_pending,ARRAY[]::TEXT[]),v_failures,'release-db-attestation-v29'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v10() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v10()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v10() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v9()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
    pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE
    v_current RECORD;
    v_failures TEXT[]:=ARRAY[]::TEXT[];
    v_expected_v28 TEXT;
    v_expected_v27 TEXT;
    v_expected_v26 TEXT;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v10();
    SELECT expected_sha256 INTO v_expected_v28
    FROM private.koaryu_release_v28_expectations
    WHERE expectation_key='operational_contract_v28';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v28_expectations)<>1
       OR private.koaryu_release_operational_contract_v28()
            IS DISTINCT FROM '0:'||v_expected_v28 THEN
        v_failures:=array_append(v_failures,'operational_contract_v28');
    END IF;
    SELECT expected_sha256 INTO v_expected_v27
    FROM private.koaryu_release_v27_expectations
    WHERE expectation_key='operational_contract_v27';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v27_expectations)<>1
       OR private.koaryu_release_operational_contract_v27()
            IS DISTINCT FROM '0:'||v_expected_v27 THEN
        v_failures:=array_append(v_failures,'operational_contract_v27');
    END IF;
    SELECT expected_sha256 INTO v_expected_v26
    FROM private.koaryu_release_v26_expectations
    WHERE expectation_key='operational_contract_v26';
    IF NOT FOUND OR (SELECT count(*) FROM private.koaryu_release_v26_expectations)<>1
       OR private.koaryu_release_operational_contract_v26()
            IS DISTINCT FROM '0:'||v_expected_v26 THEN
        v_failures:=array_append(v_failures,'operational_contract_v26');
    END IF;
    IF v_current.ready AND cardinality(v_failures)=0
       AND v_current.migration_count=124
       AND v_current.migration_head='20260826102840' THEN
        RETURN QUERY SELECT true,123,'20260826073728'::TEXT,
            (v_current.pending_versions[1:cardinality(v_current.pending_versions)-1]),
            ARRAY[]::TEXT[],'release-db-attestation-v28'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures,ARRAY[]::TEXT[])||v_failures,
        'release-db-attestation-v28'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v9() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v9()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v9() TO service_role;

DO $$ BEGIN
    RAISE NOTICE 'KOARYU_V29_TRANSITION_MANIFEST=%',
        private.koaryu_release_enrollment_transition_manifest_v29();
    RAISE NOTICE 'KOARYU_V29_OPERATIONAL_CONTRACT=%',
        private.koaryu_release_operational_contract_v29();
    RAISE NOTICE 'KOARYU_V29_OPERATIONAL_MANIFEST=%',
        private.koaryu_release_operational_manifest_v10();
    RAISE NOTICE 'KOARYU_V29_CRITICAL_SURFACE=%',
        private.koaryu_release_critical_surface_manifest_v18();
    RAISE NOTICE 'KOARYU_V29_V7_FUNCTION_SHA256=%',encode(
        extensions.digest(convert_to(pg_get_functiondef(
            'private.koaryu_release_operational_manifest_v7()'::REGPROCEDURE
        ),'UTF8'),'sha256'),'hex');
END $$;
